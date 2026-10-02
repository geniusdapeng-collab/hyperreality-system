#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UI_STATE_SCHEMA = "workloom.ui-consumer-state/v1";
export const UI_PACKAGE = "@workloom/ui";
export const UI_CONTRACT_VERSION = "2.0.0";
export const UI_RELEASE_TYPE = "github-release-tarball";
export const CANONICAL_BASE_REPOSITORY = "workloom-ai/workloom-im";
export const LOCKFILE_NAME = "pnpm-lock.yaml";
export const REQUIRED_CLIENT_PACKAGES = Object.freeze([
  "apps/web/package.json",
  "apps/webb/package.json",
  "apps/webc/package.json",
]);

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/u;

export function validSha512(value) {
  if (typeof value !== "string" || !value.startsWith("sha512-")) return false;
  const encoded = value.slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return false;
  try {
    const digest = Buffer.from(encoded, "base64");
    return digest.length === 64 && digest.toString("base64") === encoded;
  } catch {
    return false;
  }
}

export function canonicalUiArtifact(version) {
  const assetName = `workloom-ui-${version}.tgz`;
  return {
    type: UI_RELEASE_TYPE,
    assetName,
    url: `https://cnb.cool/${CANONICAL_BASE_REPOSITORY}/-/releases/download/ui-v${version}/${assetName}`,
    overrideSelector: `${UI_PACKAGE}@${version}`,
  };
}

function exactClientList(value) {
  return Array.isArray(value)
    && value.length === REQUIRED_CLIENT_PACKAGES.length
    && new Set(value).size === REQUIRED_CLIENT_PACKAGES.length
    && REQUIRED_CLIENT_PACKAGES.every((path) => value.includes(path));
}

export function uiStateLockContractErrors(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return [".workloom-ui.json 顶层必须是 JSON 对象"];
  }
  const errors = [];
  const validVersion = EXACT_SEMVER.test(state.version ?? "");
  if (state.schemaVersion !== UI_STATE_SCHEMA) errors.push(`schemaVersion 必须为 ${UI_STATE_SCHEMA}`);
  if (state.package !== UI_PACKAGE) errors.push(`package 必须为 ${UI_PACKAGE}`);
  if (!validVersion) errors.push("version 必须是精确稳定 semver");
  if (state.contractVersion !== UI_CONTRACT_VERSION) errors.push(`contractVersion 必须为 ${UI_CONTRACT_VERSION}`);
  if (state.source !== CANONICAL_BASE_REPOSITORY) errors.push(`source 必须为 ${CANONICAL_BASE_REPOSITORY}`);
  if (state.releaseChannel !== "stable") errors.push("releaseChannel 必须为 stable");
  if (state.updatePolicy !== "upgrade-pr-only") errors.push("updatePolicy 必须为 upgrade-pr-only");
  if (!exactClientList(state.requiredClientPackages)) errors.push("requiredClientPackages 必须精确登记固定三端");
  if (!exactClientList(state.connectedClientPackages)) errors.push("connectedClientPackages 必须精确登记固定三端");
  const expected = validVersion ? canonicalUiArtifact(state.version) : null;
  if (!state.artifact || typeof state.artifact !== "object" || Array.isArray(state.artifact)) {
    errors.push("缺少 artifact 对象");
  } else {
    if (expected && state.artifact.type !== expected.type) errors.push(`artifact.type 必须为 ${expected.type}`);
    if (expected && state.artifact.assetName !== expected.assetName) errors.push("artifact.assetName 必须由稳定版本唯一推导");
    if (expected && state.artifact.url !== expected.url) errors.push("artifact.url 必须为 canonical GitHub Release URL");
    if (!validSha512(state.artifact.sha512)) errors.push("artifact.sha512 必须是有效 SHA-512 SRI");
  }
  return errors;
}

function decodeScalar(raw, label) {
  const value = String(raw).trim();
  if (!value) throw new Error(`${label} 缺少标量值`);
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new Error(`${label} 的单引号标量未闭合`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"')) {
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded !== "string") throw new Error("not string");
      return decoded;
    } catch {
      throw new Error(`${label} 的双引号标量无效`);
    }
  }
  if (/\s#|[\r\n]/u.test(value)) throw new Error(`${label} 不允许行内注释或换行`);
  return value;
}

function quotedKeyEnd(text, quote) {
  if (quote === '"') {
    let escaped = false;
    for (let index = 1; index < text.length; index += 1) {
      const character = text[index];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) return index;
    }
    return -1;
  }
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] !== quote) continue;
    if (text[index + 1] === quote) index += 1;
    else return index;
  }
  return -1;
}

function mappingEntry(line, indent) {
  const prefix = " ".repeat(indent);
  if (!line.startsWith(prefix) || line[indent] === " " || line[indent] === "\t") return null;
  const text = line.slice(indent);
  if (!text || text.startsWith("#") || text.startsWith("- ")) return null;
  let separator = -1;
  if (text[0] === "'" || text[0] === '"') {
    const end = quotedKeyEnd(text, text[0]);
    if (end < 0 || text[end + 1] !== ":") return null;
    separator = end + 1;
  } else {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === ":" && (index === text.length - 1 || /\s/u.test(text[index + 1]))) {
        separator = index;
        break;
      }
    }
  }
  if (separator < 0) return null;
  return {
    key: decodeScalar(text.slice(0, separator), "YAML key"),
    value: text.slice(separator + 1).trim(),
  };
}

function entriesAt(lines, start, end, indent) {
  const entries = [];
  for (let index = start; index < end; index += 1) {
    const entry = mappingEntry(lines[index], indent);
    if (entry) entries.push({ ...entry, index });
  }
  return entries;
}

function uniqueEntry(entries, key, label) {
  const matches = entries.filter((entry) => entry.key === key);
  if (matches.length !== 1) throw new Error(`${label} 必须且只能出现一次，当前为 ${matches.length}`);
  return matches[0];
}

function nestedRange(lines, entry, parentEnd, indent) {
  let end = parentEnd;
  for (let index = entry.index + 1; index < parentEnd; index += 1) {
    if (mappingEntry(lines[index], indent)) {
      end = index;
      break;
    }
  }
  return { start: entry.index + 1, end };
}

function topLevelRange(lines, key) {
  const entries = entriesAt(lines, 0, lines.length, 0);
  const entry = uniqueEntry(entries, key, `pnpm-lock.yaml 顶层 ${key}`);
  if (entry.value) throw new Error(`pnpm-lock.yaml 顶层 ${key} 必须是映射`);
  return nestedRange(lines, entry, lines.length, 0);
}

function splitFlowItems(source) {
  const items = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && character === "\\") escaped = true;
      else if (character === quote) {
        if (quote === "'" && source[index + 1] === "'") index += 1;
        else quote = "";
      }
    } else if (character === "'" || character === '"') quote = character;
    else if (character === ",") {
      items.push(source.slice(start, index));
      start = index + 1;
    }
  }
  if (quote) throw new Error("resolution flow mapping 引号未闭合");
  items.push(source.slice(start));
  return items;
}

function parseResolution(raw) {
  const value = raw.trim();
  if (!value.startsWith("{") || !value.endsWith("}")) {
    throw new Error("共享 UI resolution 必须是 pnpm 10 生成的单行 flow mapping");
  }
  const result = {};
  for (const item of splitFlowItems(value.slice(1, -1))) {
    const entry = mappingEntry(item.trim(), 0);
    if (!entry || !entry.value) throw new Error("共享 UI resolution flow mapping 无效");
    if (Object.hasOwn(result, entry.key)) throw new Error(`共享 UI resolution 字段重复：${entry.key}`);
    result[entry.key] = decodeScalar(entry.value, `resolution.${entry.key}`);
  }
  const unexpected = Object.keys(result).filter((key) => !["tarball", "integrity"].includes(key));
  if (unexpected.length) throw new Error(`共享 UI resolution 含非预期字段：${unexpected.join("、")}`);
  return result;
}

function isUiOverrideSelector(selector) {
  const leaf = String(selector).split(">").at(-1);
  return leaf === UI_PACKAGE || leaf.startsWith(`${UI_PACKAGE}@`);
}

function importerPath(packagePath) {
  return packagePath.replace(/\/package\.json$/u, "");
}

function analyzeLockSource(source, state, { allowMissingIntegrity = false } = {}) {
  const stateErrors = uiStateLockContractErrors(state);
  if (stateErrors.length) throw new Error(`.workloom-ui.json 缺少可用于锁文件验真的稳定 UI 制品契约：${stateErrors.join("；")}`);
  if (typeof source !== "string" || !source.endsWith("\n") || source.includes("\r") || source.includes("\t")) {
    throw new Error("pnpm-lock.yaml 必须是 pnpm 10 生成的 LF/空格缩进文本并以换行结尾");
  }
  const lines = source.slice(0, -1).split("\n");
  const topEntries = entriesAt(lines, 0, lines.length, 0);
  const lockfileVersion = uniqueEntry(topEntries, "lockfileVersion", "pnpm-lock.yaml lockfileVersion");
  if (decodeScalar(lockfileVersion.value, "lockfileVersion") !== "9.0") {
    throw new Error("pnpm-lock.yaml lockfileVersion 必须为 pnpm 10 的 9.0");
  }

  const selector = `${state.package}@${state.version}`;
  const overrideRange = topLevelRange(lines, "overrides");
  const overrides = entriesAt(lines, overrideRange.start, overrideRange.end, 2);
  const uiOverrides = overrides.filter((entry) => isUiOverrideSelector(entry.key));
  const override = uniqueEntry(uiOverrides, selector, `pnpm-lock.yaml overrides ${selector}`);
  if (decodeScalar(override.value, `overrides.${selector}`) !== state.artifact.url || uiOverrides.length !== 1) {
    throw new Error("pnpm-lock.yaml 必须且只能包含同版本 canonical 共享 UI override");
  }

  const importerRange = topLevelRange(lines, "importers");
  const importers = entriesAt(lines, importerRange.start, importerRange.end, 2);
  for (const packagePath of REQUIRED_CLIENT_PACKAGES) {
    const path = importerPath(packagePath);
    const importer = uniqueEntry(importers, path, `pnpm-lock.yaml importer ${path}`);
    if (importer.value) throw new Error(`pnpm-lock.yaml importer ${path} 必须是映射`);
    const importerBlock = nestedRange(lines, importer, importerRange.end, 2);
    const dependencies = uniqueEntry(entriesAt(lines, importerBlock.start, importerBlock.end, 4), "dependencies", `importer ${path}.dependencies`);
    if (dependencies.value) throw new Error(`importer ${path}.dependencies 必须是映射`);
    const dependencyBlock = nestedRange(lines, dependencies, importerBlock.end, 4);
    const dependency = uniqueEntry(entriesAt(lines, dependencyBlock.start, dependencyBlock.end, 6), state.package, `importer ${path} ${state.package}`);
    if (dependency.value) throw new Error(`importer ${path} ${state.package} 必须是映射`);
    const uiBlock = nestedRange(lines, dependency, dependencyBlock.end, 6);
    const fields = entriesAt(lines, uiBlock.start, uiBlock.end, 8);
    const specifier = decodeScalar(uniqueEntry(fields, "specifier", `importer ${path} specifier`).value, `importer ${path} specifier`);
    const version = decodeScalar(uniqueEntry(fields, "version", `importer ${path} version`).value, `importer ${path} version`);
    if (specifier !== state.artifact.url) throw new Error(`importer ${path} specifier 未锁定 canonical Release URL`);
    if (version !== state.artifact.url && !version.startsWith(`${state.artifact.url}(`)) {
      throw new Error(`importer ${path} version 未解析到 canonical Release URL`);
    }
  }

  const packagesRange = topLevelRange(lines, "packages");
  const packages = entriesAt(lines, packagesRange.start, packagesRange.end, 2);
  const uiPackages = packages.filter((entry) => entry.key.startsWith(`${state.package}@`));
  if (uiPackages.length !== 1) {
    throw new Error(`pnpm-lock.yaml 必须且只能锁定一个 ${state.package} packages 记录，当前为 ${uiPackages.length}`);
  }
  const packageEntry = uiPackages[0];
  if (packageEntry.key !== `${state.package}@${state.artifact.url}` || packageEntry.value) {
    throw new Error(`pnpm-lock.yaml 的 ${state.package} packages key 必须精确绑定 canonical Release URL`);
  }
  const packageBlock = nestedRange(lines, packageEntry, packagesRange.end, 2);
  const packageFields = entriesAt(lines, packageBlock.start, packageBlock.end, 4);
  const version = decodeScalar(uniqueEntry(packageFields, "version", `${state.package} version`).value, `${state.package} version`);
  if (version !== state.version) throw new Error(`${state.package} packages version 必须为 ${state.version}`);
  const resolutionEntry = uniqueEntry(packageFields, "resolution", `${state.package} resolution`);
  const resolution = parseResolution(resolutionEntry.value);
  if (resolution.tarball !== state.artifact.url) throw new Error(`${state.package} resolution.tarball 必须为 canonical Release URL`);
  if (resolution.integrity === undefined && allowMissingIntegrity) {
    // pnpm 10.14 对 URL tarball 的刚生成 lock 不带 integrity；只允许这一种缺省。
  } else if (resolution.integrity !== state.artifact.sha512) {
    throw new Error(`${state.package} resolution.integrity 必须等于 .workloom-ui.json SHA-512`);
  }
  return { lines, resolutionEntry, resolution };
}

function readState(repo) {
  const statePath = join(repo, ".workloom-ui.json");
  if (!existsSync(statePath)) throw new Error("缺少 .workloom-ui.json");
  const stat = lstatSync(statePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(".workloom-ui.json 必须是仓内非符号链接普通文件");
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    throw new Error(".workloom-ui.json 不是有效 JSON");
  }
}

/**
 * 仅用于 pnpm 10.14 `install --lockfile-only` 与 frozen install 之间的发布 TCB。
 * 模块只使用 Node 内建库；先完整验证 state 与真实 pnpm 文本形态，再对唯一
 * canonical resolution 做一次原子替换。完整 YAML 语义复验由安装后的 consumer
 * verifier 执行。
 */
export function bindUiLockfileIntegrity(repoPath, state = undefined) {
  const repo = resolve(repoPath);
  const consumerState = state ?? readState(repo);
  const lockPath = join(repo, LOCKFILE_NAME);
  if (!existsSync(lockPath)) throw new Error(`缺少 ${LOCKFILE_NAME}`);
  const stat = lstatSync(lockPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${LOCKFILE_NAME} 必须是仓内非符号链接普通文件`);
  const source = readFileSync(lockPath, "utf8");
  const analysis = analyzeLockSource(source, consumerState, { allowMissingIntegrity: true });
  const existing = analysis.resolution.integrity;
  if (existing !== undefined && existing !== consumerState.artifact.sha512) {
    throw new Error(`${LOCKFILE_NAME} 已存在不同的 ${consumerState.package} integrity，拒绝静默覆盖`);
  }
  if (existing === consumerState.artifact.sha512) {
    analyzeLockSource(source, consumerState);
    return { changed: false, lockfile: lockPath, integrity: existing, packageKey: `${consumerState.package}@${consumerState.artifact.url}` };
  }

  const lines = [...analysis.lines];
  lines[analysis.resolutionEntry.index] = `    resolution: {integrity: ${consumerState.artifact.sha512}, tarball: ${consumerState.artifact.url}}`;
  const next = `${lines.join("\n")}\n`;
  // 在 rename 前对待写字节运行同一完整分析；后验失败不会把半成品留在仓内。
  analyzeLockSource(next, consumerState);
  if (readFileSync(lockPath, "utf8") !== source) throw new Error(`${LOCKFILE_NAME} 在绑定期间被并发修改`);
  const temporary = join(dirname(lockPath), `.${basename(lockPath)}.workloom-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, next, { flag: "wx", mode: stat.mode & 0o777 });
    chmodSync(temporary, stat.mode & 0o777);
    renameSync(temporary, lockPath);
  } finally {
    rmSync(temporary, { force: true });
  }
  return {
    changed: true,
    lockfile: lockPath,
    integrity: consumerState.artifact.sha512,
    packageKey: `${consumerState.package}@${consumerState.artifact.url}`,
  };
}

function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--repo");
  const repo = index >= 0 ? args[index + 1] : ".";
  if (!repo) throw new Error("--repo 需要目录参数");
  const result = bindUiLockfileIntegrity(repo);
  process.stdout.write(`✅ ${result.changed ? "已写入" : "已确认"} ${LOCKFILE_NAME} 的共享 UI SHA-512：${result.integrity}\n`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`❌ ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
