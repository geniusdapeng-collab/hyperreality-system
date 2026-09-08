/**
 * adapters/redis · Redis Streams 持久化适配器（生产备选，证明接口可替换）
 *
 * 真实 Redis 命令流（无私有扩展）：
 *  - 发布：INCR wl:seq:{stream}（服务器位点）+ XADD {stream} *（字段含 msgId/ts/deliverAt/subject/payload）；
 *  - 重放：XRANGE {stream} - +（全量升序）；
 *  - 消费组：XGROUP CREATE（MKSTREAM，BUSYGROUP 幂等）；后台泵 XREADGROUP（把新消息送入 PEL）；
 *    未 ack 清单 = XPENDING 展开 + XRANGE 逐条恢复 msgId 映射（崩溃重启后同样成立）；
 *  - ack：XACK（PEL 移除即服务器位点确认）；
 *  - deliver-at：ZADD wl:delayed {due} + liftDue = ZRANGEBYSCORE(-inf, now) + ZREM 原子化
 *    （对焦稿 §4.2「延迟 sorted-set + lift」）。
 *
 * 连接抽象 RedisConnection：生产 = TcpRedisConnection（RESP2 编解码，node:net）；
 * 测试 = 进程内 FakeRedisServer（testing/fake-redis.ts，真实 TCP 起服务，全链路走真 RESP）。
 */
import type { BusBackend, OutboxMsg, PersistedMsg, StreamSpec } from "../mirrored.js";

/* ================= 连接抽象 ================= */

export type RespValue = string | number | null | RespValue[] | Error;

export interface RedisConnection {
  call(...args: string[]): Promise<RespValue>;
  close(): Promise<void>;
}

const DELAY_KEY = "wl:delayed";
const seqKey = (stream: string) => `wl:seq:${stream}`;

interface StreamEntry { id: string; fields: Record<string, string> }

export class RedisBackend implements BusBackend {
  /** msgId → entryId（本进程缓存；崩溃重启后经 groupUnacked 的 XPENDING+XRANGE 恢复） */
  private entryByMsgId = new Map<string, string>();
  constructor(private conn: RedisConnection) {}

  async ensureStreams(specs: StreamSpec[]): Promise<void> {
    // Redis Stream 随首条 XADD 自动创建；消费组在 ensureGroup 建立。此处仅记录拓扑（空操作保语义）。
    void specs;
  }

  async publishUp(msg: OutboxMsg): Promise<number> {
    const seq = Number(await this.conn.call("INCR", seqKey(msg.stream)));
    const entryId = await this.conn.call(
      "XADD", msg.stream, "*",
      "msg_id", msg.msgId,
      "subject", msg.subject,
      "seq", String(seq),
      "ts", String(msg.ts),
      "deliver_at", String(msg.deliverAt),
      "payload", JSON.stringify(msg.payload),
    );
    this.entryByMsgId.set(msg.msgId, String(entryId));
    return seq;
  }

  async fetchLog(stream: string): Promise<PersistedMsg[]> {
    const rows = (await this.conn.call("XRANGE", stream, "-", "+")) as Array<[string, string[]]> | null;
    const out: PersistedMsg[] = [];
    for (const [id, kv] of rows ?? []) {
      const f = kvToFields(kv);
      out.push({
        msgId: f.msg_id ?? id,
        stream,
        subject: f.subject ?? "",
        payload: parseJson(f.payload),
        ts: Number(f.ts ?? 0),
        deliverAt: Number(f.deliver_at ?? 0),
        serverSeq: Number(f.seq ?? 0),
      });
    }
    return out.sort((a, b) => a.serverSeq - b.serverSeq);
  }

  async ensureGroup(stream: string, group: string, opts: { maxAckPending: number; ackWaitMs: number }): Promise<void> {
    void opts;
    await this.conn.call("XGROUP", "CREATE", stream, group, "0", "MKSTREAM").catch((e) => {
      if (!String(e).includes("BUSYGROUP")) throw e;
    });
    // 把新消息送入 PEL（消费组的「已投递」集合——崩溃恢复的事实源）
    await this.pullIntoPel(stream, group);
  }

  /** XREADGROUP → PEL + msgId 映射刷新 */
  private async pullIntoPel(stream: string, group: string): Promise<void> {
    const resp = (await this.conn.call(
      "XREADGROUP", "GROUP", group, "wl", "COUNT", "500", "STREAMS", stream, ">",
    )) as Array<[string, Array<[string, string[]]>]> | null;
    for (const [, entries] of resp ?? []) {
      for (const [id, kv] of entries) {
        const f = kvToFields(kv);
        if (f.msg_id) this.entryByMsgId.set(f.msg_id, id);
      }
    }
  }

  async ackUp(stream: string, group: string, msgId: string): Promise<void> {
    const entryId = this.entryByMsgId.get(msgId) ?? (await this.findEntryByMsgId(stream, group, msgId));
    if (entryId) await this.conn.call("XACK", stream, group, entryId);
  }

  private async findEntryByMsgId(stream: string, group: string, msgId: string): Promise<string | null> {
    const pendings = (await this.conn.call("XPENDING", stream, group, "-", "+", "1000")) as Array<[string, string, number, number]> | null;
    for (const [entryId] of pendings ?? []) {
      const rows = (await this.conn.call("XRANGE", stream, entryId, entryId)) as Array<[string, string[]]> | null;
      const f = rows?.[0] ? kvToFields(rows[0][1]) : {};
      if (f.msg_id) this.entryByMsgId.set(f.msg_id, entryId);
      if (f.msg_id === msgId) return entryId;
    }
    return null;
  }

  async groupUnacked(stream: string, group: string): Promise<string[]> {
    const pendings = (await this.conn.call("XPENDING", stream, group, "-", "+", "1000")) as Array<[string, string, number, number]> | null;
    const out: string[] = [];
    for (const [entryId] of pendings ?? []) {
      const rows = (await this.conn.call("XRANGE", stream, entryId, entryId)) as Array<[string, string[]]> | null;
      const f = rows?.[0] ? kvToFields(rows[0][1]) : {};
      const msgId = f.msg_id;
      if (msgId) {
        this.entryByMsgId.set(msgId, entryId);
        out.push(msgId);
      }
    }
    return out;
  }

  async delayUp(msg: OutboxMsg): Promise<void> {
    await this.conn.call("ZADD", DELAY_KEY, String(msg.deliverAt), JSON.stringify({
      msgId: msg.msgId, stream: msg.stream, subject: msg.subject,
      payload: msg.payload, ts: msg.ts, deliverAt: msg.deliverAt,
    }));
  }

  async liftDue(now: number, limit: number): Promise<OutboxMsg[]> {
    const rows = (await this.conn.call("ZRANGEBYSCORE", DELAY_KEY, "-inf", String(now), "LIMIT", "0", String(limit))) as string[] | null;
    const out: OutboxMsg[] = [];
    for (const raw of rows ?? []) {
      const removed = Number(await this.conn.call("ZREM", DELAY_KEY, raw));
      if (removed !== 1) continue; // 并发下已被其他实例取走
      const p = JSON.parse(raw) as OutboxMsg;
      out.push(p);
    }
    return out;
  }

  async close(): Promise<void> { await this.conn.close(); }
}

function kvToFields(kv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < kv.length; i += 2) out[kv[i]!] = kv[i + 1]!;
  return out;
}
function parseJson(s: string | undefined): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

/* ================= TCP 客户端（RESP2 子集） ================= */

export class TcpRedisConnection implements RedisConnection {
  private socket!: import("node:net").Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private queue: Array<{ resolve: (v: RespValue) => void; reject: (e: Error) => void }> = [];
  private ready: Promise<void>;

  constructor(private url: string) {
    this.ready = this.connect();
  }

  private async connect(): Promise<void> {
    const { default: net } = await import("node:net");
    const u = new URL(this.url);
    this.socket = net.createConnection({ host: u.hostname, port: Number(u.port || 6379) });
    this.socket.setNoDelay(true);
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.socket.on("error", (err) => {
      for (const q of this.queue.splice(0)) q.reject(err);
    });
    await new Promise<void>((resolve, reject) => {
      this.socket.once("connect", () => resolve());
      this.socket.once("error", reject);
    });
    if (u.password) await this.call("AUTH", u.username && u.username !== "default" ? `${u.username} ${u.password}` : u.password);
  }

  call(...args: string[]): Promise<RespValue> {
    return new Promise((resolve, reject) => {
      const encoded = encodeCommand(args);
      this.ready.then(() => {
        this.queue.push({ resolve, reject });
        this.socket.write(encoded);
      }).catch(reject);
    });
  }

  private onData(chunk: Buffer): void {
    // 字节级组帧：RESP 批量字符串的长度是字节数——中文负载下字符串长度会失真（与 NATS 同修）
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = parseResp(this.buffer);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.consumed);
      const q = this.queue.shift();
      if (q) {
        if (parsed.value instanceof Error) q.reject(parsed.value);
        else q.resolve(parsed.value);
      }
    }
  }

  async close(): Promise<void> {
    await this.ready.catch(() => undefined);
    if (!this.socket) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1500);
      this.socket.once("close", () => { clearTimeout(t); resolve(); });
      this.socket.end();
    });
    this.socket.destroy();
  }
}

function encodeCommand(args: string[]): string {
  let out = `*${args.length}\r\n`;
  for (const a of args) out += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
  return out;
}

/** RESP2 增量解析（字节级；返回 null 表示数据不足） */
export function parseResp(buf: Buffer): { value: RespValue; consumed: number } | null {
  if (buf.length === 0) return null;
  const type = String.fromCharCode(buf[0]!);
  if (type === "+" || type === "-" || type === ":") {
    const end = buf.indexOf("\r\n");
    if (end < 0) return null;
    const body = buf.subarray(1, end).toString("utf-8");
    if (type === "+") return { value: body, consumed: end + 2 };
    if (type === "-") return { value: new Error(body), consumed: end + 2 };
    return { value: Number(body), consumed: end + 2 };
  }
  if (type === "$") {
    const end = buf.indexOf("\r\n");
    if (end < 0) return null;
    const len = Number(buf.subarray(1, end).toString("utf-8"));
    if (len === -1) return { value: null, consumed: end + 2 };
    if (buf.length < end + 2 + len + 2) return null;
    return { value: buf.subarray(end + 2, end + 2 + len).toString("utf-8"), consumed: end + 2 + len + 2 };
  }
  if (type === "*") {
    const end = buf.indexOf("\r\n");
    if (end < 0) return null;
    const count = Number(buf.subarray(1, end).toString("utf-8"));
    if (count === -1) return { value: null, consumed: end + 2 };
    const items: RespValue[] = [];
    let off = end + 2;
    for (let i = 0; i < count; i++) {
      const sub = parseResp(buf.subarray(off));
      if (!sub) return null;
      items.push(sub.value);
      off += sub.consumed;
    }
    return { value: items, consumed: off };
  }
  return null;
}
