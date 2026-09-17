/**
 * mirrored · 持久化适配器基座（本地镜像 + 后台同步泵）
 *
 * 设计：上层拿的是与 MemoryEventBus 逐字一致的同步接口（零改动）；
 * 真相在服务器（Stream 日志 / 消费组 ack 位点 / 延迟队列全部持久化）。镜像是服务器日志的缓存视图：
 *  - publish：同步写镜像（msgId 去重键）+ 入上行队列，后台泵异步落服务器；
 *  - ack：同步出 pending + 入 ack 上行队列（at-least-once：上行未确认的消息由服务器重投兜底，消费者幂等）；
 *  - 崩溃重启：bootstrap 从服务器全量重建镜像（msgId 去重），消费组按服务器未 ack 清单恢复 pending；
 *  - 延迟消息：deliverAt 未到点的消息存服务器延迟队列（不进流日志），到点 lift 转入目标流——
 *    进程重启后仍必达（转入流日志后对镜像可见）。
 */
import { randomUUID } from "node:crypto";
import { MemoryEventBus, MemoryConsumerGroup } from "./memory.js";
import type { BusMessage, ConsumerGroupLike, EventBusLike, StreamName } from "./types.js";

/** 流声明（拓扑表的一部分：名称 + 主题模式 + 留存） */
export interface StreamSpec {
  name: StreamName;
  subjects: string[];
  /** 留存：limits（按 maxAgeMs）/ workqueue（消费即删） */
  retention?: "limits" | "workqueue";
  maxAgeMs?: number;
}

export interface OutboxMsg {
  msgId: string;
  stream: StreamName;
  subject: string;
  payload: unknown;
  ts: number;
  deliverAt: number;
}

export interface PersistedMsg extends OutboxMsg {
  /** 服务器位点（单调） */
  serverSeq: number;
}

/** 持久化后端协议（NATS JetStream / Redis Streams 各自实现） */
export interface BusBackend {
  ensureStreams(specs: StreamSpec[]): Promise<void>;
  /** 上行发布：返回服务器位点 */
  publishUp(msg: OutboxMsg): Promise<number>;
  /** 全量日志（bootstrap/镜像对齐；按 serverSeq 升序） */
  fetchLog(stream: StreamName): Promise<PersistedMsg[]>;
  /** 确保消费组存在（durable：ack 位点服务端持久化） */
  ensureGroup(stream: StreamName, group: string, opts: { maxAckPending: number; ackWaitMs: number }): Promise<void>;
  /** 上行 ack（按 msgId） */
  ackUp(stream: StreamName, group: string, msgId: string): Promise<void>;
  /** 消费组未 ack 清单（服务器视图；崩溃恢复 pending 用） */
  groupUnacked(stream: StreamName, group: string): Promise<string[]>;
  /** 延迟消息暂存（服务器侧；到点由 liftDue 原子取出） */
  delayUp(msg: OutboxMsg): Promise<void>;
  /** 取到点延迟消息（原子移除；适配器随后 publishUp 到目标流） */
  liftDue(now: number, limit: number): Promise<OutboxMsg[]>;
  close(): Promise<void>;
}

interface PendingUp { msg: OutboxMsg }
interface PendingAck { stream: StreamName; group: string; msgId: string }

export class MirroredEventBus implements EventBusLike {
  private mirror: MemoryEventBus;
  private msgIdBySeq = new Map<number, string>();
  private upQueue: PendingUp[] = [];
  private ackQueue: PendingAck[] = [];
  private groups = new Map<string, MirroredConsumerGroup>();
  private groupInits: Promise<void>[] = [];
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private booted = false;
  private closed = false;

  constructor(
    private backend: BusBackend,
    private specs: StreamSpec[],
    private now: () => number = () => Date.now(),
    pumpMs = 50,
    ackWaitMs = 30_000,
  ) {
    this.mirror = new MemoryEventBus(specs.map((s) => s.name), now);
    this.pumpMs = pumpMs;
    this.ackWaitMs = ackWaitMs;
  }
  private pumpMs: number;
  /** 消费组 ack_wait：崩溃后服务器按此时长重投未 ack 消息（演练/演示可调小加速恢复） */
  private ackWaitMs: number;

  /** 启动：建流 → 全量重建镜像 → 启动后台泵（必须先 await 再使用） */
  async start(): Promise<void> {
    if (this.booted) return;
    await this.backend.ensureStreams(this.specs);
    for (const spec of this.specs) {
      const log = await this.backend.fetchLog(spec.name);
      for (const pm of log) this.mirrorAppend(pm);
    }
    this.booted = true;
    // 定时泵：正在 flush 时跳过（不置补跑标记——否则 10ms 级定时器会让 do-while 永不退出）
    this.pumpTimer = setInterval(() => {
      if (this.flushing || this.closed) return;
      void this.flush().catch(() => undefined);
    }, this.pumpMs);
    (this.pumpTimer as unknown as { unref?: () => void }).unref?.();
  }

  private mirrorAppend(pm: PersistedMsg): BusMessage {
    const existingSeq = [...this.msgIdBySeq.entries()].find(([, id]) => id === pm.msgId)?.[0];
    if (existingSeq !== undefined) return this.mirror.logOf(pm.stream).find((m) => m.seq === existingSeq)!;
    const msg = this.mirror.publish(pm.stream, pm.subject, pm.payload, { ts: pm.ts, deliverAt: pm.deliverAt });
    this.msgIdBySeq.set(msg.seq, pm.msgId);
    return msg;
  }

  publish<T>(stream: StreamName, subject: string, payload: T, opts: { deliverAt?: number; ts?: number } = {}): BusMessage<T> {
    const om: OutboxMsg = {
      msgId: randomUUID(), stream, subject, payload,
      ts: opts.ts ?? this.now(), deliverAt: opts.deliverAt ?? 0,
    };
    const msg = this.mirrorAppend({ ...om, serverSeq: 0 });
    this.upQueue.push({ msg: om });
    return msg as BusMessage<T>;
  }

  consumer(stream: StreamName, group: string, maxAckPending = 1000): ConsumerGroupLike {
    const key = `${stream}/${group}`;
    if (!this.groups.has(key)) {
      const g = new MirroredConsumerGroup(this, this.mirror.consumer(stream, group, maxAckPending), stream, group, maxAckPending);
      this.groups.set(key, g);
      this.groupInits.push(this.backend.ensureGroup(stream, group, { maxAckPending, ackWaitMs: this.ackWaitMs })
        .then(() => g.restore())
        .catch(() => undefined));
    }
    return this.groups.get(key)!;
  }

  replay(stream: StreamName, fromSeq = 0): BusMessage[] { return this.mirror.replay(stream, fromSeq); }
  logOf(stream: StreamName): BusMessage[] { return this.mirror.logOf(stream); }
  /** 消费组滞后量（背压观察，镜像视图） */
  backlog(stream: StreamName, group: string): number { return this.mirror.backlog(stream, group); }

  /** 内部：流日志末尾位点（恢复游标用；空流为 0） */
  endSeqOf(stream: StreamName): number {
    const log = this.mirror.logOf(stream);
    return log.length > 0 ? log[log.length - 1]!.seq : 0;
  }

  /** 内部：ack 上行入队（按镜像 seq 反查 msgId） */
  enqueueAckBySeq(stream: StreamName, group: string, seq: number): void {
    const msgId = this.msgIdBySeq.get(seq);
    if (msgId) this.ackQueue.push({ stream, group, msgId });
  }

  /** 内部：消费组崩溃恢复（服务器未 ack 清单 → 镜像消息） */
  async unackedOf(stream: StreamName, group: string): Promise<BusMessage[]> {
    const ids = await this.backend.groupUnacked(stream, group);
    const seqById = new Map([...this.msgIdBySeq.entries()].map(([s, id]) => [id, s]));
    const out: BusMessage[] = [];
    for (const id of ids) {
      const seq = seqById.get(id);
      if (seq !== undefined) {
        const m = this.mirror.logOf(stream).find((x) => x.seq === seq);
        if (m) out.push(m);
      }
    }
    return out;
  }

  /** 强制对齐：上行队列落服务器 → 延迟 lift → 镜像补充新消息 */
  /**
   * 上行/下行泵。重入安全：内部定时器与外部调用可能并发——
   * 并发 flush 会让两条泵看到同一个未出队的 outbox 项导致重复发布
   * （演练实证：重复项挤占流内 seq，ack 路由整体偏移）。互斥 + 补跑标记。
   */
  private flushing = false;
  private flushAgain = false;
  async flush(): Promise<void> {
    if (this.closed) return;
    // 仅外部调用参与补跑：并发的外部 flush 合并为「当前这轮跑完再补一轮」
    if (this.flushing) { this.flushAgain = true; return; }
    this.flushing = true;
    try {
      do {
        this.flushAgain = false;
        await this.flushOnce();
      } while (this.flushAgain && !this.closed);
    } finally {
      this.flushing = false;
    }
  }

  private async flushOnce(): Promise<void> {
    // ⓪ 等待消费组建组与恢复完成（确定性语义）
    if (this.groupInits.length > 0) await Promise.allSettled(this.groupInits.splice(0));
    // ① publish 上行（未到点的延迟消息分流到服务器延迟队列）
    while (this.upQueue.length > 0) {
      const item = this.upQueue[0]!;
      if (item.msg.deliverAt > this.now()) await this.backend.delayUp(item.msg);
      else await this.backend.publishUp(item.msg);
      this.upQueue.shift();
    }
    // ② ack 上行
    while (this.ackQueue.length > 0) {
      const a = this.ackQueue[0]!;
      await this.backend.ackUp(a.stream, a.group, a.msgId);
      this.ackQueue.shift();
    }
    // ③ 延迟 lift：到点消息转入目标流
    const due = await this.backend.liftDue(this.now(), 500);
    for (const om of due) await this.backend.publishUp(om);
    // ④ 镜像补充（lift 回流/多写者）
    for (const spec of this.specs) {
      const log = await this.backend.fetchLog(spec.name);
      for (const pm of log) this.mirrorAppend(pm);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.pumpTimer) { clearInterval(this.pumpTimer); this.pumpTimer = null; }
    await this.flush().catch(() => undefined);
    this.closed = true;
    await this.backend.close();
  }
}

/** 镜像消费组：同步外观（委托内存组）+ ack 上行 + 启动时按服务器未 ack 清单恢复 pending */
class MirroredConsumerGroup<T = unknown> implements ConsumerGroupLike<T> {
  private restoreDone = false;
  constructor(
    private owner: MirroredEventBus,
    private inner: MemoryConsumerGroup,
    public readonly stream: StreamName,
    public readonly name: string,
    private maxAckPending: number,
  ) {}

  /**
   * 崩溃恢复：服务器未 ack 的消息构成限定集，游标推到镜像末尾——
   * 已 ack 的历史不重投，未 ack 的由首个 pull 重投（at-least-once 兜底，消费者幂等）。
   */
  async restore(): Promise<void> {
    if (this.restoreDone) return;
    this.restoreDone = true;
    const msgs = (await this.owner.unackedOf(this.stream, this.name)) as BusMessage<T>[];
    if (msgs.length > 0) {
      this.inner.restrict(msgs.map((m) => m.seq), this.owner.endSeqOf(this.stream));
    }
  }

  pull(batchSize: number, now: number): BusMessage<T>[] {
    return this.inner.pull(batchSize, now) as BusMessage<T>[];
  }

  ack(seq: number): void {
    this.inner.ack(seq);
    this.owner.enqueueAckBySeq(this.stream, this.name, seq);
  }

  redeliver(now: number): BusMessage<T>[] {
    return this.inner.redeliver(now) as BusMessage<T>[];
  }

  pullDueDelayed(now: number): BusMessage<T>[] {
    return this.inner.pullDueDelayed(now) as BusMessage<T>[];
  }

  pendingCount(): number { return this.inner.pendingCount(); }
  position(): number { return this.inner.position(); }
}
