/**
 * service · C 端公开网关（Hono 子应用，挂 /c，独立于员工 tRPC）
 *  - POST /c/session（S2）：h5 直登仅 SERVICE_C_DEMO_AUTH==='true' 放行（默认开发态 true，启动告警）；
 *    wechat-mini/alipay 走 code→openid 交换 seam（无凭据 503「渠道未配置」）；
 *    IP+channel 限流 60 次/分（限流 Map 5 分钟 TTL 清扫）
 *  - 鉴权：Bearer c-token（verifyCToken）；内存限流 60 次/分钟/用户
 *  - POST /c/chat：service-dialog 流水线；toolCall → biz-hotel 适配器执行并渲染契约卡片；
 *    ticketDraft + confirmTicket:true → 服务端幂等键 + createTicket/assignTicket/五元事件同一 serviceTx（H2）；
 *    pushMessage 失败 catch 落库 status='failed' 不阻断响应
 *  - 契约（H6，以 webc types.ts 为准）：cards={kind:'order'|'member'|'catalog',data}；
 *    工单附 statusText 中文枚举（保留英文 status）；/member={level,points,benefits[],demo?}；
 *    /orders=[{id,title,status,checkIn?,roomType?,amount?}]；/notifications 每项含 read:false
 *  - 输入约束（M9）：/chat text≤2000；/tickets kind 白名单 + title≤120 + payload JSON≤10KB
 * 工作区解析：C 端无工作区入参，取 env SERVICE_C_WORKSPACE_ID，缺省第一个工作区（演示口径）。
 */
import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getOwnerPool } from "@workloom/db";
import {
  CHANNELS, cSecret, exchangeCodeForOpenid, getCUser, issueCToken, listNotifications, pushMessage,
  resolveCUser, verifyCToken, type Channel, type CTokenPayload,
} from "./channels.js";
import { handleMessage } from "./dialog.js";
import { runBizTool, hotelBizAdapter, type BizTool, type DemoOrder } from "./adapters/biz-hotel.js";
import {
  ServiceHttpError, assignTicketOn, createTicketOn, getTicket, listTickets, rateTicket, ticketTimeline,
  type Ticket,
} from "./ticket.js";
import { ensureServiceSchema } from "./store.js";
import { appendEventOn, serviceTx } from "./events.js";

export const serviceGateway = new Hono();

/** S2：h5/openid 演示直登开关（开发缺省 true；P1-11：生产环境缺省 false，必须显式配置渠道凭据或显式开启） */
export const DEMO_AUTH = (process.env.SERVICE_C_DEMO_AUTH ?? (process.env.NODE_ENV === "production" ? "false" : "true")) === "true";
if (DEMO_AUTH) {
  console.warn("[service-c] SERVICE_C_DEMO_AUTH 已开启：h5/openid 演示直登可用（生产环境必须置 false 并配置渠道 code 交换凭据）");
}

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

/* ---------------- 内存限流（60 次/分钟；Map 5 分钟 TTL 清扫防内存膨胀） ---------------- */
const buckets = new Map<string, { count: number; resetAt: number; touchedAt: number }>();
const BUCKET_TTL_MS = 5 * 60_000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.resetAt <= now || now - b.touchedAt > BUCKET_TTL_MS) buckets.delete(k);
  }
}, 60_000);
sweeper.unref?.();

function rateLimited(key: string, limit = 60): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000, touchedAt: now });
    return false;
  }
  b.count += 1;
  b.touchedAt = now;
  return b.count > limit;
}

/* ---------------- 鉴权中间件（Bearer c-token） ---------------- */
async function cAuth(c: Context, next: Next): Promise<Response | void> {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return c.json({ error: "未认证（缺少 c-token）" }, 401);
  const payload = await verifyCToken(auth.slice(7), cSecret());
  if (!payload) return c.json({ error: "c-token 无效或已过期" }, 401);
  if (rateLimited(`c:${payload.cUserId}`)) return c.json({ error: "请求过于频繁（60 次/分钟）" }, 429);
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

function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** 统一错误映射：ServiceHttpError → 语义状态码；其余 → 500 带 requestId（L9） */
function fail(c: Context, err: unknown, requestId: string): Response {
  if (err instanceof ServiceHttpError) return c.json({ error: err.message, requestId }, err.status as 400);
  console.warn(`[service-c] 请求处理失败 requestId=${requestId}：`, err instanceof Error ? err.message : err);
  return c.json({ error: "服务内部错误", requestId }, 500);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/* ---------------- H6 契约序列化 ---------------- */

/** 工单状态 → webc 中文枚举（保留英文 status，提供 statusText） */
const TICKET_STATUS_TEXT: Record<string, string> = {
  created: "已受理",
  assigned: "已受理",
  processing: "处理中",
  done: "已完成",
  closed: "已关闭",
};

export function serializeTicket(t: Ticket): Ticket & { statusText: string } {
  return { ...t, statusText: TICKET_STATUS_TEXT[t.status] ?? t.status };
}

/** 会员等级 → 权益清单（演示口径） */
function benefitsOf(tier: string): string[] {
  if (tier.includes("金")) return ["免费双人早餐", "延迟退房至 14:00", "积分 1.5 倍累积"];
  if (tier.includes("银")) return ["免费早餐", "积分 1.2 倍累积"];
  return ["积分累积"];
}

function orderToContract(o: DemoOrder): Record<string, unknown> {
  return {
    id: o.orderId,
    title: `${o.roomType} · 入住 ${o.checkIn}`,
    status: o.status,
    checkIn: o.checkIn,
    roomType: o.roomType,
    amount: o.amountYuan,
  };
}

/** 工单受理推送：失败 catch 落库 status='failed' 不阻断响应（H2） */
async function pushAcceptedSafely(input: {
  workspaceId: string; cUserId: string; ticketId: string; title: string; dept: string | null;
}): Promise<void> {
  const payload = {
    ticketId: input.ticketId, title: input.title,
    text: `您的工单「${input.title}」已受理，${input.dept ?? "客服部"}将尽快跟进。`,
  };
  try {
    await pushMessage({ workspaceId: input.workspaceId, cUserId: input.cUserId, kind: "ticket.accepted", payload });
  } catch (err) {
    console.warn(`[service-c] 受理推送失败，落 failed 通知（不阻断建单响应）：`, err instanceof Error ? err.message : err);
    try {
      await serviceTx(input.workspaceId, async (client) => {
        await client.query(
          `INSERT INTO c_notifications (workspace_id, c_user_id, channel, kind, payload, driver, status)
           VALUES ($1,$2,'h5','ticket.accepted',$3,'mock','failed')`,
          [input.workspaceId, input.cUserId, JSON.stringify(payload)],
        );
      });
    } catch (err2) {
      console.warn(`[service-c] failed 通知落库也失败：`, err2 instanceof Error ? err2.message : err2);
    }
  }
}

/** 建单链路（H2）：createTicket + assignTicket + 五元事件同一 serviceTx；幂等命中直接返回原单 */
async function createTicketFlow(input: {
  workspaceId: string; cUserId: string; channel: string; conversationId?: string;
  kind: string; title: string; payload: Record<string, unknown>; idempotencyKey: string;
}): Promise<{ ticket: Ticket; deduped: boolean }> {
  return serviceTx(input.workspaceId, async (client, scope) => {
    const { ticket, deduped } = await createTicketOn(client, {
      workspaceId: input.workspaceId, cUserId: input.cUserId, conversationId: input.conversationId,
      kind: input.kind, title: input.title, payload: input.payload, idempotencyKey: input.idempotencyKey,
    });
    if (deduped) return { ticket, deduped: true }; // 幂等重放：不重复派单/推送/留痕
    const assigned = await assignTicketOn(client, { workspaceId: input.workspaceId, ticketId: ticket.id });
    await appendEventOn(client, scope, { id: input.cUserId, type: "human" }, {
      objectType: "ticket", objectId: ticket.id, action: "service.ticket.create",
      after: { kind: input.kind, title: input.title, dept: assigned.dept, channel: input.channel },
      channel: input.channel,
    });
    return { ticket: assigned, deduped: false };
  });
}

/* ---------------- 会话 ---------------- */
serviceGateway.post("/session", async (c) => {
  const requestId = randomUUID();
  try {
    const body = await bodyOf<{ channel: string; openid: string; nickname: string; code: string }>(c);
    if (!body.channel || !(CHANNELS as readonly string[]).includes(body.channel)) {
      return c.json({ error: `channel 须为 ${CHANNELS.join("/")}` }, 400);
    }
    const channel = body.channel as Channel;
    // S2：IP+channel 限流（60 次/分，防 openid 爆破）
    if (rateLimited(`session:${clientIp(c)}:${channel}`)) {
      return c.json({ error: "请求过于频繁（60 次/分钟）" }, 429);
    }
    let openid: string;
    if (channel === "h5") {
      // h5 直登仅演示授权放行（S2）
      if (!DEMO_AUTH) return c.json({ error: "h5 演示直登已关闭（SERVICE_C_DEMO_AUTH=false）" }, 403);
      if (!body.openid) return c.json({ error: "缺少 openid" }, 400);
      openid = body.openid;
    } else if (DEMO_AUTH && body.openid) {
      openid = body.openid; // 开发态：小程序渠道也允许 openid 直登
    } else {
      // wechat-mini / alipay：code → openid 交换 seam（无凭据 503 渠道未配置）
      if (!body.code) return c.json({ error: `缺少 code（${channel} 需经 code 换取 openid）` }, 400);
      const ex = await exchangeCodeForOpenid(channel, body.code);
      if (!ex.ok) return c.json({ error: `渠道未配置：${channel}（${ex.reason}）`, requestId }, 503);
      openid = ex.openid;
    }
    const workspaceId = await cWorkspaceId();
    const user = await resolveCUser({ workspaceId, channel, openid, nickname: body.nickname });
    const token = await issueCToken({ workspaceId, cUserId: user.id, channel: user.channel, secret: cSecret() });
    return c.json({ token, user });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

/* ---------------- 对话 ---------------- */
serviceGateway.post("/chat", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const body = await bodyOf<{
      conversationId: string; text: string; confirmTicket: boolean; idempotencyKey: string;
      ticketDraft: { kind: string; title: string; payload: Record<string, unknown> };
    }>(c);
    if (!body.text?.trim()) return c.json({ error: "缺少 text" }, 400);
    if (body.text.length > 2000) return c.json({ error: "text 超长（≤2000 字符）" }, 400);

    const r = await handleMessage({
      workspaceId: a.workspaceId, cUserId: a.cUserId, channel: a.channel,
      text: body.text.trim(), conversationId: body.conversationId,
    });

    // 业务查询工具：执行适配器并渲染契约卡片（H6：{kind:'order'|'member'|'catalog', data}）
    const cards: Array<{ kind: "order" | "member" | "catalog"; data: Record<string, unknown> }> = [];
    let answer = r.answer;
    if (r.toolCall) {
      const user = await getCUser(a.workspaceId, a.cUserId);
      const data = await runBizTool(r.toolCall.tool as BizTool, {
        workspaceId: a.workspaceId, cUserId: a.cUserId, memberId: user?.memberId ?? null,
      }, r.toolCall.params);
      const d = data as {
        demo?: boolean; bindRequired?: boolean; hint?: string;
        orders?: DemoOrder[]; items?: Array<{ sku: string; name: string; priceYuan: number }>;
        member?: { memberId: string; name: string; tier: string; points: number } | null;
        ticket?: Record<string, unknown> | null;
      };
      if (d.bindRequired) {
        // S4：未绑定 → 不出卡，答案替换为绑定引导
        answer = d.hint ?? "请先绑定会员身份后再查询。";
      } else if (r.toolCall.tool === "query_order") {
        for (const o of d.orders ?? []) cards.push({ kind: "order", data: orderToContract(o) });
      } else if (r.toolCall.tool === "query_member") {
        if (d.member) {
          cards.push({
            kind: "member",
            data: { level: d.member.tier, points: d.member.points, benefits: benefitsOf(d.member.tier), demo: d.demo ?? true },
          });
        }
      } else if (r.toolCall.tool === "query_catalog") {
        cards.push({ kind: "catalog", data: { items: d.items ?? [], demo: d.demo ?? true } });
      } else if (r.toolCall.tool === "query_ticket") {
        const t = d.ticket;
        if (t) answer = `您的工单「${String(t.title)}」当前状态：${TICKET_STATUS_TEXT[String(t.status)] ?? String(t.status)}，${String(t.dept ?? "客服部")}跟进中。`;
      }
    }

    // 工单草稿确认：confirmTicket:true → 服务端幂等键 + 同事务建单/派单/五元事件（H2）
    let ticket: (Ticket & { statusText: string }) | null = null;
    let deduped = false;
    const draft = body.confirmTicket ? (body.ticketDraft ?? r.ticketDraft) : undefined; // 客户端显式回传的草稿优先于本轮新产生的兜底草稿
    if (draft) {
      const idempotencyKey = body.idempotencyKey ?? `chat:${r.conversationId}:${sha256(body.text.trim()).slice(0, 16)}`;
      const flow = await createTicketFlow({
        workspaceId: a.workspaceId, cUserId: a.cUserId, channel: a.channel, conversationId: r.conversationId,
        kind: draft.kind, title: draft.title.slice(0, 120), payload: draft.payload ?? {}, idempotencyKey,
      });
      deduped = flow.deduped;
      if (!flow.deduped) {
        await pushAcceptedSafely({
          workspaceId: a.workspaceId, cUserId: a.cUserId,
          ticketId: flow.ticket.id, title: flow.ticket.title, dept: flow.ticket.dept,
        });
      }
      ticket = serializeTicket(flow.ticket);
    }

    return c.json({
      conversationId: r.conversationId,
      intent: r.intent,
      answer,
      confidence: r.confidence,
      citations: r.citations,
      cards,
      ticket,
      ...(deduped ? { deduped: true } : {}),
      ticketDraft: r.ticketDraft ?? null,
      latencyMs: r.latencyMs,
      ...(r.mock ? { mock: true } : {}),
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

/* ---------------- 业务查询（酒店示例适配器；H6 契约形状） ---------------- */
serviceGateway.get("/orders", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const user = await getCUser(a.workspaceId, a.cUserId);
    const data = await hotelBizAdapter.queryOrder({ workspaceId: a.workspaceId, cUserId: a.cUserId, memberId: user?.memberId ?? null });
    return c.json({
      orders: data.orders.map(orderToContract),
      demo: data.demo,
      ...(data.bindRequired ? { bindRequired: true, hint: data.hint } : {}),
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.get("/member", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const user = await getCUser(a.workspaceId, a.cUserId);
    const data = await hotelBizAdapter.queryMember({ workspaceId: a.workspaceId, cUserId: a.cUserId, memberId: user?.memberId ?? null });
    if (data.bindRequired || !data.member) {
      return c.json({
        level: "游客", points: 0, benefits: [], demo: data.demo,
        bindRequired: true, hint: data.hint,
      });
    }
    return c.json({
      level: data.member.tier,
      points: data.member.points,
      benefits: benefitsOf(data.member.tier),
      demo: data.demo,
    });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

/* ---------------- 工单 ---------------- */
const TICKET_KINDS = ["delivery", "repair", "complaint", "other", "service_request", "consult"] as const;

serviceGateway.post("/tickets", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const body = await bodyOf<{
      kind: string; title: string; payload: Record<string, unknown>;
      conversationId: string; idempotencyKey: string;
    }>(c);
    if (!body.kind || !body.title?.trim()) return c.json({ error: "缺少 kind/title" }, 400);
    // M9 输入约束：kind 白名单 / title≤120 / payload JSON≤10KB
    if (!(TICKET_KINDS as readonly string[]).includes(body.kind)) {
      return c.json({ error: `kind 须为 ${TICKET_KINDS.join("/")}` }, 400);
    }
    const title = body.title.trim();
    if (title.length > 120) return c.json({ error: "title 超长（≤120 字符）" }, 400);
    const payload = body.payload ?? {};
    if (JSON.stringify(payload).length > 10 * 1024) return c.json({ error: "payload 超大（≤10KB）" }, 400);
    // H2：客户端传入幂等键优先，否则服务端强制生成（重放安全）
    const idempotencyKey = body.idempotencyKey
      ?? `ticket:${a.cUserId}:${sha256(`${body.kind}|${title}|${JSON.stringify(payload)}`).slice(0, 16)}`;

    const flow = await createTicketFlow({
      workspaceId: a.workspaceId, cUserId: a.cUserId, channel: a.channel, conversationId: body.conversationId,
      kind: body.kind, title, payload, idempotencyKey,
    });
    if (flow.deduped) return c.json({ ticket: serializeTicket(flow.ticket), idempotentReplay: true });
    await pushAcceptedSafely({
      workspaceId: a.workspaceId, cUserId: a.cUserId,
      ticketId: flow.ticket.id, title: flow.ticket.title, dept: flow.ticket.dept,
    });
    return c.json({ ticket: serializeTicket(flow.ticket) });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.get("/tickets", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const tickets = await listTickets({ workspaceId: a.workspaceId, cUserId: a.cUserId });
    return c.json({ tickets: tickets.map(serializeTicket) });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.get("/tickets/:id", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const ticket = await getTicket(a.workspaceId, String(c.req.param("id")));
    if (!ticket || ticket.cUserId !== a.cUserId) return c.json({ error: "工单不存在", requestId }, 404);
    const timeline = await ticketTimeline({ workspaceId: a.workspaceId, ticketId: ticket.id });
    // H6：detail 归一为字符串（webc TimelineItem.detail: string）
    const items = timeline.map((e) => ({
      action: e.action,
      actorType: e.actorType,
      actorId: e.actorId,
      detail: typeof e.detail === "string" ? e.detail : String((e.detail as Record<string, unknown>).note ?? JSON.stringify(e.detail)),
      createdAt: e.createdAt,
    }));
    return c.json({ ticket: serializeTicket(ticket), timeline: items });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

serviceGateway.post("/tickets/:id/rate", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const body = await bodyOf<{ score: number; comment: string }>(c);
    if (!body.score || body.score < 1 || body.score > 5) return c.json({ error: "score 须为 1-5" }, 400);
    // L9：仅 done 可评且只可评一次（rateTicket 内状态机/幂等断言，409/404 语义）
    const ticket = await rateTicket({
      workspaceId: a.workspaceId, ticketId: String(c.req.param("id")), cUserId: a.cUserId,
      score: body.score, comment: body.comment,
    });
    await serviceTx(a.workspaceId, async (client, scope) => {
      await appendEventOn(client, scope, { id: a.cUserId, type: "human" }, {
        objectType: "ticket", objectId: ticket.id, action: "service.ticket.rate",
        after: { score: body.score, comment: body.comment ?? null }, channel: a.channel,
      });
    });
    return c.json({ ticket: serializeTicket(ticket) });
  } catch (err) {
    return fail(c, err, requestId);
  }
});

/* ---------------- 推送箱 ---------------- */
serviceGateway.get("/notifications", cAuth, async (c) => {
  const requestId = randomUUID();
  try {
    const a = authOf(c);
    const notifications = await listNotifications({ workspaceId: a.workspaceId, cUserId: a.cUserId });
    return c.json({ notifications });
  } catch (err) {
    return fail(c, err, requestId);
  }
});
