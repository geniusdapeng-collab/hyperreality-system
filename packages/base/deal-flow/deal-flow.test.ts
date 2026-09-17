/**
 * deal-flow 测试（内存 mock DB，不依赖真实 Postgres）：
 * 线索建单幂等、报价带校验（超带 escalate L4）、节点推进幂等、催款备稿（只备稿不外发）、结案报告聚合
 */
import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  DealError,
  advanceMilestone,
  applyQuote,
  closureReport,
  createFromLead,
  dunning,
  quoteCheck,
} from "./index.js";

/* ================= 内存 mock DB ================= */

type Row = Record<string, any>;

class MockDb {
  comments: Row[] = [];
  orders: Row[] = [];
  milestones: Row[] = [];
  settlements: Row[] = [];
  events: Array<{ seq: number; event_id: string; hash: string; payload: any }> = [];
  private seq = 7700;

  query(sql: string, params: any[] = []): { rows: Row[]; rowCount: number } {
    const s = sql.replace(/\s+/g, " ").trim();
    const ok = { rows: [], rowCount: 0 };
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return ok;
    if (s.includes("set_config") || s.includes("pg_advisory")) return ok;

    // ---- biz_events ----
    if (/FROM biz_events WHERE tenant_id = \$1 AND event_id = \$2/.test(s)) {
      const e = this.events.find((x) => x.event_id === params[1]);
      return { rows: e ? [{ seq: String(e.seq), hash: e.hash }] : [], rowCount: e ? 1 : 0 };
    }
    if (/FROM biz_events WHERE tenant_id = \$1( AND workspace_id = \$\d+)? ORDER BY seq DESC/.test(s)) {
      const tail = this.events[this.events.length - 1];
      return { rows: tail ? [{ seq: String(tail.seq), hash: tail.hash }] : [], rowCount: tail ? 1 : 0 };
    }
        // P0-3 契约：event_id 由全局序列分配——mock nextval 返回递增计数
    if (/nextval\('biz_events_eid_seq'\)/.test(s)) {
      this._eidSeq = (this._eidSeq ?? 9100) + 1;
      return { rows: [{ v: String(this._eidSeq) }], rowCount: 1 };
    }
if (s.includes("append_event_insert")) {
      const seq = ++this.seq;
      this.events.push({ seq, event_id: params[0], hash: params[6], payload: JSON.parse(params[4]) });
      return { rows: [{ seq: String(seq), inserted: true }], rowCount: 1 };
    }

    // ---- comments ----
    if (/SELECT id FROM comments WHERE workspace_id=\$1 AND id=\$2/.test(s)) {
      const rows = this.comments.filter((x) => x.workspace_id === params[0] && x.id === params[1])
        .map((x) => ({ id: x.id }));
      return { rows, rowCount: rows.length };
    }

    // ---- deal_orders ----
    if (/SELECT \* FROM deal_orders WHERE workspace_id=\$1 AND brand=\$2 AND lead_comment_id=\$3/.test(s)) {
      const rows = this.orders.filter(
        (x) => x.workspace_id === params[0] && x.brand === params[1] && x.lead_comment_id === params[2],
      );
      return { rows, rowCount: rows.length };
    }
    if (/SELECT \* FROM deal_orders WHERE workspace_id=\$1 AND id=\$2/.test(s)) {
      const rows = this.orders.filter((x) => x.workspace_id === params[0] && x.id === params[1]);
      return { rows, rowCount: rows.length };
    }
    if (/INSERT INTO deal_orders/.test(s)) {
      const row: Row = {
        id: params[0], workspace_id: params[1], brand: params[2], contact: params[3],
        amount: "0", quote_band: JSON.parse(params[4]), channel: params[5],
        lead_comment_id: params[6], project_id: params[7], status: "draft",
        created_by: params[8], created_at: new Date().toISOString(), closed_at: null,
        payment_terms: {},
      };
      this.orders.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/UPDATE deal_orders SET amount=\$3, status='quoting'/.test(s)) {
      const row = this.orders.find((x) => x.workspace_id === params[0] && x.id === params[1]);
      if (!row) return { rows: [], rowCount: 0 };
      row.amount = String(params[2]);
      row.status = "quoting";
      return { rows: [row], rowCount: 1 };
    }

    // ---- deal_milestones ----
    if (/SELECT \* FROM deal_milestones WHERE workspace_id=\$1 AND id=\$2/.test(s)) {
      const rows = this.milestones.filter((x) => x.workspace_id === params[0] && x.id === params[1]);
      return { rows, rowCount: rows.length };
    }
    if (/SELECT \* FROM deal_milestones WHERE workspace_id=\$1 AND order_id=\$2/.test(s)) {
      const rows = this.milestones.filter((x) => x.workspace_id === params[0] && x.order_id === params[1]);
      return { rows, rowCount: rows.length };
    }
    if (/UPDATE deal_milestones SET status='done', done_at=now\(\)/.test(s)) {
      const row = this.milestones.find((x) => x.workspace_id === params[0] && x.id === params[1]);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = "done";
      row.done_at = new Date().toISOString();
      if (params[2]) row.note = params[2];
      return { rows: [row], rowCount: 1 };
    }
    if (/UPDATE deal_milestones SET status='overdue'/.test(s)) {
      const row = this.milestones.find((x) => x.workspace_id === params[0] && x.id === params[1]);
      if (row) row.status = "overdue";
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (/FROM deal_milestones m JOIN deal_orders o/.test(s)) {
      const now = Date.parse(params[1]);
      const rows = this.milestones
        .filter((m) => m.workspace_id === params[0] && m.kind === "payment"
          && (m.status === "pending" || m.status === "overdue")
          && m.due_at && Date.parse(m.due_at) < now)
        .map((m) => {
          const o = this.orders.find((x) => x.workspace_id === m.workspace_id && x.id === m.order_id)!;
          return { ...m, brand: o.brand, amount: o.amount };
        });
      return { rows, rowCount: rows.length };
    }

    // ---- settlement_statements ----
    if (/FROM settlement_statements WHERE workspace_id=\$1 AND order_id=\$2/.test(s)) {
      const rows = this.settlements.filter((x) => x.workspace_id === params[0] && x.order_id === params[1]);
      const due = rows.reduce((acc, r) => acc + Number(r.due_amount), 0);
      const paid = rows.reduce((acc, r) => acc + Number(r.paid_amount), 0);
      return {
        rows: [{ due_total: rows.length ? String(due) : null, paid_total: rows.length ? String(paid) : null, n: String(rows.length) }],
        rowCount: 1,
      };
    }

    // ---- 事件号源函数（D29：appendEventInTx 号尾查询，SECURITY DEFINER 全租户口径） ----
    if (/biz_events_max_event_no/.test(s)) {
      return { rows: [{ n: "9900" }], rowCount: 1 };
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

function fixture() {
  const db = new MockDb();
  db.comments.push({ id: "cm-lead-1", workspace_id: scope.workspaceId, text: "想合作，怎么联系" });
  db.orders.push({
    id: "do-1", workspace_id: scope.workspaceId, brand: "某品牌", contact: "张三",
    amount: "0", quote_band: { floor: 10000, ceiling: 50000, currency: "CNY" },
    status: "draft", channel: "dm", lead_comment_id: null, project_id: "VID-001",
    payment_terms: {}, created_by: "m-1", created_at: new Date().toISOString(), closed_at: null,
  });
  return { db, app: poolOf(db), gateway: poolOf(db) };
}

/* ================= createFromLead ================= */

describe("createFromLead 线索建单", () => {
  it("线索评论 → deal_order 草稿 + 同事务 deal.created_from_lead 事件", async () => {
    const { db, app, gateway } = fixture();
    const r = await createFromLead(app, gateway, scope, {
      id: "do-2", commentId: "cm-lead-1", brand: "新品牌",
      quoteBand: { floor: 5000, ceiling: 20000 }, by: "m-1",
    });
    expect(r.deduped).toBe(false);
    expect(r.order.status).toBe("draft");
    expect(r.order.lead_comment_id).toBe("cm-lead-1");
    const ev = db.events.find((e) => e.payload.decision.action === "deal.created_from_lead")!;
    expect(ev.payload.decision.after.orderId).toBe("do-2");
  });

  it("幂等：同品牌同线索重复建单返回已有行", async () => {
    const { db, app, gateway } = fixture();
    const first = await createFromLead(app, gateway, scope, {
      id: "do-2", commentId: "cm-lead-1", brand: "新品牌", by: "m-1",
    });
    const second = await createFromLead(app, gateway, scope, {
      id: "do-3", commentId: "cm-lead-1", brand: "新品牌", by: "m-1",
    });
    expect(second.deduped).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    expect(db.orders.filter((o) => o.brand === "新品牌").length).toBe(1);
  });

  it("线索评论不存在 → LEAD_NOT_FOUND（不凭空建单）", async () => {
    const { app, gateway } = fixture();
    await expect(createFromLead(app, gateway, scope, {
      id: "do-9", commentId: "cm-404", brand: "x", by: "m-1",
    })).rejects.toThrow(DealError);
  });
});

/* ================= quoteCheck / applyQuote ================= */

describe("报价带校验", () => {
  it("quoteCheck 纯函数：带内/超低/超高/无带四态", () => {
    const band = { floor: 10000, ceiling: 50000 };
    expect(quoteCheck(30000, band).inBand).toBe(true);
    const low = quoteCheck(8000, band);
    expect(low.inBand).toBe(false);
    expect(low.escalate).toBe("l4_chairman");
    const high = quoteCheck(60000, band);
    expect(high.escalate).toBe("l4_chairman");
    expect(quoteCheck(1, {}).inBand).toBe(true); // 无报价带免校验
  });

  it("applyQuote：超带落单但事件带 escalate=l4_chairman 标记", async () => {
    const { db, app, gateway } = fixture();
    const r = await applyQuote(app, gateway, scope, "do-1", { amount: 60000, by: "m-1" });
    expect(r.verdict.inBand).toBe(false);
    expect(r.verdict.escalate).toBe("l4_chairman");
    expect(r.order.status).toBe("quoting");
    const ev = db.events.find((e) => e.payload.decision.action === "deal.quoted")!;
    expect(ev.payload.decision.after.escalate).toBe("l4_chairman");
  });

  it("已结案商单不可再报价", async () => {
    const { db, app, gateway } = fixture();
    db.orders[0]!.status = "closed";
    await expect(applyQuote(app, gateway, scope, "do-1", { amount: 20000, by: "m-1" }))
      .rejects.toThrow(DealError);
  });
});

/* ================= advanceMilestone ================= */

describe("advanceMilestone 节点推进", () => {
  it("pending → done + deal.milestone_advanced 事件；重复推进幂等", async () => {
    const { db, app, gateway } = fixture();
    db.milestones.push({
      id: "ms-1", workspace_id: scope.workspaceId, order_id: "do-1", kind: "brief",
      due_at: null, status: "pending", done_at: null, note: null,
      created_by: "m-1", created_at: new Date().toISOString(),
    });
    const r = await advanceMilestone(app, gateway, scope, "ms-1", { by: "m-1", note: "brief 已确认" });
    expect(r.advanced).toBe(true);
    expect(r.milestone.status).toBe("done");
    const ev = db.events.find((e) => e.payload.decision.action === "deal.milestone_advanced")!;
    expect(ev.payload.decision.after.kind).toBe("brief");

    const again = await advanceMilestone(app, gateway, scope, "ms-1", { by: "m-1" });
    expect(again.advanced).toBe(false);
    expect(db.events.filter((e) => e.payload.decision.action === "deal.milestone_advanced").length).toBe(1);
  });

  it("waived 节点拒绝推进", async () => {
    const { db, app, gateway } = fixture();
    db.milestones.push({
      id: "ms-2", workspace_id: scope.workspaceId, order_id: "do-1", kind: "publish",
      due_at: null, status: "waived", done_at: null, note: null,
      created_by: "m-1", created_at: new Date().toISOString(),
    });
    await expect(advanceMilestone(app, gateway, scope, "ms-2", { by: "m-1" })).rejects.toThrow(DealError);
  });
});

/* ================= dunning ================= */

describe("dunning 账期催款备稿", () => {
  it("到期 payment 节点 → 转 overdue + 备稿 + deal.dunning_drafted 事件；二次巡检不重复写事件", async () => {
    const { db, app, gateway } = fixture();
    db.orders[0]!.amount = "30000";
    db.milestones.push({
      id: "ms-pay", workspace_id: scope.workspaceId, order_id: "do-1", kind: "payment",
      due_at: "2026-08-01T00:00:00Z", status: "pending", done_at: null, note: null,
      created_by: "m-1", created_at: new Date().toISOString(),
    });
    const items = await dunning(app, gateway, scope, { now: "2026-08-10T00:00:00Z" });
    expect(items.length).toBe(1);
    expect(items[0]!.daysOverdue).toBe(9);
    expect(items[0]!.newlyOverdue).toBe(true);
    expect(items[0]!.draft).toContain("某品牌");
    expect(items[0]!.draft).toContain("30000.00");
    expect(db.milestones[0]!.status).toBe("overdue");
    expect(db.events.some((e) => e.payload.decision.action === "deal.dunning_drafted")).toBe(true);

    const again = await dunning(app, gateway, scope, { now: "2026-08-12T00:00:00Z" });
    expect(again.length).toBe(1);
    expect(again[0]!.newlyOverdue).toBe(false); // 已逾期只复述
    expect(db.events.filter((e) => e.payload.decision.action === "deal.dunning_drafted").length).toBe(1);
  });

  it("未到期不催；无逾期返回空", async () => {
    const { db, app, gateway } = fixture();
    db.milestones.push({
      id: "ms-pay2", workspace_id: scope.workspaceId, order_id: "do-1", kind: "payment",
      due_at: "2026-09-01T00:00:00Z", status: "pending", done_at: null, note: null,
      created_by: "m-1", created_at: new Date().toISOString(),
    });
    const items = await dunning(app, gateway, scope, { now: "2026-08-10T00:00:00Z" });
    expect(items).toEqual([]);
  });
});

/* ================= closureReport ================= */

describe("closureReport 结案报告", () => {
  it("订单 + 节点完成率 + 结算比对聚合", async () => {
    const { db, app } = fixture();
    db.milestones.push(
      { id: "m1", workspace_id: scope.workspaceId, order_id: "do-1", kind: "brief", due_at: null, status: "done", done_at: "2026-08-01", note: null, created_by: "m-1", created_at: "" },
      { id: "m2", workspace_id: scope.workspaceId, order_id: "do-1", kind: "publish", due_at: null, status: "pending", done_at: null, note: null, created_by: "m-1", created_at: "" },
    );
    db.settlements.push(
      { id: "s1", workspace_id: scope.workspaceId, order_id: "do-1", due_amount: "30000", paid_amount: "28000" },
    );
    const r = await closureReport(app, scope, "do-1");
    expect(r!.order.id).toBe("do-1");
    expect(r!.milestoneCompletion).toBeCloseTo(0.5, 5);
    expect(r!.settlement.dueTotal).toBe(30000);
    expect(r!.settlement.paidTotal).toBe(28000);
    expect(r!.settlement.diffRatio).toBeCloseTo(-2000 / 30000, 5);
  });

  it("不存在返回 null；无结算单 diffRatio null（不伪造）", async () => {
    const { app } = fixture();
    expect(await closureReport(app, scope, "do-404")).toBeNull();
    const r = await closureReport(app, scope, "do-1");
    expect(r!.settlement.diffRatio).toBeNull();
    expect(r!.milestoneCompletion).toBeNull();
  });
});
