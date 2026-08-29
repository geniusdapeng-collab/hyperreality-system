/**
 * 内容健康线单测：断更 / 节律 / 低效选题 / 高潜素材复用 / 时段错配。
 */
import { describe, expect, it } from "vitest";
import { analyzeContent } from "../src/analyzers/content.js";
import { baseAccount, baseVideo, daysAgo, emptySnapshot, NOW } from "./helpers.js";

const ctx = { now: NOW };

describe("内容健康线 · 断更与节律", () => {
  it("断更 9 天 → P1，粉丝流失按 0.5%/周经验估计", () => {
    const s = emptySnapshot({
      accounts: [baseAccount({ followers: 5000 })],
      videos: [baseVideo({ videoId: "v-last", publishedAt: daysAgo(9) })],
    });
    const f = analyzeContent(s, ctx).find((x) => x.title.includes("断更"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.calculation.result).toBe("9d > 7d");
    // 5000 × 0.005 × 9/7 ≈ 32 FANS
    expect(f!.estimatedImpact?.amount).toBe(32);
    expect(f!.estimatedImpact?.confidence).toBe("estimate");
  });

  it("断更 15 天 → P0", () => {
    const s = emptySnapshot({
      accounts: [baseAccount()],
      videos: [baseVideo({ publishedAt: daysAgo(15) })],
    });
    expect(analyzeContent(s, ctx).find((x) => x.title.includes("断更"))!.severity).toBe("P0");
  });

  it("断更 ≤7 天 → 不报", () => {
    const s = emptySnapshot({
      accounts: [baseAccount()],
      videos: [baseVideo({ publishedAt: daysAgo(6) })],
    });
    expect(analyzeContent(s, ctx).find((x) => x.title.includes("断更"))).toBeUndefined();
  });

  it("低于自设节律 70% → P2", () => {
    // 自设 3 条/周 → 30 天期望 12.86 条；实际 4 条（且未断更）
    const videos = Array.from({ length: 4 }, (_, i) => baseVideo({ videoId: `v-${i}`, publishedAt: daysAgo(i + 1) }));
    const s = emptySnapshot({ accounts: [baseAccount({ expectedPostsPerWeek: 3 })], videos });
    const f = analyzeContent(s, ctx).find((x) => x.title.includes("节律不足"));
    expect(f!.severity).toBe("P2");
  });
});

describe("内容健康线 · 低效选题聚集", () => {
  it("近 20 条中完播 <15% 占比 >50% → P1", () => {
    // 12 条：7 条完播 0.10，5 条完播 0.40
    const videos = Array.from({ length: 12 }, (_, i) =>
      baseVideo({ videoId: `v-${i}`, publishedAt: daysAgo(i + 1), completionRate: i < 7 ? 0.1 : 0.4 }),
    );
    const s = emptySnapshot({ accounts: [baseAccount()], videos });
    const f = analyzeContent(s, ctx).find((x) => x.title.includes("低效选题聚集"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P1");
    expect(f!.calculation.inputs["lowCount"]).toBe(7);
  });

  it("样本 <10 条 → 不判定", () => {
    const videos = Array.from({ length: 5 }, (_, i) => baseVideo({ videoId: `v-${i}`, publishedAt: daysAgo(i + 1), completionRate: 0.05 }));
    const s = emptySnapshot({ accounts: [baseAccount()], videos });
    expect(analyzeContent(s, ctx).find((x) => x.title.includes("低效选题"))).toBeUndefined();
  });
});

describe("内容健康线 · 高潜素材未复用", () => {
  it("爆款选题近 30 天 0 复用 → P2，按复刻 30% 播放估算", () => {
    const videos = [
      // 基准池：老视频 10000 播放（>30 天）
      ...Array.from({ length: 5 }, (_, i) => baseVideo({ videoId: `old-${i}`, publishedAt: daysAgo(40 + i), plays: 10000, topic: "日常" })),
      // 爆款：40 天前，topic=测评，40000 播放（4×基准），近 30 天无同 topic
      baseVideo({ videoId: "hit-1", title: "爆款测评", publishedAt: daysAgo(40), plays: 40000, topic: "测评" }),
      // 近期正常更新（topic=日常）
      ...Array.from({ length: 3 }, (_, i) => baseVideo({ videoId: `new-${i}`, publishedAt: daysAgo(i + 1), plays: 10000, topic: "日常" })),
    ];
    const s = emptySnapshot({ accounts: [baseAccount()], videos });
    const f = analyzeContent(s, ctx).find((x) => x.title.includes("高潜素材未复用"));
    expect(f).toBeDefined();
    expect(f!.severity).toBe("P2");
    // 40000 × 0.3 × 0.003 = 36 FANS
    expect(f!.estimatedImpact?.amount).toBe(36);
  });

  it("爆款选题近 30 天已复用 → 不报", () => {
    const videos = [
      ...Array.from({ length: 5 }, (_, i) => baseVideo({ videoId: `old-${i}`, publishedAt: daysAgo(40 + i), plays: 10000, topic: "日常" })),
      baseVideo({ videoId: "hit-1", publishedAt: daysAgo(40), plays: 40000, topic: "测评" }),
      baseVideo({ videoId: "reuse-1", publishedAt: daysAgo(5), plays: 9000, topic: "测评" }),
    ];
    const s = emptySnapshot({ accounts: [baseAccount()], videos });
    expect(analyzeContent(s, ctx).find((x) => x.title.includes("高潜素材"))).toBeUndefined();
  });
});

describe("内容健康线 · 发布时段错配", () => {
  it("近 20 条高峰发布占比 <30% → P2", () => {
    // 高峰 UTC 3 点；12 条全部发在 UTC 12 点
    const videos = Array.from({ length: 12 }, (_, i) =>
      baseVideo({ videoId: `v-${i}`, publishedAt: `2026-08-${String(10 + i).padStart(2, "0")}T12:00:00Z` }),
    );
    const s = emptySnapshot({ accounts: [baseAccount({ trafficPeakHours: [3, 4] })], videos });
    const f = analyzeContent(s, ctx).find((x) => x.title.includes("时段错配"));
    expect(f!.severity).toBe("P2");
    expect(f!.calculation.inputs["inPeak"]).toBe(0);
  });

  it("健康账号 → 全子项零发现", () => {
    const videos = Array.from({ length: 12 }, (_, i) =>
      baseVideo({ videoId: `v-${i}`, publishedAt: `2026-08-${String(16 + (i % 10)).padStart(2, "0")}T03:00:00Z`, plays: 10000, completionRate: 0.4, topic: "日常" }),
    );
    const s = emptySnapshot({
      accounts: [baseAccount({ expectedPostsPerWeek: 3, trafficPeakHours: [3, 4] })],
      videos,
    });
    expect(analyzeContent(s, ctx)).toHaveLength(0);
  });
});
