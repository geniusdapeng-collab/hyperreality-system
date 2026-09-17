#!/usr/bin/env node
/**
 * 公共产品运行身份解析器。
 *
 * 基座脚本、桌面打包和本地编排只能从受保护的 product.manifest.json 读取
 * 产品名、仓库与端口偏移；禁止把 workloom-im 或任一行业名称写死在公共能力中。
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PRODUCT_ROOT = resolve(HERE, "..");
const BASE_REPOSITORY = "workloom-ai/workloom-im";

function isOrdinaryFile(path) {
  try {
    const value = lstatSync(path);
    return value.isFile() && !value.isSymbolicLink();
  } catch {
    return false;
  }
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function safePathPrefix(value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\")) return null;
  const normalized = value.replace(/\/$/u, "") || ".";
  if (normalized.split("/").some((part) => !part || part === "..")) return null;
  return normalized;
}

function scriptTrustRoot() {
  // 普通仓和正式载荷的清单与 scripts/ 同根；优先固定在本产品目录，绝不借用外层仓库。
  if (isOrdinaryFile(join(SCRIPT_PRODUCT_ROOT, "product.manifest.json"))) return SCRIPT_PRODUCT_ROOT;

  // Tiger 等 monorepo 子目录形态由根级同步 state 显式绑定 pathPrefix。只有完整同步、
  // 官方基座、精确 SHA 与真实路径均吻合时，才允许脚本向上读取仓根产品身份。
  let candidate = dirname(SCRIPT_PRODUCT_ROOT);
  while (true) {
    const statePath = join(candidate, ".workloom-base-sync.json");
    if (isOrdinaryFile(statePath)) {
      let state;
      try { state = JSON.parse(readFileSync(statePath, "utf8")); }
      catch { throw new Error("根级 .workloom-base-sync.json 无法解析"); }
      const prefix = safePathPrefix(state?.pathPrefix);
      const boundDirectory = prefix ? resolve(candidate, prefix) : null;
      const validBinding = state?.baseRepo === BASE_REPOSITORY
        && state?.lastSyncMode === "full"
        && /^[0-9a-f]{40}$/u.test(state?.lastSyncedBaseSha ?? "")
        && boundDirectory === SCRIPT_PRODUCT_ROOT
        && existsSync(boundDirectory)
        && realpathSync(boundDirectory) === realpathSync(SCRIPT_PRODUCT_ROOT);
      if (validBinding) {
        if (!isOrdinaryFile(join(candidate, "product.manifest.json"))) {
          throw new Error("pathPrefix 产品仓根缺少受保护的 product.manifest.json");
        }
        return candidate;
      }
    }
    if (existsSync(join(candidate, ".git"))) break;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return SCRIPT_PRODUCT_ROOT;
}

const SCRIPT_TRUST_ROOT = scriptTrustRoot();

function findManifest(start) {
  const resolvedStart = resolve(start);
  // 运行时脚本本身就是产品载荷的信任锚。即使载荷被解压到另一个 Git 仓库中，
  // 也不得越过该锚点去借用外层仓库的产品身份。
  const boundary = isWithin(SCRIPT_TRUST_ROOT, resolvedStart)
    ? SCRIPT_TRUST_ROOT
    : null;
  let current = resolvedStart;
  while (true) {
    const manifestPath = join(current, "product.manifest.json");
    if (existsSync(manifestPath)) return { repositoryRoot: current, manifestPath };
    if (current === boundary) break;
    // 对显式传入的仓库外测试/工具起点，以最近的 Git 工作树标记为上行边界。
    // 不再调用 `git rev-parse`，避免非 Git 载荷被跳转到外部 Git 根。
    if (!boundary && existsSync(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    if (boundary && !isWithin(boundary, parent)) break;
    current = parent;
  }
  throw new Error("缺少受保护的 product.manifest.json");
}

export function loadProductRuntime(start = SCRIPT_PRODUCT_ROOT) {
  const { repositoryRoot, manifestPath } = findManifest(start);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("product.manifest.json 无法解析");
  }
  const schemaVersion = manifest?.schemaVersion;
  const productId = manifest?.productId;
  const role = manifest?.role;
  const displayName = manifest?.displayName;
  const repository = manifest?.repository;
  const demoWorkspaceSlug = manifest?.demoWorkspaceSlug;
  const demoMemberNo = manifest?.demoMemberNo;
  const portOffset = manifest?.desktop?.portOffset;
  if (schemaVersion !== "workloom.product/v1") {
    throw new Error("product.manifest.json 缺少受支持的 schemaVersion");
  }
  if (typeof productId !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(productId)) {
    throw new Error("product.manifest.json 缺少有效产品标识");
  }
  if (typeof role !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(role)) {
    throw new Error("product.manifest.json 缺少有效产品角色");
  }
  if (
    typeof displayName !== "string"
    || displayName.trim() !== displayName
    || displayName.length < 2
    || displayName.length > 80
    || /[\u0000-\u001f\u007f]/.test(displayName)
  ) {
    throw new Error("product.manifest.json 缺少有效产品名称");
  }
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("product.manifest.json 缺少有效 GitHub 仓库");
  }
  if (typeof demoWorkspaceSlug !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(demoWorkspaceSlug)) {
    throw new Error("product.manifest.json 缺少有效演示工作区标识");
  }
  if (typeof demoMemberNo !== "string" || !/^[A-Z][A-Z0-9-]{1,31}$/.test(demoMemberNo)) {
    throw new Error("product.manifest.json 缺少有效演示成员编号");
  }
  if (!Number.isInteger(portOffset) || portOffset < 0 || portOffset > 900) {
    throw new Error("product.manifest.json 的桌面端口偏移必须是 0 到 900 的整数");
  }
  return Object.freeze({
    repositoryRoot,
    manifestPath,
    schemaVersion,
    productId,
    role,
    displayName,
    repository,
    demoWorkspaceSlug,
    demoMemberNo,
    portOffset,
    serverPort: 8787 + portOffset,
    webPort: 5173 + portOffset,
    pgPort: 5432 + portOffset,
    natsPort: 4222 + portOffset,
  });
}

function main() {
  const manifestPathRequested = process.argv.includes("--manifest-path");
  const fieldIndex = process.argv.indexOf("--field");
  const field = fieldIndex >= 0 ? process.argv[fieldIndex + 1] : null;
  const product = loadProductRuntime();
  if (manifestPathRequested && !field) {
    process.stdout.write(`${product.manifestPath}\n`);
    return;
  }
  if (!field || !Object.hasOwn(product, field) || field === "repositoryRoot" || field === "manifestPath") {
    throw new Error("用法：node scripts/product-runtime.mjs --manifest-path | --field schemaVersion|productId|role|displayName|repository|demoWorkspaceSlug|demoMemberNo|portOffset|serverPort|webPort|pgPort|natsPort");
  }
  process.stdout.write(`${product[field]}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
