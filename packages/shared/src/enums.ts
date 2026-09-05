/**
 * 全局枚举 —— 与 PRD V2.5 编号一一对应；行业差异枚举（对象/阶段）不在这里，
 * 由各行业 bundles/<行业>/schemas 提供（总纲 D2 / PRD §2.2 槽②）。
 */

/** 会话三态（F3.3） */
export const THREAD_MODES = ["ask", "agent", "quest"] as const;
export type ThreadMode = (typeof THREAD_MODES)[number];

/** 任务线程状态机（F3.4）：queued→running→pending_review→completed/failed/paused */
export const THREAD_STATUSES = [
  "queued",
  "running",
  "pending_review",
  "completed",
  "failed",
  "paused",
] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

/** 围栏三级（F2.1）：auto 放行 / review 挂起必审 / block 熔断 */
export const FENCE_LEVELS = ["auto", "review", "block"] as const;
export type FenceLevel = (typeof FENCE_LEVELS)[number];

/** 围栏判定结果（附录 E rule_impact.result） */
export const RULE_RESULTS = ["pass", "review", "blocked", "conflict"] as const;
export type RuleResult = (typeof RULE_RESULTS)[number];

/** 围栏规则包生命周期（F2.4） */
export const FENCE_STATUSES = ["draft", "pending_approval", "active", "rolled_back"] as const;
export type FenceStatus = (typeof FENCE_STATUSES)[number];

/** 夜班状态机（F4.8） */
export const NIGHT_STATUSES = [
  "unconfigured",
  "ready",
  "running",
  "paused",
  "package_generated",
] as const;
export type NightStatus = (typeof NIGHT_STATUSES)[number];

/** 审批状态（F5.x；expired 见 F5.7） */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "edited",
  "rejected",
  "expired",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** 审批三手势（M5/F1.7）：权重 1/2/3 */
export const GESTURES = ["approve", "edit", "reject"] as const;
export type Gesture = (typeof GESTURES)[number];
export const GESTURE_WEIGHT: Record<Gesture, number> = { approve: 1, edit: 2, reject: 3 };

/** 人类成员角色（F5.6 三端权限一致） */
export const MEMBER_ROLES = ["owner", "manager", "readonly", "group", "channel"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** 版本能力矩阵（F7.2）：社区版 / Pro / Teams / VPC */
export const PLAN_TIERS = ["community", "pro", "teams", "vpc"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

/** 技能三级体系（F8.1） */
export const SKILL_LEVELS = ["official", "team", "industry"] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];

/** 巡检异常分级（F9.2）：高/中/低 ↔ P0/P1/P2 */
export const ALERT_LEVELS = ["p0", "p1", "p2"] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

/** 记忆作用域三级（F1.4） */
export const MEMORY_SCOPES = ["workspace", "agent", "run"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** 记忆种类：偏好/模式/SOP/禁用承诺（F1.4/L1.6） */
export const MEMORY_KINDS = ["preference", "pattern", "sop", "forbidden"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 触发器双入口（F4.7） */
export const TRIGGER_KINDS = ["cron", "event"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** 内置 7 个 Agent 职业（游戏规则手册 §3.2；行业包可扩展） */
export const AGENT_KINDS = [
  "pricing",
  "review",
  "reconcile",
  "inspection",
  "content",
  "competitor",
  "desktop",
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** 审批渠道（F5.4；首版仅 inapp 本地回环，其余进停车场——总纲 D7） */
export const APPROVAL_CHANNELS = ["inapp", "dingtalk", "wecom", "feishu", "slack"] as const;
export type ApprovalChannel = (typeof APPROVAL_CHANNELS)[number];
