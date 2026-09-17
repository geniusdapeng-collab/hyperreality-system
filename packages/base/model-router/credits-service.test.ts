/**
 * 积分账本服务测试（v3.0 商业化 P1）：
 * 加油包价目纪律 / 平台成本不扣客户积分 / 三池投影一致性 / 套餐映射
 */
import { describe, expect, it } from "vitest";
import { CREDIT_PACKS, MIN_PURCHASE_CREDITS } from "./credits-service.js";
import { balance, projectLedger } from "./credits.js";
import { planTierToPlanId } from "./policy.js";

describe("加油包价目（方案 5.5 五档阶梯）", () => {
  it("五档齐全、单积分成本随档递减、有效期口径", () => {
    expect(CREDIT_PACKS.map((p) => p.credits)).toEqual([5_000, 20_000, 50_000, 100_000, 200_000]);
    expect(CREDIT_PACKS.map((p) => p.priceYuan)).toEqual([450, 1_680, 3_900, 7_200, 13_800]);
    const units = CREDIT_PACKS.map((p) => p.unitPrice);
    for (let i = 1; i < units.length; i++) expect(units[i]!).toBeLessThan(units[i - 1]!);
    expect(units[0]).toBe(0.09);
    expect(units[4]).toBe(0.069);
  });

  it("预充值最低 2 万积分起", () => {
    expect(MIN_PURCHASE_CREDITS).toBe(20_000);
  });
});

describe("平台成本隔离（售前体检 bill_to=platform 不扣客户积分）", () => {
  it("projectLedger 跳过 platform 场景计量", () => {
    const now = new Date("2026-08-15T00:00:00Z");
    const ledger = projectLedger([
      { action: "credits.grant", after: { amount: 5000 }, time: "2026-08-01T00:00:00Z" },
      { action: "model.call", after: { bill_to: "platform" }, model_trace: { credits: 45 } }, // 体检报告：平台承担
      { action: "model.call", after: { bill_to: "tenant" }, model_trace: { credits: 10 } },
    ], now);
    expect(balance(ledger, now)).toBe(4990); // 只扣 tenant 的 10
  });
});

describe("部署档 → 商业路由档映射", () => {
  it("community→智享 / pro→标准 / teams/vpc→智能", () => {
    expect(planTierToPlanId("community")).toBe("lite");
    expect(planTierToPlanId("pro")).toBe("standard");
    expect(planTierToPlanId("teams")).toBe("smart");
    expect(planTierToPlanId("vpc")).toBe("smart");
    expect(planTierToPlanId("unknown")).toBe("standard");
  });
});
