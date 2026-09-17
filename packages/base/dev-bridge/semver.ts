/**
 * 版本建议（semver）：按变更性质给建议，人类可改——建议不是决定。
 */

export type ChangeKind = "feat" | "fix" | "breaking" | "chore";

/** 从最新 tag 与变更性质推导下一个版本号 */
export function suggestVersion(latestTag: string | null, kind: ChangeKind): string {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(latestTag ?? "");
  const [major, minor, patch] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  switch (kind) {
    case "breaking": return `v${major + 1}.0.0`;
    case "feat": return `v${major}.${minor + 1}.0`;
    case "fix": return `v${major}.${minor}.${patch + 1}`;
    case "chore": return `v${major}.${minor}.${patch + 1}`;
  }
}

/** 从任务单标题/变更统计粗判变更性质（LLM 缺位时的确定性兜底） */
export function inferChangeKind(input: { titles: string[]; filesChanged: number }): ChangeKind {
  const text = input.titles.join(" ").toLowerCase();
  if (/breaking|不兼容|破坏性/.test(text)) return "breaking";
  if (/feat|新增|特性|feature|支持/.test(text)) return "feat";
  if (/fix|修复|bug|缺陷/.test(text)) return "fix";
  return input.filesChanged > 0 ? "feat" : "chore";
}
