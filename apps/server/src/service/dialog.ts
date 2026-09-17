/**
 * service · 对话（接口对齐 packages/base/service-dialog 签名；表结构为底座迁移版）
 * 意图流水线（M8：与 packages/base/service-dialog/intents.ts 同一张规则表 ruleBasedIntent；
 *   底座规则表行业中性，本酒店示例域的行业词经 HOTEL_INTENT_EXT 注入取并集）：
 *   complaint（投诉）> biz_query（订单/会员/房价/工单进度）> service_request（报修服务类，产 ticketDraft）
 *   > kb_qa（KB 检索三档分流）> chat（规则未命中兜底）
 *   疑问句（几点/时间/吗/呢/怎么/如何）优先 kb_qa 不建单；「修/修一下/坏了」直连 service_request。
 * 置信度三档（H5：检索 score 归一化 0..1，复用 base scoreChunkFallback）：
 *   ≥0.72 直接作答（带引用）；0.45–0.72 作答但附「可能不完全准确」提示；<0.45 诚实拒答 + ticketDraft。
 * 命中 KB 必带 citations，无据不答（诚实拒答）。
 * 全量消息落 c_messages（stats.overview 聚合数据源；mock 仅在响应标注）。
 */
import { ruleBasedIntent, type IntentRuleExtension } from "@workloom/base/service-dialog";
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

/* ================= 意图（M8：复用 base 同一张规则表 + 本域行业词扩展） ================= */

/** 酒店示例域扩展词表（M8 评测校准口径；底座规则表保持行业中性，行业词由本域注入） */
const HOTEL_INTENT_EXT: IntentRuleExtension = {
  biz_query: ["房费", "房价", "房型", "大床房", "双床房", "套房", "标间", "订房"],
  service_request: ["换床单", "续住"],
  kb_qa: ["早餐", "停车", "健身房", "泳池", "退房", "入住"],
};

/** 工单进度查询（server 侧特有 biz_query 子类，先于规则表判定） */
const RE_TICKET_STATUS = /工单.*(进度|状态|怎么样)|进度.*工单/;
const RE_ORDER = /订单|预订|订房|入住记录|房费|账单/;
const RE_MEMBER = /会员|积分|等级|权益|余额/;
const RE_CATALOG = /房价|房型|多少钱|价格/;

/**
 * 客房价格查询直连（server 侧目录查询子类，先于规则表判定）：判定锚是**房型名词**——
 * 「面膜多少钱」类通用询价无房型词仍走 kb_qa（M8 口径 R04/A16/A19/A24 不破坏，D17/D18 不受影响）。
 */
const RE_ROOM_RATE = /房价|房型|大床房|双床房|单人房|标准间|套房|海景房|钟点房/;

export function classify(text: string): { intent: Intent; tool?: BizToolName } {
  if (RE_TICKET_STATUS.test(text)) return { intent: "biz_query", tool: "query_ticket" };
  if (RE_ROOM_RATE.test(text)) return { intent: "biz_query", tool: "query_catalog" };
  const ruled = ruleBasedIntent(text, HOTEL_INTENT_EXT);
  if (ruled === "complaint") return { intent: "complaint" };
  if (ruled === "service_request") return { intent: "service_request" };
  if (ruled === "biz_query") {
    if (RE_MEMBER.test(text)) return { intent: "biz_query", tool: "query_member" };
    if (RE_CATALOG.test(text)) return { intent: "biz_query", tool: "query_catalog" };
    return { intent: "biz_query", tool: "query_order" };
  }
  if (ruled === "kb_qa") return { intent: "kb_qa" };
  return { intent: "kb_qa" }; // 规则未命中：默认先查知识库（低置信走诚实拒答三档）
}

/** service_request 文本 → 工单类型（修/坏类 → repair；送/拿/打扫类 → delivery；其余 other） */
export function ticketKindOf(text: string): "repair" | "delivery" | "other" {
  if (/维修|修|坏|故障|漏水|不制冷|不制热|空调|热水|马桶/.test(text)) return "repair";
  if (/送|拿|打扫|换床单|加一|多要|再来/.test(text)) return "delivery";
  return "other";
}

/* ================= 置信度三档（H5） ================= */

export type ConfidenceTier = "high" | "medium" | "low";
export const CONFIDENCE_HIGH = 0.72;
export const CONFIDENCE_MEDIUM = 0.45;

/** score 归一化（0..1）后分档：≥0.72 高 / 0.45–0.72 中 / <0.45 低 */
export function tierOfScore(score: number | undefined): ConfidenceTier {
  if (score === undefined) return "low";
  const s = Math.max(0, Math.min(1, score));
  if (s >= CONFIDENCE_HIGH) return "high";
  if (s >= CONFIDENCE_MEDIUM) return "medium";
  return "low";
}

export const MEDIUM_HINT = "以上回答可能不完全准确，仅供参考；如需确认可联系前台。";
export const LOW_REFUSAL = "抱歉，这个问题我暂时无法准确回答，不敢随意编造。已为您准备好工单草稿，确认后转人工跟进；您也可以换个说法再问我。";

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
  } else if (cls.intent === "service_request") {
    const kind = ticketKindOf(input.text);
    result = {
      intent: "service_request",
      answer: "好的，我可以为您生成服务工单，相关部门会尽快处理。请确认是否提交？",
      confidence: 0.85,
      citations: [],
      ticketDraft: { kind, title: input.text.slice(0, 40), payload: { text: input.text } },
    };
  } else {
    // kb_qa：检索三档分流（H5）——score 已归一化 0..1
    const hits = await searchKB({ workspaceId: input.workspaceId, query: input.text, limit: 5 });
    const top = hits[0];
    const tier = tierOfScore(top?.score);
    if (tier === "low") {
      // 诚实拒答 + 工单草稿（不编造；L1 低置信留痕）
      result = {
        intent: "kb_qa",
        answer: LOW_REFUSAL,
        confidence: top?.score ?? 0,
        citations: [],
        ticketDraft: {
          kind: "other",
          title: `知识库未覆盖咨询：${input.text.slice(0, 30)}`,
          payload: { text: input.text, intent: "kb_qa", topScore: top?.score ?? null },
        },
      };
    } else if (top) {
      // top-2 合并：次命中与首命中共享非弱词 token 且自身 ≥0.45 时并入（跨块事实，如「早餐多少钱」）
      const WEAK = new Set(["时间", "免费", "收费", "可以", "服务", "房间", "酒店", "半天", "一份", "一瓶", "东西", "地方", "怎么", "如何", "一下", "价格", "多少钱", "客房", "住客", "客人", "前台", "工作", "两张", "一张", "几位", "一些"]);
      const norm = (t: string) => t.toLowerCase().replace(/(?<=[a-z0-9])-(?=[a-z0-9])/g, "");
      const topHay = norm(`${top.heading}\n${top.content}`);
      const topTokens = new Set(topHay.match(/[a-z0-9]+|[\u4e00-\u9fff]{2}/g) ?? []);
      const topDistinctive = new Set([...topTokens].filter((t) => !WEAK.has(t)));
      const second = hits[1];
      const mergeSecond = second && second.score >= CONFIDENCE_MEDIUM && (() => {
        const sHay = norm(`${second.heading}\n${second.content}`);
        const sTokens = (sHay.match(/[a-z0-9]+|[\u4e00-\u9fff]{2}/g) ?? []).filter((t) => !WEAK.has(t));
        return sTokens.some((t) => topDistinctive.has(t));
      })();
      const blocks = [top, ...(mergeSecond ? [second] : [])];
      let answer = blocks
        .map((h) => `${h.heading ? `【${h.heading}】` : ""}${h.content.replace(/^#\s.*$/m, "").trim().slice(0, 300)}`)
        .join("\n");
      if (llm) {
        try {
          answer = await llm(
            `你是酒店前台客服。仅依据以下资料回答客人问题，不要编造资料之外的信息，回答控制在 80 字内。\n客人：${input.text}\n资料：${blocks.map((h) => h.content.slice(0, 400)).join("\n---\n")}`,
          );
        } catch (err) {
          console.warn("[service-c] kb_qa 组答 LLM 失败，使用确定性拼装答案：", err instanceof Error ? err.message : err);
        }
      }
      if (tier === "medium") answer = `${answer}\n${MEDIUM_HINT}`;
      result = { intent: "kb_qa", answer, confidence: Math.max(0, Math.min(1, top.score)), citations: citationsOf(hits) };
    } else {
      result = {
        intent: "kb_qa",
        answer: LOW_REFUSAL,
        confidence: 0,
        citations: [],
        ticketDraft: {
          kind: "other",
          title: `知识库未覆盖咨询：${input.text.slice(0, 30)}`,
          payload: { text: input.text, intent: "kb_qa", topScore: null },
        },
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
