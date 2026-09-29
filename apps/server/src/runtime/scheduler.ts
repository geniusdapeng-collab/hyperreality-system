/**
 * 本机调度器（GR-16）。
 *
 * 问题（2026-09-28 真机实证）：全系统没有任何调度器——`status='queued'` 的线程
 * 只有"立即执行"这一个入口能跑；客户端注释也承认「本机演示没有独立调度器，只立项会永远排队」。
 * 受影响面：agent 模式（runImmediately 被静默忽略）、任务页/岗位卡派活、服务重启后 queued 遗留。
 *
 * 口径：
 *  - 进程内轻量循环（默认 7s，`WORKLOOM_SCHEDULER_MS=0` 关闭；VPC 可关）；
 *  - 每轮扫描各工作区 queued 线程，按创建时间先进先出，遵守 L3.1 并发上限（running+queued 计入）；
 *  - 选中的线程走 `runQuestForThread`（与派遣/续跑同一条装配路径；agent 模式跑到第一个 review 点挂起）；
 *  - 启动恢复：`running` 且超过 N 分钟无心跳的线程标 `paused`（可人工续跑），不做静默重放；
 *  - 单进程内同线程互斥（in-flight 集合），失败只落日志并把错误交给线程终态（runQuest 自己写 failed）。
 */
import type pg from "pg";
import { getAppPool, getOwnerPool } from "@workloom/db";
import { MAX_CONCURRENT_THREADS } from "@workloom/shared";
import { runQuestForThread, type Scope } from "./thread-runner.js";

export interface SchedulerOptions {
  /** 扫描间隔（毫秒）；<=0 表示关闭 */
  intervalMs?: number;
  /** 单轮最多拉起多少条（防止一次性打满） */
  batch?: number;
  /** running 超过多少分钟视为僵尸（进程重启/崩溃遗留） */
  staleRunningMinutes?: number;
}

const DEFAULT_INTERVAL_MS = 7_000;
const DEFAULT_STALE_RUNNING_MIN = 10;

export function schedulerConfigFromEnv(): Required<SchedulerOptions> {
  const interval = Number(process.env.WORKLOOM_SCHEDULER_MS ?? DEFAULT_INTERVAL_MS);
  const batch = Number(process.env.WORKLOOM_SCHEDULER_BATCH ?? 3);
  const stale = Number(process.env.WORKLOOM_STALE_RUNNING_MIN ?? DEFAULT_STALE_RUNNING_MIN);
  return {
    intervalMs: Number.isFinite(interval) ? interval : DEFAULT_INTERVAL_MS,
    batch: Number.isFinite(batch) && batch > 0 ? batch : 3,
    staleRunningMinutes: Number.isFinite(stale) && stale > 0 ? stale : DEFAULT_STALE_RUNNING_MIN,
  };
}

interface QueuedThread { id: string; title: string; mode: string; agent_id: string | null }

const inFlight = new Set<string>();

/**
 * 列出所有工作区：调度器是**系统级**组件，而 `workspaces` 表带 RLS
 * （`p_workspaces_ws: id = current_setting('app.workspace_id')`），app 角色在无 GUC 时恒 0 行——
 * 因此这一步用 owner 池枚举，之后的每工作区读写仍走 app/gateway 池并带齐 GUC（不越过 RLS 边界）。
 */
async function listWorkspaces(app: pg.Pool = getOwnerPool()): Promise<Scope[]> {
  const client = await app.connect();
  try {
    const r = await client.query<{ id: string; tenant_id: string }>(`SELECT id, tenant_id FROM workspaces ORDER BY id`);
    return r.rows.map((row) => ({ tenantId: row.tenant_id, workspaceId: row.id }));
  } finally {
    client.release();
  }
}

/** 单工作区：取一条可执行的 queued 线程（含模式与岗位引用） */
async function nextQueuedThread(app: pg.Pool, scope: Scope): Promise<QueuedThread | undefined> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    // 与派遣入口同口径：只把「有近期心跳的 running」计入并发（僵尸 running 不占配额，见 N-15）
    const staleMin = Number(process.env.WORKLOOM_STALE_RUNNING_MIN ?? DEFAULT_STALE_RUNNING_MIN);
    const running = await client.query<{ c: string }>(
      `SELECT count(*) AS c FROM threads
        WHERE workspace_id=$1
          AND (status='queued'
               OR (status='running' AND updated_at > now() - ($2::text || ' minutes')::interval))`,
      [scope.workspaceId, String(Number.isFinite(staleMin) && staleMin > 0 ? staleMin : DEFAULT_STALE_RUNNING_MIN)],
    );
    if (Number(running.rows[0]?.c ?? 0) >= MAX_CONCURRENT_THREADS) {
      await client.query("COMMIT");
      return undefined;
    }
    const r = await client.query<QueuedThread>(
      `SELECT id, title, mode, agent_id FROM threads
        WHERE workspace_id=$1 AND status='queued'
        ORDER BY created_at ASC LIMIT 1`,
      [scope.workspaceId],
    );
    await client.query("COMMIT");
    const row = r.rows[0];
    if (!row || inFlight.has(row.id)) return undefined;
    return row;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 扫描一轮：把 queued 线程拉起来执行。返回本轮执行摘要（供测试与日志）。
 */
export async function sweepQueuedThreads(opts: SchedulerOptions = {}): Promise<{ picked: string[]; failed: string[] }> {
  const app = getAppPool();
  const owner = getOwnerPool();
  const batch = opts.batch ?? 3;
  const picked: string[] = [];
  const failed: string[] = [];
  const workspaces = await listWorkspaces(owner);
  for (const scope of workspaces) {
    for (let i = 0; i < batch; i += 1) {
      const thread = await nextQueuedThread(app, scope);
      if (!thread) break;
      inFlight.add(thread.id);
      picked.push(thread.id);
      try {
        const outcome = await runQuestForThread(scope, {
          threadId: thread.id,
          goal: thread.title,
          ...(thread.mode === "agent" ? { mode: "agent" as const } : {}),
          presetRef: thread.agent_id,
        });
        console.log(
          `[scheduler] ${thread.id}（${thread.mode}）→ ${outcome.status}（${outcome.stepsDone}/${outcome.stepsTotal}）岗位=${outcome.presetKey}`,
        );
      } catch (error) {
        failed.push(thread.id);
        console.error(
          `[scheduler] ${thread.id} 执行失败（线程终态由 runQuest 落库，若未落则保持 queued 待下轮）：`,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        inFlight.delete(thread.id);
      }
    }
  }
  return { picked, failed };
}

/**
 * 启动恢复：进程重启后，`running` 且超过阈值无更新的线程标 `paused`（可人工续跑），
 * 并写一条系统事件留痕（不静默丢状态）。
 */
export async function recoverStaleRunningThreads(staleRunningMinutes = DEFAULT_STALE_RUNNING_MIN): Promise<number> {
  const app = getAppPool();
  const workspaces = await listWorkspaces(getOwnerPool());
  let recovered = 0;
  for (const scope of workspaces) {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const r = await client.query<{ id: string }>(
        `UPDATE threads SET status='paused', updated_at=now(),
                error='进程重启：任务中断在执行中（可续跑）'
          WHERE workspace_id=$1 AND status='running'
            AND updated_at < now() - ($2::text || ' minutes')::interval
          RETURNING id`,
        [scope.workspaceId, String(staleRunningMinutes)],
      );
      recovered += r.rowCount ?? 0;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("[scheduler] 重启恢复失败（不阻塞启动）", err instanceof Error ? err.message : String(err));
    } finally {
      client.release();
    }
  }
  return recovered;
}

/** 启动调度器（返回停止函数；intervalMs<=0 时只做一次重启恢复后返回空停止函数） */
export function startThreadScheduler(opts: SchedulerOptions = {}): () => void {
  const cfg = { ...schedulerConfigFromEnv(), ...opts };
  void recoverStaleRunningThreads(cfg.staleRunningMinutes)
    .then((n) => { if (n > 0) console.log(`[scheduler] 重启恢复：${n} 条 running 线程转 paused（可续跑）`); })
    .catch((err) => console.error("[scheduler] 重启恢复异常", err instanceof Error ? err.message : String(err)));
  if (cfg.intervalMs <= 0) return () => undefined;
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // 上一轮未跑完（agent 挂起/审批等待）不叠加
    running = true;
    void sweepQueuedThreads(cfg)
      .catch((err) => console.error("[scheduler] 扫描失败", err instanceof Error ? err.message : String(err)))
      .finally(() => { running = false; });
  }, cfg.intervalMs);
  timer.unref?.();
  console.log(`[scheduler] 已启动：每 ${cfg.intervalMs}ms 扫描 queued 线程（每区每轮 ≤${cfg.batch} 条，并发上限 ${MAX_CONCURRENT_THREADS}）`);
  return () => clearInterval(timer);
}
