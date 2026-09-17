/**
 * service-ticket 单测（内存假库 + 注入式 emitter）
 * 覆盖：状态机合法/非法跃迁 / 幂等建单 / 部门路由表（默认+注入覆盖）/ 流转留痕时间线 / SLA 升级
 */
import { describe, expect, it } from "vitest";
import {
  advanceTicket,
  assignTicket,
  closeTicket,
  completeTicket,
  createTicket,
  listTickets,
  slaScan,
  ticketTimeline,
  type Ticket,
} from "./tickets.js";
import { assertTicketTransition, nextStatusOf, TicketTransitionError } from "./state.js";
import { DEFAULT_DEPT_ROUTES } from "./constants.js";
import { FakeDb, nextSerial } from "../testing/fake-pg.js";
import type { ServiceEventDraft } from "../service-dialog/dialog.js";

/* ---------- 假库 handler：ticket 链路 ---------- */
function wireTicketDb(db: FakeDb, now: () => Date): FakeDb {
  db.on(/^INSERT INTO c_tickets/, (p, d) => {
    const t = d.table("c_tickets");
    const dup = p[8] != null
      ? t.find((r) => r["workspace_id"] === p[1] && r["idempotency_key"] === p[8])
      : undefined;
    if (dup) return { rows: [] }; // ON CONFLICT DO NOTHING
    const slaHours = Number(p[9]);
    const due = new Date(now().getTime() + slaHours * 3600_000).toISOString();
    const row = {
      id: p[0], workspace_id: p[1], c_user_id: p[2], conversation_id: p[3],
      kind: p[4], title: p[5], payload: JSON.parse(String(p[6])), status: "created",
      priority: p[7], dept: null, assignee: null, sla_due_at: due, result: null,
      idempotency_key: p[8], created_at: now().toISOString(), updated_at: now().toISOString(),
    };
    t.push(row);
    return { rows: [row] };
  });
  db.on(/^SELECT \* FROM c_tickets WHERE workspace_id=\$1 AND idempotency_key=\$2/, (p, d) => ({
    rows: d.table("c_tickets").filter((r) => r["workspace_id"] === p[0] && r["idempotency_key"] === p[1]),
  }));
  db.on(/^SELECT \* FROM c_tickets WHERE id=\$1 AND workspace_id=\$2 FOR UPDATE/, (p, d) => ({
    rows: d.table("c_tickets").filter((r) => r["id"] === p[0] && r["workspace_id"] === p[1]),
  }));
  db.on(/^UPDATE c_tickets SET status='assigned', dept=\$3, assignee=\$4/, (p, d) => {
    const row = d.table("c_tickets").find((r) => r["id"] === p[0]);
    if (row) { row["status"] = "assigned"; row["dept"] = p[2]; row["assignee"] = p[3]; row["updated_at"] = now().toISOString(); }
    return { rows: row ? [row] : [] };
  });
  db.on(/^UPDATE c_tickets SET status=\$3, updated_at=now\(\)/, (p, d) => {
    const row = d.table("c_tickets").find((r) => r["id"] === p[0]);
    if (row) { row["status"] = p[2]; row["updated_at"] = now().toISOString(); }
    return { rows: row ? [row] : [] };
  });
  db.on(/^UPDATE c_tickets SET status='done', result=\$3/, (p, d) => {
    const row = d.table("c_tickets").find((r) => r["id"] === p[0]);
    if (row) { row["status"] = "done"; row["result"] = JSON.parse(String(p[2])); row["updated_at"] = now().toISOString(); }
    return { rows: row ? [row] : [] };
  });
  db.on(/^UPDATE c_tickets SET status='closed'/, (p, d) => {
    const row = d.table("c_tickets").find((r) => r["id"] === p[0]);
    if (row) { row["status"] = "closed"; row["updated_at"] = now().toISOString(); }
    return { rows: row ? [row] : [] };
  });
  db.on(/^UPDATE c_tickets SET priority=\$3/, (p, d) => {
    const row = d.table("c_tickets").find((r) => r["id"] === p[0]);
    if (row) { row["priority"] = p[2]; row["updated_at"] = now().toISOString(); }
    return { rows: row ? [row] : [] };
  });
  db.on(/^SELECT \* FROM c_tickets WHERE workspace_id = \$1/, (p, d, sql) => {
    let rows = d.table("c_tickets").filter((r) => r["workspace_id"] === p[0]);
    let idx = 1; // 过滤参数顺序与 tickets.ts listTickets 一致：status, kind, c_user_id, dept, priority, limit
    const eq = (col: string) => { const v = p[idx++]; rows = rows.filter((r) => r[col] === v); };
    if (sql.includes("status =")) eq("status");
    if (sql.includes("kind =")) eq("kind");
    if (sql.includes("c_user_id =")) eq("c_user_id");
    if (sql.includes("dept =")) eq("dept");
    if (sql.includes("priority =")) eq("priority");
    return { rows };
  });
  db.on(/^INSERT INTO c_ticket_events/, (p, d) => {
    const row = {
      id: nextSerial(d, "c_ticket_events"), workspace_id: p[0], ticket_id: p[1],
      action: p[2], actor_type: p[3], actor_id: p[4],
      detail: JSON.parse(String(p[5])), created_at: now().toISOString(),
    };
    d.table("c_ticket_events").push(row);
    return { rows: [row] };
  });
  db.on(/^SELECT \* FROM c_ticket_events/, (p, d) => ({
    rows: d.table("c_ticket_events")
      .filter((r) => r["workspace_id"] === p[0] && r["ticket_id"] === p[1])
      .sort((a, b) => Number(a["id"]) - Number(b["id"])),
  }));
  // M5：同工单同日同 from→to 的 sla_escalated 查重
  db.on(/^SELECT 1 FROM c_ticket_events/, (p, d) => {
    const dayStart = new Date(now()); dayStart.setHours(0, 0, 0, 0);
    return {
      rows: d.table("c_ticket_events").filter((r) =>
        r["workspace_id"] === p[0] && r["ticket_id"] === p[1] && r["action"] === "sla_escalated" &&
        String(r["created_at"]) >= dayStart.toISOString() &&
        (r["detail"] as Record<string, unknown>)?.["from"] === p[2] &&
        (r["detail"] as Record<string, unknown>)?.["to"] === p[3]).slice(0, 1),
    };
  });
  db.on(/^SELECT \* FROM c_tickets WHERE workspace_id=\$1 AND status IN \('created','assigned','processing'\)/, (p, d) => ({
    rows: d.table("c_tickets").filter((r) =>
      r["workspace_id"] === p[0] &&
      ["created", "assigned", "processing"].includes(String(r["status"])) &&
      r["sla_due_at"] != null && String(r["sla_due_at"]) < String(p[1])),
  }));
  return db;
}

const CTX = { tenantId: "tenant-demo", workspaceId: "ws-test" };
const ACTOR = { type: "human" as const, id: "MEM-001" };

function setup(now: () => Date) {
  const db = wireTicketDb(new FakeDb(), now);
  const events: ServiceEventDraft[] = [];
  const emit = async (_c: unknown, draft: ServiceEventDraft) => {
    events.push(draft);
    return { eventId: `E-${events.length}` };
  };
  return { db, events, emit };
}

/* ================= 状态机（纯函数） ================= */

describe("工单状态机", () => {
  it("合法迁移全通；非法迁移拒绝", () => {
    expect(() => assertTicketTransition("created", "assigned")).not.toThrow();
    expect(() => assertTicketTransition("assigned", "processing")).not.toThrow();
    expect(() => assertTicketTransition("processing", "done")).not.toThrow();
    expect(() => assertTicketTransition("done", "closed")).not.toThrow();
    expect(() => assertTicketTransition("created", "closed")).not.toThrow();
    expect(() => assertTicketTransition("created", "processing")).toThrow(TicketTransitionError);
    expect(() => assertTicketTransition("assigned", "done")).toThrow(TicketTransitionError);
    expect(() => assertTicketTransition("closed", "created")).toThrow(/非法迁移/);
    expect(nextStatusOf("assigned")).toBe("processing");
    expect(nextStatusOf("processing")).toBe("done");
  });
});

/* ================= 生命周期 + 幂等 ================= */

describe("createTicket 幂等 + 全生命周期留痕", () => {
  it("幂等键冲突返回原单（deduped），不重复落流转事件", async () => {
    const now = () => new Date("2026-08-23T10:00:00+08:00");
    const { db, emit } = setup(now);
    const input = { kind: "delivery" as const, title: "送两瓶水", idempotencyKey: "msg-001", cUserId: "cu-1" };
    const r1 = await createTicket(db, CTX, input, ACTOR, emit);
    const r2 = await createTicket(db, CTX, input, ACTOR, emit);
    expect(r1.deduped).toBe(false);
    expect(r2.deduped).toBe(true);
    expect(r2.ticket.id).toBe(r1.ticket.id);
    expect(db.table("c_tickets").length).toBe(1);
    expect(db.table("c_ticket_events").length).toBe(1); // 只落一次 created
    expect(r1.ticket.sla_due_at).toBe(new Date("2026-08-23T11:00:00+08:00").toISOString()); // delivery 默认 1h
  });

  it("created→assigned→processing→done→closed 全链路 + 时间线回放 + 五元事件", async () => {
    const now = () => new Date("2026-08-23T10:00:00+08:00");
    const { db, events, emit } = setup(now);
    const { ticket } = await createTicket(db, CTX,
      { kind: "repair", title: "设备坏了", idempotencyKey: "msg-002" }, ACTOR, emit);
    // 默认部门路由：repair → 维修组
    const assigned = await assignTicket(db, CTX, ticket.id, ACTOR, {}, emit);
    expect(assigned.dept).toBe(DEFAULT_DEPT_ROUTES.repair);
    expect(assigned.dept).toBe("维修组");
    await advanceTicket(db, CTX, ticket.id, ACTOR, { note: "师傅已到场" }, emit);
    const done = await completeTicket(db, CTX, ticket.id, ACTOR, { fix: "更换电容", photos: ["p1"] }, emit);
    expect(done.result).toMatchObject({ fix: "更换电容" });
    await closeTicket(db, CTX, ticket.id, ACTOR, {}, emit);

    const tl = await ticketTimeline(db, CTX.workspaceId, ticket.id);
    expect(tl.map((e) => e.action)).toEqual(["created", "assigned", "advanced", "completed", "closed"]);
    expect(events.map((e) => e.action)).toEqual([
      "service.ticket.created", "service.ticket.assigned", "service.ticket.advanced",
      "service.ticket.completed", "service.ticket.closed",
    ]);
  });

  it("非法跃迁拒绝（created 直接 complete / done 再 advance）", async () => {
    const now = () => new Date();
    const { db, emit } = setup(now);
    const { ticket } = await createTicket(db, CTX,
      { kind: "other", title: "t", idempotencyKey: "msg-003" }, ACTOR, emit);
    // created 直接完成：拒绝（须先分派再处理）
    await expect(completeTicket(db, CTX, ticket.id, ACTOR, {}, emit)).rejects.toThrow(TicketTransitionError);
    // created 经 advance 走合法下一态 assigned → processing → done
    await advanceTicket(db, CTX, ticket.id, ACTOR, {}, emit);
    await advanceTicket(db, CTX, ticket.id, ACTOR, {}, emit);
    await completeTicket(db, CTX, ticket.id, ACTOR, { note: "ok" }, emit);
    // done 再 advance：拒绝（done 只能 close）
    await expect(advanceTicket(db, CTX, ticket.id, ACTOR, {}, emit)).rejects.toThrow(TicketTransitionError);
  });

  it("部门路由表可注入覆盖", async () => {
    const now = () => new Date();
    const { db, emit } = setup(now);
    const { ticket } = await createTicket(db, CTX,
      { kind: "delivery", title: "送物资", idempotencyKey: "msg-004" }, ACTOR, emit);
    const assigned = await assignTicket(db, CTX, ticket.id, ACTOR,
      { routes: { delivery: "礼宾组", repair: "维修组", complaint: "客服主管", other: "客服组" } }, emit);
    expect(assigned.dept).toBe("礼宾组");
  });

  it("listTickets 按状态过滤", async () => {
    const now = () => new Date();
    const { db, emit } = setup(now);
    await createTicket(db, CTX, { kind: "other", title: "a", idempotencyKey: "k1" }, ACTOR, emit);
    const t2 = await createTicket(db, CTX, { kind: "complaint", title: "b", idempotencyKey: "k2" }, ACTOR, emit);
    await assignTicket(db, CTX, t2.ticket.id, ACTOR, {}, emit);
    const created = await listTickets(db, CTX.workspaceId, { status: "created" });
    const assigned = await listTickets(db, CTX.workspaceId, { status: "assigned" });
    expect(created.length).toBe(1);
    expect(assigned.length).toBe(1);
    expect(assigned[0]!.dept).toBe("客服主管");
  });
});

/* ================= SLA 升级 ================= */

describe("slaScan 超时升级", () => {
  it("超时单 priority 逐级升级（normal→high→urgent）+ 告警事件；urgent 仍超时只告警", async () => {
    let current = new Date("2026-08-23T10:00:00+08:00");
    const now = () => current;
    const { db, events, emit } = setup(now);
    const { ticket } = await createTicket(db, CTX,
      { kind: "delivery", title: "送水", idempotencyKey: "k-sla", slaHours: 1 } as never, ACTOR, emit);
    expect(ticket.priority).toBe("normal");

    // 未到 SLA：不升级
    current = new Date("2026-08-23T10:30:00+08:00");
    const none = await slaScan(db, CTX, emit, current);
    expect(none.escalated).toEqual([]);

    // 超时：normal→high
    current = new Date("2026-08-23T11:01:00+08:00");
    const first = await slaScan(db, CTX, emit, current);
    expect(first.escalated).toEqual([{ ticketId: ticket.id, from: "normal", to: "high" }]);

    // 再扫：high→urgent（仍超时未处理）
    const second = await slaScan(db, CTX, emit, current);
    expect(second.escalated).toEqual([{ ticketId: ticket.id, from: "high", to: "urgent" }]);

    // urgent 仍超时：只告警不再升级
    const third = await slaScan(db, CTX, emit, current);
    expect(third.escalated).toEqual([]);
    expect(third.stillOverdue).toEqual([ticket.id]);

    const slaEvents = events.filter((e) => e.action === "service.ticket.sla_escalated");
    expect(slaEvents.length).toBe(3);
    const timeline = await ticketTimeline(db, CTX.workspaceId, ticket.id);
    expect(timeline.filter((e) => e.action === "sla_escalated").length).toBe(3);

    // done 单不再被扫描
    const final = db.table("c_tickets").find((r) => r["id"] === ticket.id) as unknown as Ticket;
    expect(final.priority).toBe("urgent");
  });

  it("M5 幂等：同工单同日同 from→to 升级不重复插事件（重复扫描安全）", async () => {
    let current = new Date("2026-08-23T10:00:00+08:00");
    const now = () => current;
    const { db, events, emit } = setup(now);
    const { ticket } = await createTicket(db, CTX,
      { kind: "delivery", title: "送水", idempotencyKey: "k-sla-m5", slaHours: 1 } as never, ACTOR, emit);
    current = new Date("2026-08-23T11:01:00+08:00");
    // 升到 urgent 后，urgent 仍超时：首次告警落事件，再次扫描同日同 from→to 被去重
    await slaScan(db, CTX, emit, current); // normal→high
    await slaScan(db, CTX, emit, current); // high→urgent
    const first = await slaScan(db, CTX, emit, current); // urgent 告警（落事件）
    expect(first.stillOverdue).toEqual([ticket.id]);
    const again = await slaScan(db, CTX, emit, current); // 同日重复扫描 → 去重跳过
    expect(again.stillOverdue).toEqual([]);
    expect(again.escalated).toEqual([]);
    const timeline = await ticketTimeline(db, CTX.workspaceId, ticket.id);
    expect(timeline.filter((e) => e.action === "sla_escalated").length).toBe(3);
    expect(events.filter((e) => e.action === "service.ticket.sla_escalated").length).toBe(3);
  });
});
