#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const bundlesRoot = path.join(root, "bundles");
const errors = [];
const envExample = path.join(root, ".env.example");
const envText = fs.existsSync(envExample) ? fs.readFileSync(envExample, "utf8") : "";
const activeSeedScripts = envText.match(/^DESKTOP_SEED_SCRIPT=(.+)$/m)?.[1] ?? "";

function requireSource(relativePath, checks) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    errors.push(`基座文件不存在：${relativePath}`);
    return;
  }
  const source = fs.readFileSync(absolutePath, "utf8");
  for (const { includes, excludes, message } of checks) {
    if (includes && !source.includes(includes)) errors.push(`${relativePath}: ${message}`);
    if (excludes && source.includes(excludes)) errors.push(`${relativePath}: ${message}`);
  }
}

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

// 跨行业统一的语音/人物/命名交付契约。把截图中出现过的回归模式固化成发布门禁，
// 避免某个行业仓同步基座时又带回长文案、随机换声或“人名+岗位”叠层。
requireSource("apps/web/src/components/welcomeScripts.ts", [
  { includes: "董事长您好，我是织伴，您的 AI 小秘书", message: "欢迎开场必须使用精简版文案" },
  { excludes: "接下来给我一分钟", message: "欢迎开场不得恢复一分钟长介绍" },
]);
requireSource("apps/web/src/voice/VoiceEngine.ts", [
  { includes: "voiceCache", message: "同一角色必须锁定 voice" },
  { includes: "AudioEngine.setSpeechActive(true)", message: "TTS 开始时必须 duck 环境声" },
  { includes: "preferredNames", message: "角色音色必须支持确定性首选列表" },
]);
for (const scene of ["apps/web/src/components/Floor3D.tsx", "apps/web/src/components/Stage3D.tsx"]) {
  requireSource(scene, [
    { includes: "BusinessAvatar3D", message: "正式 3D 职场必须使用现代商务人物" },
    { includes: "displayNameOf", message: "3D 名牌必须遵循岗位名/用户别名规则" },
    { excludes: "personaOf(", message: "3D 名牌不得显示系统生成的人名" },
  ]);
}
requireSource("apps/web/src/components/Floor3D.tsx", [
  { includes: "!dimmed && hovered", message: "职场空闲态只能悬停显示名牌，避免 3D 人群标签重叠" },
]);
requireSource("apps/web/src/components/Stage3D.tsx", [
  { includes: "hovered || spotlight", message: "舞台只应在悬停或点名时显示成员名牌" },
]);
requireSource("apps/web/src/components/CeremonyStage.tsx", [
  { includes: "data-ceremony-ready={ready ? \"true\" : \"false\"}", message: "团队舞台必须等全员首帧后才报告 ready" },
]);

if (errors.length) {
  console.error(["产品内容完整性检查失败：", ...errors.map((error) => `- ${error}`)].join("\n"));
  process.exit(1);
}

console.log("产品内容完整性检查通过：Bundle 资产、数字员工、技能、桌面种子、语音与场景命名契约一致。 ");
