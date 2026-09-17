import { describe, expect, it } from "vitest";
import { composeNavigation } from "@workloom/ui";
import { B_MOBILE_PRIMARY_TABS, isBMobileRoute, isBMobileRoutePermitted, permittedBMobileRoutes, unsupportedBaseBMobileRoutes } from "./routes";

describe("B 端移动语义路由契约", () => {
  it("承载共享导航注册表中的每一个 B 移动入口", () => {
    expect(unsupportedBaseBMobileRoutes()).toEqual([]);
  });

  it("未知地址不得静默回到首页", () => {
    expect(isBMobileRoute("/internal_raw_page")).toBe(false);
  });

  it("共享底栏只使用现有可承载路由和中文名称", () => {
    expect(B_MOBILE_PRIMARY_TABS.map((item) => item.id).every(isBMobileRoute)).toBe(true);
    expect(new Set(B_MOBILE_PRIMARY_TABS.map((item) => item.id)).size).toBe(B_MOBILE_PRIMARY_TABS.length);
    expect(B_MOBILE_PRIMARY_TABS.every((item) => /[\u3400-\u9fff]/u.test(item.label))).toBe(true);
  });

  it("直达深链只接受服务端 grants 过滤后的入口", () => {
    const readonlyEntries = composeNavigation({
      client: "b-mobile",
      permissions: new Set(["today.read", "reports.read", "account.read"]),
    });
    expect(isBMobileRoutePermitted("/", readonlyEntries)).toBe(true);
    expect(isBMobileRoutePermitted("/operations", readonlyEntries)).toBe(true);
    expect(isBMobileRoutePermitted("/approvals", readonlyEntries)).toBe(false);
    expect(isBMobileRoutePermitted("/night", readonlyEntries)).toBe(false);
    expect(permittedBMobileRoutes(["/events", "/night", "/members"], readonlyEntries)).toEqual([]);
  });
});
