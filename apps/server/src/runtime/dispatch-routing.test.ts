/**
 * 派活岗位路由回归（N-13 第三轮实测）：
 * geo/hotel 工作区的通用 orchestrator 清单顺序不能决定派给谁——按任务语义选岗。
 */
import { describe, expect, it } from "vitest";
import { preferredDispatchPresets } from "./dispatch-routing.js";

describe("派活岗位路由（N-13）", () => {
  it("生图/海报类目标 → 视觉岗位优先", () => {
    const list = preferredDispatchPresets({ goal: "生成一张门店周年庆促销海报", industry: "geo-growth" });
    expect(list[0]).toBe("visual-designer");
  });

  it("调价类目标 → 定价岗位优先（不再是生产编排/晨报岗位）", () => {
    const list = preferredDispatchPresets({ goal: "把雅致大床房调价到 510 元", industry: "hotel" });
    expect(list[0]).toBe("pricing-agent");
    expect(list).not.toContain("production-planner");
  });

  it("增长复盘类目标 → 增长负责人优先（geo 工作区）", () => {
    const list = preferredDispatchPresets({ goal: "整理获客漏斗周报，复盘渠道转化", industry: "geo-growth" });
    expect(list[0]).toBe("growth-lead");
  });

  it("视频类目标 → 导演/生产编排优先", () => {
    const list = preferredDispatchPresets({ goal: "做一条 30 秒抖音种草短片", industry: "ai-video" });
    expect(list.slice(0, 2)).toContain("director");
  });

  it("未命中任何语义 → 回落行业默认指挥岗位", () => {
    const list = preferredDispatchPresets({ goal: "处理一下积压的事", industry: "geo-growth" });
    expect(list[0]).toBe("growth-lead");
  });
});
