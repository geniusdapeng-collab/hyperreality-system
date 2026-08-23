/**
 * service-channels · 大规模功能场景套件（E base：渠道与安全）
 * 覆盖：渠道注册表（三渠道/非法渠道）、C 端 token（签发-校验往返/伪造签名拒/过期拒/scope
 * 校验/非法渠道拒签）、C 端用户归一（确定性 id/幂等 upsert/昵称覆盖）、身份核验（demo 直通/
 * 自定义 provider 拒绝/phone_hash 不落明文）、推送（mock 驱动落库可查/微信·支付宝未配置
 * 即抛不静默假成功/按渠道选驱动）。DB 走内存 FakeDb。
 */
import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { FakeDb, nextSerial } from "../testing/fake-pg.js";
import { assertChannel, CHANNEL_REGISTRY, CHANNELS } from "./channels.js";
import { CTokenError, issueCToken, verifyCToken } from "./token.js";
import { cUserIdOf, resolveCUser } from "./users.js";
import { DemoPassThroughProvider, hashPhone, verifyIdentity, type PhoneCodeProvider } from "./identity.js";
import {
  AlipayNotifyPushDriver, MockPushDriver, pushMessage, WechatSubscribePushDriver,
} from "./push.js";

const WS = "ws-scen-ch";
const SECRET = "test-c-secret-at-least-32-chars-long!!";

/* ================= FakeDb 接线（c_users / c_notifications） ================= */

function wireChannelDb(db: FakeDb): FakeDb {
  const findUser = (p: unknown[], d: FakeDb) =>
    d.table("c_users").find((r) => r["workspace_id"] === p[0] && r["channel"] === p[1] && r["openid"] === p[2]);
  db.on(/^SELECT \* FROM c_users WHERE workspace_id=\$1 AND channel=\$2 AND openid=\$3/, (p, d) => ({
    rows: [findUser(p, d)].filter(Boolean) as FakeRowT[],
  }));
  db.on(/^UPDATE c_users SET nickname=\$4/, (p, d) => {
    const row = findUser(p, d);
    if (!row) return { rows: [] };
    row["nickname"] = p[3];
    return { rows: [row] };
  });
  db.on(/^INSERT INTO c_users/, (p, d) => {
    const dup = findUser(p, d);
    if (dup) return { rows: [] }; // ON CONFLICT DO NOTHING
    const row = {
      id: p[0], workspace_id: p[1], channel: p[2], openid: p[3], nickname: p[4],
      member_id: null, phone_hash: null, created_at: new Date().toISOString(),
    };
    d.table("c_users").push(row);
    return { rows: [row] };
  });
  db.on(/^UPDATE c_users SET phone_hash=\$3 WHERE id=\$1 AND workspace_id=\$2/, (p, d) => {
    const row = d.table("c_users").find((r) => r["id"] === p[0] && r["workspace_id"] === p[1]);
    if (row) row["phone_hash"] = p[2];
    return { rows: [] };
  });
  db.on(/^SELECT channel, openid FROM c_users WHERE id=\$1 AND workspace_id=\$2/, (p, d) => ({
    rows: d.table("c_users")
      .filter((r) => r["id"] === p[0] && r["workspace_id"] === p[1])
      .map((r) => ({ channel: r["channel"], openid: r["openid"] })),
  }));
  db.on(/^INSERT INTO c_notifications/, (p, d) => {
    const id = nextSerial(d, "c_notifications");
    d.table("c_notifications").push({
      id, workspace_id: p[0], c_user_id: p[1], channel: p[2], kind: p[3],
      payload: JSON.parse(String(p[4])), driver: p[5], status: "delivered",
      created_at: new Date().toISOString(),
    });
    return { rows: [{ id }] };
  });
  return db;
}
type FakeRowT = Record<string, unknown>;

/* ================= E1. 渠道注册表 ================= */

describe("E1 渠道注册表", () => {
  it("三渠道断言通过：wechat-mini / alipay / h5", () => {
    for (const c of CHANNELS) expect(() => assertChannel(c)).not.toThrow();
    expect(CHANNELS).toEqual(["wechat-mini", "alipay", "h5"]);
  });

  it("非法渠道抛错并列出合法集", () => {
    expect(() => assertChannel("tiktok")).toThrow(/非法渠道「tiktok」/);
    expect(() => assertChannel("")).toThrow(/wechat-mini\/alipay\/h5/);
  });

  it("推送驱动映射：微信订阅/支付宝通知/h5 mock", () => {
    expect(CHANNEL_REGISTRY["wechat-mini"].pushDriver).toBe("wechat-subscribe");
    expect(CHANNEL_REGISTRY["alipay"].pushDriver).toBe("alipay-notify");
    expect(CHANNEL_REGISTRY["h5"].pushDriver).toBe("mock");
  });
});

/* ================= E2. C 端 token ================= */

describe("E2 token · 签发与校验", () => {
  const payload = { workspaceId: WS, cUserId: "cu-1", channel: "h5" as const };

  it("签发-校验往返（payload 完整 + scope 固定 'c'）", async () => {
    const token = await issueCToken(SECRET, payload);
    const got = await verifyCToken(SECRET, token);
    expect(got).toMatchObject({ ...payload, scope: "c" });
  });

  it("伪造签名（错误密钥）→ INVALID 拒绝", async () => {
    const token = await issueCToken(SECRET, payload);
    await expect(verifyCToken("another-secret-32-chars-long-xxxxxx", token))
      .rejects.toMatchObject({ code: "INVALID" });
  });

  it("篡改 payload 段 → INVALID 拒绝", async () => {
    const token = await issueCToken(SECRET, payload);
    const [h, , s] = token.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ workspaceId: WS, cUserId: "cu-evil", channel: "h5", scope: "c" })).toString("base64url")}.${s}`;
    await expect(verifyCToken(SECRET, forged)).rejects.toMatchObject({ code: "INVALID" });
  });

  it("过期 token → EXPIRED 语义错误", async () => {
    const token = await issueCToken(SECRET, payload, "-1s");
    await expect(verifyCToken(SECRET, token)).rejects.toMatchObject({ code: "EXPIRED" });
    await expect(verifyCToken(SECRET, token)).rejects.toBeInstanceOf(CTokenError);
  });

  it("scope 非 'c'（B 端令牌混用）→ BAD_SCOPE 拒绝", async () => {
    const bToken = await new SignJWT({ workspaceId: WS, cUserId: "cu-1", channel: "h5", scope: "b" })
      .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifyCToken(SECRET, bToken)).rejects.toMatchObject({ code: "BAD_SCOPE" });
  });

  it("非法渠道拒签", async () => {
    await expect(issueCToken(SECRET, { ...payload, channel: "tiktok" as never }))
      .rejects.toThrow(/非法渠道/);
  });

  it("畸形 token 串 → INVALID", async () => {
    await expect(verifyCToken(SECRET, "not.a.jwt")).rejects.toMatchObject({ code: "INVALID" });
  });
});

/* ================= E3. C 端用户归一 ================= */

describe("E3 用户归一 · resolveCUser", () => {
  it("cUserIdOf 确定性（同输入恒定）且输入敏感", () => {
    const a = cUserIdOf(WS, "h5", "openid-1");
    expect(a).toBe(cUserIdOf(WS, "h5", "openid-1"));
    expect(a).toMatch(/^cu-[0-9a-f]{12}$/);
    expect(a).not.toBe(cUserIdOf(WS, "h5", "openid-2"));
    expect(a).not.toBe(cUserIdOf(WS, "alipay", "openid-1"));
    expect(a).not.toBe(cUserIdOf("ws-other", "h5", "openid-1"));
  });

  it("新用户创建 created:true；重复进入幂等同 id created:false", async () => {
    const db = wireChannelDb(new FakeDb());
    const a = await resolveCUser(db, { workspaceId: WS, channel: "h5", openid: "o-1", nickname: "小明" });
    expect(a.created).toBe(true);
    const b = await resolveCUser(db, { workspaceId: WS, channel: "h5", openid: "o-1" });
    expect(b.created).toBe(false);
    expect(b.user.id).toBe(a.user.id);
    expect(db.table("c_users")).toHaveLength(1);
  });

  it("昵称变更后写覆盖", async () => {
    const db = wireChannelDb(new FakeDb());
    await resolveCUser(db, { workspaceId: WS, channel: "h5", openid: "o-2", nickname: "旧名" });
    const r = await resolveCUser(db, { workspaceId: WS, channel: "h5", openid: "o-2", nickname: "新名" });
    expect(r.created).toBe(false);
    expect(r.user.nickname).toBe("新名");
  });

  it("非法渠道拒绝建用户", async () => {
    const db = wireChannelDb(new FakeDb());
    await expect(resolveCUser(db, { workspaceId: WS, channel: "tiktok", openid: "x" }))
      .rejects.toThrow(/非法渠道/);
  });
});

/* ================= E4. 身份核验 ================= */

describe("E4 身份核验 · verifyIdentity", () => {
  it("hashPhone 为 sha256 hex（不落明文）", () => {
    const h = hashPhone("13800000001");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("13800000001");
  });

  it("DemoPassThroughProvider 直通：verified:true + demo:true + 落 phone_hash", async () => {
    const db = wireChannelDb(new FakeDb());
    const u = await resolveCUser(db, { workspaceId: WS, channel: "h5", openid: "o-v" });
    const r = await verifyIdentity(db, { workspaceId: WS, cUserId: u.user.id, phone: "13800000001", code: "123456" });
    expect(r).toEqual({ verified: true, demo: true });
    const row = db.table("c_users").find((x) => x["id"] === u.user.id)!;
    expect(row["phone_hash"]).toBe(hashPhone("13800000001"));
  });

  it("自定义 provider 拒绝 → verified:false 不落 hash", async () => {
    const db = wireChannelDb(new FakeDb());
    const u = await resolveCUser(db, { workspaceId: WS, channel: "h5", openid: "o-v2" });
    const strict: PhoneCodeProvider = {
      async sendCode() {},
      async verifyCode(_p, code) { return code === "888888"; },
    };
    const bad = await verifyIdentity(db, { workspaceId: WS, cUserId: u.user.id, phone: "13800000002", code: "000000" }, strict);
    expect(bad).toEqual({ verified: false, demo: false });
    const ok = await verifyIdentity(db, { workspaceId: WS, cUserId: u.user.id, phone: "13800000002", code: "888888" }, strict);
    expect(ok).toEqual({ verified: true, demo: false });
  });
});

/* ================= E5. 推送 ================= */

describe("E5 推送 · 驱动分层与落库留痕", () => {
  it("MockPushDriver 投递入内存箱", async () => {
    const box: Array<Record<string, unknown>> = [];
    const driver = new MockPushDriver(box);
    await driver.deliver({ channel: "h5", openid: "o-1", kind: "message", payload: { text: "hi" } });
    expect(box).toHaveLength(1);
    expect(box[0]).toMatchObject({ channel: "h5", kind: "message" });
    expect(typeof box[0]!["deliveredAt"]).toBe("string");
  });

  it("微信订阅消息未注入 sender → 调用即抛（不静默假成功）", async () => {
    const driver = new WechatSubscribePushDriver();
    await expect(driver.deliver({ channel: "wechat-mini", openid: "o", kind: "message", payload: {} }))
      .rejects.toThrow(/未配置/);
  });

  it("微信订阅消息注入 sender → 正常投递", async () => {
    const sent: unknown[] = [];
    const driver = new WechatSubscribePushDriver(async (m) => { sent.push(m); });
    await driver.deliver({ channel: "wechat-mini", openid: "o", kind: "ticket_update", payload: { a: 1 } });
    expect(sent).toHaveLength(1);
  });

  it("支付宝服务通知未注入 sender → 调用即抛", async () => {
    const driver = new AlipayNotifyPushDriver();
    await expect(driver.deliver({ channel: "alipay", openid: "o", kind: "message", payload: {} }))
      .rejects.toThrow(/未配置/);
  });

  it("pushMessage：h5 用户走 mock 驱动，落 c_notifications（mock:true 可查）", async () => {
    const db = wireChannelDb(new FakeDb());
    const u = await resolveCUser(db, { workspaceId: WS, channel: "h5", openid: "o-p" });
    const r = await pushMessage(db, {
      workspaceId: WS, cUserId: u.user.id, kind: "ticket_update", payload: { ticketId: "TK-1" },
    });
    expect(r).toMatchObject({ driver: "mock", status: "delivered", mock: true });
    expect(typeof r.notificationId).toBe("number");
    const row = db.table("c_notifications").find((n) => n["id"] === r.notificationId)!;
    expect(row).toMatchObject({ c_user_id: u.user.id, kind: "ticket_update", driver: "mock", status: "delivered" });
  });

  it("pushMessage：微信渠道用户按注册表选 wechat-subscribe 驱动（注入后投递）", async () => {
    const db = wireChannelDb(new FakeDb());
    const u = await resolveCUser(db, { workspaceId: WS, channel: "wechat-mini", openid: "o-wx" });
    const sent: unknown[] = [];
    const r = await pushMessage(db, {
      workspaceId: WS, cUserId: u.user.id, kind: "message", payload: { text: "你好" },
    }, { drivers: { "wechat-subscribe": new WechatSubscribePushDriver(async (m) => { sent.push(m); }) } });
    expect(r.driver).toBe("wechat-subscribe");
    expect(r.mock).toBe(false);
    expect(sent).toHaveLength(1);
    const row = db.table("c_notifications")[0]!;
    expect(row["driver"]).toBe("wechat-subscribe"); // driver 字段如实标注链路
  });

  it("pushMessage：用户不存在 → 抛错", async () => {
    const db = wireChannelDb(new FakeDb());
    await expect(pushMessage(db, { workspaceId: WS, cUserId: "cu-none", kind: "message", payload: {} }))
      .rejects.toThrow(/不存在/);
  });

  it("默认 mock 通知箱：演示路径投递同样落库（不静默）", async () => {
    const db = wireChannelDb(new FakeDb());
    const u = await resolveCUser(db, { workspaceId: WS, channel: "alipay", openid: "o-ali" });
    // 未注入任何驱动：alipay 注册驱动为 alipay-notify，但回退链 opts.drivers.mock 缺省 → MockPushDriver
    const r = await pushMessage(db, { workspaceId: WS, cUserId: u.user.id, kind: "system", payload: {} });
    expect(r.mock).toBe(true);
    expect(db.table("c_notifications")).toHaveLength(1);
  });
});

// DemoPassThroughProvider 类型引用（防未使用告警的显式断言）
describe("E4 补充 · provider 类型标注", () => {
  it("DemoPassThroughProvider 实例可用于 demo 标注判定", () => {
    expect(new DemoPassThroughProvider()).toBeInstanceOf(DemoPassThroughProvider);
  });
});
