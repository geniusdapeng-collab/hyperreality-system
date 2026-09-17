#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseBundleManifest } from "../packages/industry-contract/src/index.ts";
import { isStrictPathWithin } from "./path-containment.mjs";

const root = resolve(import.meta.dirname, "..");
let repositoryRoot = root;
try {
  repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
} catch {
  // 非 Git 制品继续以客户端基座目录为产品根；后续缺失清单会给出明确错误。
}
const write = process.argv.includes("--write");
const product = JSON.parse(readFileSync(join(repositoryRoot, "product.manifest.json"), "utf8")) as {
  defaultBundle: string;
  clients: { cMobile: { enabled: boolean; entry: string } };
};

function readUiVersion(): string {
  const consumerStatePath = join(root, ".workloom-ui.json");
  if (existsSync(consumerStatePath)) {
    const state = JSON.parse(readFileSync(consumerStatePath, "utf8")) as {
      schemaVersion?: unknown;
      package?: unknown;
      version?: unknown;
    };
    if (
      state.schemaVersion !== "workloom.ui-consumer-state/v1"
      || state.package !== "@workloom/ui"
      || typeof state.version !== "string"
      || !/^\d+\.\d+\.\d+$/.test(state.version)
    ) {
      throw new Error("共享 UI 消费状态无效，无法生成可追溯的客户端投影");
    }
    return state.version;
  }

  const sourcePackagePath = join(root, "packages/ui/package.json");
  if (!existsSync(sourcePackagePath)) {
    throw new Error("缺少 .workloom-ui.json；行业仓必须先完成稳定 UI 制品安装与验真");
  }
  const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, "utf8")) as { version?: unknown };
  if (typeof sourcePackage.version !== "string" || !/^\d+\.\d+\.\d+$/.test(sourcePackage.version)) {
    throw new Error("基座 packages/ui 版本无效");
  }
  return sourcePackage.version;
}

async function loadThemeValidator(): Promise<(theme: { primary: string; secondary: string }) => string[]> {
  const clientPackagePath = join(root, product.clients.cMobile.entry, "package.json");
  if (!existsSync(clientPackagePath)) {
    throw new Error(`C端客户端入口不存在：${product.clients.cMobile.entry}`);
  }
  const installedPackageRoot = join(root, product.clients.cMobile.entry, "node_modules/@workloom/ui");
  const installedManifestPath = join(installedPackageRoot, "package.json");
  const entryPath = join(installedPackageRoot, "dist/index.js");
  if (!existsSync(installedManifestPath) || !existsSync(entryPath)) {
    throw new Error("C端客户端尚未安装经锁定的 @workloom/ui，拒绝生成投影");
  }
  const installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (installedManifest.name !== "@workloom/ui" || installedManifest.version !== uiVersion) {
    throw new Error(`C端客户端 @workloom/ui 与受控版本 ${uiVersion} 不一致`);
  }
  const uiModule = await import(pathToFileURL(entryPath).href) as {
    validateLightBrandTheme?: (theme: { primary: string; secondary: string }) => string[];
  };
  if (typeof uiModule.validateLightBrandTheme !== "function") {
    throw new Error("当前 @workloom/ui 未导出品牌色可访问性校验器");
  }
  return uiModule.validateLightBrandTheme;
}

const uiVersion = readUiVersion();
const validateLightBrandTheme = await loadThemeValidator();
const bundleDir = join(root, "bundles", product.defaultBundle);
const manifest = parseBundleManifest(JSON.parse(readFileSync(join(bundleDir, "bundle.json"), "utf8")));

if (!product.clients.cMobile.enabled) {
  console.log("ℹ️ 产品清单已关闭 C端，不生成服务前台投影");
  process.exit(0);
}
if (!manifest.workloom.ui.serviceFront.enabled) {
  throw new Error(`默认行业包 ${product.defaultBundle} 未启用 C端服务前台，产品清单不能把 C端标为启用`);
}
const candidates = manifest.workloom.provides.serviceFront.filter((item) => item.endsWith("client.json"));
if (candidates.length !== 1) throw new Error(`默认行业包必须且只能声明一个 service-front/client.json，实际 ${candidates.length} 个`);
const sourcePath = resolve(bundleDir, candidates[0]!);
if (
  !existsSync(sourcePath)
  || !isStrictPathWithin(realpathSync(bundleDir), realpathSync(sourcePath))
) throw new Error("C端投影源不存在或越出行业包目录");
const source = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
const theme = source.theme as { primary?: unknown; secondary?: unknown } | undefined;
if (!theme || typeof theme.primary !== "string" || typeof theme.secondary !== "string") {
  throw new Error("C端投影必须声明品牌主色与辅助色");
}
const contrastIssues = validateLightBrandTheme({ primary: theme.primary, secondary: theme.secondary });
if (contrastIssues.length > 0) {
  throw new Error(`C端品牌色未通过可访问性校验：${contrastIssues.join("；")}`);
}
const profile = source.profile as { identityBinding?: unknown; membership?: unknown; orders?: unknown } | undefined;
if (!profile || [profile.identityBinding, profile.membership, profile.orders].some((value) => typeof value !== "boolean")) {
  throw new Error("C端投影必须显式声明账号页身份、权益和订单能力，基座不提供行业默认值");
}
const front = manifest.workloom.ui.serviceFront;
if (profile.identityBinding !== (front.identityPolicy !== "disabled")) {
  throw new Error(`C端身份入口与 Bundle identityPolicy=${front.identityPolicy} 不一致`);
}
if ((profile.membership || profile.orders) && !front.adapterId) {
  throw new Error("C端启用权益或订单时，Bundle 必须声明已验证业务适配器");
}
const projection = {
  ...source,
  projection: {
    bundleId: manifest.workloom.industry,
    bundleVersion: manifest.version,
    contractVersion: manifest.workloom.compatibility.contract,
    uiVersion,
    manifestDigest: manifest.integrity?.digest ?? "草稿未封装",
  },
};
const output = `${JSON.stringify(projection, null, 2)}\n`;
// 行业内容只能写入 client-foundation 明确放行的扩展目录；根配置是受管加载壳，
// 由基座稳定标签统一升级，任何行业包都不得覆盖它。
const target = join(root, product.clients.cMobile.entry, "public/industry/service-front.config.json");

if (write) {
  mkdirSync(join(root, product.clients.cMobile.entry, "public/industry"), { recursive: true });
  writeFileSync(target, output);
  console.log(`✅ 已由 ${product.defaultBundle} 行业包生成 C端投影：${target}`);
} else {
  const actual = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (actual !== output) {
    console.error("❌ C端投影与默认行业包不一致；请运行 pnpm projections:generate 后评审差异");
    process.exit(1);
  }
  console.log(`✅ C端投影与 ${product.defaultBundle}@${manifest.version} 清单一致`);
}
