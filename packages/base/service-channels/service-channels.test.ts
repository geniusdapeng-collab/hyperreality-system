/**
 * service-channels 单测（内存假库隔离 pg）
 * 覆盖：resolveCUser 幂等 upsert / CToken 签发校验（过期/坏签名/scope 隔离）/
 *      pushMessage mock 投递落库可查 + 真实驱动预留 / verifyIdentity 演示直通回填 phone_hash
 */
import { describe, expect, it } from "vitest";
import { assertChannel } from "./channels.js";
import { cUserIdOf, resolveCUser } from "./users.js";
import { CTokenError, issueCToken, verifyCToken } from "./token.js";
import { MockPushDriver, pushMessage, WechatSubscribePushDriver } from "./push.js";
import { hashPhone, verifyIdentity, type PhoneCodeProvider } from "./identity.js";
import { FakeDb, nextSerial } from "../testing/fake-pg.js";

/* ---------- 假库 handler：channels 链路 ---------- */
function wireChannelDb(db: FakeDb): FakeDb {
  const findUser = (d: FakeDb, p: unknown[]) =>
    d.table("c_users").filter((r) =>
      r["workspace_id"] === p[0] && r["channel"] === p[1] && r["openid"] === p[2]);
  db.on(/^SELECT \* FROM c_users WHERE workspace_id=\$1 AND channel=\$2 AND openid=\$3/, (p, d) => ({
    rows: findUser(d, p),
  }));
  db.on(/^UPDATE c_users SET nickname=\$4/, (p, d) => {
    const row = findUser(d, p)[0];
    if (row) row["nickname"] = p[3];
    return { rows: row ? [row] : [] };
  });
  db.on(/^INSERT INTO c_users/, (p, d) => {
    const t = d.table("c_users");
    if (t.some((r) => r["workspace_id"] === p[1] && r["channel"] === p[2] && r["openid"] === p[3])) {
      return { rows: [] }; // ON CONFLICT DO NOTHING
    }
    const row = {
      id: p[0], workspace_id: p[1], channel: p[2], openid: p[3], nickname: p[4],
      member_id: null, phone_hash: null, created_at: new Date().toISOString(),
    };
    t.push(row);
    return { rows: [row] };
  });
  db.on(/^SELECT channel, openid FROM c_users WHERE id=\$1/, (p, d) => ({
    rows: d.table("c_users")
      .filter((r) => r["id"] === p[0] && r["workspace_id"] === p[1])
      .map((r) => ({ channel: r["channel"], openid: r["openid"] })),
  }));
  db.on(/^INSERT INTO c_notifications/, (p, d) => {
    const row = {
      id: nextSerial(d, "c_notifications"), workspace_id: p[0], c_user_id: p[1],
      channel: p[2], kind: p[3], payload: JSON.parse(String(p[4])), driver: p[5],
      status: "delivered", created_at: new Date().toISOString(),
    };
    d.table("c_notifications").push(row);
    return { rows: [{ id: row["id"] }] };
  });
  db.on(/^UPDATE c_users SET phone_hash=\$3/, (p, d) => {
    const row = d.table("c_users").find((r) => r["id"] === p[0] && r["workspace_id"] === p[1]);
    if (row) row["phone_hash"] = p[2];
    return { rows: [] };
  });
  return db;
}

const WS = "ws-test";

/* ================= resolveCUser ================= */

describe("resolveCUser 幂等 upsert", () => {
  it("同渠道同 openid 重复进入返回同一用户；昵称后写覆盖；确定性 id", async () => {
    const db = wireChannelDb(new FakeDb());
    const r1 = await resolveCUser(db, { workspaceId: WS, channel: "wechat-mini", openid: "oABC", nickname: "小明" });
    const r2 = await resolveCUser(db, { workspaceId: WS, channel: "wechat-mini", openid: "oABC" });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.user.id).toBe(r1.user.id);
    expect(r1.user.id).toBe(cUserIdOf(WS, "wechat-mini", "oABC"));
    expect(db.table("c_users").length).toBe(1);
    const r3 = await resolveCUser(db, { workspaceId: WS, channel: "wechat-mini", openid: "oABC", nickname: "小明2" });
    expect(r3.user.nickname).toBe("小明2");
    // 跨渠道同 openid 是不同用户
    const r4 = await resolveCUser(db, { workspaceId: WS, channel: "alipay", openid: "oABC" });
    expect(r4.user.id).not.toBe(r1.user.id);
  });

  it("非法渠道拒绝", async () => {
    expect(() => assertChannel("douyin")).toThrow(/非法渠道/);
    const db = wireChannelDb(new FakeDb());
    await expect(resolveCUser(db, { workspaceId: WS, channel: "douyin", openid: "x" }))
      .rejects.toThrow(/非法渠道/);
  });
});

/* ================= CToken ================= */

describe("issueCToken / verifyCToken（HMAC JWT）", () => {
  const SECRET = "c-secret-test";
  const PAYLOAD = { workspaceId: WS, cUserId: "cu-1", channel: "wechat-mini" as const };

  it("签发→校验闭环，payload 完整", async () => {
    const token = await issueCToken(SECRET, PAYLOAD);
    const payload = await verifyCToken(SECRET, token);
    expect(payload).toEqual({ ...PAYLOAD, scope: "c" });
  });

  it("坏签名 / 错 secret 拒绝", async () => {
    const token = await issueCToken(SECRET, PAYLOAD);
    await expect(verifyCToken("wrong-secret", token)).rejects.toThrow(CTokenError);
    await expect(verifyCToken(SECRET, `${token}x`)).rejects.toThrow(CTokenError);
  });

  it("过期令牌抛 EXPIRED", async () => {
    const token = await issueCToken(SECRET, PAYLOAD, "0s");
    await new Promise((r) => setTimeout(r, 1100));
    await expect(verifyCToken(SECRET, token)).rejects.toMatchObject({ code: "EXPIRED" });
  });

  it("scope 非 'c' 的令牌拒绝（B 端令牌不混用）", async () => {
    const { SignJWT } = await import("jose");
    const bToken = await new SignJWT({ workspaceId: WS, cUserId: "cu-1", channel: "wechat-mini", scope: "b" })
      .setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifyCToken(SECRET, bToken)).rejects.toMatchObject({ code: "BAD_SCOPE" });
  });
});

/* ================= pushMessage ================= */

describe("pushMessage（mock 投递必落库可查）", () => {
  it("mock 驱动：内存通知箱 + c_notifications 落库，driver 如实标注", async () => {
    const db = wireChannelDb(new FakeDb());
    const { user } = await resolveCUser(db, { workspaceId: WS, channel: "h5", openid: "oH5" });
    const box: Array<Record<string, unknown>> = [];
    const mock = new MockPushDriver(box);
    const r = await pushMessage(db, {
      workspaceId: WS, cUserId: user.id, kind: "ticket_update",
      payload: { ticketId: "TK-1", status: "assigned" },
    }, { drivers: { mock } });
    expect(r.mock).toBe(true);
    expect(box.length).toBe(1);
    expect(box[0]).toMatchObject({ kind: "ticket_update", openid: "oH5" });
    const persisted = db.table("c_notifications");
    expect(persisted.length).toBe(1);
    expect(persisted[0]).toMatchObject({ c_user_id: user.id, driver: "mock", kind: "ticket_update" });
  });

  it("微信渠道缺凭据：真实驱动预留位调用即抛（不静默假成功）", async () => {
    const db = wireChannelDb(new FakeDb());
    const { user } = await resolveCUser(db, { workspaceId: WS, channel: "wechat-mini", openid: "oWX" });
    await expect(pushMessage(db, {
      workspaceId: WS, cUserId: user.id, kind: "message", payload: { text: "hi" },
    }, { drivers: { "wechat-subscribe": new WechatSubscribePushDriver() } }))
      .rejects.toThrow(/未配置/);
  });

  it("微信驱动注入 sender 后正常投递并落库", async () => {
    const db = wireChannelDb(new FakeDb());
    const { user } = await resolveCUser(db, { workspaceId: WS, channel: "wechat-mini", openid: "oWX" });
    const sent: unknown[] = [];
    const wx = new WechatSubscribePushDriver(async (m) => { sent.push(m); });
    const r = await pushMessage(db, {
      workspaceId: WS, cUserId: user.id, kind: "message", payload: { text: "hi" },
    }, { drivers: { "wechat-subscribe": wx } });
    expect(r.driver).toBe("wechat-subscribe");
    expect(r.mock).toBe(false);
    expect(sent.length).toBe(1);
    expect(db.table("c_notifications")[0]).toMatchObject({ driver: "wechat-subscribe" });
  });
});

/* ================= verifyIdentity ================= */

describe("verifyIdentity（演示直通 + 预留位）", () => {
  it("演示直通：核验通过回填 phone_hash（不落明文）", async () => {
    const db = wireChannelDb(new FakeDb());
    const { user } = await resolveCUser(db, { workspaceId: WS, channel: "h5", openid: "oH5" });
    const r = await verifyIdentity(db, { workspaceId: WS, cUserId: user.id, phone: "13800001111", code: "123456" });
    expect(r).toEqual({ verified: true, demo: true });
    const row = db.table("c_users")[0]!;
    expect(row["phone_hash"]).toBe(hashPhone("13800001111"));
    expect(String(row["phone_hash"])).not.toContain("13800001111");
  });

  it("真实 provider 校验失败不回填", async () => {
    const db = wireChannelDb(new FakeDb());
    const { user } = await resolveCUser(db, { workspaceId: WS, channel: "h5", openid: "oH5" });
    const bad: PhoneCodeProvider = { async sendCode() {}, async verifyCode() { return false; } };
    const r = await verifyIdentity(db, { workspaceId: WS, cUserId: user.id, phone: "13800001111", code: "000000" }, bad);
    expect(r.verified).toBe(false);
    expect(db.table("c_users")[0]!["phone_hash"]).toBeNull();
  });
});
