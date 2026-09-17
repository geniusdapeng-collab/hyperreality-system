import { createElement } from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BASE_NAVIGATION, navigationEntriesFromBundle } from "@workloom/ui";
import {
  buildIndustryRouteRegistry,
  industryRouteMatchesBundle,
  resolveIndustryRouteAccess,
  validateIndustryCapabilityId,
  validateIndustryRoutePath,
} from "./IndustryRoutes";

const page = createElement("main", null, "行业页面");

describe("B 端 PC 行业扩展路由契约", () => {
  it("默认无扩展时不增加任何路由", () => {
    expect(buildIndustryRouteRegistry({})).toEqual({ routes: [], error: null });
  });

  it("受管 App 只接通用注册表，不直接导入行业页面", () => {
    const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    expect(appSource).toContain("INDUSTRY_ROUTE_REGISTRY.routes.map");
    expect(appSource).toContain("definition.legacyPaths ?? []");
    expect(appSource).toContain("<IndustryLegacyRedirect definition={definition} />");
    expect(appSource).not.toMatch(/from\s+["'][^"']*\/extensions\//);
  });

  it("接受行业命名空间、语义地址和动态详情页", () => {
    const registry = buildIndustryRouteRegistry({
      "../extensions/routes.tsx": {
        industryRoutes: [
          { path: "/orders", capabilityId: "hotel.orders", element: page },
          { path: "/orders/:orderId", capabilityId: "hotel.orders", element: page },
        ],
      },
    });
    expect(registry.error).toBeNull();
    expect(registry.routes.map((route) => route.path)).toEqual(["/orders", "/orders/:orderId"]);
  });

  it("任一声明无效时整组扩展失败关闭", () => {
    const registry = buildIndustryRouteRegistry({
      "../extensions/routes.tsx": {
        industryRoutes: [
          { path: "/orders", capabilityId: "hotel.orders", element: page },
          { path: "/approvals/export", capabilityId: "hotel.export", element: page },
        ],
      },
    });
    expect(registry.routes).toEqual([]);
    expect(registry.error?.message).toContain("不得覆盖基座地址");
  });

  it("共享导航新增公共地址时必须同步进入行业路由保护契约", () => {
    for (const entry of BASE_NAVIGATION) {
      for (const route of [entry.route, ...(entry.legacyRoutes ?? [])]) {
        expect(() => validateIndustryRoutePath(route)).toThrow();
      }
    }
  });

  it("拒绝重复匹配模式、基座能力和危险地址语法", () => {
    const duplicate = buildIndustryRouteRegistry({
      "../extensions/orders/routes.tsx": {
        industryRoutes: [
          { path: "/orders/:id", capabilityId: "hotel.orders", element: page },
          { path: "/orders/:orderId", capabilityId: "hotel.orders", element: page },
        ],
      },
    });
    expect(duplicate.routes).toEqual([]);
    expect(duplicate.error?.message).toContain("地址重复");
    expect(() => validateIndustryCapabilityId("workloom.approvals")).toThrow("行业命名空间");
    expect(() => validateIndustryRoutePath("/:path")).toThrow("首段");
    expect(() => validateIndustryRoutePath("/orders/*")).toThrow("不受支持");
  });

  it("历史非基座地址由同一行业能力受控重定向", () => {
    const registry = buildIndustryRouteRegistry({
      "../extensions/routes.tsx": {
        industryRoutes: [{
          path: "/orders",
          legacyPaths: ["/p10"],
          capabilityId: "hotel.orders",
          element: page,
        }],
      },
    });
    expect(registry.error).toBeNull();
    expect(registry.routes[0]?.legacyPaths).toEqual(["/p10"]);

    const aiPmRegistry = buildIndustryRouteRegistry({
      "../extensions/ai-pm/routes.tsx": {
        industryRoutes: [{
          path: "/development",
          legacyPaths: ["/p25"],
          capabilityId: "ai-pm.development",
          element: page,
        }],
      },
    });
    expect(aiPmRegistry.error).toBeNull();
    expect(aiPmRegistry.routes[0]?.legacyPaths).toEqual(["/p25"]);

    for (const protectedPath of ["/p1", "/p4", "/p6", "/p8", "/login", "/dev"]) {
      const protectedRegistry = buildIndustryRouteRegistry({
        "../extensions/routes.tsx": {
          industryRoutes: [{ path: "/orders", legacyPaths: [protectedPath], capabilityId: "hotel.orders", element: page }],
        },
      });
      expect(protectedRegistry.routes).toEqual([]);
      expect(protectedRegistry.error?.message).toContain("不得覆盖基座地址");
    }
  });

  it("历史地址不得与主路由、其他别名重复，动态参数必须完全一致", () => {
    const duplicate = buildIndustryRouteRegistry({
      "../extensions/routes.tsx": {
        industryRoutes: [{
          path: "/orders/:orderId",
          legacyPaths: ["/legacy-orders/:orderId", "/legacy-orders/:id"],
          capabilityId: "hotel.orders",
          element: page,
        }],
      },
    });
    expect(duplicate.routes).toEqual([]);
    expect(duplicate.error?.message).toMatch(/参数必须.*一致|重复/);

    const primaryCollision = buildIndustryRouteRegistry({
      "../extensions/routes.tsx": {
        industryRoutes: [{ path: "/orders", legacyPaths: ["/orders"], capabilityId: "hotel.orders", element: page }],
      },
    });
    expect(primaryCollision.routes).toEqual([]);
    expect(primaryCollision.error?.message).toContain("重复");
  });

  it("只接受服务端已验证 Bundle 中同能力、同路径域的导航", () => {
    const entries = navigationEntriesFromBundle("hotel", [{
      capabilityId: "hotel.orders",
      route: "/orders",
      title: "订单经营",
      group: "operations",
      icon: "document",
      clients: ["pc"],
      permissions: ["hotel.orders.read"],
    }]);
    expect(industryRouteMatchesBundle({ path: "/orders/:orderId", capabilityId: "hotel.orders" }, entries)).toBe(true);
    expect(industryRouteMatchesBundle({ path: "/inventory", capabilityId: "hotel.orders" }, entries)).toBe(false);
    expect(industryRouteMatchesBundle({ path: "/orders", capabilityId: "hotel.inventory" }, entries)).toBe(false);
  });

  it("以服务端 navigationPermissions 的过滤结果作为唯一放行依据", () => {
    const knownEntries = navigationEntriesFromBundle("hotel", [{
      capabilityId: "hotel.orders",
      route: "/orders",
      title: "订单经营",
      group: "operations",
      icon: "document",
      clients: ["pc"],
      permissions: ["hotel.orders.read"],
    }]);
    const definition = { path: "/orders/:orderId", capabilityId: "hotel.orders" };
    expect(resolveIndustryRouteAccess(definition, knownEntries, [])).toBe("forbidden");
    expect(resolveIndustryRouteAccess(definition, knownEntries, knownEntries)).toBe("granted");

    const noPermission = navigationEntriesFromBundle("hotel", [{
      capabilityId: "hotel.orders",
      route: "/orders",
      title: "订单经营",
      group: "operations",
      icon: "document",
      clients: ["pc"],
    }]);
    expect(resolveIndustryRouteAccess(definition, noPermission, noPermission)).toBe("misconfigured");

    // 历史地址在 App 中复用同一个 definition 进入相同边界，不产生额外授权入口。
    expect(resolveIndustryRouteAccess({ ...definition, path: "/orders/:orderId" }, knownEntries, [])).toBe("forbidden");
  });
});
