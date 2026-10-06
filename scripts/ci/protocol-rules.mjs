/**
 * 协议规则内核（纯函数，无副作用）：
 * 供 verify-commit-msg.mjs / verify-lock-conflict.mjs / protocol-rules.test.mjs 共用。
 * 规则定义见 docs/DEVELOPMENT-PROTOCOL.md §4、§5。
 */

export const TYPES = ["feat", "fix", "sync", "protocol", "exam", "docs", "test", "chore", "ci"];

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

/**
 * 过渡期祖父规则：早于该时刻的提交只校验 type（存量分支与并行车道不追溯）；
 * 之后的新提交必须满足 type + 任务号；layer 仅作告警。
 */
export const STRICT_COMMIT_SINCE = "2026-09-19T00:00:00+08:00";

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

export function isLegacyCommit(dateIso) {
  if (!dateIso) return false;
  const time = Date.parse(dateIso);
  if (Number.isNaN(time)) return false;
  return time < Date.parse(STRICT_COMMIT_SINCE);
}

export function layerForRepo(slug) {
  const name = String(slug ?? "").split("/").pop();
  return LAYER_BY_REPO[name] ?? null;
}

/**
 * 校验单条提交标题。
 * 硬失败：格式、type 非法、摘要为空、缺任务号（过渡期后）。
 * 仅告警：layer 不在标准集合 / 与本仓不一致。
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateSubject(subject, options = {}) {
  const { repoSlug = null, requireTaskId = true } = options;
  const errors = [];
  const warnings = [];
  const text = String(subject ?? "").trim();
  if (!text) return { errors: ["提交标题为空"], warnings };
  if (isExemptSubject(text)) return { errors, warnings };

  const match = SUBJECT_RE.exec(text);
  if (!match) {
    return {
      errors: [`格式不符：期望 "<type>(<layer>): <摘要> [T-YYYY-MMDD-XXXX]"，实际 "${text}"`],
      warnings,
    };
  }
  const [, type, layer, summary] = match;
  if (!TYPES.includes(type)) errors.push(`type "${type}" 不在允许集合 [${TYPES.join("|")}]`);

  const allowedLayers = Object.values(LAYER_BY_REPO);
  if (!allowedLayers.includes(layer)) {
    warnings.push(`layer "${layer}" 不在标准集合 [${allowedLayers.join("|")}]（仅告警）`);
  }
  const expected = repoSlug ? layerForRepo(repoSlug) : null;
  if (expected && layer !== expected) {
    warnings.push(`layer "${layer}" 与本仓不符：${repoSlug} 建议使用 "${expected}"（仅告警）`);
  }
  if (!summary.trim()) errors.push("摘要为空");
  if (requireTaskId && !TASK_ID_RE.test(text)) {
    errors.push("缺少任务号 [T-YYYYMMDD-XXXX]（临时放宽可设 PROTOCOL_TASK_ID_OPTIONAL=1）");
  }
  return { errors, warnings };
}

/**
 * 按提交粒度校验：过渡期内的提交只要求 type 合法；之后按完整规则。
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateCommit({ subject, date }, options = {}) {
  const text = String(subject ?? "").trim();
  if (isExemptSubject(text)) return { errors: [], warnings: [] };
  const match = SUBJECT_RE.exec(text);
  if (!match) {
    return { errors: [`格式不符：期望 "<type>(<layer>): <摘要> [T-YYYYMMDD-XXXX]"，实际 "${text}"`], warnings: [] };
  }
  const [, type] = match;
  if (!TYPES.includes(type)) return { errors: [`type "${type}" 不在允许集合 [${TYPES.join("|")}]`], warnings: [] };

  if (isLegacyCommit(date)) {
    const full = validateSubject(text, options);
    const warnings = full.warnings.slice();
    for (const error of full.errors) {
      warnings.push(`过渡期宽限（提交早于 ${STRICT_COMMIT_SINCE}）：${error}`);
    }
    return { errors: [], warnings };
  }
  return validateSubject(text, options);
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

/**
 * 锁冲突门禁的处置级别（协议 §4 的 push / PR 语义分离）。
 *
 * 背景（2026-09-27 实测）：push 事件（即 main 上的合并提交）下，门禁会把**已经合入的提交**
 * 与**在途 PR** 比文件重叠。合并已经发生、门禁再拦也拦不住，只会把 main 打成红：
 * 实例 = workloom-growth PR #211 合入后，因在途 #206/#209 同改 `bundles/ai-video/bundle.json`
 * → `cnb/push/pipeline-1(static-gate)` 红，而同一内容在 PR 门禁下三门禁全绿。
 *
 * 语义：
 * - **PR 事件**：`warn`（真实开发互斥改由有期限的敏感模块租约承担）；
 * - **push 事件**：`warn`（只提醒重叠的在途 PR "需要 rebase 后重跑"，不判红）；
 * - `LOCK_OVERLAP_MODE=fail|warn` 可显式覆盖事件默认；`--strict` 强制 `fail`（人工复核用）。
 */
export function resolveLockOverlapMode({ event = null, envMode = null, strict = false } = {}) {
  if (strict) return "fail";
  if (envMode === "fail" || envMode === "warn") return envMode;
  return "warn";
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
      const [sha, date, ...rest] = line.split("\u001f");
      return { sha: (sha ?? "").slice(0, 12), date: date ?? "", subject: rest.join("\u001f") };
    });
}
