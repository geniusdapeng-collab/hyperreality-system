/**
 * service · C 端通道（接口对齐 packages/base/service-channels 签名）
 *  - resolveCUser：三渠道 openid → c_user（幂等 upsert）
 *  - issueCToken / verifyCToken：C 端会话 JWT（HS256，密钥 env SERVICE_C_SECRET，缺省开发占位）
 *  - pushMessage：统一推送箱（落 c_notifications；driver=mock 无真实通道时响应带 mock:true，与 LLM/IM 同纪律）
 *  - verifyIdentity：手机号验证占位（演示口径：6 位数字码即过，落 phone_hash 不落明文；真实短信网关进停车场）
 * 全部读写经 svcQuery/serviceTx（RLS 事务上下文，L7.1）。
 */
import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { ensureServiceSchema } from "./store.js";
import { serviceTx, svcQuery } from "./events.js";

export const CHANNELS = ["wechat-mini", "alipay", "h5"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface CUser {
  id: string;
  workspaceId: string;
  channel: Channel;
  openid: string;
  nickname: string | null;
  memberId: string | null;
  verified: boolean;
  createdAt: string;
}

export interface CTokenPayload {
  workspaceId: string;
  cUserId: string;
  channel: Channel;
  scope: "c-user";
}

const DEV_C_SECRET = "workloom-c-dev-secret-change-me";

let secretWarned = false;

/** C 端 JWT 密钥：生产缺失即抛错（S3）；<32 字符启动告警一次 */
export function cSecret(): string {
  const s = process.env.SERVICE_C_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("生产环境必须配置 SERVICE_C_SECRET（拒绝使用开发占位密钥）");
    }
    return DEV_C_SECRET;
  }
  if (s.length < 32 && !secretWarned) {
    secretWarned = true;
    console.warn("[service-c] SERVICE_C_SECRET 长度不足 32 字符，请更换为高强度随机密钥");
  }
  return s;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

let seq = 0;
function newId(prefix: string): string {
  seq = (seq + 1) % 46656;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36).padStart(3, "0")}${Math.random().toString(36).slice(2, 6)}`;
}

interface CUserRow extends Record<string, unknown> {
  id: string; workspace_id: string; channel: string; openid: string;
  nickname: string | null; member_id: string | null; phone_hash: string | null;
  created_at: string;
}

function toCUser(r: CUserRow): CUser {
  return {
    id: r.id, workspaceId: r.workspace_id, channel: r.channel as Channel, openid: r.openid,
    nickname: r.nickname, memberId: r.member_id, verified: !!r.phone_hash,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function resolveCUser(input: {
  workspaceId: string; channel: Channel; openid: string; nickname?: string;
}): Promise<CUser> {
  await ensureServiceSchema();
  const rows = await serviceTx(input.workspaceId, async (client) => {
    const r = await client.query(
      `INSERT INTO c_users (id, workspace_id, channel, openid, nickname)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (workspace_id, channel, openid)
       DO UPDATE SET nickname = COALESCE(EXCLUDED.nickname, c_users.nickname)
       RETURNING *`,
      [newId("cu"), input.workspaceId, input.channel, input.openid, input.nickname ?? null],
    );
    return r.rows as CUserRow[];
  });
  return toCUser(rows[0]!);
}

export async function getCUser(workspaceId: string, cUserId: string): Promise<CUser | null> {
  await ensureServiceSchema();
  const rows = await svcQuery<CUserRow>(
    workspaceId, `SELECT * FROM c_users WHERE workspace_id=$1 AND id=$2`, [workspaceId, cUserId],
  );
  return rows[0] ? toCUser(rows[0]) : null;
}

export async function issueCToken(input: {
  workspaceId: string; cUserId: string; channel: Channel; secret: string;
}): Promise<string> {
  return new SignJWT({ workspaceId: input.workspaceId, cUserId: input.cUserId, channel: input.channel, scope: "c-user" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("workloom-c")
    .setExpirationTime("7d")
    .sign(key(input.secret));
}

export async function verifyCToken(token: string, secret: string): Promise<CTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { issuer: "workloom-c" });
    if (payload.scope !== "c-user") return null;
    return {
      workspaceId: String(payload.workspaceId),
      cUserId: String(payload.cUserId),
      channel: payload.channel as Channel,
      scope: "c-user",
    };
  } catch {
    return null;
  }
}

/** 统一推送箱：落 c_notifications 供 C 端拉取；无真实通道驱动 → driver=mock + mock:true */
export async function pushMessage(input: {
  workspaceId: string; cUserId: string; kind: string; payload: Record<string, unknown>;
}): Promise<{ delivered: boolean; mock?: boolean }> {
  await ensureServiceSchema();
  const user = await getCUser(input.workspaceId, input.cUserId);
  await svcQuery(
    input.workspaceId,
    `INSERT INTO c_notifications (workspace_id, c_user_id, channel, kind, payload, driver, status)
     VALUES ($1,$2,$3,$4,$5,'mock','delivered') RETURNING id`,
    [input.workspaceId, input.cUserId, user?.channel ?? "h5", input.kind, JSON.stringify(input.payload)],
  );
  return { delivered: true, mock: true };
}

export async function listNotifications(input: {
  workspaceId: string; cUserId: string; limit?: number;
}): Promise<Array<{ id: string; kind: string; payload: Record<string, unknown>; createdAt: string; read: boolean }>> {
  await ensureServiceSchema();
  const rows = await svcQuery<{ id: number; kind: string; payload: Record<string, unknown>; created_at: string }>(
    input.workspaceId,
    `SELECT id, kind, payload, created_at FROM c_notifications
     WHERE workspace_id=$1 AND c_user_id=$2 ORDER BY id DESC LIMIT $3`,
    [input.workspaceId, input.cUserId, input.limit ?? 50],
  );
  // read 占位（H6 契约：底座表暂无已读列，C 端一律 false 未读样式）
  return rows.map((x) => ({ id: String(x.id), kind: x.kind, payload: x.payload, createdAt: new Date(x.created_at).toISOString(), read: false }));
}

/**
 * 渠道 code → openid 交换 seam（S2：wechat-mini / alipay 服务端换登）
 * 凭据经 env 配置（SERVICE_C_WECHAT_APPID/SECRET、SERVICE_C_ALIPAY_APPID/KEY）；
 * 未配置 → {ok:false, reason}，网关返回 503「渠道未配置」（明确报错，不回退 openid 直登）。
 */
export async function exchangeCodeForOpenid(
  channel: Channel,
  code: string,
): Promise<{ ok: true; openid: string } | { ok: false; reason: string }> {
  if (channel === "wechat-mini") {
    const appid = process.env.SERVICE_C_WECHAT_APPID;
    const secret = process.env.SERVICE_C_WECHAT_SECRET;
    if (!appid || !secret) return { ok: false, reason: "缺少 SERVICE_C_WECHAT_APPID/SECRET" };
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const data = (await res.json()) as { openid?: string; errcode?: number; errmsg?: string };
    if (!data.openid) return { ok: false, reason: `微信换登失败：${data.errmsg ?? `errcode=${data.errcode}`}` };
    return { ok: true, openid: data.openid };
  }
  if (channel === "alipay") {
    const appid = process.env.SERVICE_C_ALIPAY_APPID;
    const key = process.env.SERVICE_C_ALIPAY_KEY;
    if (!appid || !key) return { ok: false, reason: "缺少 SERVICE_C_ALIPAY_APPID/KEY" };
    // 支付宝 oauth token 交换需服务端签名 SDK，演示环境未接入：明确报渠道未配置
    return { ok: false, reason: "alipay 换登链路待接入（签名 SDK 未装配）" };
  }
  return { ok: false, reason: `channel ${channel} 不支持 code 交换` };
}

/** 身份验证占位（演示：6 位数字码即通过；只落 phone_hash 不落明文，L6.2 同纪律） */
export async function verifyIdentity(input: {
  workspaceId: string; cUserId: string; phone: string; code?: string;
}): Promise<{ verified: boolean }> {
  await ensureServiceSchema();
  const ok = !!input.code && /^\d{6}$/.test(input.code);
  if (ok) {
    const hash = createHash("sha256").update(input.phone).digest("hex");
    await svcQuery(
      input.workspaceId,
      `UPDATE c_users SET phone_hash=$3 WHERE workspace_id=$1 AND id=$2 RETURNING id`,
      [input.workspaceId, input.cUserId, hash],
    );
  }
  return { verified: ok };
}
