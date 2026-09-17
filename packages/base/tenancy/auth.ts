/**
 * tenancy · 演示身份 JWT（B5；F5.6 三端权限一致的身份载体）
 * 演示口径（总纲 §2.4）：登录页选择种子成员（王店长/李前台/陈经理）签发 JWT。
 * 真实企业 IdP 对接进停车场；签名密钥 JWT_SECRET（.env），缺省为开发占位（README 已警）。
 */
import { SignJWT, jwtVerify } from "jose";
import type { MemberRole, PlanTier } from "@workloom/shared";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Identity {
  /** 旧演示令牌没有 kind；校验后会统一补成 member。 */
  kind?: "member";
  memberId: string;
  memberNo: string;
  name: string;
  role: MemberRole;
  tenantId: string;
  workspaceId: string;
  plan: PlanTier;
}

/** 伙伴令牌与成员令牌严格分域，不能被普通 protectedProcedure 当作成员消费。 */
export interface PartnerSessionIdentity {
  kind: "partner";
  partnerId: string;
  contactAccountId: string;
  name: string;
  grants: Array<{ grantId: string; tenantId: string; workspaces: string[]; capabilities: string[] }>;
}

export type SessionIdentity = Identity | PartnerSessionIdentity;

const DEV_SECRET = "workloom-dev-secret-change-me";
const DEFAULT_ISSUER = "workloom-im";

// 生产启动强校验（模块加载即生效）：缺 JWT_SECRET 直接抛错拒启，不回落开发占位密钥
if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  throw new Error("生产环境（NODE_ENV=production）必须配置 JWT_SECRET（见 .env.example），拒绝回落开发占位密钥");
}
// 弱密钥告警（一次性）：<32 字符熵不足，暴力可枚举
const _secret = process.env.JWT_SECRET ?? DEV_SECRET;
if (_secret.length < 32) {
  console.warn("[auth] JWT_SECRET 长度 <32 字符，熵不足——生产环境请配置 ≥32 字符随机密钥");
}

function key(): Uint8Array {
  return new TextEncoder().encode(process.env.JWT_SECRET ?? DEV_SECRET);
}

/**
 * 签发方属于部署身份，不属于可分叉的认证实现。默认从受保护产品清单派生；
 * 运维可以显式覆盖，但非法值直接失败，避免签发和校验端各自猜测。
 */
function productManifestIssuer(start = process.cwd()): string | null {
  let directory = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const file = join(directory, "product.manifest.json");
    if (existsSync(file)) {
      let productId: unknown;
      try {
        productId = (JSON.parse(readFileSync(file, "utf8")) as { productId?: unknown }).productId;
      } catch {
        throw new Error("product.manifest.json 无法解析，已拒绝确定会话签发方");
      }
      if (typeof productId !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(productId)) {
        throw new Error("product.manifest.json 缺少有效产品标识，已拒绝确定会话签发方");
      }
      return productId;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

export function sessionTokenIssuer(): string {
  const configured = process.env.JWT_ISSUER?.trim();
  const value = configured || productManifestIssuer()
    || (process.env.NODE_ENV === "production" ? "" : DEFAULT_ISSUER);
  if (!value) throw new Error("生产环境必须提供受保护的 product.manifest.json 或 JWT_ISSUER");
  if (!/^[a-z0-9][a-z0-9.-]{1,79}$/.test(value)) {
    throw new Error("JWT_ISSUER 必须是稳定的小写产品标识");
  }
  return value;
}

/** 签发演示 JWT（24h，对齐审批超时口径 G6 的一天会话） */
export async function signDemoToken(identity: Identity): Promise<string> {
  return new SignJWT({ ...identity, kind: "member" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(sessionTokenIssuer())
    .setExpirationTime("24h")
    .sign(key());
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function memberIdentity(payload: Record<string, unknown>): Identity | null {
  const memberId = stringClaim(payload.memberId);
  const memberNo = stringClaim(payload.memberNo);
  const name = stringClaim(payload.name);
  const tenantId = stringClaim(payload.tenantId);
  const workspaceId = stringClaim(payload.workspaceId);
  const roles = new Set<MemberRole>(["owner", "manager", "staff", "readonly", "group", "channel"]);
  const plans = new Set<PlanTier>(["community", "pro", "teams", "vpc"]);
  if (!memberId || !memberNo || !name || !tenantId || !workspaceId
    || !roles.has(payload.role as MemberRole) || !plans.has(payload.plan as PlanTier)) return null;
  return {
    kind: "member",
    memberId,
    memberNo,
    name,
    role: payload.role as MemberRole,
    tenantId,
    workspaceId,
    plan: payload.plan as PlanTier,
  };
}

function partnerIdentity(payload: Record<string, unknown>): PartnerSessionIdentity | null {
  const partnerId = stringClaim(payload.partnerId);
  const contactAccountId = stringClaim(payload.contactAccountId);
  const name = stringClaim(payload.name);
  if (!partnerId || !contactAccountId || !name || !Array.isArray(payload.grants)) return null;
  const grants: PartnerSessionIdentity["grants"] = [];
  for (const raw of payload.grants) {
    if (!raw || typeof raw !== "object") return null;
    const grant = raw as Record<string, unknown>;
    const grantId = stringClaim(grant.grantId);
    const tenantId = stringClaim(grant.tenantId);
    if (!grantId || !tenantId || !Array.isArray(grant.workspaces) || !Array.isArray(grant.capabilities)
      || !grant.workspaces.every((item) => typeof item === "string")
      || !grant.capabilities.every((item) => typeof item === "string")) return null;
    grants.push({
      grantId,
      tenantId,
      workspaces: grant.workspaces as string[],
      capabilities: grant.capabilities as string[],
    });
  }
  return { kind: "partner", partnerId, contactAccountId, name, grants };
}

/** 验签后按 kind 严格解析会话；未知/缺字段载荷一律失败关闭。 */
export async function verifySessionToken(token: string): Promise<SessionIdentity | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { issuer: sessionTokenIssuer() });
    const record = payload as Record<string, unknown>;
    if (record.kind === "partner") return partnerIdentity(record);
    if (record.kind !== undefined && record.kind !== "member") return null;
    return memberIdentity(record);
  } catch {
    return null;
  }
}

/** 校验并还原身份；失败返回 null（调用方按 401 处理） */
export async function verifyToken(token: string): Promise<Identity | null> {
  const session = await verifySessionToken(token);
  return session?.kind === "partner" ? null : session;
}
