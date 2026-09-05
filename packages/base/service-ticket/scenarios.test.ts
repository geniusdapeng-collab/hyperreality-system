/**
 * service-ticket · 大规模功能场景套件（C：工单生命周期）
 * 覆盖：创建（四类 + 幂等重放 + 非法类型拒绝）、部门路由表（delivery→配送组/repair→维修组/
 * complaint→客服主管/other→客服组 + 自定义覆盖）、状态机全部合法/非法跃迁矩阵（created→assigned
 * →processing→done→closed 及全部非法对）、SLA（到期扫描/逐级升级/同日幂等去重/urgent 告警）、
 * 完成回填、时间线完整性、五元事件留痕。DB 走内存 FakeDb。
 */
import { describe, expect, it } from "vitest";
import { FakeDb, nextSerial } from "../testing/fake-pg.js";
import {
  assertTicketTransition, nextStatusOf, TicketTransitionError, type TicketStatus,
} from "./state.js";
import { DEFAULT_DEPT_ROUTES, DEFAULT_SLA_HOURS, TICKET_KINDS, type TicketKind } from "./constants.js";
import {
  advanceTicket, assignTicket, closeTicket, completeTicket, createTicket,
  listTickets, slaScan, ticketTimeline, type Ticket,
} from "./tickets.js";
import type { ServiceEventDraft } from "../service-dialog/dialog.js";

const WS = "ws-scen-tck";
const CTX = { tenantId: "tenant-demo", workspaceId: WS };
const HUMAN = { type: "human" as const, id: "MEM-001" };

/* ================= FakeDb 接线（c_tickets / c_ticket_events） ================= */

function wireTicketDb(db: FakeDb): FakeDb {
  db.on(/^INSERT INTO c_tickets/, (p, d) => {
    const dup = d.table("c_tickets").find((r) => r["workspace_id"] === p[1] && r["idempotency_key"] === p[8]);
    if (dup) return { rows: [] }; // ON CONFLICT DO NOTHING
    const slaHours = Number(p[9]);
    const row = {
      id: p[0], workspace_id: p[1], c_user_id: p[2], conversation_id: p[3], kind: p[4],
      title: p[5], payload: JSON.parse(String(p[6])), status: "created", priority: p[7],
      dept: null, assignee: null,
      sla_due_at: new Date(Date.now() + slaHours * 3600_000).toISOString(),
      result: null, idempotency_key: p[8],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    d.table("c_tickets").push(row);
    return { rows: [row] };
  });
  db.on(/^SELECT \* FROM c_tickets WHERE workspace_id=\$1 AND idempotency_key=\$2/, (p, d) => ({
    rows: d.table("c_tickets").filter((r) => r["workspace_id"] === p[0] && r["idempotency_key"] === p[1]),
  }));
  db.on(/^SELECT \* FROM c_tickets WHERE id=\$1 AND workspace_id=\$2 FOR UPDATE/, (p, d) => ({
    rows: d.table("c_tickets").filter((r) => r["id"] === p[0] && r["workspace_id"] === p[1]),
  }));
  db.on(/^UPDATE c_tickets SET status='assigned', dept=\$3, assignee=\$4/, (p, d) => {
    const row = d.table("c_tickets").find((r) => r["id"] === p[0] && r["workspace_id"] === p[1]);
    if (!row) return { rows: [] };
    row["status"] = "assigned"; row["dept"] = p[2]; row["assignee"] = p[3];
    row["updated_at"] = new Date().toISOString();
    return { rows: [row] };
  });
  db.on(/^UPDATE c_tickets SET status='done', result=\$3/, (p, d) => {
    const row = d.table("c_tickets").find((r) => r["id"] === p[0] && r["workspace_id"] === p[1]);
    if (!row) return { rows: [] };
    row["status"] = "done"; row["result"] = JSON.parse(String(p[2]));
    row["updated_at"] = new Date().toISOString();
    return { rows: [row] };
  });
  db.on(/^UPDATE c_tickets SET status='closed'/, (p, d) => {
    const row = d.table("c_tickets").find((r) => r["id"] === p[0] && r["workspace_id"] === p[1]);
    if (!row) return { rows: [] };
    row["status"] = "closed";
    row["updated_at"] = new Date().toISOString();
    return { rows: [row] };
  });
  // advanceTicket / slaScan priority 更新（status=$3 / priority=$3）
  db.on(/^UPDATE c_tickets SET status=\$3, updated_at=now\(\)/, (p, d) => {
    const row = d.table("c_tickets").find((r) => r["id"] === p[0] && r["workspace_id"] === p[1]);
    if (!row) return { rows: [] };
    row["status"] = p[2];
    row["updated_at"] = new Date().toISOString();
    return { rows: [row] };
  });
  db.on(/^UPDATE c_tickets SET priority=\$3, updated_at=now\(\)/, (p, d) => {
    const row = d.table("c_tickets").find((r) => r["id"] === p[0] && r["workspace_id"] === p[1]);
    if (!row) return { rows: [] };
    row["priority"] = p[2];
    row["updated_at"] = new Date().toISOString();
    return { rows: [row] };
  });
  db.on(/^INSERT INTO c_ticket_events/, (p, d) => {
    d.table("c_ticket_events").push({
      id: nextSerial(d, "c_ticket_events"), workspace_id: p[0], ticket_id: p[1],
      action: p[2], actor_type: p[3], actor_id: p[4], detail: JSON.parse(String(p[5])),
      created_at: new Date().toISOString(),
    });
    return { rows: [] };
  });
  // listTickets（可选过滤参数 + 末位 LIMIT）
  db.on(/^SELECT \* FROM c_tickets WHERE workspace_id = \$1/, (p, d) => {
    let rows = d.table("c_tickets").filter((r) => r["workspace_id"] === p[0]);
    for (const extra of p.slice(1, -1)) {
      rows = rows.filter((r) =>
        r["status"] === extra || r["kind"] === extra || r["c_user_id"] === extra ||
        r["dept"] === extra || r["priority"] === extra);
    }
    return { rows: rows.slice(0, Number(p[p.length - 1])) };
  });
  db.on(/^SELECT \* FROM c_ticket_events WHERE workspace_id=\$1 AND ticket_id=\$2 ORDER BY id ASC/, (p, d) => ({
    rows: d.table("c_ticket_events")
      .filter((r) => r["workspace_id"] === p[0] && r["ticket_id"] === p[1])
      .sort((a, b) => Number(a["id"]) - Number(b["id"])),
  }));
  // slaScan 到期单选取（now 参数比较）
  db.on(/status IN \('created','assigned','processing'\) AND sla_due_at IS NOT NULL AND sla_due_at < \$2/, (p, d) => ({
    rows: d.table("c_tickets").filter((r) =>
      r["workspace_id"] === p[0] &&
      ["created", "assigned", "processing"].includes(String(r["status"])) &&
      r["sla_due_at"] && String(r["sla_due_at"]) < String(p[1])),
  }));
  // slaScan 同日幂等去重检查
  db.on(/SELECT 1 FROM c_ticket_events .*action='sla_escalated'/, (p, d) => ({
    rows: d.table("c_ticket_events").filter((r) =>
      r["workspace_id"] === p[0] && r["ticket_id"] === p[1] && r["action"] === "sla_escalated" &&
      (r["detail"] as Record<string, unknown>)["from"] === p[2] &&
      (r["detail"] as Record<string, unknown>)["to"] === p[3]).slice(0, 1),
  }));
  return db;
}

function memoryEmit(sink: ServiceEventDraft[]) {
  return async (_ctx: unknown, draft: ServiceEventDraft) => {
    sink.push(draft);
    return { eventId: `E-${sink.length}` };
  };
}

async function makeTicket(db: FakeDb, kind: TicketKind, key: string): Promise<Ticket> {
  const { ticket } = await createTicket(db, CTX, {
    kind, title: `测试单-${kind}`, payload: { room: "8808" }, idempotencyKey: key,
  }, HUMAN);
  return ticket;
}

/* ================= C1. 状态机矩阵（纯函数） ================= */

describe("C1 状态机 · 合法跃迁", () => {
  const legal: Array<[TicketStatus, TicketStatus]> = [
    ["created", "assigned"], ["created", "closed"],
    ["assigned", "processing"], ["processing", "done"], ["done", "closed"],
  ];
  for (const [from, to] of legal) {
    it(`${from} → ${to} 合法`, () => {
      expect(() => assertTicketTransition(from, to)).not.toThrow();
    });
  }
});

describe("C1 状态机 · 非法跃迁矩阵（15 对全拒）", () => {
  const illegal: Array<[TicketStatus, TicketStatus]> = [
    ["created", "processing"], ["created", "done"],
    ["assigned", "created"], ["assigned", "done"], ["assigned", "closed"],
    ["processing", "created"], ["processing", "assigned"], ["processing", "closed"],
    ["done", "created"], ["done", "assigned"], ["done", "processing"],
    ["closed", "created"], ["closed", "assigned"], ["closed", "processing"], ["closed", "done"],
  ];
  for (const [from, to] of illegal) {
    it(`${from} → ${to} 抛 TicketTransitionError`, () => {
      expect(() => assertTicketTransition(from, to)).toThrow(TicketTransitionError);
      expect(() => assertTicketTransition(from, to)).toThrow(`${from} → ${to}`);
    });
  }
});

describe("C1 状态机 · nextStatusOf 推导", () => {
  it("assigned → processing；processing → done", () => {
    expect(nextStatusOf("assigned")).toBe("processing");
    expect(nextStatusOf("processing")).toBe("done");
  });

  it("created 排除 closed 后唯一推进态为 assigned", () => {
    expect(nextStatusOf("created")).toBe("assigned");
  });

  it("done / closed 无推进态 → 抛错", () => {
    expect(() => nextStatusOf("done")).toThrow(TicketTransitionError);
    expect(() => nextStatusOf("closed")).toThrow(TicketTransitionError);
  });
});

/* ================= C2. 创建（四类 + 幂等 + 缺参拒绝） ================= */

describe("C2 创建 · 类型/幂等/SLA", () => {
  for (const kind of TICKET_KINDS) {
    it(`创建 ${kind} 单：status=created + 默认 SLA 时限`, async () => {
      const db = wireTicketDb(new FakeDb());
      const t = await makeTicket(db, kind, `k-${kind}`);
      expect(t.kind).toBe(kind);
      expect(t.status).toBe("created");
      expect(t.priority).toBe("normal");
      const due = new Date(t.sla_due_at!).getTime() - Date.now();
      expect(due).toBeGreaterThan((DEFAULT_SLA_HOURS[kind] - 0.05) * 3600_000);
      expect(due).toBeLessThanOrEqual(DEFAULT_SLA_HOURS[kind] * 3600_000 + 1000);
    });
  }

  it("幂等重放：同 idempotencyKey 返回原单（deduped:true，不重复落事件）", async () => {
    const db = wireTicketDb(new FakeDb());
    const input = { kind: "repair" as const, title: "水龙头漏水", payload: {}, idempotencyKey: "dup-1" };
    const a = await createTicket(db, CTX, input, HUMAN);
    const b = await createTicket(db, CTX, input, HUMAN);
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.ticket.id).toBe(a.ticket.id);
    expect(db.table("c_tickets")).toHaveLength(1);
    expect(db.table("c_ticket_events").filter((e) => e["action"] === "created")).toHaveLength(1);
  });

  it("非法工单类型拒绝", async () => {
    const db = wireTicketDb(new FakeDb());
    await expect(createTicket(db, CTX, {
      kind: "hack" as never, title: "x", idempotencyKey: "bad-1",
    }, HUMAN)).rejects.toThrow("非法工单类型");
  });

  it("创建落 'created' 流转事件 + 五元事件（emitter 注入）", async () => {
    const db = wireTicketDb(new FakeDb());
    const sink: ServiceEventDraft[] = [];
    const { ticket } = await createTicket(db, CTX, {
      kind: "delivery", title: "送水", idempotencyKey: "ev-1",
    }, HUMAN, memoryEmit(sink));
    const tl = await ticketTimeline(db, WS, ticket.id);
    expect(tl).toHaveLength(1);
    expect(tl[0]).toMatchObject({ action: "created", actor_type: "human", actor_id: "MEM-001" });
    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({ action: "service.ticket.created", object: { type: "c_ticket", id: ticket.id } });
  });
});

/* ================= C3. 部门路由表 ================= */

describe("C3 分派 · 部门路由表", () => {
  const routes: Array<[TicketKind, string]> = [
    ["delivery", "配送组"], ["repair", "维修组"], ["complaint", "客服主管"], ["other", "客服组"],
  ];
  for (const [kind, dept] of routes) {
    it(`${kind} → ${dept}`, async () => {
      const db = wireTicketDb(new FakeDb());
      const t = await makeTicket(db, kind, `route-${kind}`);
      const a = await assignTicket(db, CTX, t.id, HUMAN);
      expect(a.dept).toBe(dept);
      expect(a.dept).toBe(DEFAULT_DEPT_ROUTES[kind]);
      expect(a.status).toBe("assigned");
    });
  }

  it("自定义路由表可注入覆盖默认表", async () => {
    const db = wireTicketDb(new FakeDb());
    const t = await makeTicket(db, "repair", "route-custom");
    const a = await assignTicket(db, CTX, t.id, HUMAN, {
      routes: { delivery: "A", repair: "外包维修组", complaint: "C", other: "D" },
    });
    expect(a.dept).toBe("外包维修组");
  });

  it("显式指定 dept/assignee 优先于路由表", async () => {
    const db = wireTicketDb(new FakeDb());
    const t = await makeTicket(db, "delivery", "route-exp");
    const a = await assignTicket(db, CTX, t.id, HUMAN, { dept: "礼宾组", assignee: "MEM-002" });
    expect(a.dept).toBe("礼宾组");
    expect(a.assignee).toBe("MEM-002");
  });

  it("assigned 单重复分派 → 非法跃迁拒绝", async () => {
    const db = wireTicketDb(new FakeDb());
    const t = await makeTicket(db, "other", "route-twice");
    await assignTicket(db, CTX, t.id, HUMAN);
    await expect(assignTicket(db, CTX, t.id, HUMAN)).rejects.toThrow(TicketTransitionError);
  });

  it("不存在工单分派 → 抛错", async () => {
    const db = wireTicketDb(new FakeDb());
    await expect(assignTicket(db, CTX, "TK-none", HUMAN)).rejects.toThrow("不存在");
  });
});

/* ================= C4. 推进 / 完成 / 关闭 ================= */

describe("C4 生命周期 · 推进/完成回填/关闭", () => {
  it("全链路 created→assigned→processing→done→closed 时间线完整", async () => {
    const db = wireTicketDb(new FakeDb());
    const t = await makeTicket(db, "repair", "life-1");
    await assignTicket(db, CTX, t.id, HUMAN);
    const p = await advanceTicket(db, CTX, t.id, HUMAN);
    expect(p.status).toBe("processing");
    const dn = await completeTicket(db, CTX, t.id, HUMAN, { text: "已更换水龙头", worker: "张工" });
    expect(dn.status).toBe("done");
    expect(dn.result).toMatchObject({ text: "已更换水龙头" });
    const cl = await closeTicket(db, CTX, t.id, HUMAN);
    expect(cl.status).toBe("closed");
    const actions = (await ticketTimeline(db, WS, t.id)).map((e) => e.action);
    expect(actions).toEqual(["created", "assigned", "advanced", "completed", "closed"]);
  });

  it("created 单可直接关闭（客人撤单）", async () => {
    const db = wireTicketDb(new FakeDb());
    const t = await makeTicket(db, "other", "life-cancel");
    const cl = await closeTicket(db, CTX, t.id, HUMAN, { reason: "客人撤单" });
    expect(cl.status).toBe("closed");
  });

  it("created 单 advance → assigned（排除 closed 后的唯一推进态）", async () => {
    const db = wireTicketDb(new FakeDb());
    const t = await makeTicket(db, "other", "life-bad-adv");
    const a = await advanceTicket(db, CTX, t.id, HUMAN);
    expect(a.status).toBe("assigned");
  });

  it("created 单不能 complete（跳态拒绝）", async () => {
    const db = wireTicketDb(new FakeDb());
    const t = await makeTicket(db, "repair", "life-skip");
    await expect(completeTicket(db, CTX, t.id, HUMAN, { text: "x" })).rejects.toThrow(TicketTransitionError);
  });

  it("done 单不能 advance / 不能重复 complete", async () => {
    const db = wireTicketDb(new FakeDb());
    const t = await makeTicket(db, "repair", "life-done");
    await assignTicket(db, CTX, t.id, HUMAN);
    await advanceTicket(db, CTX, t.id, HUMAN);
    await completeTicket(db, CTX, t.id, HUMAN, { text: "完成" });
    await expect(advanceTicket(db, CTX, t.id, HUMAN)).rejects.toThrow(TicketTransitionError);
    await expect(completeTicket(db, CTX, t.id, HUMAN, { text: "再来" })).rejects.toThrow(TicketTransitionError);
  });

  it("closed 单一切流转拒绝", async () => {
    const db = wireTicketDb(new FakeDb());
    const t = await makeTicket(db, "other", "life-closed");
    await closeTicket(db, CTX, t.id, HUMAN);
    await expect(assignTicket(db, CTX, t.id, HUMAN)).rejects.toThrow(TicketTransitionError);
    await expect(advanceTicket(db, CTX, t.id, HUMAN)).rejects.toThrow(TicketTransitionError);
    await expect(closeTicket(db, CTX, t.id, HUMAN)).rejects.toThrow(TicketTransitionError);
  });

  it("listTickets 按状态/类型过滤", async () => {
    const db = wireTicketDb(new FakeDb());
    const a = await makeTicket(db, "repair", "flt-a");
    await makeTicket(db, "delivery", "flt-b");
    await assignTicket(db, CTX, a.id, HUMAN);
    const assigned = await listTickets(db, WS, { status: "assigned" });
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.id).toBe(a.id);
    const repairs = await listTickets(db, WS, { kind: "repair" });
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.kind).toBe("repair");
  });
});

/* ================= C5. SLA 扫描 ================= */

describe("C5 SLA · 到期升级与同日幂等", () => {
  /** 造一张已过期单（slaHours 负数 → 立即可扫） */
  async function overdueTicket(db: FakeDb, key: string, priority: "normal" | "high" | "urgent" = "normal"): Promise<Ticket> {
    const { ticket } = await createTicket(db, CTX, {
      kind: "repair", title: "超时单", payload: {}, idempotencyKey: key, slaHours: -1, priority,
    }, HUMAN);
    return ticket;
  }

  it("超时 normal 单 → 升级 high + sla_escalated 事件", async () => {
    const db = wireTicketDb(new FakeDb());
    const t = await overdueTicket(db, "sla-1");
    const r = await slaScan(db, CTX);
    expect(r.escalated).toEqual([{ ticketId: t.id, from: "normal", to: "high" }]);
    const row = db.table("c_tickets").find((x) => x["id"] === t.id)!;
    expect(row["priority"]).toBe("high");
    const ev = db.table("c_ticket_events").find((e) => e["ticket_id"] === t.id && e["action"] === "sla_escalated")!;
    expect(ev).toBeDefined();
  });

  it("超时 high 单 → 升级 urgent", async () => {
    const db = wireTicketDb(new FakeDb());
    const t = await overdueTicket(db, "sla-2", "high");
    const r = await slaScan(db, CTX);
    expect(r.escalated).toEqual([{ ticketId: t.id, from: "high", to: "urgent" }]);
  });

  it("urgent 仍超时 → stillOverdue 告警不再升级", async () => {
    const db = wireTicketDb(new FakeDb());
    const t = await overdueTicket(db, "sla-3", "urgent");
    const r = await slaScan(db, CTX);
    expect(r.escalated).toHaveLength(0);
    expect(r.stillOverdue).toEqual([t.id]);
    const row = db.table("c_tickets").find((x) => x["id"] === t.id)!;
    expect(row["priority"]).toBe("urgent");
    const ev = db.table("c_ticket_events").find((e) => e["ticket_id"] === t.id && e["action"] === "sla_escalated")!;
    expect((ev!["detail"] as Record<string, unknown>)["note"]).toContain("urgent");
  });

  it("同日幂等去重：逐级升级到 urgent 后，同级 from→to 重复扫描跳过", async () => {
    const db = wireTicketDb(new FakeDb());
    const t = await overdueTicket(db, "sla-4");
    const r1 = await slaScan(db, CTX);
    expect(r1.escalated).toEqual([{ ticketId: t.id, from: "normal", to: "high" }]);
    // 同日再扫：已是 high 且仍超时 → 升 urgent（不同 from→to，非重复）
    const r2 = await slaScan(db, CTX);
    expect(r2.escalated).toEqual([{ ticketId: t.id, from: "high", to: "urgent" }]);
    // 第三扫：urgent 仍超时 → 只告警（from=to=urgent）
    const r3 = await slaScan(db, CTX);
    expect(r3.stillOverdue).toEqual([t.id]);
    // 第四扫：同 urgent→urgent 已留痕 → 幂等跳过
    const r4 = await slaScan(db, CTX);
    expect(r4.escalated).toHaveLength(0);
    expect(r4.stillOverdue).toHaveLength(0);
    const evs = db.table("c_ticket_events").filter((e) => e["ticket_id"] === t.id && e["action"] === "sla_escalated");
    expect(evs).toHaveLength(3); // normal→high / high→urgent / urgent 告警 各一条，无重复
  });

  it("未到期单不扫描", async () => {
    const db = wireTicketDb(new FakeDb());
    await makeTicket(db, "repair", "sla-fresh"); // 默认 2h 未到期
    const r = await slaScan(db, CTX);
    expect(r.escalated).toHaveLength(0);
    expect(r.stillOverdue).toHaveLength(0);
  });

  it("done/closed 单不参与 SLA 扫描", async () => {
    const db = wireTicketDb(new FakeDb());
    const t = await overdueTicket(db, "sla-done");
    await assignTicket(db, CTX, t.id, HUMAN);
    await advanceTicket(db, CTX, t.id, HUMAN);
    await completeTicket(db, CTX, t.id, HUMAN, { text: "已完成" });
    const r = await slaScan(db, CTX);
    expect(r.escalated).toHaveLength(0);
  });

  it("SLA 升级落五元事件（emitter 注入）", async () => {
    const db = wireTicketDb(new FakeDb());
    await overdueTicket(db, "sla-ev");
    const sink: ServiceEventDraft[] = [];
    await slaScan(db, CTX, memoryEmit(sink));
    expect(sink.some((d) => d.action === "service.ticket.sla_escalated")).toBe(true);
  });
});
