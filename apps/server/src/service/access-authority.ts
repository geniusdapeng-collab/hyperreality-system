/**
 * B 端访问权威：实时成员/伙伴授权 + 当前套餐 + 已验证活动 Bundle 的唯一合并点。
 *
 * 客户端只能消费这里下发的导航与动作授权，不能根据“已登录”、JWT 旧 role/plan
 * 或行业标识自行推导。行业权限只取自已通过运行时校验的 Bundle 声明，不在基座
 * 硬编码任何行业权限。
 */
import type { PoolClient } from "pg";
import { getAppPool, getOwnerPool, withWorkspace } from "@workloom/db";
import {
  getCapabilities,
  type Identity,
  type PartnerSessionIdentity,
  type SessionIdentity,
} from "@workloom/base/tenancy";
import {
  BASE_CLIENT_ACTION_PERMISSIONS,
  type BaseClientActionPermission,
  type MemberRole,
  type PlanTier,
} from "@workloom/shared";
import {
  resolveWorkspaceActiveBundle,
  type ActiveBundleResolution,
} from "./active-bundle.js";

export const ACCESS_SCHEMA_VERSION = "workloom.client-access/v1" as const;

export const BASE_NAVIGATION_PERMISSIONS = [
  "today.read",
  "inbox.read",
  "tasks.read",
  "approvals.read",
  "reports.read",
  "service.read",
  "executive.read",
  "guardrails.read",
  "ledger.read",
  "eval.read",
  "memory.read",
  "night.read",
  "models.read",
  "skills.read",
  "workspace.manage",
  "assembly.read",
  "agents.read",
  "members.read",
  "partners.read",
  "account.read",
] as const;

export const BASE_ACTION_PERMISSIONS = BASE_CLIENT_ACTION_PERMISSIONS;

export type BaseNavigationPermission = (typeof BASE_NAVIGATION_PERMISSIONS)[number];
export type BaseActionPermission = BaseClientActionPermission;

export interface MemberAuthorityFacts {
  memberId: string;
  memberNo: string;
  name: string;
  role: MemberRole;
  tenantId: string;
  workspaceId: string;
  plan: PlanTier;
  permissions: Record<string, unknown>;
}

export interface PartnerAuthorityFacts {
  partnerId: string;
  name: string;
  tenantId: string;
  workspaceId: string;
  plan: PlanTier;
  capabilities: string[];
  grantIds: string[];
  availableScopes: Array<{
    tenantId: string;
    tenantName: string;
    workspaceId: string;
    workspaceName: string;
  }>;
}

export interface AccessAuthorityDeps {
  loadMemberFacts: (claim: Identity) => Promise<MemberAuthorityFacts | null>;
  loadPartnerFacts: (
    claim: PartnerSessionIdentity,
    target?: { tenantId: string; workspaceId: string },
  ) => Promise<PartnerAuthorityFacts | null>;
  resolveBundle: (workspaceId: string) => Promise<ActiveBundleResolution>;
}

export class AccessAuthorityError extends Error {
  constructor(
    public readonly code: "SESSION_INVALID" | "SCOPE_MISMATCH" | "TARGET_REQUIRED" | "GRANT_INACTIVE",
    message: string,
  ) {
    super(message);
    this.name = "AccessAuthorityError";
  }
}

const SAFE_MEMBER_READS: readonly BaseNavigationPermission[] = [
  "today.read", "inbox.read", "tasks.read", "approvals.read", "reports.read",
  "service.read", "executive.read", "guardrails.read", "ledger.read", "eval.read",
  "memory.read", "models.read", "skills.read", "assembly.read", "agents.read", "account.read",
];

const STAFF_ACTIONS: readonly BaseActionPermission[] = [
  "workspace.write", "task.dispatch", "approval.decide", "guardrail.manage",
  "exam.run", "memory.manage", "night.manage",
];

const MANAGER_ACTIONS: readonly BaseActionPermission[] = [
  ...STAFF_ACTIONS,
  "skill.manage", "bundle.manage", "agent.manage", "member.manage", "memory.recall", "workspace.configure",
];

const OWNER_ACTIONS: readonly BaseActionPermission[] = [
  ...MANAGER_ACTIONS,
  "member.role.manage", "partner.manage", "tenant.plan.manage",
];

const NON_DELEGABLE_BASE = new Set<string>([
  "workspace.manage", "members.read", "partners.read",
  "member.manage", "member.role.manage", "partner.manage", "tenant.plan.manage",
]);

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export interface PartnerGrantAuthorityRow {
  id: string;
  tenant_id: string;
  workspaces: unknown;
  capabilities: unknown;
  expires_at: Date | string;
  revoked_at: Date | string | null;
}

/** SQL 条件之外的第二道时效校验，避免长事务快照或适配器实现遗漏导致旧授权复活。 */
export function livePartnerGrantRows(
  rows: readonly PartnerGrantAuthorityRow[],
  now: Date = new Date(),
): PartnerGrantAuthorityRow[] {
  return rows.filter((grant) => !grant.revoked_at && new Date(grant.expires_at).getTime() > now.getTime());
}

/**
 * members.permissions 支持 {allow:[], deny:[]} 及 permission.id:boolean 两种历史形态。
 * deny 始终收紧；allow 只能授予当前已验证 Bundle 声明的权限，不能抬升基座角色。
 */
export function memberPermissionOverrides(value: Record<string, unknown>): { allow: Set<string>; deny: Set<string> } {
  const allow = new Set(stringArray(value.allow));
  const deny = new Set(stringArray(value.deny));
  for (const [permission, enabled] of Object.entries(value)) {
    if (enabled === true) allow.add(permission);
    if (enabled === false) deny.add(permission);
  }
  return { allow, deny };
}

export function memberAccessGrants(input: {
  role: MemberRole;
  plan: PlanTier;
  guest: boolean;
  permissions?: Record<string, unknown>;
  verifiedBundlePermissions?: readonly string[];
  verifiedBundleActionPermissions?: readonly string[];
}): { navigationPermissions: string[]; actionPermissions: string[] } {
  const navigation = new Set<string>(SAFE_MEMBER_READS);
  const actions = new Set<string>();

  if (input.role === "owner" || input.role === "manager") {
    navigation.add("workspace.manage");
    navigation.add("members.read");
  }
  if (input.role === "owner") navigation.add("partners.read");
  // 夜班日报是示例工作区最有说服力的只读展示面，游客亦可读；
  // 写操作（night.manage 等）仍由下方 actions.clear() 与 writeProcedure 双重阻断。
  if (input.plan !== "community") navigation.add("night.read");

  if (!input.guest) {
    const roleActions = input.role === "owner" ? OWNER_ACTIONS
      : input.role === "manager" ? MANAGER_ACTIONS
        : input.role === "staff" ? STAFF_ACTIONS
          : [];
    for (const permission of roleActions) actions.add(permission);
  }

  const bundleUniverse = new Set(input.verifiedBundlePermissions ?? []);
  // 行业执行键只来自已验证的活动 Bundle。与导航权限分开，避免把
  // 「能打开只读页面」误作「可以执行页面内动作」。
  const bundleActions = new Set(input.verifiedBundleActionPermissions ?? []);
  const overrides = memberPermissionOverrides(input.permissions ?? {});
  if (!input.guest) {
    if (input.role === "owner" || input.role === "manager") {
      for (const permission of bundleUniverse) navigation.add(permission);
      if (actions.has("workspace.write")) {
        for (const permission of bundleActions) actions.add(permission);
      }
    }
    for (const permission of overrides.allow) {
      if (bundleUniverse.has(permission) && !NON_DELEGABLE_BASE.has(permission)) navigation.add(permission);
      if (actions.has("workspace.write") && bundleActions.has(permission)) actions.add(permission);
    }
  }
  for (const denied of overrides.deny) {
    navigation.delete(denied);
    actions.delete(denied);
  }
  if (!actions.has("workspace.write")) {
    for (const permission of bundleActions) actions.delete(permission);
  }

  // 套餐降级实时生效：旧 JWT 或前端缓存不能保留夜班入口/动作。
  if (input.plan === "community") {
    navigation.delete("night.read");
    actions.delete("night.manage");
  }
  // 游客令牌可能借用 owner 的成员主键，但永远按只读体验会话处理。
  // 只读保留 approvals.read：「请您拍板」队列是示例工作区核心展示面，游客看得见但批不了
  // （决策动作权限为空集 + writeProcedure 服务端 403 兜底）；inbox/成员/伙伴/工作区管理仍不开放。
  if (input.guest) {
    navigation.delete("inbox.read");
    navigation.delete("workspace.manage");
    navigation.delete("members.read");
    navigation.delete("partners.read");
    actions.clear();
  }
  return {
    navigationPermissions: [...navigation].sort(),
    actionPermissions: [...actions].sort(),
  };
}

/** 伙伴能力到公共 B 端体验面的最小映射；不包含任何行业语义。 */
export function partnerAccessGrants(capabilities: readonly string[]): {
  navigationPermissions: string[];
  actionPermissions: string[];
} {
  const caps = new Set(capabilities);
  const navigation = new Set<string>(["account.read"]);
  const actions = new Set<string>();
  // 当前公共任务/报告页面使用成员域数据过程，绝不把伙伴令牌送入 member-only API。
  // 伙伴业务页需由已验 Bundle 的伙伴投影或独立 partnerProcedure 承载；在此之前只开放
  // 已具备伙伴安全展示的个人页，能力本身仍完整下发供专属页面消费。
  if (caps.has("ticket.handle")) actions.add("partner.ticket.handle");
  if (caps.has("workorder.self")) actions.add("partner.workorder.respond");
  if (caps.has("ops.execute")) actions.add("partner.ops.execute");
  return { navigationPermissions: [...navigation].sort(), actionPermissions: [...actions].sort() };
}

async function queryMemberFacts(claim: Identity): Promise<MemberAuthorityFacts | null> {
  return withWorkspace(getAppPool(), { tenantId: claim.tenantId, workspaceId: claim.workspaceId }, async (_db, client) => {
    const result = await client.query<{
      member_id: string; member_no: string; member_name: string; role: MemberRole;
      permissions: Record<string, unknown>; member_status: string;
      workspace_id: string; tenant_id: string; plan: PlanTier; tenant_status: string;
    }>(
      `SELECT m.id AS member_id, m.member_no, m.name AS member_name, m.role, m.permissions,
              m.status AS member_status, w.id AS workspace_id, w.tenant_id, t.plan, t.status AS tenant_status
       FROM members m
       JOIN workspaces w ON w.id=m.workspace_id
       JOIN tenants t ON t.id=w.tenant_id
       WHERE m.id=$1 AND m.workspace_id=$2 AND w.tenant_id=$3`,
      [claim.memberId, claim.workspaceId, claim.tenantId],
    );
    const row = result.rows[0];
    if (!row || row.member_status !== "active" || row.tenant_status !== "active") return null;
    return {
      memberId: row.member_id,
      memberNo: row.member_no,
      name: row.member_name,
      role: row.role,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      plan: row.plan,
      permissions: row.permissions ?? {},
    };
  });
}

async function queryPartnerFacts(
  claim: PartnerSessionIdentity,
  requestedTarget?: { tenantId: string; workspaceId: string },
): Promise<PartnerAuthorityFacts | null> {
  // 伙伴没有 membership，只有在验签令牌给出 partnerId 后才进入这条精确回查；
  // 目标工作区必须同时属于租户且出现在未吊销、未过期授权中。
  const client: PoolClient = await getOwnerPool().connect();
  try {
    const partner = await client.query<{ name: string }>(
      `SELECT name FROM partners WHERE id=$1 AND contact_account_id=$2 AND status='active'`,
      [claim.partnerId, claim.contactAccountId],
    );
    if (!partner.rows[0]) return null;
    const grantResult = await client.query<PartnerGrantAuthorityRow>(
      `SELECT id, tenant_id, workspaces, capabilities, expires_at, revoked_at FROM partner_grants
       WHERE partner_id=$1 AND revoked_at IS NULL AND expires_at>now()
       ORDER BY issued_at DESC, id`,
      [claim.partnerId],
    );
    const grants = livePartnerGrantRows(grantResult.rows);
    // 可选范围只从当前数据库有效授权推导；JWT 授权快照和客户端缓存都不参与放行。
    const candidateMap = new Map<string, { tenantId: string; workspaceId: string }>();
    for (const grant of grants) {
      for (const workspaceId of stringArray(grant.workspaces)) {
        const candidate = { tenantId: grant.tenant_id, workspaceId };
        candidateMap.set(`${candidate.tenantId}:${candidate.workspaceId}`, candidate);
      }
    }
    const candidates = [...candidateMap.values()];
    if (requestedTarget && !candidateMap.has(`${requestedTarget.tenantId}:${requestedTarget.workspaceId}`)) return null;

    const activeScopes: Array<{
      tenantId: string; tenantName: string; workspaceId: string; workspaceName: string; plan: PlanTier;
    }> = [];
    for (const candidate of candidates) {
      const scope = await client.query<{
        plan: PlanTier; tenant_status: string; tenant_name: string; workspace_name: string;
      }>(
        `SELECT t.plan, t.status AS tenant_status, t.name AS tenant_name, w.name AS workspace_name
         FROM workspaces w JOIN tenants t ON t.id=w.tenant_id
         WHERE w.id=$1 AND w.tenant_id=$2`,
        [candidate.workspaceId, candidate.tenantId],
      );
      if (scope.rows[0]?.tenant_status === "active") {
        activeScopes.push({
          ...candidate,
          tenantName: scope.rows[0].tenant_name,
          workspaceName: scope.rows[0].workspace_name,
          plan: scope.rows[0].plan,
        });
      }
    }
    const activeScope = requestedTarget
      ? activeScopes.find((scope) => scope.tenantId === requestedTarget.tenantId
        && scope.workspaceId === requestedTarget.workspaceId)
      : activeScopes[0];
    if (!activeScope) return null;
    const target = { tenantId: activeScope.tenantId, workspaceId: activeScope.workspaceId };
    const scoped = grants.filter((grant) =>
      grant.tenant_id === target.tenantId && stringArray(grant.workspaces).includes(target.workspaceId),
    );
    if (scoped.length === 0) return null;
    return {
      partnerId: claim.partnerId,
      name: partner.rows[0].name,
      tenantId: target.tenantId,
      workspaceId: target.workspaceId,
      plan: activeScope.plan,
      capabilities: [...new Set(scoped.flatMap((grant) => stringArray(grant.capabilities)))],
      grantIds: scoped.map((grant) => grant.id),
      availableScopes: activeScopes.map(({ tenantId, tenantName, workspaceId, workspaceName }) => ({
        tenantId, tenantName, workspaceId, workspaceName,
      })),
    };
  } finally {
    client.release();
  }
}

export const accessAuthorityDeps: AccessAuthorityDeps = {
  loadMemberFacts: queryMemberFacts,
  loadPartnerFacts: queryPartnerFacts,
  resolveBundle: resolveWorkspaceActiveBundle,
};

export async function currentMemberAuthority(
  claim: Identity,
  deps: Pick<AccessAuthorityDeps, "loadMemberFacts"> = accessAuthorityDeps,
): Promise<{ identity: Identity; permissions: Record<string, unknown> }> {
  const facts = await deps.loadMemberFacts(claim);
  if (!facts) throw new AccessAuthorityError("SESSION_INVALID", "当前成员关系或租户已失效，请重新登录");
  const guest = claim.memberNo === "GUEST";
  return {
    identity: {
      kind: "member",
      memberId: facts.memberId,
      memberNo: guest ? "GUEST" : facts.memberNo,
      name: guest ? "游客" : facts.name,
      role: guest ? "readonly" : facts.role,
      tenantId: facts.tenantId,
      workspaceId: facts.workspaceId,
      plan: facts.plan,
    },
    permissions: guest ? {} : facts.permissions,
  };
}

export async function resolveAuthoritativeClientAccess(
  session: SessionIdentity,
  requestedScope?: { tenantId: string; workspaceId: string },
  deps: AccessAuthorityDeps = accessAuthorityDeps,
) {
  if (session.kind === "partner") {
    const facts = await deps.loadPartnerFacts(session, requestedScope);
    if (!facts) {
      throw new AccessAuthorityError("GRANT_INACTIVE", "该伙伴授权不存在、已到期、已吊销或不包含当前工作区");
    }
    const bundle = await deps.resolveBundle(facts.workspaceId);
    const grants = partnerAccessGrants(facts.capabilities);
    return {
      schemaVersion: ACCESS_SCHEMA_VERSION,
      subject: { kind: "partner" as const, id: facts.partnerId, name: facts.name, role: "partner" as const },
      scope: { tenantId: facts.tenantId, workspaceId: facts.workspaceId },
      plan: facts.plan,
      capabilities: getCapabilities(facts.plan),
      ...grants,
      partnerCapabilities: [...facts.capabilities].sort(),
      availableScopes: facts.availableScopes,
      authority: { source: "server" as const, evaluatedAt: new Date().toISOString(), grantIds: facts.grantIds },
      bundle: bundle.state === "ready" && bundle.projection
        ? { configured: true as const, ...bundle.projection }
        : { configured: false as const, reason: "当前工作区尚未装配可用行业界面" },
    };
  }

  if (requestedScope && (requestedScope.tenantId !== session.tenantId || requestedScope.workspaceId !== session.workspaceId)) {
    throw new AccessAuthorityError("SCOPE_MISMATCH", "当前会话不能读取其他租户或工作区的访问授权");
  }
  const current = await currentMemberAuthority(session, deps);
  const bundle = await deps.resolveBundle(current.identity.workspaceId);
  const verifiedBundlePermissions = bundle.state === "ready" && bundle.projection
    ? bundle.projection.primaryBundleId !== undefined || bundle.projection.sources !== undefined
      // 组合投影缺少导航权限全集时失败关闭；不能回退到包含内部权限的旧 permissions。
      ? bundle.projection.navigationPermissionUniverse ?? []
      // 仅兼容尚未携带组合来源元数据的旧单 Bundle 投影。
      : bundle.projection.ui.permissions
    : [];
  const verifiedBundleActionPermissions = bundle.state === "ready" && bundle.projection
    && (bundle.projection.primaryBundleId === undefined && bundle.projection.sources === undefined
      || Array.isArray(bundle.projection.navigationPermissionUniverse))
    ? bundle.projection.ui.permissions.filter((permission) => permission.endsWith(".execute"))
    : [];
  const grants = memberAccessGrants({
    role: current.identity.role,
    plan: current.identity.plan,
    guest: current.identity.memberNo === "GUEST",
    permissions: current.permissions,
    verifiedBundlePermissions,
    verifiedBundleActionPermissions,
  });
  return {
    schemaVersion: ACCESS_SCHEMA_VERSION,
    subject: {
      kind: current.identity.memberNo === "GUEST" ? "guest" as const : "member" as const,
      id: current.identity.memberId,
      memberNo: current.identity.memberNo,
      name: current.identity.name,
      role: current.identity.role,
    },
    scope: { tenantId: current.identity.tenantId, workspaceId: current.identity.workspaceId },
    plan: current.identity.plan,
    capabilities: getCapabilities(current.identity.plan),
    ...grants,
    partnerCapabilities: [],
    availableScopes: [{
      tenantId: current.identity.tenantId,
      tenantName: "",
      workspaceId: current.identity.workspaceId,
      workspaceName: "",
    }],
    authority: { source: "server" as const, evaluatedAt: new Date().toISOString(), grantIds: [] },
    bundle: bundle.state === "ready" && bundle.projection
      ? { configured: true as const, ...bundle.projection }
      : {
          configured: false as const,
          reason: bundle.state === "bundle-mismatch"
            ? "当前工作区装配状态不一致，请由管理员重新确认生效版本"
            : bundle.state === "projection-invalid"
              ? "当前行业界面未通过安全校验，请由管理员重新发布"
              : "当前工作区尚未装配可用行业界面",
        },
  };
}
