import { composeNavigation, isNavigationActive, type BottomTabItem, type NavigationEntry } from "@workloom/ui";

/** 移动端一级入口使用共享 BottomTabs 契约；id 即现有语义路由，不引入第二套路由状态。 */
export const B_MOBILE_PRIMARY_TABS = [
  { id: "/", label: "今日", icon: "home" },
  { id: "/inbox", label: "待办", icon: "inbox" },
  { id: "/tasks", label: "任务", icon: "tasks" },
  { id: "/operations", label: "经营", icon: "report" },
  { id: "/account", label: "我的", icon: "account" },
] as const satisfies readonly BottomTabItem[];

/** B 端移动生产壳实际承载的语义路由；新增基座入口必须先完成页面再进入导航。 */
export const B_MOBILE_SUPPORTED_ROUTES = new Set([
  "/",
  "/inbox",
  "/approvals",
  "/tasks",
  "/operations",
  "/reports",
  "/executive",
  "/events",
  "/exams",
  "/memory",
  "/night",
  "/models",
  "/guardrails",
  "/skills",
  "/agents",
  "/members",
  "/account",
]);

export function isBMobileRoute(pathname: string): boolean {
  return B_MOBILE_SUPPORTED_ROUTES.has(pathname);
}

/** 同一服务端授权结果约束抽屉、底栏和手输/外部打开的直达地址。 */
export function isBMobileRoutePermitted(pathname: string, entries: readonly NavigationEntry[]): boolean {
  // “经营”是移动聚合页，沿用经营报告授权，不另造客户端权限。
  const canonical = pathname === "/operations" ? "/reports" : pathname;
  return entries.some((entry) => isNavigationActive(entry, canonical));
}

/** 页内链接与壳导航复用同一判定，避免先展示无权入口、点击后再撞拦截页。 */
export function permittedBMobileRoutes(paths: readonly string[], entries: readonly NavigationEntry[]): string[] {
  return paths.filter((path) => isBMobileRoutePermitted(path, entries));
}

export function unsupportedBaseBMobileRoutes(): string[] {
  return composeNavigation({ client: "b-mobile" })
    .map((entry) => entry.route)
    .filter((route) => !B_MOBILE_SUPPORTED_ROUTES.has(route));
}
