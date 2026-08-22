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
    await client.query("COMMIT");
    const get = (action: string, dry = 0) =>
      Number(r.rows.find((x) => x.action === action && (x.dry ?? 0) === dry)?.n ?? 0);
    const escalations = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM approvals
       WHERE workspace_id=$1 AND tier='l4_chairman' AND snapshot->>'ceo_escalated' = 'true'`,
      [scope.workspaceId],
    ).catch(() => ({ rows: [{ n: "0" }] }));
    return {
      decisions: get("ceo.decision"),
      briefings: get("ceo.briefing"),
      initiatives: get("initiative.launch"),
      escalatedToChairman: Number(escalations.rows[0]?.n ?? 0),
      breakerTrips: get("ceo.circuit_breaker"),
      shadowDecisions: get("ceo.decision", 1),
      windowDays,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
