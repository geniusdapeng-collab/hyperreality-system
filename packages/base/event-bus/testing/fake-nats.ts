/**
 * testing/fake-nats · 进程内 JetStream 仿真服务器（真实 TCP + 真协议子集）
 *
 * 用途：无外部依赖地全链路验证 NatsBackend + TcpNatsConnection——
 * 客户端走真实 NATS 文本协议，服务端在本进程内仿真 JetStream 语义：
 *  - Stream：CREATE/按名捕获发布（subject 前缀匹配）/seq 单调/Nats-Msg-Id 去重窗/PubAck；
 *  - Push Consumer：DURABLE.CREATE（deliver_subject 推送 + ackReply 跟踪 + 未 ack 清单 +
 *    同名 durable 重建订阅时重投未 ack——ack_wait 的确定性等价）；
 *  - 临时 consumer（replay）：CREATE（无 durable）→ 全量推送 → DELETE；
 *  - 状态保存在服务器实例内：客户端断线重连（模拟进程崩溃重启）后仍在——持久化语义可测。
 *
 * 纪律：本文件只用于测试（不进生产装配路径）；仿真的是「我们使用的语义子集」，不是完整 JetStream。
 */
import { createServer, type Server, type Socket } from "node:net";

interface FakeStream {
  name: string;
  subjects: string[];
  retention: "limits" | "workqueue";
  seq: number;
  messages: Array<{ seq: number; subject: string; payload: string; msgId: string | null; ts: number }>;
  dedupe: Set<string>;
}
interface FakeConsumer {
  stream: string;
  name: string;
  durable: boolean;
  deliverSubject: string;
  ackWaitMs: number;
  maxAckPending: number;
  /** ack_policy=none（重放/只读 consumer：不计 pending、不受背压） */
  ackNone: boolean;
  /** 已推送未 ack：seq → 明细 */
  pending: Map<number, { ackReply: string; deliveries: number }>;
  nextDeliver: number; // 下一条待推送的流内位点（1-based）
}

interface ClientConn {
  socket: Socket;
  buffer: Buffer;
  subs: Map<string, string>; // sid → subject
}

export class FakeNatsServer {
  private server: Server;
  private streams = new Map<string, FakeStream>();
  private consumers = new Map<string, FakeConsumer>();
  private conns = new Set<ClientConn>();
  port = 0;

  /** 测试只读：流内全量消息（到达序） */
  streamMessages(stream: string): { seq: number; payload: string }[] {
    return [...(this.streams.get(stream)?.messages ?? [])];
  }

  constructor(private opts: { ackWaitMs?: number } = {}) {
    this.server = createServer((socket) => this.onConn(socket));
  }

  async start(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.socket.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  url(): string { return `nats://127.0.0.1:${this.port}`; }

  /* ---------- 连接与协议 ---------- */
  private onConn(socket: Socket): void {
    const conn: ClientConn = { socket, buffer: Buffer.alloc(0), subs: new Map() };
    this.conns.add(conn);
    socket.setNoDelay(true);
    socket.write(`INFO {"server_id":"fake-jetstream","version":"2.11.0","jetstream":true}\r\n`);
    socket.on("data", (chunk: Buffer) => this.onData(conn, chunk));
    socket.on("close", () => this.conns.delete(conn));
    socket.on("error", () => this.conns.delete(conn));
  }

  private send(conn: ClientConn, s: string): void {
    if (!conn.socket.destroyed) conn.socket.write(s);
  }

  private onData(conn: ClientConn, chunk: Buffer): void {
    // 字节级组帧：协议长度字段是字节数，中文负载下字符串长度会失真（与客户端同修）
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    for (;;) {
      const lineEnd = conn.buffer.indexOf("\r\n");
      if (lineEnd < 0) return;
      const line = conn.buffer.subarray(0, lineEnd).toString("utf-8");
      if (line.startsWith("PUB ") || line.startsWith("HPUB ")) {
        const parts = line.split(" ");
        const isH = line.startsWith("HPUB ");
        const totalLen = Number(parts[parts.length - 1]);
        if (conn.buffer.length < lineEnd + 2 + totalLen + 2) return;
        const frame = conn.buffer.subarray(lineEnd + 2, lineEnd + 2 + totalLen).toString("utf-8");
        conn.buffer = conn.buffer.subarray(lineEnd + 2 + totalLen + 2);
        let payload = frame, msgId: string | null = null;
        if (isH) {
          const hdrEnd = frame.indexOf("\r\n\r\n");
          const headers = frame.slice(0, hdrEnd);
          payload = frame.slice(hdrEnd + 4);
          const m = headers.match(/Nats-Msg-Id:\s*(\S+)/i);
          msgId = m?.[1] ?? null;
        }
        const subject = parts[1]!;
        // PUB subj [reply] len（parts 3/4）｜ HPUB subj [reply] hdrLen totalLen（parts 4/5）
        const replyTo = isH
          ? (parts.length === 5 ? parts[2] : undefined)
          : (parts.length === 4 ? parts[2] : undefined);
        this.onPublish(conn, subject, payload, replyTo, msgId);
        continue;
      }
      conn.buffer = conn.buffer.subarray(lineEnd + 2);
      const [cmd, ...rest] = line.split(" ");
      if (cmd === "PING") this.send(conn, "PONG\r\n");
      else if (cmd === "CONNECT") { /* 接受即成功 */ }
      else if (cmd === "SUB") {
        const subject = rest[0]!;
        const sid = rest[rest.length - 1]!;
        conn.subs.set(sid, subject);
        // durable 重建订阅：重投该 deliver_subject 关联 consumer 的未 ack
        this.redeliverPending(conn, subject, sid);
      } else if (cmd === "UNSUB") {
        conn.subs.delete(rest[0]!);
      }
    }
  }

  /* ---------- 发布路由 ---------- */
  private onPublish(conn: ClientConn, subject: string, payload: string, replyTo: string | undefined, msgId: string | null): void {
    // ① JetStream API
    if (subject.startsWith("$JS.API.")) {
      this.handleApi(conn, subject, payload, replyTo);
      return;
    }
    // ② ack（$JS.ACK.{stream}.{consumer}...）
    if (subject.startsWith("$JS.ACK.")) {
      const parts = subject.split(".");
      const stream = parts[2]!, consumer = parts[3]!;
      const seq = Number(parts[5] ?? 0);
      const c = this.consumers.get(`${stream}/${consumer}`);
      if (c && payload.includes("+ACK")) {
        c.pending.delete(seq);
      }
      return;
    }
    // ③ 普通订阅投递（原始 payload，无 reply）
    this.deliverRaw(subject, payload);
    // ④ 流捕获
    const streamName = subject.split(".")[0]!;
    const stream = this.streams.get(streamName);
    if (stream) {
      if (msgId && stream.dedupe.has(msgId)) {
        if (replyTo) this.deliverMsg(conn, replyTo, JSON.stringify({ stream: streamName, seq: 0, duplicate: true }));
        return;
      }
      if (msgId) stream.dedupe.add(msgId);
      const seq = ++stream.seq;
      stream.messages.push({ seq, subject, payload, msgId, ts: Date.now() });
      if (replyTo) this.deliverMsg(conn, replyTo, JSON.stringify({ stream: streamName, seq }));
      // 推送到该流的 push consumers
      for (const c of this.consumers.values()) {
        if (c.stream === streamName) this.deliverToConsumer(c, seq);
      }
    }
  }

  private deliverRaw(subject: string, payload: string): void {
    for (const conn of this.conns) {
      for (const [sid, sub] of conn.subs) {
        if (sub === subject || (sub.endsWith(".>") && subject.startsWith(sub.slice(0, -1)))) {
          this.send(conn, `MSG ${subject} ${sid} ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
        }
      }
    }
  }

  private deliverMsg(conn: ClientConn, subject: string, payload: string): void {
    for (const [sid, sub] of conn.subs) {
      if (sub === subject) {
        this.send(conn, `MSG ${subject} ${sid} ${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
      }
    }
  }

  /* ---------- 消费组投递与 ack ---------- */
  private deliverToConsumer(c: FakeConsumer, seq: number): void {
    const stream = this.streams.get(c.stream)!;
    const m = stream.messages.find((x) => x.seq === seq);
    if (!m) return;
    if (!c.ackNone && c.pending.size >= c.maxAckPending) return; // 背压：留在 pending/未投递
    const ackReply = c.ackNone ? "" : `$JS.ACK.${c.stream}.${c.name}.1.${seq}.${seq}.${Date.now()}.0`;
    if (!c.ackNone) c.pending.set(seq, { ackReply, deliveries: 1 });
    c.nextDeliver = seq + 1;
    // 投递到 deliver_subject 的所有订阅者（帧带 reply=ackReply）
    const frame = m.payload;
    for (const conn of this.conns) {
      for (const [sid, sub] of conn.subs) {
        if (sub === c.deliverSubject) {
          const head = ackReply ? `MSG ${c.deliverSubject} ${sid} ${ackReply} ` : `MSG ${c.deliverSubject} ${sid} `;
          this.send(conn, `${head}${Buffer.byteLength(frame)}\r\n${frame}\r\n`);
        }
      }
    }
  }

  /** durable 重建订阅：把未 ack 的消息重新投递（ack_wait 等价语义） */
  private redeliverPending(conn: ClientConn, subject: string, sid: string): void {
    for (const c of this.consumers.values()) {
      if (c.deliverSubject !== subject) continue;
      const stream = this.streams.get(c.stream);
      if (!stream) continue;
      for (const [seq, p] of c.pending) {
        const m = stream.messages.find((x) => x.seq === seq);
        if (!m) continue;
        p.deliveries += 1;
        this.send(conn, `MSG ${subject} ${sid} ${p.ackReply} ${Buffer.byteLength(m.payload)}\r\n${m.payload}\r\n`);
      }
    }
  }

  /* ---------- JetStream API 子集 ---------- */
  private handleApi(conn: ClientConn, subject: string, payload: string, replyTo: string | undefined): void {
    const reply = (v: unknown) => { if (replyTo) this.deliverMsg(conn, replyTo, JSON.stringify(v)); };
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(payload) as Record<string, unknown>; } catch { /* 空体 */ }
    const parts = subject.split(".");

    if (subject.startsWith("$JS.API.STREAM.CREATE.")) {
      const name = parts[4]!;
      if (this.streams.has(name)) { reply({ error: { code: 400, description: "stream name already in use" } }); return; }
      this.streams.set(name, {
        name,
        subjects: (body.subjects as string[]) ?? [`${name}.>`],
        retention: body.retention === "workqueue" ? "workqueue" : "limits",
        seq: 0, messages: [], dedupe: new Set(),
      });
      reply({ stream: { config: { name } }, did_create: true });
      return;
    }
    if (subject.startsWith("$JS.API.CONSUMER.DURABLE.CREATE.") || subject.startsWith("$JS.API.CONSUMER.CREATE.")) {
      const cfg = (body.config && typeof body.config === "object" ? body.config : body) as Record<string, unknown>;
      body = { ...cfg };
      const durable = subject.includes("DURABLE");
      const streamName = durable ? parts[5]! : parts[4]!;
      const consumerName = durable ? parts[6]! : String(body.name ?? `eph-${Date.now()}`);
      const key = `${streamName}/${consumerName}`;
      // durable 幂等：已存在则报错且保留其 ack 状态（真实语义：consumer name already in use）
      if (durable && this.consumers.has(key)) {
        reply({ error: { code: 400, description: "consumer name already in use" } });
        return;
      }
      const c: FakeConsumer = {
        stream: streamName,
        name: consumerName,
        durable,
        deliverSubject: String(body.deliver_subject ?? ""),
        ackWaitMs: Number(body.ack_wait ?? 30e9) / 1e6,
        maxAckPending: Number(body.max_ack_pending ?? 1000),
        ackNone: body.ack_policy === "none",
        pending: new Map(),
        nextDeliver: 1,
      };
      this.consumers.set(key, c);
      // 全量补投（deliver_policy=all）
      const stream = this.streams.get(streamName);
      if (stream) for (const m of stream.messages) this.deliverToConsumer(c, m.seq);
      reply({ stream_name: streamName, name: consumerName });
      return;
    }
    if (subject.startsWith("$JS.API.CONSUMER.DELETE.")) {
      this.consumers.delete(`${parts[5]}/${parts[6]}`);
      reply({ success: true });
      return;
    }
    reply({ error: { code: 501, description: `fake: 未实现的 API ${subject}` } });
  }
}
