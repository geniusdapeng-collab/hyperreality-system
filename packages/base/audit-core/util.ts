/**
 * audit-core 纯函数工具：时间窗/修约/中位数/年化系数。
 * 所有分析器与内核共用，禁止读取系统时钟（时钟由 AnalyzerContext 注入）。
 */

/** 保留两位小数 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 两个时间的整天差（b - a，按 24h 计，向下取整） */
export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

/** 距锚定钟 N 天的时间点 */
export function daysAgo(now: Date, n: number): Date {
  return new Date(now.getTime() - n * 86_400_000);
}

/** 中位数（空数组返回 0） */
export function median(nums: readonly number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** 年化归一（与引擎一致：one-off×1 / daily×365 / monthly×12 / yearly×1） */
export function yearlyFactor(period: "one-off" | "daily" | "monthly" | "yearly"): number {
  return period === "daily" ? 365 : period === "monthly" ? 12 : 1;
}

/** 百分比差（相对 max 的相对差，0–1；max=0 时返回 0） */
export function relDiff(a: number, b: number): number {
  const max = Math.max(Math.abs(a), Math.abs(b));
  return max === 0 ? 0 : Math.abs(a - b) / max;
}
