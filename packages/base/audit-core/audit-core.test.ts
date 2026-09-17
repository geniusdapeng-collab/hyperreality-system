/**
 * audit-core 内核测试：通用编排纪律（覆盖度降级/软预算/编号/排序/聚合/异常不阻塞）。
 * 用玩具快照与玩具分析器验证行业无关行为。
 */
import { describe, expect, it } from "vitest";
import { runFastScan, type Finding, type LineDef } from "./index.js";

interface ToySnapshot {
  records: number[];
  meta?: { sourceMissing?: boolean };
}

const NOW = new Date("2026-08-29T08:00:00.000Z");

function finding(severity: Finding["severity"], amount?: number, period?: "one-off" | "daily" | "monthly" | "yearly"): Finding {
  return {
    id: "",
    line: "toy",
    severity,
    title: `发现-${severity}`,
    evidence: [{ kind: "record", id: "r1" }],
    impact: amount === undefined ? undefined : { amount, unit: "CNY", period: period ?? "one-off", confidence: "exact", basis: "toy" },
  };
}

const full: ToySnapshot = { records: [1, 2, 3] };

function toyLine(line: string, out: Finding[], coverage: "covered" | "partial" | "not-covered" = "covered"): LineDef<ToySnapshot> {
  return {
    line,
    precheck: (s) => (s.meta?.sourceMissing ? { coverage: "not-covered", note: "源缺失" } : { coverage, note: coverage === "partial" ? "子集缺失降级" : undefined }),
    analyze: () => out,
  };
}

describe("runFastScan 编排纪律", () => {
  it("正常执行：编号补齐、按严重度+年化排序、totals 聚合", () => {
    const r = runFastScan(full, [
      toyLine("alpha", [finding("P2", 10, "monthly" as never), finding("P0", 5, "one-off" as never)]),
      toyLine("beta", [finding("P1", 100, "yearly" as never)]),
    ], { now: NOW, reportId: "RPT-T", snapshotId: "SNAP-T" });
    expect(r.reportId).toBe("RPT-T");
    expect(r.findings[0]!.severity).toBe("P0");
    expect(r.findings[0]!.id).toBe("FND-ALPHA-2");
    expect(r.findings[1]!.severity).toBe("P1");
    expect(r.totals).toMatchObject({ p0: 1, p1: 1, p2: 1 });
    expect(r.totals.byUnit.CNY).toBe(10 * 12 + 5 + 100);
    expect(r.coverage).toEqual({ alpha: "covered", beta: "covered" });
  });

  it("缺源降级：precheck not-covered 时不执行分析器且不阻塞其他线", () => {
    let called = 0;
    const blocked: LineDef<ToySnapshot> = {
      line: "blocked",
      precheck: (s) => (s.meta?.sourceMissing ? { coverage: "not-covered", note: "源缺失" } : { coverage: "covered" }),
      analyze: () => { called++; return [finding("P0")]; },
    };
    const ok: LineDef<ToySnapshot> = { line: "ok", precheck: () => ({ coverage: "covered" }), analyze: () => [finding("P2", 1, "one-off")] };
    const r = runFastScan({ records: [], meta: { sourceMissing: true } }, [blocked, ok], { now: NOW });
    expect(called).toBe(0);
    expect(r.coverage.blocked).toBe("not-covered");
    expect(r.findings).toHaveLength(1);
  });

  it("分析器异常：该线降级 not-covered 留痕，不阻塞整体", () => {
    const boom: LineDef<ToySnapshot> = { line: "boom", precheck: () => ({ coverage: "covered" }), analyze: () => { throw new Error("炸了"); } };
    const r = runFastScan(full, [boom, toyLine("ok", [finding("P1", 2, "one-off" as never)])], { now: NOW });
    expect(r.coverage.boom).toBe("not-covered");
    expect(r.lineResults[0]!.note).toContain("炸了");
    expect(r.findings).toHaveLength(1);
  });

  it("软预算耗尽：后续线标 not-covered 且不再执行", () => {
    let late = 0;
    const slow: LineDef<ToySnapshot> = {
      line: "slow",
      precheck: () => ({ coverage: "covered" }),
      analyze: () => { const t = Date.now(); while (Date.now() - t < 5) { /* 耗时 */ } return [finding("P2", 1, "one-off" as never)]; },
    };
    const lateLine: LineDef<ToySnapshot> = { line: "late", precheck: () => ({ coverage: "covered" }), analyze: () => { late++; return [finding("P0")]; } };
    const r = runFastScan(full, [slow, lateLine], { now: NOW, softBudgetMs: 1 });
    expect(late).toBe(0);
    expect(r.coverage.late).toBe("not-covered");
  });

  it("Top 排序按年化归一（daily×365 胜过 monthly×12 与 one-off 大额）", () => {
    const r = runFastScan(full, [toyLine("x", [
      finding("P1", 1000, "one-off" as never),
      finding("P1", 10, "daily" as never),
      finding("P1", 100, "monthly" as never),
    ])], { now: NOW, topN: 3 });
    expect(r.top.map((f) => f.impact!.amount)).toEqual([10, 100, 1000]);
  });

  it("partial 覆盖度透传并保留 note", () => {
    const r = runFastScan(full, [toyLine("p", [finding("P2", 1, "one-off" as never)], "partial")], { now: NOW });
    expect(r.coverage.p).toBe("partial");
    expect(r.lineResults[0]!.note).toContain("降级");
  });

  it("无 impact 的发现排最后且不参与金额聚合", () => {
    const r = runFastScan(full, [toyLine("x", [finding("P1", 5, "one-off" as never), finding("P0")])], { now: NOW });
    expect(r.top).toHaveLength(1);
    expect(r.totals.byUnit.CNY).toBe(5);
    expect(r.totals.p0).toBe(1);
  });
});
