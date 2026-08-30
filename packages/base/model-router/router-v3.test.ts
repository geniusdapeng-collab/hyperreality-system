/**
 * v3.0 通用模型路由系统测试：
 * 三档体系与套餐映射 / model-policy.yml 解析校验 / 模型池与降级链 / 真实积分计量 /
 * 三池账本 / routeSmart 全链路（场景×套餐×复杂度×降级语义）/ 升级重答与配额 / 自动调表
 */
import { describe, expect, it } from "vitest";
import { MockProvider } from "./providers.js";
import {
  DEFAULT_MODEL_POLICY, legacyTierToTier3, parseModelPolicy, resolveTier, shiftTier,
  tierDown, tierUp, type ModelPolicy,
} from "./policy.js";
import { MODEL_CATALOG, catalogByTier, chainFor, poolFromEnv } from "./pool.js";
import { balance, computeCredits, deduct, grant, projectLedger, type CreditLedger } from "./credits.js";
import { MemoryQuotaStore, autoTuneScenes, escalate, tierAfterEscalation } from "./feedback.js";
import { routeSmart, type EventSink, type SmartTask } from "./router.js";

function memSink() {
  const traces: any[] = [];
  const degrades: any[] = [];
  const breaks_: any[] = [];
  const feedbacks: any[] = [];
  const sink: EventSink = {
    recordModelTrace: async (t) => { traces.push(t); },
    recordDegradation: async (d) => { degrades.push(d); },
    recordCircuitBreak: async (d) => { breaks_.push(d); },
    recordFeedback: async (f) => { feedbacks.push(f); },
  };
  return { sink, traces, degrades, breaks_, feedbacks };
}

const mockPool = (over: Record<string, { failFirst?: number; down?: boolean }> = {}) =>
  new Map(MODEL_CATALOG.map((m) => [m.id, new MockProvider(m.id, over[m.id])]));

const task = (over: Partial<SmartTask> = {}): SmartTask => ({
  action: "cs-answer", scene: "cs-answer",
  messages: [{ role: "user", content: "WiFi 密码是多少？" }],
  ...over,
});

/* ================= 三档体系与套餐映射 ================= */

describe("三档体系（L1/L2/L3）与套餐默认映射", () => {
  it("档位代数：升/降/位移，越界截断", () => {
    expect(tierUp("L1")).toBe("L2");
    expect(tierUp("L3")).toBeNull();
    expect(tierDown("L2")).toBe("L1");
    expect(shiftTier("L2", -1)).toBe("L1");
    expect(shiftTier("L1", -1)).toBe("L1");
    expect(shiftTier("L2", 1)).toBe("L3");
    expect(legacyTierToTier3("flagship")).toBe("L3");
    expect(legacyTierToTier3("standard")).toBe("L2");
  });

  it("套餐映射：智享压一档 / 标准原位 / 智能抬一档；点名覆盖优先", () => {
    const p = DEFAULT_MODEL_POLICY;
    expect(resolveTier(p, "quest-plan", "lite")).toBe("L1");      // L2 → 压一档
    expect(resolveTier(p, "quest-plan", "standard")).toBe("L2");
    expect(resolveTier(p, "quest-plan", "smart")).toBe("L3");      // L2 → 抬一档
    expect(resolveTier(p, "cs-answer", "smart")).toBe("L2");       // 智能版点名：客服保底 L2
    expect(resolveTier(p, "intent-classify", "smart")).toBe("L1"); // 延迟红线保持 L1
  });

  it("noDowngrade 质量红线：套餐下压不得生效", () => {
    expect(resolveTier(DEFAULT_MODEL_POLICY, "ceo-deep-analysis", "lite")).toBe("L3");
    expect(resolveTier(DEFAULT_MODEL_POLICY, "fast-scan-report", "lite")).toBe("L3");
  });
});

/* ================= model-policy.yml 解析与校验 ================= */

describe("model-policy.yml（bundle 第⑦槽）解析校验", () => {
  it("合法文件：行业场景覆盖底座默认，未点名场景继承", () => {
    const { policy, issues } = parseModelPolicy(`
version: "v3.0"
scenes:
  cs-answer: { tier: L1, escalateOn: [low-confidence, thumbs-down] }
  debate: { tier: L3, noDowngrade: true, fallback: passthrough-disclose }
plans:
  smart: { defaultShift: 1, tierOverrides: { cs-answer: L2 } }
`);
    expect(issues).toEqual([]);
    expect(policy!.scenes["debate"]!.fallback).toBe("passthrough-disclose");
    expect(policy!.scenes["quest-plan"]).toBeDefined(); // 继承底座
    expect(resolveTier(policy!, "cs-answer", "smart")).toBe("L2");
  });

  it("非法 tier / 非法 fallback / 覆盖未定义场景 → 逐条报错", () => {
    const { policy, issues } = parseModelPolicy(`
scenes:
  a: { tier: L9 }
  b: { tier: L1, fallback: whatever }
plans:
  smart: { defaultShift: 1, tierOverrides: { ghost: L2 } }
`);
    expect(policy).toBeNull();
    expect(issues.length).toBe(3);
    expect(issues.join()).toContain("L9");
    expect(issues.join()).toContain("ghost");
  });
});

/* ================= 模型池与降级链 ================= */

describe("国产三档模型池", () => {
  it("目录：每档三家互备（L1/L2/L3 各 3 款）", () => {
    expect(catalogByTier("L1").length).toBe(3);
    expect(catalogByTier("L2").length).toBe(3);
    expect(catalogByTier("L3").length).toBe(3);
  });

  it("降级链：同档优先，跨档兜底；长文需求长文款前置；禁跨档时截断", () => {
    const l2 = chainFor("L2");
    expect(l2.slice(0, 3)).toEqual(["deepseek-v4-pro", "glm-5.2", "minimax-m3"]);
    expect(l2.length).toBeGreaterThan(3); // 跨档兜底 L1
    const noCross = chainFor("L3", { allowCrossTier: false });
    expect(noCross).toEqual(["glm-5.3", "kimi-k3", "qwen-3.8-max"]);
    const longFirst = chainFor("L1", { longContext: true });
    expect(longFirst.length).toBe(3 + 0); // L1 无 longContext 标记，顺序不变
  });

  it("mock 模式全池确定性可跑（D4 离线保险丝）", () => {
    const pool = poolFromEnv();
    expect(pool.size).toBe(MODEL_CATALOG.length);
  });
});

/* ================= 积分计量与三池账本 ================= */

describe("积分计量（1 积分 = 1,000 tokens L2 基准）", () => {
  it("倍率：L1 0.2× / L2 1× / L3 3×；谷时再 ×0.2", () => {
    expect(computeCredits({ tier: "L2", promptTokens: 2000, completionTokens: 1000, window: "peak" })).toBe(3);
    expect(computeCredits({ tier: "L1", promptTokens: 2000, completionTokens: 1000, window: "peak" })).toBe(0.6);
    expect(computeCredits({ tier: "L3", promptTokens: 2000, completionTokens: 1000, window: "peak" })).toBe(9);
    expect(computeCredits({ tier: "L3", promptTokens: 2000, completionTokens: 1000, window: "off-peak" })).toBe(1.8);
    expect(computeCredits({ tier: "L1", promptTokens: 1, completionTokens: 1, window: "peak" })).toBe(0.01); // 下限
  });
});

describe("三池账本（赠送→加油包→本金，先扣先到期）", () => {
  const at = new Date("2026-08-31T00:00:00Z");
  it("扣减顺序与过期冻结", () => {
    let ledger: CreditLedger = [];
    ledger = grant(ledger, "principal", 20000, at);
    ledger = grant(ledger, "pack", 5000, at);
    ledger = grant(ledger, "gift", 5000, at);
    expect(ledger.map((p) => p.name)).toEqual(["gift", "pack", "principal"]);
    const r = deduct(ledger, 7000, at);
    expect(r.deductions).toEqual([{ pool: "gift", amount: 5000 }, { pool: "pack", amount: 2000 }]);
    expect(r.shortfall).toBe(0);
    expect(balance(r.ledger, at)).toBe(23000);
  });

  it("欠费出缺口；过期池不扣", () => {
    let ledger: CreditLedger = [{ name: "gift", amount: 100, expiresAt: "2026-01-01T00:00:00Z" }];
    const r = deduct(ledger, 500, at);
    expect(r.shortfall).toBe(500); // gift 已过期冻结
    expect(balance(ledger, at)).toBe(0);
  });

  it("账本=事件投影（grant/purchase 入，model.call 出），不重算", () => {
    const mid = new Date("2026-08-15T00:00:00Z"); // 赠送池 30 天有效期内
    const ledger = projectLedger([
      { action: "credits.grant", after: { amount: 5000 }, time: "2026-08-01T00:00:00Z" },
      { action: "credits.purchase", after: { amount: 20000, pool: "principal" }, time: "2026-08-02T00:00:00Z" },
      { action: "model.call", model_trace: { credits: 3000 } },
      { action: "model.call", model_trace: { credits: 2500 } },
    ], mid);
    // 先扣赠送 5000，再扣本金 500
    expect(balance(ledger, mid)).toBe(19500);
  });
});

/* ================= routeSmart 全链路 ================= */

describe("routeSmart（场景 × 套餐 × 复杂度 × 真实计量）", () => {
  it("场景表路由：cs-answer 走 L1 档模型，真实 token 计量", async () => {
    const { sink, traces } = memSink();
    const r = await routeSmart(task(), mockPool(), sink);
    expect(r.kind).toBe("answered");
    expect(r.tier).toBe("L1");
    expect(catalogByTier("L1").map((m) => m.id)).toContain(r.modelTrace!.model_id);
    expect(traces[0].credits).toBeGreaterThan(0);
    expect(traces[0].scene).toBe("cs-answer");
  });

  it("套餐映射生效：智享版 quest-plan 压到 L1，智能版抬到 L3", async () => {
    const { sink: s1 } = memSink();
    const lite = await routeSmart(task({ action: "quest-plan", scene: "quest-plan", plan: "lite" }), mockPool(), s1);
    expect(lite.tier).toBe("L1");
    const { sink: s2 } = memSink();
    const smart = await routeSmart(task({ action: "quest-plan", scene: "quest-plan", plan: "smart" }), mockPool(), s2);
    expect(smart.tier).toBe("L3");
  });

  it("noDowngrade 场景（ceo-deep-analysis）：智享版仍 L3，降级链截断跨档段", async () => {
    const { sink, degrades } = memSink();
    const pool = mockPool({ "glm-5.3": { down: true }, "kimi-k3": { down: true } });
    const r = await routeSmart(
      task({ action: "ceo-deep-analysis", scene: "ceo-deep-analysis", plan: "lite" }), pool, sink);
    expect(r.tier).toBe("L3");
    expect(r.modelTrace!.model_id).toBe("qwen-3.8-max"); // 同档第三互备，未降档
    expect(degrades.every((d) => catalogByTier("L3").some((m) => m.id === d.from))).toBe(true);
  });

  it("金融口径 passthrough-disclose：全链不可用 → 透传披露，不降档不猜测", async () => {
    const policy: ModelPolicy = {
      ...DEFAULT_MODEL_POLICY,
      scenes: { ...DEFAULT_MODEL_POLICY.scenes, debate: { tier: "L3", noDowngrade: true, fallback: "passthrough-disclose" } },
    };
    const { sink } = memSink();
    const pool = mockPool({ "glm-5.3": { down: true }, "kimi-k3": { down: true }, "qwen-3.8-max": { down: true } });
    const r = await routeSmart(task({ action: "debate", scene: "debate" }), pool, sink, { policy });
    expect(r.kind).toBe("unavailable");
    expect(r.passthrough).toBe(true);
  });

  it("复杂度信号：超长输入自动升档 + 长文款前置", async () => {
    const { sink, traces } = memSink();
    const big = "长".repeat(5000); // 超 L1 天花板 4000 → 升 L2，且 deepseek-v4-pro 长文款在前
    const r = await routeSmart(task({ messages: [{ role: "user", content: big }] }), mockPool(), sink);
    expect(r.tier).toBe("L2");
    expect(traces[0].model_id).toBe("deepseek-v4-pro");
  });

  it("谷时计量 ×0.2 且 bill_to=platform 场景留痕计费归属", async () => {
    const { sink, traces } = memSink();
    const r = await routeSmart(
      task({ action: "fast-scan-report", scene: "fast-scan-report" }),
      mockPool(), sink, {}, new Date("2026-08-16T23:30:00+08:00"));
    expect(r.billTo).toBe("platform");
    expect(traces[0].bill_to).toBe("platform");
    expect(traces[0].window).toBe("off-peak");
  });

  it("降级留痕：主模型故障按链切换且每次写事件（L6.1 禁止静默）", async () => {
    const { sink, degrades, traces } = memSink();
    const pool = mockPool({ "deepseek-v4-flash": { down: true } });
    const r = await routeSmart(task(), pool, sink);
    expect(r.kind).toBe("answered");
    expect(r.modelTrace!.model_id).toBe("glm-5.3-flash");
    expect(degrades[0]).toMatchObject({ from: "deepseek-v4-flash", to: "glm-5.3-flash", reason: "unhealthy" });
    expect(traces.length).toBe(1);
  });
});

/* ================= 升级重答与反馈环 ================= */

describe("一键升级重答（👎 → 升一档重新生成）", () => {
  it("L1→L2 升级重答，首次免费并记 model.feedback 事件", async () => {
    const { sink, feedbacks } = memSink();
    const quota = new MemoryQuotaStore(1);
    const r = await escalate({
      task: task(), fromTier: "L1", providers: mockPool(), sink, quota,
    });
    expect(r.escalated).toBe(true);
    expect(r.toTier).toBe("L2");
    expect(r.freeEscalation).toBe(true);
    expect(r.kind).toBe("answered");
    expect(feedbacks[0]).toMatchObject({ thumbs: "down", original_tier: "L1", escalated_tier: "L2" });
  });

  it("配额 24h 限免 1 次：第二次重答免费额度耗尽（仍允许，实扣）", async () => {
    const { sink } = memSink();
    const quota = new MemoryQuotaStore(1);
    const t = task();
    const r1 = await escalate({ task: t, fromTier: "L1", providers: mockPool(), sink, quota });
    const r2 = await escalate({ task: t, fromTier: "L1", providers: mockPool(), sink, quota });
    expect(r1.freeEscalation).toBe(true);
    expect(r2.freeEscalation).toBe(false);
  });

  it("L3 已是天花板 → 不升级（调用方转人工/工单）", async () => {
    const { sink } = memSink();
    const r = await escalate({ task: task(), fromTier: "L3", providers: mockPool(), sink });
    expect(r.escalated).toBe(false);
    expect(tierAfterEscalation("L3")).toBeNull();
  });
});

describe("路由质量周报：场景升级率 >15% 自动建议调表", () => {
  it("autoTuneScenes：超阈值场景建议上调默认档", () => {
    const recs = autoTuneScenes([
      { scene: "cs-answer", generations: 100, escalations: 20 },   // 20% → 调
      { scene: "quest-plan", generations: 100, escalations: 5 },   // 5% → 留
      { scene: "briefing", generations: 0, escalations: 0 },       // 无数据 → 留
    ]);
    expect(recs[0]).toMatchObject({ scene: "cs-answer", recommendation: "raise-tier" });
    expect(recs.find((r) => r.scene === "quest-plan")!.recommendation).toBe("keep");
    expect(recs.find((r) => r.scene === "briefing")!.recommendation).toBe("keep");
  });
});
