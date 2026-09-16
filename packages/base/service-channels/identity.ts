/**
 * service-channels · 身份核验（verifyIdentity）
 * 手机号验证码接口预留（PhoneCodeProvider seam，真实短信网关由 server 层注入）；
 * 默认 provider 明确 fail closed；演示方必须显式注入 DemoPassThroughProvider。
 * 核验通过回填 phone_hash（sha256，不落明文）。
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../service-kb/kb.js";

/** 验证码服务 seam（真实短信网关预留位） */
export interface PhoneCodeProvider {
  sendCode(phone: string): Promise<void>;
  verifyCode(phone: string, code: string): Promise<boolean>;
}

/** 未装配真实身份服务时的安全默认值：调用即失败，不隐式进入演示核验。 */
export class UnconfiguredPhoneCodeProvider implements PhoneCodeProvider {
  async sendCode(): Promise<void> {
    throw new Error("手机号身份核验服务未配置");
  }
  async verifyCode(): Promise<boolean> {
    throw new Error("手机号身份核验服务未配置");
  }
}

/** 演示核验（不发短信；仅接受显式演示码，输出标注 demo:true） */
export class DemoPassThroughProvider implements PhoneCodeProvider {
  constructor(private readonly demoCode = "123456") {}
  async sendCode(): Promise<void> { /* 演示直通：不发短信 */ }
  async verifyCode(_phone: string, code: string): Promise<boolean> { return code === this.demoCode; }
}

export function hashPhone(phone: string): string {
  return createHash("sha256").update(phone, "utf-8").digest("hex");
}

export async function verifyIdentity(
  db: Queryable,
  input: { workspaceId: string; cUserId: string; phone: string; code: string },
  provider: PhoneCodeProvider = new UnconfiguredPhoneCodeProvider(),
): Promise<{ verified: boolean; demo: boolean }> {
  const ok = await provider.verifyCode(input.phone, input.code);
  if (!ok) return { verified: false, demo: provider instanceof DemoPassThroughProvider };
  await db.query(
    `UPDATE c_users SET phone_hash=$3 WHERE id=$1 AND workspace_id=$2`,
    [input.cUserId, input.workspaceId, hashPhone(input.phone)],
  );
  return { verified: true, demo: provider instanceof DemoPassThroughProvider };
}
