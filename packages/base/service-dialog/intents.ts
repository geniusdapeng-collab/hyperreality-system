/**
 * service-dialog · 意图路由（routeIntent）
 *
 * 规则关键词先行（确定性、零成本、可解释）；规则未命中 → LLM 兜底（注入式）；
 * 两者皆无 → 保守落 'chat'（标注 degraded，绝不静默编造业务意图）。
 */

export type Intent = "chat" | "kb_qa" | "biz_query" | "service_request" | "complaint";

export const INTENTS: readonly Intent[] = ["chat", "kb_qa", "biz_query", "service_request", "complaint"];

/** LLM 意图分类 seam（注入式；无实现时规则未命中即落 chat + degraded） */
export interface IntentLlm {
  classify(text: string): Promise<Intent>;
}

/** 规则表（顺序即优先级：投诉 > 服务请求 > 业务查询 > 知识问答） */
const RULES: Array<{ intent: Intent; keywords: string[] }> = [
  {
    intent: "complaint",
    keywords: ["投诉", "差评", "不满意", "太吵", "卫生差", "态度差", "举报", "维权", "退款理由"],
  },
  {
    intent: "service_request",
    keywords: ["送", "拿", "加一", "维修", "修一下", "坏了", "打扫", "换床单", "开发票", "续住", "多要", "再来一份"],
  },
  {
    intent: "biz_query",
    keywords: ["我的订单", "订单", "房费", "账单", "积分", "余额", "会员", "发票记录", "押金"],
  },
  {
    intent: "kb_qa",
    keywords: ["几点", "时间", "政策", "早餐", "wifi", "WiFi", "WIFI", "停车", "健身房", "泳池", "退房", "入住", "怎么", "如何", "可以带", "收费吗", "免费吗"],
  },
];

export interface IntentResult {
  intent: Intent;
  /** rule = 关键词命中；llm = 模型兜底；fallback = 无 LLM 保守落 chat（degraded） */
  source: "rule" | "llm" | "fallback";
  degraded: boolean;
}

export async function routeIntent(text: string, llm?: IntentLlm): Promise<IntentResult> {
  for (const rule of RULES) {
    if (rule.keywords.some((k) => text.includes(k))) {
      return { intent: rule.intent, source: "rule", degraded: false };
    }
  }
  if (llm) {
    const intent = await llm.classify(text);
    if (INTENTS.includes(intent)) return { intent, source: "llm", degraded: false };
  }
  return { intent: "chat", source: "fallback", degraded: !llm };
}
