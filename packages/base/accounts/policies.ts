/**
 * accounts/policies —— 审批策略三套业态模板 + 应用器 + scoped API 密钥。
 * 模板是默认参数而非规则结构：客户可经配置引导调参数（与配置录入管线同一纪律）。
 */
import type { AccountsDeps, QueryFn } from "./service.js";
import { newId, randomToken, hashSecret } from "./kdf.js";

export type ActionClass = "daily" | "business" | "finance" | "redline";
export type Archetype = "single" | "unmanned" | "group-store";

export interface ApprovalPolicyRow {
  actionClass: ActionClass;
  fenceLevel: "auto" | "review" | "block";
  approverRule: Record<string, unknown>;
  delegation?: Record<string, unknown>;
}

/** 三套业态默认审批模板（PRD §5.2） */
export const APPROVAL_TEMPLATES: Record<Archetype, ApprovalPolicyRow[]> = {
  /** 民宿/单体一人店：一切归 owner */
  single: [
    { actionClass: "daily", fenceLevel: "auto", approverRule: {} },
    { actionClass: "business", fenceLevel: "review", approverRule: { role: "owner" } },
    { actionClass: "finance", fenceLevel: "review", approverRule: { role: "owner", secondFactor: true } },
    { actionClass: "redline", fenceLevel: "block", approverRule: { exportViaTicket: true } },
  ],
  /** 无人酒店：经营敏感委托数字 CEO 授权带，资金远程 owner 必审 */
  unmanned: [
    { actionClass: "daily", fenceLevel: "auto", approverRule: {} },
    { actionClass: "business", fenceLevel: "review", approverRule: { digitalCeo: { band: "default" }, fallback: { role: "owner" } } },
    { actionClass: "finance", fenceLevel: "review", approverRule: { role: "owner", secondFactor: true, remote: true } },
    { actionClass: "redline", fenceLevel: "block", approverRule: { exportViaTicket: true } },
  ],
  /** 集团门店：店长→区域→品牌分级 */
  "group-store": [
    { actionClass: "daily", fenceLevel: "auto", approverRule: {} },
    { actionClass: "business", fenceLevel: "review", approverRule: { role: "manager", escalate: { role: "region-manager", over: "store-threshold" } } },
    { actionClass: "finance", fenceLevel: "review", approverRule: { role: "region-manager", escalate: { role: "brand", over: "group-threshold" } } },
    { actionClass: "redline", fenceLevel: "block", approverRule: { exportViaTicket: true, groupVisible: true } },
  ],
};

/** 工作区开通时按业态预填审批策略（幂等：已存在不覆盖） */
export async function applyApprovalTemplate(
  deps: AccountsDeps,
  input: { workspaceId: string; archetype: Archetype; updatedBy: string },
): Promise<{ applied: number }> {
  const rows = APPROVAL_TEMPLATES[input.archetype];
  let applied = 0;
  for (const r of rows) {
    const res = await deps.q(
      `INSERT INTO approval_policies (id, workspace_id, action_class, fence_level, approver_rule, delegation, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace_id, action_class) DO NOTHING`,
      [newId("apol"), input.workspaceId, r.actionClass, r.fenceLevel,
       JSON.stringify(r.approverRule), JSON.stringify(r.delegation ?? {}), input.updatedBy],
    );
    applied += (res as unknown as { rowCount?: number }).rowCount ?? 1;
  }
  return { applied };
}

export async function listApprovalPolicies(q: QueryFn, workspaceId: string) {
  const r = await q(
    `SELECT action_class, fence_level, approver_rule, delegation, updated_at FROM approval_policies
     WHERE workspace_id=$1 ORDER BY action_class`,
    [workspaceId],
  );
  return r.rows;
}

/* ================= scoped API 密钥 ================= */

export interface ApiKeyIdentity {
  kind: "apikey";
  keyId: string;
  workspaceId: string;
  capabilities: string[];
  rateLimit: number;
}

/** 签发 API 密钥（明文只返回一次） */
export async function createApiKey(
  deps: AccountsDeps,
  input: { workspaceId: string; name: string; capabilities: string[]; rateLimit?: number; ttlDays?: number; createdBy: string },
): Promise<{ keyId: string; plainKey: string }> {
  const plain = `wlk_${randomToken(24)}`;
  const id = newId("key");
  await deps.q(
    `INSERT INTO api_keys (id, workspace_id, name, key_hash, key_prefix, capabilities, rate_limit, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + ($8 || ' days')::interval END, $9)`,
    [id, input.workspaceId, input.name, hashSecret(plain, "apikey"), plain.slice(0, 10),
     JSON.stringify(input.capabilities), input.rateLimit ?? 60, input.ttlDays ?? null, input.createdBy],
  );
  return { keyId: id, plainKey: plain };
}

/** 校验 API 密钥（命中即更新 last_used_at；能力校验由调用方做） */
export async function verifyApiKey(q: QueryFn, plain: string): Promise<ApiKeyIdentity | null> {
  const r = await q(
    `UPDATE api_keys SET last_used_at=now()
     WHERE key_hash=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     RETURNING id, workspace_id, capabilities, rate_limit`,
    [hashSecret(plain, "apikey")],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    kind: "apikey", keyId: row.id as string, workspaceId: row.workspace_id as string,
    capabilities: row.capabilities as string[], rateLimit: row.rate_limit as number,
  };
}

export async function listApiKeys(q: QueryFn, workspaceId: string) {
  const r = await q(
    `SELECT id, name, key_prefix, capabilities, rate_limit, last_used_at, expires_at, revoked_at, created_at
     FROM api_keys WHERE workspace_id=$1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return r.rows;
}

export async function revokeApiKey(q: QueryFn, workspaceId: string, keyId: string): Promise<void> {
  await q(`UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND workspace_id=$2`, [keyId, workspaceId]);
}

/* ================= 集团租户层级 ================= */

export async function linkTenant(
  deps: AccountsDeps,
  input: { parentTenantId: string; childTenantId: string; relation: "direct" | "franchise"; settlement: "group_pool" | "self_pay" },
): Promise<void> {
  await deps.q(
    `INSERT INTO tenant_relations (id, parent_tenant_id, child_tenant_id, relation, settlement)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (parent_tenant_id, child_tenant_id) DO NOTHING`,
    [newId("trel"), input.parentTenantId, input.childTenantId, input.relation, input.settlement],
  );
}

/** 集团门店清单（区域/品牌视图） */
export async function childTenants(q: QueryFn, parentTenantId: string) {
  const r = await q(
    `SELECT tr.child_tenant_id, tr.relation, tr.settlement, t.name, t.plan
     FROM tenant_relations tr JOIN tenants t ON t.id=tr.child_tenant_id
     WHERE tr.parent_tenant_id=$1 ORDER BY t.name`,
    [parentTenantId],
  );
  return r.rows;
}
