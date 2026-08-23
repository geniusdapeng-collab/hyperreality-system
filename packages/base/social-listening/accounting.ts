/**
 * social-listening · 爆款会计学（聚合查询，纯读）
 *
 * 三个聚合视角：
 *  - topicHitRate：选题卡 → 发布 → 数据回溯命中率（topic_cards.expected vs account_metrics 实际播放）
 *  - unitEconomics：单条经济账（budget_ledger 成本 meta.video_id 挂接 vs 播放/转化）
 *  - roiReview：投入产出复盘（渲染+投放成本 vs 商单回款，按项目归集）
 * 纪律：纯读不落库；无数据返回空集/null 比率（不伪造）；涨粉口径以 conversions 代理
 *      （account_metrics 无独立涨粉字段，返回中明确标注口径）。
 * 数据链：topic_cards ← content_calendar.topic_card_id → asset_id = account_metrics.video_id
 *      （content_calendar.asset_id 即成片，发布回执的平台视频 ID 落 account_metrics.video_id）。
 */
import type pg from "pg";

interface Scope { tenantId: string; workspaceId: string }

/** scoped 只读事务（事务级 RLS GUC 双保险，越权返回空 L7.1 同源） */
async function inTx<T>(app: pg.Pool, scope: Scope, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ================= ① topicHitRate：选题命中率 ================= */

export interface TopicHitItem {
  topicCardId: string;
  title: string;
  /** 预期播放（expected.plays；无预期 = 不可测） */
  expectedPlays: number | null;
  /** 回溯实际播放（calendar→metrics 链路求和；无链路数据 = 0） */
  actualPlays: number;
  /** 命中 = 实际 ≥ 预期；不可测为 null */
  hit: boolean | null;
}

export interface TopicHitRate {
  /** 已发布选题卡总数 */
  published: number;
  /** 可回测数（有 expected.plays 预期） */
  measurable: number;
  hits: number;
  /** hits/measurable；不可测样本为 0 时 null（不伪造） */
  hitRate: number | null;
  items: TopicHitItem[];
}

export async function topicHitRate(app: pg.Pool, scope: Scope): Promise<TopicHitRate> {
  const rows = await inTx(app, scope, async (c) => {
    const r = await c.query<{ id: string; title: string; expected: Record<string, unknown>; plays: string }>(
      `SELECT t.id, t.title, t.expected,
              COALESCE(SUM(m.plays), 0)::text AS plays
       FROM topic_cards t
       LEFT JOIN content_calendar c
         ON c.workspace_id = t.workspace_id AND c.topic_card_id = t.id
       LEFT JOIN account_metrics m
         ON m.workspace_id = t.workspace_id AND m.video_id = c.asset_id
       WHERE t.workspace_id = $1 AND t.status = 'published'
       GROUP BY t.id, t.title, t.expected
       ORDER BY t.id`,
      [scope.workspaceId],
    );
    return r.rows;
  });
  const items: TopicHitItem[] = rows.map((r) => {
    const expectedPlays = typeof r.expected?.plays === "number" && Number.isFinite(r.expected.plays)
      ? (r.expected.plays as number) : null;
    const actualPlays = Number(r.plays);
    return {
      topicCardId: r.id, title: r.title, expectedPlays, actualPlays,
      hit: expectedPlays === null ? null : actualPlays >= expectedPlays,
    };
  });
  const measurable = items.filter((i) => i.hit !== null);
  const hits = measurable.filter((i) => i.hit === true).length;
  return {
    published: items.length,
    measurable: measurable.length,
    hits,
    hitRate: measurable.length > 0 ? hits / measurable.length : null,
    items,
  };
}

/* ================= ② unitEconomics：单条经济账 ================= */

export interface UnitEconomicsItem {
  videoId: string;
  /** 成本（budget_ledger meta.video_id 挂接求和；无成本记录 = 0） */
  cost: number;
  /** 播放（无指标记录 = null，不伪造 0 播放） */
  plays: number | null;
  /** 转化（涨粉代理口径：account_metrics.conversions；无记录 = null） */
  conversions: number | null;
  /** 单播放成本 cost/plays；无播放数据 = null */
  costPerPlay: number | null;
}

export interface UnitEconomics {
  items: UnitEconomicsItem[];
  /** 口径说明（涨粉代理） */
  notes: string[];
}

/** 单条经济账（projectId 缺省 = 工作区全量） */
export async function unitEconomics(
  app: pg.Pool,
  scope: Scope,
  filter: { projectId?: string } = {},
): Promise<UnitEconomics> {
  return inTx(app, scope, async (c) => {
    const costParams: unknown[] = [scope.workspaceId];
    let costWhere = "workspace_id = $1 AND meta ? 'video_id'";
    if (filter.projectId) {
      costParams.push(filter.projectId);
      costWhere += ` AND project_id = $${costParams.length}`;
    }
    const costs = await c.query<{ video_id: string; cost: string }>(
      `SELECT meta->>'video_id' AS video_id, SUM(amount)::text AS cost
       FROM budget_ledger WHERE ${costWhere} GROUP BY 1`,
      costParams,
    );
    const metrics = await c.query<{ video_id: string; plays: string; conversions: string }>(
      `SELECT video_id, SUM(plays)::text AS plays, SUM(conversions)::text AS conversions
       FROM account_metrics WHERE workspace_id=$1 AND video_id IS NOT NULL GROUP BY video_id`,
      [scope.workspaceId],
    );
    const metricByVideo = new Map(metrics.rows.map((m) => [m.video_id, m]));
    const items: UnitEconomicsItem[] = costs.rows.map((row) => {
      const m = metricByVideo.get(row.video_id);
      const cost = Number(row.cost);
      const plays = m ? Number(m.plays) : null;
      return {
        videoId: row.video_id,
        cost,
        plays,
        conversions: m ? Number(m.conversions) : null,
        costPerPlay: plays !== null && plays > 0 ? cost / plays : null,
      };
    });
    return {
      items,
      notes: ["涨粉口径以 account_metrics.conversions 代理（时序表无独立涨粉字段，不伪造）"],
    };
  });
}

/* ================= ③ roiReview：投入产出复盘 ================= */

export interface RoiReviewItem {
  projectId: string;
  /** 渲染成本（cost_kind=render） */
  renderCost: number;
  /** 投放成本（cost_kind=ads_spend） */
  adsCost: number;
  /** 回款（settlement_statements.paid_amount 经 deal_orders.project_id 归集） */
  revenue: number;
  /** (revenue - cost) / cost；成本为 0 = null（不伪造） */
  roi: number | null;
}

export interface RoiReview {
  items: RoiReviewItem[];
  totals: { renderCost: number; adsCost: number; revenue: number; roi: number | null };
}

/** 投入产出复盘（渲染+投放 vs 回款，按项目归集） */
export async function roiReview(app: pg.Pool, scope: Scope): Promise<RoiReview> {
  return inTx(app, scope, async (c) => {
    const costs = await c.query<{ project_id: string; cost_kind: string; total: string }>(
      `SELECT project_id, cost_kind, SUM(amount)::text AS total
       FROM budget_ledger
       WHERE workspace_id=$1 AND project_id IS NOT NULL AND cost_kind IN ('render','ads_spend')
       GROUP BY project_id, cost_kind`,
      [scope.workspaceId],
    );
    const revenues = await c.query<{ project_id: string; revenue: string }>(
      `SELECT d.project_id, SUM(s.paid_amount)::text AS revenue
       FROM settlement_statements s
       JOIN deal_orders d ON d.workspace_id = s.workspace_id AND d.id = s.order_id
       WHERE s.workspace_id=$1 AND d.project_id IS NOT NULL
       GROUP BY d.project_id`,
      [scope.workspaceId],
    );
    const revenueByProject = new Map(revenues.rows.map((r) => [r.project_id, Number(r.revenue)]));
    const byProject = new Map<string, RoiReviewItem>();
    const ensure = (pid: string): RoiReviewItem => {
      const cur = byProject.get(pid) ?? { projectId: pid, renderCost: 0, adsCost: 0, revenue: 0, roi: null };
      byProject.set(pid, cur);
      return cur;
    };
    for (const row of costs.rows) {
      const item = ensure(row.project_id);
      if (row.cost_kind === "render") item.renderCost += Number(row.total);
      else item.adsCost += Number(row.total);
    }
    for (const [pid, revenue] of revenueByProject) {
      ensure(pid).revenue = revenue;
    }
    const items = [...byProject.values()].map((i) => {
      const cost = i.renderCost + i.adsCost;
      return { ...i, roi: cost > 0 ? (i.revenue - cost) / cost : null };
    });
    const totals = items.reduce(
      (acc, i) => ({ renderCost: acc.renderCost + i.renderCost, adsCost: acc.adsCost + i.adsCost, revenue: acc.revenue + i.revenue }),
      { renderCost: 0, adsCost: 0, revenue: 0 },
    );
    const totalCost = totals.renderCost + totals.adsCost;
    return { items, totals: { ...totals, roi: totalCost > 0 ? (totals.revenue - totalCost) / totalCost : null } };
  });
}
