#!/usr/bin/env node
/**
 * 桌面候选制品封存（MC-202）：把 electron-builder 产物改名为对外恒定名，并写出平台清单。
 *
 * 与 .github/workflows/desktop-production-release.yml 的封存口径逐字段一致
 * （schemaVersion/tag/platformSigning/assets + sha512），保证 CNB 与遗留发布通道产出同一批名字：
 *   mac：release/WorkLoom 织元-mac-arm64.dmg → <out>/WorkLoom-mac-arm64.dmg（x64 同理）
 *   win：release/WorkLoom 织元-win-x64.exe  → <out>/WorkLoom-win-x64.exe
 *
 * 纪律：产物数量必须精确匹配（多一个少一个即失败——防止把未验签/旧版本文件混进候选），
 * 清单摘要来自**实际字节**，且后续 finalize 会回读远端字节复核，任一处不符即拒绝发布。
 *
 * 用法：
 *   node scripts/desktop-candidate-stage.mjs --platform mac --out <dir> --version vX.Y.Z [--signing signed|unsigned]
 *   node scripts/desktop-candidate-stage.mjs --platform win --out <dir> --version vX.Y.Z [--signing signed|unsigned]
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const platform = option("--platform");
const version = option("--version");
const signing = option("--signing") ?? "signed";
const out = resolve(option("--out") ?? join(REPO_ROOT, "dist-desktop"));

if (!["mac", "win"].includes(platform ?? "") || !/^v\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("用法：node scripts/desktop-candidate-stage.mjs --platform mac|win --out <dir> --version vX.Y.Z [--signing signed|unsigned]");
  process.exit(2);
}
if (!["signed", "unsigned"].includes(signing)) {
  console.error(`--signing 只能是 signed|unsigned（当前：${signing}）`);
  process.exit(2);
}

/** 平台 → [源文件名, 对外文件名] 清单（与发布策略事实源同名） */
const SPECS = {
  mac: [
    ["WorkLoom 织元-mac-arm64.dmg", "WorkLoom-mac-arm64.dmg"],
    ["WorkLoom 织元-mac-x64.dmg", "WorkLoom-mac-x64.dmg"],
  ],
  win: [
    ["WorkLoom 织元-win-x64.exe", "WorkLoom-win-x64.exe"],
  ],
};

const releaseDir = join(REPO_ROOT, "release");
const expectedExtension = platform === "mac" ? ".dmg" : ".exe";
const built = readdirSync(releaseDir).filter((name) => name.endsWith(expectedExtension));
const expectedSources = SPECS[platform].map(([source]) => source);
if (built.length !== expectedSources.length || expectedSources.some((name) => !built.includes(name))) {
  console.error(`release/ 下的 ${expectedExtension} 产物与期望不符：实得 [${built.sort().join("、")}]，期望 [${expectedSources.join("、")}]`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const assets = [];
for (const [source, name] of SPECS[platform]) {
  const sourcePath = join(releaseDir, source);
  if (!statSync(sourcePath).isFile() || statSync(sourcePath).size === 0) {
    console.error(`源产物不可用（不存在或为空）：${source}`);
    process.exit(1);
  }
  copyFileSync(sourcePath, join(out, name));
  const bytes = readFileSync(join(out, name));
  assets.push({ name, size: bytes.length, sha512: createHash("sha512").update(bytes).digest("hex") });
}

const manifestName = platform === "mac" ? "desktop-macos-manifest.json" : "desktop-windows-manifest.json";
writeFileSync(`${join(out, manifestName)}`, `${JSON.stringify({ schemaVersion: 1, tag: version, platformSigning: signing, assets }, null, 2)}\n`);
console.log(`已封存 ${platform} 候选：${assets.map((asset) => `${asset.name}(${asset.size}B)`).join("、")} → ${out}`);
