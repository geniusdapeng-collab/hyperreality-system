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

/** 三套组织形态默认审批模板（PRD §5.2） */
export const APPROVAL_TEMPLATES: Record<Archetype, ApprovalPolicyRow[]> = {
  /** 单组织小团队：经营与资金事项由负责人裁决 */
  single: [
    { actionClass: "daily", fenceLevel: "auto", approverRule: {} },
    { actionClass: "business", fenceLevel: "review", approverRule: { role: "owner" } },
    { actionClass: "finance", fenceLevel: "review", approverRule: { role: "owner", secondFactor: true } },
    { actionClass: "redline", fenceLevel: "block", approverRule: { exportViaTicket: true } },
  ],
  /** 少人值守组织：经营敏感事项使用授权带，资金事项由负责人复核 */
  unmanned: [
    { actionClass: "daily", fenceLevel: "auto", approverRule: {} },
    { actionClass: "business", fenceLevel: "review", approverRule: { digitalCeo: { band: "default" }, fallback: { role: "owner" } } },
    { actionClass: "finance", fenceLevel: "review", approverRule: { role: "owner", secondFactor: true, remote: true } },
    { actionClass: "redline", fenceLevel: "block", approverRule: { exportViaTicket: true } },
  ],
  /** 多层级集团：一线负责人→区域负责人→集团负责人分级 */
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
  const keyHash = hashSecret(plain, "apikey");
  // 轮换窗口到期即把旧密钥落成“已吊销”，既拒绝认证，也给管理页留下明确审计状态。
  await q(
    `UPDATE api_keys SET revoked_at=overlap_expires_at
     WHERE key_hash=$1 AND revoked_at IS NULL
       AND overlap_expires_at IS NOT NULL AND overlap_expires_at <= now()`,
    [keyHash],
  );
  const r = await q(
    `UPDATE api_keys SET last_used_at=now()
     WHERE key_hash=$1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
       AND (overlap_expires_at IS NULL OR overlap_expires_at > now())
     RETURNING id, workspace_id, capabilities, rate_limit`,
    [keyHash],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    kind: "apikey", keyId: row.id as string, workspaceId: row.workspace_id as string,
    capabilities: row.capabilities as string[], rateLimit: row.rate_limit as number,
  };
}

export async function listApiKeys(q: QueryFn, workspaceId: string) {
  await q(
    `UPDATE api_keys SET revoked_at=overlap_expires_at
     WHERE workspace_id=$1 AND revoked_at IS NULL
       AND overlap_expires_at IS NOT NULL AND overlap_expires_at <= now()`,
    [workspaceId],
  );
  const r = await q(
    `SELECT id, name, key_prefix, capabilities, rate_limit, last_used_at, expires_at, revoked_at, created_at,
            rotation_of, replaced_by, overlap_expires_at
     FROM api_keys WHERE workspace_id=$1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return r.rows;
}

export async function revokeApiKey(q: QueryFn, workspaceId: string, keyId: string): Promise<void> {
  const result = await q(
    `UPDATE api_keys SET revoked_at=COALESCE(revoked_at, now())
     WHERE id=$1 AND workspace_id=$2 RETURNING id`,
    [keyId, workspaceId],
  );
  if (!result.rows[0]) throw new Error("密钥不存在或不属于当前工作区");
}

/**
 * 无中断轮换：一次 SQL 原子创建新密钥并为旧密钥开启短暂并存窗口。
 * 新密钥继承原能力、限流和到期时间；明文仍只返回一次。
 */
export async function rotateApiKey(
  deps: AccountsDeps,
  input: { workspaceId: string; keyId: string; overlapMinutes?: number; createdBy: string },
): Promise<{ keyId: string; plainKey: string; replacedKeyId: string; overlapExpiresAt: string }> {
  const overlapMinutes = input.overlapMinutes ?? 60;
  if (!Number.isInteger(overlapMinutes) || overlapMinutes < 5 || overlapMinutes > 1_440) {
    throw new Error("双密钥并存时间须在 5 分钟至 24 小时之间");
  }
  const plain = `wlk_${randomToken(24)}`;
  const newKeyId = newId("key");
  const result = await deps.q(
    `WITH source AS MATERIALIZED (
       SELECT id, workspace_id, name, capabilities, rate_limit, expires_at
       FROM api_keys
       WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL
         AND replaced_by IS NULL
         AND (expires_at IS NULL OR expires_at > now())
         AND (overlap_expires_at IS NULL OR overlap_expires_at > now())
       FOR UPDATE
     ), created AS (
       INSERT INTO api_keys
         (id, workspace_id, name, key_hash, key_prefix, capabilities, rate_limit,
          expires_at, created_by, rotation_of)
       SELECT $3, workspace_id, name, $4, $5, capabilities, rate_limit,
              expires_at, $6, id
       FROM source
       RETURNING id
     ), linked AS (
       UPDATE api_keys AS old_key
       SET replaced_by=(SELECT id FROM created),
           overlap_expires_at=now() + ($7::int || ' minutes')::interval
       WHERE old_key.id=(SELECT id FROM source) AND EXISTS (SELECT 1 FROM created)
       RETURNING old_key.id, old_key.overlap_expires_at
     )
     SELECT created.id AS new_key_id, linked.id AS old_key_id,
            linked.overlap_expires_at
     FROM created CROSS JOIN linked`,
    [input.keyId, input.workspaceId, newKeyId, hashSecret(plain, "apikey"), plain.slice(0, 10), input.createdBy, overlapMinutes],
  );
  const row = result.rows[0];
  if (!row) throw new Error("密钥不可轮换：它可能已失效、正在轮换，或不属于当前工作区");
  return {
    keyId: row.new_key_id as string,
    plainKey: plain,
    replacedKeyId: row.old_key_id as string,
    overlapExpiresAt: new Date(row.overlap_expires_at as string).toISOString(),
  };
}

/** 确认调用方已切换到新密钥后，可提前结束旧密钥并存窗口。 */
export async function completeApiKeyRotation(q: QueryFn, workspaceId: string, keyId: string): Promise<void> {
  const result = await q(
    `UPDATE api_keys SET revoked_at=COALESCE(revoked_at, now()), overlap_expires_at=LEAST(overlap_expires_at, now())
     WHERE id=$1 AND workspace_id=$2 AND replaced_by IS NOT NULL
     RETURNING id`,
    [keyId, workspaceId],
  );
  if (!result.rows[0]) throw new Error("没有可结束的密钥轮换窗口");
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
