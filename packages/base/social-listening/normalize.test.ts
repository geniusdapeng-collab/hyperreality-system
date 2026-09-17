/**
 * normalize 测试（纯函数，无 DB）：
 * 口径映射注册/覆盖、归一产出三元组、未注册平台 null + confidence 0、
 * 别名命中降权、±10% divergent 标记、缺失侧不可比不伪造差异
 */
import { describe, expect, it } from "vitest";
import {
  CANONICAL_METRICS,
  MetricMappingRegistry,
  compareMetrics,
  defaultMetricRegistry,
  normalizeMetric,
} from "./normalize.js";

describe("口径映射注册表", () => {
  it("registerMetricMapping 注册并查询；覆盖式更新", () => {
    const r = new MetricMappingRegistry();
    r.registerMetricMapping("custom", { plays: ["pv"] });
    expect(r.mappingOf("custom")?.plays).toEqual(["pv"]);
    r.registerMetricMapping("custom", { plays: ["view_cnt"] });
    expect(r.mappingOf("custom")?.plays).toEqual(["view_cnt"]);
    expect(r.mappingOf("unknown")).toBeUndefined();
    expect(r.platforms()).toEqual(["custom"]);
  });

  it("默认注册表覆盖六平台", () => {
    const r = defaultMetricRegistry();
    expect(r.platforms().sort()).toEqual(
      ["bilibili", "douyin", "shipinhao", "tiktok", "xiaohongshu", "youtube"],
    );
  });
});

describe("normalizeMetric 归一", () => {
  it("抖音原始字段 → canonical（首选字段满权重 → confidence 1）", () => {
    const r = defaultMetricRegistry();
    const out = normalizeMetric({
      platform: "douyin",
      fields: { play_count: 12000, digg_count: 800, comment_count: 90, share_count: 30, follower_count: 5000 },
    }, r);
    expect(out.normalized).toEqual({ plays: 12000, likes: 800, comments: 90, shares: 30, follows: 5000 });
    expect(out.confidence).toBe(1);
    expect(out.raw.fields.play_count).toBe(12000);
  });

  it("别名命中降权（首选缺失用别名 → confidence 略低于 1）", () => {
    const r = defaultMetricRegistry();
    const out = normalizeMetric({
      platform: "douyin",
      fields: { plays: 100, likes: 10, comments: 5, shares: 2, follows: 50 }, // 全走别名位
    }, r);
    expect(out.normalized.plays).toBe(100);
    expect(out.confidence).toBeCloseTo(0.9, 5);
  });

  it("缺失口径记 null 且拉低 confidence（不编造）", () => {
    const r = defaultMetricRegistry();
    const out = normalizeMetric({
      platform: "xiaohongshu",
      fields: { views: 3000, liked_count: 200 },
    }, r);
    expect(out.normalized.plays).toBe(3000);
    expect(out.normalized.comments).toBeNull();
    expect(out.confidence).toBeCloseTo(2 / CANONICAL_METRICS.length, 5);
  });

  it("未注册平台 → 全 null + confidence 0", () => {
    const r = defaultMetricRegistry();
    const out = normalizeMetric({ platform: "kuaishou", fields: { vv: 999 } }, r);
    expect(Object.values(out.normalized).every((v) => v === null)).toBe(true);
    expect(out.confidence).toBe(0);
  });
});

describe("compareMetrics ±10% divergent", () => {
  const base = { plays: 10000, likes: 500, comments: 100, shares: 50, follows: 2000 };

  it("差异 ≤10% 不标记", () => {
    const rep = compareMetrics(base, { ...base, plays: 10900 }); // 9%
    expect(rep.divergent).toBe(false);
    expect(rep.diffs.find((d) => d.metric === "plays")!.diffRatio).toBeCloseTo(0.09, 2);
  });

  it("差异 >10% 标记 divergent", () => {
    const rep = compareMetrics(base, { ...base, plays: 11200 }); // 约 10.7%（以 max 为分母）
    expect(rep.divergent).toBe(true);
    expect(rep.diffs.find((d) => d.metric === "plays")!.divergent).toBe(true);
  });

  it("任一侧 null 不可比 → divergent=false 且 diffRatio=null（不伪造差异）", () => {
    const rep = compareMetrics(base, { plays: null, likes: 500, comments: 100, shares: 50, follows: 2000 });
    const d = rep.diffs.find((x) => x.metric === "plays")!;
    expect(d.diffRatio).toBeNull();
    expect(d.divergent).toBe(false);
    expect(rep.divergent).toBe(false);
  });

  it("双侧均 0 视为无差异（防除零）", () => {
    const rep = compareMetrics({ ...base, shares: 0 }, { ...base, shares: 0 });
    expect(rep.diffs.find((d) => d.metric === "shares")!.divergent).toBe(false);
  });

  it("自定义容差生效", () => {
    const rep = compareMetrics(base, { ...base, likes: 400 }, 0.05); // 20% > 5%
    expect(rep.diffs.find((d) => d.metric === "likes")!.divergent).toBe(true);
  });
});
