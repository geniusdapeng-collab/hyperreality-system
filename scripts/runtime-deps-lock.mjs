#!/usr/bin/env node
/**
 * 每产品桌面运行时依赖锁。
 *
 * pnpm-lock.yaml 是 monorepo 的事实源；本工具把各 importer 的运行依赖合成为
 * 精确 package.json，再以固定 npm 版本生成完整 package-lock.json。锁目录是
 * 产品派生资产，普通 base-sync 只下发本工具，不得把基座锁覆盖到行业仓。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildMergedRuntimeManifest, runtimeDependencySources } from "./pack-nm-merge.mjs";
import { loadProductRuntime } from "./product-runtime.mjs";
import { payloadPolicyFor } from "./payload-policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..");

export const RUNTIME_DEPS_DIR = ".workloom-runtime-deps";
export const RUNTIME_NPM_VERSION = "11.17.0";
export const RUNTIME_TARGETS = Object.freeze([
  Object.freeze({ platform: "darwin", arch: "arm64" }),
  Object.freeze({ platform: "darwin", arch: "x64" }),
  Object.freeze({ platform: "win32", arch: "x64" }),
]);

const NATIVE_FAMILIES = Object.freeze([
  Object.freeze({
    parent: "node_modules/esbuild",
    packages: Object.freeze({
      "darwin-arm64": "node_modules/@esbuild/darwin-arm64",
      "darwin-x64": "node_modules/@esbuild/darwin-x64",
      "win32-x64": "node_modules/@esbuild/win32-x64",
    }),
  }),
  Object.freeze({
    parent: "node_modules/@tailwindcss/oxide",
    packages: Object.freeze({
      "darwin-arm64": "node_modules/@tailwindcss/oxide-darwin-arm64",
      "darwin-x64": "node_modules/@tailwindcss/oxide-darwin-x64",
      "win32-x64": "node_modules/@tailwindcss/oxide-win32-x64-msvc",
    }),
  }),
  Object.freeze({
    parent: "node_modules/rolldown",
    packages: Object.freeze({
      "darwin-arm64": "node_modules/@rolldown/binding-darwin-arm64",
      "darwin-x64": "node_modules/@rolldown/binding-darwin-x64",
      "win32-x64": "node_modules/@rolldown/binding-win32-x64-msvc",
    }),
  }),
  Object.freeze({
    parent: "node_modules/lightningcss",
    packages: Object.freeze({
      "darwin-arm64": "node_modules/lightningcss-darwin-arm64",
      "darwin-x64": "node_modules/lightningcss-darwin-x64",
      "win32-x64": "node_modules/lightningcss-win32-x64-msvc",
    }),
  }),
]);

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} 无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function targetKey(target) {
  return `${target.platform}-${target.arch}`;
}

function targetFor(platform, arch) {
  const target = RUNTIME_TARGETS.find((item) => item.platform === platform && item.arch === arch);
  if (!target) throw new Error(`不支持的运行时目标 ${platform}-${arch}`);
  return target;
}

function productContext(root) {
  const product = loadProductRuntime(root);
  return { product, policy: payloadPolicyFor(product) };
}

function lockPaths(root) {
  const directory = join(root, RUNTIME_DEPS_DIR);
  return {
    directory,
    manifest: join(directory, "package.json"),
    lock: join(directory, "package-lock.json"),
    metadata: join(directory, "metadata.json"),
  };
}

function inputFiles(root, product, policy) {
  const byPath = new Map();
  for (const [path] of runtimeDependencySources(root, policy)) byPath.set(path, join(root, path));
  byPath.set("pnpm-lock.yaml", join(root, "pnpm-lock.yaml"));
  for (const path of [
    "scripts/pack-nm-merge.mjs",
    "scripts/runtime-deps-lock.mjs",
    "scripts/payload-policy.mjs",
    "scripts/product-runtime.mjs",
  ]) byPath.set(path, join(root, path));
  const manifestLabel = product.manifestPath.startsWith(`${resolve(root)}${sep}`)
    ? relative(root, product.manifestPath).split(sep).join("/")
    : "repository:product.manifest.json";
  byPath.set(manifestLabel, product.manifestPath);
  return [...byPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, absolute]) => {
      if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`运行依赖锁输入缺失：${path}`);
      return { path, sha256: sha256(readFileSync(absolute)) };
    });
}

function expectedMetadata(root, product, policy, manifest, packageLock) {
  return {
    schemaVersion: "workloom.runtime-deps/v1",
    product: {
      productId: product.productId,
      role: product.role,
      repository: product.repository,
      includePlatformOps: policy.includePlatformOps,
    },
    npmVersion: RUNTIME_NPM_VERSION,
    targets: RUNTIME_TARGETS,
    inputs: inputFiles(root, product, policy),
    manifestSha256: sha256(json(manifest)),
    packageLockSha256: sha256(json(packageLock)),
  };
}

function assertRegistryEntry(path, entry) {
  if (typeof entry?.version !== "string" || !entry.version) throw new Error(`runtime package-lock 缺少版本：${path}`);
  if (entry.link) throw new Error(`runtime package-lock 不得包含链接：${path}`);
  if (entry.inBundle) return;
  if (typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://registry.npmjs.org/")) {
    throw new Error(`runtime package-lock 只允许 npm 官方 registry：${path}`);
  }
  if (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)) {
    throw new Error(`runtime package-lock 缺少 SHA-512 完整性：${path}`);
  }
}

export function verifyRuntimePackageLock(manifest, packageLock) {
  if (packageLock?.lockfileVersion !== 3 || !packageLock?.packages || typeof packageLock.packages !== "object") {
    throw new Error("runtime package-lock 必须是 npm lockfileVersion 3");
  }
  const root = packageLock.packages[""];
  if (!root || root.name !== manifest.name || root.version !== manifest.version || !same(root.dependencies, manifest.dependencies)) {
    throw new Error("runtime package-lock 根依赖与精确 manifest 不一致");
  }
  for (const [path, entry] of Object.entries(packageLock.packages)) {
    if (path) assertRegistryEntry(path, entry);
  }
  for (const name of Object.keys(manifest.dependencies)) {
    const path = `node_modules/${name}`;
    if (!packageLock.packages[path]) throw new Error(`runtime package-lock 缺少直接依赖：${name}`);
  }
  for (const family of NATIVE_FAMILIES) {
    if (!packageLock.packages[family.parent]) continue;
    for (const target of RUNTIME_TARGETS) {
      const path = family.packages[targetKey(target)];
      const entry = packageLock.packages[path];
      if (!entry) throw new Error(`runtime package-lock 缺少 ${targetKey(target)} 原生包：${path}`);
      const expectedOs = target.platform;
      if (Array.isArray(entry.os) && !entry.os.includes(expectedOs)) {
        throw new Error(`runtime package-lock 原生包 OS 标记错误：${path}`);
      }
      if (Array.isArray(entry.cpu) && !entry.cpu.includes(target.arch)) {
        throw new Error(`runtime package-lock 原生包 CPU 标记错误：${path}`);
      }
    }
  }
  return packageLock;
}

export function verifyRuntimeDepsLock(root = DEFAULT_ROOT) {
  const resolvedRoot = resolve(root);
  const { product, policy } = productContext(resolvedRoot);
  const expectedManifest = buildMergedRuntimeManifest(resolvedRoot, policy);
  const paths = lockPaths(resolvedRoot);
  const actualManifest = readJson(paths.manifest, `${RUNTIME_DEPS_DIR}/package.json`);
  if (!same(actualManifest, expectedManifest)) throw new Error("runtime 精确 manifest 已过期，请刷新每产品依赖锁");
  const packageLock = verifyRuntimePackageLock(actualManifest, readJson(paths.lock, `${RUNTIME_DEPS_DIR}/package-lock.json`));
  const metadata = readJson(paths.metadata, `${RUNTIME_DEPS_DIR}/metadata.json`);
  const expected = expectedMetadata(resolvedRoot, product, policy, actualManifest, packageLock);
  if (!same(metadata, expected)) throw new Error("runtime 依赖锁元数据或输入摘要已过期，请刷新每产品依赖锁");
  return Object.freeze({ product, policy, manifest: actualManifest, packageLock, metadata, paths });
}

function npmDlx(root, args) {
  return execFileSync("pnpm", ["dlx", `npm@${RUNTIME_NPM_VERSION}`, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function refreshRuntimeDepsLock(root = DEFAULT_ROOT) {
  const resolvedRoot = resolve(root);
  const { product, policy } = productContext(resolvedRoot);
  const manifest = buildMergedRuntimeManifest(resolvedRoot, policy);
  const temporary = mkdtempSync(join(tmpdir(), "workloom-runtime-lock-"));
  try {
    writeFileSync(join(temporary, "package.json"), json(manifest));
    npmDlx(temporary, [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--include=optional",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
    ]);
    const packageLock = verifyRuntimePackageLock(manifest, readJson(join(temporary, "package-lock.json"), "新生成 runtime package-lock"));
    const metadata = expectedMetadata(resolvedRoot, product, policy, manifest, packageLock);
    const paths = lockPaths(resolvedRoot);
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.manifest, json(manifest));
    writeFileSync(paths.lock, json(packageLock));
    writeFileSync(paths.metadata, json(metadata));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return verifyRuntimeDepsLock(resolvedRoot);
}

function allows(values, target) {
  if (!Array.isArray(values) || values.length === 0) return true;
  const denied = values.filter((value) => String(value).startsWith("!")).map((value) => String(value).slice(1));
  if (denied.includes(target)) return false;
  const allowed = values.filter((value) => !String(value).startsWith("!"));
  return allowed.length === 0 || allowed.includes(target);
}

function installedPackages(nodeModulesRoot) {
  const found = [];
  const visitNodeModules = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".bin" || entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        for (const scoped of readdirSync(absolute, { withFileTypes: true })) {
          if (scoped.isDirectory() && !scoped.isSymbolicLink()) visitPackage(join(absolute, scoped.name));
        }
      } else {
        visitPackage(absolute);
      }
    }
  };
  const visitPackage = (directory) => {
    const packageJson = join(directory, "package.json");
    if (existsSync(packageJson)) found.push({ directory, value: readJson(packageJson, `已安装包 ${relative(nodeModulesRoot, directory)}`) });
    const nested = join(directory, "node_modules");
    if (existsSync(nested)) visitNodeModules(nested);
  };
  visitNodeModules(nodeModulesRoot);
  return found;
}

export function verifyInstalledRuntimeTarget(stage, platform, arch, verified = null) {
  const target = targetFor(platform, arch);
  const context = verified ?? verifyRuntimeDepsLock(DEFAULT_ROOT);
  const nodeModules = join(resolve(stage), "node_modules");
  if (!existsSync(nodeModules)) throw new Error("runtime npm ci 未产出 node_modules");
  for (const [name] of Object.entries(context.manifest.dependencies)) {
    if (!existsSync(join(nodeModules, ...name.split("/"), "package.json"))) {
      throw new Error(`runtime npm ci 缺少直接依赖：${name}`);
    }
  }
  for (const item of installedPackages(nodeModules)) {
    if (!allows(item.value.os, target.platform) || !allows(item.value.cpu, target.arch)) {
      throw new Error(`runtime npm ci 混入非目标原生包：${relative(nodeModules, item.directory)}`);
    }
  }
  for (const family of NATIVE_FAMILIES) {
    if (!context.packageLock.packages[family.parent]) continue;
    const path = family.packages[targetKey(target)].replace(/^node_modules\//u, "");
    if (!existsSync(join(nodeModules, ...path.split("/"), "package.json"))) {
      throw new Error(`runtime npm ci 缺少目标原生包：${path}`);
    }
  }
  const inventory = installedPackages(nodeModules)
    .map((item) => `${relative(nodeModules, item.directory).split(sep).join("/")}@${item.value.version}`)
    .sort();
  return Object.freeze({ target, packages: inventory.length, inventorySha256: sha256(`${inventory.join("\n")}\n`) });
}

function systemNpmVersion() {
  try {
    return execFileSync("npm", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error(`缺少 npm ${RUNTIME_NPM_VERSION}；正式装配必须使用 Node 24.19.0 自带 npm`);
  }
}

export function stageRuntimeDependencies(root, stage, platform, arch, registry = "https://registry.npmjs.org") {
  const resolvedRoot = resolve(root);
  const verified = verifyRuntimeDepsLock(resolvedRoot);
  const target = targetFor(platform, arch);
  const npmVersion = systemNpmVersion();
  if (npmVersion !== RUNTIME_NPM_VERSION) {
    throw new Error(`npm 版本不受控：期望 ${RUNTIME_NPM_VERSION}，实际 ${npmVersion}`);
  }
  const targetDir = resolve(stage);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "package.json"), json(verified.manifest));
  writeFileSync(join(targetDir, "package-lock.json"), json(verified.packageLock));
  execFileSync("npm", [
    "ci",
    "--ignore-scripts",
    "--legacy-peer-deps",
    "--include=optional",
    "--no-audit",
    "--no-fund",
    `--os=${target.platform}`,
    `--cpu=${target.arch}`,
    `--registry=${registry}`,
  ], { cwd: targetDir, stdio: "inherit" });
  return verifyInstalledRuntimeTarget(targetDir, target.platform, target.arch, verified);
}

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function main() {
  const command = process.argv[2];
  const root = resolve(arg("--root", DEFAULT_ROOT));
  if (command === "refresh") {
    const result = refreshRuntimeDepsLock(root);
    console.log(`✅ runtime 依赖锁已刷新：${result.product.productId} · npm ${RUNTIME_NPM_VERSION}`);
    return;
  }
  if (command === "verify") {
    const result = verifyRuntimeDepsLock(root);
    console.log(`✅ runtime 依赖锁有效：${result.product.productId} · ${Object.keys(result.manifest.dependencies).length} 个直接依赖`);
    return;
  }
  if (command === "stage") {
    const directory = process.argv[3];
    if (!directory) throw new Error("stage 缺少输出目录");
    const result = stageRuntimeDependencies(root, directory, arg("--os"), arg("--cpu"), arg("--registry", "https://registry.npmjs.org"));
    console.log(`✅ runtime npm ci：${targetKey(result.target)} · ${result.packages} 包 · ${result.inventorySha256}`);
    return;
  }
  throw new Error("用法：runtime-deps-lock.mjs refresh|verify [--root DIR] | stage DIR --os darwin|win32 --cpu arm64|x64 [--registry URL]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
