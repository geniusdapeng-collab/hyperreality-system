/**
 * adapters/nats · NATS JetStream 持久化适配器（生产主选，既定 ADR-1）
 *
 * 真实 JetStream 流程（无私有 API）：
 *  - 建流：$JS.API.STREAM.CREATE（retention/max_age 按拓扑表；storage=file）；
 *  - 发布：HPUB（Nats-Msg-Id 去重窗）→ JetStream PubAck 的 seq 即服务器位点；
 *  - 消费组：$JS.API.CONSUMER.DURABLE.CREATE（push 模式 deliver_subject + ack_policy=explicit +
 *    max_ack_pending + ack_wait）——服务器把消息推到 deliver_subject，适配器维护
 *    「已送达未 ack」表（msgId → ackReply），ack = 向 ackReply 回 +ACK（真实语义）；
 *  - 崩溃恢复：重连后重建同名 durable 订阅，ack_wait 到期服务器自动重投未 ack 消息；
 *  - 重放：临时有序 consumer（ack_policy=none, deliver_policy=all）拉全量后即删；
 *  - deliver-at：独立延迟流 wl-delayed + 常驻 durable（wl-lift）——适配器收进延迟挂起表，
 *    到点 +ACK 并转入目标流（对焦稿 §4.1「延迟主题 + lift」）。
 *
 * 连接抽象 NatsConnection：生产 = TcpNatsConnection（NATS 文本协议子集，node:net）；
 * 测试 = 进程内 FakeNatsServer（testing/fake-nats.ts，真实 TCP 起服务，全链路走真协议）。
 */
import { randomUUID } from "node:crypto";
import type { BusBackend, OutboxMsg, PersistedMsg, StreamSpec } from "../mirrored.js";

/* ================= 连接抽象 ================= */

export interface NatsFrame { payload: unknown; replyTo?: string }

export interface NatsConnection {
  /** 请求-响应（JetStream API）：等单条 JSON 响应 */
  request(subject: string, payload: unknown, timeoutMs?: number): Promise<unknown>;
  /** 发布（msgId → HPUB Nats-Msg-Id 去重头） */
  publish(subject: string, payload: unknown, opts?: { replyTo?: string; msgId?: string }): Promise<void>;
  /** 订阅（返回退订函数） */
  subscribe(subject: string, onMsg: (frame: NatsFrame) => void): Promise<() => void>;
  close(): Promise<void>;
}

const DELAY_STREAM = "wl-delayed";
const DELAY_CONSUMER = "wl-lift";

interface DeliveredPending { msgId: string; ackReply: string; msg: OutboxMsg }

export class NatsBackend implements BusBackend {
  /** 每消费组：已送达未 ack（msgId → 明细） */
  private groupPending = new Map<string, Map<string, DeliveredPending>>();
  private delayPending = new Map<string, DeliveredPending>();
  private unsubs: Array<() => void> = [];

  constructor(private conn: NatsConnection) {}

  /* ---------- 建流 ---------- */
  async ensureStreams(specs: StreamSpec[]): Promise<void> {
    for (const s of [...specs, { name: DELAY_STREAM, subjects: [`${DELAY_STREAM}.>`], retention: "limits" as const }]) {
      await this.conn.request(`$JS.API.STREAM.CREATE.${s.name}`, {
        name: s.name,
        subjects: s.subjects,
        retention: s.retention === "workqueue" ? "workqueue" : "limits",
        max_age: s.maxAgeMs ? s.maxAgeMs * 1e6 : undefined,
        storage: "file",
        duplicate_window: 120e9,
      }).catch((e) => { if (!/already in use|stream name/.test(String(e))) throw e; });
    }
  }

  /* ---------- 发布 ---------- */
  async publishUp(msg: OutboxMsg): Promise<number> {
    const subject = `${msg.stream}.${msg.subject}`;
    const resp = await this.conn.request(subject, {
      __wl_msg_id: msg.msgId, __wl_ts: msg.ts, __wl_deliver_at: msg.deliverAt,
      ...asRecord(msg.payload),
    }, 8000) as { seq?: number };
    return resp?.seq ?? 0;
  }

  /* ---------- 重放（临时有序 consumer） ---------- */
  async fetchLog(stream: string): Promise<PersistedMsg[]> {
    const name = `wl-replay-${randomUUID().slice(0, 8)}`;
    const deliver = `wl.replay.${randomUUID()}`;
    const out: PersistedMsg[] = [];
    const seen = new Set<string>();
    const unsub = await this.conn.subscribe(deliver, (f) => {
      const m = this.decodeMsg(stream, f);
      if (m && !seen.has(m.msgId)) { seen.add(m.msgId); out.push(m); }
    });
    try {
      await this.conn.request(`$JS.API.CONSUMER.CREATE.${stream}`, {
        stream_name: stream,
        config: {
          name,
          // 真实 JetStream 纪律：workqueue 流拒绝 ack_policy=none（err 10098）——
          // 重放是只读语义：explicit 但不 ack，临时消费者 inactive_threshold 后自动回收
          ack_policy: "explicit", deliver_policy: "all", replay_policy: "instant",
          deliver_subject: deliver, inactive_threshold: 5e9,
        },
      });
      // 等推送静止（无 NEXT 拉取的 push consumer 会立即全量推完）
      await waitQuiet(() => out.length, 120, 5000);
    } finally {
      await unsub();
      await this.conn.request(`$JS.API.CONSUMER.DELETE.${stream}.${name}`, {}).catch(() => null);
    }
    return out.sort((a, b) => a.serverSeq - b.serverSeq);
  }

  private decodeMsg(stream: string, f: NatsFrame): PersistedMsg | null {
    const p = asRecord(f.payload);
    if (Object.keys(p).length === 0) return null;
    const replyMeta = parseAckReply(f.replyTo);
    return {
      msgId: String(p.__wl_msg_id ?? randomUUID()),
      stream,
      subject: replyMeta?.subject ?? String(p.__wl_subject ?? ""),
      payload: stripMeta(p),
      ts: Number(p.__wl_ts ?? 0),
      deliverAt: Number(p.__wl_deliver_at ?? 0),
      serverSeq: replyMeta?.streamSeq ?? 0,
    };
  }

  /* ---------- 消费组（push durable） ---------- */
  async ensureGroup(stream: string, group: string, opts: { maxAckPending: number; ackWaitMs: number }): Promise<void> {
    const deliver = `wl.deliver.${stream}.${group}`;
    const key = `${stream}/${group}`;
    if (!this.groupPending.has(key)) {
      this.groupPending.set(key, new Map());
      const unsub = await this.conn.subscribe(deliver, (f) => {
        const m = this.decodeMsg(stream, f);
        if (m && f.replyTo) {
          this.groupPending.get(key)!.set(m.msgId, { msgId: m.msgId, ackReply: f.replyTo, msg: m });
        }
      });
      this.unsubs.push(unsub);
    }
    await this.conn.request(`$JS.API.CONSUMER.DURABLE.CREATE.${stream}.${group}`, {
      stream_name: stream,
      config: {
        name: group, durable_name: group,
        ack_policy: "explicit", max_ack_pending: opts.maxAckPending,
        ack_wait: opts.ackWaitMs * 1e6,
        deliver_policy: "all", replay_policy: "instant",
        deliver_subject: deliver,
      },
    }).catch((e) => { if (!/already|exist/.test(String(e))) throw e; });
  }

  async ackUp(stream: string, group: string, msgId: string): Promise<void> {
    const key = `${stream}/${group}`;
    const p = this.groupPending.get(key)?.get(msgId);
    if (p) {
      await this.conn.publish(p.ackReply, "+ACK");
      this.groupPending.get(key)!.delete(msgId);
    }
  }

  async groupUnacked(stream: string, group: string): Promise<string[]> {
    // 真相在服务器：崩溃重建后本地 pending 为空，须等 durable 消费者按 ack_wait 重投。
    // 以 CONSUMER.INFO.num_ack_pending 为目标数做有界等待（fake 即时、真实 ≤ ack_wait+余量）。
    const key = `${stream}/${group}`;
    const info = asRecord(await this.conn.request(`$JS.API.CONSUMER.INFO.${stream}.${group}`, {})
      .catch(() => ({})));
    const target = Number(info.num_ack_pending ?? 0);
    await this.waitPending(key, target);
    return [...(this.groupPending.get(key)?.keys() ?? [])];
  }

  /** 有界等待服务器把未 ack 消息重投到本地 pending（恢复确定性核心） */
  private async waitPending(key: string, target: number, budgetMs = 40_000): Promise<void> {
    if (target <= 0) return;
    const deadline = Date.now() + budgetMs;
    const sizeOf = key === `${DELAY_STREAM}/${DELAY_CONSUMER}`
      ? () => this.delayPending.size
      : () => this.groupPending.get(key)?.size ?? 0;
    while (sizeOf() < target && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /* ---------- deliver-at 延迟队列 ---------- */
  async delayUp(msg: OutboxMsg): Promise<void> {
    // 延迟流承载；目标 stream/subject/deliverAt 内嵌 payload
    await this.conn.publish(`${DELAY_STREAM}.item`, {
      __wl_msg_id: msg.msgId, __wl_ts: msg.ts, __wl_deliver_at: msg.deliverAt,
      target_stream: msg.stream, subject: msg.subject, payload: msg.payload,
    }, { msgId: msg.msgId });
  }

  private async ensureLift(): Promise<void> {
    const deliver = `wl.deliver.${DELAY_STREAM}.${DELAY_CONSUMER}`;
    if (!this.delayPending.size && !this.liftReady) {
      this.liftReady = true;
      const unsub = await this.conn.subscribe(deliver, (f) => {
        const p = asRecord(f.payload);
        const msgId = String(p.__wl_msg_id ?? randomUUID());
        if (f.replyTo) {
          this.delayPending.set(msgId, {
            msgId, ackReply: f.replyTo,
            msg: {
              msgId,
              stream: String(p.target_stream ?? DELAY_STREAM),
              subject: String(p.subject ?? ""),
              payload: p.payload,
              ts: Number(p.__wl_ts ?? 0),
              deliverAt: Number(p.__wl_deliver_at ?? 0),
            },
          });
        }
      });
      this.unsubs.push(unsub);
      await this.conn.request(`$JS.API.CONSUMER.DURABLE.CREATE.${DELAY_STREAM}.${DELAY_CONSUMER}`, {
        stream_name: DELAY_STREAM,
        config: {
          name: DELAY_CONSUMER, durable_name: DELAY_CONSUMER,
          ack_policy: "explicit", ack_wait: 30e9,
          deliver_policy: "all", replay_policy: "instant",
          deliver_subject: deliver,
        },
      }).catch((e) => { if (!/already|exist/.test(String(e))) throw e; });
    }
  }
  private liftReady = false;

  async liftDue(now: number, limit: number): Promise<OutboxMsg[]> {
    await this.ensureLift();
    // 崩溃重建后延迟消息同样靠服务器重投：有界等待到 num_ack_pending
    const info = asRecord(await this.conn.request(`$JS.API.CONSUMER.INFO.${DELAY_STREAM}.${DELAY_CONSUMER}`, {})
      .catch(() => ({})));
    await this.waitPending(`${DELAY_STREAM}/${DELAY_CONSUMER}`, Number(info.num_ack_pending ?? 0));
    const out: OutboxMsg[] = [];
    for (const [msgId, p] of this.delayPending) {
      if (out.length >= limit) break;
      if (p.msg.deliverAt <= now) {
        await this.conn.publish(p.ackReply, "+ACK");
        this.delayPending.delete(msgId);
        out.push(p.msg);
      }
    }
    return out;
  }

  async close(): Promise<void> {
    for (const u of this.unsubs.splice(0)) await u();
    await this.conn.close();
  }
}

/* ================= 工具 ================= */

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : { value: v };
}
function stripMeta(p: Record<string, unknown>): unknown {
  const { __wl_msg_id: _a, __wl_ts: _b, __wl_deliver_at: _c, __wl_subject: _d, ...rest } = p;
  return Object.keys(rest).length === 1 && "value" in rest ? rest.value : rest;
}
/** JetStream ackReply 形如 $JS.ACK.{stream}.{consumer}.{delivered}.{sseq}.{cseq}.{ts}.{pending} */
function parseAckReply(reply?: string): { streamSeq: number; subject: string } | null {
  if (!reply || !reply.startsWith("$JS.ACK.")) return null;
  const parts = reply.split(".");
  const sseq = Number(parts[5] ?? 0);
  return { streamSeq: Number.isFinite(sseq) ? sseq : 0, subject: "" };
}
async function waitQuiet(count: () => number, quietMs: number, maxMs: number): Promise<void> {
  const start = Date.now();
  let last = -1, quietStart = Date.now();
  while (Date.now() - start < maxMs) {
    const c = count();
    if (c !== last) { last = c; quietStart = Date.now(); }
    if (Date.now() - quietStart >= quietMs) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/* ================= TCP 客户端（生产；NATS 文本协议子集） ================= */

export class TcpNatsConnection implements NatsConnection {
  private socket!: import("node:net").Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private sid = 0;
  private subscriptions = new Map<string, (f: NatsFrame) => void>();
  private pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ready: Promise<void>;

  constructor(private url: string) {
    this.ready = this.connect();
  }

  private async connect(): Promise<void> {
    const { default: net } = await import("node:net");
    const u = new URL(this.url);
    this.socket = net.createConnection({ host: u.hostname, port: Number(u.port || 4222) });
    this.socket.setNoDelay(true);
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.socket.on("error", (err) => {
      for (const [, p] of this.pendingRequests) { clearTimeout(p.timer); p.reject(err); }
      this.pendingRequests.clear();
    });
    await new Promise<void>((resolve, reject) => {
      this.socket.once("connect", () => resolve());
      this.socket.once("error", reject);
    });
    const auth = u.username ? { user: u.username, pass: u.password } : {};
    this.raw(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false, lang: "ts", version: "0.1.0", protocol: 1, headers: true, ...auth })}\r\n`);
    this.raw("PING\r\n");
  }

  private raw(s: string): void { this.socket.write(s); }

  private onData(chunk: Buffer): void {
    // 字节级组帧：协议长度字段是字节数——中文等多字节负载下，字符串长度 ≠ 字节长度，
    // 用字符串组帧会在含中文时永远等不到「完整帧」（演练实证：501 中文描述触发 5s 超时）
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const lineEnd = this.buffer.indexOf("\r\n");
      if (lineEnd < 0) return;
      const line = this.buffer.subarray(0, lineEnd).toString("utf-8");
      if (line.startsWith("MSG ") || line.startsWith("HMSG ")) {
        const parts = line.split(" ");
        const hmsg = line.startsWith("HMSG ");
        // MSG subj sid [reply] len ｜ HMSG subj sid [reply] hdrLen totalLen
        const len = Number(parts[parts.length - 1]);
        const headerLen = hmsg ? Number(parts[parts.length - 2]) : 0;
        if (this.buffer.length < lineEnd + 2 + len + 2) return;
        const frameRaw = this.buffer.subarray(lineEnd + 2, lineEnd + 2 + len).toString("utf-8");
        this.buffer = this.buffer.subarray(lineEnd + 2 + len + 2);
        const payloadRaw = hmsg ? frameRaw.slice(headerLen) : frameRaw;
        const subject = parts[1]!;
        const sid = parts[2]!;
        const expectLen = hmsg ? 6 : 5;
        const replyTo = parts.length === expectLen ? parts[3] : undefined;
        let payload: unknown = payloadRaw;
        try { payload = JSON.parse(payloadRaw); } catch { /* 原样字符串 */ }
        const req = this.pendingRequests.get(sid);
        if (req) {
          clearTimeout(req.timer);
          this.pendingRequests.delete(sid);
          this.raw(`UNSUB ${sid}\r\n`);
          const rawErr = asRecord(payload).error;
          const err = rawErr !== null && typeof rawErr === "object" ? rawErr as Record<string, unknown> : {};
          if (Object.keys(err).length > 0) req.reject(new Error(`JetStream API 错误：${JSON.stringify(err)}`));
          else req.resolve(payload);
        } else {
          this.subscriptions.get(sid)?.({ payload, replyTo });
        }
        continue;
      }
      this.buffer = this.buffer.subarray(lineEnd + 2);
      if (line === "PING") this.raw("PONG\r\n");
      else if (line.startsWith("-ERR")) {
        const err = new Error(line);
        for (const [, p] of this.pendingRequests) { clearTimeout(p.timer); p.reject(err); }
        this.pendingRequests.clear();
      }
      // INFO / +OK / PONG：忽略
    }
  }

  async request(subject: string, payload: unknown, timeoutMs = 5000): Promise<unknown> {
    await this.ready;
    const sid = `req-${++this.sid}`;
    const inbox = `_INBOX.${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(sid);
        this.raw(`UNSUB ${sid}\r\n`);
        reject(new Error(`NATS request 超时：${subject}`));
      }, timeoutMs);
      this.pendingRequests.set(sid, { resolve, reject, timer });
      this.raw(`SUB ${inbox} ${sid}\r\n`);
      const body = JSON.stringify(payload);
      this.raw(`PUB ${subject} ${inbox} ${Buffer.byteLength(body)}\r\n${body}\r\n`);
    });
  }

  async publish(subject: string, payload: unknown, opts: { replyTo?: string; msgId?: string } = {}): Promise<void> {
    await this.ready;
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (opts.msgId) {
      const headers = `NATS/1.0\r\nNats-Msg-Id: ${opts.msgId}\r\n\r\n`;
      const total = Buffer.byteLength(headers) + Buffer.byteLength(body);
      const reply = opts.replyTo ? ` ${opts.replyTo}` : "";
      this.raw(`HPUB ${subject}${reply} ${Buffer.byteLength(headers)} ${total}\r\n${headers}${body}\r\n`);
    } else {
      const reply = opts.replyTo ? ` ${opts.replyTo}` : "";
      this.raw(`PUB ${subject}${reply} ${Buffer.byteLength(body)}\r\n${body}\r\n`);
    }
  }

  async subscribe(subject: string, onMsg: (f: NatsFrame) => void): Promise<() => void> {
    await this.ready;
    const sid = `sub-${++this.sid}`;
    this.subscriptions.set(sid, onMsg);
    this.raw(`SUB ${subject} ${sid}\r\n`);
    return async () => {
      this.subscriptions.delete(sid);
      this.raw(`UNSUB ${sid}\r\n`);
    };
  }

  async close(): Promise<void> {
    await this.ready.catch(() => undefined);
    if (!this.socket) return;
    // 优雅关闭：end() 让写队列（+ACK 等 fire-and-forget 帧）落网后再销毁——
    // 直接 destroy 会在 OS 层丢弃未发出的写（演练实证：丢失两条 ack 导致误重投）
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1500);
      this.socket.once("close", () => { clearTimeout(t); resolve(); });
      this.socket.end();
    });
    this.socket.destroy();
  }
}
