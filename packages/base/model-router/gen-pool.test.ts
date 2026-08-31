/**
 * 多模态生成池测试（v3.0 下一迭代）：
 * 异步任务制 / 降级链留痕 / 渲染额度台账（套餐配额 × 事件投影）/ 谷时计量
 */
import { describe, expect, it } from "vitest";
import {
  MockGenProvider, RENDER_QUOTA_SECONDS, checkRenderBudget, projectRenderUsage, routeGenSubmit,
} from "./gen-pool.js";
import type { EventSink } from "./router.js";

function memSink() {
  const traces: any[] = [];
  const degrades: any[] = [];
  const sink: EventSink = {
    recordModelTrace: async (t) => { traces.push(t); },
    recordDegradation: async (d) => { degrades.push(d); },
    recordCircuitBreak: async () => undefined,
  };
  return { sink, traces, degrades };
}

describe("生成任务提交（异步任务制 + 降级链）", () => {
  it("首选 provider 提交成功 → task_id 回填 + 计量留痕", async () => {
    const { sink, traces } = memSink();
    const pool = new Map([["seedance", new MockGenProvider("seedance")]]);
    const r = await routeGenSubmit({ prompt: "一只猫在窗台晒太阳", estimatedUnits: 30 }, ["seedance"], pool, sink);
    expect(r.kind).toBe("submitted");
    expect(r.taskId).toContain("mock-seedance");
    expect(traces[0]).toMatchObject({ model_id: "gen:seedance", action: "gen.submit" });
  });

  it("首选故障 → 备援接管且 gen.degraded 留痕（L6.1 禁止静默）", async () => {
    const { sink, degrades } = memSink();
    const pool = new Map([
      ["seedance", new MockGenProvider("seedance", "video", { down: true })],
      ["kling", new MockGenProvider("kling")],
    ]);
    const r = await routeGenSubmit({ prompt: "x", estimatedUnits: 10 }, ["seedance", "kling"], pool, sink);
    expect(r.kind).toBe("submitted");
    expect(r.providerId).toBe("kling");
    expect(degrades[0]).toMatchObject({ from: "seedance", to: "kling", reason: "unhealthy" });
  });

  it("全链不可用 → unavailable（调用方转人工/排队）", async () => {
    const { sink } = memSink();
    const pool = new Map([["seedance", new MockGenProvider("seedance", "video", { down: true })]]);
    const r = await routeGenSubmit({ prompt: "x", estimatedUnits: 10 }, ["seedance"], pool, sink);
    expect(r.kind).toBe("unavailable");
  });

  it("谷时提交计量 ×0.2（排产谷时算力语义）", async () => {
    const { sink, traces } = memSink();
    const pool = new Map([["seedance", new MockGenProvider("seedance")]]);
    await routeGenSubmit({ prompt: "x", estimatedUnits: 100 }, ["seedance"], pool, sink, new Date("2026-08-31T23:30:00+08:00"));
    const peakSink = memSink();
    await routeGenSubmit({ prompt: "x", estimatedUnits: 100 }, ["seedance"], pool, peakSink.sink, new Date("2026-08-31T12:00:00+08:00"));
    expect(traces[0].window).toBe("off-peak");
    expect(traces[0].credits).toBeLessThan(peakSink.traces[0].credits);
  });

  it("Mock poll：任务制第二步回填结果", async () => {
    const p = new MockGenProvider("seedance");
    const { taskId } = await p.submit({ prompt: "x", estimatedUnits: 5 });
    const r = await p.poll(taskId);
    expect(r.status).toBe("succeeded");
    expect(r.uri).toContain("mock://gen/");
  });
});

describe("渲染额度台账（套餐秒数配额 × 事件投影）", () => {
  it("套餐配额口径：智享按量 / 标准 100s / 智能 500s", () => {
    expect(RENDER_QUOTA_SECONDS.lite).toBe(0);
    expect(RENDER_QUOTA_SECONDS.standard).toBe(100);
    expect(RENDER_QUOTA_SECONDS.smart).toBe(500);
  });

  it("用量投影：本月 render.submit 秒数合计，跨月不计", () => {
    const now = new Date("2026-08-31T12:00:00+08:00");
    const used = projectRenderUsage([
      { action: "render.submit", after: { estimated_seconds: 30 }, time: "2026-08-10T00:00:00+08:00" },
      { action: "render.submit", after: { estimated_seconds: 50 }, time: "2026-08-20T00:00:00+08:00" },
      { action: "render.submit", after: { estimated_seconds: 999 }, time: "2026-07-31T23:00:00+08:00" }, // 上月
      { action: "model.call", after: {}, time: "2026-08-10T00:00:00+08:00" },
    ], now);
    expect(used).toBe(80);
  });

  it("预算闸：配额内放行；超支未确认 → 熔断并给出加油包指引", () => {
    const ok = checkRenderBudget({ plan: "standard", usedSeconds: 60, requestSeconds: 30 });
    expect(ok.allowed).toBe(true);
    expect(ok.overageSeconds).toBe(0);
    const blocked = checkRenderBudget({ plan: "standard", usedSeconds: 90, requestSeconds: 30 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.overageSeconds).toBe(20);
    expect(blocked.reason).toContain("加油包");
    const over = checkRenderBudget({ plan: "standard", usedSeconds: 90, requestSeconds: 30, allowOverage: true });
    expect(over.allowed).toBe(true);
    expect(over.overageSeconds).toBe(20);
  });

  it("智享版无赠送额度：任何提交都计为按量实扣区", () => {
    const r = checkRenderBudget({ plan: "lite", usedSeconds: 0, requestSeconds: 10, allowOverage: true });
    expect(r.quotaSeconds).toBe(0);
    expect(r.overageSeconds).toBe(10);
  });
});
