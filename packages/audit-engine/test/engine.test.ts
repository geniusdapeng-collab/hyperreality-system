/**
 * 引擎编排单测：覆盖度降级 / 时间纪律 / 确定性 / 编号 / Top10 排序 / 报告结构。
 */
import { describe, expect, it } from "vitest";
import { runFastScan } from "../src/engine.js";
import { baseAccount, baseComment, baseLead, baseVideo, daysAgo, emptySnapshot, hoursAgo, NOW } from "./helpers.js";

/** 全数据源齐活的健康快照（四线均 covered） */
function fullSnapshot() {
  return emptySnapshot({
    accounts: [baseAccount({ expectedPostsPerWeek: 3, trafficPeakHours: [3] })],
    videos: Array.from({ length: 12 }, (_, i) =>
      baseVideo({ videoId: `v-${i}`, publishedAt: `2026-08-${String(16 + (i % 10)).padStart(2, "0")}T03:00:00Z`, plays: 10000, completionRate: 0.4, topic: "日常" }),
    ),
    comments: [baseComment({ repliedAt: hoursAgo(4) })],
    leads: [baseLead({ followedUpAt: hoursAgo(9) })],
  });
}

describe("引擎 · 覆盖度降级", () => {
  it("评论源缺失 → comments 线 not-covered，其余线正常，出部分报告", () => {
    const s = fullSnapshot();
    s.comments = [];
    const r = runFastScan(s, { now: NOW });
    expect(r.coverage.comments).toBe("not-covered");
    expect(r.coverageNotes.join()).toContain("评论源缺失");
    expect(r.coverage.account).toBe("covered");
    expect(r.coverage.content).toBe("covered");
    expect(r.coverage.conversion).toBe("covered");
  });

  it("内容源缺失 → content 线 not-covered，account 线 partial（限流/搬运子项降级）", () => {
    const s = fullSnapshot();
    s.videos = [];
    const r = runFastScan(s, { now: NOW });
    expect(r.coverage.content).toBe("not-covered");
    expect(r.coverage.account).toBe("partial");
  });

  it("完播率全未采集 → content 线 partial", () => {
    const s = fullSnapshot();
    for (const v of s.videos) delete v.completionRate;
    const r = runFastScan(s, { now: NOW });
    expect(r.coverage.content).toBe("partial");
    expect(r.coverageNotes.join()).toContain("完播率");
  });

  it("时间预算为负 → 全部线 not-covered（时间纪律留痕）", () => {
    const r = runFastScan(fullSnapshot(), { now: NOW, timeBudgetMinutes: -1 });
    for (const line of ["account", "content", "comments", "conversion"] as const) {
      expect(r.coverage[line]).toBe("not-covered");
    }
    expect(r.overview.findingCount).toBe(0);
    expect(r.coverageNotes.join()).toContain("时间预算耗尽");
  });
});

describe("引擎 · 确定性与编号", () => {
  it("同一快照 + 同一 now 两次运行正文一致（除耗时）", () => {
    const s = fullSnapshot();
    const a = runFastScan(s, { now: NOW });
    const b = runFastScan(s, { now: NOW });
    expect({ ...a, elapsedMs: 0 }).toEqual({ ...b, elapsedMs: 0 });
  });

  it("发现统一编号 FND-<LINE>-<序号> 且全局唯一", () => {
    const s = fullSnapshot();
    // 制造两条发现：断更（content）+ 负面评论 30h（comments）
    s.videos = [baseVideo({ publishedAt: daysAgo(9) })];
    s.comments = [baseComment({ text: "体验很差不推荐", sentiment: "negative", createdAt: hoursAgo(30) })];
    const r = runFastScan(s, { now: NOW });
    const ids = r.accounts.flatMap((a) => a.findings.map((f) => f.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^FND-(ACCOUNT|CONTENT|COMMENTS|CONVERSION)-\d{3}$/.test(id))).toBe(true);
  });
});

describe("引擎 · 报告结构与 Top10", () => {
  it("一账号一份 + 矩阵总览 + Top10 按估算挽回降序", () => {
    const s = emptySnapshot({
      accounts: [
        baseAccount({ accountId: "a1", accountName: "甲号", followers: 12000, profile: { avatar: true, bio: true, showcase: false, booking: false, contact: false } }),
        baseAccount({ accountId: "a2", accountName: "乙号", followers: 5000 }),
      ],
      videos: [
        // a1：爆款未挂组件（30 LEADS）+ 一条近期正常更新（避免断更串扰）
        ...Array.from({ length: 5 }, (_, i) => baseVideo({ accountId: "a1", videoId: `a1-old-${i}`, publishedAt: daysAgo(10 + i), plays: 10000 })),
        baseVideo({ accountId: "a1", videoId: "a1-hit", title: "甲号爆款", publishedAt: daysAgo(10), plays: 30000, hasConversionComponent: false }),
        baseVideo({ accountId: "a1", videoId: "a1-new", publishedAt: daysAgo(2), plays: 10000 }),
        // a2：正常
        ...Array.from({ length: 5 }, (_, i) => baseVideo({ accountId: "a2", videoId: `a2-v-${i}`, publishedAt: daysAgo(i + 1), plays: 2000, completionRate: 0.4 })),
      ],
      comments: [],
      leads: [baseLead({ accountId: "a2", leadId: "l-a2", inquiryAt: hoursAgo(60) })],
    });
    const r = runFastScan(s, { now: NOW });
    expect(r.accounts).toHaveLength(2);
    expect(r.accounts.find((a) => a.accountId === "a1")!.counts.P1).toBeGreaterThanOrEqual(2); // 零组件 + 爆款未挂
    expect(r.overview.accountCount).toBe(2);
    expect(r.overview.findingCount).toBeGreaterThanOrEqual(3);
    // Top10 降序：30 LEADS 爆款未挂应排最前
    expect(r.top10[0]!.title).toContain("爆款未挂转化组件");
    const amounts = r.top10.map((f) => f.estimatedImpact!.amount);
    expect([...amounts].sort((x, y) => y - x)).toEqual(amounts);
    // 总览分单位汇总：LEADS 与 FANS 不混算
    expect(r.overview.totalRecoverableByUnit["LEADS"]).toBeGreaterThan(0);
  });
});
