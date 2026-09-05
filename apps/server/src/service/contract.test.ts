/**
 * server · C 端网关契约 fixture 单测（H6：以 webc types.ts 为准断言响应形状）
 * 直连 Hono handler（serviceGateway.request），打沙箱活库（需先应用 0011 迁移）。
 * 覆盖：session 形状与渠道门控/限流、cards kind/data、statusText 中文枚举、
 *      /member /orders /notifications 形状、建单幂等重放、rate 409、404 requestId、低置信拒答 ticketDraft。
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";

process.env.DATABASE_URL ??= "postgres://postgres:workloom@localhost:5432/workloom";
process.env.DATABASE_APP_URL ??= "postgres://workloom_app:workloom_dev_app@localhost:5432/workloom";
process.env.DATABASE_GATEWAY_URL ??= "postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom";
process.env.SERVICE_C_DEMO_AUTH = "true";

let app: Hono;
const RUN = `contract-${Date.now().toString(36)}`;
const IP = "198.51.100.77"; // TEST-NET-2，与其它用例隔离限流桶

async function req(path: string, init?: RequestInit, token?: string): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": IP,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
}

async function makeSession(openid: string): Promise<{ token: string; user: Record<string, unknown> }> {
  const res = await req("/session", { method: "POST", body: JSON.stringify({ channel: "h5", openid, nickname: "契约测试" }) });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; user: Record<string, unknown> };
}

beforeAll(async () => {
  ({ serviceGateway: app } = await import("./gateway.js"));
});

describe("契约 · session（S2）", () => {
  it("h5 演示直登返回 {token, user}", async () => {
    const s = await makeSession(`${RUN}-a`);
    expect(typeof s.token).toBe("string");
    expect(s.user).toMatchObject({ channel: "h5", openid: `${RUN}-a` });
    expect(typeof s.user.id).toBe("string");
  });

  it("wechat-mini 无 code → 400；有 code 无凭据 → 503 渠道未配置", async () => {
    const r1 = await req("/session", { method: "POST", body: JSON.stringify({ channel: "wechat-mini" }) });
    expect(r1.status).toBe(400);
    const r2 = await req("/session", { method: "POST", body: JSON.stringify({ channel: "wechat-mini", code: "abc" }) });
    expect(r2.status).toBe(503);
    expect(((await r2.json()) as { error: string }).error).toContain("渠道未配置");
  });

  it("session IP+channel 限流 60 次/分", async () => {
    let last = 0;
    for (let i = 0; i < 65; i++) {
      const res = await app.request("/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ channel: "h5", openid: `${RUN}-rl` }),
      });
      last = res.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});

describe("契约 · member / orders / notifications（H6）", () => {
  it("未绑定会员：/member 返回 {level,points,benefits[],demo,bindRequired}，/orders 空集+bindRequired", async () => {
    const { token } = await makeSession(`${RUN}-guest`);
    const m = (await (await req("/member", {}, token)).json()) as Record<string, unknown>;
    expect(m).toMatchObject({ level: "游客", points: 0, bindRequired: true });
    expect(Array.isArray(m.benefits)).toBe(true);
    expect(typeof m.hint).toBe("string");

    const o = (await (await req("/orders", {}, token)).json()) as Record<string, unknown>;
    expect(o).toMatchObject({ bindRequired: true });
    expect(o.orders).toEqual([]);
  });

  it("/notifications 每项含 read:false 占位", async () => {
    const { token } = await makeSession(`${RUN}-ntf`);
    // 先建一单触发受理通知
    await req("/tickets", {
      method: "POST",
      body: JSON.stringify({ kind: "other", title: "契约测试通知", payload: {}, idempotencyKey: `${RUN}-ntf-t1` }),
    }, token);
    const n = (await (await req("/notifications", {}, token)).json()) as { notifications: Array<Record<string, unknown>> };
    expect(n.notifications.length).toBeGreaterThan(0);
    for (const item of n.notifications) {
      expect(item).toMatchObject({ read: false });
      expect(typeof item.id).toBe("string");
      expect(typeof item.kind).toBe("string");
      expect(typeof item.createdAt).toBe("string");
    }
  });
});

describe("契约 · 工单（H1/H2/H6/L9/M9）", () => {
  it("建单 → {ticket:{id,kind,title,status,statusText}}；同键重放 idempotentReplay 且同 id", async () => {
    const { token } = await makeSession(`${RUN}-t`);
    const body = JSON.stringify({ kind: "repair", title: "契约测试-水龙头漏水", payload: { room: "9999" }, idempotencyKey: `${RUN}-t1` });
    const r1 = (await (await req("/tickets", { method: "POST", body }, token)).json()) as { ticket: Record<string, unknown> };
    expect(r1.ticket).toMatchObject({ kind: "repair", title: "契约测试-水龙头漏水", status: "assigned", statusText: "已受理" });
    expect(typeof r1.ticket.id).toBe("string");

    const r2 = (await (await req("/tickets", { method: "POST", body }, token)).json()) as { ticket: { id: string }; idempotentReplay?: boolean };
    expect(r2.idempotentReplay).toBe(true);
    expect(r2.ticket.id).toBe(r1.ticket.id);

    // 列表项同样带 statusText
    const list = (await (await req("/tickets", {}, token)).json()) as { tickets: Array<Record<string, unknown>> };
    const mine = list.tickets.find((t) => t.id === r1.ticket.id)!;
    expect(mine).toMatchObject({ status: "assigned", statusText: "已受理" });
  });

  it("非 done 工单评价 → 409；不存在工单详情 → 404 带 requestId", async () => {
    const { token } = await makeSession(`${RUN}-r`);
    const created = (await (await req("/tickets", {
      method: "POST",
      body: JSON.stringify({ kind: "delivery", title: "契约测试-送水", payload: {}, idempotencyKey: `${RUN}-r1` }),
    }, token)).json()) as { ticket: { id: string } };
    const rate = await req(`/tickets/${created.ticket.id}/rate`, { method: "POST", body: JSON.stringify({ score: 5 }) }, token);
    expect(rate.status).toBe(409);

    const missing = await req("/tickets/tck-not-exist", {}, token);
    expect(missing.status).toBe(404);
    const mj = (await missing.json()) as { requestId?: string };
    expect(typeof mj.requestId).toBe("string");
  });

  it("M9：非法 kind / 超长 title → 400", async () => {
    const { token } = await makeSession(`${RUN}-v`);
    const bad = await req("/tickets", { method: "POST", body: JSON.stringify({ kind: "hack", title: "x", payload: {} }) }, token);
    expect(bad.status).toBe(400);
    const long = await req("/tickets", { method: "POST", body: JSON.stringify({ kind: "other", title: "长".repeat(121), payload: {} }) }, token);
    expect(long.status).toBe(400);
  });
});

describe("契约 · chat（H5/H6/M9）", () => {
  it("KB 高置信问答：citations 非空、cards 为 {kind,data} 契约", async () => {
    const { token } = await makeSession(`${RUN}-c`);
    const r = (await (await req("/chat", {
      method: "POST",
      body: JSON.stringify({ text: "退房时间是几点？" }),
    }, token)).json()) as Record<string, unknown>;
    expect(r).toMatchObject({ intent: "kb_qa" });
    expect(typeof r.answer).toBe("string");
    const conf = r.confidence as number;
    expect(conf).toBeGreaterThan(0);
    expect(conf).toBeLessThanOrEqual(1);
    expect((r.citations as unknown[]).length).toBeGreaterThan(0);
    for (const card of (r.cards ?? []) as Array<{ kind: string; data: unknown }>) {
      expect(["order", "member", "catalog"]).toContain(card.kind);
      expect(typeof card.data).toBe("object");
    }
  });

  it("低置信问题诚实拒答 + ticketDraft（无 citations）", async () => {
    const { token } = await makeSession(`${RUN}-c2`);
    const r = (await (await req("/chat", {
      method: "POST",
      body: JSON.stringify({ text: "火星移民船票怎么买" }),
    }, token)).json()) as Record<string, unknown>;
    expect(r.confidence as number).toBeLessThan(0.5);
    expect((r.citations as unknown[]).length).toBe(0);
    expect(r.ticketDraft).toMatchObject({ kind: "other" });
    expect(String(r.answer)).toContain("无法准确回答");
  });

  it("text 超 2000 字符 → 400", async () => {
    const { token } = await makeSession(`${RUN}-c3`);
    const res = await req("/chat", { method: "POST", body: JSON.stringify({ text: "长".repeat(2001) }) }, token);
    expect(res.status).toBe(400);
  });
});
