#!/usr/bin/env node
import {
  createHash, createPrivateKey, createPublicKey, sign as signValue,
  timingSafeEqual, verify as verifyValue,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import {
  assertBundleCompatibility,
  canonicalBundleArtifactPayload,
  formatContractError,
  parseBundleManifest,
  WORKLOOM_BUNDLE_HOME_COMPONENTS,
  WORKLOOM_BUNDLE_NAVIGATION_ICONS,
  WORKLOOM_NAVIGATION_GROUPS,
  WorkforcePresetCollectionSchema,
  type BundleManifest,
} from "../packages/industry-contract/src/index.ts";

const root = resolve(import.meta.dirname, "..");
const bundlesRoot = resolve(process.env.BUNDLES_ROOT ?? join(root, "bundles"));
const args = new Set(process.argv.slice(2));
const refreshDigests = args.has("--refresh-digests");
const releaseMode = args.has("--release");
const readVersion = (path: string): string | null => {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof value.version === "string" ? value.version : null;
  } catch { return null; }
};
const baseVersion = process.env.WORKLOOM_BASE_VERSION
  ?? readVersion(join(root, "packages/base/package.json"))
  ?? (() => { throw new Error("无法确定基座版本"); })();
const uiVersion = process.env.WORKLOOM_UI_VERSION
  ?? readVersion(join(root, "packages/ui/package.json"))
  ?? readVersion(join(root, ".workloom-ui.json"))
  ?? (() => { throw new Error("无法确定共享 UI 版本；行业仓必须先完成稳定基座接入"); })();
const iconNames = new Set<string>(WORKLOOM_BUNDLE_NAVIGATION_ICONS);
const navigationGroups = new Set<string>(WORKLOOM_NAVIGATION_GROUPS);
const baseWidgetComponents = new Set<string>(WORKLOOM_BUNDLE_HOME_COMPONENTS);
const errors: string[] = [];
const manifestsByBundleId = new Map<string, { directoryName: string; manifest: BundleManifest; actorTerminology: Record<string, string> }>();
// 公钥环是独立信任根，严禁与可替换的 bundles/ 制品同目录。
// 桌面构建把此文件作为独立、受应用签名保护的 extraResource 分发；托管部署也可直接注入公钥环。
const trustFile = resolve(process.env.BUNDLE_TRUST_OUTPUT ?? join(root, "build", "bundle-trust.json"));
const trustRelativeToBundles = relative(bundlesRoot, trustFile);
if (!trustRelativeToBundles || (!trustRelativeToBundles.startsWith("..") && !trustRelativeToBundles.startsWith(sep))) {
  throw new Error("BUNDLE_TRUST_OUTPUT 必须位于 bundles/ 目录之外");
}

function digestFor(
  manifest: BundleManifest | Record<string, unknown>,
  assets?: Record<string, string>,
): string {
  return createHash("sha256").update(canonicalBundleArtifactPayload(manifest, assets)).digest("hex");
}

function normalizedPem(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

function privateKeyFromEnvironment() {
  const value = process.env.BUNDLE_SIGNING_PRIVATE_KEY?.trim();
  if (!value) return null;
  const key = createPrivateKey(normalizedPem(value));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("BUNDLE_SIGNING_PRIVATE_KEY 必须是 Ed25519 私钥");
  return key;
}

function signDigest(digest: string, privateKey: ReturnType<typeof createPrivateKey>): string {
  return signValue(null, Buffer.from(digest, "hex"), privateKey).toString("base64");
}

function publicKeyPem(privateKey: ReturnType<typeof createPrivateKey>): string {
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
}

interface TrustRingDocument {
  schemaVersion: "workloom.bundle.trust/v1";
  keys: Record<string, { algorithm: "ed25519"; publicKey: string }>;
  revoked: string[];
}

function readTrustRing(): TrustRingDocument {
  if (!existsSync(trustFile)) return { schemaVersion: "workloom.bundle.trust/v1", keys: {}, revoked: [] };
  const value = JSON.parse(readFileSync(trustFile, "utf8")) as TrustRingDocument;
  if (value.schemaVersion !== "workloom.bundle.trust/v1" || !value.keys || !Array.isArray(value.revoked)) {
    throw new Error("行业包公钥环格式无效");
  }
  return value;
}

function registerSigningPublicKey(keyId: string, privateKey: ReturnType<typeof createPrivateKey>): void {
  const ring = readTrustRing();
  if (ring.revoked.includes(keyId)) throw new Error(`签名密钥 ${keyId} 已撤销，不能重新用于发布`);
  ring.keys[keyId] = { algorithm: "ed25519", publicKey: publicKeyPem(privateKey) };
  mkdirSync(dirname(trustFile), { recursive: true });
  writeFileSync(trustFile, `${JSON.stringify(ring, null, 2)}\n`);
}

function releaseTrustRing(): TrustRingDocument {
  const ring = readTrustRing();
  const envValue = process.env.BUNDLE_VERIFICATION_KEYS?.trim();
  if (!envValue) return ring;
  const parsed = JSON.parse(envValue) as Record<string, unknown>;
  const source = parsed.keys && typeof parsed.keys === "object"
    ? parsed.keys as Record<string, unknown>
    : parsed;
  for (const [keyId, item] of Object.entries(source)) {
    if (["schemaVersion", "revoked"].includes(keyId)) continue;
    const publicKey = typeof item === "string" ? item
      : item && typeof item === "object" ? (item as Record<string, unknown>).publicKey
        : undefined;
    if (typeof publicKey !== "string") throw new Error(`验证公钥 ${keyId} 格式无效`);
    ring.keys[keyId] = { algorithm: "ed25519", publicKey: normalizedPem(publicKey) };
  }
  if (Array.isArray(parsed.revoked)) {
    ring.revoked = [...new Set([...ring.revoked, ...parsed.revoked.filter((item): item is string => typeof item === "string")])];
  }
  return ring;
}

function safeEqual(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function providedPaths(manifest: BundleManifest): string[] {
  const paths: string[] = [];
  for (const value of Object.values(manifest.workloom.provides)) {
    if (typeof value === "string") paths.push(value);
    else if (Array.isArray(value)) paths.push(...value);
  }
  return paths;
}

function assetDigestsFor(directory: string, manifest: BundleManifest): Record<string, string> {
  const paths = providedPaths(manifest);
  if (new Set(paths).size !== paths.length) throw new Error("资产清单存在重复路径");
  return Object.fromEntries(paths.sort((a, b) => a.localeCompare(b)).map((assetPath) => {
    const absolute = resolve(directory, assetPath);
    if (!absolute.startsWith(`${directory}${sep}`) || !existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(`声明的资产不存在、不是文件或越出行业包目录：${assetPath}`);
    }
    return [assetPath, createHash("sha256").update(readFileSync(absolute)).digest("hex")];
  }));
}

function verifyPresetAssets(directory: string, label: string, manifest: BundleManifest): Record<string, string> {
  const declared = manifest.workloom.provides.presets;
  const declaredSet = new Set(declared);
  if (declaredSet.size !== declared.length) errors.push(`${label}：岗位资产清单存在重复路径`);

  const presetDirectory = join(directory, "presets");
  const actual = existsSync(presetDirectory)
    ? readdirSync(presetDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map((entry) => `presets/${entry.name}`)
    : [];
  for (const path of actual) {
    if (!declaredSet.has(path)) errors.push(`${label}：岗位资产未在清单声明：${path}`);
  }

  const documents: Array<{ assetPath: string; value: unknown }> = [];
  for (const assetPath of declared) {
    const absolute = resolve(directory, assetPath);
    if (!absolute.startsWith(`${directory}${sep}`) || !existsSync(absolute)) continue;
    try {
      documents.push({ assetPath, value: YAML.parse(readFileSync(absolute, "utf8")) });
    } catch (error) {
      errors.push(`${label}：岗位资产无法解析：${assetPath}（${String(error)}）`);
    }
  }

  const workforce = WorkforcePresetCollectionSchema.safeParse(documents.map((item) => item.value));
  if (!workforce.success) {
    for (const issue of workforce.error.issues) {
      const [rawIndex, ...fieldPath] = issue.path;
      const source = typeof rawIndex === "number" ? documents[rawIndex]?.assetPath : undefined;
      const field = fieldPath.length > 0 ? `（${fieldPath.join(".")}）` : "";
      errors.push(`${label}：${source ?? "岗位资产"}${field}：${issue.message}`);
    }
    return {};
  }
  return Object.fromEntries(workforce.data.map((preset) => [`actor.${preset.preset_key}`, preset.name]));
}

function verifyOne(directory: string): void {
  const file = join(directory, "bundle.json");
  const label = relative(bundlesRoot, directory);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    errors.push(`${label}：bundle.json 不是合法 JSON（${String(error)}）`);
    return;
  }

  if (refreshDigests) {
    const workloom = raw.workloom;
    if (releaseMode && workloom && typeof workloom === "object" && !Array.isArray(workloom)
      && (workloom as Record<string, unknown>).status !== "draft") {
      (workloom as Record<string, unknown>).status = "stable";
    }
    let normalized: BundleManifest;
    try {
      normalized = parseBundleManifest(raw);
    } catch (error) {
      errors.push(...formatContractError(error).map((message) => `${label}：${message}`));
      return;
    }
    let assets: Record<string, string>;
    try {
      assets = assetDigestsFor(directory, normalized);
    } catch (error) {
      errors.push(`${label}：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const digest = digestFor(normalized, assets);
    let signatureKey: ReturnType<typeof createPrivateKey> | null = null;
    try { signatureKey = privateKeyFromEnvironment(); } catch (error) {
      errors.push(`${label}：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const keyId = process.env.BUNDLE_SIGNING_KEY_ID;
    if (releaseMode && normalized.workloom.status === "stable" && !signatureKey) {
      errors.push(`${label}：生产发布缺少 BUNDLE_SIGNING_PRIVATE_KEY`);
      return;
    }
    if (signatureKey && !keyId) {
      errors.push(`${label}：提供了 Ed25519 私钥但缺少 BUNDLE_SIGNING_KEY_ID`);
      return;
    }
    if (signatureKey && keyId) {
      try { registerSigningPublicKey(keyId, signatureKey); } catch (error) {
        errors.push(`${label}：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    raw.integrity = {
      algorithm: "sha256",
      digest,
      assets,
      ...(signatureKey && keyId ? { signature: { algorithm: "ed25519", keyId, value: signDigest(digest, signatureKey) } } : {}),
    };
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  }

  let manifest: BundleManifest;
  try {
    manifest = parseBundleManifest(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    errors.push(...formatContractError(error).map((message) => `${label}：${message}`));
    return;
  }

  try {
    assertBundleCompatibility(manifest, { base: baseVersion, ui: uiVersion });
  } catch (error) {
    errors.push(`${label}：${error instanceof Error ? error.message : String(error)}`);
  }

  const allProvidedPaths = providedPaths(manifest);
  if (new Set(allProvidedPaths).size !== allProvidedPaths.length) {
    errors.push(`${label}：provides 资产清单存在重复路径`);
  }
  for (const path of allProvidedPaths) {
    const absolute = resolve(directory, path);
    if (!absolute.startsWith(`${directory}${sep}`) || !existsSync(absolute)) {
      errors.push(`${label}：声明的资产不存在或越出行业包目录：${path}`);
    }
  }
  const actorTerminology = verifyPresetAssets(directory, label, manifest);

  const bundleId = manifest.workloom.industry;
  const directoryName = relative(bundlesRoot, directory);
  if (directoryName !== bundleId) {
    errors.push(`${label}：目录名必须与行业包标识一致（${bundleId}）`);
  }
  const existingBundle = manifestsByBundleId.get(bundleId);
  if (existingBundle) {
    errors.push(`${label}：行业包标识 ${bundleId} 与目录 ${existingBundle.directoryName} 重复`);
  } else {
    manifestsByBundleId.set(bundleId, { directoryName, manifest, actorTerminology });
  }

  const actualDigest = digestFor(manifest);
  if (!manifest.integrity) {
    if (manifest.workloom.status !== "draft") errors.push(`${label}：候选/稳定行业包必须有 sha256 完整性摘要`);
  } else if (!safeEqual(manifest.integrity.digest, actualDigest)) {
    errors.push(`${label}：完整性摘要与清单内容不一致，请重新封装`);
  }

  if (manifest.integrity) {
    try {
      const diskAssets = assetDigestsFor(directory, manifest);
      const declaredAssets = manifest.integrity.assets;
      const diskPaths = Object.keys(diskAssets).sort();
      const declaredPaths = Object.keys(declaredAssets).sort();
      if (diskPaths.length !== declaredPaths.length
        || diskPaths.some((path, index) => path !== declaredPaths[index])) {
        errors.push(`${label}：integrity.assets 必须与 provides 逐项一一对应，不得缺失或额外声明`);
      } else {
        for (const path of diskPaths) {
          if (!safeEqual(diskAssets[path]!, declaredAssets[path]!)) {
            errors.push(`${label}：资产内容摘要不一致：${path}`);
          }
        }
      }
    } catch (error) {
      errors.push(`${label}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (manifest.workloom.status === "stable") {
    const signature = manifest.integrity?.signature;
    if (!signature) {
      errors.push(`${label}：生产发布必须有 Ed25519 签名`);
    } else {
      try {
        const ring = releaseTrustRing();
        if (ring.revoked.includes(signature.keyId)) {
          errors.push(`${label}：签名密钥 ${signature.keyId} 已撤销`);
        } else {
          const trusted = ring.keys[signature.keyId];
          if (!trusted) errors.push(`${label}：可信公钥环没有 ${signature.keyId}`);
          else {
            const key = createPublicKey(normalizedPem(trusted.publicKey));
            const valid = key.asymmetricKeyType === "ed25519" && verifyValue(
              null,
              Buffer.from(actualDigest, "hex"),
              key,
              Buffer.from(signature.value, "base64"),
            );
            if (!valid) errors.push(`${label}：Ed25519 签名验证失败`);
          }
        }
      } catch (error) {
        errors.push(`${label}：验证公钥环失败（${error instanceof Error ? error.message : String(error)}）`);
      }
    }
  }

  for (const entry of manifest.workloom.ui.navigation.slots) {
    if (!navigationGroups.has(entry.group)) errors.push(`${label}：未知导航分组 ${entry.group}`);
    if (!iconNames.has(entry.icon)) errors.push(`${label}：未知共享图标 ${entry.icon}`);
  }

  for (const widget of manifest.workloom.ui.home.widgets) {
    if (!baseWidgetComponents.has(widget.component)) {
      errors.push(`${label}：首页组件 ${widget.component} 不在基座组件白名单，行业包不得自建基础组件`);
    }
    if (widget.component === "QuickTaskList") {
      const tasks = widget.props.tasks;
      if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 8) {
        errors.push(`${label}：快捷任务必须配置 1–8 条中文任务`);
      } else {
        for (const task of tasks) {
          if (typeof task !== "string" || !/\p{Script=Han}/u.test(task) || task.length > 40) {
            errors.push(`${label}：快捷任务必须是 40 字以内的中文用户文案`);
          }
        }
      }
    }
  }

  const front = manifest.workloom.ui.serviceFront;
  if (!front.enabled && (front.identityPolicy !== "disabled" || front.tabs.length || front.services.length)) {
    errors.push(`${label}：C端关闭时身份策略、标签和服务必须同时为空`);
  }
  // C 端可以只开放已签名渠道会话、通用对话与工单，而不绑定行业业务身份。
  // identityPolicy=disabled 表示禁用会员/订单等业务身份绑定，不代表允许客户端自报身份。
}

/**
 * 发布前验证完整组合闭包。运行时会再次验真并 fail-close；这里把缺包、版本漂移、
 * 循环和 UI 合并冲突提前到制品门禁，避免“发布成功、首次装载才失败”。
 */
function verifyComposition(primaryId: string): void {
  const primaryRecord = manifestsByBundleId.get(primaryId);
  if (!primaryRecord) return;
  const ordered: Array<{ parentId: string | null; manifest: BundleManifest; actorTerminology: Record<string, string> }> = [];
  const visiting: string[] = [];
  const seen = new Set<string>();

  const visit = (bundleId: string, expectedVersion: string | undefined, parentId: string | null): void => {
    if (visiting.includes(bundleId)) {
      errors.push(`${primaryId}：组合依赖形成循环：${[...visiting, bundleId].join(" → ")}`);
      return;
    }
    if (seen.has(bundleId)) {
      errors.push(`${primaryId}：组合依赖重复引用 ${bundleId}`);
      return;
    }
    const record = manifestsByBundleId.get(bundleId);
    if (!record) {
      errors.push(`${primaryId}：依赖行业包 ${bundleId}@${expectedVersion ?? "未知版本"} 不存在`);
      return;
    }
    if (expectedVersion && record.manifest.version !== expectedVersion) {
      errors.push(`${primaryId}：依赖 ${bundleId} 要求 ${expectedVersion}，实际为 ${record.manifest.version}`);
    }
    if (parentId && ["draft", "retired"].includes(record.manifest.workloom.status)) {
      errors.push(`${primaryId}：依赖行业包 ${bundleId} 未处于可组合发布状态`);
    }
    visiting.push(bundleId);
    seen.add(bundleId);
    for (const dependency of record.manifest.workloom.dependencies ?? []) {
      visit(dependency.bundleId, dependency.version, bundleId);
    }
    visiting.pop();
    ordered.push({ parentId, manifest: record.manifest, actorTerminology: record.actorTerminology });
  };

  visit(primaryId, undefined, null);
  if (primaryRecord.manifest.workloom.status === "stable") {
    const unstable = ordered.find(({ manifest }) => manifest.workloom.status !== "stable");
    if (unstable) errors.push(`${primaryId}：稳定主行业包不能组合未稳定依赖 ${unstable.manifest.workloom.industry}`);
  }

  const capabilityOwners = new Map<string, string>();
  const routeOwners = new Map<string, string>();
  const terminology = new Map<string, { value: string; owner: string }>();
  const dependencyWidgetSlots = new Map<string, string>();
  for (const { parentId, manifest, actorTerminology } of ordered) {
    const bundleId = manifest.workloom.industry;
    for (const slot of manifest.workloom.ui.navigation.slots) {
      const capabilityOwner = capabilityOwners.get(slot.capabilityId);
      if (capabilityOwner) errors.push(`${primaryId}：导航能力 ${slot.capabilityId} 由 ${capabilityOwner} 与 ${bundleId} 重复声明`);
      else capabilityOwners.set(slot.capabilityId, bundleId);
      const routeOwner = routeOwners.get(slot.route);
      if (routeOwner) errors.push(`${primaryId}：导航路由 ${slot.route} 由 ${routeOwner} 与 ${bundleId} 重复声明`);
      else routeOwners.set(slot.route, bundleId);
    }
    for (const [key, value] of Object.entries({ ...actorTerminology, ...manifest.workloom.ui.terminology })) {
      const existing = terminology.get(key);
      if (existing && existing.value !== value) {
        errors.push(`${primaryId}：组合术语 ${key} 在 ${existing.owner} 与 ${bundleId} 中冲突`);
      } else if (!existing) terminology.set(key, { value, owner: bundleId });
    }
    // 主包可显式覆盖依赖首页槽；两个依赖之间争用同一客户端槽位必须拒绝。
    if (parentId !== null) {
      for (const widget of manifest.workloom.ui.home.widgets) {
        for (const client of widget.clients) {
          const key = `${widget.slot}:${client}`;
          const owner = dependencyWidgetSlots.get(key);
          if (owner) errors.push(`${primaryId}：依赖首页槽位 ${key} 由 ${owner} 与 ${bundleId} 争用`);
          else dependencyWidgetSlots.set(key, bundleId);
        }
      }
    }
  }
}

if (!existsSync(bundlesRoot) || !statSync(bundlesRoot).isDirectory()) {
  console.error(`❌ 行业包目录不存在：${bundlesRoot}`);
  process.exit(1);
}
for (const entry of readdirSync(bundlesRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && existsSync(join(bundlesRoot, entry.name, "bundle.json"))) verifyOne(join(bundlesRoot, entry.name));
}
for (const bundleId of manifestsByBundleId.keys()) verifyComposition(bundleId);

if (errors.length) {
  console.error(`❌ 行业包治理门禁失败（${errors.length} 项）`);
  for (const error of errors) console.error(`  · ${error}`);
  process.exit(1);
}
console.log(`✅ 行业包契约、兼容范围、资产、导航与完整性门禁通过（base ${baseVersion} / ui ${uiVersion}${releaseMode ? " / 发布验签" : ""}）`);
