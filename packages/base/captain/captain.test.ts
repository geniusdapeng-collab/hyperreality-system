/**
 * 数字CEO（D21）单元测试：治理状态机 / 试用降档 / 五级路由 / 裁决策略 / 熔断 / 请示单依据链强制
 * 全部为纯函数测试（无 PG 依赖）。
 */
import { describe, expect, it } from "vitest";
import {
  defaultCharter, parseCharter, transition, canExecute, isShadow, isExpired,
  effectiveAutonomy, evalCircuitBreaker, tightenAutonomy,
} from "./charter.js";
import { routeTier, decideForCaptain } from "./router.js";
import { buildMemo, composeBriefing, type BriefFacts } from "./briefing.js";

const granted = () => transition(defaultCharter(), {
  kind: "grant",
  grant: {
    event_id: "E-G1", granted_by: "MEM-001", granted_at: new Date().toISOString(),
    disclosure_version: "risk-v1", clauses: ["自主调价", "自主采购", "试用降档规则"],
    shadow_days: 3, trial_days: 7, trial_ends_at: null, retain_until: null,
  },
});

describe("治理状态机（§12.1）", () => {
  it("默认关闭；disabled 无执行权、非影子", () => {
    const c = defaultCharter();
    expect(c.mode).toBe("disabled");
    expect(canExecute(c.mode)).toBe(false);
    expect(isShadow(c.mode)).toBe(false);
  });

  it("grant → shadow → trial → 到期 suspended；keep_long → active；revoke → suspended；close → disabled", () => {
    let c = granted();
    expect(c.mode).toBe("shadow");
    c = transition(c, { kind: "advance" });
    expect(c.mode).toBe("trial");
    expect(c.grant?.trial_ends_at).toBeTruthy();
    c = transition(c, { kind: "expire" });
    expect(c.mode).toBe("suspended");
    c = transition(c, { kind: "keep_long" });
    expect(c.mode).toBe("active");
    expect(canExecute(c.mode)).toBe(true);
    c = transition(c, { kind: "revoke" });
    expect(c.mode).toBe("suspended");
    c = transition(c, { kind: "close" });
    expect(c.mode).toBe("disabled");
  });

  it("非法迁移被拒（重复授权/跳级/未启用撤回）", () => {
    expect(() => transition(granted(), { kind: "grant", grant: granted().grant! })).toThrow();
    expect(() => transition(defaultCharter(), { kind: "advance" })).toThrow();
    expect(() => transition(defaultCharter(), { kind: "revoke" })).toThrow();
  });

  it("到期判定：trial_ends_at / retain_until 到期即真", () => {
    let c = transition(granted(), { kind: "advance" });
    c.grant!.trial_ends_at = new Date(Date.now() - 1000).toISOString();
    expect(isExpired(c)).toBe(true);
    let a = transition(transition(c, { kind: "expire" }), { kind: "keep_until", until: new Date(Date.now() - 1000).toISOString() });
    expect(isExpired(a)).toBe(true);
  });
});

describe("试用期降档 overlay（§12.1）", () => {
  it("trial 态三上限减半、价格带向 1 收窄一半；active 态原样", () => {
    const t = transition(granted(), { kind: "advance" });
    const eff = effectiveAutonomy(t);
    expect(eff.procurement_cap).toBe(2500);
    expect(eff.price_band[0]).toBeCloseTo(0.925, 3);
    expect(eff.price_band[1]).toBeCloseTo(1.075, 3);
    const a = transition(transition(t, { kind: "expire" }), { kind: "keep_long" });
    expect(effectiveAutonomy(a).procurement_cap).toBe(5000);
  });
});

describe("五级审批路由（方案 §三）", () => {
  const c = transition(transition(granted(), { kind: "advance" }), { kind: "expire" });
  const active = transition(c, { kind: "keep_long" });

  it("价格带内 → L2；带外 → L4；围栏放宽/宪章变更 → 一律 L4；跨区 → L3", () => {
    expect(routeTier(active, { action: "price.adjust", params: {}, priceCtx: { afterPrice: 500, basePrice: 458 } })).toBe("l2_captain");
    expect(routeTier(active, { action: "price.adjust", params: {}, priceCtx: { afterPrice: 600, basePrice: 458 } })).toBe("l4_chairman");
    expect(routeTier(active, { action: "fence.patch", params: {}, isFenceWiden: true })).toBe("l4_chairman");
    expect(routeTier(active, { action: "charter.update", params: {}, isCharterChange: true })).toBe("l4_chairman");
    expect(routeTier(active, { action: "inventory.transfer", params: {}, crossWorkspace: true })).toBe("l3_fleet");
  });

  it("金额超自治上限 → L4；试用降档后上限同步收紧", () => {
    expect(routeTier(active, { action: "procurement.create", params: {}, amountCtx: { amount: 6000 } })).toBe("l4_chairman");
    expect(routeTier(active, { action: "procurement.create", params: {}, amountCtx: { amount: 3000 } })).toBe("l2_captain");
    const trial = transition(granted(), { kind: "advance" });
    expect(routeTier(trial, { action: "procurement.create", params: {}, amountCtx: { amount: 3000 } })).toBe("l4_chairman"); // 降档后 2500 上限
  });
});

describe("公司CEO 裁决策略（router.decideForCaptain）", () => {
  const active = transition(transition(granted(), { kind: "advance" }), { kind: "expire" });
  const c = transition(active, { kind: "keep_long" });
  const base = { approvalId: "a1", eventId: "E-1", action: "price.adjust", params: {}, ruleIds: ["R1"], title: "调价" };

  it("带内 approve / 贴边 escalate / 带外 escalate（路由兜底）/ 无判据 escalate（保守默认）", () => {
    expect(decideForCaptain(c, { ...base, priceCtx: { afterPrice: 480, basePrice: 458 } }).kind).toBe("approve");
    expect(decideForCaptain(c, { ...base, priceCtx: { afterPrice: 396, basePrice: 458 } }).kind).toBe("escalate"); // 0.865 贴边
    expect(decideForCaptain(c, { ...base, priceCtx: { afterPrice: 600, basePrice: 458 } }).kind).toBe("escalate");
    expect(decideForCaptain(c, { ...base, action: "misc.op" }).kind).toBe("escalate");
  });

  it("金额 70% 内 approve / 70-100% escalate", () => {
    expect(decideForCaptain(c, { ...base, action: "procurement.create", amountCtx: { amount: 2000 } }).kind).toBe("approve");
    expect(decideForCaptain(c, { ...base, action: "procurement.create", amountCtx: { amount: 4000 } }).kind).toBe("escalate");
  });
});

describe("自治熔断（方案 §六）", () => {
  it("KPI 跌破下限 → tripped；tightenAutonomy 收紧一档且置 tightened；已收紧不重复", () => {
    const c = defaultCharter();
    const v = evalCircuitBreaker(c, { occ: 0.62 });
    expect(v.tripped).toBe(true);
    expect(v.metric).toBe("occ");
    const t = tightenAutonomy(c);
    expect(t.autonomy.procurement_cap).toBe(2500);
    expect(t.circuit_breaker.tightened).toBe(true);
    expect(evalCircuitBreaker(t, { occ: 0.62 }).alreadyTightened).toBe(true);
  });

  it("KPI 未破线 → 不触发", () => {
    expect(evalCircuitBreaker(defaultCharter(), { occ: 0.83 }).tripped).toBe(false);
  });
});

describe("Decision Memo 依据链强制（治理 §九.3）", () => {
  it("空 basis 拒绝生成；正常生成含推荐标星", () => {
    expect(() => buildMemo({ title: "t", situation: "s", options: [], recommendation: "r", basis: [] })).toThrow("依据链强制");
    const m = buildMemo({
      title: "调价", situation: "OCC 落后", options: [{ label: "批准", recommended: true }, { label: "驳回" }],
      recommendation: "批准", basis: ["goal.tracking 偏差 6pt"],
    });
    expect(m.options[0]?.recommended).toBe(true);
    expect(m.basis).toHaveLength(1);
  });
});

describe("简报模板合成（via=rule 数字全真）", () => {
  it("四层结构含 L4 请示计数与溯源声明", () => {
    const facts: BriefFacts = {
      kpi: { 事件库规模: "100 条" }, actionsTop: [{ action: "price.adjust", n: 5 }],
      pendingByTier: { l2_captain: 2, l4_chairman: 1 }, incidents: 0,
    };
    const text = composeBriefing("daily", facts, "公司CEO");
    expect(text).toContain("晨报");
    expect(text).toContain("L4 请示董事长 1 件");
    expect(text).toContain("可下钻溯源");
  });
});

describe("宪章解析健壮性", () => {
  it("空档/脏档 → 默认 disabled 宪章", () => {
    expect(parseCharter(undefined).mode).toBe("disabled");
    expect(parseCharter({ mode: "bogus" }).mode).toBe("disabled");
  });
});
