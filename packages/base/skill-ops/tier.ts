/**
 * skill-ops · L0/L1/L2 分级引擎（纯函数，方案 v0.2 §3.3）
 *
 * 切线：执行面与权限面永不静默——
 *  - category=tool-execution → L2（无论首装/升级）
 *  - 首装知识型 → L0
 *  - 升级时工具白名单/出站域/围栏绑定有新增（权限面扩张）→ L2
 *  - 升级时权限面零扩张（纯内容变化；收缩按安全方向放行但留痕）→ L1
 */
import type { DistMeta, DistTier, SkillPackage } from "./types.js";

export interface TierDiff {
  addedTools: string[];
  removedTools: string[];
  addedEgress: string[];
  removedEgress: string[];
  addedFence: string[];
  removedFence: string[];
}

/** 本机已装现状（首装=null） */
export interface CurrentState {
  meta: DistMeta | null;
  fenceBindings: string[] | null;
}

export function diffDistMeta(current: CurrentState | null, next: SkillPackage): TierDiff {
  const d = (a: string[], b: string[]) => ({
    added: b.filter((x) => !a.includes(x)),
    removed: a.filter((x) => !b.includes(x)),
  });
  const tools = d(current?.meta?.toolWhitelist ?? [], next.meta.toolWhitelist);
  const egress = d(current?.meta?.egressDomains ?? [], next.meta.egressDomains);
  const fence = d(current?.fenceBindings ?? [], next.fenceBindings);
  return {
    addedTools: tools.added, removedTools: tools.removed,
    addedEgress: egress.added, removedEgress: egress.removed,
    addedFence: fence.added, removedFence: fence.removed,
  };
}

/** 权限面扩张判定：新增工具/出站域/围栏绑定 → L2；纯收缩不视为扩张（收紧是安全方向，按 L1 留痕） */
export function hasPermissionDrift(d: TierDiff): boolean {
  return d.addedTools.length > 0 || d.addedEgress.length > 0 || d.addedFence.length > 0;
}

/** 定级：current 为本机已装现状（未装=null 首装） */
export function classifyTier(pkg: SkillPackage, current: CurrentState | null): { tier: DistTier; diff: TierDiff } {
  const diff = diffDistMeta(current, pkg);
  if (pkg.meta.category === "tool-execution") return { tier: "L2", diff };
  if (current === null) return { tier: "L0", diff };
  if (hasPermissionDrift(diff)) return { tier: "L2", diff };
  return { tier: "L1", diff };
}
