/**
 * 本机调度器（GR-16）。
 *
 * 问题（2026-09-28 真机实证）：全系统没有任何调度器——`status='queued'` 的线程
 * 只有"立即执行"这一个入口能跑；客户端注释也承认「本机演示没有独立调度器，只立项会永远排队」。
 * 受影响面：agent 模式（runImmediately 被静默忽略）、任务页/岗位卡派活、服务重启后 queued 遗留。
 *
 * 口径：
 *  - 进程内轻量循环（默认 7s，`WORKLOOM_SCHEDULER_MS=0` 关闭；VPC 可关）；
 *  - 每轮扫描各工作区 queued 线程，按创建时间先进先出，只遵守「运行位」上限——
 *    queued 不占运行配额（MC-302：把 queued 计入并 `>= MAX` 直接 return，
 *    会让 queued ≥ 上限的工作区永久停摆，队列没有任何出口）；
 *    L3.1「单工作区 queued+running ≤10」由派遣入口（建线程事务内）把关，调度器不超发运行位；
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

/**
 * 单工作区：取一条可执行的 queued 线程（含模式与岗位引用）。
 *
 * MC-302（2026-09-30 排雷修复）：
 *  - 并发守卫只统计「有近期心跳的 running」——queued 是被调度器消费的对象，不能同时占运行位，
 *    否则 queued ≥ MAX 时本轮拒绝拾取任何线程，队列只能靠人工逐条 `threads.run` 解锁（自锁）；
 *  - 一次取前若干条排队项并跳过本进程 in-flight，避免队首恰好在本进程执行时整批空转。
 */
async function nextQueuedThread(app: pg.Pool, scope: Scope): Promise<QueuedThread | undefined> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    // 只把「有近期心跳的 running」计入运行位（僵尸 running 不占配额，见 N-15）
    const staleMin = Number(process.env.WORKLOOM_STALE_RUNNING_MIN ?? DEFAULT_STALE_RUNNING_MIN);
    const running = await client.query<{ c: string }>(
      `SELECT count(*) AS c FROM threads
        WHERE workspace_id=$1
          AND status='running'
          AND updated_at > now() - ($2::text || ' minutes')::interval`,
      [scope.workspaceId, String(Number.isFinite(staleMin) && staleMin > 0 ? staleMin : DEFAULT_STALE_RUNNING_MIN)],
    );
    if (Number(running.rows[0]?.c ?? 0) >= MAX_CONCURRENT_THREADS) {
      await client.query("COMMIT");
      return undefined;
    }
    /**
     * A-03 修复：认领必须原子——此前 SELECT 出来后到 runQuest 置 running 之间有装配+LLM 规划
     * 窗口（最长 120s），dispatch(runImmediately)/threads.run/多实例调度器可并发重入同一线程
     * （写工具重复执行=重复发布/扣费）。现在单语句 UPDATE...WHERE status='queued'
     * FOR UPDATE SKIP LOCKED 认领；崩溃留下的 running 由 recoverStaleRunningThreads 兜底（→paused 可续跑）。
     */
    const r = await client.query<QueuedThread>(
      /**
       * 合并口径（T-2026-0929-0200 × T-2026-0929-0201）：
       *  - 并发守卫沿用本轮的 MC-302 修复（只统计新鲜 running，queued 不占运行位，避免排队自锁）；
       *  - 认领改用云端 main 的 A-03 原子语句（UPDATE ... FOR UPDATE SKIP LOCKED），
       *    消除「SELECT 出来到置 running 之间」的并发重入窗口。
       */
      `UPDATE threads SET status='running', updated_at=now()
        WHERE id = (
          SELECT id FROM threads
           WHERE workspace_id=$1 AND status='queued' AND mode <> 'ask'
           ORDER BY created_at ASC LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, title, mode, agent_id`,
      [scope.workspaceId],
    );
    await client.query("COMMIT");
    return r.rows.find((row) => !inFlight.has(row.id));
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
          skipClaim: true, // A-03：本调度器已在 nextQueuedThread 单语句原子认领
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

/**
 * A-05：补续跑「步骤审批已通过（approved/edited）但线程仍停 pending_review」的僵尸线程。
 * 审批自动续跑是进程内 setTimeout，重启即丢；本函数在启动时兜底（幂等：runQuest 按事件态续跑）。
 */
export async function resumeApprovedPendingThreads(): Promise<number> {
  const app = getAppPool();
  const workspaces = await listWorkspaces(getOwnerPool());
  let resumed = 0;
  for (const scope of workspaces) {
    const client = await app.connect();
    let threadIds: string[] = [];
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const r = await client.query<{ id: string }>(
        `SELECT DISTINCT t.id
           FROM threads t
           JOIN biz_events e ON e.session_id = t.id AND e.workspace_id = t.workspace_id
           JOIN approvals a ON a.event_id = e.event_id AND a.workspace_id = t.workspace_id
          WHERE t.workspace_id=$1 AND t.status='pending_review'
            AND a.status IN ('approved','edited')
            AND e.payload->'decision'->>'step_id' IS NOT NULL
          ORDER BY t.id LIMIT 10`,
        [scope.workspaceId],
      );
      threadIds = r.rows.map((x) => x.id);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    for (const threadId of threadIds) {
      try {
        /**
         * 读取线程元数据同样必须带**事务级 RLS 上下文**：threads 对 app 角色启用 RLS，
         * 无 GUC 的 `app.query` 恒 0 行 → 旧写法 `if (!row) continue` 会把每一条候选线程
         * 静默跳过（补扫恒返回 0，看起来"没有僵尸线程"，实测 2026-09-30）。
         */
        const th = await app.connect();
        let row: { title: string; mode: string; agent_id: string | null } | undefined;
        try {
          await th.query("BEGIN");
          await th.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
          await th.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
          const r = await th.query<{ title: string; mode: string; agent_id: string | null }>(
            `SELECT title, mode, agent_id FROM threads WHERE id=$1 AND workspace_id=$2`,
            [threadId, scope.workspaceId],
          );
          row = r.rows[0];
          await th.query("COMMIT");
        } catch (err) {
          await th.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          th.release();
        }
        if (!row) continue;
        const outcome = await runQuestForThread(scope, {
          threadId,
          goal: row.title,
          ...(row.mode === "agent" ? { mode: "agent" as const } : {}),
          presetRef: row.agent_id,
        });
        resumed += 1;
        console.log(`[scheduler] 僵尸线程续跑 ${threadId} → ${outcome.status}`);
      } catch (err) {
        console.error(`[scheduler] 僵尸线程续跑失败 ${threadId}：`, err instanceof Error ? err.message : String(err));
      }
    }
  }
  return resumed;
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
