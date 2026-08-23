/**
 * service · C 端公开网关（Hono 子应用，挂 /c，独立于员工 tRPC）
 *  - POST /c/session：三渠道 openid → c_user + c-token（secret=env SERVICE_C_SECRET，缺省开发占位）
 *  - 鉴权：Bearer c-token（verifyCToken）；内存限流 60 次/分钟/用户
 *  - POST /c/chat：service-dialog 流水线；toolCall → biz-hotel 适配器执行并渲染卡片；
 *    ticketDraft + confirmTicket:true → createTicket + 自动派单 + 受理推送
 *  - GET /c/orders / /c/member：酒店示例业务查询（demo:true 透传）
 *  - POST /c/tickets（幂等键客户端传或服务端生成）、GET /c/tickets(/:id 含 timeline)
 *  - GET /c/notifications：推送箱；POST /c/tickets/:id/rate：满意度（落事件）
 * 工作区解析：C 端无工作区入参，取 env SERVICE_C_WORKSPACE_ID，缺省第一个工作区（演示口径，
 * 与登录引导同 owner 池例外点；多渠道多工作区部署时按 channel 配置路由表替换）。
 */
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getOwnerPool } from "@workloom/db";
import {
  CHANNELS, cSecret, getCUser, issueCToken, listNotifications, pushMessage,
  resolveCUser, verifyCToken, type Channel, type CTokenPayload,
} from "./channels.js";
import { handleMessage } from "./dialog.js";
import { runBizTool, hotelBizAdapter, type BizTool } from "./adapters/biz-hotel.js";
import { assignTicket, createTicket, findTicketByIdem, getTicket, listTickets, rateTicket, ticketTimeline } from "./ticket.js";
import { ensureServiceSchema } from "./store.js";
import { appendEventOn, serviceTx } from "./events.js";

export const serviceGateway = new Hono();

/** C 端工作区解析（登录引导同款 owner 池例外点，F7.1） */
let cachedWorkspaceId: string | null = null;
async function cWorkspaceId(): Promise<string> {
  if (process.env.SERVICE_C_WORKSPACE_ID) return process.env.SERVICE_C_WORKSPACE_ID;
  if (cachedWorkspaceId) return cachedWorkspaceId;
  await ensureServiceSchema();
  const r = await getOwnerPool().query(`SELECT id FROM workspaces ORDER BY created_at LIMIT 1`);
  const id = r.rows[0]?.id as string | undefined;
  if (!id) throw new Error("无可用工作区（请先完成员工端登录引导）");
  cachedWorkspaceId = id;
  return id;
}

/* ---------------- 内存限流（60 次/分钟/用户） ---------------- */
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimited(key: string): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  b.count += 1;
  return b.count > 60;
}

/* ---------------- 鉴权中间件（Bearer c-token） ---------------- */
async function cAuth(c: Context, next: Next): Promise<Response | void> {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return c.json({ error: "未认证（缺少 c-token）" }, 401);
  const payload = await verifyCToken(auth.slice(7), cSecret());
  if (!payload) return c.json({ error: "c-token 无效或已过期" }, 401);
  if (rateLimited(payload.cUserId)) return c.json({ error: "请求过于频繁（60 次/分钟）" }, 429);
  c.set("cAuth", payload);
  await next();
}

function authOf(c: Context): CTokenPayload {
  return c.get("cAuth") as CTokenPayload;
}

/** 解析 JSON body（非法/空 body → {}），属性经 Partial 访问、校验后使用 */
async function bodyOf<T>(c: Context): Promise<Partial<T>> {
  try {
    return (await c.req.json()) as Partial<T>;
  } catch {
    return {};
  }
}

/* ---------------- 会话 ---------------- */
serviceGateway.post("/session", async (c) => {
  const body = await bodyOf<{ channel: string; openid: string; nickname: string }>(c);
  if (!body.channel || !(CHANNELS as readonly string[]).includes(body.channel)) {
    return c.json({ error: `channel 须为 ${CHANNELS.join("/")}` }, 400);
  }
  if (!body.openid) return c.json({ error: "缺少 openid" }, 400);
  const workspaceId = await cWorkspaceId();
  const user = await resolveCUser({ workspaceId, channel: body.channel as Channel, openid: body.openid, nickname: body.nickname });
  const token = await issueCToken({ workspaceId, cUserId: user.id, channel: user.channel, secret: cSecret() });
  return c.json({ token, user });
});

/* ---------------- 对话 ---------------- */
serviceGateway.post("/chat", cAuth, async (c) => {
  const a = authOf(c);
  const body = await bodyOf<{
    conversationId: string; text: string; confirmTicket: boolean;
    ticketDraft: { kind: string; title: string; payload: Record<string, unknown> };
  }>(c);
  if (!body.text?.trim()) return c.json({ error: "缺少 text" }, 400);

  const r = await handleMessage({
    workspaceId: a.workspaceId, cUserId: a.cUserId, channel: a.channel,
    text: body.text.trim(), conversationId: body.conversationId,
  });

  // 业务查询工具：执行适配器并渲染卡片字段
  const cards: Array<{ type: string; data: unknown; demo?: boolean }> = [];
  if (r.toolCall) {
    const user = await getCUser(a.workspaceId, a.cUserId);
    const data = await runBizTool(r.toolCall.tool as BizTool, {
      workspaceId: a.workspaceId, cUserId: a.cUserId, memberId: user?.memberId ?? null,
    }, r.toolCall.params);
    cards.push({ type: r.toolCall.tool, data, demo: (data as { demo?: boolean }).demo });
  }

  // 工单草稿确认：confirmTicket:true → 建单 + 自动派单 + 受理推送（五元事件同事务留痕 create）
  let ticket: unknown = null;
  const draft = body.confirmTicket ? (r.ticketDraft ?? body.ticketDraft) : undefined;
  if (draft) {
    const t = await createTicket({
      workspaceId: a.workspaceId, cUserId: a.cUserId, conversationId: r.conversationId,
      kind: draft.kind, title: draft.title, payload: draft.payload,
    });
    await assignTicket({ workspaceId: a.workspaceId, ticketId: t.id });
    ticket = await getTicket(a.workspaceId, t.id);
    await serviceTx(a.workspaceId, async (client, scope) => {
      await appendEventOn(client, scope, { id: a.cUserId, type: "human" }, {
        objectType: "ticket", objectId: t.id, action: "service.ticket.create",
        after: { kind: draft.kind, title: draft.title, channel: a.channel, source: "c-chat" },
        channel: a.channel,
      });
    });
    await pushMessage({
      workspaceId: a.workspaceId, cUserId: a.cUserId, kind: "ticket.accepted",
      payload: { ticketId: t.id, title: t.title, text: `您的工单「${t.title}」已受理，${t.dept ?? "客服部"}将尽快跟进。` },
    });
  }

  return c.json({
    conversationId: r.conversationId,
    intent: r.intent,
    answer: r.answer,
    confidence: r.confidence,
    citations: r.citations,
    cards,
    ticket,
    ticketDraft: r.ticketDraft ?? null,
    latencyMs: r.latencyMs,
    ...(r.mock ? { mock: true } : {}),
  });
});

/* ---------------- 业务查询（酒店示例适配器） ---------------- */
serviceGateway.get("/orders", cAuth, async (c) => {
  const a = authOf(c);
  const user = await getCUser(a.workspaceId, a.cUserId);
  const data = await hotelBizAdapter.queryOrder({ workspaceId: a.workspaceId, cUserId: a.cUserId, memberId: user?.memberId ?? null });
  return c.json(data);
});

serviceGateway.get("/member", cAuth, async (c) => {
  const a = authOf(c);
  const user = await getCUser(a.workspaceId, a.cUserId);
  const data = await hotelBizAdapter.queryMember({ workspaceId: a.workspaceId, cUserId: a.cUserId, memberId: user?.memberId ?? null });
  return c.json(data);
});

/* ---------------- 工单 ---------------- */
serviceGateway.post("/tickets", cAuth, async (c) => {
  const a = authOf(c);
  const body = await bodyOf<{
    kind: string; title: string; payload: Record<string, unknown>;
    conversationId: string; idempotencyKey: string;
  }>(c);
  if (!body.kind || !body.title) return c.json({ error: "缺少 kind/title" }, 400);
  // 幂等重放短路：已存在同键工单 → 直接返回，不重复派单/推送/留痕
  if (body.idempotencyKey) {
    const existing = await findTicketByIdem(a.workspaceId, body.idempotencyKey);
    if (existing) return c.json({ ticket: existing, idempotentReplay: true });
  }
  const t = await createTicket({
    workspaceId: a.workspaceId, cUserId: a.cUserId, conversationId: body.conversationId,
    kind: body.kind, title: body.title, payload: body.payload ?? {},
    idempotencyKey: body.idempotencyKey,
  });
  // 自动派单（部门路由表）+ 受理通知
  await assignTicket({ workspaceId: a.workspaceId, ticketId: t.id });
  const ticket = await getTicket(a.workspaceId, t.id);
  await serviceTx(a.workspaceId, async (client, scope) => {
    await appendEventOn(client, scope, { id: a.cUserId, type: "human" }, {
      objectType: "ticket", objectId: t.id, action: "service.ticket.create",
      after: { kind: body.kind, title: body.title, dept: ticket?.dept, channel: a.channel },
      channel: a.channel,
    });
  });
  await pushMessage({
    workspaceId: a.workspaceId, cUserId: a.cUserId, kind: "ticket.accepted",
    payload: { ticketId: t.id, title: t.title, text: `您的工单「${t.title}」已受理，${ticket?.dept ?? "客服部"}将尽快跟进。` },
  });
  return c.json({ ticket });
});

serviceGateway.get("/tickets", cAuth, async (c) => {
  const a = authOf(c);
  const tickets = await listTickets({ workspaceId: a.workspaceId, cUserId: a.cUserId });
  return c.json({ tickets });
});

serviceGateway.get("/tickets/:id", cAuth, async (c) => {
  const a = authOf(c);
  const ticket = await getTicket(a.workspaceId, String(c.req.param("id")));
  if (!ticket || ticket.cUserId !== a.cUserId) return c.json({ error: "工单不存在" }, 404);
  const timeline = await ticketTimeline({ workspaceId: a.workspaceId, ticketId: ticket.id });
  return c.json({ ticket, timeline });
});

serviceGateway.post("/tickets/:id/rate", cAuth, async (c) => {
  const a = authOf(c);
  const body = await bodyOf<{ score: number; comment: string }>(c);
  if (!body.score || body.score < 1 || body.score > 5) return c.json({ error: "score 须为 1-5" }, 400);
  let ticket;
  try {
    ticket = await rateTicket({
      workspaceId: a.workspaceId, ticketId: String(c.req.param("id")), cUserId: a.cUserId,
      score: body.score, comment: body.comment,
    });
  } catch {
    return c.json({ error: "工单不存在或不属于当前用户" }, 404);
  }
  await serviceTx(a.workspaceId, async (client, scope) => {
    await appendEventOn(client, scope, { id: a.cUserId, type: "human" }, {
      objectType: "ticket", objectId: ticket.id, action: "service.ticket.rate",
      after: { score: body.score, comment: body.comment ?? null }, channel: a.channel,
    });
  });
  return c.json({ ticket });
});

/* ---------------- 推送箱 ---------------- */
serviceGateway.get("/notifications", cAuth, async (c) => {
  const a = authOf(c);
  const notifications = await listNotifications({ workspaceId: a.workspaceId, cUserId: a.cUserId });
  return c.json({ notifications });
});
