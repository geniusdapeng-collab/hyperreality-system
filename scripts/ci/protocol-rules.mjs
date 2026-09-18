/**
 * 协议规则内核（纯函数，无副作用）：
 * 供 verify-commit-msg.mjs / verify-lock-conflict.mjs / protocol-rules.test.mjs 共用。
 * 规则定义见 docs/DEVELOPMENT-PROTOCOL.md §4、§5。
 */

export const TYPES = ["feat", "fix", "sync", "protocol", "exam", "docs", "chore", "ci"];

/** 仓库 → 提交信息里的 layer 短名 */
export const LAYER_BY_REPO = {
  "workloom-im": "base",
  "workroom-andromeda": "platform",
  "workloom-hotel": "hotel",
  "hyperreality-system": "video",
  "workloom": "growth",
  "panda-cineforge": "ecom",
  "workroom-tiger": "tiger",
  "workroom-eagle": "eagle",
  "workroom-fox": "fox",
};

export const TASK_ID_RE = /\[T-\d{4}-\d{4}-\d{4}\]/;
export const SUBJECT_RE = /^([a-z][a-z-]*)\(([a-z][a-z-]*)\): (.+)$/;

/** 豁免：自动化 / 回滚 / 审计批次提交不受提交规范约束 */
export const EXEMPT_SUBJECT_RES = [
  /^Merge /,
  /^Revert /,
  /^rescue:/,
  /^sync\(/,
  /^chore\(ci\)/,
  /^chore\(deps\)/,
  /^HP-\d+/,
];

export function isExemptSubject(subject) {
  return EXEMPT_SUBJECT_RES.some((re) => re.test(String(subject ?? "")));
}

export function layerForRepo(slug) {
  const name = String(slug ?? "").split("/").pop();
  return LAYER_BY_REPO[name] ?? null;
}

/**
 * 校验单条提交标题。
 * @returns {string[]} 错误列表（空数组 = 通过）
 */
export function validateSubject(subject, options = {}) {
  const { repoSlug = null, requireTaskId = true } = options;
  const errors = [];
  const text = String(subject ?? "").trim();
  if (!text) return ["提交标题为空"];
  if (isExemptSubject(text)) return errors;

  const match = SUBJECT_RE.exec(text);
  if (!match) {
    errors.push(`格式不符：期望 "<type>(<layer>): <摘要> [T-YYYYMMDD-XXXX]"，实际 "${text}"`);
    return errors;
  }
  const [, type, layer, summary] = match;
  if (!TYPES.includes(type)) errors.push(`type "${type}" 不在允许集合 [${TYPES.join("|")}]`);
  const allowedLayers = Object.values(LAYER_BY_REPO);
  if (!allowedLayers.includes(layer)) errors.push(`layer "${layer}" 不在允许集合 [${allowedLayers.join("|")}]`);
  const expected = repoSlug ? layerForRepo(repoSlug) : null;
  if (expected && layer !== expected) errors.push(`layer "${layer}" 与本仓不符：${repoSlug} 应使用 "${expected}"`);
  if (!summary.trim()) errors.push("摘要为空");
  if (requireTaskId && !TASK_ID_RE.test(text)) {
    errors.push("缺少任务号 [T-YYYYMMDD-XXXX]（临时放宽可设 PROTOCOL_TASK_ID_OPTIONAL=1）");
  }
  return errors;
}

/** 模块级互斥路径：命中即全局独占，任何其它任务都不得同时改动 */
export const MODULE_EXCLUSIVE_KEYS = [
  "sync/",
  "protocol/",
  "migrations/",
  ".cnb.yml",
  "AGENTS.md",
  "docs/DEVELOPMENT-PROTOCOL.md",
  "root:package.json",
];

export function exclusiveModuleOf(filePath) {
  const p = String(filePath ?? "").replace(/^\.\//, "");
  if (!p) return null;
  if (!p.includes("/")) {
    if (p === ".cnb.yml") return ".cnb.yml";
    if (p === "AGENTS.md") return "AGENTS.md";
    if (p === "package.json") return "root:package.json";
    return null;
  }
  if (p === "docs/DEVELOPMENT-PROTOCOL.md") return "docs/DEVELOPMENT-PROTOCOL.md";
  if (p.startsWith("sync/")) return "sync/";
  if (p.startsWith("protocol/")) return "protocol/";
  if (/(^|\/)migrations\//.test(p)) return "migrations/";
  return null;
}

/** 同文件重叠 */
export function findFileOverlaps(mine, theirs) {
  const other = new Set(theirs);
  return [...new Set(mine)].filter((p) => other.has(p)).sort();
}

/** 模块级互斥冲突（不同文件但同一互斥模块也算冲突） */
export function findModuleConflicts(mine, theirs) {
  const mineModules = new Set(mine.map(exclusiveModuleOf).filter(Boolean));
  const conflicts = new Set();
  for (const p of theirs) {
    const key = exclusiveModuleOf(p);
    if (key && mineModules.has(key)) conflicts.add(key);
  }
  return [...conflicts].sort();
}

export function parseChangedPaths(output) {
  return String(output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseCommitLog(output) {
  return String(output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split("\u001f");
      return { sha: (sha ?? "").slice(0, 12), subject: rest.join("\u001f") };
    });
}

