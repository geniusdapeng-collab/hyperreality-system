/**
 * 分析器公共工具：时间窗、数值修约、基准量、分析器上下文。
 * 所有分析器为纯函数：同一份快照 + 同一个 now 必得同一份发现（确定性纪律，可复算）。
 */
import type { Finding, VideoRecord } from "../types.js";

/** 分析器上下文：锚定时间（由 engine 注入，分析器不读系统时钟） */
export interface AnalyzerContext {
  /** 报告锚定时间（断更天数、未回复时长、近 30 天窗口以此为界） */
  now: Date;
}

/** 两位小数修约 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 百分比修约（pp/占比判定展示用） */
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 两个 ISO 时间的小时差（now - at） */
export function hoursSince(now: Date, at: string): number {
  return (now.getTime() - Date.parse(at)) / 3_600_000;
}

/** 两个 ISO 时间的天数差（now - at） */
export function daysSince(now: Date, at: string): number {
  return hoursSince(now, at) / 24;
}

/** 近 N 天窗口起点（含边界） */
export function windowStart(now: Date, days: number): number {
  return now.getTime() - days * 86_400_000;
}

/** 构造发现时统一收口：占位 id（由 engine 统一编号 FND-<line>-<n>） */
export function makeFinding(f: Omit<Finding, "id">): Finding {
  return { ...f, id: "" };
}

/** 账号历史基准播放量：剔除近 7 天后取中位数（限流断崖/爆款判定的共同分母；样本不足返回 0） */
export function baselinePlays(videos: VideoRecord[], now: Date): number {
  const pool = videos
    .filter((v) => Date.parse(v.publishedAt) < windowStart(now, 7))
    .map((v) => v.plays)
    .sort((a, b) => a - b);
  if (pool.length === 0) return 0;
  const mid = Math.floor(pool.length / 2);
  return pool.length % 2 === 1 ? pool[mid]! : (pool[mid - 1]! + pool[mid]!) / 2;
}

/** 中位数（通用；空数组返回 0） */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
