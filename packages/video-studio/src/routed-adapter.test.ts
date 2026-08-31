/**
 * v3.0 vendor 引擎收口测试：WorkloomLLMEngine 注入 router 后——
 * 全部调用经 routeSmart（preproduction 场景 + 真实计量留痕 + fastModel 强制 L1 + 失败可重试语义）
 */
import { describe, expect, it } from "vitest";
import { MockProvider } from "@workloom/base/model-router";
import { WorkloomLLMEngine } from "./llm-adapter.js";

function memSink() {
  const traces: any[] = [];
  const degrades: any[] = [];
  return {
    traces,
    degrades,
    sink: {
      recordModelTrace: async (t: unknown) => { traces.push(t); },
      recordDegradation: async (d: unknown) => { degrades.push(d); },
      recordCircuitBreak: async () => undefined,
    },
  };
}

const engine = (sink: any, providers?: Map<string, MockProvider>) =>
  new WorkloomLLMEngine({
    baseUrl: "http://unused.local/v1",
    apiKey: "sk-test",
    model: "stub-main",
    fastModel: "stub-fast",
    router: {
      providers: providers ?? new Map([
        ["deepseek-v4-flash", new MockProvider("deepseek-v4-flash")],
        ["glm-5.3-flash", new MockProvider("glm-5.3-flash")],
        ["qwen-3.8-flash", new MockProvider("qwen-3.8-flash")],
        ["deepseek-v4-pro", new MockProvider("deepseek-v4-pro")],
        ["glm-5.2", new MockProvider("glm-5.2")],
        ["minimax-m3", new MockProvider("minimax-m3")],
      ]),
      sink,
      scene: "preproduction",
    },
  });

describe("vendor 引擎收口 routeSmart（preproduction 场景）", () => {
  it("reason() 经路由应答并写 model.call 计量（场景留痕）", async () => {
    const { sink, traces } = memSink();
    const r = await engine(sink).reason("写一条 15 秒种草短视频大纲");
    expect(r.success).toBe(true);
    expect(r.content).toContain("mock:");
    expect(traces.length).toBe(1);
    expect(traces[0]).toMatchObject({ scene: "preproduction", bill_to: "tenant" });
  });

  it("fastModel 快速调用强制 L1 轻量档；主力调用走 L2", async () => {
    const { sink, traces } = memSink();
    const e = engine(sink);
    await e.reason("主力调用");
    await e.reason("快速调用", { model: "stub-fast" });
    expect(traces[0].tier).toBe("L2");
    expect(traces[1].tier).toBe("L1");
  });

  it("主模型故障按降级链切换且留痕（L6.1），调用仍成功", async () => {
    const { sink, degrades } = memSink();
    const providers = new Map([
      ["deepseek-v4-pro", new MockProvider("deepseek-v4-pro", { down: true })],
      ["glm-5.2", new MockProvider("glm-5.2")],
      ["minimax-m3", new MockProvider("minimax-m3")],
    ]);
    const r = await engine(sink, providers).reason("x");
    expect(r.success).toBe(true);
    expect(degrades.length).toBe(1);
    expect(degrades[0]).toMatchObject({ from: "deepseek-v4-pro", reason: "unhealthy" });
  });

  it("全链不可用 → success:false + retryable（vendor 熔断纪律接管，不静默）", async () => {
    const { sink } = memSink();
    const providers = new Map([
      ["deepseek-v4-pro", new MockProvider("deepseek-v4-pro", { down: true })],
      ["glm-5.2", new MockProvider("glm-5.2", { down: true })],
      ["minimax-m3", new MockProvider("minimax-m3", { down: true })],
      ["deepseek-v4-flash", new MockProvider("deepseek-v4-flash", { down: true })],
      ["glm-5.3-flash", new MockProvider("glm-5.3-flash", { down: true })],
      ["qwen-3.8-flash", new MockProvider("qwen-3.8-flash", { down: true })],
    ]);
    const r = await engine(sink, providers).reason("x");
    expect(r.success).toBe(false);
    expect(r.retryable).toBe(true);
  });

  it("reasonStructured 的 JSON 提取在路由路径上保持兼容", async () => {
    const { sink } = memSink();
    // Mock 应答非 JSON → extractJson 抛错 → success:false retryable（与旧路径同语义）
    const r = await engine(sink).reasonStructured("x", {});
    expect(r.success).toBe(false);
    expect(r.retryable).toBe(true);
  });
});
