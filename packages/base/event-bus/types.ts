/**
 * event-bus · 事件总线公共契约（P0-3：接口冻结，上层零改动）
 *
 * 语义对齐 NATS JetStream（既定 ADR-1）：四条 Stream（留存各异）/ 消费组扇出（一条事件 N 组
 * 独立位点消费）/ deliver-at 延迟消息（SLA 到期、回访第 3 天、灰度观察期结束，替代定时扫表）/
 * 显式 ack + maxAckPending 背压（积压留在总线持久层，不靠丢消息削峰）/ 位点重放（投影重建）。
 *
 * 三种实现共享本接口：
 *  - MemoryEventBus（起步/测试/演示默认，零依赖）
 *  - NatsEventBus（生产主选：NATS JetStream 持久化适配器）
 *  - RedisEventBus（生产备选：Redis Streams 持久化适配器，证明接口可替换）
 *
 * 持久化适配器采用「本地镜像 + 后台同步泵」：
 *  - 上层看到的是同步接口（与内存版签名逐字一致，上层零改动）；
 *  - 真相在服务器（Stream/Consumer 位点持久化）——镜像只是缓存视图，崩溃重启后从服务器重建；
 *  - publish/ack 经上行队列异步落服务器（写背后台泵）；服务器未确认的消息崩溃后由
 *    outbox/重投递语义兜底（at-least-once，消费者按 event_id 幂等——纪律同 outbox-relay）。
 */

export type StreamName = string;

export interface BusMessage<T = unknown> {
  /** 全局单调位点（重放基准；适配器侧 = 服务器位点的镜像视图） */
  seq: number;
  stream: StreamName;
  subject: string;
  payload: T;
  /** 事件产生时刻（服务端权威时钟） */
  ts: number;
  /** deliver-at：到点前对消费者不可见（0 = 立即） */
  deliverAt: number;
}

/** 消费组（durable 语义：崩溃后从位点重投递；ack 前消息永不丢） */
export interface ConsumerGroupLike<T = unknown> {
  readonly stream: StreamName;
  readonly name: string;
  /** 拉取一批可见消息（deliverAt 已到点且未超背压上限）；返回的消息进入 pending 待 ack */
  pull(batchSize: number, now: number): BusMessage<T>[];
  /** 确认消费完成（幂等；未 ack 的消息将由 redeliver 重投） */
  ack(seq: number): void;
  /** 未 ack 重投递（deliver-at 到点消息也经此变为可见） */
  redeliver(now: number): BusMessage<T>[];
  /** 延迟消息到点补投 */
  pullDueDelayed(now: number): BusMessage<T>[];
  /** 当前待 ack 数（背压观察） */
  pendingCount(): number;
  /** 当前位点 */
  position(): number;
}

export interface EventBusLike {
  /**
   * 发布（纪律：调用方须先落库后上总线——transactional outbox，见 outbox-relay）；
   * 适配器侧：同步写入本地镜像并入上行队列，后台泵异步落服务器（flush() 可强制对齐）。
   */
  publish<T>(stream: StreamName, subject: string, payload: T, opts?: { deliverAt?: number; ts?: number }): BusMessage<T>;
  /** 注册/获取消费组（扇出：同一 stream 多组各自独立位点） */
  consumer(stream: StreamName, group: string, maxAckPending?: number): ConsumerGroupLike;
  /** 位点重放（投影/新版本上线后从历史位点重建） */
  replay(stream: StreamName, fromSeq?: number): BusMessage[];
  /** 读取流日志（镜像视图） */
  logOf(stream: StreamName): BusMessage[];
  /** 消费组滞后量（背压观察：游标之后未拉取的消息数） */
  backlog?(stream: StreamName, group: string): number;
  /** 强制把上行队列（publish/ack）刷到服务器并拉齐镜像（测试与 outbox 泵点用） */
  flush(): Promise<void>;
  /** 关闭后台泵与连接 */
  close(): Promise<void>;
}
