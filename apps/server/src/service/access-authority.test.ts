import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Identity, PartnerSessionIdentity } from "@workloom/base/tenancy";
import { BASE_CLIENT_ACTION_PERMISSIONS } from "@workloom/shared";
import type { ActiveBundleResolution } from "./active-bundle.js";
import {
  BASE_ACTION_PERMISSIONS,
  livePartnerGrantRows,
  memberAccessGrants,
  resolveAuthoritativeClientAccess,
  type AccessAuthorityDeps,
  type MemberAuthorityFacts,
  type PartnerAuthorityFacts,
} from "./access-authority.js";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const claim: Identity = {
  kind: "member",
  memberId: "mem-1",
  memberNo: "MEM-001",
  name: "旧令牌姓名",
  role: "owner",
  tenantId: "tenant-1",
  workspaceId: "ws-1",
  plan: "pro",
};

const memberFacts: MemberAuthorityFacts = {
  memberId: "mem-1",
  memberNo: "MEM-001",
  name: "当前成员",
  role: "owner",
  tenantId: "tenant-1",
  workspaceId: "ws-1",
  plan: "pro",
  permissions: {},
};

const noBundle: ActiveBundleResolution = {
  state: "not-installed",
  bundleId: null,
  installId: null,
  projection: null,
  reason: "未装配",
};

function deps(input: {
  member?: MemberAuthorityFacts | null;
  partner?: PartnerAuthorityFacts | null;
  bundle?: ActiveBundleResolution;
} = {}): AccessAuthorityDeps {
  return {
    loadMemberFacts: vi.fn(async () => input.member === undefined ? memberFacts : input.member),
    loadPartnerFacts: vi.fn(async () => input.partner ?? null),
    resolveBundle: vi.fn(async () => input.bundle ?? noBundle),
  };
}

describe("三端访问权威", () => {
  it("客户端消费的动作键全部来自公共注册表且每个基座键至少有一个合法角色可获得", () => {
    expect(BASE_ACTION_PERMISSIONS).toEqual(BASE_CLIENT_ACTION_PERMISSIONS);

    const obtainable = new Set<string>();
    for (const role of ["owner", "manager", "staff", "readonly"] as const) {
      const grants = memberAccessGrants({ role, plan: "pro", guest: false });
      for (const permission of grants.actionPermissions) obtainable.add(permission);
    }
    expect([...BASE_CLIENT_ACTION_PERMISSIONS].filter((permission) => !obtainable.has(permission))).toEqual([]);

    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const consumed = new Set<string>();
    for (const clientRoot of [`${repoRoot}apps/web/src`, `${repoRoot}apps/webb/src`]) {
      for (const file of sourceFiles(clientRoot)) {
        const source = readFileSync(file, "utf8");
        const matcher = /(?:canAction|actionPermissions\.has)\(\s*["']([^"']+)["']/g;
        for (const match of source.matchAll(matcher)) {
          if (match[1]) consumed.add(match[1]);
        }
      }
    }
    expect([...consumed].filter((permission) => !BASE_CLIENT_ACTION_PERMISSIONS.includes(
      permission as (typeof BASE_CLIENT_ACTION_PERMISSIONS)[number],
    ))).toEqual([]);
  });

  it("只读角色由服务端明确授予读权限且不授予任何动作", () => {
    const grants = memberAccessGrants({ role: "readonly", plan: "pro", guest: false });
    expect(grants.navigationPermissions).toContain("ledger.read");
    expect(grants.navigationPermissions).toContain("night.read");
    expect(grants.navigationPermissions).not.toContain("workspace.manage");
    expect(grants.actionPermissions).toEqual([]);
  });

  it("游客即使借用 owner 成员主键也按最小只读范围失败关闭", async () => {
    const access = await resolveAuthoritativeClientAccess(
      { ...claim, memberNo: "GUEST", name: "游客", role: "readonly" },
      undefined,
      deps({ member: memberFacts }),
    );
    expect(access.subject).toMatchObject({ kind: "guest", role: "readonly" });
    expect(access.navigationPermissions).not.toContain("approvals.read");
    expect(access.navigationPermissions).not.toContain("workspace.manage");
    expect(access.actionPermissions).toEqual([]);
  });

  it("套餐降级读取数据库当前值，旧 Pro 令牌不能保留夜班", async () => {
    const access = await resolveAuthoritativeClientAccess(claim, undefined, deps({
      member: { ...memberFacts, plan: "community" },
    }));
    expect(access.plan).toBe("community");
    expect(access.capabilities.nightShift).toBe(false);
    expect(access.navigationPermissions).not.toContain("night.read");
    expect(access.actionPermissions).not.toContain("night.manage");
  });

  it("跨工作区直达请求在读取 Bundle 前即拒绝", async () => {
    const authority = deps();
    await expect(resolveAuthoritativeClientAccess(claim, {
      tenantId: "tenant-1",
      workspaceId: "ws-other",
    }, authority)).rejects.toMatchObject({ code: "SCOPE_MISMATCH" });
    expect(authority.resolveBundle).not.toHaveBeenCalled();
  });

  it("仅活动且已通过运行时校验的 Bundle 权限可以进入权威载荷", async () => {
    const active: ActiveBundleResolution = {
      state: "ready",
      bundleId: "sample",
      installId: "install-1",
      reason: "已验证",
      projection: {
        bundleId: "sample",
        bundleName: "示例行业",
        bundleVersion: "1.0.0",
        bundleStatus: "stable",
        contractVersion: "2.0.0",
        integrityDigest: "a".repeat(64),
        signatureKeyId: "release-key",
        ui: {
          schemaVersion: "workloom.bundle.ui/v1",
          terminology: {},
          navigation: { slots: [] },
          home: { widgets: [] },
          objects: [], workflows: [],
          serviceFront: { enabled: false, identityPolicy: "disabled", tabs: [], services: [] },
          theme: { brand: {} },
          permissions: ["sample.console.read"],
          experiments: [],
        },
      },
    };
    const access = await resolveAuthoritativeClientAccess(claim, undefined, deps({ bundle: active }));
    expect(access.bundle).toMatchObject({ configured: true, signatureKeyId: "release-key" });
    expect(access.navigationPermissions).toContain("sample.console.read");

    const invalid = await resolveAuthoritativeClientAccess(claim, undefined, deps({
      bundle: { ...noBundle, state: "projection-invalid", reason: "签名无效" },
    }));
    expect(invalid.bundle.configured).toBe(false);
    expect(invalid.navigationPermissions).not.toContain("sample.console.read");
  });

  it("组合包导航权限只取各槽位权限并与成员实时授权求交", async () => {
    const composite: ActiveBundleResolution = {
      state: "ready",
      bundleId: "geo-growth",
      installId: "install-composite",
      reason: "组合投影已验证",
      projection: {
        primaryBundleId: "geo-growth",
        bundleId: "geo-growth",
        bundleName: "获客经营组合",
        bundleVersion: "1.0.0",
        bundleStatus: "candidate",
        contractVersion: "2.0.0",
        integrityDigest: "a".repeat(64),
        signatureKeyId: null,
        navigationPermissionUniverse: ["hotel.console.read", "ai-video.console.read"],
        ui: {
          schemaVersion: "workloom.bundle.ui/v1",
          terminology: {},
          navigation: { slots: [
            { sourceBundleId: "hotel", capabilityId: "hotel.console", title: "酒店经营", route: "/hotel", group: "operations", icon: "report", clients: ["pc"], permissions: ["hotel.console.read"] },
            { sourceBundleId: "ai-video", capabilityId: "ai-video.console", title: "视频生产", route: "/video", group: "operations", icon: "report", clients: ["pc"], permissions: ["ai-video.console.read"] },
          ] },
          home: { widgets: [] }, objects: [], workflows: [],
          serviceFront: { enabled: false, identityPolicy: "disabled", tabs: [], services: [] },
          theme: { brand: {} },
          // 这个未被任何导航槽位使用的声明不能进入 navigationPermissions。
          permissions: ["hotel.console.read", "ai-video.console.read", "geo-growth.internal.read"],
          experiments: [],
        },
      },
    };
    const access = await resolveAuthoritativeClientAccess(claim, undefined, deps({
      member: {
        ...memberFacts,
        role: "staff",
        permissions: { allow: ["hotel.console.read", "geo-growth.internal.read"] },
      },
      bundle: composite,
    }));
    expect(access.navigationPermissions).toContain("hotel.console.read");
    expect(access.navigationPermissions).not.toContain("ai-video.console.read");
    expect(access.navigationPermissions).not.toContain("geo-growth.internal.read");

    const incomplete = await resolveAuthoritativeClientAccess(claim, undefined, deps({
      member: {
        ...memberFacts,
        role: "staff",
        permissions: { allow: ["hotel.console.read", "geo-growth.internal.read"] },
      },
      bundle: {
        ...composite,
        projection: { ...composite.projection!, navigationPermissionUniverse: undefined },
      },
    }));
    expect(incomplete.navigationPermissions).not.toContain("hotel.console.read");
    expect(incomplete.navigationPermissions).not.toContain("ai-video.console.read");
    expect(incomplete.navigationPermissions).not.toContain("geo-growth.internal.read");
  });

  it("伙伴只消费实时有效授权，不信任 JWT 内授权快照", async () => {
    const partner: PartnerSessionIdentity = {
      kind: "partner",
      partnerId: "ptr-1",
      contactAccountId: "acc-1",
      name: "旧名称",
      grants: [{
        grantId: "stale-grant",
        tenantId: "tenant-1",
        workspaces: ["ws-other"],
        capabilities: ["ops.execute"],
      }],
    };
    const access = await resolveAuthoritativeClientAccess(partner, {
      tenantId: "tenant-1", workspaceId: "ws-1",
    }, deps({ partner: {
      partnerId: "ptr-1", name: "当前伙伴", tenantId: "tenant-1", workspaceId: "ws-1",
      plan: "pro", capabilities: ["report.view"], grantIds: ["live-grant"],
      availableScopes: [{ tenantId: "tenant-1", tenantName: "租户一", workspaceId: "ws-1", workspaceName: "工作区一" }],
    } }));
    expect(access.subject.name).toBe("当前伙伴");
    expect(access.navigationPermissions).toEqual(["account.read"]);
    expect(access.actionPermissions).not.toContain("partner.ops.execute");
    expect(access.authority.grantIds).toEqual(["live-grant"]);
  });

  it("伙伴未传客户端选区时由服务端实时授权选择默认工作区", async () => {
    const partner: PartnerSessionIdentity = {
      kind: "partner", partnerId: "ptr-1", contactAccountId: "acc-1", name: "旧名称", grants: [],
    };
    const authority = deps({ partner: {
      partnerId: "ptr-1", name: "当前伙伴", tenantId: "tenant-live", workspaceId: "ws-live",
      plan: "pro", capabilities: ["report.view"], grantIds: ["live-grant"],
      availableScopes: [{ tenantId: "tenant-live", tenantName: "实时租户", workspaceId: "ws-live", workspaceName: "实时工作区" }],
    } });
    const access = await resolveAuthoritativeClientAccess(partner, undefined, authority);
    expect(authority.loadPartnerFacts).toHaveBeenCalledWith(partner, undefined);
    expect(access.scope).toEqual({ tenantId: "tenant-live", workspaceId: "ws-live" });
    expect(access.navigationPermissions).toEqual(["account.read"]);
  });

  it("伙伴显式切换工作区时服务端重新校验目标并返回实时可选范围", async () => {
    const partner: PartnerSessionIdentity = {
      kind: "partner", partnerId: "ptr-1", contactAccountId: "acc-1", name: "伙伴", grants: [],
    };
    const availableScopes = [
      { tenantId: "tenant-1", tenantName: "租户一", workspaceId: "ws-1", workspaceName: "工作区一" },
      { tenantId: "tenant-2", tenantName: "租户二", workspaceId: "ws-2", workspaceName: "工作区二" },
    ];
    const authority = deps({ partner: {
      partnerId: "ptr-1", name: "当前伙伴", tenantId: "tenant-2", workspaceId: "ws-2",
      plan: "teams", capabilities: ["ops.execute"], grantIds: ["grant-2"], availableScopes,
    } });
    const target = { tenantId: "tenant-2", workspaceId: "ws-2" };
    const access = await resolveAuthoritativeClientAccess(partner, target, authority);
    expect(authority.loadPartnerFacts).toHaveBeenCalledWith(partner, target);
    expect(access.scope).toEqual(target);
    expect(access.availableScopes).toEqual(availableScopes);
    expect(access.authority.grantIds).toEqual(["grant-2"]);
  });

  it.each([
    ["已过期"],
    ["已吊销"],
    ["不含目标工作区"],
  ])("伙伴授权%s时统一失败关闭", async () => {
    const partner: PartnerSessionIdentity = {
      kind: "partner", partnerId: "ptr-1", contactAccountId: "acc-1", name: "伙伴", grants: [],
    };
    await expect(resolveAuthoritativeClientAccess(partner, {
      tenantId: "tenant-1", workspaceId: "ws-1",
    }, deps({ partner: null }))).rejects.toMatchObject({ code: "GRANT_INACTIVE" });
  });

  it("伙伴授权时效过滤明确排除过期和已吊销记录", () => {
    const now = new Date("2026-09-15T00:00:00.000Z");
    const grants = livePartnerGrantRows([
      { id: "live", tenant_id: "tenant-1", workspaces: ["ws-1"], capabilities: [], expires_at: "2026-09-16T00:00:00.000Z", revoked_at: null },
      { id: "expired", tenant_id: "tenant-1", workspaces: ["ws-1"], capabilities: [], expires_at: "2026-09-14T23:59:59.000Z", revoked_at: null },
      { id: "revoked", tenant_id: "tenant-1", workspaces: ["ws-1"], capabilities: [], expires_at: "2026-09-16T00:00:00.000Z", revoked_at: "2026-09-14T00:00:00.000Z" },
    ], now);
    expect(grants.map((grant) => grant.id)).toEqual(["live"]);
  });
});
