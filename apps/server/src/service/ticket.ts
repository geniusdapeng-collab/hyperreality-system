/**
 * service · 工单（接口对齐 packages/base/service-ticket 签名；表结构为底座迁移版）
 *  - 状态机（底座 CHECK）：created → assigned → processing → done（closed 为关闭终态）
 *  - 幂等：客户端传 idempotencyKey（唯一部分索引）；命中直接返回原工单
 *  - 部门路由表：kind → 默认部门（自动派单）；SLA：sla_due_at 按 kind 时限，超时升级 priority=high + 事件留痕
 *  - 满意度：落 payload.rating（底座表无独立评分列）+ c_ticket_events 'rate' 事件
 * 全部读写经 svcQuery/serviceTx（RLS 事务上下文）。
 */
import { ensureServiceSchema } from "./store.js";
import { serviceTx, svcQuery } from "./events.js";

export type TicketStatus = "created" | "assigned" | "processing" | "done" | "closed";

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
  service_request: "客房部",
  consult: "前厅部",
  other: "前厅部",
};

/** SLA 时限（小时，按 kind；演示口径） */
const SLA_HOURS: Record<string, number> = {
  complaint: 4,
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

export async function createTicket(input: {
  workspaceId: string; cUserId: string; conversationId?: string;
  kind: string; title: string; payload: Record<string, unknown>; idempotencyKey?: string;
}): Promise<Ticket> {
  await ensureServiceSchema();
  if (input.idempotencyKey) {
    const hit = await svcQuery(
      input.workspaceId,
      `SELECT * FROM c_tickets WHERE workspace_id=$1 AND idempotency_key=$2`,
      [input.workspaceId, input.idempotencyKey],
    );
    if (hit[0]) return ticketOf(hit[0]);
  }
  const slaHours = SLA_HOURS[input.kind] ?? SLA_HOURS.other!;
  return serviceTx(input.workspaceId, async (client) => {
    const r = await client.query(
      `INSERT INTO c_tickets (id, workspace_id, c_user_id, conversation_id, kind, title, payload, idempotency_key, sla_due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' hours')::interval) RETURNING *`,
      [newId("tck"), input.workspaceId, input.cUserId, input.conversationId ?? null, input.kind, input.title,
       JSON.stringify(input.payload), input.idempotencyKey ?? null, String(slaHours)],
    );
    const row = r.rows[0] as Record<string, unknown>;
    await client.query(
      `INSERT INTO c_ticket_events (workspace_id, ticket_id, action, actor_type, actor_id, detail)
       VALUES ($1,$2,'create','c_user',$3,$4)`,
      [input.workspaceId, String(row.id), input.cUserId, JSON.stringify({ kind: input.kind, title: input.title })],
    );
    return ticketOf(row);
  });
}

async function transition(input: {
  workspaceId: string; ticketId: string; action: string;
  actorType: string; actorId: string; detail?: Record<string, unknown>;
  setStatus?: TicketStatus; setDept?: string | null; setAssignee?: string | null;
  setPriority?: string; setResult?: Record<string, unknown>; mergePayload?: Record<string, unknown>;
}): Promise<Ticket> {
  await ensureServiceSchema();
  return serviceTx(input.workspaceId, async (client) => {
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
    if (!row) throw new Error(`工单不存在：${input.ticketId}`);
    await client.query(
      `INSERT INTO c_ticket_events (workspace_id, ticket_id, action, actor_type, actor_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.workspaceId, input.ticketId, input.action, input.actorType, input.actorId, JSON.stringify(input.detail ?? {})],
    );
    return ticketOf(row);
  });
}

export async function assignTicket(input: {
  workspaceId: string; ticketId: string; dept?: string; assignee?: string;
}): Promise<Ticket> {
  const cur = await getTicket(input.workspaceId, input.ticketId);
  if (!cur) throw new Error(`工单不存在：${input.ticketId}`);
  const dept = input.dept ?? DEPT_ROUTE[cur.kind] ?? DEPT_ROUTE.other!;
  return transition({
    ...input, action: "assign", actorType: "system", actorId: "service-desk",
    setStatus: "assigned", setDept: dept, setAssignee: input.assignee ?? null,
    detail: { dept, assignee: input.assignee ?? null },
  });
}

export async function advanceTicket(input: {
  workspaceId: string; ticketId: string; action: string;
  actorType: string; actorId: string; detail?: Record<string, unknown>;
}): Promise<Ticket> {
  // B 端推进：start → processing；其余 action 原样留痕不变更状态
  return transition({ ...input, setStatus: input.action === "start" ? "processing" : undefined });
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

/** 满意度评价（C 端本人工单；评分落 payload.rating + 'rate' 事件留痕） */
export async function rateTicket(input: {
  workspaceId: string; ticketId: string; cUserId: string; score: number; comment?: string;
}): Promise<Ticket> {
  await ensureServiceSchema();
  return serviceTx(input.workspaceId, async (client) => {
    const r = await client.query(
      `UPDATE c_tickets SET payload = payload || $3::jsonb, updated_at=now()
       WHERE workspace_id=$1 AND id=$2 AND c_user_id=$4 RETURNING *`,
      [input.workspaceId, input.ticketId, JSON.stringify({ rating: { score: input.score, comment: input.comment ?? null } }), input.cUserId],
    );
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error(`工单不存在或不属于当前用户：${input.ticketId}`);
    await client.query(
      `INSERT INTO c_ticket_events (workspace_id, ticket_id, action, actor_type, actor_id, detail)
       VALUES ($1,$2,'rate','c_user',$3,$4)`,
      [input.workspaceId, input.ticketId, input.cUserId, JSON.stringify({ score: input.score, comment: input.comment ?? null })],
    );
    return ticketOf(row);
  });
}

export async function getTicket(workspaceId: string, ticketId: string): Promise<Ticket | null> {
  await ensureServiceSchema();
  const rows = await svcQuery(workspaceId, `SELECT * FROM c_tickets WHERE workspace_id=$1 AND id=$2`, [workspaceId, ticketId]);
  return rows[0] ? ticketOf(rows[0]) : null;
}

/** 按幂等键查已有工单（网关幂等重放短路用：命中则不再派单/推送/留痕） */
export async function findTicketByIdem(workspaceId: string, idempotencyKey: string): Promise<Ticket | null> {
  await ensureServiceSchema();
  const rows = await svcQuery(
    workspaceId,
    `SELECT * FROM c_tickets WHERE workspace_id=$1 AND idempotency_key=$2`,
    [workspaceId, idempotencyKey],
  );
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

/** SLA 扫描：超时未完结 → 升级 priority=high + 'escalate' 事件（幂等：已 high 不重复） */
export async function slaScan(input: { workspaceId: string }): Promise<{ escalated: number }> {
  await ensureServiceSchema();
  return serviceTx(input.workspaceId, async (client) => {
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
  });
}
