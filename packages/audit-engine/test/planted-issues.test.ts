/**
 * 埋点考卷（集成验证，本任务的成败判据）
 * 构造一份含 6 个已知埋点的社媒快照，引擎必须全部独立算出，且严重度 / 估算口径正确。
 * 任何一条漏报或错级 = 考卷不过。
 *
 * 埋点清单（分布在两个账号上，数据互相隔离避免交叉触发）：
 *  ① acc-main 限流信号：连续 3 条播放 4000 < 基准 10000×50%
 *  ② acc-side 断更 9 天（上次发布 9 天前）
 *  ③ acc-main 高意向咨询 18h 未回复
 *  ④ acc-main 爆款 30000 播放（3×基准）未挂转化组件
 *  ⑤ acc-main 负面评论 30h 未处理
 *  ⑥ acc-main 主页无转化组件（橱窗/预约/联系方式全无）
 */
import { describe, expect, it } from "vitest";
import { runFastScan } from "../src/engine.js";
import type { AuditSnapshot, Finding } from "../src/types.js";
import { baseAccount, daysAgo, hoursAgo, NOW } from "./helpers.js";

function plantedSnapshot(): AuditSnapshot {
  return {
    snapshotId: "SNAP-PLANTED",
    generatedAt: NOW.toISOString(),
    accounts: [
      baseAccount({
        accountId: "acc-main",
        platformId: "douyin",
        accountName: "焕颜美妆日记",
        followers: 12000,
        expectedPostsPerWeek: 3,
        // 埋点⑥：主页零转化组件
        profile: { avatar: true, bio: true, showcase: false, booking: false, contact: false },
      }),
      baseAccount({
        accountId: "acc-side",
        platformId: "xiaohongshu",
        accountName: "焕颜好物小号",
        followers: 5000,
      }),
    ],
    videos: [
      // acc-main 基准池：5 条老视频 10000 播放（中位基准 = 10000）
      ...Array.from({ length: 5 }, (_, i) => ({
        accountId: "acc-main",
        videoId: `m-old-${i}`,
        title: `教程第${i + 1}期`,
        publishedAt: daysAgo(13 + i),
        plays: 10000,
        completionRate: 0.35,
        likes: 500,
        comments: 50,
        shares: 30,
        topic: "教程",
        hasConversionComponent: true,
      })),
      // 埋点④：12 天前爆款 30000 播放（3×基准）零挂载（排除高潜复用子项：未超 30 天窗口）
      {
        accountId: "acc-main",
        videoId: "m-hit",
        title: "早八伪素颜妆教",
        publishedAt: daysAgo(12),
        plays: 30000,
        completionRate: 0.42,
        likes: 3200,
        comments: 410,
        shares: 260,
        topic: "教程",
        hasConversionComponent: false,
      },
      // 埋点①：最新连续 3 条播放 4000 < 基准 50%（断崖）
      ...Array.from({ length: 3 }, (_, i) => ({
        accountId: "acc-main",
        videoId: `m-new-${i}`,
        title: `新内容第${i + 1}条`,
        publishedAt: daysAgo(i + 1),
        plays: 4000,
        completionRate: 0.3,
        likes: 180,
        comments: 20,
        shares: 8,
        topic: "教程",
        hasConversionComponent: true,
      })),
      // acc-side：断更场景，4 条正常视频，最新一条在 9 天前（埋点②）
      ...Array.from({ length: 4 }, (_, i) => ({
        accountId: "acc-side",
        videoId: `s-v-${i}`,
        title: `开箱第${i + 1}期`,
        publishedAt: daysAgo(9 + i),
        plays: 2000,
        completionRate: 0.35,
        likes: 120,
        comments: 15,
        shares: 5,
        topic: "开箱",
        hasConversionComponent: true,
      })),
    ],
    comments: [
      // 埋点③：高意向咨询 18h 未回复
      {
        accountId: "acc-main",
        commentId: "c-inq-001",
        videoId: "m-hit",
        text: "这款粉底怎么买求链接",
        createdAt: hoursAgo(18),
        sentiment: "neutral",
        isInquiry: true,
      },
      // 埋点⑤：负面评论 30h 未处理
      {
        accountId: "acc-main",
        commentId: "c-neg-001",
        videoId: "m-old-0",
        text: "用了两天就过敏了太失望",
        createdAt: hoursAgo(30),
        sentiment: "negative",
      },
      // 陪跑评论：已回复的正面评论（文本互不相同，不触发高频问题）
      {
        accountId: "acc-main",
        commentId: "c-ok-1",
        text: "妆感真的自然",
        createdAt: hoursAgo(20),
        repliedAt: hoursAgo(19),
        sentiment: "positive",
      },
      {
        accountId: "acc-main",
        commentId: "c-ok-2",
        text: "求出续集教程",
        createdAt: hoursAgo(15),
        repliedAt: hoursAgo(14),
        sentiment: "positive",
      },
    ],
    leads: [],
    sensitiveWords: [],
  };
}

const report = runFastScan(plantedSnapshot(), { now: NOW });
const all = report.accounts.flatMap((a) => a.findings);
const find = (pred: (f: Finding) => boolean): Finding | undefined => all.find(pred);

describe("埋点考卷 · 6 个已知埋点必须全部检出", () => {
  it("① 限流信号：连续 3 条播放 < 基准 50% → 检出，P1，54 FANS（baseline）", () => {
    const f = find((x) => x.line === "account" && x.title.includes("疑似限流"));
    expect(f, "埋点①未检出").toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.accountId).toBe("acc-main");
    expect(f!.calculation.inputs["streak"]).toBe(3);
    expect(f!.calculation.inputs["baseline"]).toBe(10000);
    // 播放缺口 3×(10000−4000)=18000 × 0.3% = 54 FANS
    expect(f!.estimatedImpact?.amount).toBe(54);
    expect(f!.estimatedImpact?.currency).toBe("FANS");
    expect(f!.estimatedImpact?.confidence).toBe("baseline");
  });

  it("② 断更 9 天 → 检出，P1，挂 acc-side，粉丝流失 32（estimate）", () => {
    const f = find((x) => x.line === "content" && x.title.includes("断更"));
    expect(f, "埋点②未检出").toBeDefined();
    expect(f!.severity).toBe("P1"); // 9d > 7d，未超 14d 升级线
    expect(f!.accountId).toBe("acc-side");
    expect(f!.calculation.result).toBe("9d > 7d");
    // 5000 × 0.5%/周 × 9/7 周 ≈ 32 FANS
    expect(f!.estimatedImpact?.amount).toBe(32);
    expect(f!.estimatedImpact?.confidence).toBe("estimate");
  });

  it("③ 高意向咨询 18h 未回 → 检出，P1，线索流失 0.5 条（baseline）", () => {
    const f = find((x) => x.line === "comments" && x.title.includes("高意向咨询"));
    expect(f, "埋点③未检出").toBeDefined();
    expect(f!.severity).toBe("P1"); // 18h > 12h，未超 48h 升级线
    expect(f!.evidence[0]!.id).toBe("c-inq-001");
    expect(f!.calculation.result).toBe("18h > 12h");
    expect(f!.estimatedImpact?.amount).toBe(0.5);
    expect(f!.estimatedImpact?.currency).toBe("LEADS");
  });

  it("④ 爆款未挂转化组件 → 检出，P1，线索损失 30 条（30000×0.1%，baseline）", () => {
    const f = find((x) => x.line === "conversion" && x.title.includes("爆款未挂转化组件"));
    expect(f, "埋点④未检出").toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.evidence[0]!.id).toBe("m-hit");
    expect(f!.estimatedImpact?.amount).toBe(30);
    expect(f!.estimatedImpact?.currency).toBe("LEADS");
    expect(f!.estimatedImpact?.confidence).toBe("baseline");
  });

  it("⑤ 负面评论 30h 未处理 → 检出，P1（>24h 命中，未触发 >72h 升级）", () => {
    const f = find((x) => x.line === "comments" && x.title.includes("负面评论"));
    expect(f, "埋点⑤未检出").toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.evidence[0]!.id).toBe("c-neg-001");
    expect(f!.calculation.result).toBe("30h > 24h");
  });

  it("⑥ 主页零转化组件 → 检出，P1，月度线索损失 2 条（12000×0.02%，estimate）", () => {
    const f = find((x) => x.line === "conversion" && x.title.includes("零转化组件"));
    expect(f, "埋点⑥未检出").toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.accountId).toBe("acc-main");
    expect(f!.estimatedImpact?.amount).toBe(2);
    expect(f!.estimatedImpact?.period).toBe("monthly");
    expect(f!.estimatedImpact?.confidence).toBe("estimate");
  });

  it("考卷整体：四线全 covered，报告结构完整，恰 6 条发现无串扰，Top10 降序", () => {
    for (const line of ["account", "content", "comments", "conversion"] as const) {
      expect(report.coverage[line], line).toBe("covered");
    }
    expect(report.accounts).toHaveLength(2);
    // 恰 6 条：埋点互相隔离，无交叉触发（如爆款视频不参与限流连击、断更号无限流）
    expect(report.overview.findingCount).toBe(6);
    expect(report.overview.counts.P0).toBe(0);
    expect(report.overview.counts.P1).toBe(6);
    // Top10 按估算挽回数值降序：Top1 = 限流信号（54 FANS），爆款未挂（30 LEADS）次之
    expect(report.top10[0]!.title).toContain("疑似限流");
    expect(report.top10.map((f) => f.title).join()).toContain("爆款未挂转化组件");
    const amounts = report.top10.map((f) => f.estimatedImpact!.amount);
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    // 隔离性兜底：acc-side 不应误触发限流（2000 播放 = 自身基准）
    expect(find((x) => x.accountId === "acc-side" && x.title.includes("疑似限流"))).toBeUndefined();
    // 分单位汇总不混算
    expect(report.overview.totalRecoverableByUnit["FANS"]).toBe(54 + 32);
    expect(report.overview.totalRecoverableByUnit["LEADS"]).toBe(2 + 30 + 0.5);
  });
});
