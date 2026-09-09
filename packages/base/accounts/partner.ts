/**
 * accounts/partner —— 伙伴域：授权签发/吊销、伙伴登录、能力校验、一次性工单通行证。
 * 纪律：伙伴无 membership；能力只有白名单；吊销即时生效；动作双向留痕。
 */
import type { AccountsDeps, QueryFn } from "./service.js";
import { consumeCode, loginEvent } from "./service.js";
import { newId } from "./kdf.js";
import { mintRefreshToken, hashRefreshToken, signPartnerToken, ACCESS_TTL_SEC, REFRESH_TTL_DAYS, type PartnerIdentity } from "./tokens.js";

export const PARTNER_CAPABILITIES = [
  "ticket.handle",      // 工单处理（agency）
  "ops.execute",        // 日常执行（agency）
  "report.view",        // 经营报表（agency/observer）
  "deliverable.view",   // 交付物查看（observer）
  "workorder.self",     // 仅本人工单（contractor 一次性通行证）
] as const;
export type PartnerCapability = (typeof PARTNER_CAPABILITIES)[number];

/** 客户 owner 签发伙伴授权 */
export async function issueGrant(
  deps: AccountsDeps,
  input: {
    partnerId: string; tenantId: string; workspaces: string[];
    capabilities: PartnerCapability[]; ttlDays: number; issuedBy: string;
    constraints?: Record<string, unknown>;
  },
) {
  const bad = input.capabilities.filter((c) => !(PARTNER_CAPABILITIES as readonly string[]).includes(c));
  if (bad.length > 0) throw new Error(`未知伙伴能力：${bad.join(",")}`);
  const id = newId("grt");
  await deps.q(
    `INSERT INTO partner_grants (id, partner_id, tenant_id, workspaces, capabilities, constraints, issued_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' days')::interval)`,
    [id, input.partnerId, input.tenantId, JSON.stringify(input.workspaces), JSON.stringify(input.capabilities),
     JSON.stringify(input.constraints ?? {}), input.issuedBy, input.ttlDays],
  );
  return { grantId: id };
}

export async function revokeGrant(deps: AccountsDeps, grantId: string, reason: string): Promise<void> {
  await deps.q(`UPDATE partner_grants SET revoked_at=now(), revoke_reason=$2 WHERE id=$1`, [grantId, reason]);
}

export async function listGrantsForTenant(q: QueryFn, tenantId: string) {
  const r = await q(
    `SELECT g.*, p.name AS partner_name, p.type AS partner_type FROM partner_grants g
     JOIN partners p ON p.id=g.partner_id WHERE g.tenant_id=$1 ORDER BY g.issued_at DESC`,
    [tenantId],
  );
  return r.rows;
}

export async function listGrantsForPartner(q: QueryFn, partnerId: string) {
  const r = await q(
    `SELECT g.*, t.name AS tenant_name FROM partner_grants g JOIN tenants t ON t.id=g.tenant_id
     WHERE g.partner_id=$1 AND g.revoked_at IS NULL ORDER BY g.expires_at`,
    [partnerId],
  );
  return r.rows;
}

/** 创建伙伴主体（agency/observer 由客户 owner 或平台登记；contractor 由一次性通行证自动创建） */
export async function ensurePartner(
  deps: AccountsDeps,
  input: { name: string; type: "agency" | "contractor" | "observer"; contactPhone: string },
): Promise<{ partnerId: string }> {
  const accR = await deps.q(`SELECT id FROM accounts WHERE phone=$1`, [input.contactPhone]);
  let accId = accR.rows[0]?.id as string | undefined;
  if (!accId) {
    accId = newId("acc");
    await deps.q(`INSERT INTO accounts (id, phone, display_name) VALUES ($1,$2,$3)`, [accId, input.contactPhone, input.name]);
  }
  const exist = await deps.q(
    `SELECT id FROM partners WHERE contact_account_id=$1 AND type=$2 AND status='active'`,
    [accId, input.type],
  );
  if (exist.rows[0]) return { partnerId: exist.rows[0].id as string };
  const id = newId("ptr");
  await deps.q(
    `INSERT INTO partners (id, name, type, contact_account_id) VALUES ($1,$2,$3,$4)`,
    [id, input.name, input.type, accId],
  );
  return { partnerId: id };
}

/** 伙伴登录（手机验证码）：返回伙伴令牌 + refresh */
export async function partnerLogin(
  deps: AccountsDeps,
  input: { phone: string; code: string; device?: string; ip?: string },
) {
  const accR = await deps.q(`SELECT * FROM accounts WHERE phone=$1`, [input.phone]);
  const acc = accR.rows[0];
  if (!acc) throw new Error("该手机号未登记为伙伴联系人");
  const pR = await deps.q(`SELECT * FROM partners WHERE contact_account_id=$1 AND status='active'`, [acc.id]);
  const partner = pR.rows[0];
  if (!partner) throw new Error("该账号没有有效伙伴身份");
  const ok = await consumeCode(deps, { channel: "phone", target: input.phone, purpose: "login", code: input.code });
  if (!ok) throw new Error("验证码错误或已过期");
  const grants = await activeGrantSnapshot(deps.q, partner.id as string);
  const identity: PartnerIdentity = {
    kind: "partner", partnerId: partner.id as string,
    contactAccountId: acc.id as string, name: partner.name as string, grants,
  };
  const refresh = mintRefreshToken();
  await deps.q(
    `INSERT INTO partner_sessions (id, partner_id, refresh_token_hash, device_name, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + interval '${REFRESH_TTL_DAYS} days')`,
    [newId("psess"), partner.id, refresh.hash, input.device ?? "", input.ip ?? ""],
  );
  await loginEvent(deps.q, { accountId: acc.id as string, kind: "login.ok", ip: input.ip, device: input.device, detail: { domain: "partner", partnerId: partner.id } });
  return {
    accessToken: await signPartnerToken(identity),
    refreshToken: refresh.plain, expiresIn: ACCESS_TTL_SEC, identity,
  };
}

async function activeGrantSnapshot(q: QueryFn, partnerId: string): Promise<PartnerIdentity["grants"]> {
  const r = await q(
    `SELECT id, tenant_id, workspaces, capabilities FROM partner_grants
     WHERE partner_id=$1 AND revoked_at IS NULL AND expires_at > now()`,
    [partnerId],
  );
  return r.rows.map((g) => ({
    grantId: g.id as string, tenantId: g.tenant_id as string,
    workspaces: g.workspaces as string[], capabilities: g.capabilities as string[],
  }));
}

export async function partnerRefresh(deps: AccountsDeps, input: { refreshToken: string }) {
  const r = await deps.q(
    `SELECT * FROM partner_sessions WHERE refresh_token_hash=$1 AND revoked_at IS NULL AND expires_at > now()`,
    [hashRefreshToken(input.refreshToken)],
  );
  const sess = r.rows[0];
  if (!sess) throw new Error("伙伴会话已失效，请重新登录");
  await deps.q(`UPDATE partner_sessions SET revoked_at=now() WHERE id=$1`, [sess.id]);
  const pR = await deps.q(`SELECT * FROM partners WHERE id=$1 AND status='active'`, [sess.partner_id]);
  const partner = pR.rows[0];
  if (!partner) throw new Error("伙伴身份已停用");
  const identity: PartnerIdentity = {
    kind: "partner", partnerId: partner.id as string,
    contactAccountId: partner.contact_account_id as string, name: partner.name as string,
    grants: await activeGrantSnapshot(deps.q, partner.id as string),
  };
  const refresh = mintRefreshToken();
  await deps.q(
    `INSERT INTO partner_sessions (id, partner_id, refresh_token_hash, device_name, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + interval '${REFRESH_TTL_DAYS} days')`,
    [newId("psess"), partner.id, refresh.hash, sess.device_name, sess.ip],
  );
  return { accessToken: await signPartnerToken(identity), refreshToken: refresh.plain, expiresIn: ACCESS_TTL_SEC, identity };
}

/**
 * 伙伴能力校验（每次敏感操作实时回查 grant——令牌快照之外的双保险，吊销即时生效）
 */
export async function checkPartnerCapability(
  q: QueryFn,
  input: { partnerId: string; tenantId: string; workspaceId?: string; capability: string },
): Promise<{ ok: boolean; grantId?: string; reason?: string }> {
  const r = await q(
    `SELECT id, workspaces, capabilities, constraints FROM partner_grants
     WHERE partner_id=$1 AND tenant_id=$2 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY issued_at DESC`,
    [input.partnerId, input.tenantId],
  );
  for (const g of r.rows) {
    const caps = g.capabilities as string[];
    const wss = g.workspaces as string[];
    if (!caps.includes(input.capability)) continue;
    if (input.workspaceId && wss.length > 0 && !wss.includes(input.workspaceId)) continue;
    return { ok: true, grantId: g.id as string };
  }
  return { ok: false, reason: "无有效授权或授权已过期/吊销" };
}

/** 一次性工单通行证（contractor）：短时效、单工单、仅 workorder.self */
export async function issueWorkorderPass(
  deps: AccountsDeps,
  input: { phone: string; name: string; tenantId: string; workspaceId: string; ticketId: string; ttlHours?: number; issuedBy: string },
): Promise<{ passCode: string }> {
  const { partnerId } = await ensurePartner(deps, { name: input.name, type: "contractor", contactPhone: input.phone });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await deps.q(
    `INSERT INTO partner_grants (id, partner_id, tenant_id, workspaces, capabilities, constraints, issued_by, expires_at)
     VALUES ($1,$2,$3,$4,'["workorder.self"]',$5,$6, now() + ($7 || ' hours')::interval)`,
    [newId("grt"), partnerId, input.tenantId, JSON.stringify([input.workspaceId]),
     JSON.stringify({ ticketId: input.ticketId, passCodeHash: (await import("./kdf.js")).hashSecret(code, input.phone) }),
     input.issuedBy, input.ttlHours ?? 48],
  );
  await deps.sms.send(input.phone, `【WorkLoom】工单通行码 ${code}：您有一张工单待处理，${input.ttlHours ?? 48} 小时内有效。`);
  return { passCode: process.env.NODE_ENV === "production" ? "" : code };
}
