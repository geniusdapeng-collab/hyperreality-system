/**
 * cost-ledger 测试（内存 mock DB，不依赖真实 Postgres）：
 * recordCost 落账 + 同事务事件 + 幂等去重；aggregate 三级归集；checkBudget 阈值判定与 tighten 建议
 */
import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  CostLedgerError,
  aggregate,
  checkBudget,
  evalBudget,
  recordCost,
} from "./index.js";

/* ================= 内存 mock DB ================= */

type Row = Record<string, any>;

class MockDb {
  ledger: Row[] = [];
  events: Array<{ seq: number; event_id: string; hash: string; payload: any }> = [];
  private seq = 9900;
  private ledgerSeq = 0;

  query(sql: string, params: any[] = []): { rows: Row[]; rowCount: number } {
    const s = sql.replace(/\s+/g, " ").trim();
    const ok = { rows: [], rowCount: 0 };
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return ok;
    if (s.includes("set_config") || s.includes("pg_advisory")) return ok;

    // ---- biz_events（workdata events.ts 写入段） ----
    if (/FROM biz_events WHERE tenant_id = \$1 AND event_id = \$2/.test(s)) {
      const e = this.events.find((x) => x.event_id === params[1]);
      return { rows: e ? [{ seq: String(e.seq), hash: e.hash }] : [], rowCount: e ? 1 : 0 };
    }
    if (/FROM biz_events WHERE tenant_id = \$1 ORDER BY seq DESC/.test(s)) {
      const tail = this.events[this.events.length - 1];
      return { rows: tail ? [{ seq: String(tail.seq), hash: tail.hash }] : [], rowCount: tail ? 1 : 0 };
    }
    if (s.includes("append_event_insert")) {
      const seq = ++this.seq;
      this.events.push({ seq, event_id: params[0], hash: params[6], payload: JSON.parse(params[4]) });
      return { rows: [{ seq: String(seq), inserted: true }], rowCount: 1 };
    }

    // ---- budget_ledger ----
    if (/SELECT \* FROM budget_ledger WHERE workspace_id=\$1 AND idempotency_key=\$2/.test(s)) {
      const rows = this.ledger.filter((x) => x.workspace_id === params[0] && x.idempotency_key === params[1]);
      return { rows, rowCount: rows.length };
    }
    if (/INSERT INTO budget_ledger/.test(s)) {
      const row: Row = {
        id: String(++this.ledgerSeq), workspace_id: params[0], project_id: params[1],
        episode: params[2], shot_id: params[3], cost_kind: params[4], amount: String(params[5]),
        currency: params[6], idempotency_key: params[7], meta: JSON.parse(params[8]),
        occurred_at: params[9], ref_event_id: null,
      };
      this.ledger.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/UPDATE budget_ledger SET ref_event_id=\$3/.test(s)) {
      const row = this.ledger.find((x) => x.workspace_id === params[0] && x.id === String(params[1]));
      if (row) row.ref_event_id = params[2];
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    // 聚合查询（SUM/COUNT + GROUP BY；mock 按 params 过滤后内存归集）
    if (/FROM budget_ledger WHERE/.test(s) && s.includes("SUM(amount)")) {
      const ws = params[0];
      const hasProject = params.length > 1;
      const rows = this.ledger.filter(
        (x) => x.workspace_id === ws && (!hasProject || x.project_id === params[1]),
      );
      const sum = (rs: Row[]) => rs.reduce((acc, r) => acc + Number(r.amount), 0);
      if (s.includes("COUNT(*)")) {
        return { rows: [{ total: rows.length ? String(sum(rows)) : null, entries: String(rows.length) }], rowCount: 1 };
      }
      const group = (keyFn: (r: Row) => string, filterFn?: (r: Row) => boolean) => {
        const m = new Map<string, Row[]>();
        for (const r of rows) {
          if (filterFn && !filterFn(r)) continue;
          const k = keyFn(r);
          m.set(k, [...(m.get(k) ?? []), r]);
        }
        return [...m.entries()];
      };
      if (s.includes("GROUP BY cost_kind")) {
        return {
          rows: group((r) => r.cost_kind).map(([k, rs]) => ({ cost_kind: k, total: String(sum(rs)) })),
          rowCount: 0,
        };
      }
      if (s.includes("GROUP BY episode, shot_id")) {
        return {
          rows: group((r) => `${r.episode}::${r.shot_id}`, (r) => r.shot_id != null)
            .map(([k, rs]) => ({ episode: rs[0]!.episode, shot_id: rs[0]!.shot_id, total: String(sum(rs)) })),
          rowCount: 0,
        };
      }
      if (s.includes("GROUP BY episode")) {
        return {
          rows: group((r) => String(r.episode))
            .map(([, rs]) => ({ episode: rs[0]!.episode, total: String(sum(rs)) })),
          rowCount: 0,
        };
      }
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
const fixture = () => {
  const db = new MockDb();
  return { db, app: poolOf(db), gateway: poolOf(db) };
};

/* ================= recordCost ================= */

describe("recordCost 计量落账", () => {
  it("落账 + 同事务 budget.cost_recorded 事件 + ref_event_id 互证", async () => {
    const { db, app, gateway } = fixture();
    const r = await recordCost(app, gateway, scope, {
      projectId: "VID-001", episode: "E01", shotId: "S01",
      costKind: "render", amount: 12.5, idempotencyKey: "seedance-task-1", by: "m-1",
    });
    expect(r.deduped).toBe(false);
    expect(db.ledger.length).toBe(1);
    const ev = db.events.find((e) => e.payload.decision.action === "budget.cost_recorded")!;
    expect(ev.payload.decision.after.amount).toBe(12.5);
    expect(db.ledger[0]!.ref_event_id).toBe(ev.event_id);
    expect(r.eventId).toBe(ev.event_id);
  });

  it("幂等：同 idempotencyKey 重复记账返回已有行，不写行不写事件", async () => {
    const { db, app, gateway } = fixture();
    const first = await recordCost(app, gateway, scope, {
      projectId: "VID-001", costKind: "render", amount: 10, idempotencyKey: "k-1", by: "m-1",
    });
    const second = await recordCost(app, gateway, scope, {
      projectId: "VID-001", costKind: "render", amount: 10, idempotencyKey: "k-1", by: "m-1",
    });
    expect(second.deduped).toBe(true);
    expect(second.row.id).toBe(first.row.id);
    expect(second.eventId).toBeNull();
    expect(db.ledger.length).toBe(1);
    expect(db.events.filter((e) => e.payload.decision.action === "budget.cost_recorded").length).toBe(1);
  });

  it("非法成本类型/非有限金额抛错", async () => {
    const { app, gateway } = fixture();
    await expect(recordCost(app, gateway, scope, {
      costKind: "bad" as never, amount: 1, idempotencyKey: "k-x", by: "m-1",
    })).rejects.toThrow(CostLedgerError);
    await expect(recordCost(app, gateway, scope, {
      costKind: "render", amount: Number.NaN, idempotencyKey: "k-y", by: "m-1",
    })).rejects.toThrow(CostLedgerError);
  });
});

/* ================= aggregate 三级归集 ================= */

describe("aggregate 三级归集", () => {
  it("项目级总额 + 按类型/集/镜头三级拆分", async () => {
    const { app, gateway } = fixture();
    const entries = [
      { projectId: "VID-001", episode: "E01", shotId: "S01", costKind: "render" as const, amount: 10, idempotencyKey: "a" },
      { projectId: "VID-001", episode: "E01", shotId: "S02", costKind: "render" as const, amount: 20, idempotencyKey: "b" },
      { projectId: "VID-001", episode: "E02", costKind: "license" as const, amount: 5, idempotencyKey: "c" },
      { projectId: "VID-002", costKind: "ads_spend" as const, amount: 100, idempotencyKey: "d" },
    ];
    for (const e of entries) await recordCost(app, gateway, scope, { ...e, by: "m-1" });

    const p1 = await aggregate(app, scope, { projectId: "VID-001" });
    expect(p1.total).toBe(35);
    expect(p1.entries).toBe(3);
    expect(p1.byCostKind).toEqual({ render: 30, license: 5 });
    expect(p1.byEpisode.find((x) => x.episode === "E01")!.total).toBe(30);
    expect(p1.byShot.length).toBe(2);
    expect(p1.byShot.find((x) => x.shotId === "S02")!.total).toBe(20);

    const all = await aggregate(app, scope);
    expect(all.total).toBe(135);
    expect(all.entries).toBe(4);
  });

  it("空数据返回 0/空集（不伪造）", async () => {
    const { app } = fixture();
    const agg = await aggregate(app, scope, { projectId: "VID-404" });
    expect(agg.total).toBe(0);
    expect(agg.entries).toBe(0);
    expect(agg.byEpisode).toEqual([]);
  });
});

/* ================= checkBudget ================= */

describe("checkBudget 阈值判定", () => {
  it("evalBudget 纯函数：ok / warn / exceeded 三档；budget≤0 不判定", () => {
    expect(evalBudget(50, { budget: 100 }).level).toBe("ok");
    const warn = evalBudget(85, { budget: 100 });
    expect(warn.level).toBe("warn");
    expect(warn.tighten!.action).toBe("escalate_l4");
    const exceeded = evalBudget(120, { budget: 100 });
    expect(exceeded.level).toBe("exceeded");
    expect(exceeded.tighten!.action).toBe("pause_render_submit");
    expect(exceeded.ratio).toBeCloseTo(1.2, 5);
    const noBudget = evalBudget(999, { budget: 0 });
    expect(noBudget.level).toBe("ok");
    expect(noBudget.ratio).toBeNull();
  });

  it("超阈值写 budget.threshold_exceeded 事件（含 tighten 建议）；未超不写", async () => {
    const { db, app, gateway } = fixture();
    await recordCost(app, gateway, scope, {
      projectId: "VID-001", costKind: "render", amount: 130, idempotencyKey: "z1", by: "m-1",
    });
    const v = await checkBudget(app, gateway, scope, { projectId: "VID-001" }, { budget: 100 });
    expect(v.level).toBe("exceeded");
    expect(v.tighten!.action).toBe("pause_render_submit");
    const ev = db.events.find((e) => e.payload.decision.action === "budget.threshold_exceeded")!;
    expect(ev.payload.decision.after.tighten.action).toBe("pause_render_submit");

    const v2 = await checkBudget(app, gateway, scope, { projectId: "VID-404" }, { budget: 100 });
    expect(v2.level).toBe("ok");
    expect(db.events.filter((e) => e.payload.decision.action === "budget.threshold_exceeded").length).toBe(1);
  });
});
