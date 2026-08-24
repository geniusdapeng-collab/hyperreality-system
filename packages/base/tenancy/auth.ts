/**
 * tenancy · 演示身份 JWT（B5；F5.6 三端权限一致的身份载体）
 * 演示口径（总纲 §2.4）：登录页选择种子成员（陈主理/林运营/赵剪辑）签发 JWT。
 * 真实企业 IdP 对接进停车场；签名密钥 JWT_SECRET（.env），缺省为开发占位（README 已警）。
 */
import { SignJWT, jwtVerify } from "jose";
import type { MemberRole, PlanTier } from "@workloom/shared";

export interface Identity {
  memberId: string;
  memberNo: string;
  name: string;
  role: MemberRole;
  tenantId: string;
  workspaceId: string;
  plan: PlanTier;
}

const DEV_SECRET = "hyperreality-dev-secret-change-me";

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

/** 签发演示 JWT（24h，对齐审批超时口径 G6 的一天会话） */
export async function signDemoToken(identity: Identity): Promise<string> {
  return new SignJWT({ ...identity })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("hyperreality-im")
    .setExpirationTime("24h")
    .sign(key());
}

/** 校验并还原身份；失败返回 null（调用方按 401 处理） */
export async function verifyToken(token: string): Promise<Identity | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { issuer: "hyperreality-im" });
    return {
      memberId: String(payload.memberId),
      memberNo: String(payload.memberNo),
      name: String(payload.name),
      role: payload.role as MemberRole,
      tenantId: String(payload.tenantId),
      workspaceId: String(payload.workspaceId),
      plan: payload.plan as PlanTier,
    };
  } catch {
    return null;
  }
}
