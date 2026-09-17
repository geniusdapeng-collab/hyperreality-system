/**
 * tenancy · 版本能力矩阵（F7.2 唯一口径，L7.2：其他章节/营销物料不得超卖）
 * 四版本（PRD M7.2 原文）：
 *   社区版：无 Quest preset / 无夜班 / 无巡检，事件保留 7 天
 *   Pro   ：完整夜班 + 巡检
 *   Teams ：+ 集团共享记忆 / 跨店继承 / 审计报告
 *   VPC   ：+ 内网 seam + 本地模型
 * 裁剪 = bundle 组合差异 + patch；服务端对越版调用强制 403+升级提示（H-10）；前端隐藏非置灰
 */
import { PLAN_TIERS, RETENTION_DAYS, type PlanTier } from "@workloom/shared";

export interface PlanCapabilities {
  quest: boolean;
  nightShift: boolean;
  inspection: boolean;
  /** 集团共享记忆中心 / 跨店继承（Teams+） */
  sharedMemory: boolean;
  auditReport: boolean;
  /** VPC：内网 seam / 本地模型适配器 */
  vpcSeam: boolean;
  localModel: boolean;
  /** 事件保留天数（社区版 7 天；到期降级保留 90 天可导出，F7.5） */
  eventRetentionDays: number;
}

export const PLAN_CAPABILITIES: Record<PlanTier, PlanCapabilities> = {
  community: {
    quest: false, nightShift: false, inspection: false,
    sharedMemory: false, auditReport: false, vpcSeam: false, localModel: false,
    eventRetentionDays: RETENTION_DAYS.communityEvents,
  },
  pro: {
    quest: true, nightShift: true, inspection: true,
    sharedMemory: false, auditReport: false, vpcSeam: false, localModel: false,
    eventRetentionDays: Number.POSITIVE_INFINITY, // 订阅期内不限（保留策略 VPC 合同化）
  },
  teams: {
    quest: true, nightShift: true, inspection: true,
    sharedMemory: true, auditReport: true, vpcSeam: false, localModel: false,
    eventRetentionDays: Number.POSITIVE_INFINITY,
  },
  vpc: {
    quest: true, nightShift: true, inspection: true,
    sharedMemory: true, auditReport: true, vpcSeam: true, localModel: true,
    eventRetentionDays: Number.POSITIVE_INFINITY,
  },
} as const;

export type CapabilityKey = Exclude<keyof PlanCapabilities, "eventRetentionDays">;

const PLAN_LABELS: Record<PlanTier, string> = {
  community: "社区版",
  pro: "专业版",
  teams: "团队版",
  vpc: "私有部署版",
};

const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  quest: "多步骤任务编排",
  nightShift: "夜班自动运行",
  inspection: "经营巡检",
  sharedMemory: "团队共享记忆",
  auditReport: "审计报告",
  vpcSeam: "内网接入",
  localModel: "本地模型",
};

export function planDisplayName(plan: PlanTier): string {
  return PLAN_LABELS[plan];
}

export function capabilityDisplayName(capability: CapabilityKey): string {
  return CAPABILITY_LABELS[capability];
}

export function getCapabilities(plan: PlanTier): PlanCapabilities {
  return PLAN_CAPABILITIES[plan];
}

export function hasCapability(plan: PlanTier, cap: CapabilityKey): boolean {
  return PLAN_CAPABILITIES[plan][cap];
}

/**
 * 越版调用错误（H-10：403 + 升级提示；调用方负责把留痕写成事件，G8）
 */
export class PlanForbidden extends Error {
  constructor(
    public readonly plan: PlanTier,
    public readonly capability: CapabilityKey,
  ) {
    super(`当前使用${planDisplayName(plan)}，暂不包含“${capabilityDisplayName(capability)}”，请升级后再试。`);
    this.name = "PlanForbidden";
  }
  /** HTTP 语义 */
  get statusCode(): number {
    return 403;
  }
  /** 升级提示（前端展示口径） */
  get upgradeHint(): string {
    const need: PlanTier | null =
      this.capability === "vpcSeam" || this.capability === "localModel" ? "vpc"
      : this.capability === "sharedMemory" || this.capability === "auditReport" ? "teams"
      : "pro";
    return `升级至${planDisplayName(need)}后可使用“${capabilityDisplayName(this.capability)}”。`;
  }
}

/** 守卫：不具备能力即抛 PlanForbidden（服务端 403 的唯一出口） */
export function requireCapability(plan: PlanTier, cap: CapabilityKey): void {
  if (!PLAN_TIERS.includes(plan)) throw new PlanForbidden(plan, cap);
  if (!hasCapability(plan, cap)) throw new PlanForbidden(plan, cap);
}
