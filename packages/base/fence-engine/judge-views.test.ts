/**
 * judgeViews 多视图语义（2026-09-24 修复回归）：
 *  - 视图分两类：**执行真相视图**（工具名/工具前缀派生，标 `failClosed: true`）与
 *    **标签视图**（LLM 自造动作名/对象，只做加严）；
 *  - 标签视图未命中不回落 default——否则"LLM 自造语义动作名"会把已知执行工具的正常步骤推成
 *    review（P 域实测 T-104..T-107 全挂）；
 *  - 执行真相视图未命中必须回落 default——否则"未声明工具 + 已声明动作名"会被静默放行
 *    （2026-09-24 红队复核 T-113：action=publish_article 命中 G-CON2 auto，实际工具 ai_task.emit）；
 *  - 求值异常（block）与 block 级规则命中始终最严——修复不放松任何已知风险。
 */
import { describe, expect, it } from "vitest";
import { judgeViews, type RuntimeRule } from "./judge.js";

const autoRule: RuntimeRule = {
  rule_id: "G-C01", version: "v1", name: "内部协作放行", level: "auto", is_baseline: true,
  objectTypes: ["content", "script"], actions: ["draft", "compose", "generate"],
  when: "true",
};
const reviewRule: RuntimeRule = {
  rule_id: "G9", version: "v1", name: "公网发布必审", level: "review", is_baseline: true,
  objectTypes: ["publish_task"], actions: ["publish.execute"],
  when: "true",
};
const blockRule: RuntimeRule = {
  rule_id: "G-GEO3", version: "v1", name: "灰帽熔断", level: "block", is_baseline: true,
  objectTypes: ["geo_content"], actions: ["geo.rewrite"],
  when: "params.technique in ['corpus_pollution']",
};

describe("judgeViews：命中任一视图即生效，全不命中才 default", () => {
  it("语义动作名自造（未命中）+ 工具视图命中 auto → 放行（不再被 default review 拖严）", () => {
    const verdict = judgeViews([
      { object: { type: "geo_article" }, action: "generate_geo_article", effect: "write" },
      { object: { type: "content" }, action: "generate", effect: "write", failClosed: true },
    ], [autoRule], "review");
    expect(verdict.level).toBe("auto");
    expect(verdict.impacts.map((i) => i.rule_id)).toEqual(["G-C01"]);
  });

  it("标签视图命中 auto、但执行真相视图无规则覆盖 → 仍按 default 挂起（堵「未声明工具+已声明动作名」）", () => {
    const verdict = judgeViews([
      { object: { type: "content" }, action: "draft", effect: "write" },              // 标签：命中 G-C01 auto
      { object: { type: "wechat_article" }, action: "publish_article", effect: "write", failClosed: true }, // 真相：无规则
    ], [autoRule], "review");
    expect(verdict.level).toBe("review");
    expect(verdict.triggeredBy.join("；")).toContain("default_level");
  });

  it("两个视图都没命中规则 → 按 default_level（未知写 fail-closed 不变）", () => {
    const verdict = judgeViews([
      { object: { type: "geo_article" }, action: "generate_geo_article", effect: "write" },
      { object: { type: "geo_article" }, action: "content.draft", effect: "write" },
    ], [autoRule], "review");
    expect(verdict.level).toBe("review");
    expect(verdict.impacts).toEqual([]);
    expect(verdict.triggeredBy.join("；")).toContain("default_level");
  });

  it("任一视图命中 review/block 规则时取其严：auto 视图不能盖过发布必审/熔断", () => {
    const publish = judgeViews([
      { object: { type: "content" }, action: "draft", effect: "write" },
      { object: { type: "publish_task" }, action: "publish.execute", effect: "write" },
    ], [autoRule, reviewRule], "review");
    expect(publish.level).toBe("review");
    const blocked = judgeViews([
      { object: { type: "content" }, action: "draft", effect: "write" },
      { object: { type: "geo_content" }, action: "geo.rewrite", params: { technique: "corpus_pollution" }, effect: "write" },
    ], [autoRule, blockRule], "review");
    expect(blocked.level).toBe("block");
  });

  it("求值异常按 block 且不被其它视图的 auto 冲淡（E2.1 宁可错杀）", () => {
    const badRule: RuntimeRule = { ...autoRule, rule_id: "G-X1", when: "after.price / 0 > 1" };
    const verdict = judgeViews([
      { object: { type: "content" }, action: "draft", effect: "write" },
      { object: { type: "content" }, action: "draft", after: { price: 1 }, effect: "write" },
    ], [autoRule, badRule], "review");
    expect(verdict.evalErrors.length).toBeGreaterThan(0);
    expect(verdict.level).toBe("block");
  });
});
