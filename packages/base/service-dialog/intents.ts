/**
 * service-dialog · 意图路由（routeIntent）
 *
 * 规则关键词先行（确定性、零成本、可解释）；规则未命中 → LLM 兜底（注入式）；
 * 两者皆无 → 保守落 'chat'（标注 degraded，绝不静默编造业务意图）。
 *
 * M8 规则口径（server 层 dialog 复用同一张表 ruleBasedIntent，禁止两份规则漂移）：
 *  优先级 complaint > biz_query > service_request > kb_qa；
 *  疑问句（含「几点/时间/吗/呢/怎么/如何/什么时候」）优先 kb_qa 不建单
 *   （如「送站巴士几点发」——含服务词「送」但表疑问 → kb_qa）；
 *  明示报修词（修/修一下/坏了/故障/维修）直连 service_request（如「空调坏了帮我修一下」）。
 * 底座规则表保持行业中性；行业专属词由各行业域层
 * 经 IntentRuleExtension 注入（apps server 层行业示例域即如此装配），不进底座。
 */

export type Intent = "chat" | "kb_qa" | "biz_query" | "service_request" | "complaint";

export const INTENTS: readonly Intent[] = ["chat", "kb_qa", "biz_query", "service_request", "complaint"];

/** LLM 意图分类 seam（注入式；无实现时规则未命中即落 chat + degraded） */
export interface IntentLlm {
  classify(text: string): Promise<Intent>;
}

/** 疑问句标记：含其一即视为「问问题」而非「下指令」（优先级高于一般服务词、低于明示报修词） */
const QUESTION_MARKERS = ["几点", "时间", "什么时候", "吗", "呢", "怎么", "如何", "多久", "多长时间", "多少", "多少钱", "哪里", "哪儿", "收费", "免费"];

/** 明示报修/故障词：直连 service_request（疑问句也不拦——「空调怎么修」仍需上门） */
const REPAIR_KEYWORDS = ["维修", "修一下", "坏了", "故障", "报修", "漏水", "不制冷", "不制热"];

/** 规则表（complaint > biz_query > service_request > kb_qa；service_request 只收「指令型」服务词；行业中性） */
const RULES = {
  complaint: ["投诉", "差评", "不满意", "太吵", "卫生差", "态度差", "举报", "维权", "退款理由"],
  // 价格/会员类仅在有明确「我的账户/预订」语境时才走业务查询，
  // 否则「面膜多少钱」「会员吃早餐要钱吗」应走知识库（M8 评测校准：R04/A16/A20）
  biz_query: ["我的订单", "订单", "账单", "积分", "余额", "发票记录", "押金", "预订", "我的会员", "会员卡", "我的积分", "我的余额"],
  service_request: ["送", "拿", "加一", "打扫", "开发票", "多要", "再来一份", "修"],
  kb_qa: ["几点", "时间", "政策", "wifi", "WiFi", "WIFI", "怎么", "如何", "可以带", "收费吗", "免费吗"],
} as const;

/** 行业扩展词表（由行业域层注入，与底座规则表取并集；底座不含任何行业词） */
export interface IntentRuleExtension {
  complaint?: readonly string[];
  biz_query?: readonly string[];
  service_request?: readonly string[];
  kb_qa?: readonly string[];
}

function hit(text: string, keywords: readonly string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

/** 纯规则意图（未命中返回 null；M8 唯一事实源，server dialog 直接复用；行业词经 ext 注入取并集） */
export function ruleBasedIntent(text: string, ext?: IntentRuleExtension): Intent | null {
  const table = (key: keyof IntentRuleExtension): readonly string[] => [...RULES[key], ...(ext?.[key] ?? [])];
  if (hit(text, table("complaint"))) return "complaint";
  if (hit(text, table("biz_query"))) return "biz_query";
  // 疑问句优先 kb_qa：「送站巴士几点发」「报修多久能来人」类问句不建单（含价格/时效疑问词）
  if (hit(text, QUESTION_MARKERS)) return "kb_qa";
  // 明示报修词：直连建单（「修/修一下/坏了/故障」指令型，疑问句已在上方分流）
  if (hit(text, REPAIR_KEYWORDS)) return "service_request";
  if (hit(text, table("service_request"))) return "service_request";
  if (hit(text, table("kb_qa"))) return "kb_qa";
  return null;
}

export interface IntentResult {
  intent: Intent;
  /** rule = 关键词命中；llm = 模型兜底；fallback = 无 LLM 保守落 chat（degraded） */
  source: "rule" | "llm" | "fallback";
  degraded: boolean;
}

export async function routeIntent(text: string, llm?: IntentLlm, ext?: IntentRuleExtension): Promise<IntentResult> {
  const ruled = ruleBasedIntent(text, ext);
  if (ruled) return { intent: ruled, source: "rule", degraded: false };
  if (llm) {
    const intent = await llm.classify(text);
    if (INTENTS.includes(intent)) return { intent, source: "llm", degraded: false };
  }
  return { intent: "chat", source: "fallback", degraded: !llm };
}
