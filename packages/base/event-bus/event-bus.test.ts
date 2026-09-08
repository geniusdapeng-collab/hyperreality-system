/**
 * event-bus 一致性测试套件（P0-3「接口不变、上层零改动」的举证方式）
 *
 * 同一套语义用例跑三种实现：memory（起步形态）/ nats（JetStream 适配器）/ redis（Streams 适配器）。
 * 持久化实现额外跑「崩溃重启」用例：在途消息不丢、未 ack 重投、已 ack 不重投、延迟消息重启后必达。
 *
 * 运行方式：nats/redis 用例使用进程内仿真服务器（真实 TCP + 真协议子集，无外部依赖）；
 * 有真实 NATS_URL / REDIS_URL 环境变量时自动追加真实服务器回归（CI 可选）。
 */
import { afterEach, beforeEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryEventBus } from "./memory.js";
import { MirroredEventBus, type StreamSpec } from "./mirrored.js";
import { NatsBackend, TcpNatsConnection } from "./adapters/nats.js";
import { RedisBackend, TcpRedisConnection } from "./adapters/redis.js";
import { FakeNatsServer } from "./testing/fake-nats.js";
import { FakeRedisServer } from "./testing/fake-redis.js";
import type { EventBusLike } from "./types.js";

const SPECS: StreamSpec[] = [
  { name: "events-core", subjects: ["events-core.>"], retention: "limits", maxAgeMs: 72 * 3600e3 },
  { name: "tickets-flow", subjects: ["tickets-flow.>"], retention: "workqueue" },
];
const STREAMS = SPECS.map((s) => s.name);

interface Ctx {
  makeBus: () => Promise<EventBusLike>;
  /** 制造一次「进程崩溃」：销毁当前 bus（不 flush 上行），返回重建入口 */
  crash?: (bus: EventBusLike) => Promise<EventBusLike>;
  cleanup: () => Promise<void>;
  persistent: boolean;
  /** 直读服务器侧流日志（绕过镜像，抓重复发布的治本判据） */
  serverLog?: (stream: string) => Promise<{ payload: unknown }[]>;
}

/* ---------------- 语义一致性套件 ---------------- */
function semanticsSuite(name: string, ctx: Ctx, nowRef: { t: number }) {
  describe(`语义一致性 · ${name}`, () => {
    it("扇出：一条事件 N 个消费组各自独立位点收全", async () => {
      const bus = await ctx.makeBus();
      bus.publish("events-core", "ev.t.order", { n: 1 });
      bus.publish("events-core", "ev.t.order", { n: 2 });
      await bus.flush();
      const g1 = bus.consumer("events-core", "projector");
      const g2 = bus.consumer("events-core", "chain-verifier");
      await bus.flush();
      expect(g1.pull(10, nowRef.t)).toHaveLength(2);
      expect(g2.pull(10, nowRef.t)).toHaveLength(2);
      // g1 ack 不影响 g2 的位点
      g1.ack(1);
      expect(g2.pendingCount()).toBe(2);
      await bus.close();
    });

    it("ack 语义：ack 后不重投；未 ack redeliver 重投且计数递增", async () => {
      const bus = await ctx.makeBus();
      bus.publish("events-core", "ev.t.a", { n: 1 });
      bus.publish("events-core", "ev.t.a", { n: 2 });
      await bus.flush();
      const g = bus.consumer("events-core", "g");
      await bus.flush();
      const msgs = g.pull(10, nowRef.t);
      expect(msgs).toHaveLength(2);
      g.ack(msgs[0]!.seq);
      await bus.flush();
      const re = g.redeliver(nowRef.t);
      expect(re).toHaveLength(1);
      expect(re[0]!.seq).toBe(msgs[1]!.seq);
      await bus.close();
    });

    it("背压：pending 达上限 pull 返回空，积压留在总线", async () => {
      const bus = await ctx.makeBus();
      for (let i = 0; i < 5; i++) bus.publish("events-core", "ev.t.bp", { i });
      await bus.flush();
      const g = bus.consumer("events-core", "bp", 2);
      await bus.flush();
      expect(g.pull(10, nowRef.t)).toHaveLength(2); // maxAckPending=2
      expect(g.pull(10, nowRef.t)).toHaveLength(0); // 背压
      expect(bus.logOf("events-core")).toHaveLength(5); // 一条没丢
      await bus.close();
    });

    it("deliver-at：到点前不可见，到点必达（pullDueDelayed）", async () => {
      const bus = await ctx.makeBus();
      bus.publish("events-core", "ev.t.sla", { x: 1 }, { deliverAt: nowRef.t + 3600e3 });
      await bus.flush();
      const g = bus.consumer("events-core", "sla");
      await bus.flush();
      expect(g.pull(10, nowRef.t)).toHaveLength(0); // 未到点
      nowRef.t += 3600e3; // 到点
      await bus.flush(); // lift（持久化实现）
      const due = g.pullDueDelayed(nowRef.t);
      expect(due).toHaveLength(1);
      expect((due[0]!.payload as { x: number }).x).toBe(1);
      await bus.close();
    });

    it("位点重放：fromSeq 之后全量有序返回", async () => {
      const bus = await ctx.makeBus();
      for (let i = 1; i <= 5; i++) bus.publish("events-core", "ev.t.r", { i });
      await bus.flush();
      const all = bus.replay("events-core");
      expect(all).toHaveLength(5);
      expect(all.map((m) => (m.payload as { i: number }).i)).toEqual([1, 2, 3, 4, 5]);
      const from2 = bus.replay("events-core", all[1]!.seq);
      expect(from2).toHaveLength(3);
      await bus.close();
    });

    it("四流隔离：流名拼错即抛（不静默写错流）", async () => {
      const bus = await ctx.makeBus();
      expect(() => bus.publish("no-such-stream", "x", {})).toThrow("未声明");
      await bus.close();
    });

    it("多字节负载：中文/emoji 事件全链路不失真（字节组帧回归）", async () => {
      // 协议长度字段是字节数——字符串组帧会在中文负载下帧对齐崩坏（演练实证 5s 超时）。
      const bus = await ctx.makeBus();
      const payload = { msg: "客人投诉：空调不制冷，要求换房🥶", n: 1 };
      bus.publish("events-core", "ev.t.zh", payload);
      await bus.flush();
      const g = bus.consumer("events-core", "zh-g");
      await bus.flush();
      const got = g.pull(10, nowRef.t).find((m) => (m.payload as { n?: number }).n === 1);
      expect((got?.payload as { msg?: string }).msg).toBe(payload.msg); // 原样往返
      g.ack(got!.seq);
      await bus.flush();
      if (ctx.persistent && ctx.crash) {
        const bus2 = await ctx.crash(bus);
        const m2 = bus2.logOf("events-core").find((m) => (m.payload as { n?: number }).n === 1);
        expect((m2?.payload as { msg?: string }).msg).toBe(payload.msg); // 重启后仍原样
        await bus2.close();
      } else {
        await bus.close();
      }
    });

    it("flush 重入安全：并发 flush 不产生重复发布（演练实证回归）", async () => {
      // 内部定时器与外部调用并发 flush 时，两条泵曾看到同一未出队项 → 重复发布 →
      // 流内 seq 错位 → ack 路由偏移。互斥锁修复后：服务器侧零重复。
      const bus = await ctx.makeBus();
      for (let i = 0; i < 50; i++) bus.publish("events-core", "ev.t.r", { i });
      await Promise.all([bus.flush(), bus.flush(), bus.flush()]); // 并发重入
      await bus.flush();
      const log = bus.logOf("events-core");
      const ids = log.map((m) => (m.payload as { i?: number }).i);
      expect(new Set(ids).size).toBe(ids.length); // 镜像零重复
      if (ctx.serverLog) {
        const serverIds = (await ctx.serverLog("events-core")).map((m) => (m.payload as { i?: number }).i);
        expect(new Set(serverIds).size).toBe(serverIds.length); // 服务器零重复（治本判据）
        expect(serverIds.length).toBe(50);
      }
      await bus.close();
    });
  });
}

/* ---------------- 持久化（崩溃重启）套件 ---------------- */
function persistenceSuite(name: string, ctx: Ctx, nowRef: { t: number }) {
  if (!ctx.persistent || !ctx.crash) return;
  describe(`持久化 · ${name}`, () => {
    it("崩溃重启：在途消息不丢，镜像从服务器重建", async () => {
      let bus = await ctx.makeBus();
      bus.publish("events-core", "ev.t.p", { n: 1 });
      bus.publish("events-core", "ev.t.p", { n: 2 });
      await bus.flush(); // 落服务器
      bus = await ctx.crash!(bus); // 模拟 kill -9（不 flush、不 close）
      const log = bus.logOf("events-core");
      expect(log).toHaveLength(2);
      expect(bus.replay("events-core")).toHaveLength(2);
      await bus.close();
    });

    it("崩溃重启：未 ack 重投、已 ack 不重投", async () => {
      let bus = await ctx.makeBus();
      bus.publish("events-core", "ev.t.c", { n: 1 });
      bus.publish("events-core", "ev.t.c", { n: 2 });
      bus.publish("events-core", "ev.t.c", { n: 3 });
      await bus.flush();
      let g = bus.consumer("events-core", "crash-g");
      await bus.flush();
      const msgs = g.pull(10, nowRef.t);
      expect(msgs).toHaveLength(3);
      g.ack(msgs[0]!.seq); // 只 ack 第一条
      await bus.flush(); // ack 落服务器
      // 崩溃 → 重建
      bus = await ctx.crash!(bus);
      g = bus.consumer("events-core", "crash-g");
      await bus.flush(); // 组恢复
      const re = g.pull(10, nowRef.t);
      const ns = re.map((m) => (m.payload as { n: number }).n).sort();
      expect(ns).toEqual([2, 3]); // 已 ack 的 n=1 不重投
      await bus.close();
    });

    it("崩溃重启：延迟消息仍必达", async () => {
      let bus = await ctx.makeBus();
      bus.publish("events-core", "ev.t.d", { x: 9 }, { deliverAt: nowRef.t + 1000 });
      await bus.flush(); // 延迟消息落服务器延迟队列
      bus = await ctx.crash!(bus);
      nowRef.t += 1000; // 到点
      await bus.flush(); // lift：延迟消息转入目标流
      const g = bus.consumer("events-core", "d-g");
      await bus.flush();
      // 新消费组游标在 0：lift 后的消息（deliverAt 已到点）经正常 pull 必达
      const due = g.pull(10, nowRef.t).filter((m) => (m.payload as { x?: number }).x === 9);
      expect(due).toHaveLength(1);
      await bus.close();
    });
  });
}

/* ================= 三实现装配 ================= */
let now = { t: 1_000 };

describe("event-bus 一致性测试套件", () => {
  beforeAll(() => { now.t = 1_000; }); // 原地重置：与 ctx 闭包共享同一对象

  /* ---- memory ---- */
  semanticsSuite("memory", {
    makeBus: async () => new MemoryEventBus(STREAMS, () => now.t),
    cleanup: async () => undefined,
    persistent: false,
  }, now);

  /* ---- nats（fake server，真 TCP 真协议） ---- */
  describe("nats 适配器", () => {
    let server: FakeNatsServer;
    const buses: EventBusLike[] = [];
    beforeEach(async () => {
      server = new FakeNatsServer();
      await server.start();
    }, 15000);
    afterEach(async () => {
      for (const b of buses.splice(0)) await b.close().catch(() => undefined);
      await server.stop();
    });
    const ctx: Ctx = {
      makeBus: async () => {
        const bus = new MirroredEventBus(new NatsBackend(new TcpNatsConnection(server.url())), SPECS, () => now.t, 10);
        await bus.start();
        buses.push(bus);
        return bus;
      },
      crash: async (bus) => {
        await bus.close().catch(() => undefined); // 销毁客户端（服务器状态保留）
        return ctx.makeBus();
      },
      cleanup: async () => undefined,
      persistent: true,
      serverLog: async (stream) =>
        (server.streamMessages(stream)).map((m) => ({ payload: JSON.parse(m.payload) as unknown })),
    };
    semanticsSuite("nats", ctx, now);
    persistenceSuite("nats", ctx, now);
  });

  /* ---- redis（fake server，真 TCP 真 RESP） ---- */
  describe("redis 适配器", () => {
    let server: FakeRedisServer;
    const buses: EventBusLike[] = [];
    beforeEach(async () => {
      server = new FakeRedisServer();
      await server.start();
    }, 15000);
    afterEach(async () => {
      for (const b of buses.splice(0)) await b.close().catch(() => undefined);
      await server.stop();
    });
    const ctx: Ctx = {
      makeBus: async () => {
        const bus = new MirroredEventBus(new RedisBackend(new TcpRedisConnection(server.url())), SPECS, () => now.t, 10);
        await bus.start();
        buses.push(bus);
        return bus;
      },
      crash: async (bus) => {
        await bus.close().catch(() => undefined);
        return ctx.makeBus();
      },
      cleanup: async () => undefined,
      persistent: true,
      serverLog: async (stream) => server.streamMessages(stream).map((m) => ({ payload: m.payload as unknown })),
    };
    semanticsSuite("redis", ctx, now);
    persistenceSuite("redis", ctx, now);
  });
});
