/**
 * service-channels · 身份核验（verifyIdentity）
 * 手机号验证码接口预留（PhoneCodeProvider seam，真实短信网关由 server 层注入）；
 * 内置 DemoPassThroughProvider 演示直通。核验通过回填 phone_hash（sha256，不落明文）。
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../service-kb/kb.js";

/** 验证码服务 seam（真实短信网关预留位） */
export interface PhoneCodeProvider {
  sendCode(phone: string): Promise<void>;
  verifyCode(phone: string, code: string): Promise<boolean>;
}

/** 演示直通（无短信网关时全链路可跑；输出标注 demo:true） */
export class DemoPassThroughProvider implements PhoneCodeProvider {
  async sendCode(): Promise<void> { /* 演示直通：不发短信 */ }
  async verifyCode(): Promise<boolean> { return true; }
}

export function hashPhone(phone: string): string {
  return createHash("sha256").update(phone, "utf-8").digest("hex");
}

export async function verifyIdentity(
  db: Queryable,
  input: { workspaceId: string; cUserId: string; phone: string; code: string },
  provider: PhoneCodeProvider = new DemoPassThroughProvider(),
): Promise<{ verified: boolean; demo: boolean }> {
  const ok = await provider.verifyCode(input.phone, input.code);
  if (!ok) return { verified: false, demo: provider instanceof DemoPassThroughProvider };
  await db.query(
    `UPDATE c_users SET phone_hash=$3 WHERE id=$1 AND workspace_id=$2`,
    [input.cUserId, input.workspaceId, hashPhone(input.phone)],
  );
  return { verified: true, demo: provider instanceof DemoPassThroughProvider };
}
