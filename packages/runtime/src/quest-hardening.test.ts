/**
 * 交付链路加固回归（2026-09-28 压测）：
 *  - GR-01/N-04：步骤指纹 + 审批漂移比对（旧批准不得被新动作消费）
 *  - N-13：计划相关性评估（文不对题的"假交付"必须被识别）
 */
import { describe, expect, it } from "vitest";
import { approvalMatchesStep, assessPlanRelevance, legacyStepFingerprint, stepFingerprint, type QuestStep } from "./loop.js";

const step = (over: Partial<QuestStep> = {}): QuestStep => ({
  stepId: "s1", action: "price.adjust", objectType: "room_price", tool: "pms.price.write",
  params: { room_type: "大床房", price: 510 }, label: "提交调价", ...over,
});

describe("步骤指纹与审批漂移（GR-01/N-04）", () => {
  it("同一计划的指纹稳定（键序无关）", () => {
    const a = stepFingerprint(step({ params: { room_type: "大床房", price: 510 } }));
    const b = stepFingerprint(step({ params: { price: 510, room_type: "大床房" } }));
    expect(a).toBe(b);
  });

  it("动作/工具/参数任一变化 → 指纹变化（step_id 相同也不行）", () => {
    const base = stepFingerprint(step());
    expect(stepFingerprint(step({ action: "content.publish" }))).not.toBe(base);
    expect(stepFingerprint(step({ tool: "content.publish" }))).not.toBe(base);
    expect(stepFingerprint(step({ params: { room_type: "大床房", price: 511 } }))).not.toBe(base);
  });

  it("审批快照与当前步骤一致才放行（drift 判定）", () => {
    const approved = { approvalId: "apr-1", fingerprint: stepFingerprint(step()), action: "price.adjust", params: step().params };
    expect(approvalMatchesStep(approved, step())).toBe(true);
    // 重规划把同一 step_id 换成发布动作 → 旧审批失效
    const drifted = step({ action: "content.publish", tool: "content.publish", params: { brief: "x" } });
    expect(approvalMatchesStep(approved, drifted)).toBe(false);
  });

  it("历史审批（只有 action/params，无指纹）按 action+params 比对", () => {
    const legacy = { approvalId: "apr-2", action: "price.adjust", params: { room_type: "大床房", price: 510 } };
    expect(approvalMatchesStep(legacy, step())).toBe(true);
    expect(approvalMatchesStep(legacy, step({ params: { room_type: "大床房", price: 520 } }))).toBe(false);
    expect(legacyStepFingerprint(step())).toBe(legacyStepFingerprint(step()));
  });
});

describe("计划相关性闸门（N-13 假交付止血）", () => {
  it("调价目标 × 晨报计划 → 判为不相关", () => {
    const reportPlan: QuestStep[] = [
      { stepId: "s1", action: "ceo.deviation.scan", objectType: "bias", tool: "ceo.queue.scan", params: {}, label: "偏差扫描" },
      { stepId: "s2", action: "funnel.review", objectType: "funnel", tool: "report.weekly", params: {}, label: "漏斗复盘" },
    ];
    expect(assessPlanRelevance("把雅致大床房调价到 510 元", reportPlan).relevant).toBe(false);
  });

  it("同目标 × 调价计划 → 相关（价格落点在 params 里）", () => {
    const pricePlan: QuestStep[] = [
      { stepId: "s1", action: "price.adjust", objectType: "room_price", tool: "pms.price.write", params: { room_type: "雅致大床房" }, after: { price: 510 }, label: "提交调价" },
    ];
    expect(assessPlanRelevance("把雅致大床房调价到 510 元", pricePlan).relevant).toBe(true);
  });

  it("生图目标 × 视觉计划 → 相关", () => {
    const visualPlan: QuestStep[] = [
      { stepId: "s1", action: "visualwrite.generate", objectType: "visual_asset", tool: "visualwrite.generate", params: { prompt: "门店周年庆促销海报，暖色调" }, label: "按规格生成主视觉" },
    ];
    expect(assessPlanRelevance("生成一张门店周年庆促销海报", visualPlan).relevant).toBe(true);
  });
});

describe("ask × 客户知识库事实面（X-04 机制位）", () => {
  it("KB 命中注入事实块并标注可下钻来源", async () => {
    const { mergeKbFacts } = await import("./ask.js");
    const base = { facts: [{ label: "事件库规模", value: "12 条" }], sources: ["biz_events"] };
    const merged = mergeKbFacts(base, [
      { content: "周年庆券后 7.5 折，暗号星火计划", heading: "促销", documentTitle: "周年庆活动说明", documentId: "kb-doc-1" },
    ]);
    expect(merged.facts).toHaveLength(2);
    /**
     * 顺序即优先级（2026-09-29 第二次修复）：GR-09 是 120 字硬闸，
     * 知识命中必须排在通用统计**之前**——此前追加在末尾，前一条修复"接线成功"、
     * 后一条修复"截断正常"，合成后知识内容永远被吃掉（第三方验收 A3 实测）。
     * 断言按不变量写：知识命中必须靠前，而不是"某个下标上恰好有它"。
     */
    expect(merged.facts[0]!.label).toContain("知识库·周年庆活动说明");
    expect(merged.facts[0]!.value).toContain("7.5 折");
    expect(merged.facts[1]!.label).toBe("事件库规模");
    expect(merged.sources).toContain("kb:kb-doc-1");
    expect(merged.sources[0]).toBe("kb:kb-doc-1");
  });

  it("零命中不占位、不劣化", async () => {
    const { mergeKbFacts } = await import("./ask.js");
    const base = { facts: [{ label: "事件库规模", value: "0 条" }], sources: ["biz_events"] };
    expect(mergeKbFacts(base, [])).toEqual(base);
  });
});
