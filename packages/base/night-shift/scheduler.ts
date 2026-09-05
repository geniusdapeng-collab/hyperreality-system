/**
 * night-shift · 夜班状态机 + 一键暂停（F4.2/F4.3/F4.8，G5，E4.1，L4.1）
 *
 * 状态机（图 M4-1）：unconfigured → ready → running ⇄ paused → package_generated → ready
 *  - 启动时做围栏版本快照（F2.6/L4.1：夜班动作 100% 过围栏，无例外通道）
 *  - 一键暂停：任意端发起 → run 置 paused + 工作区全部 running 线程挂起 → 留痕（含端到端耗时）
 *    ≤60s 生效（G5 机制+计时留痕）；超时写 P0 告警事件（E4.1 强制隔离机制位）
 *  - 暂停/恢复/配置变更全部事件化（L4.4 同源纪律）
 */
import type pg from "pg";
import { NIGHT_DEFAULTS, PAUSE_ALL_SLA_SECONDS, type NightStatus } from "@workloom/shared";
import { gatewayAppend, gatewayAppendOnClient } from "../workdata/gateway.js";

/* ---------- 状态机（纯函数：迁移合法性唯一事实源） ---------- */

const TRANSITIONS: Record<NightStatus, NightStatus[]> = {
  unconfigured: ["ready"],
  ready: ["running"],
  running: ["paused", "package_generated"],
  paused: ["running", "package_generated"],
  package_generated: ["ready"],
};

export class NightTransitionError extends Error {
  constructor(from: NightStatus, to: NightStatus) {
    super(`夜班状态机非法迁移：${from} → ${to}（F4.8）`);
    this.name = "NightTransitionError";
  }
}

export function assertTransition(from: NightStatus, to: NightStatus): void {
  if (!TRANSITIONS[from]?.includes(to)) throw new NightTransitionError(from, to);
}

/* ---------- 运行记录读写 ---------- */

interface Scope { tenantId: string; workspaceId: string }

/** 事务内事件留痕（D16：调用方持有事务，与状态写同一 COMMIT） */
async function emitInTx(
  client: pg.PoolClient,
  scope: Scope,
  decision: Record<string, unknown>,
  links?: string[],
): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: "night-shift", type: "system" },
  }, {
    who: { type: "system", id: "night-shift" },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "夜班" },
    object: { type: "store", id: scope.workspaceId },
    decision: decision as never,
    rule_impact: [],
    links,
  });
  return r.eventId;
}

async function emit(
  gateway: pg.Pool,
  scope: Scope,
  decision: Record<string, unknown>,
  links?: string[],
): Promise<string> {
  const r = await gatewayAppend(gateway, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: "night-shift", type: "system" },
  }, {
    who: { type: "system", id: "night-shift" },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "夜班" },
    object: { type: "store", id: scope.workspaceId },
    decision: decision as never,
    rule_impact: [],
    links,
  });
  return r.eventId;
}

/** 班次 id（0013 口径）：nr-<workspaceId>-<runDate>；PK 已改 (workspace_id, run_date)，id 保留唯一约束兼容旧查询 */
export function nightRunId(workspaceId: string, runDate: string): string {
  return `nr-${workspaceId}-${runDate}`;
}

/** 创建/就绪夜班（unconfigured → ready；配置变更留痕 F4.8） */
export async function ensureReady(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  runDate: string,
): Promise<string> {
  const id = nightRunId(scope.workspaceId, runDate);
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    // 同工作区同日期唯一一班（复合 PK 幂等）；旧格式 id 存量行命中 PK 冲突即跳过
    await client.query(
      `INSERT INTO night_runs (id, workspace_id, run_date, status) VALUES ($1,$2,$3,'ready')
       ON CONFLICT DO NOTHING`, // D31：复合主键(ws,date)+uq(id) 双约束并存，裸 ON CONFLICT 全兜（并发 ensureReady 竞态）
      [id, scope.workspaceId, runDate],
    );
    // 回读真实 id：兼容旧格式 id（nr-<runDate>）存量行，调用方一律按返回 id 操作
    const row = await client.query<{ id: string }>(
      `SELECT id FROM night_runs WHERE workspace_id=$1 AND run_date=$2`,
      [scope.workspaceId, runDate],
    );
    await client.query("COMMIT");
    return row.rows[0]?.id ?? id;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 开启夜班（人类命令，不经模型轮次 F4.1）：ready → running + 围栏快照（F2.6） */
export async function confirmNight(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  runId: string,
  by: string,
  candidateIds: string[],
): Promise<void> {
  const client = await app.connect();
  let fenceVersion: string | null = null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const cur = await client.query<{ status: NightStatus }>(
      `SELECT status FROM night_runs WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [runId, scope.workspaceId],
    );
    const from = cur.rows[0]?.status ?? "unconfigured";
    assertTransition(from, "running");
    // F2.6：围栏版本快照（取当前生效基线包版本）
    // #6 修复：限定 is_baseline=true + DESC 确定性排序；断言最多一条 active baseline
    const fr = await client.query<{ version: string }>(
      `SELECT version FROM fence_rules
       WHERE (workspace_id=$1 OR workspace_id='*') AND status='active' AND is_baseline=true
       ORDER BY version DESC, created_at DESC LIMIT 1`,
      [scope.workspaceId],
    );
    fenceVersion = fr.rows[0]?.version ?? null;
    await client.query(
      `UPDATE night_runs SET status='running', fence_snapshot_version=$3, candidate_count=$4, started_at=now()
       WHERE id=$1 AND workspace_id=$2`,
      [runId, scope.workspaceId, fenceVersion, candidateIds.length],
    );
    // D16（#1/A）：状态推进与开启事件同一事务同一 COMMIT
    await emitInTx(client, scope, {
      action: "night.run.start",
      after: { runId, by, candidates: candidateIds, fenceSnapshot: fenceVersion },
      basis: ["人类命令开启夜班（F4.1 不经模型轮次）", `围栏快照 ${fenceVersion}（F2.6）`],
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ---------- 一键暂停（F4.3/G5/E4.1） ---------- */

export interface PauseResult {
  runId: string;
  elapsedMs: number;
  withinSla: boolean;
  pausedThreads: number;
}

export async function pauseAll(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  runId: string,
  by: { memberNo: string; channel: string },
): Promise<PauseResult> {
  const client = await app.connect();
  // G5 SLA 计时从拿到连接后开始（排队等连接不计入端到端暂停耗时）
  const t0 = Date.now();
  let pausedThreads = 0;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
    const cur = await client.query<{ status: NightStatus }>(
      `SELECT status FROM night_runs WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [runId, scope.workspaceId],
    );
    const from = cur.rows[0]?.status;
    if (!from) throw new Error(`夜班班次 ${runId} 不存在（pauseAll 拒绝对空班次操作）`);
    assertTransition(from, "paused");
    // 挂起工作区全部 running 线程（断点挂起，恢复续跑 E4.2/E3.3）
    // #13 修复：标记 paused_by='night-shift'，resumeNight 只恢复该标记的线程，不覆盖手动暂停
    const th = await client.query(
      `UPDATE threads SET status='paused', paused_by='night-shift', updated_at=now()
       WHERE workspace_id=$1 AND status='running'`,
      [scope.workspaceId],
    );
    pausedThreads = th.rowCount ?? 0;
    await client.query(`UPDATE night_runs SET status='paused' WHERE id=$1 AND workspace_id=$2`, [runId, scope.workspaceId]);
    const elapsedMs = Date.now() - t0;
    const withinSla = elapsedMs <= PAUSE_ALL_SLA_SECONDS * 1000;
    // D16（#1/A）：暂停状态、线程挂起、事件留痕同一事务同一 COMMIT
    const eventId = await emitInTx(client, scope, {
      action: "night.pause_all",
      after: { runId, by: by.memberNo, channel: by.channel, pausedThreads, elapsedMs, slaSeconds: PAUSE_ALL_SLA_SECONDS },
      basis: [`一键暂停（G5 端到端 ≤${PAUSE_ALL_SLA_SECONDS}s；本次 ${elapsedMs}ms）`],
    });
    // E4.1：超时升级 P0 告警（强制隔离机制位——会话隔离动作在 E1 联调卡落）
    if (!withinSla) {
      await emitInTx(client, scope, {
        action: "night.pause_timeout",
        after: { runId, elapsedMs, slaSeconds: PAUSE_ALL_SLA_SECONDS, level: "p0", action_required: "强制隔离会话" },
      }, [eventId]);
    }
    await client.query("COMMIT");
    return { runId, elapsedMs, withinSla, pausedThreads };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 恢复（paused → running；断点续跑由 runtime runQuest 重入保证） */
export async function resumeNight(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  runId: string,
  by: string,
): Promise<void> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
    const cur = await client.query<{ status: NightStatus }>(
      `SELECT status FROM night_runs WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [runId, scope.workspaceId],
    );
    assertTransition(cur.rows[0]?.status ?? "unconfigured", "running");
    await client.query(`UPDATE night_runs SET status='running' WHERE id=$1 AND workspace_id=$2`, [runId, scope.workspaceId]);
    // #13 修复：只恢复 paused_by='night-shift' 的线程，不覆盖用户手动暂停的线程
    await client.query(
      `UPDATE threads SET status='queued', paused_by=NULL, updated_at=now()
       WHERE workspace_id=$1 AND status='paused' AND paused_by='night-shift'`,
      [scope.workspaceId],
    );
    // D16（#1/A）：恢复状态与事件同一事务同一 COMMIT
    await emitInTx(client, scope, { action: "night.resume", after: { runId, by } });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export { NIGHT_DEFAULTS };
