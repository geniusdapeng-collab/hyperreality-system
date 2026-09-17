/**
 * base/captain · 指挥官成绩单（D21，方案 §七 Captain Scorecard）
 * 决策量/层级分布/裁决去向/熔断次数——董事长用它决定「要不要给更大授权」。
 */
import type pg from "pg";

interface Scope { tenantId: string; workspaceId: string }

export interface CeoScorecard {
  decisions: number;           // ceo.decision 裁决数
  briefings: number;           // ceo.briefing 简报数
  initiatives: number;         // initiative.launch 主动立项数
  escalatedToChairman: number; // 上浮 L4 数（谨慎度指标）
  breakerTrips: number;        // 熔断触发次数
  shadowDecisions: number;     // 影子期模拟决策数
  windowDays: number;
  // V2 决策质量（D22）
  hitRate: number | null;      // 决策命中率（命中/(命中+偏离+打脸)，无回测样本为 null）
  outcomeCounts: { hit: number; miss: number; fail: number };
  tierCounts: Record<string, number>; // 分级分布 micro/standard/major
}

export async function buildScorecard(app: pg.Pool, scope: Scope, windowDays = 30): Promise<CeoScorecard> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{ action: string; dry: number | null; n: string }>(
      `SELECT payload->'decision'->>'action' AS action,
              CASE WHEN payload->'decision'->'params'->>'dry_run' = 'true' THEN 1 ELSE 0 END AS dry,
              count(*)::text AS n
       FROM biz_events
       WHERE workspace_id=$1
         AND payload->'who'->>'id' = 'company-ceo'
         AND created_at > now() - ($2 || ' days')::interval
       GROUP BY 1, 2`,
      [scope.workspaceId, String(windowDays)],
    );
    const get = (action: string, dry = 0) =>
      Number(r.rows.find((x) => x.action === action && (x.dry ?? 0) === dry)?.n ?? 0);
    const escalations = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approvals
       WHERE workspace_id=$1 AND tier='l4_chairman' AND snapshot->>'ceo_escalated' = 'true'`,
      [scope.workspaceId],
    ).catch(() => ({ rows: [{ n: "0" }] }));
    // V2：命中率与分级分布（D22）——同事务内（RLS GUC 事务级有效）
    const outcomes = await client.query<{ verdict: string; n: string }>(
      `SELECT payload->'decision'->'params'->>'verdict' AS verdict, count(*)::text AS n
       FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='decision.outcome'
         AND created_at > now() - ($2 || ' days')::interval GROUP BY 1`,
      [scope.workspaceId, String(windowDays)],
    );
    const oc = { hit: 0, miss: 0, fail: 0 };
    for (const o of outcomes.rows) {
      if (o.verdict === "命中") oc.hit = Number(o.n);
      else if (o.verdict === "偏离") oc.miss = Number(o.n);
      else if (o.verdict === "打脸") oc.fail = Number(o.n);
    }
    const totalOutcomes = oc.hit + oc.miss + oc.fail;
    const tiers = await client.query<{ tier: string; n: string }>(
      `SELECT payload->'decision'->'params'->>'tier' AS tier, count(*)::text AS n
       FROM biz_events WHERE workspace_id=$1 AND payload->'decision'->>'action'='ceo.decision'
         AND created_at > now() - ($2 || ' days')::interval GROUP BY 1`,
      [scope.workspaceId, String(windowDays)],
    );
    await client.query("COMMIT");
    return {
      decisions: get("ceo.decision"),
      briefings: get("ceo.briefing"),
      initiatives: get("initiative.launch"),
      escalatedToChairman: Number(escalations.rows[0]?.n ?? 0),
      breakerTrips: get("ceo.circuit_breaker"),
      shadowDecisions: get("ceo.decision", 1),
      windowDays,
      hitRate: totalOutcomes > 0 ? oc.hit / totalOutcomes : null,
      outcomeCounts: oc,
      tierCounts: Object.fromEntries(tiers.rows.filter((t) => t.tier).map((t) => [t.tier as string, Number(t.n)])),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
