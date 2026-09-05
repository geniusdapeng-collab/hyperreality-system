/**
 * service-dialog · C 端问答引擎（handleMessage）
 *
 * 链路：落用户消息 → routeIntent（规则先行 + LLM 兜底）→ 分支处理 → 落助手消息 + 五元事件：
 *  - kb_qa：searchKB 混合检索 → 置信度三档分流（top1 ≥0.72 高置信直答；0.5–0.72 中置信附
 *    「可能不完全准确」提示；<0.5 诚实拒答 + ticketDraft 自动建单草稿）。组答强制引用——
 *    citations 非空才外发，无据不答（防幻觉铁律）。
 *  - complaint / service_request：直接生成 ticketDraft（由 server 层落 service-ticket）。
 *  - biz_query：不答数据，返回工具调用描述 {tool, params}（工具契约由 server 层执行）。
 *  - chat：LLM 注入式；无 LLM 确定性 mock 应答（标注 mock:true，全链路离线可演示）。
 * 事件：经注入的 gatewayAppend 风格 emitter（签名参照 workdata/gateway.ts；测试注入内存 emitter）。
 */
import { newId } from "@workloom/shared";
import { routeIntent, type Intent, type IntentLlm } from "./intents.js";
import type { Queryable } from "../service-kb/kb.js";
import { searchKB, type KbSearchHit } from "../service-kb/search.js";

/* ================= 置信度三档 ================= */

export type ConfidenceTier = "high" | "medium" | "low";

/** 高置信阈值（≥直答） */
export const CONFIDENCE_HIGH = 0.72;
/** 中置信阈值（≥附提示；低于则拒答） */
export const CONFIDENCE_MEDIUM = 0.5;

export function classifyConfidence(topScore: number | undefined): ConfidenceTier {
  if (topScore === undefined) return "low";
  if (topScore >= CONFIDENCE_HIGH) return "high";
  if (topScore >= CONFIDENCE_MEDIUM) return "medium";
  return "low";
}

/* ================= 类型 ================= */

export interface Citation {
  documentId: string;
  documentTitle: string;
  heading: string;
  snippet: string;
  score: number;
}

export type TicketDraftKind = "delivery" | "repair" | "complaint" | "other";

export interface TicketDraft {
  kind: TicketDraftKind;
  title: string;
  payload: Record<string, unknown>;
  priority: "normal" | "high";
}

/** biz_query 工具调用契约（server 层执行，dialog 只产出描述不碰业务数据） */
export interface ToolCallRequest {
  tool: "biz.query_orders" | "biz.query_bill" | "biz.query_member";
  params: Record<string, unknown>;
}

/** 五元事件 emitter seam（签名参照 workdata gatewayAppend；生产接安全网关，测试注入内存） */
export interface ServiceEventContext {
  tenantId: string;
  workspaceId: string;
  actorId?: string;
  actorType?: "system" | "agent" | "human";
}
export interface ServiceEventDraft {
  action: string;
  object: { type: string; id?: string };
  after?: unknown;
  basis?: string[];
  links?: string[];
}
export type ServiceEventEmitter = (
  ctx: ServiceEventContext,
  draft: ServiceEventDraft,
) => Promise<{ eventId: string }>;

/** 检索 seam（默认 service-kb searchKB；测试注入内存检索） */
export type SearchFn = (text: string) => Promise<KbSearchHit[]>;

/** 闲聊 LLM seam */
export interface ChatLlm {
  reply(text: string): Promise<string>;
}

export interface HandleMessageInput {
  workspaceId: string;
  tenantId: string;
  cUserId: string;
  channel: string;
  text: string;
  conversationId?: string;
}

export interface HandleMessageResult {
  conversationId: string;
  intent: Intent;
  answer: string;
  confidence: number | null;
  tier?: ConfidenceTier;
  citations: Citation[];
  ticketDraft?: TicketDraft;
  bizTool?: ToolCallRequest;
  latencyMs: number;
  /** 无 LLM 的确定性兜底产出（mock 应答 / 兜底意图） */
  mock?: boolean;
  degraded?: boolean;
}

/* ================= 确定性辅助（纯函数） ================= */

/** service_request → 工单类型映射（通用口径） */
export function ticketKindForServiceRequest(text: string): TicketDraftKind {
  if (/修|坏|漏水|设备|热水|灯|水管|器材/.test(text)) return "repair";
  if (/送|拿|清洁|换|加一|多要|再来/.test(text)) return "delivery";
  return "other";
}

/** biz_query → 工具调用描述（工具契约，由 server 层执行） */
export function bizToolFor(text: string, cUserId: string): ToolCallRequest {
  if (/账单|费用|发票/.test(text)) return { tool: "biz.query_bill", params: { cUserId } };
  if (/积分|会员|余额/.test(text)) return { tool: "biz.query_member", params: { cUserId } };
  return { tool: "biz.query_orders", params: { cUserId } };
}

function toCitation(hit: KbSearchHit): Citation {
  return {
    documentId: hit.documentId,
    documentTitle: hit.documentTitle,
    heading: hit.heading,
    snippet: hit.content.slice(0, 120),
    score: hit.score,
  };
}

/** 组答（强制引用：citations 非空才外发） */
function composeAnswer(tier: ConfidenceTier, top: KbSearchHit): string {
  const cite = `（来源：${top.documentTitle}${top.heading ? ` · ${top.heading}` : ""}）`;
  if (tier === "high") return `${top.content}${cite}`;
  // medium：附「可能不完全准确」提示
  return `${top.content}${cite}\n以上回答可能不完全准确，仅供参考；如需确认可联系客服。`;
}

/* ================= 主入口 ================= */

export interface DialogDeps {
  db: Queryable;
  /** 五元事件 emitter（缺省不写事件；生产接 workdata gatewayAppend 适配器） */
  emit?: ServiceEventEmitter;
  /** 检索（缺省走 service-kb searchKB 关键词兜底） */
  search?: SearchFn;
  intentLlm?: IntentLlm;
  chatLlm?: ChatLlm;
}

export async function handleMessage(
  deps: DialogDeps,
  input: HandleMessageInput,
): Promise<HandleMessageResult> {
  const t0 = Date.now();
  const { db } = deps;

  // ① 会话就绪（无 conversationId 则新建）
  let conversationId = input.conversationId;
  if (conversationId) {
    const cur = await db.query(
      `SELECT id FROM c_conversations WHERE id=$1 AND workspace_id=$2`,
      [conversationId, input.workspaceId],
    );
    if (!cur.rows[0]) throw new Error(`会话 ${conversationId} 不存在`);
  } else {
    conversationId = newId("CCV");
    await db.query(
      `INSERT INTO c_conversations (id, workspace_id, c_user_id, channel) VALUES ($1,$2,$3,$4) RETURNING id`,
      [conversationId, input.workspaceId, input.cUserId, input.channel],
    );
  }

  // ② 落用户消息
  await db.query(
    `INSERT INTO c_messages (workspace_id, conversation_id, role, content, citations) VALUES ($1,$2,'user',$3,'[]')`,
    [input.workspaceId, conversationId, input.text],
  );

  // ③ 意图路由（规则先行 + LLM 兜底）
  const routed = await routeIntent(input.text, deps.intentLlm);
  const intent = routed.intent;

  let answer = "";
  let confidence: number | null = null;
  let tier: ConfidenceTier | undefined;
  let citations: Citation[] = [];
  let ticketDraft: TicketDraft | undefined;
  let bizTool: ToolCallRequest | undefined;
  let mock = false;
  let degraded = routed.degraded;

  if (intent === "kb_qa") {
    const search = deps.search ?? (async (q: string) =>
      (await searchKB(db, q, { workspaceId: input.workspaceId, limit: 5 })).hits);
    const hits = await search(input.text);
    const top = hits[0];
    tier = classifyConfidence(top?.score);
    confidence = top?.score ?? null;
    if (tier !== "low" && top) {
      // 高/中置信：组答强制引用（citations 非空才外发，无据不答）
      citations = hits.map(toCitation);
      answer = composeAnswer(tier, top);
    } else {
      // 低置信：诚实拒答 + 自动建单草稿（不编造答案）
      answer = "抱歉，这个问题我暂时无法准确回答，已为您转人工处理。";
      citations = [];
      ticketDraft = {
        kind: "other",
        title: `知识库未覆盖咨询：${input.text.slice(0, 30)}`,
        payload: { text: input.text, intent, topScore: confidence },
        priority: "normal",
      };
    }
  } else if (intent === "complaint") {
    confidence = routed.source === "rule" ? 1 : 0.6;
    ticketDraft = {
      kind: "complaint",
      title: `顾客投诉：${input.text.slice(0, 30)}`,
      payload: { text: input.text, channel: input.channel },
      priority: "high",
    };
    answer = "非常抱歉给您带来不便。您的反馈已记录，客服主管会尽快与您联系处理。";
  } else if (intent === "service_request") {
    confidence = routed.source === "rule" ? 1 : 0.6;
    const kind = ticketKindForServiceRequest(input.text);
    ticketDraft = {
      kind,
      title: `服务请求：${input.text.slice(0, 30)}`,
      payload: { text: input.text, channel: input.channel },
      priority: "normal",
    };
    answer = "好的，您的需求已收到，我们马上为您安排。";
  } else if (intent === "biz_query") {
    confidence = routed.source === "rule" ? 1 : 0.6;
    bizTool = bizToolFor(input.text, input.cUserId);
    answer = "正在为您查询相关业务数据…";
  } else {
    // chat：LLM 注入式；无 LLM 确定性 mock 兜底（标注 mock，离线可演示）
    if (deps.chatLlm) {
      answer = await deps.chatLlm.reply(input.text);
      confidence = 0.8;
    } else {
      mock = true;
      degraded = true;
      answer = `[mock] 您好，我是智能客服。您说的「${input.text.slice(0, 20)}」我已收到，可继续描述您的问题。`;
      confidence = 0.3;
    }
  }

  const latencyMs = Date.now() - t0;

  // ④ 落助手消息（意图/置信度/引用/耗时留痕）
  await db.query(
    `INSERT INTO c_messages (workspace_id, conversation_id, role, content, intent, confidence, citations, latency_ms)
     VALUES ($1,$2,'assistant',$3,$4,$5,$6,$7)`,
    [input.workspaceId, conversationId, answer, intent, confidence, JSON.stringify(citations), latencyMs],
  );
  await db.query(
    `UPDATE c_conversations SET last_message_at=now() WHERE id=$1 AND workspace_id=$2`,
    [conversationId, input.workspaceId],
  );

  // ⑤ 五元事件（经注入 emitter；缺省跳过——server 层接线时必须注入）
  if (deps.emit) {
    await deps.emit(
      { tenantId: input.tenantId, workspaceId: input.workspaceId, actorId: "service-dialog", actorType: "system" },
      {
        action: "service.message.handle",
        object: { type: "c_conversation", id: conversationId },
        after: {
          cUserId: input.cUserId, channel: input.channel, intent, tier, confidence,
          citations: citations.length, ticketDraft: ticketDraft?.kind, bizTool: bizTool?.tool,
          latencyMs, mock, degraded,
        },
        basis: [`意图来源=${routed.source}`, `置信度=${confidence ?? "n/a"}`],
      },
    );
  }

  const result: HandleMessageResult = {
    conversationId, intent, answer, confidence, citations, latencyMs,
  };
  if (tier) result.tier = tier;
  if (ticketDraft) result.ticketDraft = ticketDraft;
  if (bizTool) result.bizTool = bizTool;
  if (mock) result.mock = true;
  if (degraded) result.degraded = true;
  return result;
}
