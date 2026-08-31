/**
 * video/render-poller.ts —— 渲染结果轮询回填（v3.0 下一迭代：异步任务制第二步）
 *
 * 扫描 render_jobs 中 submitted/rendering 的任务，经 gen-pool poll(task_id) 回填：
 *   succeeded → status='done' + result_url + render.complete 事件（actual_seconds 台账回填）
 *   failed    → status='failed' + render.failed 事件（原因留痕，不静默）
 *   running   → status 推进 'rendering'
 * mock 任务（task_id 前缀 mock-）走 MockGenProvider（离线全流程可跑）。
 * 纪律：状态推进与事件同一事务同一 COMMIT（D16 同构）；provider 取自提交事件留痕。
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import {
  MockGenProvider, genPoolFromEnv, type GenProvider,
} from "@workloom/base/model-router";

interface Scope { tenantId: string; workspaceId: string }

interface OpenJob {
  id: string;
  task_id: string;
  script_id: string;
  project_id: string;
  provider: string | null;
}

export interface PollReport {
  checked: number;
  done: number;
  failed: number;
  running: number;
  details: Array<{ jobId: string; status: string; uri?: string; error?: string }>;
}

/** 生成供应商解析：提交事件留痕优先；mock 前缀回退；缺省 seedance（首选） */
function resolveProvider(
  pool: Map<string, GenProvider>,
  job: OpenJob,
  mockPool: Map<string, GenProvider>,
): GenProvider | null {
  if (job.task_id.startsWith("mock-")) {
    return mockPool.get(job.provider ?? "seedance") ?? mockPool.get("seedance") ?? null;
  }
  return pool.get(job.provider ?? "seedance") ?? null;
}

export async function pollRenderJobs(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  opts: { limit?: number; pool?: Map<string, GenProvider> } = {},
): Promise<PollReport> {
  const realPool = opts.pool ?? genPoolFromEnv();
  const mockPool = new Map<string, GenProvider>([
    ["seedance", new MockGenProvider("seedance")],
    ["kling", new MockGenProvider("kling")],
    ["jimeng", new MockGenProvider("jimeng")],
  ]);
  const report: PollReport = { checked: 0, done: 0, failed: 0, running: 0, details: [] };

  const client = await app.connect();
  let jobs: OpenJob[];
  try {
    // 事务级 RLS 上下文必须在显式事务内设置（编码铁律）
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    // 开放任务 + 提交事件留痕的供应商（event 回放取 provider，无留痕回退推断）
    const rows = await client.query<OpenJob>(
      `SELECT j.id, j.task_id, j.script_id, j.project_id,
              (SELECT e.payload->'decision'->'after'->>'provider'
                 FROM biz_events e
                WHERE e.workspace_id=j.workspace_id
                  AND e.payload->'decision'->>'action'='render.submit'
                  AND e.payload->'decision'->'after'->>'jobId'=j.id
                ORDER BY e.seq DESC LIMIT 1) AS provider
         FROM render_jobs j
        WHERE j.workspace_id=$1 AND j.status IN ('submitted','rendering') AND j.task_id IS NOT NULL
        ORDER BY j.created_at ASC
        LIMIT $2`,
      [scope.workspaceId, opts.limit ?? 20],
    );
    jobs = rows.rows;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const gw = await gateway.connect();
  for (const job of jobs) {
    report.checked += 1;
    const provider = resolveProvider(realPool, job, mockPool);
    if (!provider) {
      report.details.push({ jobId: job.id, status: "skip", error: `供应商 ${job.provider ?? "seedance"} 未配置` });
      continue;
    }
    let result: { status: string; uri?: string; actualUnits?: number; error?: string };
    try {
      result = await provider.poll(job.task_id);
    } catch (err) {
      result = { status: "running", error: err instanceof Error ? err.message : String(err) };
    }

    if (result.status === "succeeded" || result.status === "failed") {
      const done = result.status === "succeeded";
      try {
        await gw.query("BEGIN");
        await gw.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await gw.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        await gw.query(
          `UPDATE render_jobs SET status=$3, result_url=$4 WHERE id=$1 AND workspace_id=$2`,
          [job.id, scope.workspaceId, done ? "done" : "failed", result.uri ?? null],
        );
        await gatewayAppendOnClient(gw, { ...scope, actor: { id: "render-poller", type: "system" } }, {
          who: { type: "system", id: "render-poller" },
          context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
          object: { type: "render_job", id: job.id },
          decision: {
            action: done ? "render.complete" : "render.failed",
            after: {
              task_id: job.task_id, provider: provider.providerId,
              result_url: result.uri ?? null, error: result.error ?? null,
              actual_seconds: result.actualUnits ?? null,
            },
            basis: [done ? "轮询回填：渲染成功（异步任务制第二步）" : `轮询回填：渲染失败（${result.error ?? "未知原因"}；不静默）`],
          },
          rule_impact: [],
        });
        await gw.query("COMMIT");
      } catch (err) {
        await gw.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
      if (done) report.done += 1; else report.failed += 1;
      report.details.push({ jobId: job.id, status: done ? "done" : "failed", uri: result.uri, error: result.error });
    } else {
      // 仍在生成：状态推进 rendering（幂等）
      await app.query(
        `UPDATE render_jobs SET status='rendering' WHERE id=$1 AND workspace_id=$2 AND status='submitted'`,
        [job.id, scope.workspaceId],
      );
      report.running += 1;
      report.details.push({ jobId: job.id, status: "running" });
    }
  }
  gw.release();
  return report;
}
