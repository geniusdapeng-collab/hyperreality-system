/**
 * 引擎编排：runFastScan（社媒账号快照快扫）
 * 纪律（fast-scan SKILL.md 四）：
 *  - 时间纪律：软预算默认 30 分钟，逐线检查耗时，超时后剩余线标注 not-covered 出部分报告；
 *  - 降级纪律：某数据源缺失 → 该线标注 not-covered / partial，不阻塞整体；
 *  - 估算透明：所有 Finding 估算必须带 confidence 与计算口径（分析器层已强制）。
 * 输出：一账号一份 + 矩阵总览 + 按估算挽回降序 Top10。
 */
import { analyzeAccount } from "./analyzers/account.js";
import { analyzeComments } from "./analyzers/comments.js";
import { analyzeContent } from "./analyzers/content.js";
import { analyzeConversion } from "./analyzers/conversion.js";
import type { AnalyzerContext } from "./analyzers/util.js";
import type {
  AccountReport,
  AuditLine,
  AuditReport,
  AuditSnapshot,
  FastScanOptions,
  Finding,
  LineCoverage,
  Severity,
} from "./types.js";

/** 线的执行顺序（对齐 SKILL.md 步骤 2→5） */
const LINE_ORDER: readonly AuditLine[] = ["account", "content", "comments", "conversion"];

const ANALYZERS: Record<AuditLine, (s: AuditSnapshot, ctx: AnalyzerContext) => Finding[]> = {
  account: analyzeAccount,
  content: analyzeContent,
  comments: analyzeComments,
  conversion: analyzeConversion,
};

/**
 * 数据源覆盖度预判：某线所需数据集全空 → not-covered；关键子集缺失 → partial。
 */
function precheckLine(line: AuditLine, s: AuditSnapshot): { coverage: LineCoverage; note?: string } {
  switch (line) {
    case "account": {
      if (s.accounts.length === 0) return { coverage: "not-covered", note: "账号档案源缺失，账号健康线未覆盖" };
      if (s.videos.length === 0) return { coverage: "partial", note: "内容源缺失，限流信号与矩阵搬运子项降级" };
      return { coverage: "covered" };
    }
    case "content": {
      if (s.videos.length === 0) return { coverage: "not-covered", note: "内容源缺失，内容健康线未覆盖" };
      if (s.videos.every((v) => v.completionRate === undefined)) return { coverage: "partial", note: "完播率未采集，低效选题子项降级" };
      if (s.accounts.every((a) => a.expectedPostsPerWeek === undefined)) return { coverage: "partial", note: "自设节律未采集，节律达成子项降级" };
      return { coverage: "covered" };
    }
    case "comments": {
      if (s.comments.length === 0) return { coverage: "not-covered", note: "评论源缺失，评论与口碑线未覆盖" };
      return { coverage: "covered" };
    }
    case "conversion": {
      if (s.accounts.length === 0) return { coverage: "not-covered", note: "账号档案源缺失，转化健康线未覆盖" };
      if (s.leads.length === 0 && s.videos.length === 0)
        return { coverage: "partial", note: "线索与内容源均缺失，跟进断点与爆款挂载子项降级" };
      return { coverage: "covered" };
    }
  }
}

/** 严重度计数器 */
function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { P0: 0, P1: 0, P2: 0 };
  for (const f of findings) c[f.severity] += 1;
  return c;
}

/** 按计量单位分桶求和（FANS/LEADS/CNY 不互相折算） */
function sumByUnit(findings: Finding[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const f of findings) {
    if (!f.estimatedImpact) continue;
    const unit = f.estimatedImpact.currency;
    totals[unit] = Math.round(((totals[unit] ?? 0) + f.estimatedImpact.amount) * 100) / 100;
  }
  return totals;
}

/**
 * 快速体检主入口：快照 → 四线 → 报告。
 * 纯函数（除耗时计量）：同一快照 + 同一 now 必得同一报告正文。
 */
export function runFastScan(snapshot: AuditSnapshot, opts: FastScanOptions = {}): AuditReport {
  const startedAt = Date.now();
  const budgetMs = (opts.timeBudgetMinutes ?? 30) * 60_000;
  const ctx: AnalyzerContext = {
    now: opts.now ?? new Date(snapshot.generatedAt),
  };

  const coverage = {} as Record<AuditLine, LineCoverage>;
  const coverageNotes: string[] = [];
  const allFindings: Finding[] = [];

  for (const line of LINE_ORDER) {
    // 时间纪律：逐线检查软预算，超时后剩余线 not-covered（部分报告仍是有效交付）
    if (Date.now() - startedAt > budgetMs) {
      coverage[line] = "not-covered";
      coverageNotes.push(`时间预算耗尽（${opts.timeBudgetMinutes ?? 30} 分钟），${line} 线未执行`);
      continue;
    }
    const pre = precheckLine(line, snapshot);
    coverage[line] = pre.coverage;
    if (pre.note) coverageNotes.push(pre.note);
    if (pre.coverage === "not-covered") continue;
    const findings = ANALYZERS[line](snapshot, ctx);
    // 统一编号：FND-<LINE>-<全局序号>（报告可回溯）
    for (const f of findings) {
      f.id = `FND-${line.toUpperCase()}-${String(allFindings.length + 1).padStart(3, "0")}`;
      allFindings.push(f);
    }
  }

  /* ---------- 一账号一份 ---------- */
  const byAccount = new Map<string, Finding[]>();
  for (const f of allFindings) {
    const arr = byAccount.get(f.accountId) ?? [];
    arr.push(f);
    byAccount.set(f.accountId, arr);
  }
  const severityRank: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };
  const accounts: AccountReport[] = snapshot.accounts.map((a) => {
    const findings = (byAccount.get(a.accountId) ?? []).sort(
      (x, y) => severityRank[x.severity] - severityRank[y.severity] || (y.estimatedImpact?.amount ?? 0) - (x.estimatedImpact?.amount ?? 0),
    );
    return {
      accountId: a.accountId,
      accountName: a.accountName,
      platformId: a.platformId,
      followers: a.followers,
      findings,
      counts: countBySeverity(findings),
      totalRecoverableByUnit: sumByUnit(findings),
    };
  });
  // 有发现但账号不在快照 accounts 里的兜底桶（防御性；正常快照不会触发）
  for (const [accountId, findings] of byAccount) {
    if (accounts.some((a) => a.accountId === accountId)) continue;
    accounts.push({
      accountId,
      accountName: accountId,
      platformId: "unknown",
      followers: 0,
      findings,
      counts: countBySeverity(findings),
      totalRecoverableByUnit: sumByUnit(findings),
    });
  }

  /* ---------- 矩阵总览 + Top10 ---------- */
  const top10 = [...allFindings]
    .filter((f) => f.estimatedImpact)
    .sort((a, b) => (b.estimatedImpact?.amount ?? 0) - (a.estimatedImpact?.amount ?? 0))
    .slice(0, 10);

  return {
    reportId: `RPT-${snapshot.snapshotId}`,
    generatedAt: ctx.now.toISOString(),
    snapshotId: snapshot.snapshotId,
    coverage,
    coverageNotes,
    accounts,
    overview: {
      accountCount: snapshot.accounts.length,
      findingCount: allFindings.length,
      counts: countBySeverity(allFindings),
      totalRecoverableByUnit: sumByUnit(allFindings),
    },
    top10,
    elapsedMs: Date.now() - startedAt,
    timeBudgetMinutes: opts.timeBudgetMinutes ?? 30,
  };
}
