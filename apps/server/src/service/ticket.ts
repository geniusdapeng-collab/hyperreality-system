/**
 * service · 工单（接口对齐 packages/base/service-ticket 签名；表结构为底座迁移版）
 *  - 状态机（H1/H3）：迁移合法性复用 packages/base/service-ticket 的 assertTicketTransition
 *    （created→assigned→processing→done→closed，created 可直关）；非法跃迁抛 409 语义错误
 *  - 幂等（H1/H3）：ON CONFLICT (workspace_id,idempotency_key) DO NOTHING + 回查返回 {deduped:true}
 *    （删除先查后插竞态窗口）；createTicketOn/assignTicketOn 供网关纳入同一 serviceTx（H2）
 *  - 部门路由表：kind → 默认部门（自动派单）；SLA：sla_due_at 按 kind 时限，超时升级 priority=high + 事件留痕
 *  - 满意度（L9）：仅 status=done 可评且只可评一次（重复评 409）；评分落 payload.rating + 'rate' 事件
 * 全部读写经 svcQuery/serviceTx（RLS 事务上下文）。
 */
import type pg from "pg";
import { assertTicketTransition, TicketTransitionError } from "@workloom/base/service-ticket";
import { ensureServiceSchema } from "./store.js";
import { serviceTx, svcQuery } from "./events.js";

export type TicketStatus = "created" | "assigned" | "processing" | "done" | "closed";

/** 带 HTTP 语义的服务层错误（网关按 status 映射响应码） */
export class ServiceHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ServiceHttpError";
  }
}

export interface Ticket {
  id: string; workspaceId: string; cUserId: string | null; conversationId: string | null;
  kind: string; title: string; payload: Record<string, unknown>;
  status: TicketStatus; priority: string; dept: string | null; assignee: string | null;
  ratingScore: number | null; ratingComment: string | null;
  result: Record<string, unknown> | null;
  slaDeadline: string | null; createdAt: string; updatedAt: string;
}
export interface TicketEvent {
  id: string; ticketId: string; action: string; actorType: string; actorId: string;
  detail: Record<string, unknown>; createdAt: string;
}

/** 部门路由表（kind → 受理部门；可按工作区配置化扩展） */
export const DEPT_ROUTE: Record<string, string> = {
  complaint: "客服部",
  repair: "工程部",
  delivery: "客房部",
  service_request: "客房部",
  consult: "前厅部",
  other: "前厅部",
};

/** SLA 时限（小时，按 kind；演示口径） */
const SLA_HOURS: Record<string, number> = {
  complaint: 4,
  repair: 2,
  delivery: 1,
  service_request: 2,
  consult: 8,
  other: 24,
};

let seq = 0;
function newId(prefix: string): string {
  seq = (seq + 1) % 46636;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36).padStart(3, "0")}${Math.random().toString(36).slice(2, 6)}`;
}

function ticketOf(x: Record<string, unknown>): Ticket {
  const payload = (x.payload ?? {}) as Record<string, unknown>;
  const rating = (payload.rating ?? null) as { score?: number; comment?: string } | null;
  return {
    id: String(x.id), workspaceId: String(x.workspace_id),
    cUserId: x.c_user_id as string | null, conversationId: x.conversation_id as string | null,
    kind: String(x.kind), title: String(x.title), payload,
    status: x.status as TicketStatus, priority: String(x.priority ?? "normal"),
    dept: x.dept as string | null, assignee: x.assignee as string | null,
    ratingScore: rating?.score ?? null, ratingComment: rating?.comment ?? null,
    result: (x.result ?? null) as Record<string, unknown> | null,
    slaDeadline: x.sla_due_at ? new Date(String(x.sla_due_at)).toISOString() : null,
    createdAt: new Date(String(x.created_at)).toISOString(),
    updatedAt: new Date(String(x.updated_at)).toISOString(),
  };
}
function eventOf(x: Record<string, unknown>): TicketEvent {
  return {
    id: String(x.id), ticketId: String(x.ticket_id), action: String(x.action),
    actorType: String(x.actor_type), actorId: String(x.actor_id),
    detail: (x.detail ?? {}) as Record<string, unknown>, createdAt: new Date(String(x.created_at)).toISOString(),
  };
}

/** 状态机断言 → 409 语义（TicketTransitionError 转 ServiceHttpError） */
function assertTransition(from: TicketStatus, to: TicketStatus): void {
  try {
    assertTicketTransition(from, to);
  } catch (err) {
    if (err instanceof TicketTransitionError) throw new ServiceHttpError(err.message, 409);
    throw err;
  }
}

export interface CreateTicketInput {
  workspaceId: string; cUserId: string; conversationId?: string;
  kind: string; title: string; payload: Record<string, unknown>; idempotencyKey?: string;
}

/** 事务内建单（ON CONFLICT 幂等 + 'create' 事件；deduped 命中不落事件） */
export async function createTicketOn(
  client: pg.PoolClient,
  input: CreateTicketInput,
): Promise<{ ticket: Ticket; deduped: boolean }> {
  const slaHours = SLA_HOURS[input.kind] ?? SLA_HOURS.other!;
  const r = await client.query(
    `INSERT INTO c_tickets (id, workspace_id, c_user_id, conversation_id, kind, title, payload, idempotency_key, sla_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' hours')::interval)
     ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [newId("tck"), input.workspaceId, input.cUserId, input.conversationId ?? null, input.kind, input.title,
     JSON.stringify(input.payload), input.idempotencyKey ?? null, String(slaHours)],
  );
  let row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    // 幂等命中：回查原单返回（不重复落流转事件）
    const cur = await client.query(
      `SELECT * FROM c_tickets WHERE workspace_id=$1 AND idempotency_key=$2`,
      [input.workspaceId, input.idempotencyKey ?? null],
    );
    row = cur.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new ServiceHttpError("幂等冲突但未查到原单（数据异常）", 500);
    return { ticket: ticketOf(row), deduped: true };
  }
  await client.query(
    `INSERT INTO c_ticket_events (workspace_id, ticket_id, action, actor_type, actor_id, detail)
     VALUES ($1,$2,'create','c_user',$3,$4)`,
    [input.workspaceId, String(row.id), input.cUserId, JSON.stringify({ kind: input.kind, title: input.title })],
  );
  return { ticket: ticketOf(row), deduped: false };
}

export async function createTicket(input: CreateTicketInput): Promise<{ ticket: Ticket; deduped: boolean }> {
  await ensureServiceSchema();
  return serviceTx(input.workspaceId, async (client) => createTicketOn(client, input));
}

/** 事务内派单（created→assigned 状态机断言 + 'assign' 事件） */
export async function assignTicketOn(
  client: pg.PoolClient,
  input: { workspaceId: string; ticketId: string; dept?: string; assignee?: string },
): Promise<Ticket> {
  const cur = await client.query(
    `SELECT * FROM c_tickets WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
    [input.workspaceId, input.ticketId],
  );
  const row = cur.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new ServiceHttpError(`工单不存在：${input.ticketId}`, 404);
  const from = row.status as TicketStatus;
  assertTransition(from, "assigned");
  const dept = input.dept ?? DEPT_ROUTE[String(row.kind)] ?? DEPT_ROUTE.other!;
  const upd = await client.query(
    `UPDATE c_tickets SET status='assigned', dept=$3, assignee=$4, updated_at=now()
     WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [input.workspaceId, input.ticketId, dept, input.assignee ?? null],
  );
  await client.query(
    `INSERT INTO c_ticket_events (workspace_id, ticket_id, action, actor_type, actor_id, detail)
     VALUES ($1,$2,'assign','system','service-desk',$3)`,
    [input.workspaceId, input.ticketId, JSON.stringify({ dept, assignee: input.assignee ?? null })],
  );
  return ticketOf(upd.rows[0] as Record<string, unknown>);
}

/** 事务内状态推进（D16：供 router/gateway 的 serviceTx 回调复用同一 client，不再嵌套另开连接） */
export async function transitionOn(
  client: pg.PoolClient,
  input: {
    workspaceId: string; ticketId: string; action: string;
    actorType: string; actorId: string; detail?: Record<string, unknown>;
    setStatus?: TicketStatus; setDept?: string | null; setAssignee?: string | null;
    setPriority?: string; setResult?: Record<string, unknown>; mergePayload?: Record<string, unknown>;
  },
): Promise<Ticket> {
  await ensureServiceSchema();
  const cur = await client.query(
    `SELECT status FROM c_tickets WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
    [input.workspaceId, input.ticketId],
  );
  const from = (cur.rows[0] as { status?: string } | undefined)?.status as TicketStatus | undefined;
  if (!from) throw new ServiceHttpError(`工单不存在：${input.ticketId}`, 404);
  // H1/H3 状态机：目标态变更必须先过迁移合法性（非法跃迁 409）
  if (input.setStatus && input.setStatus !== from) assertTransition(from, input.setStatus);
  const r = await client.query(
    `UPDATE c_tickets SET
       status   = COALESCE($3, status),
       dept     = COALESCE($4, dept),
       assignee = COALESCE($5, assignee),
       priority = COALESCE($6, priority),
       result   = COALESCE($7, result),
       payload  = payload || COALESCE($8::jsonb, '{}'::jsonb),
       updated_at = now()
     WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [input.workspaceId, input.ticketId, input.setStatus ?? null, input.setDept ?? null, input.setAssignee ?? null,
     input.setPriority ?? null, input.setResult ? JSON.stringify(input.setResult) : null,
     input.mergePayload ? JSON.stringify(input.mergePayload) : null],
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new ServiceHttpError(`工单不存在：${input.ticketId}`, 404);
  await client.query(
    `INSERT INTO c_ticket_events (workspace_id, ticket_id, action, actor_type, actor_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.workspaceId, input.ticketId, input.action, input.actorType, input.actorId, JSON.stringify(input.detail ?? {})],
  );
  return ticketOf(row);
}

async function transition(input: {
  workspaceId: string; ticketId: string; action: string;
  actorType: string; actorId: string; detail?: Record<string, unknown>;
  setStatus?: TicketStatus; setDept?: string | null; setAssignee?: string | null;
  setPriority?: string; setResult?: Record<string, unknown>; mergePayload?: Record<string, unknown>;
}): Promise<Ticket> {
  await ensureServiceSchema();
  return serviceTx(input.workspaceId, (client) => transitionOn(client, input));
}

export async function assignTicket(input: {
  workspaceId: string; ticketId: string; dept?: string; assignee?: string;
}): Promise<Ticket> {
  await ensureServiceSchema();
  return serviceTx(input.workspaceId, async (client) => assignTicketOn(client, input));
}

export async function advanceTicket(input: {
  workspaceId: string; ticketId: string; action: string;
  actorType: string; actorId: string; detail?: Record<string, unknown>;
}): Promise<Ticket> {
  // B 端推进：start → processing（assigned→processing 状态机断言）；其余 action 原样留痕不变更状态
  return transition({ ...input, setStatus: input.action === "start" ? "processing" : undefined });
}

/** 事务内 B 端推进（D16：供 router serviceTx 回调复用同一 client） */
export async function advanceTicketOn(
  client: pg.PoolClient,
  input: {
    workspaceId: string; ticketId: string; action: string;
    actorType: string; actorId: string; detail?: Record<string, unknown>;
  },
): Promise<Ticket> {
  return transitionOn(client, { ...input, setStatus: input.action === "start" ? "processing" : undefined });
}

export async function completeTicket(input: {
  workspaceId: string; ticketId: string; result: string; actorId: string;
}): Promise<Ticket> {
  return transition({
    workspaceId: input.workspaceId, ticketId: input.ticketId,
    action: "complete", actorType: "staff", actorId: input.actorId,
    setStatus: "done", setResult: { text: input.result }, detail: { result: input.result },
  });
}

/** 事务内完结（D16：供 router serviceTx 回调复用同一 client） */
export async function completeTicketOn(
  client: pg.PoolClient,
  input: { workspaceId: string; ticketId: string; result: string; actorId: string },
): Promise<Ticket> {
  return transitionOn(client, {
    workspaceId: input.workspaceId, ticketId: input.ticketId,
    action: "complete", actorType: "staff", actorId: input.actorId,
    setStatus: "done", setResult: { text: input.result }, detail: { result: input.result },
  });
}

/** 事务内满意度评价（D16：供 gateway serviceTx 回调复用同一 client） */
export async function rateTicketOn(
  client: pg.PoolClient,
  input: {
    workspaceId: string; ticketId: string; cUserId: string; score: number; comment?: string;
  },
): Promise<Ticket> {
  await ensureServiceSchema();
  const cur = await client.query(
    `SELECT status, payload->'rating' AS rating FROM c_tickets
     WHERE workspace_id=$1 AND id=$2 AND c_user_id=$3 FOR UPDATE`,
    [input.workspaceId, input.ticketId, input.cUserId],
  );
  const row = cur.rows[0] as { status?: string; rating?: unknown } | undefined;
  if (!row) throw new ServiceHttpError(`工单不存在或不属于当前用户：${input.ticketId}`, 404);
  if (row.status !== "done") throw new ServiceHttpError("仅已完成的工单可评价", 409);
  if (row.rating) throw new ServiceHttpError("该工单已评价过，不可重复评价", 409);
  const r = await client.query(
    `UPDATE c_tickets SET payload = payload || $3::jsonb, updated_at=now()
     WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [input.workspaceId, input.ticketId, JSON.stringify({ rating: { score: input.score, comment: input.comment ?? null } })],
  );
  await client.query(
    `INSERT INTO c_ticket_events (workspace_id, ticket_id, action, actor_type, actor_id, detail)
     VALUES ($1,$2,'rate','c_user',$3,$4)`,
    [input.workspaceId, input.ticketId, input.cUserId, JSON.stringify({ score: input.score, comment: input.comment ?? null })],
  );
  return ticketOf(r.rows[0] as Record<string, unknown>);
}

/** 满意度评价（L9：仅 status=done 可评且只可评一次，重复评 409；评分落 payload.rating + 'rate' 事件） */
export async function rateTicket(input: {
  workspaceId: string; ticketId: string; cUserId: string; score: number; comment?: string;
}): Promise<Ticket> {
  await ensureServiceSchema();
  return serviceTx(input.workspaceId, (client) => rateTicketOn(client, input));
}

export async function getTicket(workspaceId: string, ticketId: string): Promise<Ticket | null> {
  await ensureServiceSchema();
  const rows = await svcQuery(workspaceId, `SELECT * FROM c_tickets WHERE workspace_id=$1 AND id=$2`, [workspaceId, ticketId]);
  return rows[0] ? ticketOf(rows[0]) : null;
}

export async function listTickets(input: {
  workspaceId: string; status?: string; dept?: string; cUserId?: string;
}): Promise<Ticket[]> {
  await ensureServiceSchema();
  const rows = await svcQuery(
    input.workspaceId,
    `SELECT * FROM c_tickets
     WHERE workspace_id=$1
       AND ($2::text IS NULL OR status=$2)
       AND ($3::text IS NULL OR dept=$3)
       AND ($4::text IS NULL OR c_user_id=$4)
     ORDER BY created_at DESC LIMIT 100`,
    [input.workspaceId, input.status ?? null, input.dept ?? null, input.cUserId ?? null],
  );
  return rows.map(ticketOf);
}

export async function ticketTimeline(input: { workspaceId: string; ticketId: string }): Promise<TicketEvent[]> {
  await ensureServiceSchema();
  const rows = await svcQuery(
    input.workspaceId,
    `SELECT * FROM c_ticket_events WHERE workspace_id=$1 AND ticket_id=$2 ORDER BY id`,
    [input.workspaceId, input.ticketId],
  );
  return rows.map(eventOf);
}

/** 事务内 SLA 扫描（D16：供 router serviceTx 回调复用同一 client；超时升级与五元事件同一 COMMIT） */
export async function slaScanOn(
  client: pg.PoolClient,
  input: { workspaceId: string },
): Promise<{ escalated: number }> {
  await ensureServiceSchema();
  const r = await client.query(
    `UPDATE c_tickets SET priority='high', updated_at=now()
     WHERE workspace_id=$1 AND sla_due_at < now() AND status IN ('created','assigned','processing') AND priority <> 'high'
     RETURNING id`,
    [input.workspaceId],
  );
  const ids = (r.rows as Array<{ id: string }>).map((x) => x.id);
  for (const id of ids) {
    await client.query(
      `INSERT INTO c_ticket_events (workspace_id, ticket_id, action, actor_type, actor_id, detail)
       VALUES ($1,$2,'escalate','system','sla-scan',$3)`,
      [input.workspaceId, id, JSON.stringify({ reason: "SLA 超时" })],
    );
  }
  return { escalated: ids.length };
}

/** SLA 扫描：超时未完结 → 升级 priority=high + 'escalate' 事件（幂等：已 high 不重复） */
export async function slaScan(input: { workspaceId: string }): Promise<{ escalated: number }> {
  await ensureServiceSchema();
  return serviceTx(input.workspaceId, (client) => slaScanOn(client, input));
}
