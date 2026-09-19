#!/usr/bin/env node
/**
 * oss-inventory · WorkLoom 开源组件全量清单生成器（离线、确定性、可复现）
 *
 * 职责：
 *   ① 扫描本仓真实依赖事实（pnpm workspace + lockfile、供应商 vendor 代码、Python
 *      requirements、容器镜像、随包二进制、工具链），生成 docs/OPEN_SOURCE_COMPONENTS.md；
 *   ② 与 oss-components.json（人工登记的治理清单）合并渲染：登记组件带「当前使用版本 /
 *      上游最新版本 / 注意事项」，全量直接依赖带「当前版本 / 上游最新」；
 *   ③ --check 做零网络一致性门禁：清单与仓库事实漂移即失败（供 CI 使用）。
 *
 * 用法：
 *   node scripts/oss-inventory.mjs --write        # 生成/刷新清单文档
 *   node scripts/oss-inventory.mjs --check        # CI 门禁：清单是否与仓库事实一致
 *   node scripts/oss-inventory.mjs --json         # 打印机器可读清单
 *   node scripts/oss-inventory.mjs --self-test    # 内置规则自检
 *
 * 数据来源（事实源优先级）：
 *   当前版本 = pnpm-lock.yaml importers（A 级：锁文件实际解析结果）> package.json 声明
 *   上游最新 = .oss-watch-state.json#registryCache（由 scripts/oss-watch.sh 联网刷新）
 *
 * 纪律：本脚本只读仓库、零网络；写盘仅限清单文档（--write）。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * YAML 解析：优先用仓库依赖 `yaml`（pnpm install 后可用）；在 Python 仓或无依赖环境
 * 退化为内置子集解析（仅覆盖本脚本需要的四类结构：workspace globs、lockfile importers、
 * compose/cnb 镜像行）。降级时结果标记 `yamlFallback=true`，不谎报全量解析。
 */
let YAML = null;
try {
  ({ default: YAML } = await import("yaml"));
} catch {
  YAML = null;
}
export const YAML_AVAILABLE = Boolean(YAML);

/** 子集解析：workspace globs / lockfile importers / 镜像行。 */
function parseYamlSubset(text, kind) {
  if (kind === "workspace") {
    return {
      packages: [...text.matchAll(/^\s*-\s*["']?([^"'\s#]+)["']?\s*$/gm)].map((match) => match[1]),
    };
  }
  if (kind === "lockfile") {
    const importers = {};
    const packages = {};
    let importer = null;
    let section = null;
    let dep = null;
    let inPackages = false;
    for (const raw of text.split("\n")) {
      if (!raw.trim() || raw.trim().startsWith("#")) continue;
      const indent = raw.length - raw.trimStart().length;
      const line = raw.trim();
      if (indent === 0 && line === "packages:") {
        inPackages = true;
        importer = null;
        section = null;
        dep = null;
        continue;
      }
      if (indent === 0 && line.endsWith(":")) inPackages = false;
      if (inPackages) {
        if (indent === 2 && line.endsWith(":")) {
          const key = line.slice(0, -1).replace(/^["']|["']$/g, "");
          packages[key] = packages[key] ?? {};
        }
        continue;
      }
      if (indent === 2 && line.endsWith(":") && !line.startsWith("-")) {
        importer = line.slice(0, -1).replace(/^["']|["']$/g, "");
        importers[importer] = importers[importer] ?? {};
        section = null;
        dep = null;
        continue;
      }
      if (!importer) continue;
      if (indent === 4 && /^(dependencies|devDependencies|optionalDependencies):$/.test(line)) {
        section = line.slice(0, -1);
        importers[importer][section] = importers[importer][section] ?? {};
        dep = null;
        continue;
      }
      if (!section) continue;
      const nameMatch = line.match(/^["']?((?:@[^/]+\/)?[^"':]+)["']?:$/);
      if (indent === 6 && nameMatch) {
        dep = nameMatch[1];
        importers[importer][section][dep] = {};
        continue;
      }
      if (indent === 8 && dep && line.startsWith("version:")) {
        importers[importer][section][dep].version = line.slice("version:".length).trim().replace(/^["']|["']$/g, "");
        continue;
      }
      if (indent === 8 && dep && line.startsWith("specifier:")) {
        importers[importer][section][dep].specifier = line.slice("specifier:".length).trim().replace(/^["']|["']$/g, "");
      }
    }
    return { importers, packages };
  }
  if (kind === "images") {
    return { images: [...text.matchAll(/^\s*image:\s*["']?([^"'\s#]+)["']?\s*$/gm)].map((m) => m[1]) };
  }
  if (kind === "services") {
    const services = {};
    let current = null;
    for (const raw of text.split("\n")) {
      const serviceMatch = raw.match(/^  ([A-Za-z0-9_.-]+):\s*$/);
      if (serviceMatch) {
        current = serviceMatch[1];
        services[current] = {};
        continue;
      }
      const imageMatch = raw.match(/^\s{4}image:\s*["']?([^"'\s#]+)["']?\s*$/);
      if (current && imageMatch) services[current].image = imageMatch[1];
    }
    return { services };
  }
  return null;
}

function readYamlSubset(path, kind) {
  const text = readText(path, "");
  if (!text) return null;
  return parseYamlSubset(text, kind);
}

export const REGISTRY_FILE = "oss-components.json";
export const STATE_FILE = ".oss-watch-state.json";
export const DOC_FILE = "docs/OPEN_SOURCE_COMPONENTS.md";
export const PLAN_FILE = "docs/oss-update-plan.md";
export const SCHEMA = "workloom.oss-components/v2";
export const INVENTORY_SCHEMA = "workloom.oss-inventory/v1";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  "cache",
  "dist",
  "dist-payload",
  "reports",
  ".pytest_cache",
  "__pycache__",
]);

/* ============================ 基础 IO ============================ */

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function readText(path, fallback = "") {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

export function readYaml(path, fallback = null) {
  try {
    return YAML.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function posix(path) {
  return path.split(sep).join("/");
}

/** 递归收集文件（相对仓库根的 posix 路径），跳过构建产物与依赖目录。 */
export function walkFiles(root, { filter = () => true, maxDepth = 8 } = {}) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(full, depth + 1);
      } else if (entry.isFile() && filter(posix(relative(root, full)))) {
        found.push(posix(relative(root, full)));
      }
    }
  };
  visit(root, 0);
  return found;
}

/* ============================ 语义版本 ============================ */

/** 归一化版本串：去 ^ ~ = v 前缀与空白，保留 prerelease，取自 range 的首个版本。 */
export function normalizeVersion(raw) {
  if (typeof raw !== "string") return null;
  const match = raw.trim().match(/v?(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

/** 版本比较：a>b 返回 1，a<b 返回 -1，相等 0；含 prerelease 时按 semver 规则（1.0.0-rc < 1.0.0）。 */
export function compareVersions(a, b) {
  const pa = normalizeVersion(a);
  const pb = normalizeVersion(b);
  if (!pa || !pb) return null;
  const split = (value) => {
    const [core, pre = ""] = value.split("-");
    const nums = core.split(".").map((part) => Number.parseInt(part, 10));
    return { nums, pre };
  };
  const A = split(pa);
  const B = split(pb);
  for (let index = 0; index < 3; index += 1) {
    const left = A.nums[index] ?? 0;
    const right = B.nums[index] ?? 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

export function isOutdated(current, latest) {
  const verdict = compareVersions(current, latest);
  return verdict === -1;
}

/** 取一组版本串中的最高版本（用于「本仓实际使用版本」对比上游最新）。 */
export function highestVersion(versions) {
  const list = (versions ?? []).filter((value) => normalizeVersion(value));
  if (!list.length) return null;
  return [...list].sort((a, b) => compareVersions(a, b) ?? 0)[list.length - 1];
}

/* ============================ 依赖事实采集 ============================ */

function matchesWorkspacePattern(pattern, path) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

export function readWorkspacePatterns(root) {
  const file = join(root, "pnpm-workspace.yaml");
  const doc = YAML_AVAILABLE ? readYaml(file) : readYamlSubset(file, "workspace");
  const patterns = doc?.packages;
  return Array.isArray(patterns) ? patterns : [];
}

export function readLockfile(root) {
  return readLockfileAt(root, "pnpm-lock.yaml");
}

export function readLockfileAt(root, file) {
  const target = join(root, file);
  const doc = YAML_AVAILABLE ? readYaml(target) : readYamlSubset(target, "lockfile");
  const importers = doc?.importers ?? {};
  const result = {};
  for (const [path, entry] of Object.entries(importers)) {
    const deps = {};
    for (const kind of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, info] of Object.entries(entry?.[kind] ?? {})) {
        const raw = typeof info === "string" ? info : info?.version ?? "";
        const specifier = typeof info === "object" ? info?.specifier ?? "" : raw;
        const resolved = raw.startsWith("link:") ? "workspace" : normalizeVersion(raw) ?? raw;
        deps[name] = { kind, specifier, raw, resolved };
      }
    }
    result[path] = deps;
  }
  return result;
}

/** lockfile 的 packages 段：包名 → 已解析的全部版本（升序），用于取「实际解析版本」。 */
export function readLockPackagesAt(root, file) {
  const target = join(root, file);
  const doc = YAML_AVAILABLE ? readYaml(target) : readYamlSubset(target, "lockfile");
  if (!doc) return {};
  const versions = {};
  for (const key of Object.keys(doc?.packages ?? {})) {
    const match = key.match(/^(@[^/]+\/[^@]+|[^@][^@]*)@(.+)$/);
    if (!match) continue;
    const version = normalizeVersion(match[2]);
    if (!version) continue;
    if (!versions[match[1]]) versions[match[1]] = [];
    if (!versions[match[1]].includes(version)) versions[match[1]].push(version);
  }
  for (const name of Object.keys(versions)) {
    versions[name].sort((a, b) => compareVersions(a, b) ?? 0);
  }
  return versions;
}

/** 全仓直接依赖（按 manifest 分组 + 去重汇总）。 */
export function collectNpmInventory(root) {
  const manifests = walkFiles(root, { filter: (path) => path.endsWith("package.json") });
  const patterns = readWorkspacePatterns(root);
  const entries = [];
  const packages = {};
  const lockCache = new Map();
  const workspaceMembers = new Set();

  /** 就近锁定文件：支持嵌套工程（如子仓 governance/ 自带 pnpm-lock.yaml）。 */
  const nearestLock = (manifestDir) => {
    if (lockCache.has(manifestDir)) return lockCache.get(manifestDir);
    let dir = manifestDir;
    let found = null;
    for (;;) {
      const candidate = dir === "." ? "pnpm-lock.yaml" : `${dir}/pnpm-lock.yaml`;
      if (existsSync(join(root, candidate))) {
        found = { file: candidate, dir, importers: readLockfileAt(root, candidate) };
        break;
      }
      if (dir === ".") break;
      const parent = dirname(dir);
      dir = parent === "." ? "." : parent;
    }
    lockCache.set(manifestDir, found);
    return found;
  };

  for (const manifestPath of manifests.sort()) {
    const dir = dirname(manifestPath) === "." ? "." : dirname(manifestPath);
    const manifest = readJson(join(root, manifestPath));
    if (!manifest) continue;
    const lock = nearestLock(dir);
    const relativeToLock = lock ? (dir === lock.dir ? "." : dir.slice(lock.dir.length + 1)) : dir;
    const importer = lock?.importers?.[relativeToLock] ?? {};
    const workspace =
      dir === "." ||
      patterns.some((pattern) => matchesWorkspacePattern(pattern, dir)) ||
      Boolean(lock?.importers?.[relativeToLock]) ||
      (lock?.dir === "." ? false : patterns.some((pattern) => matchesWorkspacePattern(pattern, relativeToLock)));
    if (workspace) workspaceMembers.add(manifestPath);
    const kindOf = (section) => {
      if (section === "optionalDependencies") return "optional";
      return section === "devDependencies" ? "dev" : "prod";
    };
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
        if (specifier.startsWith("workspace:")) continue;
        const locked = importer[name];
        const aliasMatch = String(specifier).match(/^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/);
        const packageName = aliasMatch ? aliasMatch[1] : name;
        const entry = {
          name,
          package: packageName,
          alias: aliasMatch ? name : null,
          kind: kindOf(section),
          specifier: String(specifier),
          version: locked?.resolved ?? normalizeVersion(String(specifier)) ?? String(specifier),
          versionSource: locked?.resolved ? "pnpm-lock.yaml" : "package.json",
          resolution: locked?.resolved ? "lockfile" : "declared",
          importer: manifestPath,
          workspace,
        };
        entries.push(entry);
        const key = name;
        if (!packages[key]) {
          packages[key] = {
            name,
            package: packageName,
            aliases: [],
            kinds: new Set(),
            importers: new Set(),
            versions: new Set(),
            specifiers: new Set(),
          };
        }
        const bucket = packages[key];
        if (aliasMatch) bucket.aliases.push(name);
        bucket.kinds.add(entry.kind);
        bucket.importers.add(manifestPath);
        bucket.versions.add(entry.version);
        bucket.specifiers.add(entry.specifier);
        bucket.resolution = bucket.resolution === "lockfile" || entry.resolution === "lockfile" ? "lockfile" : "declared";
      }
    }
  }

  const packageList = Object.values(packages)
    .map((bucket) => ({
      name: bucket.name,
      package: bucket.package,
      aliases: [...new Set(bucket.aliases)].sort(),
      kinds: [...bucket.kinds].sort(),
      importers: [...bucket.importers].sort(),
      versions: [...bucket.versions].sort(),
      specifiers: [...bucket.specifiers].sort(),
      resolution: bucket.resolution ?? "declared",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { entries, packages: packageList, workspaceMembers: [...workspaceMembers].sort() };
}

/** Python 依赖：requirements.txt / pyproject 声明的第三方包。 */
export function collectPythonInventory(root) {
  const files = walkFiles(root, {
    filter: (path) =>
      path.endsWith("requirements.txt") ||
      path === "requirements.txt" ||
      path.endsWith("requirements-dev.txt"),
  });
  const entries = [];
  for (const file of files.sort()) {
    const lines = readText(join(root, file)).split("\n");
    for (const line of lines) {
      const text = line.trim();
      if (!text || text.startsWith("#") || text.startsWith("-")) continue;
      const match = text.match(/^([A-Za-z0-9_.\-\[\]]+)\s*(==|>=|~=|<=|>|<)?\s*([0-9][^;\s]*)?/);
      if (!match) continue;
      const name = match[1].split("[")[0];
      const constraint = `${match[2] ?? ""}${match[3] ?? ""}`.trim();
      entries.push({
        package: name,
        name,
        version: match[3] ?? null,
        specifier: constraint || "（未锁版本）",
        source: file,
      });
    }
  }
  const merged = new Map();
  for (const entry of entries.sort((a, b) => a.package.localeCompare(b.package))) {
    const key = entry.package.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      if (!existing.sources.includes(entry.source)) existing.sources.push(entry.source);
      if (entry.version && !existing.versions.includes(entry.version)) existing.versions.push(entry.version);
    } else {
      merged.set(key, {
        package: entry.package,
        specifier: entry.specifier,
        versions: entry.version ? [entry.version] : [],
        sources: [entry.source],
      });
    }
  }
  return [...merged.values()];
}

/** 容器/流水线镜像：docker-compose、Dockerfile、.cnb.yml。 */
export function collectContainerInventory(root) {
  const images = new Map();
  const add = (image, source) => {
    if (!image || typeof image !== "string") return;
    const key = image.split("@")[0];
    if (!images.has(key)) images.set(key, { image: key, sources: new Set() });
    images.get(key).sources.add(source);
  };
  const composePath = join(root, "docker-compose.yml");
  const compose = YAML_AVAILABLE ? readYaml(composePath) : readYamlSubset(composePath, "services");
  for (const [name, service] of Object.entries(compose?.services ?? {})) {
    add(service?.image, `docker-compose.yml#${name}`);
  }
  const cnbPath = join(root, ".cnb.yml");
  if (existsSync(cnbPath)) {
    const visit = (node, path = "") => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "image" && typeof value === "string" && value.includes(":")) add(value, ".cnb.yml");
        else visit(value, `${path}.${key}`);
      }
    };
    if (YAML_AVAILABLE) {
      visit(readYaml(cnbPath, {}));
    } else {
      for (const image of readYamlSubset(cnbPath, "images")?.images ?? []) add(image, ".cnb.yml");
    }
  }
  for (const file of walkFiles(root, { filter: (path) => /(^|\/)Dockerfile(\.|$)/.test(path) })) {
    for (const line of readText(join(root, file)).split("\n")) {
      const match = line.match(/^\s*FROM\s+([^\s]+)/i);
      if (match) add(match[1], file);
    }
  }
  return [...images.values()]
    .map((entry) => ({ image: entry.image, sources: [...entry.sources].sort() }))
    .sort((a, b) => a.image.localeCompare(b.image));
}

/** 随包二进制/素材引脚：登记表 probe 声明的正则解析（如 nats-server、PG）。 */
export function probeVersions(root, components) {
  const results = {};
  for (const component of components ?? []) {
    results[component.name] = null;
    const probe = component.probe;
    if (!probe) continue;
    if (probe.kind === "regex") {
      const text = readText(join(root, probe.file));
      if (!text) continue;
      const match = text.match(new RegExp(probe.pattern, "m"));
      if (match?.[1]) results[component.name] = { value: match[1], source: probe.file };
    } else if (probe.kind === "docker") {
      const images = collectContainerInventory(root);
      const hit = images.find((entry) => entry.image.startsWith(probe.image));
      if (hit) results[component.name] = { value: hit.image.split(":")[1] ?? "latest", source: hit.sources[0] };
    } else if (probe.kind === "vendor") {
      const manifest = readJson(join(root, probe.file));
      if (manifest?.version) results[component.name] = { value: manifest.version, source: probe.file };
    } else if (probe.kind === "lockfile") {
      const file = probe.file ?? "pnpm-lock.yaml";
      const resolved = readLockPackagesAt(root, file)[probe.package] ?? [];
      if (resolved.length) {
        results[component.name] = { value: resolved[resolved.length - 1], source: file };
      } else {
        const lock = readLockfileAt(root, file);
        for (const deps of Object.values(lock)) {
          if (deps[probe.package]) {
            results[component.name] = { value: deps[probe.package].resolved, source: file };
            break;
          }
        }
      }
    }
  }
  return results;
}

export function collectToolchain(root) {
  const rootManifest = readJson(join(root, "package.json"));
  const metadata = readJson(join(root, ".workloom-runtime-deps/metadata.json"));
  const images = collectContainerInventory(root);
  const nodeImage = images.find((entry) => entry.image.startsWith("node:"))?.image ?? null;
  return {
    node: rootManifest?.engines?.node ?? null,
    packageManager: rootManifest?.packageManager ?? null,
    runtimeNpm: metadata?.npmVersion ?? null,
    runtimeTargets: metadata?.targets ?? [],
    ciNodeImage: nodeImage,
  };
}

/** 汇总本仓全部开源依赖事实。 */
export function buildInventory(root) {
  return {
    schema: INVENTORY_SCHEMA,
    npm: collectNpmInventory(root),
    python: collectPythonInventory(root),
    containers: collectContainerInventory(root),
    toolchain: collectToolchain(root),
  };
}

/* ============================ 登记表 / 状态 ============================ */

export function loadRegistry(root) {
  const registry = readJson(join(root, REGISTRY_FILE));
  if (!registry) return { meta: {}, components: [] };
  return { meta: registry.meta ?? {}, components: Array.isArray(registry.components) ? registry.components : [] };
}

export function loadState(root) {
  const state = readJson(join(root, STATE_FILE));
  return state && typeof state === "object" ? state : {};
}

/** 登记条目当前版本的自动探测（probe 优先，其次 npm/pypi 包名比对）。 */
export function resolveCurrent(component, inventory, probes) {
  const probe = probes?.[component.name];
  if (probe?.value) return { current: probe.value, source: probe.source, evidence: "A" };
  if (component.channel === "npm" && component.package) {
    const hit = inventory.npm.packages.find(
      (entry) => entry.name === component.package || entry.package === component.package,
    );
    if (hit) {
      return {
        current: hit.versions.join(" / "),
        source: hit.importers.join(", "),
        evidence: "A",
      };
    }
  }
  if (component.channel === "pypi" && component.package) {
    const hit = inventory.python.find(
      (entry) => entry.package.toLowerCase() === component.package.toLowerCase(),
    );
    if (hit) {
      return {
        current: hit.versions.length ? hit.versions.join(" / ") : hit.specifier,
        source: hit.sources.join(", "),
        evidence: "A",
      };
    }
  }
  if (component.channel === "docker" && component.image) {
    const hit = inventory.containers.find((entry) => entry.image.startsWith(component.image));
    if (hit) return { current: hit.image.split(":")[1] ?? "latest", source: hit.sources.join(", "), evidence: "A" };
  }
  if (component.current) return { current: component.current, source: component.currentSource ?? "登记", evidence: "C" };
  return { current: "未引入", source: "—", evidence: "D" };
}

const USAGE_LABEL = {
  runtime: "运行时",
  dev: "开发/构建",
  ci: "CI/流水线",
  asset: "素材/资产",
  binary: "随包二进制",
  service: "独立服务",
  parked: "停车场（已选型未引入）",
  watch: "观察项",
};

function cell(value) {
  return String(value ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/\n+/g, " ")
    .trim() || "—";
}

function shortRepos(paths, limit = 3) {
  const list = [...new Set(paths)];
  if (list.length <= limit) return list.join("、");
  return `${list.slice(0, limit).join("、")} 等 ${list.length} 处`;
}

export function renderMarkdown({ root, repo, registry, inventory, state, planFile = PLAN_FILE }) {
  const scannedAt = state?.last_full_scan ? state.last_full_scan : "尚未扫描（运行 `pnpm oss:watch`）";
  const hasNodeStack = existsSync(join(root, "package.json"));
  const cmd = (task) =>
    hasNodeStack
      ? `pnpm ${task}`
      : { "oss:watch": "bash scripts/oss-watch.sh", "oss:plan": "bash scripts/oss-watch.sh --show" }[task];
  const cache = state?.registry_cache ?? {};
  const probes = probeVersions(root, registry.components);
  const lines = [];
  lines.push(`# WorkLoom 开源组件清单 · ${repo.name}`);
  lines.push("");
  lines.push("<!-- 自动生成，请勿手改：node scripts/oss-inventory.mjs --write -->");
  lines.push("");
  lines.push(`> 生成器：\`scripts/oss-inventory.mjs\`（离线事实）＋ \`scripts/oss-watch.sh\`（上游最新版本）`);
  lines.push(`> 仓库：${repo.slug ?? repo.name} ｜ 最近一次上游扫描：${scannedAt}`);
  lines.push(
    `> 统计：登记组件 ${registry.components.length} 个 ｜ npm 直接依赖 ${inventory.npm.packages.length} 个 ｜ Python 依赖 ${inventory.python.length} 个 ｜ 容器镜像 ${inventory.containers.length} 个`,
  );
  lines.push("");
  lines.push("## 0. 维护机制（四件事）");
  lines.push("");
  lines.push("| 时机 | 动作 | 命令 |");
  lines.push("|---|---|---|");
  lines.push(
    `| 依赖变更（改 package.json / lockfile / requirements） | CI 门禁：清单必须同步刷新，否则红灯 | \`${
      hasNodeStack ? "pnpm oss:check" : "node scripts/oss-inventory.mjs --check"
    }\` |`,
  );
  lines.push(`| 每周（CNB crontab + 基座审计任务） | 扫描上游最新版本，有更新则进更新计划并开 PR | \`${cmd("oss:watch")}\` |`);
  lines.push(`| 安全事件（CVE / 供应链投毒） | 不等周期，立即全量扫描 | \`${cmd("oss:watch")} --all\` |`);
  lines.push(`| 发布前 | 复核清单新鲜度与更新计划 | \`${cmd("oss:plan")}\` |`);
  lines.push("");
  lines.push("升级纪律：**扫描可以自动，升级永不自动**；升级必须逐项走 `docs/oss-update-plan.md` 的人工圈定 + 门禁 + 发布流程。");
  lines.push("");
  lines.push("## 1. 登记组件（治理清单 · 人工登记 + 自动探测当前版本 + 自动扫描上游最新版本）");
  lines.push("");
  lines.push("| # | 组件 | 开源地址 / 许可 | 当前使用版本 | 上游最新 | 状态 | 使用位置 | 注意事项 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  registry.components.forEach((component, index) => {
    const resolved = resolveCurrent(component, inventory, probes);
    const latest = component.latest ? `${component.latest}` : component.package && cache[component.package]?.latest ? cache[component.package].latest : "—";
    const outdated = isOutdated(resolved.current, latest);
    const latestCell = latest === "—" ? "—（未扫描）" : outdated ? `**${latest}** ⬆` : latest;
    const repoCell = component.repo ? `[${shortRepoLabel(component.repo)}](${component.repo})` : "—";
    const license = component.license ? ` · ${component.license}` : "";
    const scope = Array.isArray(component.scope) ? component.scope.join("、") : component.scope;
    lines.push(
      `| ${index + 1} | ${cell(component.name)} | ${cell(repoCell)}${license} | ${cell(resolved.current)} | ${cell(latestCell)} | ${cell(USAGE_LABEL[component.usage] ?? component.usage ?? "—")} | ${cell(scope)} | ${cell(component.notes)} |`,
    );
  });
  lines.push("");
  lines.push("## 2. 全量直接依赖（本仓事实，含上游最新）");
  lines.push("");
  lines.push(`### 2.1 npm 直接依赖（${inventory.npm.packages.length} 个，解析自 pnpm-lock.yaml）`);
  lines.push("");
  lines.push("| 包 | 当前版本 | 声明 | 类型 | 出现位置 | 上游最新 |");
  lines.push("|---|---|---|---|---|---|");
  for (const entry of inventory.npm.packages) {
    const latest = cache[entry.package]?.latest ?? "—";
    const outdated = isOutdated(highestVersion(entry.versions), latest);
    const latestCell = latest === "—" ? "—（未扫描）" : outdated ? `**${latest}** ⬆` : latest;
    const kinds = entry.kinds
      .map((kind) => (kind === "prod" ? "生产" : kind === "dev" ? "开发" : "可选"))
      .join("/");
    const versionCell = entry.resolution === "declared" ? `${entry.versions.join(" / ")}（声明）` : entry.versions.join(" / ");
    const label = entry.name === entry.package ? entry.name : `${entry.name} → npm:${entry.package}`;
    lines.push(
      `| \`${cell(label)}\` | ${cell(versionCell)} | ${cell(entry.specifiers.join(" / "))} | ${kinds} | ${cell(shortRepos(entry.importers))} | ${cell(latestCell)} |`,
    );
  }
  lines.push("");
  lines.push(`### 2.2 Python 依赖（${inventory.python.length} 个）`);
  lines.push("");
  if (inventory.python.length) {
    lines.push("| 包 | 当前版本 | 声明 | 出现位置 | 上游最新 |");
    lines.push("|---|---|---|---|---|");
    for (const entry of inventory.python) {
      const latest = cache[entry.package]?.latest ?? cache[entry.package.toLowerCase()]?.latest ?? "—";
      const pinned = entry.specifier.includes("==") || entry.specifier.includes("~=");
      const current = pinned && entry.versions.length ? entry.versions.join(" / ") : `${entry.specifier}（下限声明）`;
      const outdated = pinned && isOutdated(entry.versions[0], latest);
      const latestCell = latest === "—" ? "—（未扫描）" : outdated ? `**${latest}** ⬆` : latest;
      lines.push(`| \`${cell(entry.package)}\` | ${cell(current)} | ${cell(entry.specifier)} | ${cell(shortRepos(entry.sources))} | ${cell(latestCell)} |`);
    }
  } else {
    lines.push("（本仓无 Python 依赖）");
  }
  lines.push("");
  lines.push(`### 2.3 容器镜像（${inventory.containers.length} 个）`);
  lines.push("");
  if (inventory.containers.length) {
    lines.push("| 镜像 | 出现位置 |");
    lines.push("|---|---|");
    for (const entry of inventory.containers) {
      lines.push(`| \`${cell(entry.image)}\` | ${cell(shortRepos(entry.sources))} |`);
    }
  } else {
    lines.push("（本仓无容器镜像依赖）");
  }
  lines.push("");
  lines.push("### 2.4 工具链");
  lines.push("");
  lines.push("| 项 | 版本/要求 | 来源 |");
  lines.push("|---|---|---|");
  lines.push(`| Node.js | \`${cell(inventory.toolchain.node)}\` | package.json#engines |`);
  lines.push(`| pnpm | \`${cell(inventory.toolchain.packageManager)}\` | package.json#packageManager |`);
  if (inventory.toolchain.runtimeNpm) {
    lines.push(`| 桌面载荷 npm | \`${inventory.toolchain.runtimeNpm}\` | .workloom-runtime-deps/metadata.json |`);
  }
  if (inventory.toolchain.ciNodeImage) {
    lines.push(`| CI 构建镜像 | \`${inventory.toolchain.ciNodeImage}\` | .cnb.yml |`);
  }
  lines.push("");
  lines.push("## 3. 有可用更新");
  lines.push("");
  const outdatedComponents = registry.components.filter((component) => {
    const resolved = resolveCurrent(component, inventory, probes);
    return component.latest && isOutdated(resolved.current, component.latest);
  });
  const outdatedPackages = inventory.npm.packages.filter((entry) =>
    isOutdated(highestVersion(entry.versions), cache[entry.package]?.latest),
  );
  if (outdatedComponents.length || outdatedPackages.length) {
    lines.push(`登记组件滞后 ${outdatedComponents.length} 个，直接依赖滞后 ${outdatedPackages.length} 个 —— 逐项执行单见 \`${planFile}\`。`);
    if (outdatedComponents.length) {
      for (const component of outdatedComponents) {
        const resolved = resolveCurrent(component, inventory, probes);
        lines.push(`- \`${component.name}\` ${resolved.current} → **${component.latest}**（门禁 ${component.gate ?? "—"}）`);
      }
    }
  } else {
    lines.push("本周期无滞后项（或尚未扫描上游最新版本）。");
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function shortRepoLabel(url) {
  const match = String(url).match(/github\.com[/:]([^/]+\/[^/\s)]+)/);
  if (match) return `github.com/${match[1].replace(/\.git$/, "")}`;
  return String(url).replace(/^https?:\/\//, "").slice(0, 48);
}

export function repoIdentity(root) {
  const manifest = readJson(join(root, "package.json"));
  const product = readJson(join(root, "product.manifest.json"));
  return {
    name: product?.productId ?? manifest?.name ?? root.split(sep).pop(),
    slug: product?.repository ?? null,
  };
}

export function generateDocument(root) {
  const registry = loadRegistry(root);
  const state = loadState(root);
  const inventory = buildInventory(root);
  return {
    content: renderMarkdown({ root, repo: repoIdentity(root), registry, inventory, state }),
    registry,
    inventory,
    state,
  };
}

/* ============================ CLI ============================ */

function selfTest() {
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };
  expect(compareVersions("1.2.3", "1.2.4") === -1, "compareVersions 补丁升级");
  expect(compareVersions("v2.0.0", "1.9.9") === 1, "compareVersions 主版本");
  expect(compareVersions("1.0.0-rc.1", "1.0.0") === -1, "compareVersions 预发布");
  expect(compareVersions("1.0.0", "1.0.0") === 0, "compareVersions 相等");
  expect(compareVersions("选型在案", "1.0.0") === null, "compareVersions 非版本串");
  expect(normalizeVersion("^4.4.3") === "4.4.3", "normalizeVersion 去前缀");
  expect(isOutdated("8.2.2", "8.3.0") === true, "isOutdated 检出升级");
  expect(isOutdated("8.3.0", "8.2.2") === false, "isOutdated 不回退");
  expect(matchesWorkspacePattern("apps/*", "apps/web") && !matchesWorkspacePattern("apps/*", "apps/web/src"), "workspace glob");
  if (failures.length) {
    console.error(`✗ oss-inventory self-test 失败：\n - ${failures.join("\n - ")}`);
    process.exit(1);
  }
  console.log("✓ oss-inventory self-test 通过（版本比较 8 例 + glob 1 例）");
}

function main() {
  const args = process.argv.slice(2);
  const has = (flag) => args.includes(flag);
  const root = resolve(process.env.OSS_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), ".."));

  if (has("--self-test")) {
    selfTest();
    return;
  }
  if (has("--json")) {
    process.stdout.write(`${JSON.stringify(buildInventory(root), null, 2)}\n`);
    return;
  }
  const generated = generateDocument(root);
  const target = join(root, DOC_FILE);
  if (has("--check")) {
    const existing = readText(target, null);
    if (existing === null) {
      console.error(`✗ 缺少清单文档 ${DOC_FILE}：请运行 node scripts/oss-inventory.mjs --write`);
      process.exit(1);
    }
    if (existing !== generated.content) {
      console.error(
        `✗ 开源组件清单与仓库事实不一致（${DOC_FILE}）：\n  依赖/登记表已变化，请运行 pnpm oss:watch（或 node scripts/oss-inventory.mjs --write）后一并提交。`,
      );
      process.exit(1);
    }
    console.log("✓ 开源组件清单与仓库事实一致");
    return;
  }
  if (has("--write")) {
    writeFileSync(target, generated.content);
    console.log(`✓ 已生成 ${DOC_FILE}（登记组件 ${generated.registry.components.length}，npm 直接依赖 ${generated.inventory.npm.packages.length}）`);
    return;
  }
  process.stdout.write(generated.content);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
