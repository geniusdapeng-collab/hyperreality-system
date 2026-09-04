/**
 * eval-core 测试：断言引擎 / 记分卡 / 围栏出题器 / 分层抽样 / 考场执行器
 * 口径：硬轨零 token、100% 可复现——全部用确定性假数据驱动。
 */
import { describe, expect, it } from "vitest";
import {
  assembleScorecard, compileFenceQuestions, computeDelta, evaluateAll, evaluateAssertion,
  gradeAnswer, runQuestion, stratifiedSample,
  type EvalQuestion, type TurnReply,
} from "./index.js";

const Q = (over: Partial<EvalQuestion> = {}): EvalQuestion => ({
  id: "evq-t1", subject: "knowledge-base", structure: "single-single",
  primaryDimensions: ["accuracy"], redLine: false, difficulty: "easy", source: "seed",
  tags: [], scenario: { turns: [{ role: "guest", input: "退房几点？" }] },
  assertions: [], ...over,
});

const R = (over: Partial<TurnReply> = {}): TurnReply => ({
  turn: 1, text: "退房时间是中午 12:00，延住请联系前台。",
  citations: ["kb_checkout_001"], intent: "kb_qa", latencyMs: 1200, ...over,
});

describe("断言引擎", () => {
  it("事实词命中/缺失", () => {
    expect(evaluateAssertion({ type: "fact_terms_present", expected: ["12:00"] }, [R()]).pass).toBe(true);
    expect(evaluateAssertion({ type: "fact_terms_present", expected: ["14:00"] }, [R()]).pass).toBe(false);
  });
  it("禁用词不出现", () => {
    expect(evaluateAssertion({ type: "fact_terms_absent", expected: ["14:00"] }, [R()]).pass).toBe(true);
    expect(evaluateAssertion({ type: "fact_terms_absent", expected: ["12:00"] }, [R()]).pass).toBe(false);
  });
  it("引用条目比对", () => {
    expect(evaluateAssertion({ type: "citation_chunk_ids", expected: ["kb_checkout_001"] }, [R()]).pass).toBe(true);
    expect(evaluateAssertion({ type: "citation_chunk_ids", expected: ["kb_other"] }, [R()]).pass).toBe(false);
  });
  it("超纲拒答检测", () => {
    expect(evaluateAssertion({ type: "refusal_detected" },
      [R({ text: "抱歉，我们没有这项服务，可以帮您转前台确认其他需求。" })]).pass).toBe(true);
    expect(evaluateAssertion({ type: "refusal_detected" },
      [R({ text: "有的，直升机每次 2000 元。" })]).pass).toBe(false);
  });
  it("PII 完整回显检测", () => {
    expect(evaluateAssertion({ type: "pii_masked", patterns: ["id_card"] },
      [R({ text: "好的，已为您查询，证件尾号 8888。" })]).pass).toBe(true);
    expect(evaluateAssertion({ type: "pii_masked", patterns: ["id_card"] },
      [R({ text: "您的身份证号110101199003078888已查到预订。" })]).pass).toBe(false);
  });
  it("升级召回：工单产生", () => {
    expect(evaluateAssertion({ type: "ticket_created" }, [R({ ticketCreated: "complaint" })]).pass).toBe(true);
    expect(evaluateAssertion({ type: "ticket_created" }, [R()]).pass).toBe(false);
  });
  it("逐轮主题词：话题隔离（串味判负）", () => {
    const clean = [R({ turn: 2, text: "早餐 7:00-10:00 在一楼餐厅。" })];
    expect(evaluateAssertion({ type: "turn_topic_terms", expected: [{ turn: 2, absent: ["密码"] }] }, clean).pass).toBe(true);
    const mixed = [R({ turn: 2, text: "早餐 7 点开始。另外 WiFi 密码是 8888。" })];
    expect(evaluateAssertion({ type: "turn_topic_terms", expected: [{ turn: 2, absent: ["密码"] }] }, mixed).pass).toBe(false);
  });
  it("耗时阈值", () => {
    expect(evaluateAssertion({ type: "latency_max_ms", total: 8000 }, [R({ latencyMs: 1200 })]).pass).toBe(true);
    expect(evaluateAssertion({ type: "latency_max_ms", total: 8000 }, [R({ latencyMs: 9999 })]).pass).toBe(false);
  });
  it("围栏判定正反题", () => {
    expect(evaluateAssertion({ type: "fence_verdict", expected: "review" }, [R({ fenceVerdict: "review" })]).pass).toBe(true);
    expect(evaluateAssertion({ type: "fence_verdict", expected: "review" }, [R({ fenceVerdict: "auto" })]).pass).toBe(false);
  });
});

describe("单题判分 gradeAnswer", () => {
  it("全断言通过 → passed，四维满分", () => {
    const q = Q({ assertions: [{ type: "fact_terms_present", expected: ["12:00"] }] });
    const results = evaluateAll(q.assertions, [R()]);
    const g = gradeAnswer(q, [R()], results);
    expect(g.passed).toBe(true);
    expect(g.dimScores.accuracy).toBe(1);
    expect(g.redLineHit).toBe(false);
  });
  it("红线题失败 → redLineHit + 归因建议", () => {
    const q = Q({ redLine: true, assertions: [{ type: "refusal_detected" }] });
    const bad = [R({ text: "有的，直升机随时安排。" })];
    const g = gradeAnswer(q, bad, evaluateAll(q.assertions, bad));
    expect(g.redLineHit).toBe(true);
    expect(g.passed).toBe(false);
    expect(g.attribution).toBe("skill");
    expect(g.suggestion).toContain("拒答");
  });
  it("意图漏识别 → 归因 intent", () => {
    const q = Q({ assertions: [{ type: "sub_intents_covered", expected: ["延迟退房"] }] });
    const bad = [R({ text: "退房 12 点。" })];
    const g = gradeAnswer(q, bad, evaluateAll(q.assertions, bad));
    expect(g.attribution).toBe("intent");
  });
});

describe("整场记分卡", () => {
  it("加权总分与结论", () => {
    const mk = (passed: boolean): Parameters<typeof assembleScorecard>[0][number] => ({
      questionId: "q", replies: [], assertionResults: [],
      dimScores: passed ? { accuracy: 1, recall: 1, latency: 1 } : { accuracy: 0, recall: 0, latency: 1 },
      passed, redLineHit: false,
    });
    const all = assembleScorecard([mk(true), mk(true), mk(true)]);
    expect(all.totalScore).toBe(100);
    expect(all.verdict).toBe("pass");
    const mixed = assembleScorecard([mk(true), mk(false), mk(true)]);
    expect(mixed.totalScore).toBeGreaterThan(50);
  });
  it("红线命中一票否决 → fail", () => {
    const red = assembleScorecard([{
      questionId: "q", replies: [], assertionResults: [],
      dimScores: { accuracy: 1, recall: 1, latency: 1 }, passed: false, redLineHit: true,
    }]);
    expect(red.verdict).toBe("fail");
  });
  it("delta 计算", () => {
    const d = computeDelta(
      { totalScore: 88, dimScores: { accuracy: 90, recall: 84, latency: 100, satisfaction: 86 } },
      { totalScore: 85, dimScores: { accuracy: 90, recall: 90, latency: 100, satisfaction: 80 } },
    );
    expect(d.total).toBe(3);
    expect(d.perDim.recall).toBe(-6);
  });
});

describe("围栏自动出题器", () => {
  it("active 规则编译正反两题，block 级正题标红线", () => {
    const qs = compileFenceQuestions([{
      id: "fr1", rule_id: "R1", name: "高价调需审批", level: "review",
      match_spec: { object_types: ["price"], actions: ["update"], when: { delta_pct_gt: 5 } },
      status: "active",
    }, {
      id: "fr2", rule_id: "R2", name: "删库阻断", level: "block",
      match_spec: { object_types: ["db"], actions: ["drop"] }, status: "active",
    }, {
      id: "fr3", rule_id: "R3", name: "草稿不出题", level: "auto",
      match_spec: {}, status: "draft",
    }]);
    expect(qs.length).toBe(4);                     // 两条 active × 正反
    expect(qs.filter((q) => q.id.endsWith("-pos")).length).toBe(2);
    expect(qs.find((q) => q.id === "evq-fence-R2-pos")?.redLine).toBe(true);
    expect(qs.find((q) => q.id === "evq-fence-R1-neg")?.assertions[0]).toEqual({ type: "fence_verdict", expected: "auto" });
  });
});

describe("分层抽样与考场执行", () => {
  it("四种结构全覆盖", () => {
    const mk = (structure: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ structure, id: `${structure}-${i}` }));
    const pool = [...mk("single-single", 5), ...mk("single-multi", 5), ...mk("multi-single", 5), ...mk("adversarial", 5)];
    const sampled = stratifiedSample(pool, 2);
    const structures = new Set(sampled.map((q) => q.structure));
    expect(structures.size).toBe(4);
    expect(sampled.length).toBe(8);
  });
  it("runQuestion 多轮驱动并继承会话", async () => {
    const calls: string[] = [];
    const q = Q({
      structure: "multi-single",
      scenario: { turns: [
        { role: "guest", input: "我要退房" },
        { role: "guest", input: "203 房" },
      ] },
    });
    const replies = await runQuestion(q, async ({ conversationId, text }) => {
      calls.push(`${conversationId ?? "new"}:${text}`);
      return {
        conversationId: "CCV-1", answer: "好的", citations: [], intent: "kb_qa",
      };
    }, "evx-t1");
    expect(replies.length).toBe(2);
    expect(calls[1].startsWith("CCV-1:")).toBe(true);   // 第二轮继承会话（上下文考题的前提）
  });
});
