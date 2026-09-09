/**
 * accounts/tokens —— 双令牌：2h access（JWT，Identity claims 与演示令牌同构零改动消费）
 * + 30d refresh（高熵随机串，散列入库，旋转签发，可单设备踢出/全员下线）。
 */
import { SignJWT } from "jose";
import type { Identity } from "../tenancy/auth.js";
import { hashSecret, randomToken } from "./kdf.js";

const DEV_SECRET = "workloom-dev-secret-change-me";
function key(): Uint8Array {
  return new TextEncoder().encode(process.env.JWT_SECRET ?? DEV_SECRET);
}

export const ACCESS_TTL_SEC = 2 * 3600;
export const REFRESH_TTL_DAYS = 30;

/** 签发访问令牌（claims 与演示 JWT 完全同构：memberId/memberNo/name/role/tenantId/workspaceId/plan） */
export async function signAccessToken(identity: Identity, ttlSec = ACCESS_TTL_SEC): Promise<string> {
  return new SignJWT({ ...identity, kind: "member" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("workloom-im")
    .setExpirationTime(`${ttlSec}s`)
    .sign(key());
}

/** 伙伴域访问令牌（独立 claims：kind=partner，权限=授权清单快照，验收时实时回查 grant 状态） */
export interface PartnerIdentity {
  kind: "partner";
  partnerId: string;
  contactAccountId: string;
  name: string;
  grants: Array<{ grantId: string; tenantId: string; workspaces: string[]; capabilities: string[] }>;
}
export async function signPartnerToken(p: PartnerIdentity, ttlSec = ACCESS_TTL_SEC): Promise<string> {
  return new SignJWT({ ...p })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("workloom-im")
    .setExpirationTime(`${ttlSec}s`)
    .sign(key());
}

/** 新 refresh token（明文只出现一次；入库为散列） */
export function mintRefreshToken(): { plain: string; hash: string } {
  const plain = randomToken(32);
  return { plain, hash: hashSecret(plain, "refresh") };
}
export function hashRefreshToken(plain: string): string {
  return hashSecret(plain, "refresh");
}
