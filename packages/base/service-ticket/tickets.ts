/**
 * service-ticket · 工单生命周期
 *
 *  - createTicket：幂等键 UNIQUE(workspace_id, idempotency_key)，冲突返回原单（deduped）；
 *  - assignTicket：部门路由表（可注入），created → assigned；
 *  - advanceTicket / completeTicket：状态机推进，非法跃迁拒绝；
 *  - 每次流转落 c_ticket_events + 五元事件（注入式 emitter，签名参照 workdata gatewayAppend）；
 *  - slaScan：超时单升级 priority（normal→high→urgent）+ 告警事件，供 night-shift 定时调用。
 */
import { newId } from "@workloom/shared";
import type { Queryable } from "../service-kb/kb.js";
import type { ServiceEventEmitter } from "../service-dialog/dialog.js";
import {
  DEFAULT_DEPT_ROUTES,
  DEFAULT_SLA_HOURS,
  TICKET_KINDS,
  type TicketKind,
  type TicketPriority,
} from "./constants.js";
import {
  assertTicketTransition,
  nextStatusOf,
  type TicketStatus,
} from "./state.js";

export interface Ticket {
  id: string;
  workspace_id: string;
  c_user_id: string | null;
  conversation_id: string | null;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  status: TicketStatus;
  priority: TicketPriority;
  dept: string | null;
  assignee: string | null;
  sla_due_at: string | null;
  result: Record<string, unknown> | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketEventRow {
  id: number;
  workspace_id: string;
  ticket_id: string;
  action: string;
  actor_type: string;
  actor_id: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface TicketActor {
  type: "human" | "agent" | "system" | "c_user";
  id: string;
}

interface Ctx {
  tenantId: string;
  workspaceId: string;
}

/** 流转留痕：c_ticket_events + 五元事件（同一逻辑步） */
async function recordTransition(
  db: Queryable,
  emit: ServiceEventEmitter | undefined,
  ctx: Ctx,
  ticket: Ticket,
  action: string,
  actor: TicketActor,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO c_ticket_events (workspace_id, ticket_id, action, actor_type, actor_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [ctx.workspaceId, ticket.id, action, actor.type, actor.id, JSON.stringify(detail)],
  );
  if (emit) {
    await emit(
      { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, actorId: "service-ticket", actorType: "system" },
      {
        action: `service.ticket.${action}`,
        object: { type: "c_ticket", id: ticket.id },
        after: { ticketId: ticket.id, kind: ticket.kind, status: ticket.status, ...detail },
        basis: [`操作者 ${actor.type}:${actor.id}`],
      },
    );
  }
}

async function loadTicketForUpdate(
  db: Queryable,
  workspaceId: string,
  ticketId: string,
): Promise<Ticket> {
  const r = await db.query<Ticket & Record<string, unknown>>(
    `SELECT * FROM c_tickets WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
    [ticketId, workspaceId],
  );
  const row = r.rows[0] as Ticket | undefined;
  if (!row) throw new Error(`工单 ${ticketId} 不存在`);
  return row;
}

/* ================= 创建（幂等） ================= */

export interface CreateTicketInput {
  kind: TicketKind;
  title: string;
  payload?: Record<string, unknown>;
  cUserId?: string;
  conversationId?: string;
  priority?: TicketPriority;
  idempotencyKey: string;
  /** 覆盖默认 SLA 小时数 */
  slaHours?: number;
}

export async function createTicket(
  db: Queryable,
  ctx: Ctx,
  input: CreateTicketInput,
  actor: TicketActor,
  emit?: ServiceEventEmitter,
): Promise<{ ticket: Ticket; deduped: boolean }> {
  if (!TICKET_KINDS.includes(input.kind)) throw new Error(`非法工单类型「${input.kind}」`);
  const id = newId("TK");
  const slaHours = input.slaHours ?? DEFAULT_SLA_HOURS[input.kind];
  const ins = await db.query<Ticket & Record<string, unknown>>(
    `INSERT INTO c_tickets
       (id, workspace_id, c_user_id, conversation_id, kind, title, payload, priority, sla_due_at, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($10 || ' hours')::interval, $9)
     ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      id, ctx.workspaceId, input.cUserId ?? null, input.conversationId ?? null,
      input.kind, input.title, JSON.stringify(input.payload ?? {}),
      input.priority ?? "normal", input.idempotencyKey, String(slaHours),
    ],
  );
  let ticket = ins.rows[0] as Ticket | undefined;
  if (!ticket) {
    // 幂等命中：返回原单，不再落流转事件（重复提交不重复建单）
    const cur = await db.query<Ticket & Record<string, unknown>>(
      `SELECT * FROM c_tickets WHERE workspace_id=$1 AND idempotency_key=$2`,
      [ctx.workspaceId, input.idempotencyKey],
    );
    ticket = cur.rows[0] as Ticket | undefined;
    if (!ticket) throw new Error("幂等冲突但未查到原单（数据异常）");
    return { ticket, deduped: true };
  }
  await recordTransition(db, emit, ctx, ticket, "created", actor, {
    title: input.title, kind: input.kind, priority: ticket.priority, slaHours,
  });
  return { ticket, deduped: false };
}

/* ================= 分派（部门路由表可注入） ================= */

export async function assignTicket(
  db: Queryable,
  ctx: Ctx,
  ticketId: string,
  actor: TicketActor,
  opts: { dept?: string; assignee?: string; routes?: Record<TicketKind, string> } = {},
  emit?: ServiceEventEmitter,
): Promise<Ticket> {
  const ticket = await loadTicketForUpdate(db, ctx.workspaceId, ticketId);
  assertTicketTransition(ticket.status, "assigned");
  const routes = opts.routes ?? DEFAULT_DEPT_ROUTES;
  const dept = opts.dept ?? routes[ticket.kind as TicketKind] ?? DEFAULT_DEPT_ROUTES.other;
  const r = await db.query<Ticket & Record<string, unknown>>(
    `UPDATE c_tickets SET status='assigned', dept=$3, assignee=$4, updated_at=now()
     WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    [ticketId, ctx.workspaceId, dept, opts.assignee ?? null],
  );
  const updated = r.rows[0] as Ticket;
  await recordTransition(db, emit, ctx, updated, "assigned", actor, {
    from: ticket.status, dept, assignee: opts.assignee ?? null,
  });
  return updated;
}

/* ================= 推进 / 完成 / 关闭 ================= */

export async function advanceTicket(
  db: Queryable,
  ctx: Ctx,
  ticketId: string,
  actor: TicketActor,
  detail: Record<string, unknown> = {},
  emit?: ServiceEventEmitter,
): Promise<Ticket> {
  const ticket = await loadTicketForUpdate(db, ctx.workspaceId, ticketId);
  const to = nextStatusOf(ticket.status);
  assertTicketTransition(ticket.status, to);
  const r = await db.query<Ticket & Record<string, unknown>>(
    `UPDATE c_tickets SET status=$3, updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    [ticketId, ctx.workspaceId, to],
  );
  const updated = r.rows[0] as Ticket;
  await recordTransition(db, emit, ctx, updated, "advanced", actor, { from: ticket.status, to, ...detail });
  return updated;
}

export async function completeTicket(
  db: Queryable,
  ctx: Ctx,
  ticketId: string,
  actor: TicketActor,
  result: Record<string, unknown>,
  emit?: ServiceEventEmitter,
): Promise<Ticket> {
  const ticket = await loadTicketForUpdate(db, ctx.workspaceId, ticketId);
  assertTicketTransition(ticket.status, "done");
  const r = await db.query<Ticket & Record<string, unknown>>(
    `UPDATE c_tickets SET status='done', result=$3, updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    [ticketId, ctx.workspaceId, JSON.stringify(result)],
  );
  const updated = r.rows[0] as Ticket;
  await recordTransition(db, emit, ctx, updated, "completed", actor, { from: ticket.status, result });
  return updated;
}

export async function closeTicket(
  db: Queryable,
  ctx: Ctx,
  ticketId: string,
  actor: TicketActor,
  detail: Record<string, unknown> = {},
  emit?: ServiceEventEmitter,
): Promise<Ticket> {
  const ticket = await loadTicketForUpdate(db, ctx.workspaceId, ticketId);
  assertTicketTransition(ticket.status, "closed");
  const r = await db.query<Ticket & Record<string, unknown>>(
    `UPDATE c_tickets SET status='closed', updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING *`,
    [ticketId, ctx.workspaceId],
  );
  const updated = r.rows[0] as Ticket;
  await recordTransition(db, emit, ctx, updated, "closed", actor, { from: ticket.status, ...detail });
  return updated;
}

/* ================= 查询 ================= */

export interface TicketFilter {
  status?: TicketStatus;
  kind?: TicketKind;
  cUserId?: string;
  dept?: string;
  priority?: TicketPriority;
  limit?: number;
}

export async function listTickets(
  db: Queryable,
  workspaceId: string,
  filter: TicketFilter = {},
): Promise<Ticket[]> {
  const conds = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  for (const [col, val] of [
    ["status", filter.status], ["kind", filter.kind],
    ["c_user_id", filter.cUserId], ["dept", filter.dept], ["priority", filter.priority],
  ] as const) {
    if (val) { params.push(val); conds.push(`${col} = $${params.length}`); }
  }
  params.push(Math.min(filter.limit ?? 50, 200));
  const r = await db.query<Ticket & Record<string, unknown>>(
    `SELECT * FROM c_tickets WHERE ${conds.join(" AND ")}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows as Ticket[];
}

/** 工单时间线（c_ticket_events 升序回放） */
export async function ticketTimeline(
  db: Queryable,
  workspaceId: string,
  ticketId: string,
): Promise<TicketEventRow[]> {
  const r = await db.query<TicketEventRow & Record<string, unknown>>(
    `SELECT * FROM c_ticket_events WHERE workspace_id=$1 AND ticket_id=$2 ORDER BY id ASC`,
    [workspaceId, ticketId],
  );
  return r.rows as TicketEventRow[];
}

/* ================= SLA 扫描（供 night-shift 定时调用） ================= */

const PRIORITY_ESCALATION: Record<TicketPriority, TicketPriority | null> = {
  normal: "high",
  high: "urgent",
  urgent: null,
};

export interface SlaScanResult {
  escalated: Array<{ ticketId: string; from: TicketPriority; to: TicketPriority }>;
  /** 已到 urgent 仍超时的单（只告警不再升级） */
  stillOverdue: string[];
}

export async function slaScan(
  db: Queryable,
  ctx: Ctx,
  emit?: ServiceEventEmitter,
  now: Date = new Date(),
): Promise<SlaScanResult> {
  const r = await db.query<Ticket & Record<string, unknown>>(
    `SELECT * FROM c_tickets
     WHERE workspace_id=$1 AND status IN ('created','assigned','processing')
       AND sla_due_at IS NOT NULL AND sla_due_at < $2
     FOR UPDATE`,
    [ctx.workspaceId, now.toISOString()],
  );
  const result: SlaScanResult = { escalated: [], stillOverdue: [] };
  for (const row of r.rows as Ticket[]) {
    const from = row.priority; // 先快照（UPDATE 后再读可能被同一对象引用污染）
    const to = PRIORITY_ESCALATION[from];
    if (to) {
      const upd = await db.query<Ticket & Record<string, unknown>>(
        `UPDATE c_tickets SET priority=$3, updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING *`,
        [row.id, ctx.workspaceId, to],
      );
      const updated = upd.rows[0] as Ticket;
      await recordTransition(db, emit, ctx, updated, "sla_escalated", { type: "system", id: "service-ticket" }, {
        from, to, slaDueAt: row.sla_due_at, level: "p1",
      });
      result.escalated.push({ ticketId: row.id, from, to });
    } else {
      // urgent 仍超时：只告警事件，不再升级
      await recordTransition(db, emit, ctx, row, "sla_escalated", { type: "system", id: "service-ticket" }, {
        from, to: from, slaDueAt: row.sla_due_at, level: "p0", note: "urgent 单仍超时",
      });
      result.stillOverdue.push(row.id);
    }
  }
  return result;
}
