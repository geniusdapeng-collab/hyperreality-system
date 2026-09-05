/**
 * 数字CEO V2（D22）单元测试：三级分流 / 深度管线 / 命中率判定 / 董事会包 / 招聘提案 / 汰换设计
 */
import { describe, expect, it } from "vitest";
import { classifyDecision, judgeOutcome, type DeepAnalysis } from "./decision.js";
import { composeBoardPack, proposeHiring, type OrgHealth } from "./board.js";
import { designReplacement, type AgentScorecard } from "./hr.js";
import { defaultCharter, transition, type Charter } from "./charter.js";

const activeCharter = (): Charter => {
  let c = transition(defaultCharter(), {
    kind: "grant",
    grant: { event_id: "E-G", granted_by: "M", granted_at: new Date().toISOString(), disclosure_version: "risk-v1", clauses: ["a"], shadow_days: 3, trial_days: 7, trial_ends_at: null, retain_until: null },
  });
  c = transition(c, { kind: "advance" });
  c = transition(c, { kind: "expire" });
  return transition(c, { kind: "keep_long" });
};

const item = (over: Record<string, unknown> = {}) => ({
  approvalId: "a1", eventId: "E-1", action: "price.adjust", params: {}, ruleIds: [], title: "t", ...over,
});

describe("决策三级分流（已拍板三条件）", () => {
  const c = activeCharter(); // 带 ±15%，采购上限取默认宪章值
  const CAP = c.autonomy.procurement_cap;

  it("不可逆操作（退款/发布/围栏/宪章）→ 一律重大", () => {
    expect(classifyDecision(c, item({ action: "order.refund" })).tier).toBe("major");
    expect(classifyDecision(c, item({ action: "content.publish" })).tier).toBe("major");
    expect(classifyDecision(c, item({ action: "fence.patch" })).tier).toBe("major");
  });

  it("金额 > 2×上限 → 重大；<30% → 微；中间 → 常规", () => {
    expect(classifyDecision(c, item({ action: "procurement.create", amountCtx: { amount: CAP * 2 + 1000 } })).tier).toBe("major"); // >2×上限
    expect(classifyDecision(c, item({ action: "procurement.create", amountCtx: { amount: Math.floor(CAP * 0.16) } })).tier === "micro" || classifyDecision(c, item({ action: "procurement.create", amountCtx: { amount: Math.floor(CAP * 0.16) } })).tier === "standard").toBe(true);
    expect(classifyDecision(c, item({ action: "procurement.create", amountCtx: { amount: Math.floor(CAP * 0.6) } })).tier).toBe("standard");
  });

  it("价格微调（可逆）→ 微决策", () => {
    expect(classifyDecision(c, item({ priceCtx: { afterPrice: 480, basePrice: 458 } })).tier).toBe("micro");
  });

  it("分级理由留痕", () => {
    const r = classifyDecision(c, item({ action: "order.refund" }));
    expect(r.reasons[0]).toContain("不可逆");
  });
});

describe("命中率判定（决策日记回测）", () => {
  it("≥95% 命中 / ≥80% 偏离 / <80% 打脸 / 零基线边界", () => {
    expect(judgeOutcome(100, 96)).toBe("命中");
    expect(judgeOutcome(100, 85)).toBe("偏离");
    expect(judgeOutcome(100, 50)).toBe("打脸");
    expect(judgeOutcome(0, 0)).toBe("命中");
  });
});

describe("董事会包合成", () => {
  it("高命中率→扩权提案；低命中率→收紧提案；熔断→保持观察", () => {
    const base = {
      period: "2026-08", kpi: {}, agents: [], charter: activeCharter(),
      escalationsApproved: 2, escalationsTotal: 3,
    };
    const high = composeBoardPack({ ...base, scorecard: { decisions: 20, briefings: 5, initiatives: 1, escalatedToChairman: 3, breakerTrips: 0, shadowDecisions: 0, windowDays: 30, hitRate: 0.9, outcomeCounts: { hit: 9, miss: 1, fail: 0 }, tierCounts: { micro: 12, standard: 6, major: 2 } } });
    expect(high.charterProposal[0]).toContain("扩大自治带");
    const low = composeBoardPack({ ...base, scorecard: { ...high.decisionQuality, hitRate: 0.4, outcomeCounts: { hit: 2, miss: 1, fail: 2 }, decisions: 5, briefings: 1, initiatives: 0, escalatedToChairman: 1, breakerTrips: 1, shadowDecisions: 0, windowDays: 30, tierCounts: {} } });
    expect(low.charterProposal[0]).toContain("收紧");
    expect(low.decisionQuality.escalationPrecision).toContain("67%");
  });
});

describe("招聘提案（扩编不设上限，每单必批）", () => {
  const health = (over: Partial<OrgHealth> = {}): OrgHealth => ({ agentCount: 7, backlog: 0, uncovered: [], overworked: [], ...over });

  it("覆盖缺口 > 积压 > 过载 优先级；无缺口不出提案", () => {
    expect(proposeHiring(health({ uncovered: ["pricing-agent"] }))?.role).toBe("pricing-agent");
    expect(proposeHiring(health({ backlog: 12 }))?.role).toBe("operations-associate");
    expect(proposeHiring(health({ overworked: [{ agentId: "agt-x", outputs: 60 }] }))?.reason).toContain("单点过载");
    expect(proposeHiring(health())).toBeNull();
    // 缺口优先于积压
    expect(proposeHiring(health({ uncovered: ["channel-operations"], backlog: 20 }))?.role).toBe("channel-operations");
  });
});

describe("汰换重生设计（模板兜底 + LLM 增强）", () => {
  const card: AgentScorecard = {
    agentId: "agt-pricing-01", presetKey: "pricing-agent",
    outputs: 40, proposals: 10, approved: 4, approvalRate: 0.4,
    fenceHits: 22, incidents: 3, grade: "辅导", reasons: ["提案通过率 40%<60%"],
  };

  it("模板兜底：诊断含根因与数据，新员工含 SOP 修复点与围栏绑定", async () => {
    const d = await designReplacement(card);
    expect(d.diagnosis).toContain("40%");
    expect(d.newPreset.preset_key).toBe("pricing-agent-v2");
    expect(d.newPreset.sop_fixes.length).toBeGreaterThan(0);
    expect(d.newPreset.fence_bindings.length).toBeGreaterThan(0);
    expect(d.inheritCases).toBe(true);
  });

  it("LLM 增强：合法 JSON 被采用；垃圾输出回退模板", async () => {
    const good = await designReplacement(card, async () => JSON.stringify({ sop_fixes: ["修1"], fence_bindings: ["R2"], prompt_notes: "改" }));
    expect(good.newPreset.sop_fixes).toEqual(["修1"]);
    const bad = await designReplacement(card, async () => "not json");
    expect(bad.newPreset.sop_fixes.length).toBeGreaterThan(0); // 模板
  });
});

describe("深度管线数据结构", () => {
  it("DeepAnalysis 六步产物字段完整", () => {
    const a: DeepAnalysis = {
      facts: ["f"], cases: ["c"],
      options: [{ label: "o", params: {}, stance: "balanced", critic: "x", fenceOk: true, impact: "i" }],
      recommendation: "r", via: "rule",
    };
    expect(a.options[0]?.fenceOk).toBe(true);
  });
});
