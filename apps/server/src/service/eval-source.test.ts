import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveEvalQuestionSet, type ExplicitEvalQuestionFixture } from "./eval.js";

const FIXTURE: ExplicitEvalQuestionFixture = {
  id: "unit-generic-v1",
  questions: [{
    subject: "skill",
    structure: "single-single",
    primaryDimensions: ["accuracy"],
    redLine: false,
    difficulty: "easy",
    source: "customer",
    tags: ["通用"],
    scenario: { turns: [{ role: "guest", input: "请说明当前能力边界。" }] },
    assertions: [{ type: "fact_terms_present", expected: ["边界"] }],
  }],
};

describe("考试院题源门禁", () => {
  it("显式服务端夹具无需行业默认即可生成隔离题号", async () => {
    const set = await resolveEvalQuestionSet("workspace-fixture", FIXTURE);
    expect(set.sourceId).toBe("fixture:unit-generic-v1");
    expect(set.questionIds).toHaveLength(1);
    expect(set.questionIds[0]).toContain("fixture-unit-generic-v1");
  });

  it("空显式夹具失败关闭", async () => {
    await expect(resolveEvalQuestionSet("workspace-fixture", { id: "empty", questions: [] }))
      .rejects.toThrow(/没有题目/);
  });

  it("显式夹具同样执行运行时 Schema，类型断言不能绕过", async () => {
    const invalid = {
      id: "invalid-runtime",
      questions: [{ ...FIXTURE.questions[0], assertions: [] }],
    } as ExplicitEvalQuestionFixture;
    await expect(resolveEvalQuestionSet("workspace-fixture", invalid))
      .rejects.toThrow(/不符合题集契约/);
  });

  it("服务实现不再导入或引用酒店默认题集", () => {
    const source = readFileSync(new URL("./eval.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/HOTEL_CS_SEED_QUESTIONS|酒店客服科|退房时间|房型/);
    expect(source).toContain("resolveWorkspaceActiveBundle");
    expect(source).toContain("loadVerifiedBundleEvalQuestions");
  });
});
