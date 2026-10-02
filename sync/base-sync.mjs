#!/usr/bin/env node
/**
 * WorkLoom IM · 基座能力同步引擎（Node >= 20，零第三方依赖）
 *
 *   detect --repo <子仓基座目录> [--base-dir <本地基座>]
 *   pull   --repo <子仓基座目录> [--base-dir <本地基座>] [--no-commit]
 *   push   --base <本地基座> --dry-run（只读计划；实际下发用 fanout-cnb 的 PR 通道）
 *
 * 行业代码仍写入 --repo/pathPrefix 指向的目录；requiredRootAssets 始终写入
 * 目标 Git 仓库根目录。AGENTS.md 只同步受控标记块，绝不覆盖仓库自有说明。
 * --required-only 仅安装/校验根级必备资产与根级 state，不触碰其余基座文件。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { bindUiLockfileIntegrity } from "./ui-lockfile-integrity.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const DEFAULT_BASE_REPO = "workloom-ai/workloom-im";
const STATE_FILE = ".workloom-base-sync.json";
const UI_STATE_FILE = ".workloom-ui.json";
const MODULE_SOURCE_EXTENSIONS = Object.freeze([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]);

function parseArgs(argv) {
  const mode = argv[0];
  const opt = (name, dft = "") => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : dft;
  };
  const has = (name) => argv.includes(name);
  return {
    mode,
    repo: opt("--repo"),
    base: opt("--base"),
    baseDir: opt("--base-dir"),
    baseUrl: opt("--base-url", "https://cnb.cool"),
    extraExclude: opt("--extra-exclude") ? opt("--extra-exclude").split(",").filter(Boolean) : [],
    dryRun: has("--dry-run"),
    json: has("--json"),
    push: has("--push"),
    noCommit: has("--no-commit"),
    requiredOnly: has("--required-only"),
    adopt: has("--adopt"),
  };
}

/* ---------------- 安全的命令执行与认证 ---------------- */
function redact(value, token = process.env.GH_TOKEN || "") {
  let text = String(value ?? "");
  const secrets = [token, token ? encodeURIComponent(token) : "", token ? Buffer.from(`x-access-token:${token}`).toString("base64") : ""].filter(Boolean);
  for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/(https?:\/\/)[^/@\s]+@/g, "$1[REDACTED]@");
}

function gitAuthEnv(token = process.env.GH_TOKEN || "") {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!token) return env;
  const count = Number.parseInt(env.GIT_CONFIG_COUNT || "0", 10) || 0;
  env.GIT_CONFIG_COUNT = String(count + 1);
  env[`GIT_CONFIG_KEY_${count}`] = "http.https://github.com/.extraHeader";
  env[`GIT_CONFIG_VALUE_${count}`] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return env;
}

function sh(cmd, cmdArgs, cwd, { auth = false } = {}) {
  try {
    return execFileSync(cmd, cmdArgs, {
      cwd,
      encoding: "utf8",
      env: auth ? gitAuthEnv() : { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    const detail = redact(stderr || error?.message || `${cmd} 执行失败`);
    throw new Error(detail.slice(0, 2000));
  }
}

const git = (cwd, ...args) => sh("git", args, cwd);

function credentialFreeRemote(url) {
  if (/^https?:\/\//i.test(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new Error(`远端 URL 不得包含凭据：${redact(url)}`);
  }
  return url;
}

function canSendGithubHeader(url) {
  if (!process.env.GH_TOKEN || !/^https?:\/\//i.test(url)) return false;
  try {
    return new URL(url).origin === "https://github.com";
  } catch {
    return false;
  }
}

function gitNetwork(cwd, remoteUrl, ...args) {
  const safeUrl = credentialFreeRemote(remoteUrl);
  return sh("git", args, cwd, { auth: canSendGithubHeader(safeUrl) });
}

function repoUrl(baseUrl, repo) {
  return credentialFreeRemote(`${baseUrl.replace(/\/$/, "")}/${repo}.git`);
}

function assertClean(repoRoot, action) {
  const dirty = git(repoRoot, "status", "--porcelain=v1", "--untracked-files=all");
  if (dirty) {
    const lines = dirty.split("\n");
    const paths = lines.slice(0, 8).map((line) => line.slice(3)).join(", ");
    throw new Error(`拒绝${action}：目标仓库存在未提交改动（${paths}${lines.length > 8 ? " …" : ""}）。请先提交或暂存到其他工作树。`);
  }
}

/* ---------------- scope 与内容工具 ---------------- */
function globToRegExp(glob) {
  let pattern = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  pattern = pattern.replace(/\*\*/g, "\u0000");
  pattern = pattern.replace(/\*/g, "[^/]*");
  pattern = pattern.replace(/\u0000/g, ".*");
  return new RegExp(`^${pattern}$`);
}

function assertSafeRelative(path, label) {
  const raw = String(path);
  const segments = raw.split("/");
  if (
    !raw ||
    raw.includes("\\") ||
    raw.includes("\u0000") ||
    raw.includes("\n") ||
    raw.includes("\r") ||
    raw.startsWith("/") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} 必须是仓库内安全相对路径：${redact(path)}`);
  }
  return raw;
}

function assertContained(root, path, label) {
  const rootPath = resolve(root);
  const targetPath = resolve(path);
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`${label} 逃逸出受控根目录：${redact(path)}`);
  }
  return targetPath;
}

function assertNoSymlinkPath(root, path, label, { allowMissing = true } = {}) {
  const lexicalRoot = resolve(root);
  const lexicalTarget = assertContained(lexicalRoot, path, label);
  const rootPath = realpathSync(lexicalRoot);
  const targetPath = join(rootPath, relative(lexicalRoot, lexicalTarget));
  assertContained(rootPath, targetPath, label);
  const rel = relative(rootPath, targetPath);
  let cursor = rootPath;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!allowMissing) throw new Error(`${label} 不存在：${relative(rootPath, cursor)}`);
      break;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} 不允许 symlink：${relative(rootPath, cursor)}`);
    }
  }
  return targetPath;
}

function isContained(root, path) {
  const rootPath = resolve(root);
  const targetPath = resolve(path);
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${sep}`);
}

function resolveChildTarget(requested) {
  const lexicalTarget = resolve(requested);
  let targetStat;
  try {
    targetStat = lstatSync(lexicalTarget);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`--repo 目录不存在：${lexicalTarget}`);
    throw error;
  }
  if (targetStat.isSymbolicLink()) throw new Error("--repo 目标路径不允许 symlink");
  if (!targetStat.isDirectory()) throw new Error("--repo 必须指向目录");

  const childDir = realpathSync(lexicalTarget);
  const repoRoot = realpathSync(resolve(git(lexicalTarget, "rev-parse", "--show-toplevel")));
  if (!isContained(repoRoot, childDir)) throw new Error("--repo 解析后逃逸出目标 Git 工作树");

  // 从目标路径逐层向上找物理 Git 根。每一层都先 lstat，因此即使某个
  // pathPrefix 中间段是指向另一仓库的 symlink，也会在 realpath 前被拒绝。
  let lexicalRoot = lexicalTarget;
  while (realpathSync(lexicalRoot) !== repoRoot) {
    const parent = dirname(lexicalRoot);
    if (parent === lexicalRoot) throw new Error("--repo 无法映射回目标 Git 根目录");
    lexicalRoot = parent;
    const stat = lstatSync(lexicalRoot);
    if (stat.isSymbolicLink()) {
      throw new Error(`--repo 目标路径不允许 symlink：${lexicalRoot}`);
    }
  }
  assertNoSymlinkPath(lexicalRoot, lexicalTarget, "--repo 目标路径", { allowMissing: false });
  return { childDir, repoRoot };
}

function validateScope(scope, baseDir) {
  const required = scope.requiredRootAssets;
  if (!required || !Array.isArray(required.files) || typeof required.managedSections !== "object") {
    throw new Error("base-scope.json 缺少 requiredRootAssets.files/managedSections");
  }
  for (const path of required.files) {
    const safePath = assertSafeRelative(path, "required root asset");
    assertNoSymlinkPath(baseDir, join(baseDir, safePath), `required root asset ${safePath}`, { allowMissing: false });
  }
  for (const [path, config] of Object.entries(required.managedSections)) {
    const safePath = assertSafeRelative(path, "managed section path");
    assertNoSymlinkPath(baseDir, join(baseDir, safePath), `managed section ${safePath}`, { allowMissing: false });
    extractManagedSection(readFileSync(join(baseDir, safePath), "utf8"), config, safePath);
  }
  for (const [target, config] of Object.entries(required.copiedFiles ?? {})) {
    const safeTarget = assertSafeRelative(target, "copied root asset target");
    const source = assertSafeRelative(config.source, `copied root asset ${safeTarget} source`);
    assertNoSymlinkPath(baseDir, join(baseDir, source), `copied root asset source ${source}`, { allowMissing: false });
  }
  if (typeof scope.preCommitSecretScanner !== "string") throw new Error("base-scope.json 缺少 preCommitSecretScanner");
  const scanner = assertSafeRelative(scope.preCommitSecretScanner, "preCommitSecretScanner");
  assertNoSymlinkPath(baseDir, join(baseDir, scanner), `pre-commit scanner ${scanner}`, { allowMissing: false });
  for (const [path, acceptance] of Object.entries(scope.acceptedBaseSecretScanFindings ?? {})) {
    const safePath = assertSafeRelative(path, "accepted base secret finding path");
    const source = join(baseDir, safePath);
    assertNoSymlinkPath(baseDir, source, `accepted base secret finding source ${safePath}`, { allowMissing: false });
    if (!/^[0-9a-f]{64}$/.test(acceptance?.sha256 ?? "") || sha256(readFileSync(source)) !== acceptance.sha256) {
      throw new Error(`accepted base secret finding 内容摘要失配：${safePath}`);
    }
    if (typeof acceptance.reason !== "string" || !acceptance.reason.trim() || !Array.isArray(acceptance.findings) || !acceptance.findings.length) {
      throw new Error(`accepted base secret finding 缺少审计理由或精确 finding：${safePath}`);
    }
    const findings = new Set();
    const lineCount = readFileSync(source, "utf8").split("\n").length;
    for (const finding of acceptance.findings) {
      if (
        typeof finding?.rule !== "string" || !finding.rule ||
        !Number.isInteger(finding?.line) || finding.line < 1 || finding.line > lineCount
      ) {
        throw new Error(`accepted base secret finding 非法：${safePath}`);
      }
      const key = `${finding.rule}\0${finding.line}`;
      if (findings.has(key)) throw new Error(`accepted base secret finding 重复：${safePath}:${finding.line}`);
      findings.add(key);
    }
  }
  for (const [path, config] of Object.entries(scope.adoptMigrations ?? {})) {
    const safePath = assertSafeRelative(path, "adopt migration path");
    if (!["replace-if-identical-to-base", "remove-if-identical-to-base"].includes(config.strategy)) {
      throw new Error(`adopt migration ${safePath} strategy 不受支持`);
    }
    if (config.strategy === "replace-if-identical-to-base" && typeof config.scaffold !== "string") {
      throw new Error(`adopt migration ${safePath} 缺少 scaffold`);
    }
    assertNoSymlinkPath(baseDir, join(baseDir, safePath), `adopt migration source ${safePath}`, { allowMissing: false });
  }
  for (const [path, config] of Object.entries(scope.anchorMerge ?? {})) {
    assertSafeRelative(path, "anchor merge path");
    if (!Array.isArray(config.mergeKeys)) throw new Error(`anchor merge ${path} 缺少 mergeKeys`);
    if (config.ignoreDependencyKeys !== undefined && !Array.isArray(config.ignoreDependencyKeys)) {
      throw new Error(`anchor merge ${path} 的 ignoreDependencyKeys 必须是数组`);
    }
  }
  if (scope.publicAppendOnlyFiles !== undefined && !Array.isArray(scope.publicAppendOnlyFiles)) {
    throw new Error("publicAppendOnlyFiles 必须是安全相对路径数组");
  }
  const publicAppendOnlyFiles = new Set();
  const rawIncludesForAppend = (scope.include ?? []).map(globToRegExp);
  const rawExcludesForAppend = (scope.exclude ?? []).map(globToRegExp);
  for (const path of scope.publicAppendOnlyFiles ?? []) {
    const safePath = assertSafeRelative(path, "public append-only file");
    if (publicAppendOnlyFiles.has(safePath)) throw new Error(`public append-only file 重复：${safePath}`);
    publicAppendOnlyFiles.add(safePath);
    assertNoSymlinkPath(baseDir, join(baseDir, safePath), `public append-only source ${safePath}`, { allowMissing: false });
    if (!hitAny(rawIncludesForAppend, safePath) || !hitAny(rawExcludesForAppend, safePath)) {
      throw new Error(`public append-only file 必须位于普通 include 内且被普通 exclude 隔离：${safePath}`);
    }
  }
  if (scope.newIndustryBootstrapFiles !== undefined && !Array.isArray(scope.newIndustryBootstrapFiles)) {
    throw new Error("newIndustryBootstrapFiles 必须是安全相对路径数组");
  }
  const newIndustryBootstrapFiles = new Set();
  for (const path of scope.newIndustryBootstrapFiles ?? []) {
    const safePath = assertSafeRelative(path, "new industry bootstrap file");
    if (newIndustryBootstrapFiles.has(safePath)) throw new Error(`new industry bootstrap file 重复：${safePath}`);
    newIndustryBootstrapFiles.add(safePath);
    assertNoSymlinkPath(baseDir, join(baseDir, safePath), `new industry bootstrap source ${safePath}`, { allowMissing: false });
    if (!hitAny(rawIncludesForAppend, safePath) || !hitAny(rawExcludesForAppend, safePath)) {
      throw new Error(`new industry bootstrap file 必须位于普通 include 内且被普通 exclude 隔离：${safePath}`);
    }
  }
  if (!Number.isInteger(scope.pollutionGuard?.maxFilesPerSync) || scope.pollutionGuard.maxFilesPerSync < 1) {
    throw new Error("pollutionGuard.maxFilesPerSync 必须是正整数");
  }
  if (!Number.isInteger(scope.pollutionGuard?.maxFilesPerAdopt)
    || scope.pollutionGuard.maxFilesPerAdopt < scope.pollutionGuard.maxFilesPerSync) {
    throw new Error("pollutionGuard.maxFilesPerAdopt 必须是不小于 maxFilesPerSync 的正整数");
  }
  for (const capability of scope.registryCapabilities ?? []) {
    if (typeof capability.package !== "string" || !capability.package) throw new Error("registry capability 缺少 package");
    if (!Array.isArray(capability.consumers) || capability.consumers.length === 0) {
      throw new Error(`registry capability ${capability.package} 缺少 consumers`);
    }
    for (const consumer of capability.consumers) assertSafeRelative(consumer, `${capability.package} consumer`);
    const gate = assertSafeRelative(capability.consumerGate, `${capability.package} consumerGate`);
    assertNoSymlinkPath(baseDir, join(baseDir, gate), `${capability.package} consumerGate`, { allowMissing: false });
    if (capability.distribution !== "stable-github-release-upgrade-pr") {
      throw new Error(`release artifact capability ${capability.package} 必须通过 stable-github-release-upgrade-pr 分发`);
    }
  }
    // 仓级实验扩展路径（实验车道）：形状必须与全局白名单同级，否则拒绝同步
  for (const child of scope?.requiredRootAssets ? [] : []) void child;
  const childInventory = (() => {
    try {
      return JSON.parse(readFileSync(join(baseDir, "sync/child-repos.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  for (const child of childInventory?.children ?? []) {
    for (const pattern of child.industryExtensionPaths ?? []) {
      if (typeof pattern !== "string" || !pattern.startsWith("apps/") || pattern.includes("..")) {
        throw new Error(`非法仓级实验扩展路径（${child.repo}）：${pattern}`);
      }
    }
    if (child.lane === "experiment" && !child.experimentNote) {
      throw new Error(`实验车道仓必须写明 experimentNote：${child.repo}`);
    }
  }
const foundation = scope.clientFoundationCapability;
  if (foundation) {
    if (foundation.distribution !== "stable-tag-upgrade-pr") {
      throw new Error("三端客户端基座必须通过 stable-tag-upgrade-pr 分发");
    }
    if (foundation.conflictPolicy !== "previous-source-sha256-fail-close") {
      throw new Error("三端客户端基座必须采用旧基座 SHA-256 冲突关闭策略");
    }
    const foundationInstaller = assertSafeRelative(foundation.installer, "client foundation installer");
    assertNoSymlinkPath(baseDir, join(baseDir, foundationInstaller), "client foundation installer", { allowMissing: false });
    for (const clientRoot of ["apps/web", "apps/webb", "apps/webc"]) {
      const probe = `${clientRoot}/__workloom_foundation_probe__`;
      const excluded = (scope.exclude ?? []).some((pattern) => globToRegExp(pattern).test(probe));
      if (!excluded) throw new Error(`三端受管根必须排除普通 base-sync，防止双通道覆盖：${clientRoot}`);
    }
    for (const pattern of foundation.industryExtensionPaths ?? []) {
      if (typeof pattern !== "string" || !pattern.startsWith("apps/") || pattern.includes("..")) {
        throw new Error(`非法三端行业扩展路径：${pattern}`);
      }
    }
  }
  const uiGovernance = scope.uiGovernanceCapability;
  if (!uiGovernance || uiGovernance.distribution !== "stable-upgrade-pr-only") {
    throw new Error("UI 消费治理单元必须通过 stable-upgrade-pr-only 分发");
  }
  const governanceInstaller = assertSafeRelative(uiGovernance.installer, "UI governance installer");
  assertNoSymlinkPath(baseDir, join(baseDir, governanceInstaller), "UI governance installer", { allowMissing: false });
  if (uiGovernance.stateFile !== ".workloom-ui-governance.json") {
    throw new Error("UI 消费治理单元必须使用受控 .workloom-ui-governance.json state");
  }
  if (uiGovernance.dependency !== "npm:typescript@5.9.3") {
    throw new Error("UI 消费治理单元必须固定 typescript-governance 解析器");
  }
  if (uiGovernance.yamlDependency !== "npm:yaml@2.9.0") {
    throw new Error("UI 消费治理单元必须固定 yaml-governance 解析器");
  }
  if (!Array.isArray(uiGovernance.managedFiles) || uiGovernance.managedFiles.length === 0) {
    throw new Error("UI 消费治理单元缺少 managedFiles");
  }
  const governanceFiles = new Set();
  for (const path of uiGovernance.managedFiles) {
    const safePath = assertSafeRelative(path, "UI governance managed file");
    if (governanceFiles.has(safePath)) throw new Error(`UI governance managed file 重复：${safePath}`);
    governanceFiles.add(safePath);
    assertNoSymlinkPath(baseDir, join(baseDir, safePath), `UI governance managed file ${safePath}`, { allowMissing: false });
    const excluded = (scope.exclude ?? []).some((pattern) => globToRegExp(pattern).test(safePath));
    if (!excluded) throw new Error(`UI governance managed file 必须排除普通 base-sync，防止双通道覆盖：${safePath}`);
    if (scope.anchorMerge?.[safePath]) throw new Error(`UI governance managed file 不得作为锚点合并目标：${safePath}`);
  }
  const protectedFiles = scope.protectedChildAssets?.files ?? [];
  for (const path of protectedFiles) {
    const safePath = assertSafeRelative(path, "protected child asset");
    const excluded = (scope.exclude ?? []).some((pattern) => globToRegExp(pattern).test(safePath));
    if (!excluded) throw new Error(`受保护的子仓资产必须显式排除整文件同步：${safePath}`);
    if (scope.anchorMerge?.[safePath]) throw new Error(`受保护的子仓资产不得作为锚点合并目标：${safePath}`);
  }
  if (scope.perProductDerivedAssets !== undefined && !Array.isArray(scope.perProductDerivedAssets)) {
    throw new Error("base-scope.json 的 perProductDerivedAssets 必须是数组");
  }
  const derivedDirectories = new Set();
  for (const asset of scope.perProductDerivedAssets ?? []) {
    const directory = assertSafeRelative(asset?.directory, "产品派生资产目录");
    if (derivedDirectories.has(directory)) throw new Error(`产品派生资产目录重复：${directory}`);
    derivedDirectories.add(directory);
    if (!Array.isArray(asset.files) || asset.files.length === 0) throw new Error(`产品派生资产 ${directory} 缺少 files`);
    for (const file of asset.files) assertSafeRelative(`${directory}/${file}`, `产品派生资产 ${directory} 文件`);
    const generator = assertSafeRelative(asset.generator, `产品派生资产 ${directory} generator`);
    assertNoSymlinkPath(baseDir, join(baseDir, generator), `产品派生资产生成器 ${generator}`, { allowMissing: false });
    if (asset.strategy !== "preserve-and-regenerate-after-product-lockfile") {
      throw new Error(`产品派生资产 ${directory} 策略不受支持`);
    }
    if (!Array.isArray(asset.refreshArgs) || asset.refreshArgs.length === 0 || !Array.isArray(asset.verifyArgs) || asset.verifyArgs.length === 0) {
      throw new Error(`产品派生资产 ${directory} 缺少 refreshArgs/verifyArgs`);
    }
    const probe = `${directory}/__workloom_derived_probe__`;
    if ((scope.include ?? []).some((pattern) => globToRegExp(pattern).test(probe))) {
      throw new Error(`产品派生资产不得进入普通 base-sync include：${directory}`);
    }
  }
  const closure = scope.dependencyClosure;
  if (!closure || closure.relativeImports !== "fail-closed" || !Array.isArray(closure.allowedExcludedTargets)) {
    throw new Error("base-scope.json 必须启用 dependencyClosure.relativeImports=fail-closed 并显式声明 allowedExcludedTargets");
  }
  const closurePairs = new Set();
  const rawIncludes = (scope.include ?? []).map(globToRegExp);
  const rawExcludes = (scope.exclude ?? []).map(globToRegExp);
  for (const entry of closure.allowedExcludedTargets) {
    const importer = assertSafeRelative(entry.importer, "dependency closure importer");
    const target = assertSafeRelative(entry.target, "dependency closure target");
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      throw new Error(`dependency closure 例外缺少原因：${importer} -> ${target}`);
    }
    if (!existsSync(join(baseDir, importer)) || !existsSync(join(baseDir, target))) {
      throw new Error(`dependency closure 例外引用不存在文件：${importer} -> ${target}`);
    }
    const pair = `${importer}\0${target}`;
    if (closurePairs.has(pair)) throw new Error(`dependency closure 例外重复：${importer} -> ${target}`);
    closurePairs.add(pair);
    if (hitAny(rawExcludes, importer) || !hitAny(rawIncludes, importer)) {
      throw new Error(`dependency closure 例外来源并未下发：${importer}`);
    }
    if (!hitAny(rawExcludes, target)) {
      throw new Error(`dependency closure 例外目标未被显式排除，无需例外：${target}`);
    }
    const importedTargets = moduleSpecifiers(readFileSync(join(baseDir, importer), "utf8"))
      .map((specifier) => resolveRelativeModule(baseDir, importer, specifier))
      .filter(Boolean);
    if (!importedTargets.includes(target)) {
      throw new Error(`dependency closure 例外没有对应的相对依赖：${importer} -> ${target}`);
    }
  }
}

function loadScope(baseDir) {
  const raw = JSON.parse(readFileSync(join(baseDir, "sync/base-scope.json"), "utf8"));
  validateScope(raw, baseDir);
  return {
    raw,
    includes: raw.include.map(globToRegExp),
    excludes: raw.exclude.map(globToRegExp),
    publicAppendOnlyFiles: new Set(raw.publicAppendOnlyFiles ?? []),
    newIndustryBootstrapFiles: new Set(raw.newIndustryBootstrapFiles ?? []),
  };
}

function withExtraExclude(scope, extraExclude = []) {
  if (!extraExclude.length) return scope;
  return { ...scope, excludes: [...scope.excludes, ...extraExclude.map(globToRegExp)] };
}

const hitAny = (patterns, path) => patterns.some((pattern) => pattern.test(path));
const inScope = (scope, path) => !hitAny(scope.excludes, path) && hitAny(scope.includes, path);

function moduleSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /^\s*import\s*(?:type\s*)?["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return [...new Set(specifiers)];
}

function resolveRelativeModule(baseDir, importer, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  const importerPath = join(baseDir, importer);
  const requested = assertContained(baseDir, resolve(dirname(importerPath), cleanSpecifier), `模块依赖 ${importer} -> ${specifier}`);
  const candidates = [requested];
  const extension = MODULE_SOURCE_EXTENSIONS.find((suffix) => requested.endsWith(suffix));
  if (extension) {
    const stem = requested.slice(0, -extension.length);
    for (const suffix of MODULE_SOURCE_EXTENSIONS) candidates.push(`${stem}${suffix}`);
  } else {
    for (const suffix of MODULE_SOURCE_EXTENSIONS) candidates.push(`${requested}${suffix}`);
  }
  for (const suffix of MODULE_SOURCE_EXTENSIONS) candidates.push(join(requested, `index${suffix}`));
  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate)) continue;
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error(`模块依赖目标不允许 symlink：${relative(baseDir, candidate)}`);
    if (stat.isFile()) return relative(baseDir, candidate).split(sep).join("/");
  }
  return "";
}

function dependencyClosureViolations(baseDir, scope) {
  const allowed = new Set((scope.raw.dependencyClosure?.allowedExcludedTargets ?? [])
    .map((entry) => `${entry.importer}\0${entry.target}`));
  const violations = [];
  const sourcePaths = [...walk(baseDir)]
    .map((path) => path.split(sep).join("/"))
    .filter((path) => inScope(scope, path) && /\.(?:[cm]?[jt]sx?|json)$/.test(path));
  for (const importer of sourcePaths) {
    if (importer.endsWith(".json")) continue;
    const source = readFileSync(join(baseDir, importer), "utf8");
    for (const specifier of moduleSpecifiers(source)) {
      const target = resolveRelativeModule(baseDir, importer, specifier);
      if (target === null) continue;
      if (!target) {
        violations.push({ importer, specifier, target: null, reason: "relative-target-missing" });
        continue;
      }
      if (!inScope(scope, target) && !allowed.has(`${importer}\0${target}`)) {
        violations.push({ importer, specifier, target, reason: "relative-target-excluded" });
      }
    }
  }
  return violations;
}

function assertDependencyClosure(baseDir, scope) {
  const violations = dependencyClosureViolations(baseDir, scope);
  if (!violations.length) return;
  const detail = violations.slice(0, 8).map((item) => (
    item.target
      ? `${item.importer} -> ${item.target}（目标未下发）`
      : `${item.importer} -> ${item.specifier}（目标不存在）`
  )).join("；");
  throw new Error(`基座同步依赖闭包失败（${violations.length} 项）：${detail}`);
}

function assertChildDependencySeams(childDir, repoRoot, scope) {
  const targets = [...new Set((scope.raw.dependencyClosure?.allowedExcludedTargets ?? [])
    .filter((entry) => inScope(scope, entry.importer))
    .map((entry) => entry.target))];
  const missing = [];
  for (const target of targets) {
    const path = join(childDir, target);
    assertNoSymlinkPath(repoRoot, path, `子仓依赖缝 ${target}`);
    if (!existsSync(path) || !lstatSync(path).isFile()) missing.push(target);
  }
  if (missing.length) {
    throw new Error(`子仓缺少 ${missing.length} 个明确保留的依赖实现，拒绝登记完整基座同步：${missing.slice(0, 8).join("、")}`);
  }
}

function* walk(dir, base = dir) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", ".dsh-home"].includes(name)) continue;
    const full = join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) yield relative(base, full);
    else if (stat.isDirectory()) yield* walk(full, base);
    else yield relative(base, full);
  }
}

function controlledSourcePaths(baseDir, scope, requiredOnly, additionalPaths = []) {
  const paths = [
    "sync/base-sync.mjs",
    "sync/base-scope.json",
    scope.raw.preCommitSecretScanner,
    ...scope.raw.requiredRootAssets.files,
    ...Object.keys(scope.raw.requiredRootAssets.managedSections),
    ...Object.values(scope.raw.requiredRootAssets.copiedFiles ?? {}).map((config) => config.source),
    ...additionalPaths,
  ];
  if (!requiredOnly) {
    paths.push(...[...walk(baseDir)].filter((path) => inScope(scope, path)));
    paths.push(...(scope.raw.publicAppendOnlyFiles ?? []));
  }
  return [...new Set(paths.map((path) => assertSafeRelative(path, "受控源文件")))].sort();
}

function verifyBaseSourcesAtHead(baseDir, scope, requiredOnly, additionalPaths = []) {
  const root = realpathSync(resolve(git(baseDir, "rev-parse", "--show-toplevel")));
  if (root !== realpathSync(resolve(baseDir))) throw new Error(`--base-dir 必须指向基座 Git 根目录：${root}`);
  const paths = controlledSourcePaths(baseDir, scope, requiredOnly, additionalPaths);
  for (const path of paths) assertNoSymlinkPath(baseDir, join(baseDir, path), `受控源文件 ${path}`, { allowMissing: false });

  const status = git(baseDir, "status", "--porcelain=v1", "--untracked-files=all", "--", ...paths);
  if (status) {
    const changed = status.split("\n").slice(0, 8).map((line) => line.slice(3)).join(", ");
    throw new Error(`基座受控源文件与 HEAD 不一致：${changed}`);
  }

  const worktreeHashes = git(baseDir, "hash-object", "--", ...paths).split("\n").filter(Boolean);
  const headHashes = git(baseDir, "rev-parse", ...paths.map((path) => `HEAD:${path}`)).split("\n").filter(Boolean);
  if (worktreeHashes.length !== paths.length || headHashes.length !== paths.length) {
    throw new Error("基座受控源文件必须全部由当前 HEAD 跟踪");
  }
  for (let index = 0; index < paths.length; index += 1) {
    if (worktreeHashes[index] !== headHashes[index]) throw new Error(`基座受控源文件与 HEAD 字节不一致：${paths[index]}`);
  }

  if (!requiredOnly) assertDependencyClosure(baseDir, scope);

  const engineInBase = join(baseDir, "sync/base-sync.mjs");
  if (!readFileSync(SCRIPT_PATH).equals(readFileSync(engineInBase))) {
    throw new Error("当前执行的 base-sync.mjs 与 --base-dir HEAD 中的引擎不一致");
  }
  return { baseSha: git(baseDir, "rev-parse", "HEAD"), paths };
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function markerCount(content, marker) {
  return content.split(marker).length - 1;
}

function extractManagedSection(content, config, path = "AGENTS.md") {
  const { beginMarker, endMarker } = config;
  const begins = markerCount(content, beginMarker);
  const ends = markerCount(content, endMarker);
  if (begins !== 1 || ends !== 1) {
    throw new Error(`${path} 的 WorkLoom 受控标记必须且只能各出现一次（BEGIN=${begins}, END=${ends}）`);
  }
  const begin = content.indexOf(beginMarker);
  const end = content.indexOf(endMarker, begin + beginMarker.length);
  if (end < begin) throw new Error(`${path} 的 WorkLoom 受控标记顺序错误`);
  return content.slice(begin, end + endMarker.length);
}

function managedScaffold(section, config) {
  const prefix = (config.missingFilePrefix ?? "# WorkLoom 仓库开发指引").trim();
  const suffix = (config.missingFileSuffix ?? "## 本仓专属规则\n\n请在此补充本仓约定，或写入根级 AGENTS.repo.md。").trim();
  return `${prefix}\n\n${section}\n\n${suffix}\n`;
}

function mergeManagedSectionDetailed(baseContent, childContent, config, path = "AGENTS.md") {
  const section = extractManagedSection(baseContent, config, path);
  if (!childContent.trim()) {
    return { content: managedScaffold(section, config), scaffoldCreated: true };
  }
  const hasBegin = childContent.includes(config.beginMarker);
  const hasEnd = childContent.includes(config.endMarker);
  if (!hasBegin && !hasEnd) {
    const fingerprint = sha256(Buffer.from(childContent, "utf8"));
    if ((config.replaceWholeFileSha256 ?? []).includes(fingerprint)) {
      return { content: managedScaffold(section, config), legacyReplaced: true };
    }
    const prefix = childContent.trimEnd();
    return {
      content: `${prefix}${prefix ? "\n\n" : ""}${section}\n`,
      unknownWithoutMarkers: true,
    };
  }
  const oldSection = extractManagedSection(childContent, config, path);
  return { content: childContent.replace(oldSection, section) };
}

function mergeManagedSection(baseContent, childContent, config, path = "AGENTS.md") {
  return mergeManagedSectionDetailed(baseContent, childContent, config, path).content;
}

function mergeKeepChildExtra(baseObj, childObj, mergeKeys, ignoreDependencyKeys = []) {
  const out = JSON.parse(JSON.stringify(baseObj));
  for (const key of mergeKeys) {
    const baseValue = baseObj[key];
    const childValue = childObj[key];
    if (Array.isArray(baseValue) || Array.isArray(childValue)) {
      const baseArray = Array.isArray(baseValue) ? baseValue : [];
      const childArray = Array.isArray(childValue) ? childValue : [];
      out[key] = [...childArray.filter((item) => !baseArray.includes(item)), ...baseArray];
    } else {
      const baseRecord = baseValue ?? {};
      const childRecord = childValue ?? {};
      out[key] = { ...baseRecord };
      if (["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].includes(key)) {
        for (const ignored of ignoreDependencyKeys) {
          if (ignored in childRecord) out[key][ignored] = childRecord[ignored];
          else delete out[key][ignored];
        }
      }
      for (const [name, value] of Object.entries(childRecord)) if (!(name in baseRecord)) out[key][name] = value;
    }
  }
  return out;
}

function anchorNeedsSync(baseObj, childObj, mergeKeys, ignoreDependencyKeys = []) {
  const topKeys = new Set([...Object.keys(baseObj), ...mergeKeys]);
  for (const key of topKeys) {
    const baseValue = baseObj[key];
    const childValue = childObj[key];
    if (mergeKeys.includes(key)) {
      if (Array.isArray(baseValue) || Array.isArray(childValue)) {
        const baseArray = Array.isArray(baseValue) ? baseValue : [];
        const childArray = Array.isArray(childValue) ? childValue : [];
        if (baseArray.some((item) => !childArray.includes(item))) return true;
      } else {
        const baseRecord = baseValue ?? {};
        const childRecord = childValue ?? {};
        for (const [name, value] of Object.entries(baseRecord)) {
          if (["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].includes(key) && ignoreDependencyKeys.includes(name)) continue;
          if (!(name in childRecord) || JSON.stringify(childRecord[name]) !== JSON.stringify(value)) return true;
        }
      }
    } else if (JSON.stringify(baseValue) !== JSON.stringify(childValue)) return true;
  }
  return false;
}

function fileNeedsSync(scope, rel, src, dst) {
  if (!existsSync(dst)) return true;
  if (scope.appendOnlyDirs.some((dir) => rel.startsWith(`${dir}/`))) return false;
  const anchor = scope.anchorMerge[rel];
  if (anchor) {
    try {
      return anchorNeedsSync(
        JSON.parse(readFileSync(src, "utf8")),
        JSON.parse(readFileSync(dst, "utf8")),
        anchor.mergeKeys,
        anchor.ignoreDependencyKeys ?? [],
      );
    } catch {
      return true;
    }
  }
  return !readFileSync(dst).equals(readFileSync(src));
}

function registryCapabilityReadiness(childDir, scope) {
  return (scope.registryCapabilities ?? []).map((capability) => {
    const presentConsumers = [];
    const missingConsumers = [];
    const connectedConsumers = [];
    const unconnectedConsumers = [];
    for (const consumer of capability.consumers) {
      const packagePath = join(childDir, consumer, "package.json");
      if (!existsSync(packagePath)) {
        missingConsumers.push(consumer);
        continue;
      }
      presentConsumers.push(consumer);
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
        const version = packageJson.dependencies?.[capability.package]
          ?? packageJson.devDependencies?.[capability.package]
          ?? packageJson.peerDependencies?.[capability.package]
          ?? packageJson.optionalDependencies?.[capability.package];
        if (typeof version === "string" && version && !version.startsWith("workspace:")) connectedConsumers.push(consumer);
        else unconnectedConsumers.push(consumer);
      } catch {
        unconnectedConsumers.push(consumer);
      }
    }
    const phase = missingConsumers.length > 0
      ? "phase-1-client-structure-required"
      : unconnectedConsumers.length > 0
        ? "phase-2-stable-artifact-upgrade-required"
        : "consumer-gate-required";
    return {
      package: capability.package,
      distribution: capability.distribution,
      consumerGate: capability.consumerGate,
      requiredConsumers: capability.consumers,
      presentConsumers,
      missingConsumers,
      connectedConsumers,
      unconnectedConsumers,
      phase,
      compliance: "unverified",
    };
  });
}

function readState(childDir, repoRoot = targetRepoRoot(childDir)) {
  const rootPath = join(repoRoot, STATE_FILE);
  assertNoSymlinkPath(repoRoot, rootPath, `目标 state ${STATE_FILE}`);
  if (existsSync(rootPath)) return JSON.parse(readFileSync(rootPath, "utf8"));
  // v2 兼容：Tiger 曾把 state 放在 governance/。读取旧值，但下次 pull 统一迁到 Git 根。
  const legacyPath = join(childDir, STATE_FILE);
  assertNoSymlinkPath(repoRoot, legacyPath, `legacy state ${relative(repoRoot, legacyPath)}`);
  return legacyPath !== rootPath && existsSync(legacyPath) ? JSON.parse(readFileSync(legacyPath, "utf8")) : null;
}

function requiredAssetDigests(baseDir, scope) {
  const result = {};
  for (const path of scope.requiredRootAssets.files) result[path] = sha256(readFileSync(join(baseDir, path)));
  for (const [target, config] of Object.entries(scope.requiredRootAssets.copiedFiles ?? {})) {
    result[target] = sha256(readFileSync(join(baseDir, config.source)));
  }
  for (const [path, config] of Object.entries(scope.requiredRootAssets.managedSections)) {
    const section = extractManagedSection(readFileSync(join(baseDir, path), "utf8"), config, path);
    result[`${path}#managed-section`] = sha256(section);
  }
  return result;
}

function targetRepoRoot(childDir) {
  return realpathSync(resolve(git(childDir, "rev-parse", "--show-toplevel")));
}

function makePlan(baseDir, childDir, repoRoot, scope, options = {}) {
  const { requiredOnly = false } = options;
  const operations = [];
  const skippedAppendOnly = [];
  const warnings = [];
  assertContained(repoRoot, childDir, "目标基座目录");
  if (!requiredOnly) assertChildDependencySeams(childDir, repoRoot, scope);
  const scopeFiles = requiredOnly ? [] : [...new Set([
    ...[...walk(baseDir)].filter((path) => inScope(scope, path)),
    ...(scope.raw.publicAppendOnlyFiles ?? []),
    ...(options.adopt ? scope.raw.newIndustryBootstrapFiles ?? [] : []),
  ])];
  const blackHit = (path) => scope.raw.pollutionGuard.pathBlacklist.some((entry) => entry.startsWith("^") ? path.startsWith(entry.slice(1)) : path.includes(entry));
  const blackHits = scopeFiles.filter(blackHit);
  if (blackHits.length) throw new Error(`防污染护栏触发：scope 文件命中黑名单 → ${blackHits.slice(0, 5).join(", ")}`);

  for (const rel of scopeFiles) {
    const src = join(baseDir, rel);
    const dst = join(childDir, rel);
    assertNoSymlinkPath(baseDir, src, `基座源文件 ${rel}`, { allowMissing: false });
    assertNoSymlinkPath(repoRoot, dst, `目标文件 ${relative(repoRoot, dst)}`);
    if (scope.publicAppendOnlyFiles.has(rel) && existsSync(dst)) {
      if (!readFileSync(src).equals(readFileSync(dst))) {
        throw new Error(`公共追加资产与子仓同路径内容冲突，拒绝覆盖：${rel}`);
      }
      continue;
    }
    if (options.adopt && scope.newIndustryBootstrapFiles.has(rel) && existsSync(dst)) {
      if (!readFileSync(src).equals(readFileSync(dst))) {
        throw new Error(`新行业完整基线与目标同路径内容冲突，拒绝覆盖：${rel}`);
      }
      continue;
    }
    if (!fileNeedsSync(scope.raw, rel, src, dst)) {
      if (existsSync(dst) && scope.raw.appendOnlyDirs.some((dir) => rel.startsWith(`${dir}/`)) && !readFileSync(src).equals(readFileSync(dst))) {
        skippedAppendOnly.push(rel);
        warnings.push(`迁移漂移跳过（各仓迁移链须自洽）: ${rel}`);
      }
      continue;
    }
    const anchor = scope.raw.anchorMerge[rel];
    if (anchor && existsSync(dst)) {
      const merged = JSON.stringify(mergeKeepChildExtra(
        JSON.parse(readFileSync(src, "utf8")),
        JSON.parse(readFileSync(dst, "utf8")),
        anchor.mergeKeys,
        anchor.ignoreDependencyKeys ?? [],
      ), null, 2) + "\n";
      operations.push({ kind: "merge", rel, dst, content: merged, stagePath: relative(repoRoot, dst) });
    } else {
      operations.push({ kind: "copy", rel, src, dst, stagePath: relative(repoRoot, dst) });
    }
  }

  for (const rel of scope.raw.requiredRootAssets.files) {
    const src = join(baseDir, rel);
    const dst = join(repoRoot, rel);
    assertNoSymlinkPath(baseDir, src, `required root asset ${rel}`, { allowMissing: false });
    assertNoSymlinkPath(repoRoot, dst, `目标 required root asset ${rel}`);
    if (!existsSync(dst) || !readFileSync(dst).equals(readFileSync(src))) {
      operations.push({ kind: "required-copy", rel: `root:${rel}`, src, dst, stagePath: rel });
    }
  }
  for (const [target, config] of Object.entries(scope.raw.requiredRootAssets.copiedFiles ?? {})) {
    const src = join(baseDir, config.source);
    const dst = join(repoRoot, target);
    assertNoSymlinkPath(baseDir, src, `copied root asset source ${config.source}`, { allowMissing: false });
    assertNoSymlinkPath(repoRoot, dst, `目标 copied root asset ${target}`);
    if (!existsSync(dst) || !readFileSync(dst).equals(readFileSync(src))) {
      operations.push({ kind: "required-copy", rel: `root:${target}`, src, dst, stagePath: target });
    }
  }
  for (const [rel, config] of Object.entries(scope.raw.requiredRootAssets.managedSections)) {
    const src = join(baseDir, rel);
    const dst = join(repoRoot, rel);
    assertNoSymlinkPath(baseDir, src, `managed section source ${rel}`, { allowMissing: false });
    assertNoSymlinkPath(repoRoot, dst, `目标 managed section ${rel}`);
    const baseContent = readFileSync(src, "utf8");
    const childContent = existsSync(dst) ? readFileSync(dst, "utf8") : "";
    const result = mergeManagedSectionDetailed(baseContent, childContent, config, rel);
    if (result.unknownWithoutMarkers) warnings.push(`${rel} 无受控标记且 fingerprint 未知：已保留原文并追加受控区块，请人工确认专属规则归档`);
    if (result.content !== childContent) {
      operations.push({
        kind: "managed-section",
        rel: `root:${rel}#managed-section`,
        dst,
        content: result.content,
        stagePath: rel,
        legacyAgentsReplaced: Boolean(result.legacyReplaced),
        manualMigrationRequired: Boolean(result.unknownWithoutMarkers),
      });
    }
  }

  if (options.adopt && realpathSync(baseDir) !== realpathSync(repoRoot)) {
    for (const [rel, config] of Object.entries(scope.raw.adoptMigrations ?? {})) {
      const src = join(baseDir, rel);
      const dst = join(repoRoot, rel);
      assertNoSymlinkPath(baseDir, src, `adopt migration source ${rel}`, { allowMissing: false });
      assertNoSymlinkPath(repoRoot, dst, `adopt migration target ${rel}`);
      if (!existsSync(dst)) continue;
      if (!readFileSync(dst).equals(readFileSync(src))) {
        warnings.push(`${rel} 与基座 fingerprint 不同：视为子仓已定制，adopt 未覆盖`);
        continue;
      }
      if (config.strategy === "remove-if-identical-to-base") {
        operations.push({ kind: "adopt-delete", rel: `root:${rel}#adopt-remove`, dst, stagePath: rel, delete: true });
      } else if (readFileSync(dst, "utf8") !== config.scaffold) {
        operations.push({ kind: "adopt-scaffold", rel: `root:${rel}#adopt-scaffold`, dst, stagePath: rel, content: config.scaffold });
      }
    }
  }

  const maxFiles = options.adopt && !requiredOnly
    ? scope.raw.pollutionGuard.maxFilesPerAdopt
    : scope.raw.pollutionGuard.maxFilesPerSync;
  if (operations.length > maxFiles) {
    throw new Error(`防污染护栏触发：单次变更 ${operations.length} 文件超过${options.adopt && !requiredOnly ? "新行业接入" : "常规同步"}上限 ${maxFiles}——请人工核对同步范围`);
  }
  return { operations, skippedAppendOnly, warnings };
}

function applyOperation(operation, repoRoot) {
  assertNoSymlinkPath(repoRoot, operation.dst, `写入目标 ${operation.stagePath}`);
  if (operation.delete) {
    rmSync(operation.dst, { force: true });
    return;
  }
  mkdirSync(dirname(operation.dst), { recursive: true });
  if (operation.content !== undefined) writeFileSync(operation.dst, operation.content);
  else copyFileSync(operation.src, operation.dst);
}

function changedPaths(repoRoot) {
  const output = git(repoRoot, "status", "--porcelain=v1", "--untracked-files=all");
  if (!output) return new Set();
  return new Set(output.split("\n").map((line) => line.slice(3).replace(/^"|"$/g, "")));
}

function statePayload(old, baseSha, digests, changed, extraExclude, options, pathPrefix) {
  const payload = {
    ...(old ?? {}),
    baseRepo: old?.baseRepo ?? DEFAULT_BASE_REPO,
    ...(!options.requiredOnly ? { lastSyncedBaseSha: baseSha } : {}),
    lastRequiredAssetsBaseSha: baseSha,
    lastSyncAt: new Date().toISOString(),
    lastSyncMode: options.requiredOnly ? "required-only" : "full",
    pathPrefix,
    filesTouched: changed,
    requiredRootAssetsSha256: digests,
  };
  if (extraExclude.length) payload.extraExclude = extraExclude;
  else if (options.authoritativeExtraExclude) delete payload.extraExclude;
  return payload;
}

function stateNeedsUpdate(oldState, baseSha, digests, extraExclude, options, pathPrefix) {
  const recordedSha = options.requiredOnly ? oldState?.lastRequiredAssetsBaseSha : oldState?.lastSyncedBaseSha;
  if (!oldState || recordedSha !== baseSha) return true;
  if (oldState.pathPrefix !== pathPrefix) return true;
  if (JSON.stringify(oldState.requiredRootAssetsSha256 ?? {}) !== JSON.stringify(digests)) return true;
  if ((extraExclude.length || options.authoritativeExtraExclude) && JSON.stringify(oldState.extraExclude ?? []) !== JSON.stringify(extraExclude)) return true;
  return false;
}

function stageWhitelist(repoRoot, paths) {
  const clean = [...new Set(paths.filter(Boolean).map((path) => path.replace(/^\.\//, "")))];
  if (clean.length) git(repoRoot, "add", "--", ...clean);
}

function unstageWhitelist(repoRoot, paths) {
  const clean = [...new Set(paths.filter(Boolean).map((path) => path.replace(/^\.\//, "")))];
  if (clean.length) git(repoRoot, "reset", "--quiet", "HEAD", "--", ...clean);
}

function runSecretScanner(baseDir, repoRoot, scannerArgs) {
  const scanner = join(baseDir, assertSafeRelative(loadScope(baseDir).raw.preCommitSecretScanner, "preCommitSecretScanner"));
  assertNoSymlinkPath(baseDir, scanner, "pre-commit secret scanner", { allowMissing: false });
  sh(process.execPath, [scanner, ...scannerArgs], repoRoot);
}

function scanStateContent(baseDir, repoRoot, content) {
  const dir = mkdtempSync(join(tmpdir(), "workloom-state-scan-"));
  const path = join(dir, STATE_FILE);
  try {
    writeFileSync(path, content, { mode: 0o600 });
    runSecretScanner(baseDir, repoRoot, ["--files", path]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scanTransactionChanges(baseDir, repoRoot, transaction, plan, scope) {
  const dir = mkdtempSync(join(tmpdir(), "workloom-sync-secret-diff-"));
  const files = [];
  const operations = new Map(plan.operations.map((operation) => [resolve(operation.dst), operation]));
  try {
    for (const [index, snapshot] of transaction.snapshots.entries()) {
      const logicalPath = relative(repoRoot, snapshot.path).split(sep).join("/");
      const before = snapshot.existed ? join(dir, `before-${index}`) : null;
      if (before !== null) writeFileSync(before, snapshot.content, { mode: 0o600 });

      let after = null;
      if (existsSync(snapshot.path)) {
        const safePath = assertNoSymlinkPath(repoRoot, snapshot.path, `密钥扫描目标 ${logicalPath}`, { allowMissing: false });
        const stat = lstatSync(safePath);
        if (!stat.isFile()) throw new Error(`密钥扫描目标必须是普通文件：${logicalPath}`);
        after = safePath;
      }
      if (before === null && after === null) continue;
      const operation = operations.get(resolve(snapshot.path));
      let acceptedFindings = [];
      let afterSha256;
      // 审计接受项只适用于从受控基座 HEAD 逐字节复制的文件。锚点合并、生成内容、
      // lockfile 与任何目标侧注入都没有此豁免；目标字节不等于基座源时摘要也会失配。
      if (after !== null && operation?.src && operation.content === undefined && !operation.delete) {
        const sourcePath = relative(baseDir, operation.src).split(sep).join("/");
        const acceptance = scope.raw.acceptedBaseSecretScanFindings?.[sourcePath];
        if (acceptance && readFileSync(after).equals(readFileSync(operation.src))) {
          acceptedFindings = acceptance.findings;
          afterSha256 = acceptance.sha256;
        }
      }
      files.push({ file: logicalPath, before, after, afterSha256, acceptedFindings });
    }
    if (!files.length) return;
    const manifest = join(dir, "manifest.json");
    writeFileSync(manifest, JSON.stringify({ version: 1, files }), { mode: 0o600 });
    runSecretScanner(baseDir, repoRoot, ["--diff-manifest", manifest]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scanStagedChanges(baseDir, repoRoot, plan, scope) {
  const dir = mkdtempSync(join(tmpdir(), "workloom-sync-staged-secret-"));
  try {
    const files = [];
    for (const operation of plan.operations) {
      if (!operation.src || operation.content !== undefined || operation.delete || !existsSync(operation.dst)) continue;
      const sourcePath = relative(baseDir, operation.src).split(sep).join("/");
      const acceptance = scope.raw.acceptedBaseSecretScanFindings?.[sourcePath];
      if (!acceptance || !readFileSync(operation.dst).equals(readFileSync(operation.src))) continue;
      files.push({
        file: operation.stagePath.split(sep).join("/"),
        afterSha256: acceptance.sha256,
        acceptedFindings: acceptance.findings,
      });
    }
    if (!files.length) {
      runSecretScanner(baseDir, repoRoot, ["--staged"]);
      return;
    }
    const manifest = join(dir, "manifest.json");
    writeFileSync(manifest, JSON.stringify({ version: 1, files }), { mode: 0o600 });
    runSecretScanner(baseDir, repoRoot, ["--staged", "--acceptance-manifest", manifest]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function captureFileSnapshot(repoRoot, path, label) {
  const safePath = assertNoSymlinkPath(repoRoot, path, label);
  let stat;
  try {
    stat = lstatSync(safePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: safePath, existed: false };
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} 不允许 symlink`);
  if (!stat.isFile()) throw new Error(`${label} 必须是普通文件`);
  return { path: safePath, existed: true, content: readFileSync(safePath), mode: stat.mode & 0o777 };
}

function captureTransaction(repoRoot, paths) {
  const snapshots = [];
  const seen = new Set();
  for (const { path, label } of paths) {
    const safePath = assertContained(repoRoot, path, label);
    if (seen.has(safePath)) continue;
    seen.add(safePath);
    snapshots.push(captureFileSnapshot(repoRoot, safePath, label));
  }
  return { snapshots, seen };
}

function rememberNewFile(transaction, repoRoot, path, label) {
  const safePath = assertContained(repoRoot, path, label);
  if (transaction.seen.has(safePath)) return;
  transaction.seen.add(safePath);
  // 这个路径在写命令之前不存在；它在命令后首次出现时记录为“原本缺失”。
  transaction.snapshots.push({ path: safePath, existed: false });
}

function restoreTransaction(repoRoot, transaction) {
  for (const snapshot of [...transaction.snapshots].reverse()) {
    assertContained(repoRoot, snapshot.path, "事务回滚目标");
    let current = null;
    try {
      current = lstatSync(snapshot.path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!snapshot.existed) {
      if (current) {
        if (!current.isFile() && !current.isSymbolicLink()) {
          throw new Error(`事务回滚拒绝移除非文件目标：${relative(repoRoot, snapshot.path)}`);
        }
        rmSync(snapshot.path, { force: true });
      }
      continue;
    }
    if (current?.isSymbolicLink()) rmSync(snapshot.path, { force: true });
    else if (current && !current.isFile()) throw new Error(`事务回滚目标不是普通文件：${relative(repoRoot, snapshot.path)}`);
    assertNoSymlinkPath(repoRoot, dirname(snapshot.path), "事务回滚父目录", { allowMissing: true });
    mkdirSync(dirname(snapshot.path), { recursive: true });
    writeFileSync(snapshot.path, snapshot.content);
    chmodSync(snapshot.path, snapshot.mode);
  }
}

function transactionPaths(repoRoot, childDir, plan, scope) {
  const statePath = join(repoRoot, STATE_FILE);
  const legacyStatePath = join(childDir, STATE_FILE);
  const paths = [
    ...plan.operations.map((operation) => ({ path: operation.dst, label: `同步目标 ${operation.stagePath}` })),
    { path: statePath, label: `同步 state ${STATE_FILE}` },
    { path: legacyStatePath, label: `legacy state ${relative(repoRoot, legacyStatePath)}` },
    { path: join(repoRoot, "pnpm-lock.yaml"), label: "根级 pnpm-lock.yaml" },
    { path: join(childDir, "pnpm-lock.yaml"), label: "基座目录 pnpm-lock.yaml" },
    { path: join(childDir, "docs/OPEN_SOURCE_COMPONENTS.md"), label: "派生清单 docs/OPEN_SOURCE_COMPONENTS.md" },
  ];
  for (const rel of walk(repoRoot)) {
    if (/(^|\/)pnpm-lock\.yaml$/.test(rel)) paths.push({ path: join(repoRoot, rel), label: `lockfile ${rel}` });
  }
  for (const asset of scope.raw.perProductDerivedAssets ?? []) {
    for (const file of asset.files) {
      paths.push({
        path: join(childDir, asset.directory, file),
        label: `产品派生资产 ${asset.directory}/${file}`,
      });
    }
  }
  return paths;
}

/* ---------------- 单仓同步核心 ---------------- */
function syncToChild(baseDir, childDir, scope, report, extraExclude = [], options = {}) {
  const repoRoot = targetRepoRoot(childDir);
  const relativePrefix = relative(repoRoot, childDir).split(sep).join("/");
  const pathPrefix = relativePrefix || ".";
  const baseSha = git(baseDir, "rev-parse", "HEAD");
  const digests = requiredAssetDigests(baseDir, scope.raw);
  const oldState = readState(childDir, repoRoot);
  const plan = makePlan(baseDir, childDir, repoRoot, scope, options);
  const changed = plan.operations.length;

  report.copied = plan.operations.filter((item) => item.kind.includes("copy")).map((item) => item.rel);
  report.merged = plan.operations.filter((item) => item.kind === "merge").map((item) => item.rel);
  report.managed = plan.operations.filter((item) => item.kind === "managed-section").map((item) => item.rel);
  report.adopted = plan.operations.filter((item) => item.kind.startsWith("adopt-")).map((item) => item.rel);
  report.legacyAgentsReplaced = plan.operations.some((item) => item.legacyAgentsReplaced);
  report.manualMigrationRequired = plan.operations.some((item) => item.manualMigrationRequired);
  report.skippedAppendOnly = plan.skippedAppendOnly;
  report.warnings = plan.warnings;
  report.changed = changed;
  report.baseSha = baseSha;
  report.requiredRootAssetsSha256 = digests;
  report.pathPrefix = pathPrefix;
  report.scopeVersion = scope.raw.version ?? null;
  report.registryCapabilities = registryCapabilityReadiness(childDir, scope.raw);
  report.committed = false;

  const updateState = stateNeedsUpdate(oldState, baseSha, digests, extraExclude, options, pathPrefix) || changed > 0 || !existsSync(join(repoRoot, STATE_FILE));
  report.stateUpdated = updateState;
  if (report.dryRun) return report;

  const dirtyBefore = changedPaths(repoRoot);
  const statePath = join(repoRoot, STATE_FILE);
  const stateContent = updateState
    ? JSON.stringify(statePayload(oldState, baseSha, digests, changed, extraExclude, options, pathPrefix), null, 2) + "\n"
    : null;
  const legacyStatePath = join(childDir, STATE_FILE);
  const migrateLegacyState = legacyStatePath !== statePath && existsSync(legacyStatePath);
  const transaction = captureTransaction(repoRoot, transactionPaths(repoRoot, childDir, plan, scope));
  const stagedPaths = plan.operations.map((item) => item.stagePath);
  let didStage = false;

  try {
    for (const operation of plan.operations) applyOperation(operation, repoRoot);

    // 先逐项复验已安装内容，再写 state，避免把半安装状态登记为“已对齐”。
    const remaining = makePlan(baseDir, childDir, repoRoot, scope, options).operations;
    if (remaining.length) throw new Error(`安装后验证失败，仍有 ${remaining.length} 个文件未对齐：${remaining.slice(0, 5).map((item) => item.rel).join(", ")}`);

    // anchor merge 以及普通 copy 的任一 package.json 都可能改变 importer specifier。
    // 必须先由子仓自己的 pnpm 10 重算 lock，再派生桌面 runtime lock；否则新包清单
    // 会与旧 pnpm-lock 组合，导致所有下游在派生锁阶段失败并整仓回滚。
    const lockfileInputsChanged = plan.operations.some((item) => (
      item.kind === "merge" || /(^|\/)package\.json$/u.test(item.rel)
    ));
    /**
     * 清单口径变化（2026-09-29 实测事故）：清单 `docs/OPEN_SOURCE_COMPONENTS.md` 除依赖事实外，
     * 还由**生成器自身**（`scripts/oss-inventory.mjs`：章节/表头/口径）与**产品派生锁**
     * （`.workloom-runtime-deps/**`，登记组件当前版本的事实源）决定。二者都在同步范围内，
     * 但对 `pnpm-lock.yaml` 与各 `package.json` 而言并非"依赖变化"——只按 lockfile 触发会漏算：
     * 下发了新生成器/新派生锁却没重算清单，子仓 `pnpm oss:check` 立即判红。
     * （实测 workroom-fox 定向 full 波次：static-gate 报「开源组件清单与仓库事实不一致」。）
     */
    const inventoryFactsChanged = lockfileInputsChanged || plan.operations.some((item) => {
      const rel = String(item.rel ?? "").replace(/^root:/u, "").split("#")[0];
      return rel === "scripts/oss-inventory.mjs" || rel.startsWith(".workloom-runtime-deps/");
    });
    if (lockfileInputsChanged) {
      try {
        sh("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], childDir);
        // pnpm 10.14 只为 URL tarball 写 resolution.tarball，不写 SRI；重算 lock 会把
        // `@workloom/ui` 稳定制品的 SHA-512 丢掉，子仓 UI 消费门禁
        // （resolution.integrity == `.workloom-ui.json` 的 SHA-512）随即判红。
        // UI 消费仓必须在 frozen install 之前把稳定 state 的 SHA-512 重新注入唯一
        // canonical resolution，口径与 `sync/ui-upgrade-pr.mjs` 的 rollout 路径一致。
        if (existsSync(join(childDir, UI_STATE_FILE))) {
          const bound = bindUiLockfileIntegrity(childDir);
          const lockRel = relative(repoRoot, bound.lockfile).split(sep).join("/");
          if (!stagedPaths.includes(lockRel)) stagedPaths.push(lockRel);
          report.uiLockfileIntegrity = {
            lockfile: lockRel,
            changed: bound.changed,
            integrity: bound.integrity,
          };
        }
        const dirtyAfter = changedPaths(repoRoot);
        for (const path of dirtyAfter) {
          if (!dirtyBefore.has(path) && /(^|\/)pnpm-lock\.yaml$/.test(path)) {
            const absolute = join(repoRoot, path);
            rememberNewFile(transaction, repoRoot, absolute, `新 lockfile ${path}`);
            stagedPaths.push(path);
          }
        }
        report.lockfileRefreshed = true;
      } catch (error) {
        throw new Error(`lockfile 刷新失败；未写 state、未提交：${redact(error?.message).slice(0, 300)}`);
      }
    }

    // 新行业 adopt 会在三端客户端与最终 pnpm-lock 全部就位后统一生成；此处过早
    // 生成会把尚未 scaffold 的 apps/web 误判为缺失。存量 full sync 则原子刷新。
    if (!options.requiredOnly && !options.adopt) {
      for (const asset of scope.raw.perProductDerivedAssets ?? []) {
        const generator = join(childDir, asset.generator);
        try {
          assertNoSymlinkPath(repoRoot, generator, `产品派生资产生成器 ${asset.generator}`, { allowMissing: false });
          sh(process.execPath, [generator, ...asset.refreshArgs, "--root", childDir], childDir);
          sh(process.execPath, [generator, ...asset.verifyArgs, "--root", childDir], childDir);
          for (const file of asset.files) stagedPaths.push(relative(repoRoot, join(childDir, asset.directory, file)));
          report.perProductDerivedAssets ??= [];
          report.perProductDerivedAssets.push({ directory: asset.directory, refreshed: true, verified: true });
        } catch (error) {
          throw new Error(`产品派生资产 ${asset.directory} 刷新/验真失败；未写 state、未提交：${redact(error?.message).slice(0, 500)}`);
        }
      }
      // 依赖一变，子仓的派生清单 docs/OPEN_SOURCE_COMPONENTS.md 就与仓库事实漂移，
      // 其 static-gate 的 `pnpm oss:check` 会直接判红（九仓波次实测）。清单把
      // `.workloom-runtime-deps` 也当作事实源，因此必须排在上面派生锁刷新**之后**、
      // 写 state/提交**之前**重算；生成器离线、确定性，产物与 `yaml` 解析器是否
      // 可用逐字节一致（实测），可在无 node_modules 的子仓克隆中安全执行。
      // pathPrefix 仓（如 Tiger：WorkLoom 壳在 governance/）可能在**仓库根**另有一套
      // 同源工具链，其 CI 的 oss:check 校验根级清单；两处都要按各自事实重算。
      const inventoryRoots = [childDir];
      if (resolve(childDir) !== resolve(repoRoot)) inventoryRoots.push(repoRoot);
      if (inventoryFactsChanged) {
        for (const inventoryRoot of inventoryRoots) {
          const inventoryGenerator = join(inventoryRoot, "scripts/oss-inventory.mjs");
          const inventoryDoc = join(inventoryRoot, "docs/OPEN_SOURCE_COMPONENTS.md");
          if (!existsSync(inventoryGenerator) || !existsSync(inventoryDoc)) continue;
          const docRel = relative(repoRoot, inventoryDoc).split(sep).join("/");
          try {
            sh(process.execPath, [inventoryGenerator, "--write"], inventoryRoot);
            if (!stagedPaths.includes(docRel)) stagedPaths.push(docRel);
            report.ossInventoryRefreshed = true;
          } catch (error) {
            throw new Error(`开源组件清单刷新失败（${docRel}）；未写 state、未提交：${redact(error?.message).slice(0, 300)}`);
          }
        }
      }
    }

    if (options.noCommit) {
      try {
        scanTransactionChanges(baseDir, repoRoot, transaction, plan, scope);
        if (stateContent !== null) scanStateContent(baseDir, repoRoot, stateContent);
      } catch (error) {
        throw new Error(`no-commit 写入后密钥扫描失败；未写 state、未提交：${redact(error?.message).slice(0, 500)}`);
      }
      if (stateContent !== null) {
        assertNoSymlinkPath(repoRoot, statePath, `写入目标 ${STATE_FILE}`);
        writeFileSync(statePath, stateContent);
      }
      if (migrateLegacyState) {
        rmSync(legacyStatePath);
        report.legacyStateMigrated = true;
      }
      report.written = true;
      return report;
    }

    // 先按同步前事务快照扫描本次新增内容，避免把目标仓历史文本误算为本次泄漏。
    // 自动提交仍会在暂存后复扫，确保最终提交白名单与已审内容一致。
    try {
      scanTransactionChanges(baseDir, repoRoot, transaction, plan, scope);
      if (stateContent !== null) scanStateContent(baseDir, repoRoot, stateContent);
    } catch (error) {
      throw new Error(`提交前密钥扫描失败；未写 state、未提交：${redact(error?.message).slice(0, 500)}`);
    }

    didStage = true;
    stageWhitelist(repoRoot, stagedPaths);
    try {
      scanStagedChanges(baseDir, repoRoot, plan, scope);
    } catch (error) {
      throw new Error(`提交前密钥扫描失败；未写 state、未提交：${redact(error?.message).slice(0, 500)}`);
    }

    if (stateContent !== null) {
      assertNoSymlinkPath(repoRoot, statePath, `写入目标 ${STATE_FILE}`);
      writeFileSync(statePath, stateContent);
      stagedPaths.push(STATE_FILE);
    }
    if (migrateLegacyState) {
      rmSync(legacyStatePath);
      stagedPaths.push(relative(repoRoot, legacyStatePath));
      report.legacyStateMigrated = true;
    }
    stageWhitelist(repoRoot, stagedPaths);
    try {
      scanStagedChanges(baseDir, repoRoot, plan, scope);
    } catch (error) {
      throw new Error(`提交前最终密钥扫描失败；未提交：${redact(error?.message).slice(0, 500)}`);
    }

    const staged = git(repoRoot, "diff", "--cached", "--name-only");
    if (staged) {
      const files = plan.operations.map((item) => item.rel).slice(0, 30).join(", ");
      git(repoRoot, "-c", "user.name=WorkLoom Base Sync", "-c", "user.email=base-sync@workloom.im", "-c", "core.hooksPath=/dev/null", "commit", "-m",
        // 提交标题走 `sync(...)`：协议 §5 把"同步器产出"登记为豁免项，子仓提交信息门禁据此放行。
        `sync(base): 基座能力对齐 → ${baseSha.slice(0, 8)}（base-sync 自动）\n\n内容 ${changed} 文件 · 状态 ${updateState ? "已更新" : "未变"}\n${files}${changed > 30 ? " …" : ""}`);
      report.committed = true;
    }
    return report;
  } catch (error) {
    if (!report.committed) {
      try {
        if (didStage) unstageWhitelist(repoRoot, [...stagedPaths, STATE_FILE, relative(repoRoot, legacyStatePath)]);
        restoreTransaction(repoRoot, transaction);
        const dirtyAfterRollback = changedPaths(repoRoot);
        if (
          dirtyAfterRollback.size !== dirtyBefore.size ||
          [...dirtyBefore].some((path) => !dirtyAfterRollback.has(path))
        ) {
          throw new Error("回滚后目标工作树状态与同步前不一致");
        }
      } catch (rollbackError) {
        throw new Error(`${redact(error?.message)}；事务回滚失败：${redact(rollbackError?.message).slice(0, 500)}`);
      }
    }
    throw error;
  }
}

function ensureBaseClone(baseRepo, baseUrl) {
  const dir = mkdtempSync(join(tmpdir(), "workloom-base-"));
  try {
    const url = repoUrl(baseUrl, baseRepo);
    gitNetwork(undefined, url, "clone", "--depth", "1", "--branch", "main", "--single-branch", url, dir);
    verifyClonedMain(dir);
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function verifyClonedMain(dir) {
  const head = git(dir, "rev-parse", "HEAD");
  const main = git(dir, "rev-parse", "refs/heads/main");
  if (head !== main) throw new Error(`clone 未固定到 refs/heads/main（HEAD=${head.slice(0, 12)}）`);
}

function output(options, object, text) {
  if (options.json) console.log(JSON.stringify(object, null, 2));
  else console.log(text);
}

function effectiveExtra(state, options, configured = []) {
  return [...new Set([...(configured ?? []), ...(state?.extraExclude ?? []), ...options.extraExclude])];
}

/* ---------------- CLI modes ---------------- */
function modeDetect(options) {
  const { childDir, repoRoot } = resolveChildTarget(options.repo);
  const state = readState(childDir, repoRoot);
  const baseRepo = state?.baseRepo ?? DEFAULT_BASE_REPO;
  let baseDir = options.baseDir ? resolve(options.baseDir) : "";
  let temporary = false;
  try {
    if (!baseDir) {
      baseDir = ensureBaseClone(baseRepo, options.baseUrl);
      temporary = true;
    }
    const baseSha = git(baseDir, "rev-parse", "HEAD");
    const extra = effectiveExtra(state, options);
    const scope = withExtraExclude(loadScope(baseDir), extra);
    verifyBaseSourcesAtHead(baseDir, scope, options.requiredOnly);
    const plan = makePlan(baseDir, childDir, repoRoot, scope, options);
    const digests = requiredAssetDigests(baseDir, scope.raw);
    const pathPrefix = relative(repoRoot, childDir).split(sep).join("/") || ".";
    const stateCurrent = !stateNeedsUpdate(state, baseSha, digests, extra, options, pathPrefix) && existsSync(join(repoRoot, STATE_FILE));
    const contentFiles = plan.operations.map((item) => item.rel);
    const localRecordedSha = options.requiredOnly ? state?.lastRequiredAssetsBaseSha : state?.lastSyncedBaseSha;
    const stateDrift = !stateCurrent;
    const report = {
      mode: "detect",
      child: childDir,
      remoteSha: baseSha,
      localSha: localRecordedSha ?? null,
      behind: contentFiles.length > 0 || stateDrift,
      contentDrift: contentFiles.length > 0,
      stateDrift,
      stateCurrent,
      contentFiles,
      files: [...contentFiles, ...(stateDrift ? [`root:${STATE_FILE}`] : [])],
      requiredRootAssetsSha256: digests,
      requiredOnly: options.requiredOnly,
      scopeVersion: scope.raw.version ?? null,
      registryCapabilities: registryCapabilityReadiness(childDir, scope.raw),
    };
    if (!report.behind) {
      output(options, report, `✅ 基座内容与同步状态已对齐（${baseSha.slice(0, 8)}；required assets 已逐项验真）`);
      return 0;
    }
    report.behindBy = `${localRecordedSha?.slice(0, 8) ?? "从未同步"} → ${baseSha.slice(0, 8)}`;
    output(options, report, `⚠️ 基座同步漂移（${report.behindBy}）：内容漂移 ${contentFiles.length} 项 · 状态漂移 ${stateDrift ? 1 : 0} 项\n${report.files.slice(0, 20).map((file) => `  · ${file}`).join("\n")}${report.files.length > 20 ? `\n  … 共 ${report.files.length} 个` : ""}\n\n修复：node sync/base-sync.mjs pull --repo .（由 CI 建 PR，或人工审核后推送）`);
    return 2;
  } finally {
    if (temporary && baseDir) rmSync(baseDir, { recursive: true, force: true });
  }
}

function modePull(options) {
  const { childDir, repoRoot } = resolveChildTarget(options.repo);
  if (!options.noCommit && !options.dryRun) assertClean(repoRoot, options.push ? "自动推送" : "自动提交");
  const state = readState(childDir, repoRoot);
  let baseDir = options.baseDir ? resolve(options.baseDir) : "";
  let temporary = false;
  try {
    if (!baseDir) {
      baseDir = ensureBaseClone(state?.baseRepo ?? DEFAULT_BASE_REPO, options.baseUrl);
      temporary = true;
    }
    const extra = effectiveExtra(state, options);
    const scope = withExtraExclude(loadScope(baseDir), extra);
    verifyBaseSourcesAtHead(
      baseDir,
      scope,
      options.requiredOnly,
      options.adopt ? [
        ...Object.keys(scope.raw.adoptMigrations ?? {}),
        ...(scope.raw.newIndustryBootstrapFiles ?? []),
      ] : [],
    );
    const report = { mode: "pull", child: childDir, dryRun: options.dryRun, requiredOnly: options.requiredOnly, noCommit: options.noCommit };
    syncToChild(baseDir, childDir, scope, report, extra, options);
    output(options, report, report.changed === 0
      ? `✅ ${options.requiredOnly ? "根级必备资产" : "基座内容"}已是最新（${report.baseSha.slice(0, 8)}）${report.committed ? "；同步状态已提交" : report.written ? "；同步状态已写入（未提交）" : ""}`
      : `${options.dryRun ? "[dry-run] " : ""}📦 ${options.requiredOnly ? "根级必备资产" : "基座"}对齐完成：内容 ${report.changed} · 普通复制 ${report.copied.length} · 锚点合并 ${report.merged.length} · AGENTS 受控块 ${report.managed.length}${report.written ? " · 已写入未提交" : ""}${report.pushed ? " · 已推送" : ""}${report.warnings.length ? `\n⚠️ ${report.warnings.join("\n⚠️ ")}` : ""}`);
    return 0;
  } finally {
    if (temporary && baseDir) rmSync(baseDir, { recursive: true, force: true });
  }
}

function modePush(options) {
  if (!options.dryRun) throw new Error("直接推送 main 已禁止；请使用 sync/fanout-cnb.mjs 创建 PR，门禁通过后串行合并");
  const baseDir = resolve(options.base || join(SCRIPT_DIR, ".."));
  const baseScope = loadScope(baseDir);
  verifyBaseSourcesAtHead(baseDir, baseScope, options.requiredOnly, ["sync/child-repos.json"]);
  const children = JSON.parse(readFileSync(join(baseDir, "sync/child-repos.json"), "utf8"));
  const results = [];
  for (const child of children.children) {
    const report = { repo: child.repo, ok: false, dryRun: options.dryRun };
    const dir = mkdtempSync(join(tmpdir(), "workloom-child-"));
    try {
      const url = repoUrl(options.baseUrl, child.repo);
      gitNetwork(undefined, url, "clone", "--depth", "1", "--branch", "main", "--single-branch", url, dir);
      verifyClonedMain(dir);
      assertClean(dir, "父仓自动同步");
      const prefix = child.pathPrefix ? assertSafeRelative(child.pathPrefix.replace(/\/$/, ""), `${child.repo} pathPrefix`) : "";
      const requestedChildDir = prefix ? join(dir, prefix) : dir;
      assertNoSymlinkPath(dir, requestedChildDir, `${child.repo} pathPrefix`, { allowMissing: false });
      const childDir = realpathSync(requestedChildDir);
      // 父仓清单是跨仓同步边界的权威来源；不采信子仓 state 自行追加的排除项。
      const extra = [...new Set([...(child.extraExclude ?? []), ...options.extraExclude])];
      const scope = withExtraExclude(baseScope, extra);
      syncToChild(baseDir, childDir, scope, report, extra, { ...options, authoritativeExtraExclude: true });
      report.ok = true;
    } catch (error) {
      report.error = redact(error?.message).slice(0, 500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    results.push(report);
    if (!options.json) console.log(`${report.ok ? "✅" : "❌"} ${child.repo}: changed=${report.changed ?? "-"}${report.pushed ? " 已推送" : ""}${report.error ? ` 错误: ${report.error}` : ""}`);
  }
  const summary = { mode: "push", baseSha: git(baseDir, "rev-parse", "HEAD"), results };
  output(options, summary, `\n═══ 推送汇总：${results.filter((item) => item.ok).length}/${results.length} 仓成功 ═══`);
  return results.some((item) => !item.ok) ? 1 : 0;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.push || (options.mode === "push" && !options.dryRun)) {
    console.error("直接推送 main 已禁止；请使用 sync/fanout-cnb.mjs 创建 PR，门禁通过后串行合并");
    return 64;
  }
  if (!["detect", "pull", "push"].includes(options.mode)) {
    console.error("用法: node base-sync.mjs detect|pull|push [--repo <path>] [--base <path>] [--base-dir <path>] [--base-url <prefix>] [--required-only] [--no-commit] [--adopt] [--push] [--dry-run] [--json]");
    return 64;
  }
  if (["detect", "pull"].includes(options.mode) && !options.repo) {
    console.error(`${options.mode} 需要 --repo`);
    return 64;
  }
  if (options.push && options.noCommit) {
    console.error("--push 与 --no-commit 不能同时使用");
    return 64;
  }
  if (options.mode === "push" && options.noCommit) {
    console.error("push 模式不支持 --no-commit");
    return 64;
  }
  if (options.adopt && (options.mode !== "pull" || !options.noCommit)) {
    console.error("--adopt 只允许与 pull --no-commit 组合，由 sync/adopt.sh 使用");
    return 64;
  }
  if (options.mode === "detect") return modeDetect(options);
  if (options.mode === "pull") return modePull(options);
  return modePush(options);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(resolve(SCRIPT_PATH));
  } catch {
    return resolve(process.argv[1]) === resolve(SCRIPT_PATH);
  }
}

if (isDirectExecution()) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`❌ ${redact(error?.message ?? error)}`);
    process.exitCode = 1;
  }
}

export {
  anchorNeedsSync,
  dependencyClosureViolations,
  extractManagedSection,
  gitAuthEnv,
  loadScope,
  main,
  mergeKeepChildExtra,
  mergeManagedSection,
  registryCapabilityReadiness,
  redact,
  repoUrl,
  withExtraExclude,
};
