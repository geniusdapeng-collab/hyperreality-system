/**
 * model-router · 路由质量周报（v3.0 下一迭代：反馈飞轮的数据引擎）
 *
 * 从事件库聚合近 7 天 model.call（生成量）与 model.feedback（👎/升级）：
 *   场景升级率 > 15% → 建议该场景默认档上调一级（autoTuneScenes，用数据调路由表不拍脑袋）；
 *   产出 model.router_review 事件（append-only 可审计）+ 结构化报告（前端/晨报消费）。
 */
import type pg from "pg";
import { gatewayAppend } from "../workdata/gateway.js";
import { autoTuneScenes, type TuneRecommendation } from "./feedback.js";

export interface RouterReviewReport {
  windowDays: number;
  totalGenerations: number;
  totalEscalations: number;
  overallRate: number;
  /** 全量场景统计（按升级率降序） */
  scenes: TuneRecommendation[];
  /** 需上调默认档的场景清单（rate > 阈值） */
  raiseTierScenes: string[];
  generatedAt: string;
}

/** 纯函数：事件 → 场景统计 → 调表建议（可单测） */
export function buildRouterReview(
  events: Array<{ action?: string; after?: Record<string, unknown> }>,
  opts: { windowDays?: number; threshold?: number; now?: Date } = {},
): RouterReviewReport {
  const stats = new Map<string, { generations: number; escalations: number }>();
  for (const e of events) {
    const scene = String(e.after?.scene ?? "");
    if (!scene) continue;
    const s = stats.get(scene) ?? { generations: 0, escalations: 0 };
    if (e.action === "model.call") s.generations += 1;
    else if (e.action === "model.feedback" && e.after?.thumbs === "down") s.escalations += 1;
    stats.set(scene, s);
  }
  const scenes = autoTuneScenes(
    [...stats.entries()].map(([scene, s]) => ({ scene, ...s })),
    opts.threshold ?? 0.15,
  );
  const totalGenerations = scenes.reduce((n, s) => n + (stats.get(s.scene)?.generations ?? 0), 0);
  const totalEscalations = scenes.reduce((n, s) => n + (stats.get(s.scene)?.escalations ?? 0), 0);
  return {
    windowDays: opts.windowDays ?? 7,
    totalGenerations,
    totalEscalations,
    overallRate: totalGenerations > 0 ? totalEscalations / totalGenerations : 0,
    scenes,
    raiseTierScenes: scenes.filter((s) => s.recommendation === "raise-tier").map((s) => s.scene),
    generatedAt: (opts.now ?? new Date()).toISOString(),
  };
}

/**
 * 周报节拍（captain runBeat 挂载点）：近 7 天事件聚合 → model.router_review 事件留痕。
 * 调表建议默认「建议」而非「自动生效」——生效动作走审批（人的权威保留在 1%）。
 */
export async function runRouterReviewBeat(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  opts: { windowDays?: number } = {},
): Promise<{ eventId: string; report: RouterReviewReport }> {
  const windowDays = opts.windowDays ?? 7;
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const client = await app.connect();
  let events: Array<{ action?: string; after?: Record<string, unknown> }>;
  try {
    // 事务级 RLS 上下文必须在显式事务内设置（编码铁律）
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const rows = await client.query<{ payload: { decision?: { action?: string; after?: Record<string, unknown> } } }>(
      `SELECT payload FROM biz_events
       WHERE workspace_id=$1
         AND payload->'decision'->>'action' IN ('model.call','model.feedback')
         AND (payload->'context'->>'time')::timestamptz >= $2`,
      [scope.workspaceId, since],
    );
    events = rows.rows.map((r) => ({
      action: r.payload.decision?.action,
      after: r.payload.decision?.after,
    }));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const report = buildRouterReview(events, { windowDays });
  const r = await gatewayAppend(gateway, { ...scope, actor: { id: "model-router", type: "system" } }, {
    who: { type: "system", id: "model-router" },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
    object: { type: "store", id: scope.workspaceId },
    decision: {
      action: "model.router_review",
      after: report as unknown as Record<string, unknown>,
      basis: [
        `路由质量周报：近 ${windowDays} 天 ${report.totalGenerations} 次生成、升级率 ${(report.overallRate * 100).toFixed(1)}%`,
        report.raiseTierScenes.length > 0
          ? `建议上调默认档：${report.raiseTierScenes.join("、")}（升级率 >15%，生效走审批）`
          : "全部场景升级率健康（≤15%）",
      ],
    },
    rule_impact: [],
  });
  return { eventId: r.eventId, report };
}
