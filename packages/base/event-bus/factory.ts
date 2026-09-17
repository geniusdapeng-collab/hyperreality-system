/**
 * factory · 事件总线装配工厂（切换机制：EVENT_BUS=memory|nats|redis，缺省自动）
 *
 * 缺省自动策略（对焦稿决策点 4：安装包内嵌 NATS 开箱即持久化）：
 *  ① EVENT_BUS 显式指定 → 按指定装配；
 *  ② 未指定且检测到内嵌 NATS 端点（embeddedNats 提供方返回非空）→ nats（自包含安装包形态）；
 *  ③ 否则 → memory（零依赖起步/演示形态）。
 * 生产部署：EVENT_BUS=nats EVENT_BUS_URL=nats://host:4222（或 redis://host:6379）。
 */
import { MemoryEventBus } from "./memory.js";
import { MirroredEventBus, type StreamSpec } from "./mirrored.js";
import { NatsBackend, TcpNatsConnection } from "./adapters/nats.js";
import { RedisBackend, TcpRedisConnection } from "./adapters/redis.js";
import type { EventBusLike } from "./types.js";

export interface BusFactoryOptions {
  streams: StreamSpec[];
  now?: () => number;
  /** 内嵌 NATS 端点探测（安装包形态：supervisor 已拉起本机 nats-server 时返回 ws/tcp 端点） */
  embeddedNats?: () => Promise<string | null>;
  /** 覆盖：测试注入自定义后端连接 */
  natsUrl?: string;
  redisUrl?: string;
}

/** 从环境变量装配（进程级唯一入口） */
export async function createEventBusFromEnv(
  env: Record<string, string | undefined>,
  opts: BusFactoryOptions,
): Promise<EventBusLike> {
  const backend = (env.EVENT_BUS ?? "").trim().toLowerCase();
  if (backend === "memory") return new MemoryEventBus(opts.streams.map((s) => s.name), opts.now);
  if (backend === "nats") return createNatsBus(env.EVENT_BUS_URL ?? "nats://127.0.0.1:4222", opts);
  if (backend === "redis") return createRedisBus(env.EVENT_BUS_URL ?? "redis://127.0.0.1:6379", opts);
  if (backend) throw new Error(`未知 EVENT_BUS：${backend}（可选 memory|nats|redis）`);
  // 缺省自动：内嵌 NATS 优先，否则 memory
  const embedded = opts.embeddedNats ? await opts.embeddedNats().catch(() => null) : null;
  if (embedded) return createNatsBus(embedded, opts);
  return new MemoryEventBus(opts.streams.map((s) => s.name), opts.now);
}

export async function createNatsBus(url: string, opts: BusFactoryOptions): Promise<EventBusLike> {
  const bus = new MirroredEventBus(new NatsBackend(new TcpNatsConnection(url)), opts.streams, opts.now);
  await bus.start();
  return bus;
}

export async function createRedisBus(url: string, opts: BusFactoryOptions): Promise<EventBusLike> {
  const bus = new MirroredEventBus(new RedisBackend(new TcpRedisConnection(url)), opts.streams, opts.now);
  await bus.start();
  return bus;
}
