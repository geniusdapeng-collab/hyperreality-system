import { describe, expect, it } from "vitest";
import { navigationEntriesFromBundle } from "@workloom/ui";
import { NAV_ENTRIES, canonicalNavigationPath, isNavigationPathPermitted, navigationForPermissions } from "./NavMenu";

const bundleEntries = navigationEntriesFromBundle("ai-pm", [{
  capabilityId: "ai-pm.development", route: "/development", title: "开发场域",
  group: "automation", icon: "developer", clients: ["pc"], permissions: ["ai-pm.development.read"],
}]);

const routesFor = (permissions: readonly string[]) => new Set(
  navigationForPermissions(new Set(permissions), bundleEntries)
    .map((entry) => entry.route),
);

describe("PC 导航权限", () => {
  it("只读社区版保留公共只读能力并隐藏管理、夜班和开发入口", () => {
    const routes = routesFor([
      "today.read", "tasks.read", "reports.read", "ledger.read", "models.read", "account.read",
    ]);
    expect(routes).toContain("/events");
    expect(routes).toContain("/models");
    expect(routes).toContain("/account");
    expect(routes).not.toContain("/night");
    expect(routes).not.toContain("/workspaces");
    expect(routes).not.toContain("/members");
    expect(routes).not.toContain("/development");
  });

  it("专业版管理员可管理工作区和成员，但伙伴授权仍仅属主可见", () => {
    const routes = routesFor([
      "today.read", "tasks.read", "reports.read", "night.read", "workspace.manage", "members.read",
      "ai-pm.development.read",
    ]);
    expect(routes).toContain("/night");
    expect(routes).toContain("/workspaces");
    expect(routes).toContain("/members");
    expect(routes).toContain("/development");
    expect(routes).not.toContain("/partners");
  });

  it("属主可发现伙伴授权入口", () => {
    expect(routesFor(["partners.read"])).toContain("/partners");
  });

  it("空授权不因已登录状态补出任何基座入口，直达深链也没有许可入口", () => {
    const granted = navigationForPermissions(new Set());
    expect(routesFor([])).toEqual(new Set());
    expect(isNavigationPathPermitted("/approvals", NAV_ENTRIES, granted)).toBe(false);
    expect(isNavigationPathPermitted("/p4", NAV_ENTRIES, granted)).toBe(false);
  });

  it("旧服务卡片深链进入语义地址", () => {
    expect(canonicalNavigationPath("/p4?from=assistant")).toBe("/approvals?from=assistant");
    expect(canonicalNavigationPath("/p2/T-100")).toBe("/tasks/T-100");
    expect(canonicalNavigationPath("/p8/agent/AGT-1")).toBe("/agents/AGT-1");
  });
});
