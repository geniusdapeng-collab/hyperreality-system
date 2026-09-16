/**
 * 三端动作授权公共契约。
 *
 * 服务端负责计算并强制执行，客户端只按同名键决定是否展示/启用动作。
 * 行业专属动作继续由已验 Bundle 命名空间声明，不得写入这个基座清单。
 */
export const BASE_CLIENT_ACTION_PERMISSIONS = [
  "workspace.write",
  "task.dispatch",
  "approval.decide",
  "guardrail.manage",
  "exam.run",
  "memory.manage",
  "memory.recall",
  "night.manage",
  "skill.manage",
  "bundle.manage",
  "agent.manage",
  "member.manage",
  "member.role.manage",
  "partner.manage",
  "workspace.configure",
  "tenant.plan.manage",
] as const;

export type BaseClientActionPermission = (typeof BASE_CLIENT_ACTION_PERMISSIONS)[number];
