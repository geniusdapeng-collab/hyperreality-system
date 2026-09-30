/**
 * service · C 端通道（接口对齐 packages/base/service-channels 签名）
 *  - resolveCUser：三渠道 openid → c_user（幂等 upsert）
 *  - issueCToken / verifyCToken：C 端会话 JWT（HS256，密钥 env SERVICE_C_SECRET，缺省开发占位）
 *  - pushMessage：统一推送箱（落 c_notifications；mock 只标演示待投递，不伪装真实送达）
 * 全部读写经 svcQuery/serviceTx（RLS 事务上下文，L7.1）。
 */
import { SignJWT, jwtVerify } from "jose";
import { ensureServiceSchema } from "./store.js";
import { serviceTx, svcQuery } from "./events.js";

export const CHANNELS = ["wechat-mini", "alipay", "h5"] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * S2/MC-207：演示直登（h5/openid 匿名会话）开关解析——网关与发布就绪度共用同一口径，
 * 避免出现「发布页说演示中、网关却拒绝登录」的两种事实。
 *  - 开发档：缺省开启（显式 SERVICE_C_DEMO_AUTH=false 可关闭）；
 *  - 生产档（含桌面自包含运行时 NODE_ENV=production）：一律关闭——出厂/历史 .env 里的 `true`
 *    不再能打开匿名直登（启动自检在 gateway.ts 打出显式告警）；正式 H5 只认
 *    SERVICE_C_H5_ENTRY_SECRET + 身份网关签发的短期 entry_token。
 */
export function resolveDemoAuth(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NODE_ENV === "production") return false;
  return (env.SERVICE_C_DEMO_AUTH ?? "true") === "true";
}

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

/**
 * 正式 H5 入口由租户的受信身份网关签发。workspaceKey 与自然人 subject
 * 都来自签名声明，客户端提交的同名字段只用于一致性校验，不能决定租户或身份。
 */
export interface H5EntryPayload {
  workspaceKey: string;
  subject: string;
  appId: string;
  scope: "c-entry";
}

const DEV_C_SECRET = "workloom-c-dev-secret-change-me";

let secretWarned = false;
let h5SecretWarned = false;

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

/** 正式 H5 入口使用独立密钥；不与 C 会话 JWT 共钥，便于单独轮换和吊销。 */
export function h5EntrySecret(): string | null {
  const secret = process.env.SERVICE_C_H5_ENTRY_SECRET?.trim();
  if (!secret) return null;
  if (secret.length < 32) {
    if (process.env.NODE_ENV === "production") return null;
    if (!h5SecretWarned) {
      h5SecretWarned = true;
      console.warn("[service-c] SERVICE_C_H5_ENTRY_SECRET 长度不足 32 字符，仅可用于本地验证");
    }
  }
  return secret;
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
    .setExpirationTime("12h")
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

/**
 * 供受信身份网关/部署工具签发短期 H5 入口凭据。生产页面本身不得暴露此能力或密钥。
 */
export async function issueH5EntryToken(input: {
  workspaceKey: string;
  subject: string;
  appId: string;
  secret: string;
  expiresIn?: string | number;
}): Promise<string> {
  if (!input.workspaceKey.trim() || !input.subject.trim() || !input.appId.trim()) {
    throw new Error("H5 入口签名缺少工作区、身份主体或应用标识");
  }
  return new SignJWT({
    workspaceKey: input.workspaceKey.trim(),
    subject: input.subject.trim(),
    appId: input.appId.trim(),
    scope: "c-entry",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("workloom-c-entry")
    .setAudience("workloom-c-h5")
    .setExpirationTime(input.expiresIn ?? "15m")
    .sign(key(input.secret));
}

export async function verifyH5EntryToken(token: string, secret: string): Promise<H5EntryPayload | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      issuer: "workloom-c-entry",
      audience: "workloom-c-h5",
    });
    if (payload.scope !== "c-entry") return null;
    const workspaceKey = typeof payload.workspaceKey === "string" ? payload.workspaceKey.trim() : "";
    const subject = typeof payload.subject === "string" ? payload.subject.trim() : "";
    const appId = typeof payload.appId === "string" ? payload.appId.trim() : "";
    if (!workspaceKey || !subject || !appId || workspaceKey.length > 160 || subject.length > 240 || appId.length > 120) {
      return null;
    }
    return { workspaceKey, subject, appId, scope: "c-entry" };
  } catch {
    return null;
  }
}

export interface PushReceipt {
  delivered: boolean;
  mock: boolean;
  state: "demo" | "pending" | "sent";
  notificationId: string;
}

/** 统一推送箱：无真实通道驱动时落 pending，并明确返回 demo；不得标记 delivered。 */
export async function pushMessage(input: {
  workspaceId: string; cUserId: string; kind: string; payload: Record<string, unknown>;
}): Promise<PushReceipt> {
  await ensureServiceSchema();
  const user = await getCUser(input.workspaceId, input.cUserId);
  const rows = await svcQuery<{ id: number }>(
    input.workspaceId,
    `INSERT INTO c_notifications (workspace_id, c_user_id, channel, kind, payload, driver, status)
     VALUES ($1,$2,$3,$4,$5,'mock','pending') RETURNING id`,
    [input.workspaceId, input.cUserId, user?.channel ?? "h5", input.kind, JSON.stringify(input.payload)],
  );
  return { delivered: false, mock: true, state: "demo", notificationId: String(rows[0]?.id ?? "") };
}

export async function listNotifications(input: {
  workspaceId: string; cUserId: string; limit?: number;
}): Promise<Array<{
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  read: boolean;
  deliveryState: "demo" | "pending" | "failed" | "sent";
}>> {
  await ensureServiceSchema();
  const rows = await svcQuery<{
    id: number; kind: string; payload: Record<string, unknown>; driver: string; status: string; created_at: string;
  }>(
    input.workspaceId,
    `SELECT id, kind, payload, driver, status, created_at FROM c_notifications
     WHERE workspace_id=$1 AND c_user_id=$2 ORDER BY id DESC LIMIT $3`,
    [input.workspaceId, input.cUserId, input.limit ?? 50],
  );
  // read 占位（H6 契约：底座表暂无已读列，C 端一律 false 未读样式）
  return rows.map((x) => ({
    id: String(x.id),
    kind: x.kind,
    payload: x.payload,
    createdAt: new Date(x.created_at).toISOString(),
    read: false,
    deliveryState: notificationDeliveryState(x.driver, x.status),
  }));
}

export function notificationDeliveryState(
  driver: string,
  status: string,
): "demo" | "pending" | "failed" | "sent" {
  if (status === "failed") return "failed";
  if (driver === "mock") return "demo";
  if (status === "delivered") return "sent";
  return "pending";
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

/**
 * @deprecated 旧占位能力不再接受任意六位码。身份绑定请走网关 /identity/*，
 * 由渠道验证器确认后再绑定会员；保留此签名只为兼容调用方并始终 fail closed。
 */
export async function verifyIdentity(input: {
  workspaceId: string; cUserId: string; phone: string; code?: string;
}): Promise<{ verified: false; reason: string }> {
  void input;
  return { verified: false, reason: "请使用已配置的身份验证渠道" };
}
