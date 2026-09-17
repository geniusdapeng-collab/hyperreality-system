/**
 * accounts/kdf —— 口令散列（scrypt，Node 内置 crypto 零依赖）
 * 格式：scrypt:N:r:p:salt(b64):hash(b64)。参数对齐 OWASP 推荐基线（N=16384,r=8,p=1）。
 * 说明：PRD 口径为 argon2id；自包含安装包要求零原生依赖（argon2 需编译），
 * 采用同等强度的 scrypt——KDF 可插拔，未来如需 argon2id 只换本文件。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384, R = 8, P = 1, KEYLEN = 64;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt:${N}:${R}:${P}:${salt.toString("base64")}:${h.toString("base64")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  try {
    const [algo, n, r, p, saltB64, hashB64] = stored.split(":");
    if (algo !== "scrypt") return false;
    const salt = Buffer.from(saltB64!, "base64");
    const expect = Buffer.from(hashB64!, "base64");
    const h = scryptSync(plain, salt, expect.length, { N: Number(n), r: Number(r), p: Number(p) });
    return timingSafeEqual(h, expect);
  } catch {
    return false;
  }
}

/** 短码散列（验证码/邀请码/PIN/refresh token）：sha256 + 应用级盐即可（码本身高熵或短时效） */
export function hashSecret(secret: string, salt = ""): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(`wl-accounts:${salt}:${secret}`).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}
