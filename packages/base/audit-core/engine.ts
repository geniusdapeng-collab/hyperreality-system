/**
 * audit-core 引擎编排：runFastScan
 * 逐线执行 precheck → analyze，软预算与降级纪律由内核统一承载，行业包无需重复实现。
 */
import type {
  AnalyzerContext,
  AuditReport,
  Coverage,
  FastScanOptions,
  Finding,
  ImpactPeriod,
  LineDef,
  LineResult,
  Severity,
} from "./types.js";

const SEV_ORDER: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

/** 年化归一系数（one-off 按 1 计） */
const YEAR_FACTOR: Record<ImpactPeriod, number> = { "one-off": 1, daily: 365, monthly: 12, yearly: 1 };

/** 发现的年化归一值（无 impact 按 0，排最后） */
function yearlyValue(f: Finding): number {
  if (!f.impact) return 0;
  return f.impact.amount * YEAR_FACTOR[f.impact.period];
}

function cmpFindings(a: Finding, b: Finding): number {
  const d = SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
  return d !== 0 ? d : yearlyValue(b) - yearlyValue(a);
}

const DEFAULT_BUDGET_MS = 30 * 60 * 1000;

/**
 * 执行快速体检扫描。
 * @param snapshot 行业快照数据集（结构由行业包定义，内核不关心字段）
 * @param lines    行业检线定义（执行顺序 = 数组顺序）
 * @param opts     软预算/锚定钟/报告标识
 */
export function runFastScan<S>(
  snapshot: S,
  lines: readonly LineDef<S>[],
  opts: FastScanOptions = {},
): AuditReport {
  const now = opts.now ?? new Date();
  const budget = opts.softBudgetMs ?? DEFAULT_BUDGET_MS;
  const topN = opts.topN ?? 10;
  // 双钟纪律：报告时间戳用锚定钟 now（可复算）；耗时计量用真实单调钟（软预算），两钟不混用
  const realStart = Date.now();
  const started = now.getTime();
  const lineResults: LineResult[] = [];
  const coverage: Record<string, Coverage> = {};
  let budgetExhausted = false;

  for (const def of lines) {
    const lineStart = Date.now();
    // 时间纪律：预算耗尽后，剩余线直接标 not-covered（不再执行分析器）
    if (budgetExhausted) {
      lineResults.push({ line: def.line, coverage: "not-covered", note: "时间预算耗尽，该线未执行", findings: [], durationMs: 0 });
      coverage[def.line] = "not-covered";
      continue;
    }

    const pre = def.precheck(snapshot);
    if (pre.coverage === "not-covered") {
      lineResults.push({ line: def.line, coverage: "not-covered", note: pre.note, findings: [], durationMs: Date.now() - lineStart });
      coverage[def.line] = "not-covered";
      continue;
    }

    let findings: Finding[] = [];
    let note = pre.note;
    try {
      const ctx: AnalyzerContext = { now, line: def.line };
      findings = def.analyze(snapshot, ctx);
    } catch (err) {
      // 分析器异常不阻塞整体：该线降级 not-covered 并留痕
      findings = [];
      note = `${note ? note + "；" : ""}分析器异常：${err instanceof Error ? err.message : String(err)}`;
      lineResults.push({ line: def.line, coverage: "not-covered", note, findings, durationMs: Date.now() - lineStart });
      coverage[def.line] = "not-covered";
      continue;
    }

    // 统一编号 FND-<LINE>-<n>（分析器未自填 id 时补齐；已填则保留）
    const tagged = findings.map((f, i) => ({
      ...f,
      id: f.id && f.id.length > 0 ? f.id : `FND-${def.line.toUpperCase()}-${i + 1}`,
      line: def.line,
    }));

    lineResults.push({ line: def.line, coverage: pre.coverage, note, findings: tagged, durationMs: Date.now() - lineStart });
    coverage[def.line] = pre.coverage;

    if (Date.now() - realStart > budget) budgetExhausted = true;
  }

  const all = lineResults.flatMap((r) => r.findings).sort(cmpFindings);
  const byUnit: Record<string, number> = {};
  for (const f of all) {
    if (!f.impact) continue;
    const key = f.impact.unit;
    byUnit[key] = Math.round(((byUnit[key] ?? 0) + f.impact.amount * YEAR_FACTOR[f.impact.period]) * 100) / 100;
  }

  return {
    reportId: opts.reportId ?? `RPT-${now.toISOString().slice(0, 10)}`,
    snapshotId: opts.snapshotId ?? `SNAP-${now.toISOString().slice(0, 10)}`,
    generatedAt: now.toISOString(),
    durationMs: Date.now() - realStart,
    coverage,
    lineResults,
    findings: all,
    top: all.filter((f) => f.impact).slice(0, topN),
    totals: {
      p0: all.filter((f) => f.severity === "P0").length,
      p1: all.filter((f) => f.severity === "P1").length,
      p2: all.filter((f) => f.severity === "P2").length,
      byUnit,
    },
  };
}
