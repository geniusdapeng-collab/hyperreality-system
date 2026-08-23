/**
 * accounting 测试（内存 mock DB，不依赖真实 Postgres）：
 * topicHitRate 命中率（含不可测样本）；unitEconomics 单条经济账；roiReview 投入产出复盘；空数据不伪造
 */
import { describe, expect, it } from "vitest";
import type pg from "pg";
import { roiReview, topicHitRate, unitEconomics } from "./accounting.js";

/* ================= 内存 mock DB ================= */

type Row = Record<string, any>;

class MockDb {
  topicCards: Row[] = [];
  calendar: Row[] = [];
  metrics: Row[] = [];
  ledger: Row[] = [];
  orders: Row[] = [];
  settlements: Row[] = [];

  query(sql: string, params: any[] = []): { rows: Row[]; rowCount: number } {
    const s = sql.replace(/\s+/g, " ").trim();
    const ok = { rows: [], rowCount: 0 };
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return ok;
    if (s.includes("set_config")) return ok;

    // topicHitRate：topic_cards ⋈ calendar ⋈ metrics
    if (/FROM topic_cards t/.test(s)) {
      const rows = this.topicCards
        .filter((t) => t.workspace_id === params[0] && t.status === "published")
        .map((t) => {
          const assetIds = this.calendar
            .filter((c) => c.workspace_id === t.workspace_id && c.topic_card_id === t.id)
            .map((c) => c.asset_id);
          const plays = this.metrics
            .filter((m) => m.workspace_id === t.workspace_id && assetIds.includes(m.video_id))
            .reduce((acc, m) => acc + Number(m.plays), 0);
          return { id: t.id, title: t.title, expected: t.expected, plays: String(plays) };
        });
      return { rows, rowCount: rows.length };
    }

    // unitEconomics：成本挂接 + 指标
    if (/FROM budget_ledger WHERE workspace_id = \$1 AND meta \? 'video_id'/.test(s)) {
      const hasProject = params.length > 1;
      const m = new Map<string, number>();
      for (const r of this.ledger) {
        if (r.workspace_id !== params[0]) continue;
        if (hasProject && r.project_id !== params[1]) continue;
        const vid = r.meta?.video_id;
        if (typeof vid !== "string") continue;
        m.set(vid, (m.get(vid) ?? 0) + Number(r.amount));
      }
      const rows = [...m.entries()].map(([video_id, cost]) => ({ video_id, cost: String(cost) }));
      return { rows, rowCount: rows.length };
    }
    if (/FROM account_metrics WHERE workspace_id=\$1 AND video_id IS NOT NULL GROUP BY video_id/.test(s)) {
      const m = new Map<string, { plays: number; conversions: number }>();
      for (const r of this.metrics) {
        if (r.workspace_id !== params[0] || !r.video_id) continue;
        const cur = m.get(r.video_id) ?? { plays: 0, conversions: 0 };
        cur.plays += Number(r.plays);
        cur.conversions += Number(r.conversions);
        m.set(r.video_id, cur);
      }
      const rows = [...m.entries()].map(([video_id, v]) => ({
        video_id, plays: String(v.plays), conversions: String(v.conversions),
      }));
      return { rows, rowCount: rows.length };
    }

    // roiReview：成本与回款
    if (/FROM budget_ledger WHERE workspace_id=\$1 AND project_id IS NOT NULL AND cost_kind IN/.test(s)) {
      const m = new Map<string, number>();
      for (const r of this.ledger) {
        if (r.workspace_id !== params[0] || !r.project_id) continue;
        if (r.cost_kind !== "render" && r.cost_kind !== "ads_spend") continue;
        m.set(`${r.project_id}::${r.cost_kind}`, (m.get(`${r.project_id}::${r.cost_kind}`) ?? 0) + Number(r.amount));
      }
      const rows = [...m.entries()].map(([k, total]) => {
        const [project_id, cost_kind] = k.split("::");
        return { project_id, cost_kind, total: String(total) };
      });
      return { rows, rowCount: rows.length };
    }
    if (/FROM settlement_statements s JOIN deal_orders d/.test(s)) {
      const m = new Map<string, number>();
      for (const st of this.settlements) {
        if (st.workspace_id !== params[0]) continue;
        const order = this.orders.find((o) => o.workspace_id === st.workspace_id && o.id === st.order_id);
        if (!order?.project_id) continue;
        m.set(order.project_id, (m.get(order.project_id) ?? 0) + Number(st.paid_amount));
      }
      const rows = [...m.entries()].map(([project_id, revenue]) => ({ project_id, revenue: String(revenue) }));
      return { rows, rowCount: rows.length };
    }

    throw new Error(`mock 未覆盖 SQL: ${s}`);
  }
}

function poolOf(db: MockDb): pg.Pool {
  const client = {
    query: (sql: string, p?: any[]) => Promise.resolve(db.query(sql, p)),
    release: () => undefined,
  };
  return { connect: async () => client, query: client.query } as unknown as pg.Pool;
}

const scope = { tenantId: "tenant-demo", workspaceId: "ws-video" };

/* ================= topicHitRate ================= */

describe("topicHitRate 选题命中率", () => {
  it("发布选题回溯：命中/未命中/不可测三态；命中率 = 命中/可测", async () => {
    const db = new MockDb();
    db.topicCards.push(
      { id: "tc-1", workspace_id: scope.workspaceId, title: "通勤剧情", status: "published", expected: { plays: 10000 } },
      { id: "tc-2", workspace_id: scope.workspaceId, title: "开箱测评", status: "published", expected: { plays: 5000 } },
      { id: "tc-3", workspace_id: scope.workspaceId, title: "无预期选题", status: "published", expected: {} },
      { id: "tc-4", workspace_id: scope.workspaceId, title: "未发布选题", status: "pool", expected: { plays: 1 } },
    );
    db.calendar.push(
      { id: "cal-1", workspace_id: scope.workspaceId, topic_card_id: "tc-1", asset_id: "vid-a" },
      { id: "cal-2", workspace_id: scope.workspaceId, topic_card_id: "tc-2", asset_id: "vid-b" },
    );
    db.metrics.push(
      { workspace_id: scope.workspaceId, video_id: "vid-a", plays: 12000, conversions: 10 },
      { workspace_id: scope.workspaceId, video_id: "vid-a", plays: 1500, conversions: 2 }, // 多次采集求和
      { workspace_id: scope.workspaceId, video_id: "vid-b", plays: 3000, conversions: 0 },
    );
    const r = await topicHitRate(poolOf(db), scope);
    expect(r.published).toBe(3); // tc-4 未发布不计入
    expect(r.measurable).toBe(2);
    expect(r.hits).toBe(1); // tc-1：13500 ≥ 10000；tc-2：3000 < 5000
    expect(r.hitRate).toBeCloseTo(0.5, 5);
    const t3 = r.items.find((i) => i.topicCardId === "tc-3")!;
    expect(t3.hit).toBeNull(); // 无预期 → 不可测
    const t1 = r.items.find((i) => i.topicCardId === "tc-1")!;
    expect(t1.actualPlays).toBe(13500);
    expect(t1.hit).toBe(true);
  });

  it("无可测样本 → hitRate null（不伪造）", async () => {
    const db = new MockDb();
    const r = await topicHitRate(poolOf(db), scope);
    expect(r.published).toBe(0);
    expect(r.hitRate).toBeNull();
    expect(r.items).toEqual([]);
  });
});

/* ================= unitEconomics ================= */

describe("unitEconomics 单条经济账", () => {
  it("成本挂接 meta.video_id + 指标求和 + 单播放成本", async () => {
    const db = new MockDb();
    db.ledger.push(
      { workspace_id: scope.workspaceId, project_id: "VID-001", amount: "100", meta: { video_id: "vid-a" } },
      { workspace_id: scope.workspaceId, project_id: "VID-001", amount: "50", meta: { video_id: "vid-a" } },
      { workspace_id: scope.workspaceId, project_id: "VID-001", amount: "30", meta: { video_id: "vid-c" } },
      { workspace_id: scope.workspaceId, project_id: "VID-002", amount: "999", meta: { video_id: "vid-x" } },
    );
    db.metrics.push({ workspace_id: scope.workspaceId, video_id: "vid-a", plays: 15000, conversions: 25 });
    const r = await unitEconomics(poolOf(db), scope, { projectId: "VID-001" });
    expect(r.items.length).toBe(2); // vid-x 属 VID-002 被过滤
    const a = r.items.find((i) => i.videoId === "vid-a")!;
    expect(a.cost).toBe(150);
    expect(a.plays).toBe(15000);
    expect(a.conversions).toBe(25);
    expect(a.costPerPlay).toBeCloseTo(0.01, 5);
    const c = r.items.find((i) => i.videoId === "vid-c")!;
    expect(c.plays).toBeNull(); // 无指标 → null 不伪造
    expect(c.costPerPlay).toBeNull();
    expect(r.notes[0]).toContain("conversions");
  });

  it("空数据返回空集", async () => {
    const db = new MockDb();
    const r = await unitEconomics(poolOf(db), scope);
    expect(r.items).toEqual([]);
  });
});

/* ================= roiReview ================= */

describe("roiReview 投入产出复盘", () => {
  it("渲染+投放成本 vs 商单回款，按项目归集；ROI = (回款-成本)/成本", async () => {
    const db = new MockDb();
    db.ledger.push(
      { workspace_id: scope.workspaceId, project_id: "VID-001", cost_kind: "render", amount: "200" },
      { workspace_id: scope.workspaceId, project_id: "VID-001", cost_kind: "ads_spend", amount: "800" },
      { workspace_id: scope.workspaceId, project_id: "VID-001", cost_kind: "license", amount: "50" }, // 不计入
      { workspace_id: scope.workspaceId, project_id: "VID-002", cost_kind: "render", amount: "300" },
    );
    db.orders.push(
      { id: "do-1", workspace_id: scope.workspaceId, project_id: "VID-001" },
      { id: "do-2", workspace_id: scope.workspaceId, project_id: null }, // 无项目挂接 → 不归集
    );
    db.settlements.push(
      { id: "ss-1", workspace_id: scope.workspaceId, order_id: "do-1", paid_amount: "2000" },
      { id: "ss-2", workspace_id: scope.workspaceId, order_id: "do-2", paid_amount: "500" },
    );
    const r = await roiReview(poolOf(db), scope);
    const p1 = r.items.find((i) => i.projectId === "VID-001")!;
    expect(p1.renderCost).toBe(200);
    expect(p1.adsCost).toBe(800);
    expect(p1.revenue).toBe(2000);
    expect(p1.roi).toBeCloseTo(1.0, 5); // (2000-1000)/1000
    const p2 = r.items.find((i) => i.projectId === "VID-002")!;
    expect(p2.revenue).toBe(0);
    expect(p2.roi).toBeCloseTo(-1.0, 5); // 纯投入未回款
    expect(r.totals.revenue).toBe(2000);
    expect(r.totals.roi).toBeCloseTo((2000 - 1300) / 1300, 5);
  });

  it("空数据 totals 全 0 且 roi null", async () => {
    const db = new MockDb();
    const r = await roiReview(poolOf(db), scope);
    expect(r.items).toEqual([]);
    expect(r.totals).toEqual({ renderCost: 0, adsCost: 0, revenue: 0, roi: null });
  });
});
