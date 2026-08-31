/**
 * 路由质量周报测试（v3.0 下一迭代）：事件聚合 → 升级率 → 调表建议
 */
import { describe, expect, it } from "vitest";
import { buildRouterReview } from "./router-review.js";

describe("buildRouterReview（场景升级率聚合）", () => {
  it("model.call 计生成量、👎 feedback 计升级，>15% 场景进调表清单", () => {
    const events = [
      // cs-answer：10 生成 2 升级（20% → 调）
      ...Array.from({ length: 10 }, () => ({ action: "model.call", after: { scene: "cs-answer" } })),
      ...Array.from({ length: 2 }, () => ({ action: "model.feedback", after: { scene: "cs-answer", thumbs: "down" } })),
      // quest-plan：20 生成 1 升级（5% → 留）
      ...Array.from({ length: 20 }, () => ({ action: "model.call", after: { scene: "quest-plan" } })),
      { action: "model.feedback", after: { scene: "quest-plan", thumbs: "down" } },
      // 👍 不计升级；无 scene 事件忽略
      { action: "model.feedback", after: { scene: "quest-plan", thumbs: "up" } },
      { action: "model.call", after: {} },
    ];
    const r = buildRouterReview(events as never);
    expect(r.totalGenerations).toBe(30);
    expect(r.totalEscalations).toBe(3);
    expect(r.raiseTierScenes).toEqual(["cs-answer"]);
    expect(r.scenes[0]!.scene).toBe("cs-answer"); // 按升级率降序
    expect(r.scenes.find((s) => s.scene === "quest-plan")!.recommendation).toBe("keep");
  });

  it("无数据场景不出现在报告；整体升级率口径正确", () => {
    const r = buildRouterReview([]);
    expect(r.totalGenerations).toBe(0);
    expect(r.overallRate).toBe(0);
    expect(r.raiseTierScenes).toEqual([]);
  });
});
