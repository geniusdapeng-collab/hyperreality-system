/** PC 导航组装：基座入口来自 @workloom/ui，行业入口只接受服务端验证后的 Bundle 投影。 */
import { composeNavigation, isNavigationActive, requiredNavigationPermissions, type NavigationEntry } from "@workloom/ui";

export const NAV_ENTRIES = composeNavigation({
  client: "b-pc",
});

export function navigationForPermissions(
  permissions: ReadonlySet<string>,
  bundleEntries: readonly NavigationEntry[] = [],
): NavigationEntry[] {
  return composeNavigation({
    client: "b-pc",
    permissions,
    bundleEntries,
  });
}

/** 左栏与手输/外部打开的直达地址使用同一份服务端 grants 过滤结果。 */
export function isNavigationPathPermitted(
  pathname: string,
  knownEntries: readonly NavigationEntry[],
  grantedEntries: readonly NavigationEntry[],
): boolean {
  const target = knownEntries.find((entry) => isNavigationActive(entry, pathname));
  if (!target || requiredNavigationPermissions(target).length === 0) return true;
  return grantedEntries.some((entry) => entry.capabilityId === target.capabilityId);
}

/** 兼容旧服务端卡片中的 /p* 深链，但浏览器最终只呈现语义地址。 */
export function canonicalNavigationPath(path: string, bundleEntries: readonly NavigationEntry[] = []): string {
  if (path.startsWith("/p8/agent/")) return `/agents/${path.slice("/p8/agent/".length)}`;
  const entry = [...NAV_ENTRIES, ...bundleEntries].find((candidate) => candidate.legacyRoutes?.some((legacy) => (
    path === legacy || path.startsWith(`${legacy}/`) || path.startsWith(`${legacy}?`) || path.startsWith(`${legacy}#`)
  )));
  if (!entry) return path;
  const legacy = entry.legacyRoutes?.find((candidate) => (
    path === candidate || path.startsWith(`${candidate}/`) || path.startsWith(`${candidate}?`) || path.startsWith(`${candidate}#`)
  ));
  return legacy ? `${entry.route}${path.slice(legacy.length)}` : path;
}
