#!/usr/bin/env node
/**
 * 桌面安装包命名一致性门禁（MC-201 / MC-202）
 *
 * 根因回放：README 与两份客户文档承诺 `WorkLoom-macOS.zip` + sha256 校验，而发布产线实际产出
 * `WorkLoom-mac-arm64.dmg` / `WorkLoom-mac-x64.dmg` / `WorkLoom-win-x64.exe` + `WorkLoom-SHA512SUMS.txt`
 * ——客户按文档找不到文件、也拿不到承诺的校验值。
 *
 * 本门禁要求三处口径一致，任一处漂移即失败：
 *   ① 发布策略事实源 `.github/workflows/desktop-production-release.yml` 的 INSTALLERS 清单（唯一名单）；
 *   ② CNB 发布流水线 `.cnb.yml#desktop-release`（事实源侧必须声明同一批产物）；
 *   ③ 对外文档（README.md / README_EN.md / docs/**.md）中出现的安装包名全部落在 ① 内。
 *
 * 用法：node scripts/desktop-artifact-naming.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW = ".github/workflows/desktop-production-release.yml";
const CNB = ".cnb.yml";
const ARTIFACT_PATTERN = /WorkLoom-[A-Za-z0-9._-]+\.(?:dmg|exe|zip)/g;

function read(path) {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** ① 产线唯一名单：INSTALLERS=(...) 数组内的产物名 */
function canonicalInstallers() {
  const source = read(WORKFLOW);
  const array = /INSTALLERS=\(([^)]*)\)/.exec(source);
  if (!array) throw new Error(`${WORKFLOW} 未声明 INSTALLERS 清单（命名门禁失去唯一事实源）`);
  const names = [...array[1].matchAll(ARTIFACT_PATTERN)].map((match) => match[0]);
  if (!names.length) throw new Error(`${WORKFLOW} 的 INSTALLERS 清单为空`);
  return [...new Set(names)].sort();
}

/** ② CNB 流水线声明：desktop-release 段落内出现的产物名 */
function cnbDeclaredInstallers() {
  const source = read(CNB);
  const start = source.indexOf(".desktop-release-preflight:");
  if (start < 0) throw new Error(`${CNB} 缺少 desktop-release 流水线（MC-202：CNB 无桌面发布通道）`);
  const end = source.indexOf("\nmain:", start);
  const section = source.slice(start, end > start ? end : undefined);
  return [...new Set([...section.matchAll(ARTIFACT_PATTERN)].map((match) => match[0]))].sort();
}

/** ③ 对外文档承诺：README 与 docs 下的安装包名 */
function walkDocs(dir, out = []) {
  for (const entry of readdirSync(join(REPO_ROOT, dir))) {
    const rel = join(dir, entry);
    const st = statSync(join(REPO_ROOT, rel));
    if (st.isDirectory()) walkDocs(rel, out);
    else if (entry.endsWith(".md")) out.push(rel);
  }
  return out;
}

function documentedArtifacts() {
  const files = ["README.md", "README_EN.md", ...walkDocs("docs")];
  const found = new Map();
  for (const file of files) {
    const names = [...read(file).matchAll(ARTIFACT_PATTERN)].map((match) => match[0]);
    for (const name of names) {
      if (!found.has(name)) found.set(name, []);
      found.get(name).push(relative(REPO_ROOT, join(REPO_ROOT, file)));
    }
  }
  return found;
}

const canonical = canonicalInstallers();
const cnb = cnbDeclaredInstallers();
const docs = documentedArtifacts();
const violations = [];

for (const name of canonical) {
  if (!cnb.includes(name)) violations.push(`CNB 流水线未声明产线产物 ${name}`);
}
for (const [name, places] of docs) {
  if (!canonical.includes(name)) violations.push(`文档承诺的安装包不在产线：${name}（${[...new Set(places)].join("、")}）`);
}

console.log(`产线产物（${WORKFLOW} INSTALLERS）：${canonical.join("、")}`);
console.log(`CNB 流水线声明：${cnb.join("、") || "（无）"}`);
console.log(`对外文档承诺：${[...docs.keys()].sort().join("、") || "（无）"}`);
if (violations.length) {
  for (const violation of violations) console.error(`✗ ${violation}`);
  process.exit(1);
}
console.log("✓ 桌面安装包命名一致（文档 / CNB 流水线 / 发布策略事实源）");
