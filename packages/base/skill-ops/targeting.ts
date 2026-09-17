/**
 * skill-ops · 定向匹配（纯函数）
 *
 * 官方投放只按标签定向，不读客户库（数据主权）：
 * 条目声明 targets（bundles/editions 缺省=全部），实例用自身标签匹配。
 */
import type { DistTargets, InstanceProfile } from "./types.js";

export function matchesTargets(targets: DistTargets, instance: InstanceProfile): boolean {
  if (targets.editions && targets.editions.length > 0 && !targets.editions.includes(instance.edition)) {
    return false;
  }
  if (targets.bundles && targets.bundles.length > 0) {
    const hit = targets.bundles.some((b) => instance.bundles.includes(b));
    if (!hit) return false;
  }
  return true;
}

/** 语义化版本比较（仅数字段，够用即可：1.10.0 > 1.9.9）；非法段按 0 处理 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
