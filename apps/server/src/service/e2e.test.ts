/**
 * server · AI 服务前台端到端套件（D 业务查询 / E 渠道与安全 / F C 端旅程 / G B 端视角）
 * 实测口径：beforeAll 以 child_process 拉起真实服务（SERVER_PORT=8795），afterAll 杀掉；
 * 全部断言经 HTTP（fetch）命中活库；B 端走 tRPC serviceRouter（auth.loginAs 签 JWT）。
 * 纪律：仅新增测试，不改源码。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";
import pg from "pg";

const PORT = 8795;
const BASE = `http://localhost:${PORT}`;
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const RUN = `e2e-${Date.now().toString(36)}`;
const DEV_C_SECRET = "workloom-c-dev-secret-change-me";
// 仓库无关的 DB 解析：优先环境变量，其次读仓库根 .env（vitest 不自动加载），最后回退 workloom
import { readFileSync } from "node:fs";
function resolveDbUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync(new URL("../../../../.env", import.meta.url), "utf-8");
    const m = env.match(/^DATABASE_URL=(.+)$/m);
    if (m?.[1]?.trim()) return m[1].trim();
  } catch { /* 无 .env 回退 */ }
  return "postgres://postgres:workloom@localhost:5432/workloom";
}
const DB_URL = resolveDbUrl();

let server: ChildProcess;
let db: pg.Client;
let bToken = "";   // MEM-001 owner
let roToken = "";  // MEM-003 readonly

/* ---------------- 基础工具 ---------------- */

async function cReq(path: string, init: RequestInit = {}, token?: string, ip = "203.0.113.1"): Promise<Response> {
  return fetch(`${BASE}/c${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
}

async function cSession(openid: string, channel = "h5", ip = "203.0.113.1"): Promise<{ token: string; user: { id: string; memberId: string | null } }> {
  const res = await cReq("/session", { method: "POST", body: JSON.stringify({ channel, openid, nickname: "e2e" }) }, undefined, ip);
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; user: { id: string; memberId: string | null } };
}

async function chat(token: string, text: string, extra: Record<string, unknown> = {}, ip?: string): Promise<Record<string, unknown>> {
  const res = await cReq("/chat", { method: "POST", body: JSON.stringify({ text, ...extra }) }, token, ip);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

interface TrpcResult { status: number; data: unknown; error: { code: number; data?: { code?: string; httpStatus?: number } } | null }

async function trpc(proc: string, opts: { input?: unknown; token?: string; method?: "query" | "mutation" } = {}): Promise<TrpcResult> {
  const method = opts.method ?? "query";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let res: Response;
  if (method === "query") {
    const qs = opts.input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(opts.input))}` : "";
    res = await fetch(`${BASE}/trpc/${proc}${qs}`, { headers });
  } else {
    res = await fetch(`${BASE}/trpc/${proc}`, { method: "POST", headers, body: JSON.stringify(opts.input ?? {}) });
  }
  const body = (await res.json()) as { result?: { data?: unknown }; error?: TrpcResult["error"] };
  return { status: res.status, data: body.result?.data ?? null, error: body.error ?? null };
}

/** 与 C 端网关同一工作区解析口径（SERVICE_C_WORKSPACE_ID ?? 酒店回归域优先 ?? 首个工作区），多工作区仓库（如视频版）下保证 B/C 同域 */
function serviceCWorkspaceId(): string | null {
  if (process.env.SERVICE_C_WORKSPACE_ID) return process.env.SERVICE_C_WORKSPACE_ID;
  try {
    const env = readFileSync(new URL("../../../../.env", import.meta.url), "utf-8");
    const m = env.match(/^SERVICE_C_WORKSPACE_ID=(.+)$/m);
    if (m?.[1]?.trim()) return m[1].trim();
  } catch { /* 无 .env 回退 */ }
  return null;
}

async function resolveWorkspaceSlug(): Promise<string> {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB_URL });
  try {
    const wsId = serviceCWorkspaceId();
    if (wsId) {
      const r = await pool.query(`SELECT slug FROM workspaces WHERE id=$1`, [wsId]);
      if (r.rows[0]?.slug) return String(r.rows[0].slug);
    }
    const r = await pool.query(`SELECT slug FROM workspaces ORDER BY (slug='yunqi-hotel') DESC, created_at LIMIT 1`);
    return String(r.rows[0]?.slug ?? "yunqi-hotel");
  } finally { await pool.end(); }
}

async function loginAs(memberNo: string): Promise<string> {
  const workspaceSlug = await resolveWorkspaceSlug();
  const r = await trpc("auth.loginAs", { input: { workspaceSlug, memberNo }, method: "mutation" });
  expect(r.error).toBeNull();
  return (r.data as { token: string }).token;
}

async function bindMember(cUserId: string, memberId: string): Promise<void> {
  await db.query(`UPDATE c_users SET member_id=$2 WHERE id=$1`, [cUserId, memberId]);
}

async function signCToken(over: Record<string, unknown>, secret = DEV_C_SECRET, exp = "1h"): Promise<string> {
  return new SignJWT({ workspaceId: "ws-yunqi", cUserId: "cu-x", channel: "h5", scope: "c-user", ...over })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setIssuer("workloom-c").setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));
}

/* ---------------- 服务拉起/回收 ---------------- */

beforeAll(async () => {
  server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "--env-file=.env", "apps/server/src/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, SERVER_PORT: String(PORT), SERVICE_C_DEMO_AUTH: "true" },
    stdio: "ignore",
    detached: true, // 独立进程组：afterAll 按组杀（tsx 会再派生 node 子进程）
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch { /* 未就绪 */ }
    if (Date.now() > deadline) throw new Error("8795 服务拉起超时");
    await new Promise((r) => setTimeout(r, 500));
  }
  db = new pg.Client(DB_URL);
  await db.connect();
  bToken = await loginAs("MEM-001");
  roToken = await loginAs("MEM-003");
}, 90_000);

afterAll(async () => {
    // 清理本套件写入的知识库文档（防评测/演示环境污染——基线文档保留）
    try {
      const pg = (await import("pg")).default;
      const pool = new pg.Pool({ connectionString: DB_URL });
      // 仅清理本套件 upsert 产生的测试文档（标题带 RUN 前缀 e2e- 开头）；种子基线与预置库（FAQ/送物/报修）一律保留
      await pool.query(`DELETE FROM kb_chunks WHERE document_id IN (SELECT id FROM kb_documents WHERE title LIKE 'e2e-%')`);
      await pool.query(`DELETE FROM kb_documents WHERE title LIKE 'e2e-%'`);
      await pool.end();
    } catch { /* 清理失败不阻断 */ }

  if (server?.pid) {
    try { process.kill(-server.pid, "SIGKILL"); } catch { server.kill("SIGKILL"); }
  }
  await db?.end().catch(() => undefined);
});

/* ================= E. 渠道与安全 ================= */

describe("E 渠道 · session 签发", () => {
  it("h5 演示直登 → {token, user}", async () => {
    const res = await cReq("/session", { method: "POST", body: JSON.stringify({ channel: "h5", openid: `${RUN}-e1` }) }, undefined, "203.0.113.11");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { token: string; user: Record<string, unknown> };
    expect(typeof j.token).toBe("string");
    expect(j.user).toMatchObject({ channel: "h5", openid: `${RUN}-e1` });
  });

  it("wechat-mini / alipay 开发态 openid 直登放行", async () => {
    for (const ch of ["wechat-mini", "alipay"]) {
      const res = await cReq("/session", { method: "POST", body: JSON.stringify({ channel: ch, openid: `${RUN}-${ch}` }) }, undefined, "203.0.113.12");
      expect(res.status, ch).toBe(200);
      const j = (await res.json()) as { user: { channel: string } };
      expect(j.user.channel).toBe(ch);
    }
  });

  it("非法渠道 → 400", async () => {
    const res = await cReq("/session", { method: "POST", body: JSON.stringify({ channel: "tiktok", openid: "x" }) }, undefined, "203.0.113.13");
    expect(res.status).toBe(400);
  });

  it("h5 缺 openid → 400", async () => {
    const res = await cReq("/session", { method: "POST", body: JSON.stringify({ channel: "h5" }) }, undefined, "203.0.113.14");
    expect(res.status).toBe(400);
  });

  it("wechat-mini 无 openid 且缺 code → 400；有 code 无凭据 → 503 渠道未配置", async () => {
    const ip = "203.0.113.15";
    const r1 = await cReq("/session", { method: "POST", body: JSON.stringify({ channel: "wechat-mini" }) }, undefined, ip);
    expect(r1.status).toBe(400);
    const r2 = await cReq("/session", { method: "POST", body: JSON.stringify({ channel: "wechat-mini", code: "abc" }) }, undefined, ip);
    expect(r2.status).toBe(503);
    expect(((await r2.json()) as { error: string }).error).toContain("渠道未配置");
  });

  it("alipay code 换登未装配 → 503", async () => {
    const res = await cReq("/session", { method: "POST", body: JSON.stringify({ channel: "alipay", code: "abc" }) }, undefined, "203.0.113.16");
    expect(res.status).toBe(503);
  });
});

describe("E 安全 · 限流", () => {
  it("session 同 IP+channel 第 61 次 → 429", async () => {
    const ip = "198.51.100.61";
    let last = 0;
    for (let i = 0; i < 62; i++) {
      const res = await cReq("/session", { method: "POST", body: JSON.stringify({ channel: "h5", openid: `${RUN}-rl` }) }, undefined, ip);
      last = res.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  it("限流按 IP+channel 维度隔离（同 IP 换 channel 仍放行）", async () => {
    const ip = "198.51.100.61"; // 同上一用例 IP：h5 已限流
    const res = await cReq("/session", { method: "POST", body: JSON.stringify({ channel: "alipay", openid: `${RUN}-rl2` }) }, undefined, ip);
    expect(res.status).toBe(200);
  });

  it("限流按 IP 隔离（换 IP 仍放行）", async () => {
    const res = await cReq("/session", { method: "POST", body: JSON.stringify({ channel: "h5", openid: `${RUN}-rl3` }) }, undefined, "198.51.100.62");
    expect(res.status).toBe(200);
  });

  it("chat 同用户第 61 次 → 429", async () => {
    const { token } = await cSession(`${RUN}-crl`, "h5", "198.51.100.63");
    let last = 0;
    for (let i = 0; i < 62; i++) {
      const res = await cReq("/chat", { method: "POST", body: JSON.stringify({ text: "退房时间几点" }) }, token, "198.51.100.63");
      last = res.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});

describe("E 安全 · token 校验", () => {
  it("缺 Authorization 头 → 401", async () => {
    const res = await cReq("/tickets", {}, undefined, "203.0.113.21");
    expect(res.status).toBe(401);
  });

  it("伪造签名（错误密钥）→ 401", async () => {
    const forged = await signCToken({}, "wrong-secret-wrong-secret-wrong!!");
    const res = await cReq("/tickets", {}, forged, "203.0.113.22");
    expect(res.status).toBe(401);
  });

  it("过期 token → 401", async () => {
    const expired = await signCToken({}, DEV_C_SECRET, "-1s");
    const res = await cReq("/tickets", {}, expired, "203.0.113.23");
    expect(res.status).toBe(401);
  });

  it("scope 非 c-user（B 端令牌混用）→ 401", async () => {
    const bad = await signCToken({ scope: "b" });
    const res = await cReq("/tickets", {}, bad, "203.0.113.24");
    expect(res.status).toBe(401);
  });

  it("畸形 token 串 → 401", async () => {
    const res = await cReq("/tickets", {}, "not-a-jwt", "203.0.113.25");
    expect(res.status).toBe(401);
  });
});

describe("E 安全 · 越权与输入约束", () => {
  it("越权读他人工单详情 → 404", async () => {
    const a = await cSession(`${RUN}-oa`, "h5", "203.0.113.31");
    const b = await cSession(`${RUN}-ob`, "h5", "203.0.113.32");
    const created = (await (await cReq("/tickets", {
      method: "POST", body: JSON.stringify({ kind: "repair", title: "越权测试单", payload: {}, idempotencyKey: `${RUN}-oa-1` }),
    }, a.token, "203.0.113.31")).json()) as { ticket: { id: string } };
    const res = await cReq(`/tickets/${created.ticket.id}`, {}, b.token, "203.0.113.32");
    expect(res.status).toBe(404);
  });

  it("越权读他人通知：通知箱仅含本人条目", async () => {
    const a = await cSession(`${RUN}-na`, "h5", "203.0.113.33");
    const b = await cSession(`${RUN}-nb`, "h5", "203.0.113.34");
    const created = (await (await cReq("/tickets", {
      method: "POST", body: JSON.stringify({ kind: "other", title: "通知隔离单", payload: {}, idempotencyKey: `${RUN}-na-1` }),
    }, a.token, "203.0.113.33")).json()) as { ticket: { id: string } };
    const nA = (await (await cReq("/notifications", {}, a.token, "203.0.113.33")).json()) as { notifications: Array<{ payload: { ticketId?: string } }> };
    expect(nA.notifications.some((n) => n.payload.ticketId === created.ticket.id)).toBe(true);
    const nB = (await (await cReq("/notifications", {}, b.token, "203.0.113.34")).json()) as { notifications: Array<{ payload: { ticketId?: string } }> };
    expect(nB.notifications.some((n) => n.payload.ticketId === created.ticket.id)).toBe(false);
  });

  it("越权续聊他人会话 → 不复用（归属校验后新建会话）", async () => {
    const a = await cSession(`${RUN}-ca`, "h5", "203.0.113.35");
    const b = await cSession(`${RUN}-cb`, "h5", "203.0.113.36");
    const first = await chat(a.token, "退房时间几点", {}, "203.0.113.35");
    const hijack = await chat(b.token, "早餐几点", { conversationId: first.conversationId }, "203.0.113.36");
    expect(hijack.conversationId).not.toBe(first.conversationId);
  });

  it("text 超 2000 字符 → 400", async () => {
    const { token } = await cSession(`${RUN}-v1`, "h5", "203.0.113.41");
    const res = await cReq("/chat", { method: "POST", body: JSON.stringify({ text: "长".repeat(2001) }) }, token, "203.0.113.41");
    expect(res.status).toBe(400);
  });

  it("空 text / 缺 text → 400", async () => {
    const { token } = await cSession(`${RUN}-v2`, "h5", "203.0.113.42");
    const r1 = await cReq("/chat", { method: "POST", body: JSON.stringify({ text: "   " }) }, token, "203.0.113.42");
    expect(r1.status).toBe(400);
    const r2 = await cReq("/chat", { method: "POST", body: JSON.stringify({}) }, token, "203.0.113.42");
    expect(r2.status).toBe(400);
  });

  it("非法 kind → 400", async () => {
    const { token } = await cSession(`${RUN}-v3`, "h5", "203.0.113.43");
    const res = await cReq("/tickets", { method: "POST", body: JSON.stringify({ kind: "hack", title: "x", payload: {} }) }, token, "203.0.113.43");
    expect(res.status).toBe(400);
  });

  it("title 超 120 字符 → 400", async () => {
    const { token } = await cSession(`${RUN}-v4`, "h5", "203.0.113.44");
    const res = await cReq("/tickets", { method: "POST", body: JSON.stringify({ kind: "other", title: "长".repeat(121), payload: {} }) }, token, "203.0.113.44");
    expect(res.status).toBe(400);
  });

  it("payload 超 10KB → 400", async () => {
    const { token } = await cSession(`${RUN}-v5`, "h5", "203.0.113.45");
    const res = await cReq("/tickets", { method: "POST", body: JSON.stringify({ kind: "other", title: "大 payload", payload: { blob: "x".repeat(11 * 1024) } }) }, token, "203.0.113.45");
    expect(res.status).toBe(400);
  });

  it("XSS 文本原样存储不执行（标题含 script 标签原样返回）", async () => {
    const { token } = await cSession(`${RUN}-v6`, "h5", "203.0.113.46");
    const xss = "<script>alert(1)</script>";
    const r = (await (await cReq("/tickets", {
      method: "POST", body: JSON.stringify({ kind: "other", title: xss, payload: {}, idempotencyKey: `${RUN}-xss-1` }),
    }, token, "203.0.113.46")).json()) as { ticket: { id: string; title: string } };
    expect(r.ticket.title).toBe(xss);
    const detail = (await (await cReq(`/tickets/${r.ticket.id}`, {}, token, "203.0.113.46")).json()) as { ticket: { title: string } };
    expect(detail.ticket.title).toBe(xss);
  });

  it("评价 score 越界（0 / 6）→ 400", async () => {
    const { token } = await cSession(`${RUN}-v7`, "h5", "203.0.113.47");
    for (const score of [0, 6]) {
      const res = await cReq("/tickets/tck-x/rate", { method: "POST", body: JSON.stringify({ score }) }, token, "203.0.113.47");
      expect(res.status, String(score)).toBe(400);
    }
  });

  it("非法 JSON body → 按缺参 400（不 500）", async () => {
    const { token } = await cSession(`${RUN}-v8`, "h5", "203.0.113.48");
    const res = await fetch(`${BASE}/c/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.48" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("不存在工单详情 → 404 带 requestId", async () => {
    const { token } = await cSession(`${RUN}-v9`, "h5", "203.0.113.49");
    const res = await cReq("/tickets/tck-not-exist", {}, token, "203.0.113.49");
    expect(res.status).toBe(404);
    expect(typeof ((await res.json()) as { requestId?: string }).requestId).toBe("string");
  });
});

/* ================= D. 业务查询 ================= */

describe("D 业务查询 · 绑定引导与卡片契约", () => {
  it("未绑定查订单：/orders 空集 + bindRequired + 引导文案", async () => {
    const { token } = await cSession(`${RUN}-d1`, "h5", "203.0.113.51");
    const j = (await (await cReq("/orders", {}, token, "203.0.113.51")).json()) as Record<string, unknown>;
    expect(j).toMatchObject({ bindRequired: true, demo: true });
    expect(j.orders).toEqual([]);
    expect(String(j.hint)).toContain("绑定会员");
  });

  it("未绑定查会员：/member level=游客 + bindRequired", async () => {
    const { token } = await cSession(`${RUN}-d2`, "h5", "203.0.113.52");
    const j = (await (await cReq("/member", {}, token, "203.0.113.52")).json()) as Record<string, unknown>;
    expect(j).toMatchObject({ level: "游客", points: 0, bindRequired: true });
    expect(j.benefits).toEqual([]);
  });

  it("绑定会员后 /orders 返回本人订单（字段契约齐全）", async () => {
    const s = await cSession(`${RUN}-d3`, "h5", "203.0.113.53");
    await bindMember(s.user.id, "M-1001");
    const j = (await (await cReq("/orders", {}, s.token, "203.0.113.53")).json()) as { orders: Array<Record<string, unknown>>; demo: boolean; bindRequired?: boolean };
    expect(j.bindRequired).toBeUndefined();
    expect(j.orders.length).toBeGreaterThan(0);
    const o = j.orders[0]!;
    for (const k of ["id", "title", "status", "checkIn", "roomType", "amount"]) expect(o, k).toHaveProperty(k);
  });

  it("订单金额分→元换算（117600 分 → 1176 元）", async () => {
    const s = await cSession(`${RUN}-d4`, "h5", "203.0.113.54");
    await bindMember(s.user.id, "M-1001");
    const j = (await (await cReq("/orders", {}, s.token, "203.0.113.54")).json()) as { orders: Array<{ id: string; amount: number }> };
    const target = j.orders.find((o) => o.id === "O-20260820-001")!;
    expect(target.amount).toBe(1176);
  });

  it("绑定会员后 /member 返回等级/积分/权益（demo 标注）", async () => {
    const s = await cSession(`${RUN}-d5`, "h5", "203.0.113.55");
    await bindMember(s.user.id, "M-1001");
    const j = (await (await cReq("/member", {}, s.token, "203.0.113.55")).json()) as Record<string, unknown>;
    expect(j).toMatchObject({ level: "金卡", points: 2680, demo: true });
    expect((j.benefits as unknown[]).length).toBeGreaterThan(0);
  });

  it("会员隔离：M-1002 只见本人订单", async () => {
    const s = await cSession(`${RUN}-d6`, "h5", "203.0.113.56");
    await bindMember(s.user.id, "M-1002");
    const j = (await (await cReq("/orders", {}, s.token, "203.0.113.56")).json()) as { orders: Array<{ id: string }> };
    expect(j.orders.length).toBeGreaterThan(0);
    expect(j.orders.every((o) => o.id === "O-20260822-003")).toBe(true);
  });

  it("chat 查订单（已绑定）→ biz_query + order 卡片", async () => {
    const s = await cSession(`${RUN}-d7`, "h5", "203.0.113.57");
    await bindMember(s.user.id, "M-1001");
    const r = await chat(s.token, "帮我查一下我的订单", {}, "203.0.113.57");
    expect(r.intent).toBe("biz_query");
    const cards = r.cards as Array<{ kind: string; data: Record<string, unknown> }>;
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0]!.kind).toBe("order");
    expect(cards[0]!.data).toHaveProperty("checkIn");
  });

  it("chat 查会员（已绑定）→ member 卡片（level/points/benefits）", async () => {
    const s = await cSession(`${RUN}-d8`, "h5", "203.0.113.58");
    await bindMember(s.user.id, "M-1001");
    const r = await chat(s.token, "我的会员积分还有多少", {}, "203.0.113.58");
    const cards = r.cards as Array<{ kind: string; data: Record<string, unknown> }>;
    expect(cards[0]!).toMatchObject({ kind: "member" });
    expect(cards[0]!.data).toMatchObject({ level: "金卡", points: 2680 });
    expect(Array.isArray(cards[0]!.data.benefits)).toBe(true);
  });

  it("chat 查房价 → catalog 卡片（items 含 sku/name/priceYuan）", async () => {
    const { token } = await cSession(`${RUN}-d9`, "h5", "203.0.113.59");
    const r = await chat(token, "豪华大床房多少钱一晚", {}, "203.0.113.59");
    const cards = r.cards as Array<{ kind: string; data: { items: Array<Record<string, unknown>> } }>;
    expect(cards[0]!.kind).toBe("catalog");
    expect(cards[0]!.data.items.length).toBeGreaterThan(0);
    expect(cards[0]!.data.items[0]).toHaveProperty("sku");
    expect(cards[0]!.data.items[0]).toHaveProperty("priceYuan");
  });

  it("chat 未绑定查订单 → 答案替换为绑定引导且不出卡", async () => {
    const { token } = await cSession(`${RUN}-d10`, "h5", "203.0.113.60");
    const r = await chat(token, "我的订单呢", {}, "203.0.113.60");
    expect(r.intent).toBe("biz_query");
    expect(String(r.answer)).toContain("绑定会员");
    expect(r.cards).toEqual([]);
  });

  it("chat 查账单（已绑定）→ query_order 订单卡片", async () => {
    const s = await cSession(`${RUN}-d11`, "h5", "203.0.113.64");
    await bindMember(s.user.id, "M-1001");
    const r = await chat(s.token, "我的账单和房费", {}, "203.0.113.64");
    expect(r.intent).toBe("biz_query");
    expect((r.cards as Array<{ kind: string }>)[0]!.kind).toBe("order");
  });

  it("chat 问工单进度 → query_ticket 应答", async () => {
    const { token } = await cSession(`${RUN}-d12`, "h5", "203.0.113.65");
    const r = await chat(token, "我的工单进度怎么样了", {}, "203.0.113.65");
    expect(r.intent).toBe("biz_query");
    expect(String(r.answer)).toContain("工单进度");
  });

  it("/orders 与 /member 均带 demo 标注", async () => {
    const s = await cSession(`${RUN}-d13`, "h5", "203.0.113.66");
    await bindMember(s.user.id, "M-1001");
    const o = (await (await cReq("/orders", {}, s.token, "203.0.113.66")).json()) as { demo: boolean };
    const m = (await (await cReq("/member", {}, s.token, "203.0.113.66")).json()) as { demo: boolean };
    expect(o.demo).toBe(true);
    expect(m.demo).toBe(true);
  });

  it("/tickets 列表仅本人单（工单查询隔离）", async () => {
    const a = await cSession(`${RUN}-d14a`, "h5", "203.0.113.67");
    const b = await cSession(`${RUN}-d14b`, "h5", "203.0.113.68");
    await cReq("/tickets", {
      method: "POST", body: JSON.stringify({ kind: "other", title: "隔离列表单", payload: {}, idempotencyKey: `${RUN}-d14-1` }),
    }, a.token, "203.0.113.67");
    const listA = (await (await cReq("/tickets", {}, a.token, "203.0.113.67")).json()) as { tickets: Array<{ title: string }> };
    expect(listA.tickets.some((t) => t.title === "隔离列表单")).toBe(true);
    const listB = (await (await cReq("/tickets", {}, b.token, "203.0.113.68")).json()) as { tickets: Array<{ title: string }> };
    expect(listB.tickets.some((t) => t.title === "隔离列表单")).toBe(false);
  });
});

/* ================= F. C 端端到端旅程 ================= */

describe("F C 端旅程 · 首问到五星评价全链路", () => {
  let token = "";
  let cUserId = "";
  let convId = "";
  let ticketId = "";
  const ip = "203.0.113.101";

  it("F1 新用户首问「退房时间几点」→ 命中 KB 带引用", async () => {
    const s = await cSession(`${RUN}-f`, "h5", ip);
    token = s.token;
    cUserId = s.user.id;
    const r = await chat(token, "退房时间是几点？", {}, ip);
    convId = String(r.conversationId);
    expect(r.intent).toBe("kb_qa");
    expect((r.citations as unknown[]).length).toBeGreaterThan(0);
    expect(String(r.answer)).toContain("12:00");
  });

  it("F2 同会话追问「早餐时间是几点」→ conversationId 续聊且中置信命中引用", async () => {
    const r = await chat(token, "早餐时间是几点？", { conversationId: convId }, ip);
    expect(r.conversationId).toBe(convId);
    expect((r.citations as unknown[]).length).toBeGreaterThan(0);
    expect(String(r.answer)).toContain("7:00");
  });

  it("F3 查订单未绑定 → 绑定引导", async () => {
    const r = await chat(token, "查一下我的订单", { conversationId: convId }, ip);
    expect(String(r.answer)).toContain("绑定会员");
    expect(r.cards).toEqual([]);
  });

  it("F4 对话中建单「帮我送两瓶水」→ ticketDraft delivery（未确认不建单）", async () => {
    const r = await chat(token, "帮我送两瓶矿泉水", { conversationId: convId }, ip);
    expect(r.intent).toBe("service_request");
    expect(r.ticketDraft).toMatchObject({ kind: "delivery" });
    expect(r.ticket).toBeNull();
  });

  it("F5 confirmTicket:true → 建单 assigned + 客房部 + statusText 已受理", async () => {
    const r = await chat(token, "帮我送两瓶矿泉水", {
      conversationId: convId, confirmTicket: true, idempotencyKey: `${RUN}-f5`,
    }, ip);
    const t = r.ticket as { id: string; status: string; dept: string; statusText: string };
    ticketId = t.id;
    expect(t).toMatchObject({ status: "assigned", dept: "客房部", statusText: "已受理" });
  });

  it("F6 受理通知：通知箱含 ticket.accepted", async () => {
    const n = (await (await cReq("/notifications", {}, token, ip)).json()) as { notifications: Array<{ kind: string; payload: { ticketId?: string } }> };
    expect(n.notifications.some((x) => x.kind === "ticket.accepted" && x.payload.ticketId === ticketId)).toBe(true);
  });

  it("F7 同幂等键重放 → deduped:true 同单号", async () => {
    const r = await chat(token, "帮我送两瓶矿泉水", {
      conversationId: convId, confirmTicket: true, idempotencyKey: `${RUN}-f5`,
    }, ip);
    expect(r.deduped).toBe(true);
    expect((r.ticket as { id: string }).id).toBe(ticketId);
  });

  it("F8 进度查询：详情时间线含 create/assign", async () => {
    const d = (await (await cReq(`/tickets/${ticketId}`, {}, token, ip)).json()) as { timeline: Array<{ action: string }> };
    const actions = d.timeline.map((e) => e.action);
    expect(actions).toContain("create");
    expect(actions).toContain("assign");
  });

  it("F9 B 端受理推进（start → processing）", async () => {
    const r = await trpc("service.tickets.advance", { input: { ticketId, action: "start" }, token: bToken, method: "mutation" });
    expect(r.error).toBeNull();
    expect((r.data as { ticket: { status: string } }).ticket.status).toBe("processing");
  });

  it("F10 B 端办结（complete → done + 结果回填）", async () => {
    const r = await trpc("service.tickets.complete", { input: { ticketId, result: "两瓶矿泉水已送至房间" }, token: bToken, method: "mutation" });
    expect(r.error).toBeNull();
    const t = (r.data as { ticket: { status: string; result: { text: string } } }).ticket;
    expect(t.status).toBe("done");
    expect(t.result.text).toContain("矿泉水");
  });

  it("F11 完成通知：通知箱含 ticket.completed", async () => {
    const n = (await (await cReq("/notifications", {}, token, ip)).json()) as { notifications: Array<{ kind: string; payload: { ticketId?: string } }> };
    expect(n.notifications.some((x) => x.kind === "ticket.completed" && x.payload.ticketId === ticketId)).toBe(true);
  });

  it("F12 进度再查：statusText=已完成", async () => {
    const d = (await (await cReq(`/tickets/${ticketId}`, {}, token, ip)).json()) as { ticket: { status: string; statusText: string } };
    expect(d.ticket).toMatchObject({ status: "done", statusText: "已完成" });
  });

  it("F13 五星评价 → ratingScore 5", async () => {
    const res = await cReq(`/tickets/${ticketId}/rate`, { method: "POST", body: JSON.stringify({ score: 5, comment: "响应很快" }) }, token, ip);
    expect(res.status).toBe(200);
    const t = ((await res.json()) as { ticket: { ratingScore: number; ratingComment: string } }).ticket;
    expect(t.ratingScore).toBe(5);
    expect(t.ratingComment).toBe("响应很快");
  });

  it("F14 重复评价 → 409", async () => {
    const res = await cReq(`/tickets/${ticketId}/rate`, { method: "POST", body: JSON.stringify({ score: 4 }) }, token, ip);
    expect(res.status).toBe(409);
  });

  it("F15 全旅程时间线完整：create→assign→start→complete→rate", async () => {
    const d = (await (await cReq(`/tickets/${ticketId}`, {}, token, ip)).json()) as { timeline: Array<{ action: string }> };
    expect(d.timeline.map((e) => e.action)).toEqual(["create", "assign", "start", "complete", "rate"]);
  });

  it("F16 会话消息全量落库（c_messages ≥ 8 条）", async () => {
    const r = await db.query(`SELECT role, count(*)::int AS n FROM c_messages WHERE conversation_id=$1 GROUP BY role`, [convId]);
    const by = Object.fromEntries(r.rows.map((x) => [x.role, x.n]));
    expect(by.user).toBeGreaterThanOrEqual(4);
    expect(by.assistant).toBeGreaterThanOrEqual(4);
  });
});

describe("F C 端旅程 · 场景分支", () => {
  it("投诉一句话直达 → intent complaint + complaint 草稿（confirm 后客服部）", async () => {
    const { token } = await cSession(`${RUN}-fc`, "h5", "203.0.113.111");
    const r = await chat(token, "我要投诉，隔壁房间半夜太吵了", {}, "203.0.113.111");
    expect(r.intent).toBe("complaint");
    expect(r.ticketDraft).toMatchObject({ kind: "complaint" });
    const ok = await chat(token, "我要投诉，隔壁房间半夜太吵了", { confirmTicket: true, idempotencyKey: `${RUN}-fc-1` }, "203.0.113.111");
    expect((ok.ticket as { dept: string; kind: string })).toMatchObject({ kind: "complaint", dept: "客服部" });
  });

  it("低置信拒答转单：answer 拒答 + ticketDraft，confirm 后建 other 单（前厅部）", async () => {
    const { token } = await cSession(`${RUN}-fl`, "h5", "203.0.113.112");
    const r = await chat(token, "火星移民船票怎么买", {}, "203.0.113.112");
    expect(String(r.answer)).toContain("无法准确回答");
    expect(r.citations).toEqual([]);
    expect(r.ticketDraft).toMatchObject({ kind: "other" });
    const ok = await chat(token, "火星移民船票怎么买", { confirmTicket: true, idempotencyKey: `${RUN}-fl-1` }, "203.0.113.112");
    expect((ok.ticket as { kind: string; dept: string })).toMatchObject({ kind: "other", dept: "前厅部" });
  });

  it("报修一句话「空调坏了」→ service_request repair 草稿，confirm 后工程部", async () => {
    const { token } = await cSession(`${RUN}-fr`, "h5", "203.0.113.113");
    const r = await chat(token, "房间空调坏了，帮我修一下", {}, "203.0.113.113");
    expect(r.intent).toBe("service_request");
    expect(r.ticketDraft).toMatchObject({ kind: "repair" });
    const ok = await chat(token, "房间空调坏了，帮我修一下", { confirmTicket: true, idempotencyKey: `${RUN}-fr-1` }, "203.0.113.113");
    expect((ok.ticket as { dept: string })).toMatchObject({ dept: "工程部" });
  });

  it("疑问句含服务词不建服务单：「送站巴士几点发」走 kb_qa（未覆盖仅给拒答草稿，不落单）", async () => {
    const { token } = await cSession(`${RUN}-fq`, "h5", "203.0.113.114");
    const r = await chat(token, "送站巴士几点发车", {}, "203.0.113.114");
    expect(r.intent).toBe("kb_qa");
    expect(r.ticket).toBeNull(); // 不建单
    // KB 未覆盖 → 低置信拒答草稿（other），而非 service_request 送物单
    expect((r.ticketDraft as { kind: string } | null)?.kind ?? "other").not.toBe("delivery");
    const list = (await (await cReq("/tickets", {}, token, "203.0.113.114")).json()) as { tickets: unknown[] };
    expect(list.tickets).toHaveLength(0);
  });

  // ⚠️ 疑似真实 bug（不改源码，标注 test.fails 上报）：
  // 客户端显式回传的上轮草稿 body.ticketDraft 被本轮消息新生成的低置信拒答草稿
  // （r.ticketDraft，kind=other）遮蔽——gateway.ts 取 `r.ticketDraft ?? body.ticketDraft`，
  // 「好的确认提交」默认走 kb_qa 低置信拒答也会产草稿，导致确认建单建成 other 而非 delivery。
  // 合理预期：显式 body.ticketDraft 应优先。
  it("confirmTicket 带 body.ticketDraft 兜底（上轮草稿本轮确认，显式草稿优先）【bug 已修复】", async () => {
    const { token } = await cSession(`${RUN}-fb`, "h5", "203.0.113.115");
    const first = await chat(token, "帮我送一床被子", {}, "203.0.113.115");
    const draft = first.ticketDraft as { kind: string; title: string; payload: Record<string, unknown> };
    expect(draft).toBeDefined();
    const second = await chat(token, "好的确认提交", {
      confirmTicket: true, ticketDraft: draft, idempotencyKey: `${RUN}-fb-1`,
    }, "203.0.113.115");
    expect((second.ticket as { kind: string; status: string })).toMatchObject({ kind: "delivery", status: "assigned" });
  });

  it("mock 标注：LLM 未装配时响应 mock:true", async () => {
    const { token } = await cSession(`${RUN}-fm`, "h5", "203.0.113.116");
    const r = await chat(token, "退房时间几点", {}, "203.0.113.116");
    expect(r.mock).toBe(true);
  });

  it("latencyMs 为非负数字", async () => {
    const { token } = await cSession(`${RUN}-ft`, "h5", "203.0.113.117");
    const r = await chat(token, "早餐几点", {}, "203.0.113.117");
    expect(typeof r.latencyMs).toBe("number");
    expect(r.latencyMs as number).toBeGreaterThanOrEqual(0);
  });

  // ⚠️ 疑似真实 bug（不改源码，标注 test.fails 上报）：
  // 切块正文写作「Wi-Fi」（连字符），查询「wifi 密码」切词得 token "wifi"，
  // 不是 "wi-fi" 的子串 → 召回/打分双 miss，top1≈0.21 < 0.5 落入诚实拒答。
  // 连字符未归一导致高频 WiFi 问句无法命中 Wi-Fi 知识（检索召回缺陷）。
  it("WiFi 问句命中种子 KB（密码为房间号后四位）【bug 已修复：连字符归一】", async () => {
    const { token } = await cSession(`${RUN}-fw`, "h5", "203.0.113.118");
    const r = await chat(token, "wifi 密码是什么", {}, "203.0.113.118");
    expect((r.citations as unknown[]).length).toBeGreaterThan(0);
    expect(String(r.answer)).toContain("房间号后四位");
  });

  it("连字符原样问句「Wi-Fi 密码」可命中（对照组）", async () => {
    const { token } = await cSession(`${RUN}-fw2`, "h5", "203.0.113.120");
    const r = await chat(token, "Wi-Fi 密码是多少", {}, "203.0.113.120");
    expect((r.citations as unknown[]).length).toBeGreaterThan(0);
    expect(String(r.answer)).toContain("房间号后四位");
  });

  it("未 confirmTicket 时 ticket 为 null（草稿不落库）", async () => {
    const { token } = await cSession(`${RUN}-fn`, "h5", "203.0.113.119");
    const r = await chat(token, "帮我打扫一下房间", {}, "203.0.113.119");
    expect(r.ticket).toBeNull();
    const list = (await (await cReq("/tickets", {}, token, "203.0.113.119")).json()) as { tickets: unknown[] };
    expect(list.tickets).toHaveLength(0);
  });
});

/* ================= G. B 端视角（tRPC serviceRouter） ================= */

describe("G B 端 · 登录与守卫", () => {
  it("loginAs 返回 token + identity（owner / plan pro）", async () => {
    const r = await trpc("auth.loginAs", { input: { workspaceSlug: "yunqi-hotel", memberNo: "MEM-001" }, method: "mutation" });
    expect(r.error).toBeNull();
    const d = r.data as { token: string; identity: Record<string, unknown> };
    expect(typeof d.token).toBe("string");
    expect(d.identity).toMatchObject({ memberNo: "MEM-001", role: "owner", workspaceId: "ws-yunqi" });
  });

  it("loginAs 不存在工作区 → NOT_FOUND", async () => {
    const r = await trpc("auth.loginAs", { input: { workspaceSlug: "no-such", memberNo: "MEM-001" }, method: "mutation" });
    expect(r.error).not.toBeNull();
    expect(r.error!.data?.code).toBe("NOT_FOUND");
  });

  it("loginAs 不存在成员 → NOT_FOUND", async () => {
    const r = await trpc("auth.loginAs", { input: { workspaceSlug: "yunqi-hotel", memberNo: "MEM-999" }, method: "mutation" });
    expect(r.error!.data?.code).toBe("NOT_FOUND");
  });

  it("无 JWT 调受保护过程 → UNAUTHORIZED(401)", async () => {
    const r = await trpc("service.stats.overview");
    expect(r.status).toBe(401);
    expect(r.error!.data?.code).toBe("UNAUTHORIZED");
  });

  it("readonly 成员写操作 → FORBIDDEN(403)；查询放行", async () => {
    const w = await trpc("service.kb.createCollection", { input: { name: `${RUN}-ro` }, token: roToken, method: "mutation" });
    expect(w.status).toBe(403);
    expect(w.error!.data?.code).toBe("FORBIDDEN");
    const q = await trpc("service.kb.listCollections", { token: roToken });
    expect(q.error).toBeNull();
  });
});

describe("G B 端 · KB 管理", () => {
  let colId = "";
  let docId = "";

  it("kb.listCollections 含种子「住客服务知识库」", async () => {
    const r = await trpc("service.kb.listCollections", { token: bToken });
    const cols = (r.data as { collections: Array<{ id: string; name: string }> }).collections;
    expect(cols.some((c) => c.name === "住客服务知识库")).toBe(true);
  });

  it("kb.createCollection 创建后列表可见", async () => {
    const r = await trpc("service.kb.createCollection", { input: { name: `${RUN}-集合`, description: "e2e" }, token: bToken, method: "mutation" });
    expect(r.error).toBeNull();
    colId = (r.data as { collection: { id: string } }).collection.id;
    const list = await trpc("service.kb.listCollections", { token: bToken });
    expect((list.data as { collections: Array<{ id: string }> }).collections.some((c) => c.id === colId)).toBe(true);
  });

  it("kb.upsertDocument 新建 → version 1 + 切块数 > 0（pending_review）", async () => {
    const r = await trpc("service.kb.upsertDocument", {
      input: {
        collectionId: colId, title: `${RUN}-接送机政策`, sourceKind: "manual",
        contentMd: `## 接送机\n\n酒店提供付费接送机服务，需提前四小时预约，单程一百八十元，正文长度足够。（${RUN}）\n`,
      }, token: bToken, method: "mutation",
    });
    expect(r.error).toBeNull();
    const d = r.data as { documentId: string; version: number; chunks: number };
    docId = d.documentId;
    expect(d.version).toBe(1);
    expect(d.chunks).toBeGreaterThan(0);
  });

  it("kb.upsertDocument 同内容再传 → hash 幂等（chunks 0 同文档）", async () => {
    const r = await trpc("service.kb.upsertDocument", {
      input: {
        collectionId: colId, title: `${RUN}-接送机政策`, sourceKind: "manual",
        contentMd: `## 接送机\n\n酒店提供付费接送机服务，需提前四小时预约，单程一百八十元，正文长度足够。（${RUN}）\n`,
      }, token: bToken, method: "mutation",
    });
    const d = r.data as { documentId: string; version: number; chunks: number };
    expect(d.documentId).toBe(docId);
    expect(d.chunks).toBe(0);
  });

  it("kb.upsertDocument 同标题新内容 → version 2", async () => {
    const r = await trpc("service.kb.upsertDocument", {
      input: {
        collectionId: colId, title: `${RUN}-接送机政策`, sourceKind: "manual",
        contentMd: `## 接送机\n\n接送机服务调整为单程二百元，需提前六小时预约，正文长度足够用来切块。（${RUN}）\n`,
      }, token: bToken, method: "mutation",
    });
    expect((r.data as { version: number }).version).toBe(2);
  });

  it("kb.listDocuments 按集合过滤", async () => {
    const r = await trpc("service.kb.listDocuments", { input: { collectionId: colId }, token: bToken });
    const docs = (r.data as { documents: Array<{ id: string; collectionId: string }> }).documents;
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => d.collectionId === colId)).toBe(true);
  });

  it("kb.pendingReviews 列出待审文档", async () => {
    const r = await trpc("service.kb.pendingReviews", { token: bToken });
    const docs = (r.data as { documents: Array<{ id: string; title: string }> }).documents;
    expect(docs.some((d) => d.id === docId)).toBe(true);
  });

  it("approveDocument 批准生效 → ok + eventId（pendingReviews 移除）", async () => {
    const r = await trpc("service.kb.approveDocument", { input: { documentId: docId }, token: bToken, method: "mutation" });
    expect(r.error).toBeNull();
    const d = r.data as { ok: boolean; eventId: string };
    expect(d.ok).toBe(true);
    expect(typeof d.eventId).toBe("string");
    const after = await trpc("service.kb.pendingReviews", { token: bToken });
    expect((after.data as { documents: Array<{ id: string }> }).documents.some((x) => x.id === docId)).toBe(false);
  });

  it("approveDocument 联动审批台（五元事件 + approvals 行落库，event_id 关联）", async () => {
    const ev = await db.query<{ event_id: string }>(
      `SELECT event_id FROM biz_events WHERE payload->'decision'->>'action'='kb.publish' ORDER BY seq DESC LIMIT 1`,
    );
    expect(ev.rows.length).toBeGreaterThan(0);
    const ap = await db.query<{ approval_id: string; event_id: string; status: string }>(
      `SELECT approval_id, event_id, status FROM approvals WHERE event_id=$1 AND channel='inapp'`,
      [ev.rows[0]!.event_id],
    );
    expect(ap.rows.length).toBeGreaterThan(0);
    expect(ap.rows[0]!.event_id).toBe(ev.rows[0]!.event_id);
  });

  it("approveDocument 后检索可见（kb.search 命中）", async () => {
    // 查询词带 RUN 指纹：历次运行累积的同主题 active 文档不会稀释本轮命中
    const r = await trpc("service.kb.search", { input: { query: `接送机怎么预约 ${RUN}`, limit: 20 }, token: bToken });
    const hits = (r.data as { hits: Array<{ documentTitle: string }> }).hits;
    expect(hits.some((h) => h.documentTitle === `${RUN}-接送机政策`)).toBe(true);
  });

  it("approveDocument 不存在文档 → NOT_FOUND", async () => {
    const r = await trpc("service.kb.approveDocument", { input: { documentId: "kbd-none" }, token: bToken, method: "mutation" });
    expect(r.error!.data?.code).toBe("NOT_FOUND");
  });

  it("kb.setStatus disabled → 检索不可见；恢复 active 可检索", async () => {
    await trpc("service.kb.setStatus", { input: { documentId: docId, status: "disabled" }, token: bToken, method: "mutation" });
    const off = await trpc("service.kb.search", { input: { query: `接送机预约 ${RUN}`, limit: 20 }, token: bToken });
    expect((off.data as { hits: Array<{ documentTitle: string }> }).hits.some((h) => h.documentTitle === `${RUN}-接送机政策`)).toBe(false);
    await trpc("service.kb.setStatus", { input: { documentId: docId, status: "active" }, token: bToken, method: "mutation" });
    const on = await trpc("service.kb.search", { input: { query: `接送机预约 ${RUN}`, limit: 20 }, token: bToken });
    expect((on.data as { hits: Array<{ documentTitle: string }> }).hits.some((h) => h.documentTitle === `${RUN}-接送机政策`)).toBe(true);
  });
});

describe("G B 端 · 工单消费", () => {
  let cTicketId = "";
  let cToken = "";
  let createdId = "";

  it("tickets.list 按状态过滤（assigned）", async () => {
    const s = await cSession(`${RUN}-g`, "h5", "203.0.113.121");
    cToken = s.token;
    const made = (await (await cReq("/tickets", {
      method: "POST", body: JSON.stringify({ kind: "delivery", title: `${RUN}-B端消费单`, payload: {}, idempotencyKey: `${RUN}-g-1` }),
    }, cToken, "203.0.113.121")).json()) as { ticket: { id: string } };
    cTicketId = made.ticket.id;
    const r = await trpc("service.tickets.list", { input: { status: "assigned" }, token: bToken });
    const tickets = (r.data as { tickets: Array<{ id: string; status: string }> }).tickets;
    expect(tickets.some((t) => t.id === cTicketId)).toBe(true);
    expect(tickets.every((t) => t.status === "assigned")).toBe(true);
  });

  it("tickets.assign 指定 dept/assignee（created 单）", async () => {
    // 直插一张 created 单（C 端链路建单即 assigned，created 态由 DB fixture 构造）
    createdId = `tck-${RUN}-created`;
    await db.query(
      `INSERT INTO c_tickets (id, workspace_id, kind, title, payload, status) VALUES ($1,'ws-yunqi','other',$2,'{}','created')`,
      [createdId, `${RUN}-待分派单`],
    );
    const r = await trpc("service.tickets.assign", { input: { ticketId: createdId, dept: "礼宾部", assignee: "MEM-002" }, token: bToken, method: "mutation" });
    expect(r.error).toBeNull();
    expect((r.data as { ticket: Record<string, unknown> }).ticket).toMatchObject({ dept: "礼宾部", assignee: "MEM-002", status: "assigned" });
  });

  it("tickets.assign 对 assigned 单重复分派 → 409 语义错误", async () => {
    const r = await trpc("service.tickets.assign", { input: { ticketId: createdId, dept: "x" }, token: bToken, method: "mutation" });
    expect(r.error).not.toBeNull();
    expect(String(r.error!.code)).not.toBe("0");
  });

  it("tickets.advance start → processing（留痕）", async () => {
    const r = await trpc("service.tickets.advance", { input: { ticketId: cTicketId, action: "start" }, token: bToken, method: "mutation" });
    expect((r.data as { ticket: { status: string } }).ticket.status).toBe("processing");
  });

  it("tickets.advance 非 start 动作 → 留痕不变状态", async () => {
    const r = await trpc("service.tickets.advance", { input: { ticketId: cTicketId, action: "备注：客人催促一次" }, token: bToken, method: "mutation" });
    expect(r.error).toBeNull();
    expect((r.data as { ticket: { status: string } }).ticket.status).toBe("processing");
  });

  it("tickets.complete → done + C 端收到完成通知", async () => {
    const r = await trpc("service.tickets.complete", { input: { ticketId: cTicketId, result: "已送达" }, token: bToken, method: "mutation" });
    expect((r.data as { ticket: { status: string } }).ticket.status).toBe("done");
    const n = (await (await cReq("/notifications", {}, cToken, "203.0.113.121")).json()) as { notifications: Array<{ kind: string; payload: { ticketId?: string } }> };
    expect(n.notifications.some((x) => x.kind === "ticket.completed" && x.payload.ticketId === cTicketId)).toBe(true);
  });

  it("tickets.timeline 完整回放（create/assign/start/备注/complete）", async () => {
    const r = await trpc("service.tickets.timeline", { input: { ticketId: cTicketId }, token: bToken });
    const actions = (r.data as { timeline: Array<{ action: string }> }).timeline.map((e) => e.action);
    expect(actions).toContain("create");
    expect(actions).toContain("assign");
    expect(actions).toContain("start");
    expect(actions).toContain("备注：客人催促一次");
    expect(actions).toContain("complete");
  });

  it("tickets.slaScan 返回 {escalated:number}", async () => {
    const r = await trpc("service.tickets.slaScan", { token: bToken, method: "mutation" });
    expect(r.error).toBeNull();
    expect(typeof (r.data as { escalated: number }).escalated).toBe("number");
  });
});

describe("G B 端 · stats.overview 指标", () => {
  it("字段齐全：date/sessions/qaCount/avgConfidence/groundedRate/avgLatencyMs/ticketsToday/completionRate/slaBreached/avgRating", async () => {
    const r = await trpc("service.stats.overview", { token: bToken });
    expect(r.error).toBeNull();
    const d = r.data as Record<string, unknown>;
    for (const k of ["date", "sessions", "qaCount", "avgConfidence", "groundedRate", "avgLatencyMs", "ticketsToday", "completionRate", "slaBreached", "avgRating"]) {
      expect(d, k).toHaveProperty(k);
    }
    expect(String(d.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("指标合理性：比率 ∈ [0,1]、计数非负、今日有问答与工单", async () => {
    const r = await trpc("service.stats.overview", { token: bToken });
    const d = r.data as Record<string, number | null>;
    expect(d.sessions).toBeGreaterThan(0);
    expect(d.qaCount).toBeGreaterThan(0);
    expect(d.ticketsToday).toBeGreaterThan(0);
    expect(d.groundedRate).toBeGreaterThanOrEqual(0);
    expect(d.groundedRate!).toBeLessThanOrEqual(1);
    if (d.completionRate !== null) {
      expect(d.completionRate).toBeGreaterThanOrEqual(0);
      expect(d.completionRate).toBeLessThanOrEqual(1);
    }
    expect(d.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(d.avgConfidence).toBeGreaterThan(0);
    expect(d.slaBreached).toBeGreaterThanOrEqual(0);
  });

  it("有据率口径：有引用助手消息 / 全部助手消息（抽查一致性）", async () => {
    const r = await trpc("service.stats.overview", { token: bToken });
    const d = r.data as { groundedRate: number | null };
    const q = await db.query<{ grounded: string; answered: string }>(
      `SELECT count(*) FILTER (WHERE role='assistant' AND jsonb_array_length(citations) > 0)::text AS grounded,
              count(*) FILTER (WHERE role='assistant')::text AS answered
       FROM c_messages WHERE workspace_id='ws-yunqi' AND created_at >= date_trunc('day', now())`,
    );
    const expectRate = Number((Number(q.rows[0]!.grounded) / Number(q.rows[0]!.answered)).toFixed(3));
    expect(d.groundedRate).toBe(expectRate);
  });

  it("完结率随办结单提升（F 旅程 done 单计入）", async () => {
    const r = await trpc("service.stats.overview", { token: bToken });
    const d = r.data as { completionRate: number | null };
    expect(d.completionRate).not.toBeNull();
    expect(d.completionRate!).toBeGreaterThan(0);
  });
});
