/**
 * service · 对话（接口对齐 packages/base/service-dialog 签名；表结构为底座迁移版）
 * 意图流水线（确定性规则优先，LLM 经 model-router 注入仅用于措辞生成，缺 key 全链路兜底 mock:true）：
 *   complaint（投诉）→ biz_query（订单/会员/房价/工单进度）→ kb_qa（KB 命中 / 诚实拒答）
 *   → service_request（报修服务类，产 ticketDraft）→ chat（兜底）
 * 命中 KB 必带 citations（文档/小节/原文），无据不答（诚实拒答，置信度低）。
 * 全量消息落 c_messages（stats.overview 聚合数据源；该表无 mock 列，mock 仅在响应标注）。
 */
import { ensureServiceSchema } from "./store.js";
import { searchKB, type KbHit } from "./kb.js";
import { llmCall } from "./llm.js";
import { serviceTx, svcQuery } from "./events.js";
import type { Channel } from "./channels.js";

export type Intent = "chat" | "kb_qa" | "biz_query" | "service_request" | "complaint";
export type BizToolName = "query_order" | "query_member" | "query_catalog" | "query_ticket";

export interface DialogResult {
  conversationId: string;
  intent: Intent;
  answer: string;
  confidence: number;
  citations: Array<{ documentTitle: string; heading: string; content: string }>;
  ticketDraft?: { kind: string; title: string; payload: Record<string, unknown> };
  toolCall?: { tool: BizToolName; params: Record<string, unknown> };
  latencyMs: number;
  mock?: boolean;
}

let seq = 0;
function newId(prefix: string): string {
  seq = (seq + 1) % 46636;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36).padStart(3, "0")}${Math.random().toString(36).slice(2, 6)}`;
}

const RE = {
  complaint: /投诉|差评|不满意|举报/,
  order: /订单|预订|订房记录|入住记录/,
  member: /会员|积分|等级|权益/,
  catalog: /房价|房型|多少钱一晚|价格表/,
  ticketStatus: /工单.*(进度|状态|怎么样)|进度.*工单/,
  service: /报修|维修|坏了|故障|打扫|加(一?条)?(毛巾|被子|枕头)|送(水|餐|东西)|开发票|发票/,
};

function classify(text: string): { intent: Intent; tool?: BizToolName } {
  if (RE.complaint.test(text)) return { intent: "complaint" };
  if (RE.order.test(text)) return { intent: "biz_query", tool: "query_order" };
  if (RE.member.test(text)) return { intent: "biz_query", tool: "query_member" };
  if (RE.catalog.test(text)) return { intent: "biz_query", tool: "query_catalog" };
  if (RE.ticketStatus.test(text)) return { intent: "biz_query", tool: "query_ticket" };
  return { intent: "kb_qa" }; // 默认先查知识库（命中与否分流 service_request / chat）
}

async function ensureConversation(input: {
  workspaceId: string; cUserId: string; channel: Channel; conversationId?: string;
}): Promise<string> {
  if (input.conversationId) {
    const rows = await svcQuery(
      input.workspaceId,
      `SELECT id FROM c_conversations WHERE workspace_id=$1 AND id=$2 AND c_user_id=$3`,
      [input.workspaceId, input.conversationId, input.cUserId],
    );
    if (rows[0]) return input.conversationId;
  }
  const id = newId("cvn");
  await svcQuery(
    input.workspaceId,
    `INSERT INTO c_conversations (id, workspace_id, c_user_id, channel) VALUES ($1,$2,$3,$4) RETURNING id`,
    [id, input.workspaceId, input.cUserId, input.channel],
  );
  return id;
}

async function logMessage(row: {
  workspaceId: string; conversationId: string; role: "user" | "assistant";
  content: string; intent?: Intent; confidence?: number; citations?: unknown[]; latencyMs?: number;
}): Promise<void> {
  await serviceTx(row.workspaceId, async (client) => {
    await client.query(
      `INSERT INTO c_messages (workspace_id, conversation_id, role, content, intent, confidence, citations, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.workspaceId, row.conversationId, row.role, row.content,
       row.intent ?? null, row.confidence ?? null, JSON.stringify(row.citations ?? []), row.latencyMs ?? null],
    );
    await client.query(
      `UPDATE c_conversations SET last_message_at=now() WHERE workspace_id=$1 AND id=$2`,
      [row.workspaceId, row.conversationId],
    );
  });
}

function citationsOf(hits: KbHit[]): Array<{ documentTitle: string; heading: string; content: string }> {
  return hits.slice(0, 3).map((h) => ({ documentTitle: h.documentTitle, heading: h.heading, content: h.content.slice(0, 300) }));
}

export async function handleMessage(input: {
  workspaceId: string; cUserId: string; channel: Channel; text: string; conversationId?: string;
}): Promise<DialogResult> {
  await ensureServiceSchema();
  const t0 = Date.now();
  const llm = llmCall();
  const mock = !llm;
  const conversationId = await ensureConversation(input);
  await logMessage({ workspaceId: input.workspaceId, conversationId, role: "user", content: input.text });

  const cls = classify(input.text);
  let result: Omit<DialogResult, "conversationId" | "latencyMs" | "mock">;

  if (cls.intent === "biz_query") {
    const tool = cls.tool!;
    const answers: Record<BizToolName, string> = {
      query_order: "为您查询到以下订单：",
      query_member: "为您查询到会员信息：",
      query_catalog: "为您查询到房型价格：",
      query_ticket: "为您查询到工单进度：",
    };
    result = { intent: "biz_query", answer: answers[tool], confidence: 0.95, citations: [], toolCall: { tool, params: {} } };
  } else if (cls.intent === "complaint") {
    result = {
      intent: "complaint",
      answer: "非常抱歉给您带来不便。我可以立即为您生成投诉工单，客服部将优先跟进。请确认是否提交？",
      confidence: 0.9,
      citations: [],
      ticketDraft: { kind: "complaint", title: input.text.slice(0, 40), payload: { text: input.text } },
    };
  } else {
    // kb_qa 优先：命中 → 有据回答；未命中再看是否服务请求，否则闲聊/诚实拒答
    const hits = await searchKB({ workspaceId: input.workspaceId, query: input.text, limit: 5 });
    if (hits.length > 0) {
      const top = hits[0]!;
      let answer = `${top.heading ? `【${top.heading}】` : ""}${top.content.replace(/^#\s.*$/m, "").trim().slice(0, 300)}`;
      if (llm) {
        try {
          answer = await llm(
            `你是酒店前台客服。仅依据以下资料回答客人问题，不要编造资料之外的信息，回答控制在 80 字内。\n客人：${input.text}\n资料：${top.content.slice(0, 800)}`,
          );
        } catch { /* 生成失败 → 用确定性拼装答案 */ }
      }
      result = { intent: "kb_qa", answer, confidence: Math.min(0.95, 0.6 + top.score * 0.05), citations: citationsOf(hits) };
    } else if (RE.service.test(input.text)) {
      result = {
        intent: "service_request",
        answer: "好的，我可以为您生成服务工单，客房部会尽快处理。请确认是否提交？",
        confidence: 0.85,
        citations: [],
        ticketDraft: { kind: "service_request", title: input.text.slice(0, 40), payload: { text: input.text } },
      };
    } else if (llm) {
      try {
        const answer = await llm(`你是酒店前台客服，客人说：「${input.text}」。知识库没有相关资料，请礼貌说明无法确认并引导其描述具体需求，60 字内。`);
        result = { intent: "chat", answer, confidence: 0.4, citations: [] };
      } catch {
        result = { intent: "chat", answer: "抱歉，这个问题我暂时无法确认。您可以换个说法，或告诉我具体需求（如报修、查订单），我来为您处理。", confidence: 0.2, citations: [] };
      }
    } else {
      result = {
        intent: "chat",
        answer: "抱歉，知识库中暂时没有相关资料，我不敢随意作答。您可以换个说法，或告诉我具体需求（如报修、查订单、投诉），我来为您处理。",
        confidence: 0.2,
        citations: [],
      };
    }
  }

  const latencyMs = Date.now() - t0;
  await logMessage({
    workspaceId: input.workspaceId, conversationId, role: "assistant",
    content: result.answer, intent: result.intent, confidence: result.confidence,
    citations: result.citations, latencyMs,
  });
  return { conversationId, ...result, latencyMs, mock };
}
