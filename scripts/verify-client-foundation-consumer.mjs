#!/usr/bin/env node
/** 下游仓自包含门禁：复算三端客户端基座 state，不依赖可变远端源码。 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const STATE_FILE = ".workloom-client-foundation.json";
const GOVERNANCE_STATE = ".workloom-ui-governance.json";
const CLIENTS = Object.freeze({ bPc: "apps/web", bMobile: "apps/webb", cMobile: "apps/webc" });
const REQUIRED_MANAGED_ENTRIES = Object.freeze([
  "apps/web/src/main.tsx",
  "apps/webb/src/main.tsx",
  "apps/webc/src/main.tsx",
  "apps/webc/public/service-front.config.json",
]);
const ALLOWED_EXTENSIONS = Object.freeze([
  "apps/*/src/extensions/**",
  "apps/*/src/projections/**",
  "apps/*/src/config/industry/**",
  "apps/*/src/theme/industry/**",
  "apps/*/public/industry/**",
]);
const IGNORED = Object.freeze(["apps/*/dist/**", "apps/*/node_modules/**", "apps/*/.vite/**", "apps/*/.DS_Store"]);

const hash = (content) => createHash("sha256").update(content).digest("hex");

/**
 * 实验车道容差：仓级行业扩展路径的唯一事实源是基座 `sync/child-repos.json`，
 * 由 rollout 写进 `.workloom-ui-governance.json`。只有登记 `lane=experiment` 时才生效；
 * 缺省（非实验仓 / 未登记）= 退回基座原口径（严格模式）。
 */
function readRepoExtensionPaths(root, errors) {
  const file = join(root, GOVERNANCE_STATE);
  if (!existsSync(file)) return [];
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${GOVERNANCE_STATE} 不是有效 JSON：${String(error?.message ?? error).split("\n")[0]}`);
    return [];
  }
  if (doc?.lane !== "experiment") return [];
  const list = Array.isArray(doc?.industryExtensionPaths) ? doc.industryExtensionPaths : [];
  const accepted = [];
  for (const pattern of list) {
    if (typeof pattern !== "string" || !pattern.startsWith("apps/") || pattern.includes("..") || pattern.includes("\\")) {
      errors.push(`仓级行业扩展路径非法：${String(pattern)}`);
      continue;
    }
    accepted.push(pattern);
  }
  return accepted;
}

function globToRegExp(glob) {
  let pattern = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  pattern = pattern.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${pattern}$`);
}
const matches = (path, patterns) => patterns.some((pattern) => globToRegExp(pattern).test(path));

function safePath(root, path) {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`state 含非法受管路径：${path}`);
  }
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`受管路径逃逸：${path}`);
  let cursor = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`客户端基座禁止 symlink：${path}`);
  }
  return target;
}

function walk(root, relativeRoot) {
  const directory = join(root, relativeRoot);
  if (!existsSync(directory)) return [];
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${relativeRoot}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`客户端基座禁止 symlink：${path}`);
    if (entry.isDirectory()) {
      if (matches(`${path}/__probe__`, IGNORED)) continue;
      result.push(...walk(root, path));
    } else if (entry.isFile()) result.push(path);
  }
  return result;
}

export function verifyClientFoundationConsumer(repoPath) {
  const root = realpathSync(resolve(repoPath));
  const errors = [];
  const statePath = join(root, STATE_FILE);
  if (!existsSync(statePath)) return [`缺少 ${STATE_FILE}，无法证明三端应用壳来自稳定基座`];
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return [`${STATE_FILE} 不是有效 JSON`];
  }
  if (state.schemaVersion !== "workloom.client-foundation-state/v1") errors.push("客户端基座 state 契约版本无效");
  if (!/^\d+\.\d+\.\d+$/.test(state.version ?? "")) errors.push("客户端基座版本必须是精确稳定 semver");
  if (state.sourceRef !== `refs/tags/ui-v${state.version}`) errors.push("客户端基座来源必须是同版本 ui-v* 稳定标签");
  if (!/^[0-9a-f]{40}$/.test(state.sourceCommit ?? "")) errors.push("客户端基座缺少不可变来源提交");
  if (state.updatePolicy !== "upgrade-pr-only") errors.push("客户端基座更新策略必须为 upgrade-pr-only");
  if (JSON.stringify(state.allowedIndustryExtensionPaths) !== JSON.stringify(ALLOWED_EXTENSIONS)) {
    errors.push("行业客户端扩展白名单被修改或不完整");
  }
  for (const [key, path] of Object.entries(CLIENTS)) {
    if (state.clients?.[key] !== path) errors.push(`客户端基座 state 缺少 ${key}=${path}`);
  }

  const managed = state.managedFiles && typeof state.managedFiles === "object" ? state.managedFiles : {};
  if (Object.keys(managed).length === 0) errors.push("客户端基座 state 没有受管文件指纹");
  if (Object.keys(managed).length > 500) errors.push("客户端基座受管文件数超过安全上限 500");
  const repoExtensions = readRepoExtensionPaths(root, errors);
  for (const [path, entry] of Object.entries(managed)) {
    if (matches(path, repoExtensions)) continue;
    let target;
    try {
      target = safePath(root, path);
    } catch (error) {
      errors.push(String(error.message));
      continue;
    }
    if (!Object.values(CLIENTS).some((client) => path.startsWith(`${client}/`))) {
      errors.push(`受管文件不在三端客户端根：${path}`);
      continue;
    }
    if (!existsSync(target)) {
      errors.push(`受管客户端文件缺失：${path}`);
      continue;
    }
    if (hash(readFileSync(target)) !== entry?.sha256) errors.push(`受管客户端文件指纹漂移：${path}`);
    const mode = (lstatSync(target).mode & 0o111) ? 493 : 420;
    if (mode !== entry?.mode) errors.push(`受管客户端文件模式漂移：${path}`);
  }
  for (const entry of REQUIRED_MANAGED_ENTRIES) {
    if (!managed[entry] || !existsSync(join(root, entry))) errors.push(`客户端基座缺少受管必备入口：${entry}`);
  }
  for (const client of Object.values(CLIENTS)) {
    for (const path of walk(root, client)) {
      if (managed[path] || matches(path, ALLOWED_EXTENSIONS) || matches(path, IGNORED) || matches(path, repoExtensions)) continue;
      errors.push(`客户端根存在非白名单行业文件：${path}`);
    }
  }
  try {
    const ui = JSON.parse(readFileSync(join(root, ".workloom-ui.json"), "utf8"));
    if (ui.version !== state.version) errors.push(`共享 UI ${ui.version ?? "未登记"} 与客户端基座 ${state.version} 不同版`);
  } catch {
    errors.push("缺少或无法读取 .workloom-ui.json");
  }
  return [...new Set(errors)];
}

function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--repo");
  const repo = index >= 0 ? args[index + 1] : ".";
  const errors = verifyClientFoundationConsumer(repo);
  if (errors.length) {
    console.error(`❌ 三端客户端基座消费门禁失败（${errors.length} 项）`);
    for (const error of errors) console.error(`  · ${error}`);
    process.exit(1);
  }
  const state = JSON.parse(readFileSync(join(resolve(repo), STATE_FILE), "utf8"));
  const extras = readRepoExtensionPaths(resolve(repo), []);
  console.log(`✅ PC/B移动/C移动均来自客户端基座 ${state.version}；受管文件指纹零漂移${extras.length ? `（本仓自有扩展路径 ${extras.length} 条由基座声明豁免）` : ""}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
