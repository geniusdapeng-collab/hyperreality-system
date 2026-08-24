/**
 * 门 → 主理员工映射（P4 审批拟人化事实源；融合设计 §3 门矩阵 × bundles/ai-video/presets）
 *  - G6 提示词/连贯审核 → 连贯审查官（continuity-reviewer）
 *  - G8 渲染烧额度门 → 渲染师小燃（render-operator）
 *  - G9 公网发布门 → 发布专员（publish-operator）
 *  - G10 评论分流门 → 评论区运营（comment-operator）
 * 命中不了门时按动作前缀兜底；再兜底=事件发起方 who.id 原样展示
 */
import { actionText } from "../../lib/display";

export interface GateAgent {
  gate: string;
  presetKey: string;
  /** 请示语气显示名（含昵称口径） */
  name: string;
}

export const GATE_AGENT_MAP: Record<string, GateAgent> = {
  G6: { gate: "G6", presetKey: "continuity-reviewer", name: "连贯审查官" },
  G8: { gate: "G8", presetKey: "render-operator", name: "渲染师小燃" },
  G9: { gate: "G9", presetKey: "publish-operator", name: "发布专员" },
  G10: { gate: "G10", presetKey: "comment-operator", name: "评论区运营" },
};

/** 动作前缀 → 门（rule_impact 缺失时兜底；与 videoRouter 动作码同口径） */
const ACTION_GATE: Array<[prefix: string, gate: string]> = [
  ["render.submit", "G8"],
  ["render.", "G8"],
  ["publish.", "G9"],
  ["comment.reply", "G10"],
  ["comment.", "G10"],
  ["cms.approve", "G8"],
];

/** 审批对象结构（最小鸭子类型，P4 ApprovalRow 兼容） */
export interface ApprovalLike {
  event?: {
    who: { id: string };
    decision: { action: string };
    rule_impact?: Array<{ rule_id: string }>;
  };
}

/** 解析审批的主理员工（门 > 动作前缀 > 发起方兜底） */
export function agentOfApproval(a: ApprovalLike): GateAgent & { fallback?: boolean } {
  const hit = a.event?.rule_impact?.map((r) => r.rule_id).find((id) => GATE_AGENT_MAP[id]);
  if (hit) return GATE_AGENT_MAP[hit]!;
  const action = a.event?.decision.action ?? "";
  const byAction = ACTION_GATE.find(([p]) => action.startsWith(p));
  if (byAction) return GATE_AGENT_MAP[byAction[1]]!;
  return { gate: "", presetKey: "", name: a.event?.who.id ?? "值班 Agent", fallback: true };
}

/** 动作码 → 请示语气动作短语（§9.1 副官语气：动作码不直接上屏） */
const ACTION_LABEL: Record<string, string> = {
  "render.submit": "提交渲染任务",
  "publish.task.create": "创建发布任务",
  "publish.execute": "执行公网发布",
  "comment.reply": "回复评论",
  "cms.approveScript": "放行渲染脚本版本",
  "script.update": "修订脚本",
  "fence.rule.propose": "提请围栏新规",
};

export function actionLabel(action: string): string {
  // 已收编到展示字典层（lib/display）：先查本地表，再查字典，兜底人性化，不裸奔原始码
  return ACTION_LABEL[action] ?? actionText(action);
}
