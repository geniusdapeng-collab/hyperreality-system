/**
 * @workloom/audit-core · 质检检测引擎通用内核（行业无关）
 * 各行业包质检模式共享骨架：快照类型与行业分析器由行业包提供，
 * Finding/报告模型、软预算、缺源降级、编号、TopN、估算口径纪律由本内核统一承载。
 */
export type {
  Analyzer,
  AnalyzerContext,
  AuditReport,
  Coverage,
  EstimatedImpact,
  EvidenceRef,
  FastScanOptions,
  Finding,
  ImpactConfidence,
  ImpactPeriod,
  LineDef,
  LineResult,
  Severity,
} from "./types.js";
export { runFastScan } from "./engine.js";
export { daysAgo, daysBetween, median, relDiff, round2, yearlyFactor } from "./util.js";
