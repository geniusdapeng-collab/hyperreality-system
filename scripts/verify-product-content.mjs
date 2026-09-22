#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveDesktopWorkflowPath } from "./desktop-workflow-path.mjs";

const root = process.cwd();
let repositoryRoot = root;
try {
  repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  // 非 Git 制品校验继续以当前目录为根；缺失清单会给出明确错误。
}
const bundlesRoot = path.join(root, "bundles");
const errors = [];
const envExample = path.join(root, ".env.example");
const envText = fs.existsSync(envExample) ? fs.readFileSync(envExample, "utf8") : "";
const activeSeedScripts = envText.match(/^DESKTOP_SEED_SCRIPT=(.+)$/m)?.[1] ?? "";
const productManifestPath = path.join(repositoryRoot, "product.manifest.json");

function requiredJson(file, label) {
  if (!fs.existsSync(file)) {
    errors.push(`缺少${label}：${path.relative(root, file)}`);
    return null;
  }
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { errors.push(`${label}不是合法 JSON：${path.relative(root, file)}`); return null; }
}

const product = requiredJson(productManifestPath, "产品清单");
if (product) {
  if (product.schemaVersion !== "workloom.product/v1") errors.push("产品清单 schemaVersion 必须为 workloom.product/v1");
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(product.productId ?? "")) errors.push("产品标识格式不正确");
  if (!/^[\w.-]+\/[\w.-]+$/.test(product.repository ?? "")) errors.push("产品清单 repository 格式不正确");
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(product.demoWorkspaceSlug ?? "")) errors.push("演示工作区标识格式不正确");
  if (!/^[A-Z][A-Z0-9-]{1,31}$/.test(product.demoMemberNo ?? "")) errors.push("演示成员编号格式不正确");
  if (!Number.isInteger(product.desktop?.portOffset) || product.desktop.portOffset < 0 || product.desktop.portOffset > 900) {
    errors.push("桌面端口偏移必须为 0 到 900 的整数");
  }
  for (const [client, spec] of Object.entries(product.clients ?? {})) {
    if (spec?.enabled !== true) errors.push(`${client} 未启用；正式产品必须明确提供三端`);
    const clientDir = path.resolve(root, spec?.entry ?? "");
    if (!spec?.entry || !clientDir.startsWith(`${root}${path.sep}`) || !fs.existsSync(path.join(clientDir, "package.json"))) {
      errors.push(`${client} 入口不存在或越出仓库：${spec?.entry ?? "未配置"}`);
    }
  }
  for (const requiredClient of ["bPc", "bMobile", "cMobile"]) {
    if (!product.clients?.[requiredClient]) errors.push(`产品清单缺少三端入口：${requiredClient}`);
  }
  const packageJson = requiredJson(path.join(root, "package.json"), "根 package.json");
  if (packageJson && packageJson.name !== product.packageName) errors.push("产品清单 packageName 与根 package.json 不一致");
  const defaultBundle = path.join(bundlesRoot, product.defaultBundle ?? "", "bundle.json");
  if (!fs.existsSync(defaultBundle)) errors.push(`默认行业包不存在：${product.defaultBundle ?? "未配置"}`);

  const builderPath = path.join(root, "electron-builder.yml");
  const builder = fs.existsSync(builderPath) ? fs.readFileSync(builderPath, "utf8") : "";
  if (!builder.includes(`appId: ${product.release?.appId}`)) errors.push("electron-builder appId 与产品清单不一致");
  if (!builder.includes(`productName: ${product.displayName}`)) errors.push("electron-builder productName 与产品清单不一致");
  if (!builder.includes(`workloomPortOffset: ${product.desktop?.portOffset}`)) errors.push("electron-builder 端口偏移与产品清单不一致");
  for (const marker of [
    "notarize: true",
    "hardenedRuntime: true",
    "entitlements: build/entitlements.mac.plist",
    "from: build/bundle-trust.json",
  ]) {
    if (!builder.includes(marker)) errors.push(`桌面生产构建缺少安全配置：${marker}`);
  }

  let desktopWorkflowPath;
  try {
    desktopWorkflowPath = resolveDesktopWorkflowPath(repositoryRoot, product).absolute;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    desktopWorkflowPath = path.join(repositoryRoot, ".github/workflows/desktop-production-release.yml");
  }
  const desktopWorkflow = fs.existsSync(desktopWorkflowPath) ? fs.readFileSync(desktopWorkflowPath, "utf8") : "";
  for (const marker of [
    "MAC_CSC_LINK",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "codesign --verify --deep --strict",
    "xcrun stapler validate",
    "WIN_CSC_LINK",
    "Get-AuthenticodeSignature",
    "pnpm bundle:release",
  ]) {
    if (!desktopWorkflow.includes(marker)) errors.push(`桌面发布工作流缺少安全门禁：${marker}`);
  }

  const releaseScript = path.join(root, "scripts/release.sh");
  if (fs.existsSync(releaseScript)) {
    const releaseSource = fs.readFileSync(releaseScript, "utf8");
    if (!releaseSource.includes("本地/长期令牌 Release 通道已封禁") || !/^exit 1$/mu.test(releaseSource)) {
      errors.push("release.sh 必须保持 fail-closed，正式发行只允许受保护 workflow 单一发布者");
    }
    if (/GH_TOKEN|api\.github\.com|uploads\.github\.com|\bcurl\b|\bgh\s+release\b/u.test(releaseSource)) {
      errors.push("release.sh 不得保留任何令牌或 GitHub Release 网络写入通道");
    }
  }
  const siteRoot = path.resolve(root, product.release?.website ?? "");
  for (const file of ["index.html", "en.html"]) {
    const siteFile = path.join(siteRoot, file);
    if (fs.existsSync(siteFile) && !fs.readFileSync(siteFile, "utf8").includes(`github.com/${product.repository}`)) {
      errors.push(`${path.relative(root, siteFile)} 下载/仓库地址与产品清单不一致`);
    }
  }
}

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
  { includes: "老板您好，我是织伴，您的 AI 小秘书", message: "欢迎开场必须使用精简版文案" },
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

console.log("产品内容完整性检查通过：产品身份、三端入口、发布目标、Bundle 资产、数字员工、技能、桌面种子、语音与场景命名契约一致。");
