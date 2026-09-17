/**
 * wizard 状态机与编排契约测试（纯函数，无需 DB）
 */
import { describe, it, expect } from "vitest";
import {
  assertTransition, canTransition, wizardSteps, canActivate, failedChecks,
  activationProfile, canSendFeedback, DELIVERY_STEPS, exampleCustomizeSteps,
  type ActivationChecklist, type FeedbackReport,
} from "./wizard.js";

describe("wizard 状态机", () => {
  it("合法迁移放行", () => {
    expect(() => assertTransition("welcome", "industry_select")).not.toThrow();
    expect(() => assertTransition("industry_select", "research")).not.toThrow();
    expect(() => assertTransition("research", "design")).not.toThrow();
    expect(() => assertTransition("design", "delivery")).not.toThrow();
    expect(() => assertTransition("delivery", "need_info")).not.toThrow();
    expect(() => assertTransition("need_info", "delivery")).not.toThrow();
    expect(() => assertTransition("delivery", "exam")).not.toThrow();
    expect(() => assertTransition("exam", "activated")).not.toThrow();
    expect(() => assertTransition("activated", "handover")).not.toThrow();
  });

  it("非法迁移拒绝：不允许跳过 design 直接从 research 到 delivery", () => {
    expect(() => assertTransition("research", "delivery")).toThrow(/非法迁移/);
    expect(canTransition("welcome", "activated")).toBe(false);
    expect(canTransition("handover", "welcome")).toBe(false);
  });

  it("快速通道可从行业选择直达交付配置（跳过调研）", () => {
    expect(canTransition("industry_select", "delivery")).toBe(true);
  });

  it("paused 可断点续跑回到任一挂起点", () => {
    for (const s of ["welcome", "industry_select", "research", "design", "delivery", "need_info"] as const) {
      expect(canTransition("paused", s)).toBe(true);
    }
  });
});

describe("向导步骤序列（无排期）", () => {
  it("完整通道深度模式含 research 与 design", () => {
    const steps = wizardSteps({ path: "full", mode: "deep", industry: "餐饮" });
    expect(steps).toEqual(["welcome", "industry_select", "staffing", "research", "design", "delivery", "exam", "activated", "handover"]);
  });
  it("快速通道与快速上线模式跳过调研", () => {
    expect(wizardSteps({ path: "fast" })).not.toContain("research");
    expect(wizardSteps({ path: "full", mode: "quick", industry: "美业" })).not.toContain("design");
  });
  it("交付配置为六步契约", () => {
    expect(DELIVERY_STEPS).toEqual(["assets", "archive", "authz", "fences", "precheck", "activate"]);
  });

  it("V4 新状态：示例明示/一键清空/编制生成/上岗考迁移合法", () => {
    expect(() => assertTransition("welcome", "example_notice")).not.toThrow();
    expect(() => assertTransition("example_notice", "industry_select")).not.toThrow();
    expect(() => assertTransition("industry_select", "clear_example")).not.toThrow();
    expect(() => assertTransition("clear_example", "industry_select")).not.toThrow();
    expect(() => assertTransition("industry_select", "staffing")).not.toThrow();
    expect(() => assertTransition("staffing", "delivery")).not.toThrow();
    expect(() => assertTransition("exam", "delivery")).not.toThrow();   // 未达标回炉
    // 非法：跳过上岗考直接激活
    expect(() => assertTransition("delivery", "activated")).toThrow(/非法迁移/);
    // 示例版定制序列
    expect(exampleCustomizeSteps()).toContain("clear_example");
    expect(exampleCustomizeSteps()).toContain("exam");
  });
});

describe("激活门禁", () => {
  const allGreen: ActivationChecklist = {
    archiveReady: true, enumsReady: true, toolsReady: true, fencesReady: true, uiReady: true, approved: true,
  };
  it("全绿才允许激活", () => {
    expect(canActivate(allGreen)).toBe(true);
  });
  it("任一红灯禁止激活", () => {
    expect(canActivate({ ...allGreen, fencesReady: false })).toBe(false);
    expect(canActivate({ ...allGreen, approved: false })).toBe(false);
    expect(failedChecks({ ...allGreen, uiReady: false })).toEqual(["uiReady"]);
  });
});

describe("能力裁剪激活（D18）", () => {
  it("community 版裁剪夜班/巡检/Quest自治，向导不中断", () => {
    const p = activationProfile("community");
    expect(p.enabled).toContain("approvals");
    expect(p.lockedPendingUpgrade).toContain("night-shift");
    expect(p.lockedPendingUpgrade).toContain("inspection");
    expect(p.lockedPendingUpgrade).toContain("quest");
  });
  it("vpc 版全量解锁", () => {
    expect(activationProfile("vpc").lockedPendingUpgrade).toEqual([]);
  });
});

describe("反哺上报四红线（D19）", () => {
  const ok: FeedbackReport = { optIn: true, previewed: true, desensitized: true, logged: true, body: "缺口描述" };
  it("四红线齐备才允许发送", () => {
    expect(canSendFeedback(ok)).toBe(true);
  });
  it.each(["optIn", "previewed", "desensitized", "logged"] as const)("缺 %s 禁止发送", (k) => {
    expect(canSendFeedback({ ...ok, [k]: false })).toBe(false);
  });
  it("空报文禁止发送", () => {
    expect(canSendFeedback({ ...ok, body: "" })).toBe(false);
  });
});
