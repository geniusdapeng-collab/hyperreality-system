// pack-nm-merge.mjs —— 从 pnpm 锁文件合并 monorepo 运行期直接依赖
// 用途：桌面装配器在其输出目录执行受控 npm ci，得到扁平无链接的 node_modules
//      （pnpm 的 symlink 布局无法经受 Windows zip 打包-解压往返，见 v2.0.8 冒烟实证）
// 规则：
//   收集 root.dependencies + apps/server.dependencies + packages/{shared,db,base,runtime}.dependencies
//   + 运行期工具：tsx（启动器执行 .ts）、vite（preview 静态服务）
//   过滤：workspace:* 协议（内部包，源码随包）/ electron* / playwright*（运行期不需要）
//   版本：只采用 pnpm-lock.yaml importer 已解析的精确版本，不把 ^/~ 范围带入发行包
//   冲突：同名依赖若锁到不同版本立即失败，禁止按目录枚举顺序静默覆盖
// 用法：node scripts/pack-nm-merge.mjs <输出 package.json 路径>
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPayloadPolicy } from "./payload-policy.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_VALUE = (v) => typeof v === "string" && v.startsWith("workspace:");
const SKIP_NAME = (n) => /^(electron|electron-builder|@electron|playwright|@playwright)/.test(n);

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
  return { key: decodeScalar(text.slice(0, separator), "YAML key"), value: text.slice(separator + 1).trim() };
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
    if (mappingEntry(lines[index], indent)) { end = index; break; }
  }
  return { start: entry.index + 1, end };
}

export function parsePnpmRuntimeLock(source) {
  if (typeof source !== "string" || source.includes("\t")) {
    throw new Error("pnpm-lock.yaml 必须使用空格缩进");
  }
  // Git for Windows 在 runner 上可能按 core.autocrlf 把受审锁文件检出为 CRLF。
  // 只规范化完整 CRLF；孤立 CR 仍视为损坏，避免静默接受含混行边界。
  const withoutCrLf = source.replaceAll("\r\n", "");
  if (withoutCrLf.includes("\r")) {
    throw new Error("pnpm-lock.yaml 含孤立 CR 换行符");
  }
  source = source.replaceAll("\r\n", "\n");
  if (!source.endsWith("\n")) {
    throw new Error("pnpm-lock.yaml 必须以换行结尾");
  }
  if (source.trimStart().startsWith("{")) {
    let parsed;
    try { parsed = JSON.parse(source); }
    catch { throw new Error("pnpm-lock.yaml JSON 形态无法解析"); }
    if (!parsed?.importers || typeof parsed.importers !== "object") throw new Error("pnpm-lock.yaml JSON 形态缺少 importers");
    return parsed;
  }
  const lines = source.slice(0, -1).split("\n");
  const top = entriesAt(lines, 0, lines.length, 0);
  const lockfileVersion = decodeScalar(uniqueEntry(top, "lockfileVersion", "lockfileVersion").value, "lockfileVersion");
  const importersEntry = uniqueEntry(top, "importers", "顶层 importers");
  if (importersEntry.value) throw new Error("顶层 importers 必须是映射");
  const importersRange = nestedRange(lines, importersEntry, lines.length, 0);
  const importers = {};
  for (const importer of entriesAt(lines, importersRange.start, importersRange.end, 2)) {
    if (importer.value || Object.hasOwn(importers, importer.key)) throw new Error(`importer ${importer.key} 必须是唯一映射`);
    const importerRange = nestedRange(lines, importer, importersRange.end, 2);
    const parsedImporter = {};
    for (const field of entriesAt(lines, importerRange.start, importerRange.end, 4)) {
      if (!["dependencies", "devDependencies", "optionalDependencies"].includes(field.key)) continue;
      if (field.value) throw new Error(`importer ${importer.key}.${field.key} 必须是映射`);
      const fieldRange = nestedRange(lines, field, importerRange.end, 4);
      const parsedField = {};
      for (const dependency of entriesAt(lines, fieldRange.start, fieldRange.end, 6)) {
        if (dependency.value || Object.hasOwn(parsedField, dependency.key)) throw new Error(`依赖 ${importer.key}.${field.key}.${dependency.key} 必须是唯一映射`);
        const dependencyRange = nestedRange(lines, dependency, fieldRange.end, 6);
        const values = entriesAt(lines, dependencyRange.start, dependencyRange.end, 8);
        parsedField[dependency.key] = {
          specifier: decodeScalar(uniqueEntry(values, "specifier", `${importer.key}.${field.key}.${dependency.key}.specifier`).value, "specifier"),
          version: decodeScalar(uniqueEntry(values, "version", `${importer.key}.${field.key}.${dependency.key}.version`).value, "version"),
        };
      }
      parsedImporter[field.key] = parsedField;
    }
    importers[importer.key] = parsedImporter;
  }
  return { lockfileVersion, importers };
}

export function runtimeDependencySources(root, policy) {
  // packages/*/package.json 动态收集（行业仓有自定义包，如 @hyperreality/video-studio——
  // v1.0.0 硬编码四包漏收集其运行依赖实证）
  const pkgSources = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => [`packages/${name}/package.json`, ["dependencies"], null, `packages/${name}`]);

  // platform-ops 的物理存在不是授权。只有仙女座精确产品身份允许收集；
  // 身份允许却缺包时也必须失败，避免发布一个名义上是运营中枢、实际残缺的载荷。
  if (policy.includePlatformOps) {
    if (!existsSync(join(root, "platform-ops/package.json"))) {
      throw new Error("仙女座正式载荷缺少 platform-ops/package.json");
    }
    pkgSources.push(["platform-ops/package.json", ["dependencies"], null, "platform-ops"]);
  }

  return [
    ["package.json", ["dependencies"], null, "."],
    ["apps/server/package.json", ["dependencies"], null, "apps/server"],
    ...pkgSources,
    // 运行期工具（来自 devDependencies，仅取这两个）
    ["package.json", ["devDependencies"], ["tsx"], "."],
    ["apps/web/package.json", ["devDependencies"], ["vite", "@tailwindcss/vite", "@vitejs/plugin-react"], "apps/web"],
  ];
}

function exactLockedVersion(lock, importer, field, name, specifier) {
  const locked = lock?.importers?.[importer]?.[field]?.[name];
  if (!locked || typeof locked !== "object") {
    throw new Error(`pnpm-lock.yaml 缺少 ${importer}.${field}.${name}`);
  }
  if (locked.specifier !== specifier) {
    throw new Error(`pnpm-lock.yaml specifier 漂移 ${importer}.${field}.${name}: ${String(locked.specifier)} != ${specifier}`);
  }
  const raw = locked.version;
  if (typeof raw !== "string" || !raw) {
    throw new Error(`pnpm-lock.yaml 缺少 ${importer}.${field}.${name} 的精确解析版本`);
  }
  if (raw.startsWith("link:") || raw.startsWith("workspace:")) {
    throw new Error(`外部运行依赖 ${name} 不得解析为工作区链接：${raw}`);
  }
  // pnpm 会把 peer 上下文写成 1.2.3(peer@4.5.6)；npm 顶层 manifest 只需要
  // 精确包版本，完整 peer/传递闭包由受控 package-lock.json 固定。
  const semver = raw.match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\(.+\))?$/u);
  if (semver) return semver[1];
  const alias = raw.match(/^(npm:[^@]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\(.+\))?$/u);
  if (alias) return alias[1];
  if (/^https:\/\//u.test(raw)) return raw;
  throw new Error(`不支持的运行依赖锁定格式 ${importer}.${field}.${name}: ${raw}`);
}

export function loadPnpmRuntimeLock(root) {
  const path = join(root, "pnpm-lock.yaml");
  let parsed;
  try {
    parsed = parsePnpmRuntimeLock(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`pnpm-lock.yaml 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  if (String(parsed?.lockfileVersion) !== "9.0" || !parsed?.importers) {
    throw new Error("pnpm-lock.yaml 必须是含 importers 的 pnpm 10 lockfileVersion 9.0");
  }
  return parsed;
}

export function buildMergedRuntimeManifest(root, policy, pnpmLock = loadPnpmRuntimeLock(root)) {
  const deps = {};
  const owners = {};
  for (const [file, fields, only, importer] of runtimeDependencySources(root, policy)) {
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(root, file), "utf8")); }
    catch (error) { throw new Error(`运行依赖来源 ${file} 无法读取：${error instanceof Error ? error.message : String(error)}`); }
    for (const field of fields) {
      for (const [name, ver] of Object.entries(pkg[field] ?? {})) {
        if (SKIP_NAME(name) || SKIP_VALUE(ver)) continue;
        if (only && !only.includes(name)) continue;
        if (typeof ver !== "string") throw new Error(`${file} 的 ${field}.${name} 版本必须是字符串`);
        const exact = exactLockedVersion(pnpmLock, importer, field, name, ver);
        if (deps[name] && deps[name] !== exact) {
          throw new Error(`运行依赖版本冲突 ${name}: ${deps[name]}（${owners[name]}） != ${exact}（${file}）`);
        }
        deps[name] = exact;
        owners[name] ??= file;
      }
    }
  }
  return {
    name: "workloom-runtime-payload",
    private: true,
    version: "0.0.0",
    description: "正式桌面运行期精确依赖合成（受控 npm ci 使用，自动生成勿手改）",
    dependencies: Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function main() {
  const out = process.argv[2];
  if (!out) throw new Error("用法：node scripts/pack-nm-merge.mjs <输出路径>");
  const policy = loadPayloadPolicy(ROOT);
  const merged = buildMergedRuntimeManifest(ROOT, policy);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(merged, null, 2) + "\n");
  console.log(`✅ 合成 ${out}：${Object.keys(merged.dependencies).length} 个直接依赖（platform-ops: ${policy.includePlatformOps ? "include" : "exclude"}）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
