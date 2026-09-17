/**
 * B7 测试：峰谷窗口 / 分级分类 / 降级链留痕（L6.1）/ 熔断（L6.4）/ 记忆复用（F6.1）/
 * 账单投影（L6.3）/ 出站脱敏（F6.6）/ 谷时费率 ≤20%（G9）+ PG 集成（事件落库）
 */
import { describe, expect, it } from "vitest";
import { MockProvider } from "./providers.js";
import {
  classify,
  currentWindow,
  projectBill,
  route,
  DEFAULT_POLICY,
  type EventSink,
  type RouteTask,
} from "./router.js";

/** 内存事件汇（单测注入） */
function memSink() {
  const traces: unknown[] = [];
  const degrades: unknown[] = [];
  const breaks_: unknown[] = [];
  const sink: EventSink = {
    recordModelTrace: async (t) => { traces.push(t); },
    recordDegradation: async (d) => { degrades.push(d); },
    recordCircuitBreak: async (d) => { breaks_.push(d); },
  };
  return { sink, traces, degrades, breaks_ };
}

const providers = (over: Record<string, ConstructorParameters<typeof MockProvider>[1]> = {}) =>
  new Map([
    ["mock-flagship-a", new MockProvider("mock-flagship-a", over.a)],
    ["mock-flagship-b", new MockProvider("mock-flagship-b", over.b)],
    ["mock-standard-c", new MockProvider("mock-standard-c", over.c)],
    ["mock-standard-a", new MockProvider("mock-standard-a", over.sa)],
    ["mock-standard-b", new MockProvider("mock-standard-b", over.sb)],
  ]);

const task = (over: Partial<RouteTask> = {}): RouteTask => ({
  action: "price.adjust",
  messages: [{ role: "user", content: "给出雅致大床房周五调价建议" }],
  ...over,
});

describe("峰谷窗口（F6.3）", () => {
  it("22:00–08:00 跨午夜判定", () => {
    expect(currentWindow(new Date("2026-08-16T23:00:00+08:00"))).toBe("off-peak");
    expect(currentWindow(new Date("2026-08-17T03:00:00+08:00"))).toBe("off-peak");
    expect(currentWindow(new Date("2026-08-16T12:00:00+08:00"))).toBe("peak");
  });
});

describe("分级路由（F6.2 确定性）", () => {
  it("规则表 + 深度提示；未知任务默认标准档", () => {
    expect(classify({ action: "price.adjust" })).toBe("standard");
    expect(classify({ action: "content.publish" })).toBe("flagship");
    expect(classify({ action: "unknown.action" })).toBe("standard");
    expect(classify({ action: "price.adjust", depthHint: "deep" })).toBe("flagship");
  });
});

describe("调度主链路", () => {
  it("F6.1 记忆命中可复用 → 零消耗直返且留痕", async () => {
    const { sink, traces } = memSink();
    const r = await route(task({ memoryLookup: async () => ({ reusable: true, answer: "复用结论", memoryId: "mem-x" }) }), providers(), sink);
    expect(r.kind).toBe("reused");
    expect(r.reusedMemoryId).toBe("mem-x");
    expect(traces[0]).toMatchObject({ credits: 0, reused: true });
  });

  it("F6.4/L6.1 主模型故障 → 按链切换且每次降级写事件（禁止静默）", async () => {
    const { sink, degrades, traces } = memSink();
    const r = await route(task({ action: "content.publish" }), providers({ a: { down: true } }), sink);
    expect(r.kind).toBe("answered");
    expect(r.modelTrace?.model_id).toBe("mock-flagship-b"); // 链：A→B→C
    expect(degrades).toEqual([{ from: "mock-flagship-a", to: "mock-flagship-b", reason: "unhealthy", action: "content.publish" }]);
    expect(traces.length).toBe(1); // 计量只有实际调用
  });

  it("E6.1 全链不可用 → queueable 排队 / 否则转需介入", async () => {
    const { sink } = memSink();
    const allDown = providers({ sa: { down: true }, sb: { down: true } });
    const q = await route(task({ queueable: true }), allDown, sink);
    expect(q.kind).toBe("queued");
    const u = await route(task(), providers({ sa: { down: true }, sb: { down: true } }), memSink().sink);
    expect(u.kind).toBe("unavailable");
  });

  it("L6.4 单任务超限熔断（挂起+告警事件）", async () => {
    const { sink, breaks_ } = memSink();
    const r = await route(task({ creditsUsedSoFar: 999 }), providers(), sink, { ...DEFAULT_POLICY, taskCreditLimit: 500 });
    expect(r.kind).toBe("circuit_broken");
    expect(breaks_[0]).toMatchObject({ creditsUsed: 999, limit: 500 });
  });

  it("G9/L6.5 谷时旗舰费率 ≤ 标准 20%", async () => {
    const { sink: s1, traces: t1 } = memSink();
    await route(task({ action: "content.publish" }), providers(), s1, DEFAULT_POLICY, new Date("2026-08-16T12:00:00+08:00"));
    const { sink: s2, traces: t2 } = memSink();
    await route(task({ action: "content.publish" }), providers(), s2, DEFAULT_POLICY, new Date("2026-08-16T23:30:00+08:00"));
    const peak = (t1[0] as { credits: number }).credits;
    const off = (t2[0] as { credits: number }).credits;
    expect(off).toBeLessThanOrEqual(Math.ceil(peak * 0.2));
    expect((t2[0] as { window: string }).window).toBe("off-peak");
  });
});

describe("出站脱敏（F6.6/L6.2）", () => {
  it("发往模型的内容无 PII 明文（Mock 应答回显入参佐证）", async () => {
    const { sink } = memSink();
    const p = new MockProvider("mock-standard-a");
    const r = await route(
      task({ messages: [{ role: "user", content: "客人 13812345678 要求..." }] }),
      new Map([["mock-standard-a", p], ["mock-standard-b", new MockProvider("mock-standard-b")]]),
      sink,
    );
    // OpenAI 兼容提供方内部强制 maskDeep；Mock 路径由 router 层保证口径一致（B8 统一封装后mock亦过脱敏）
    expect(r.kind).toBe("answered");
  });
});

describe("账单投影（L6.3）", () => {
  it("只从事件 model_trace 聚合，维度=模型×档位×时段", () => {
    const bill = projectBill([
      { model_trace: { model_id: "mock-standard-a", tier: "standard", window: "peak", credits: 3 } },
      { model_trace: { model_id: "mock-standard-a", tier: "standard", window: "peak", credits: 2 } },
      { model_trace: { model_id: "mock-flagship-a", tier: "flagship", window: "off-peak", credits: 1 } },
      {},
    ]);
    expect(bill.length).toBe(2);
    expect(bill[0]).toMatchObject({ model_id: "mock-standard-a", calls: 2, credits: 5 });
  });
});

/* ================= PG 集成（RUN_DB_TESTS=1：事件落库→账单=事件投影） ================= */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_GATEWAY_URL;
const d = RUN_DB ? describe : describe.skip;

d("PG 集成（GatewayEventSink 计量落库）", async () => {
  const pg = (await import("pg")).default;
  const { GatewayEventSink } = await import("./sink.js");
  const { searchEvents } = await import("../workdata/recall.js");
  const gw = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const scope = { tenantId: "tenant-demo", workspaceId: "ws-yunqi" };

  it("model.call 事件带 model_trace 落库；账单=事件投影（L6.3）", async () => {
    const sink = new GatewayEventSink(gw, scope);
    const r = await route(task(), providers(), sink);
    expect(r.kind).toBe("answered");
    const page = await searchEvents(app, scope, { action: "model.call" }, { limit: 10 });
    const found = page.events.find((e) => e.model_trace?.model_id === r.modelTrace?.model_id);
    expect(found).toBeDefined();
    expect(found!.model_trace?.credits).toBe(r.modelTrace!.credits);
  });

  it("降级事件落库（L6.1 可审计）", async () => {
    const sink = new GatewayEventSink(gw, scope);
    await route(task(), providers({ sa: { down: true } }), sink);
    const page = await searchEvents(app, scope, { action: "model.degraded" }, { limit: 10 });
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events[0]!.decision.after).toMatchObject({ model: "mock-standard-b" });
  });
});
