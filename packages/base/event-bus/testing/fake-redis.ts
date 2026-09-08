/**
 * testing/fake-redis · 进程内 Redis 仿真服务器（真实 TCP + 真 RESP 协议）
 *
 * 用途：无外部依赖地全链路验证 RedisBackend + TcpRedisConnection。
 * 实现命令子集（按适配器实际使用）：PING / INCR /
 * XADD / XRANGE / XGROUP CREATE / XREADGROUP / XACK / XPENDING（区间展开）/
 * ZADD / ZRANGEBYSCORE（LIMIT）/ ZREM。
 * 状态保存在服务器实例内：客户端断线重连（模拟进程崩溃重启）后仍在——持久化语义可测。
 */
import { createServer, type Server, type Socket } from "node:net";

interface StreamEntry { id: string; fields: Record<string, string> }
interface StreamState {
  entries: StreamEntry[];
  lastMs: number;
  lastSeq: number;
  groups: Map<string, { pel: Map<string, number>; cursor: string }>; // group → {PEL: entryId→deliveries, cursor}
}

export class FakeRedisServer {
  private server: Server;
  private streams = new Map<string, StreamState>();
  private counters = new Map<string, number>();
  private zsets = new Map<string, Map<string, number>>(); // key → member → score
  private conns = new Set<Socket>();
  port = 0;

  /** 测试只读：流内全量消息（payload 已解析） */
  streamMessages(stream: string): { id: string; payload: unknown }[] {
    return (this.streams.get(stream)?.entries ?? []).map((e) => ({
      id: e.id, payload: JSON.parse(e.fields.payload ?? "{}") as unknown,
    }));
  }

  constructor() {
    this.server = createServer((socket) => this.onConn(socket));
  }

  async start(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  url(): string { return `redis://127.0.0.1:${this.port}`; }

  /* ---------- 协议 ---------- */
  private onConn(socket: Socket): void {
    this.conns.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      // 字节级组帧：RESP 长度字段是字节数，中文负载下字符串长度会失真（与客户端同修）
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = this.parseArray(buffer);
        if (!parsed) return;
        buffer = buffer.subarray(parsed.consumed);
        const reply = this.execute(parsed.args);
        socket.write(reply);
      }
    });
    socket.on("close", () => this.conns.delete(socket));
    socket.on("error", () => this.conns.delete(socket));
  }

  /** RESP 数组解析（字节级；仅客户端发来的 bulk-string 数组形态） */
  private parseArray(buf: Buffer): { args: string[]; consumed: number } | null {
    if (buf.length === 0 || buf[0] !== 0x2a) return null; // '*'
    const end = buf.indexOf("\r\n");
    if (end < 0) return null;
    const count = Number(buf.subarray(1, end).toString("utf-8"));
    const args: string[] = [];
    let off = end + 2;
    for (let i = 0; i < count; i++) {
      if (buf[off] !== 0x24) return null; // '$'
      const he = buf.indexOf("\r\n", off);
      if (he < 0) return null;
      const len = Number(buf.subarray(off + 1, he).toString("utf-8"));
      if (buf.length < he + 2 + len + 2) return null;
      args.push(buf.subarray(he + 2, he + 2 + len).toString("utf-8"));
      off = he + 2 + len + 2;
    }
    return { args, consumed: off };
  }

  /* ---------- 编码 ---------- */
  private static simple(s: string): string { return `+${s}\r\n`; }
  private static err(s: string): string { return `-${s}\r\n`; }
  private static int(n: number): string { return `:${n}\r\n`; }
  private static bulk(s: string | null): string {
    return s === null ? "$-1\r\n" : `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  private static arr(items: string[]): string { return `*${items.length}\r\n${items.join("")}`; }

  /* ---------- 命令执行 ---------- */
  private execute(args: string[]): string {
    const cmd = (args[0] ?? "").toUpperCase();
    const S = FakeRedisServer;
    try {
      if (cmd === "PING") return S.simple("PONG");
      if (cmd === "AUTH") return S.simple("OK");
      if (cmd === "INCR") {
        const key = args[1]!;
        const v = (this.counters.get(key) ?? 0) + 1;
        this.counters.set(key, v);
        return S.int(v);
      }
      if (cmd === "XADD") return this.xadd(args);
      if (cmd === "XRANGE") return this.xrange(args);
      if (cmd === "XGROUP") return this.xgroup(args);
      if (cmd === "XREADGROUP") return this.xreadgroup(args);
      if (cmd === "XACK") return this.xack(args);
      if (cmd === "XPENDING") return this.xpending(args);
      if (cmd === "ZADD") {
        const z = this.zset(args[1]!);
        z.set(args[3]!, Number(args[2]));
        return S.int(1);
      }
      if (cmd === "ZRANGEBYSCORE") {
        const z = this.zset(args[1]!);
        const max = args[3] === "+inf" ? Infinity : Number(args[3]);
        const limitIdx = args.findIndex((a) => a.toUpperCase() === "LIMIT");
        const limit = limitIdx >= 0 ? Number(args[limitIdx + 2]) : Infinity;
        const items = [...z.entries()].filter(([, score]) => score <= max)
          .sort((a, b) => a[1] - b[1]).slice(0, limit)
          .map(([member]) => S.bulk(member));
        return S.arr(items);
      }
      if (cmd === "ZREM") {
        const z = this.zset(args[1]!);
        return S.int(z.delete(args[2]!) ? 1 : 0);
      }
      return S.err(`ERR unknown command '${cmd}'`);
    } catch (e) {
      return S.err(`ERR ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private zset(key: string): Map<string, number> {
    if (!this.zsets.has(key)) this.zsets.set(key, new Map());
    return this.zsets.get(key)!;
  }

  private stream(key: string, create = false): StreamState {
    if (!this.streams.has(key)) {
      if (!create) throw new Error("no such key");
      this.streams.set(key, { entries: [], lastMs: 0, lastSeq: 0, groups: new Map() });
    }
    return this.streams.get(key)!;
  }

  private xadd(args: string[]): string {
    const S = FakeRedisServer;
    const st = this.stream(args[1]!, true);
    let id = args[2]!;
    if (id === "*") {
      const ms = Date.now();
      st.lastSeq = st.lastMs === ms ? st.lastSeq + 1 : 0;
      st.lastMs = ms;
      id = `${ms}-${st.lastSeq}`;
    }
    const fields: Record<string, string> = {};
    for (let i = 3; i + 1 < args.length; i += 2) fields[args[i]!] = args[i + 1]!;
    st.entries.push({ id, fields });
    return S.bulk(id);
  }

  private xrange(args: string[]): string {
    const S = FakeRedisServer;
    if (!this.streams.has(args[1]!)) return S.arr([]); // 真实 Redis：不存在的 key 返回空数组
    const st = this.stream(args[1]!);
    const [start, end] = [args[2]!, args[3]!];
    const out = st.entries
      .filter((e) => (start === "-" || e.id >= start) && (end === "+" || e.id <= end))
      .map((e) => S.arr([S.bulk(e.id), S.arr(Object.entries(e.fields).flat().map((v) => S.bulk(v)))]));
    return S.arr(out);
  }

  private xgroup(args: string[]): string {
    const S = FakeRedisServer;
    if ((args[1] ?? "").toUpperCase() !== "CREATE") return S.err("ERR unsupported XGROUP");
    const st = this.stream(args[2]!, true);
    const group = args[3]!;
    if (st.groups.has(group)) return S.err("BUSYGROUP Consumer Group name already exists");
    st.groups.set(group, { pel: new Map(), cursor: "0-0" });
    return S.simple("OK");
  }

  private xreadgroup(args: string[]): string {
    const S = FakeRedisServer;
    const group = args[2]!;
    const countIdx = args.findIndex((a) => a.toUpperCase() === "COUNT");
    const count = countIdx >= 0 ? Number(args[countIdx + 1]) : Infinity;
    const streamKey = args[args.length - 2]!;
    const st = this.stream(streamKey, true);
    const g = st.groups.get(group);
    if (!g) return S.err(`NOGROUP No such consumer group '${group}'`);
    const fresh = st.entries.filter((e) => e.id > g.cursor).slice(0, count);
    for (const e of fresh) {
      g.pel.set(e.id, 1);
      g.cursor = e.id;
    }
    if (fresh.length === 0) return S.arr([S.arr([S.bulk(streamKey), S.arr([])])]);
    return S.arr([S.arr([S.bulk(streamKey), S.arr(fresh.map((e) => S.arr([S.bulk(e.id), S.arr(Object.entries(e.fields).flat().map((v) => S.bulk(v)))])))])]);
  }

  private xack(args: string[]): string {
    const S = FakeRedisServer;
    const st = this.stream(args[1]!);
    const g = st.groups.get(args[2]!);
    if (!g) return S.int(0);
    let n = 0;
    for (const id of args.slice(3)) if (g.pel.delete(id)) n++;
    return S.int(n);
  }

  private xpending(args: string[]): string {
    const S = FakeRedisServer;
    const st = this.stream(args[1]!);
    const g = st.groups.get(args[2]!);
    if (!g) return S.err(`NOGROUP No such consumer group '${args[2]}'`);
    // 展开形态：XPENDING stream group - + count → [ [id, consumer, idleMs, deliveries], ... ]
    const count = Number(args[5] ?? 1000);
    const rows = [...g.pel.entries()].slice(0, count)
      .map(([id, deliveries]) => S.arr([S.bulk(id), S.bulk("wl"), S.int(0), S.int(deliveries)]));
    return S.arr(rows);
  }
}
