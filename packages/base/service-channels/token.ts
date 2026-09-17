/**
 * service-channels · C 端会话令牌（HMAC JWT，jose HS256）
 * payload {workspaceId, cUserId, channel, scope:'c'}，过期 7d；secret 注入（不入库不硬编码）。
 * scope 固定 'c'：C 端令牌与 B 端成员令牌（tenancy/auth.ts）互不相认。
 */
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { assertChannel, type Channel } from "./channels.js";

export const C_TOKEN_TTL = "7d";
export const C_TOKEN_SCOPE = "c" as const;

export interface CTokenPayload {
  workspaceId: string;
  cUserId: string;
  channel: Channel;
  scope: typeof C_TOKEN_SCOPE;
}

export class CTokenError extends Error {
  constructor(
    public readonly code: "EXPIRED" | "INVALID" | "BAD_SCOPE",
    message: string,
  ) {
    super(message);
    this.name = "CTokenError";
  }
}

function keyOf(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function issueCToken(
  secret: string,
  payload: Omit<CTokenPayload, "scope">,
  ttl: string = C_TOKEN_TTL,
): Promise<string> {
  assertChannel(payload.channel);
  return new SignJWT({
    workspaceId: payload.workspaceId,
    cUserId: payload.cUserId,
    channel: payload.channel,
    scope: C_TOKEN_SCOPE,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(keyOf(secret));
}

export async function verifyCToken(secret: string, token: string): Promise<CTokenPayload> {
  let payload: Record<string, unknown>;
  try {
    const r = await jwtVerify(token, keyOf(secret));
    payload = r.payload as Record<string, unknown>;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new CTokenError("EXPIRED", "C 端令牌已过期（7d），请重新进入小程序");
    }
    throw new CTokenError("INVALID", `C 端令牌校验失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (payload["scope"] !== C_TOKEN_SCOPE) {
    throw new CTokenError("BAD_SCOPE", `令牌 scope 不符（期望 '${C_TOKEN_SCOPE}'，拒绝 B 端令牌混用）`);
  }
  const channel = String(payload["channel"]);
  assertChannel(channel);
  return {
    workspaceId: String(payload["workspaceId"]),
    cUserId: String(payload["cUserId"]),
    channel,
    scope: C_TOKEN_SCOPE,
  };
}
