/**
 * service-dialog · 意图路由（routeIntent）
 *
 * 规则关键词先行（确定性、零成本、可解释）；规则未命中 → LLM 兜底（注入式）；
 * 两者皆无 → 保守落 'chat'（标注 degraded，绝不静默编造业务意图）。
 *
 * 基座只识别投诉、明确人工协助和疑问句等跨行业信号。具体业务对象与履约
 * 动作必须由活动 Bundle 注入 IntentRuleExtension，禁止沉淀为基座默认规则。
 */

export type Intent = "chat" | "kb_qa" | "biz_query" | "service_request" | "complaint";

export const INTENTS: readonly Intent[] = ["chat", "kb_qa", "biz_query", "service_request", "complaint"];

/** LLM 意图分类 seam（注入式；无实现时规则未命中即落 chat + degraded） */
export interface IntentLlm {
  classify(text: string): Promise<Intent>;
}

/** 活动 Bundle 可注入的纯意图分类 seam；不得产生副作用或直接读取业务数据。 */
export interface IntentRuleExtension {
  readonly id: string;
  classify(text: string): Exclude<Intent, "chat"> | null;
}

/** 疑问句标记：含其一即视为「问问题」而非「下指令」（低于扩展的明确分类）。 */
const QUESTION_MARKERS = ["几点", "时间", "什么时候", "吗", "呢", "怎么", "如何", "多久", "多长时间", "多少", "多少钱", "哪里", "哪儿", "收费", "免费"];

/** 通用规则表不含任何行业对象、业务账户或行业履约动作。 */
const RULES = {
  complaint: ["投诉", "不满意", "举报", "维权", "正式反馈问题"],
  service_request: ["请处理", "帮我处理", "需要协助", "需要人工", "转人工", "请安排", "帮我安排"],
  kb_qa: ["几点", "时间", "政策", "营业", "怎么", "如何", "使用说明", "办理"],
} as const;

function hit(text: string, keywords: readonly string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

/** 纯规则意图（未命中返回 null；M8 唯一事实源，server dialog 直接复用） */
export function ruleBasedIntent(
  text: string,
  extensions: readonly IntentRuleExtension[] = [],
): Intent | null {
  if (hit(text, RULES.complaint)) return "complaint";
  const extended = extensions
    .map((extension) => extension.classify(text))
    .filter((intent): intent is Exclude<Intent, "chat"> => intent !== null);
  if (extended.includes("complaint")) return "complaint";
  if (extended.includes("biz_query")) return "biz_query";
  // 疑问句优先通用知识问答；明确行业写操作须由扩展先分类为 service_request。
  if (hit(text, QUESTION_MARKERS)) return "kb_qa";
  if (extended.includes("service_request")) return "service_request";
  if (extended.includes("kb_qa")) return "kb_qa";
  if (hit(text, RULES.service_request)) return "service_request";
  if (hit(text, RULES.kb_qa)) return "kb_qa";
  return null;
}

export interface IntentResult {
  intent: Intent;
  /** rule = 关键词命中；llm = 模型兜底；fallback = 无 LLM 保守落 chat（degraded） */
  source: "rule" | "llm" | "fallback";
  degraded: boolean;
}

export async function routeIntent(
  text: string,
  llm?: IntentLlm,
  extensions: readonly IntentRuleExtension[] = [],
): Promise<IntentResult> {
  const ruled = ruleBasedIntent(text, extensions);
  if (ruled) return { intent: ruled, source: "rule", degraded: false };
  if (llm) {
    const intent = await llm.classify(text);
    if (INTENTS.includes(intent)) return { intent, source: "llm", degraded: false };
  }
  return { intent: "chat", source: "fallback", degraded: !llm };
}
