/**
 * service-dialog · 意图路由（routeIntent）
 *
 * 规则关键词先行（确定性、零成本、可解释）；规则未命中 → LLM 兜底（注入式）；
 * 两者皆无 → 保守落 'chat'（标注 degraded，绝不静默编造业务意图）。
 *
 * M8 规则口径（server 层 dialog 复用同一张表 ruleBasedIntent，禁止两份规则漂移）：
 *  优先级 complaint > biz_query > service_request > kb_qa；
 *  疑问句（含「几点/时间/吗/呢/怎么/如何/什么时候」）优先 kb_qa 不建单
 *   （如「配送车辆几点发」——含服务词「送」但表疑问 → kb_qa）；
 *  明示报修词（修/修一下/坏了/故障/维修）直连 service_request（如「设备坏了帮我修一下」）。
 */

export type Intent = "chat" | "kb_qa" | "biz_query" | "service_request" | "complaint";

export const INTENTS: readonly Intent[] = ["chat", "kb_qa", "biz_query", "service_request", "complaint"];

/** LLM 意图分类 seam（注入式；无实现时规则未命中即落 chat + degraded） */
export interface IntentLlm {
  classify(text: string): Promise<Intent>;
}

/** 疑问句标记：含其一即视为「问问题」而非「下指令」（优先级高于一般服务词、低于明示报修词） */
const QUESTION_MARKERS = ["几点", "时间", "什么时候", "吗", "呢", "怎么", "如何", "多久", "多长时间", "多少", "多少钱", "哪里", "哪儿", "收费", "免费"];

/** 明示报修/故障词：直连 service_request（疑问句也不拦——「设备怎么修」仍需上门） */
const REPAIR_KEYWORDS = ["维修", "修一下", "坏了", "故障", "报修", "漏水", "不制冷", "不运转"];

/** 规则表（complaint > biz_query > service_request > kb_qa；service_request 只收「指令型」服务词） */
const RULES = {
  complaint: ["投诉", "差评", "不满意", "太吵", "卫生差", "态度差", "举报", "维权", "退款理由"],
  // 价格/会员类仅在有明确「我的账户/我的订单」语境时才走业务查询，
  // 否则「面膜多少钱」「会员优惠要钱吗」应走知识库（M8 评测校准：R04/A16/A20）
  biz_query: ["我的订单", "订单", "费用", "账单", "积分", "余额", "发票记录", "售价", "我的会员", "会员卡", "我的积分", "我的余额"],
  service_request: ["送", "拿", "加一", "清洁", "更换", "开发票", "续费", "多要", "再来一份", "修"],
  kb_qa: ["几点", "时间", "政策", "营业", "会员", "优惠", "怎么", "如何", "可以带", "收费吗", "免费吗"],
} as const;

function hit(text: string, keywords: readonly string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

/** 纯规则意图（未命中返回 null；M8 唯一事实源，server dialog 直接复用） */
export function ruleBasedIntent(text: string): Intent | null {
  if (hit(text, RULES.complaint)) return "complaint";
  if (hit(text, RULES.biz_query)) return "biz_query";
  // 疑问句优先 kb_qa：「配送车辆几点发」「报修多久能来人」类问句不建单（含价格/时效疑问词）
  if (hit(text, QUESTION_MARKERS)) return "kb_qa";
  // 明示报修词：直连建单（「修/修一下/坏了/故障」指令型，疑问句已在上方分流）
  if (hit(text, REPAIR_KEYWORDS)) return "service_request";
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

export async function routeIntent(text: string, llm?: IntentLlm): Promise<IntentResult> {
  const ruled = ruleBasedIntent(text);
  if (ruled) return { intent: ruled, source: "rule", degraded: false };
  if (llm) {
    const intent = await llm.classify(text);
    if (INTENTS.includes(intent)) return { intent, source: "llm", degraded: false };
  }
  return { intent: "chat", source: "fallback", degraded: !llm };
}
