/**
 * memory · MemoryEventBus（起步/测试/演示默认实现，零依赖）
 * 语义与持久化适配器逐字一致（同一接口、同一一致性测试套件）；
 * 进程内存形态——进程重启即在途与位点全丢，生产请用 NatsEventBus/RedisEventBus。
 */
import type { BusMessage, ConsumerGroupLike, EventBusLike, StreamName } from "./types.js";

interface PendingDelivery<T> { msg: BusMessage<T>; deliverCount: number }

export class MemoryConsumerGroup<T = unknown> implements ConsumerGroupLike<T> {
  private pending = new Map<number, PendingDelivery<T>>();
  private cursor = 0; // 下一待拉取位点（durable：崩溃后从本位点重投递）
  private onlySeqs: Set<number> | null = null; // 崩溃恢复限定集（一次性）
  constructor(
    private bus: MemoryEventBus,
    public readonly stream: StreamName,
    public readonly name: string,
    private maxAckPending: number,
  ) {}

  /**
   * 崩溃恢复限定：把游标推到 cursorTo（跳过服务器已 ack 的历史），
   * 首个 pull 只投递 seqs 内的消息（服务器未 ack 集合），随后恢复正常游标语义。
   */
  restrict(seqs: number[], cursorTo: number): void {
    this.onlySeqs = new Set(seqs);
    this.cursor = cursorTo;
  }

  pull(batchSize: number, now: number): BusMessage<T>[] {
    if (this.pending.size >= this.maxAckPending) return []; // 背压：积压留在总线
    const log = this.bus.logOf(this.stream);
    // 恢复模式：一次性投递限定集
    if (this.onlySeqs !== null) {
      const out: BusMessage<T>[] = [];
      for (const m of log) {
        if (out.length >= batchSize || this.pending.size >= this.maxAckPending) break;
        if (this.onlySeqs.has(m.seq) && m.deliverAt <= now && !this.pending.has(m.seq)) {
          this.pending.set(m.seq, { msg: m as BusMessage<T>, deliverCount: 2 });
          out.push(m as BusMessage<T>);
        }
      }
      this.onlySeqs = null;
      return out;
    }
    const out: BusMessage<T>[] = [];
    while (out.length < batchSize && this.pending.size < this.maxAckPending) {
      const next = log.find((m) => m.seq > this.cursor);
      if (!next) break;
      this.cursor = next.seq;
      if (next.deliverAt > now) continue; // 延迟消息未到点：位点照走、不投递
      const msg = next as BusMessage<T>;
      this.pending.set(msg.seq, { msg, deliverCount: 1 });
      out.push(msg);
    }
    return out;
  }

  ack(seq: number): void { this.pending.delete(seq); }

  redeliver(now: number): BusMessage<T>[] {
    const out: BusMessage<T>[] = [];
    for (const [seq, p] of this.pending) {
      if (p.msg.deliverAt <= now) { p.deliverCount += 1; out.push(p.msg); }
    }
    return out;
  }

  pullDueDelayed(now: number): BusMessage<T>[] {
    const log = this.bus.logOf(this.stream);
    const out: BusMessage<T>[] = [];
    for (const m of log) {
      if (m.seq <= this.cursor && m.deliverAt > 0 && m.deliverAt <= now && !this.pending.has(m.seq)) {
        this.pending.set(m.seq, { msg: m as BusMessage<T>, deliverCount: 1 });
        out.push(m as BusMessage<T>);
      }
    }
    return out;
  }

  pendingCount(): number { return this.pending.size; }
  position(): number { return this.cursor; }
  /** 适配器/测试用：当前 pending 明细 */
  pendingSeqs(): number[] { return [...this.pending.keys()]; }
}

export class MemoryEventBus implements EventBusLike {
  private streams = new Map<StreamName, BusMessage[]>();
  private groups = new Map<string, MemoryConsumerGroup>();
  private seq = 0;

  constructor(streams: StreamName[], private now: () => number = () => Date.now()) {
    for (const name of streams) this.streams.set(name, []);
  }

  publish<T>(stream: StreamName, subject: string, payload: T, opts: { deliverAt?: number; ts?: number } = {}): BusMessage<T> {
    const log = this.streams.get(stream);
    if (!log) throw new Error(`未声明的 stream：${stream}`);
    const msg: BusMessage<T> = {
      seq: ++this.seq, stream, subject, payload,
      ts: opts.ts ?? this.now(), deliverAt: opts.deliverAt ?? 0,
    };
    log.push(msg);
    return msg;
  }

  consumer(stream: StreamName, group: string, maxAckPending = 1000): MemoryConsumerGroup {
    const key = `${stream}/${group}`;
    if (!this.groups.has(key)) this.groups.set(key, new MemoryConsumerGroup(this, stream, group, maxAckPending));
    return this.groups.get(key)! as MemoryConsumerGroup;
  }

  replay(stream: StreamName, fromSeq = 0): BusMessage[] {
    return this.logOf(stream).filter((m) => m.seq > fromSeq);
  }

  logOf(stream: StreamName): BusMessage[] {
    const log = this.streams.get(stream);
    if (!log) throw new Error(`未声明的 stream：${stream}`);
    return log;
  }

  /** 消费组滞后量（背压观察：游标之后未拉取的消息数；组不存在按 0 位点计） */
  backlog(stream: StreamName, group: string): number {
    const g = this.groups.get(`${stream}/${group}`);
    const pos = g ? g.position() : 0;
    return this.logOf(stream).filter((m) => m.seq > pos).length;
  }

  async flush(): Promise<void> { /* 内存形态无上行队列 */ }
  async close(): Promise<void> { /* noop */ }
}
