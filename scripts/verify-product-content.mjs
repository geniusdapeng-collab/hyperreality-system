#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const bundlesRoot = path.join(root, "bundles");
const errors = [];
const envExample = path.join(root, ".env.example");
const envText = fs.existsSync(envExample) ? fs.readFileSync(envExample, "utf8") : "";
const activeSeedScripts = envText.match(/^DESKTOP_SEED_SCRIPT=(.+)$/m)?.[1] ?? "";

function collectStrings(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, result));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, result));
  return result;
}

for (const entry of fs.readdirSync(bundlesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const bundleDir = path.join(bundlesRoot, entry.name);
  const manifestPath = path.join(bundleDir, "bundle.json");
  if (!fs.existsSync(manifestPath)) continue;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const provided = collectStrings(manifest.workloom?.provides ?? {});
  for (const relativePath of provided) {
    const absolutePath = path.resolve(bundleDir, relativePath);
    if (!absolutePath.startsWith(`${bundleDir}${path.sep}`) || !fs.existsSync(absolutePath)) {
      errors.push(`${entry.name}: bundle.json 声明的资产不存在：${relativePath}`);
    }
  }

  if (entry.name === "ai-pm" && activeSeedScripts.includes("seed-aipm")) {
    const presets = manifest.workloom?.provides?.presets ?? [];
    const skills = manifest.workloom?.provides?.skills ?? [];
    if (presets.length !== 14) errors.push(`ai-pm: 数字员工应为 14，实际为 ${presets.length}`);
    if (skills.length !== 20) errors.push(`ai-pm: 技能应为 20，实际为 ${skills.length}`);
  }
}

if (fs.existsSync(envExample)) {
  const match = envText.match(/^DESKTOP_SEED_SCRIPT=(.+)$/m);
  for (const seed of (match?.[1] ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    if (!fs.existsSync(path.join(root, seed))) errors.push(`桌面种子脚本不存在：${seed}`);
  }
  const primarySeed = (match?.[1] ?? "").split(",")[0]?.trim();
  if (primarySeed && fs.existsSync(path.join(root, primarySeed))) {
    const seedSource = fs.readFileSync(path.join(root, primarySeed), "utf8");
    if (!seedSource.includes("bundle_id") || !seedSource.includes("is_example")) {
      errors.push(`桌面主种子必须同时写入 bundle_id 与 is_example：${primarySeed}`);
    }
  }
}

if (errors.length) {
  console.error(["产品内容完整性检查失败：", ...errors.map((error) => `- ${error}`)].join("\n"));
  process.exit(1);
}

console.log("产品内容完整性检查通过：Bundle 资产、数字员工、技能与桌面种子脚本一致。 ");
