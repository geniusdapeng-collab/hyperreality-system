/**
 * skill-ops · 夜班窗口自动同步（机制即自动，客户零操作）
 *
 * 调度：server 启动即挂载，每 60s 评估一次；对每个工作区——
 *  ① 分发已配置（SKILL_DIST_REGISTRY_URL + SKILL_DIST_SIGNING_KEY），未配置整体禁用；
 *  ② 工作区 auto_sync 策略开启（skill_dist_policy.auto_sync，默认 true，客户可关——治理主权）；
 *  ③ 当前时刻落在夜班窗口（NIGHT_DEFAULTS 22:00 出征 → 08:30 决策包，Asia/Shanghai）；
 *  ④ 距上次自动同步 ≥20h（事实源=biz_events 中 system:night-shift 归因的 skill.dist.sync）；
 *  ⑤ pg advisory xact lock 抢执行权（多副本/并发只一个真正同步，与 tickTriggers 同构）。
 * 事件归因：system:night-shift（白名单系统组件）——「谁干的」在事件库里一眼可辨。
 */
import type pg from "pg";
import { NIGHT_DEFAULTS } from "@workloom/shared";
import { syncDistribution, type EventActor, type ManifestFetcher, type SyncResult } from "./receiver.js";
import type { InstanceProfile } from "./types.js";

const AUTO_ACTOR: EventActor = { id: "night-shift", type: "system" };

/** 夜班窗口判定（纯函数）：startTime → 次日 packageTime 跨午夜区间（Asia/Shanghai 墙钟） */
export function inNightWindow(at: Date, start = NIGHT_DEFAULTS.startTime, end = NIGHT_DEFAULTS.packageTime): boolean {
  // 用上海时区墙钟时分比较（容器 TZ 不假设）
  const sh = new Date(at.toLocaleString("en-US", { timeZone: NIGHT_DEFAULTS.timezone }));
  const cur = sh.getHours() * 60 + sh.getMinutes();
  const [sh_, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const s = sh_! * 60 + sm!, e = eh! * 60 + em!;
  return s <= e ? (cur >= s && cur <= e) : (cur >= s || cur <= e); // 跨午夜：22:00→08:30
}

/** 到期判定（纯函数）：距上次自动同步 ≥20h 视为到期 */
export function isSyncDue(lastAutoSyncAt: Date | null, now: Date, intervalMs = 20 * 3600 * 1000): boolean {
  if (!lastAutoSyncAt) return true;
  return now.getTime() - lastAutoSyncAt.getTime() >= intervalMs;
}

export interface AutoSyncTickResult {
  workspaceId: string;
  ran: boolean;
  reason?: string;
  result?: SyncResult;
}

/** 单工作区自动同步评估（可独立调用=可测试；锁与条件全在事务/查询内） */
export async function autoSyncWorkspace(
  app: pg.Pool, gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  opts: {
    registryUrl: string; signingKey: string; instance: InstanceProfile;
    fetcher?: ManifestFetcher; now?: Date;
    /** 到期间隔（默认 20h；测试可注入） */
    intervalMs?: number;
  },
): Promise<AutoSyncTickResult> {
  const now = opts.now ?? new Date();
  if (!opts.registryUrl || !opts.signingKey) return { workspaceId: scope.workspaceId, ran: false, reason: "disabled" };
  if (!inNightWindow(now)) return { workspaceId: scope.workspaceId, ran: false, reason: "out_of_window" };

  // 抢执行权（xact 锁随事务结束释放）
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const lock = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [`skill-dist-autosync:${scope.workspaceId}`]);
    if (!lock.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return { workspaceId: scope.workspaceId, ran: false, reason: "locked" };
    }
    // auto_sync 策略开关
    const pol = await client.query<{ auto_sync: boolean }>(
      `SELECT auto_sync FROM skill_dist_policy WHERE workspace_id=$1`, [scope.workspaceId]);
    if (pol.rows[0] && pol.rows[0].auto_sync === false) {
      await client.query("ROLLBACK");
      return { workspaceId: scope.workspaceId, ran: false, reason: "auto_sync_off" };
    }
    // 到期判定：最后一次系统归因的同步事件
    const last = await client.query<{ at: Date }>(
      `SELECT created_at AS at FROM biz_events
       WHERE workspace_id=$1 AND payload->'decision'->>'action'='skill.dist.sync'
         AND payload->'who'->>'type'='system' AND payload->'who'->>'id'='night-shift'
       ORDER BY created_at DESC LIMIT 1`, [scope.workspaceId]);
    await client.query("COMMIT");
    if (!isSyncDue(last.rows[0]?.at ?? null, now, opts.intervalMs)) {
      return { workspaceId: scope.workspaceId, ran: false, reason: "not_due" };
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }

  const result = await syncDistribution(app, gateway, scope, {
    registryUrl: opts.registryUrl,
    signingKey: opts.signingKey,
    instance: opts.instance,
    by: "night-shift",
    actor: AUTO_ACTOR,
    fetcher: opts.fetcher,
  });
  return { workspaceId: scope.workspaceId, ran: true, result };
}

/** 调度循环（server 启动挂载；返回停止函数） */
export function startSkillDistAutoSync(
  app: pg.Pool, gateway: pg.Pool,
  opts: {
    registryUrl: string; signingKey: string;
    intervalMs?: number;
    instanceOf: (scope: { tenantId: string; workspaceId: string }) => Promise<InstanceProfile>;
    fetcher?: ManifestFetcher;
    onResult?: (r: AutoSyncTickResult) => void;
  },
): () => void {
  const intervalMs = opts.intervalMs ?? 60_000;
  let stopped = false;
  let ticking = false;
  const tick = async () => {
    if (stopped || ticking) return; // 防重入
    ticking = true;
    try {
      const ws = await app.query<{ id: string; tenant_id: string }>(`SELECT id, tenant_id FROM workspaces`);
      for (const w of ws.rows) {
        if (stopped) break;
        try {
          const scope = { tenantId: w.tenant_id, workspaceId: w.id };
          const instance = await opts.instanceOf(scope);
          const r = await autoSyncWorkspace(app, gateway, scope, {
            registryUrl: opts.registryUrl, signingKey: opts.signingKey,
            instance, fetcher: opts.fetcher,
          });
          if (r.ran) opts.onResult?.(r);
        } catch (err) {
          // 单工作区失败不影响其他工作区；错误进日志（事件面由 syncDistribution 内部留痕）
          console.warn(`[skill-dist-autosync] 工作区 ${w.id} 同步失败：${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      console.warn(`[skill-dist-autosync] tick 失败：${err instanceof Error ? err.message : err}`);
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.(); // 不阻塞进程退出
  void tick(); // 启动即评估一次（窗口内且到期才真跑）
  return () => { stopped = true; clearInterval(timer); };
}
