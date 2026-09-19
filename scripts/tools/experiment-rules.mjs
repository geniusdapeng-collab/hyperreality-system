/**
 * 实验车道规则（纯函数）：
 *  - 实验仓的定制路径（experimentPaths）必须①不被普通 base-sync include 命中（否则会被覆盖）；
 *    ②若位于三端受管根 apps/{web,webb,webc} 内，必须被（全局 ∪ 仓级）行业扩展白名单覆盖（否则 UI 升级会 fail-close）。
 */

export function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped.split("\u0000").join(".*")}$`);
}

export function matchesAny(path, patterns = []) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

export const MANAGED_CLIENT_ROOTS = ["apps/web", "apps/webb", "apps/webc"];

export function insideManagedRoot(path) {
  return MANAGED_CLIENT_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/** 把 glob 路径转成可判定的探针路径（用于 include / managed root 判定） */
export function probeOf(pattern) {
  return String(pattern).replace(/\/\*\*$/, "/probe").replace(/\*+/g, "probe");
}

/**
 * @returns {{code: string, repo: string, path: string, message: string}[]}
 */
export function auditExperimentLane({ children = [], baseScope = {} }) {
  const include = baseScope.include ?? [];
  const globalExtensions = baseScope?.clientFoundationCapability?.industryExtensionPaths ?? [];
  const findings = [];
  for (const child of children) {
    if (!child || child.lane !== "experiment") continue;
    const repo = child.repo ?? "<unknown>";
    const extras = child.industryExtensionPaths ?? [];
    if (!child.experimentNote) {
      findings.push({ code: "MISSING_NOTE", repo, path: "-", message: "实验车道仓必须写明 experimentNote（说明哪些能力属于实验语义）" });
    }
    if (!Array.isArray(child.experimentPaths) || child.experimentPaths.length === 0) {
      findings.push({ code: "MISSING_PATHS", repo, path: "-", message: "实验车道仓必须声明 experimentPaths（实验定制所在路径）" });
    }
    for (const pattern of child.experimentPaths ?? []) {
      const probe = probeOf(pattern);
      if (matchesAny(probe, include)) {
        findings.push({ code: "SYNC_WOULD_OVERWRITE", repo, path: pattern, message: "该实验路径被 base-sync include 命中，同步会覆盖实验定制" });
      }
      if (insideManagedRoot(probe) && !matchesAny(probe, [...globalExtensions, ...extras])) {
        findings.push({ code: "UI_UPGRADE_WOULD_FAIL", repo, path: pattern, message: "该实验路径在三端受管根内且不在扩展白名单内，UI 升级会计为行业分叉并 fail-close" });
      }
    }
  }
  return findings;
}
