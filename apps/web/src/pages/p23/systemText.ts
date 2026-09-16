import { clientChineseText } from "@workloom/ui";

interface FeedbackEnumText {
  code: string;
  label: string;
}

interface MemoryImpactSystemFields {
  agents: Array<{ id: string; name: string }>;
  rules: Array<{ id: string; name: string }>;
  futureTaskPolicy: string;
}

/** 服务端驳回原因的展示名在进入页面 state 前收口；code 只作为受控查找键。 */
export function feedbackReasonLabels(items: FeedbackEnumText[]): Record<string, string> {
  return Object.fromEntries(items.map((item) => [
    item.code,
    clientChineseText(item.label, "其他原因"),
  ]));
}

/** 影响预览只净化系统生成字段；成员名、任务标题与记忆正文由调用方保留原文。 */
export function memoryImpactSystemText<T extends MemoryImpactSystemFields>(
  impact: T,
): Omit<T, keyof MemoryImpactSystemFields> & MemoryImpactSystemFields {
  return {
    ...impact,
    agents: impact.agents.map((agent) => ({
      ...agent,
      name: clientChineseText(agent.name, "数字员工"),
    })),
    rules: impact.rules.map((rule) => ({
      ...rule,
      name: clientChineseText(rule.name, "关联围栏"),
    })),
    futureTaskPolicy: clientChineseText(
      impact.futureTaskPolicy,
      "后续任务将按当前规则重新评估。",
    ),
  };
}
