/**
 * bundles —— 行业装配域（L2 Base Bundle 六插件之六「行业 Bundle 装载」，F11）
 * PRD P7 舰船换装坞：换行业 = 换一套成员/群规/皮肤，底座代码零改动（§2.2/§2.3/§2.4）
 *
 * 数据来源口径（P7-⑤）：槽位状态 = bundle 注册表投影（磁盘 bundles/<slug>/ 实物扫描）；
 * 校验结果 = 装配校验器运行记录（recheck/activate 留痕 biz_events，不静默 L9.2）。
 *
 * 八装配槽（P7E1/§2.2 + v3.0 第⑦槽 + D24 第⑧槽）：① 档案 Schema ② 对象与阶段枚举 ③ 工具集 ④ 围栏包
 *   ⑤ Agent 班组 ⑥ 工作台 UI ⑦ 模型路由策略 ⑧ 反馈枚举表（feedback-enums.yml，非阻断：
 *   缺失 = decide 校验放行；存在即注册为工作区受控词表，D24 修订 3）
 * 起飞前检查单（P7E3/F2.10）：档案 forbidden 校验 / 枚举冲突检测 / 工具探针健康 /
 *   围栏绑定完整 / UI 用例同步 —— 任一失败拒绝激活；修复后重跑（数据活算，重查即重跑）。
 *   第⑦槽 model-policy.yml 为非阻断校验：缺失 → 使用底座默认路由策略（L2.6）；存在但非法 → 标红拒绝激活。
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import YAML from "yaml";
import { gatewayAppend, gatewayAppendOnClient } from "../workdata/gateway.js";
import { parseModelPolicy } from "../model-router/policy.js";
import {
  loadFeedbackEnumsFromBundle,
  registerFeedbackEnums,
  unregisterFeedbackEnums,
} from "../evolve/feedback-enums.js";
import {
  assertBundleCompatibility,
  canonicalBundleArtifactPayload,
  formatContractError,
  INDUSTRY_CONTRACT_VERSION,
  isWorkLoomReservedRoute,
  parseBundleManifest,
  parseWorkforcePresets,
  type BundleManifest,
  type WorkforcePreset,
} from "@workloom/industry-contract";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 仓库 bundles/ 根（packages/base/bundles → 上三级）；测试可用 BUNDLES_ROOT 指到临时目录 */
export const DEFAULT_BUNDLES_ROOT = join(__dirname, "..", "..", "..", "bundles");
import { maybeApplyOverlay } from "../overlay/assembly-hook.js";

export function bundlesRoot(): string {
  return process.env.BUNDLES_ROOT ?? DEFAULT_BUNDLES_ROOT;
}

/** 已注册工作台页面（P7E3 ⑤「UI 用例同步」校验基准；新增页面须同步此表与 cases.json） */
export const REGISTERED_PAGES = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"] as const;

export type SlotId = "archive" | "enums" | "tools" | "fences" | "presets" | "ui" | "model-policy";
export interface SlotState {
  id: SlotId;
  label: string;
  filled: boolean;
  /** 校验失败标红（p7_fail 口径：失败槽位标红） */
  failed: boolean;
  summary: string;
  /** 回链管理页（围栏包→P5；班组→P8） */
  go?: "p5" | "p8";
}
export type CheckKey = "archive" | "enums" | "tools" | "fences" | "ui" | "model_policy";
export interface CheckItem {
  key: CheckKey;
  label: string;
  ok: boolean;
  detail: string;
  /** 修复指引（FixList 回链槽位） */
  fix?: string;
  slot?: SlotId;
}
export interface BundleAgentRow {
  id: string;
  presetKey: string;
  name: string;
  version: string;
  status: string;
  readonly: boolean;
  fenceBindings: string[];
  /** 围栏绑定校验（P7E2：未声明 fence_bindings 即系统级禁写 F2.10） */
  fenceOk: boolean;
}
export interface BundleProfile {
  slug: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  /** active=当前工作区已激活；available=可切换；draft=草稿（§2.3 不进分发） */
  status: "active" | "available" | "draft";
  slots: SlotState[];
  filledCount: number;
  checks: CheckItem[];
  canActivate: boolean;
  agents: BundleAgentRow[];
  checkedAt: string;
}

export class BundleError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "ALREADY_EXISTS" | "INVALID_INPUT" | "ASSEMBLY_CHECK_FAILED" | "INTEGRITY_FAILED" | "INCOMPATIBLE",
    message: string,
    public readonly checks?: CheckItem[],
  ) {
    super(message);
    this.name = "BundleError";
  }
}

interface Scope { tenantId: string; workspaceId: string }

/* ================= 实物读取 ================= */

function readJson<T = Record<string, unknown>>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

type BundleJson = BundleManifest;

const RUNTIME_BASE_VERSION = process.env.WORKLOOM_BASE_VERSION ?? "0.1.0";
const RUNTIME_UI_VERSION = process.env.WORKLOOM_UI_VERSION ?? "0.1.0";

function digestForBundle(manifest: BundleJson | Record<string, unknown>): string {
  // 摘要统一覆盖“契约解析后的规范形”：Schema 默认值也属于最终制品内容。
  // 否则草稿转 candidate 时从原始 JSON 计算，而校验/治理从 parse 后计算，
  // 同一清单会出现两种摘要并在下一次装载时被误判为篡改。
  const normalized = parseBundleManifest(manifest);
  return createHash("sha256").update(canonicalBundleArtifactPayload(normalized)).digest("hex");
}

function secureHexEqual(a: string, b: string): boolean {
  return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b)
    && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

interface BundleTrustKey {
  algorithm: "ed25519";
  publicKey: string;
}

interface BundleTrustRing {
  keys: Record<string, BundleTrustKey>;
  revoked: Set<string>;
}

function parseTrustMaterial(value: unknown, label: string): BundleTrustRing {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BundleError("INTEGRITY_FAILED", `${label}不是有效的公钥环`);
  }
  const record = value as Record<string, unknown>;
  const sourceKeys = record.keys && typeof record.keys === "object" && !Array.isArray(record.keys)
    ? record.keys as Record<string, unknown>
    : record;
  const keys: Record<string, BundleTrustKey> = {};
  for (const [keyId, item] of Object.entries(sourceKeys)) {
    if (["schemaVersion", "revoked"].includes(keyId)) continue;
    const publicKey = typeof item === "string"
      ? item
      : item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>).publicKey
        : undefined;
    const algorithm = item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>).algorithm
      : "ed25519";
    if (algorithm !== "ed25519" || typeof publicKey !== "string" || !publicKey.includes("BEGIN PUBLIC KEY")) {
      throw new BundleError("INTEGRITY_FAILED", `${label}中的公钥 ${keyId} 无效`);
    }
    try { createPublicKey(publicKey); } catch {
      throw new BundleError("INTEGRITY_FAILED", `${label}中的公钥 ${keyId} 无法解析`);
    }
    keys[keyId] = { algorithm: "ed25519", publicKey };
  }
  const revoked = new Set(Array.isArray(record.revoked)
    ? record.revoked.filter((item): item is string => typeof item === "string")
    : []);
  return { keys, revoked };
}

function mergeTrustRing(target: BundleTrustRing, source: BundleTrustRing): void {
  Object.assign(target.keys, source.keys);
  for (const keyId of source.revoked) target.revoked.add(keyId);
}

function loadBundleTrustRing(bundleRoot: string): BundleTrustRing {
  const merged: BundleTrustRing = { keys: {}, revoked: new Set() };
  const configuredPath = process.env.BUNDLE_TRUST_PATH?.trim();
  if (configuredPath) {
    const trustFile = resolve(configuredPath);
    const normalizedBundleRoot = resolve(bundleRoot);
    const rel = relative(normalizedBundleRoot, trustFile);
    if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new BundleError("INTEGRITY_FAILED", "行业包验证公钥必须锚定在行业包目录之外");
    }
    const parsed = readJson<unknown>(trustFile);
    if (parsed === null) throw new BundleError("INTEGRITY_FAILED", "独立行业包验证公钥环不存在或不可读取");
    mergeTrustRing(merged, parseTrustMaterial(parsed, "独立行业包验证公钥环"));
  }
  if (process.env.BUNDLE_VERIFICATION_KEYS?.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(process.env.BUNDLE_VERIFICATION_KEYS); } catch {
      throw new BundleError("INTEGRITY_FAILED", "环境变量中的行业包验证材料不是合法 JSON");
    }
    mergeTrustRing(merged, parseTrustMaterial(parsed, "环境变量中的行业包验证材料"));
  }
  return merged;
}

function verifyStableBundleSignature(manifest: BundleJson, digest: string, root: string): void {
  if (manifest.workloom.status !== "stable") return;
  const signature = manifest.integrity?.signature;
  if (!signature) throw new BundleError("INTEGRITY_FAILED", "拒绝装载未签名的稳定行业包");
  const trust = loadBundleTrustRing(root);
  if (trust.revoked.has(signature.keyId)) {
    throw new BundleError("INTEGRITY_FAILED", `行业包签名密钥 ${signature.keyId} 已撤销，已拒绝装载`);
  }
  const trusted = trust.keys[signature.keyId];
  if (!trusted) {
    throw new BundleError("INTEGRITY_FAILED", `行业包签名密钥 ${signature.keyId} 不在可信公钥环，已拒绝装载`);
  }
  let valid = false;
  try {
    valid = verifySignature(
      null,
      Buffer.from(digest, "hex"),
      createPublicKey(trusted.publicKey),
      Buffer.from(signature.value, "base64"),
    );
  } catch { valid = false; }
  if (!valid) throw new BundleError("INTEGRITY_FAILED", `行业包签名 ${signature.keyId} 无法验证，已拒绝装载`);
}

export function verifyBundleManifestDocument(input: unknown, slug: string, trustRoot = bundlesRoot()): BundleJson {
  let manifest: BundleJson;
  try {
    manifest = parseBundleManifest(input);
  } catch (error) {
    throw new BundleError("INVALID_INPUT", `行业包契约无效：${formatContractError(error).join("；")}`);
  }
  if (manifest.workloom.industry !== slug) {
    throw new BundleError("INVALID_INPUT", `行业包目录 ${slug} 与清单标识 ${manifest.workloom.industry} 不一致`);
  }
  try {
    assertBundleCompatibility(manifest, { base: RUNTIME_BASE_VERSION, ui: RUNTIME_UI_VERSION });
  } catch (error) {
    throw new BundleError("INCOMPATIBLE", error instanceof Error ? error.message : String(error));
  }
  const expected = digestForBundle(manifest);
  if (manifest.workloom.status !== "draft" && !manifest.integrity) {
    throw new BundleError("INTEGRITY_FAILED", "非草稿行业包缺少完整性摘要，已拒绝装载");
  }
  if (manifest.integrity && !secureHexEqual(manifest.integrity.digest, expected)) {
    throw new BundleError("INTEGRITY_FAILED", "行业包内容与完整性摘要不一致，已拒绝装载");
  }
  verifyStableBundleSignature(manifest, expected, trustRoot);
  return manifest;
}

/**
 * 读取经过契约、运行时兼容性、完整性摘要及生产签名校验的 Bundle 清单。
 * 服务端能力只能从这个入口取得行业资产引用，禁止绕过校验直接读取 bundle.json。
 */
export function loadVerifiedBundleManifest(slug: string, root = bundlesRoot()): BundleJson {
  const raw = readJson(join(root, slug, "bundle.json"));
  if (!raw) throw new BundleError("NOT_FOUND", `行业包「${slug}」不存在或不可读取`);
  const manifest = verifyBundleManifestDocument(raw, slug, root);
  verifyBundleAssetContents(slug, manifest, root);
  return manifest;
}

function verifiedAssetPath(slug: string, assetPath: string, root: string): string {
  if (!assetPath.trim() || isAbsolute(assetPath) || assetPath.includes("\\")) {
    throw new BundleError("INVALID_INPUT", "行业包资产路径无效");
  }
  const segments = assetPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new BundleError("INVALID_INPUT", "行业包资产路径不得越出包目录");
  }
  const bundleDir = resolve(root, slug);
  const target = resolve(bundleDir, ...segments);
  const rel = relative(bundleDir, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new BundleError("INVALID_INPUT", "行业包资产路径不得越出包目录");
  }
  return target;
}

function declaredAssetPaths(manifest: BundleJson): string[] {
  const paths: string[] = [];
  for (const value of Object.values(manifest.workloom.provides)) {
    if (typeof value === "string") paths.push(value);
    else if (Array.isArray(value)) paths.push(...value);
  }
  return paths;
}

function collectBundleAssetDigests(slug: string, manifest: BundleJson, root: string): Record<string, string> {
  const paths = declaredAssetPaths(manifest);
  if (new Set(paths).size !== paths.length) {
    throw new BundleError("INTEGRITY_FAILED", "行业包资产清单存在重复路径，已拒绝装载");
  }
  const entries = paths.sort((a, b) => a.localeCompare(b)).map((assetPath) => {
    const path = verifiedAssetPath(slug, assetPath, root);
    try {
      const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
      return [assetPath, digest] as const;
    } catch {
      throw new BundleError("INTEGRITY_FAILED", `行业包资产「${assetPath}」不存在或不可读取`);
    }
  });
  return Object.fromEntries(entries);
}

function verifyBundleAssetContents(slug: string, manifest: BundleJson, root: string): void {
  if (!manifest.integrity) return; // 草稿可以尚未封装；候选与稳定包已在清单门禁中强制 integrity。
  const actual = collectBundleAssetDigests(slug, manifest, root);
  const declared = manifest.integrity.assets;
  const actualPaths = Object.keys(actual).sort();
  const declaredPaths = Object.keys(declared).sort();
  if (actualPaths.length !== declaredPaths.length
    || actualPaths.some((path, index) => path !== declaredPaths[index])) {
    throw new BundleError("INTEGRITY_FAILED", "行业包资产摘要索引与 provides 清单不一致，已拒绝装载");
  }
  for (const path of actualPaths) {
    if (!secureHexEqual(actual[path]!, declared[path]!)) {
      throw new BundleError("INTEGRITY_FAILED", `行业包资产「${path}」内容与摘要不一致，已拒绝装载`);
    }
  }
}

function sealBundleWithoutSignature(slug: string, manifest: BundleJson, root: string): BundleJson["integrity"] {
  const assets = collectBundleAssetDigests(slug, manifest, root);
  const candidate = {
    ...manifest,
    integrity: { algorithm: "sha256" as const, digest: "0".repeat(64), assets },
  };
  return { algorithm: "sha256", digest: digestForBundle(candidate), assets };
}

/**
 * 从已验证清单声明的相对路径读取 JSON 资产。调用方仍须校验具体资产 Schema；
 * 本函数只保证来源属于指定 Bundle，且清单本身已经通过完整性/签名门禁。
 */
export function readVerifiedBundleJsonAsset(
  slug: string,
  assetPath: string,
  root = bundlesRoot(),
): unknown {
  // 先验证清单；即使调用方已拿到投影，也不允许资产读取绕过生产签名门禁。
  loadVerifiedBundleManifest(slug, root);
  const path = verifiedAssetPath(slug, assetPath, root);
  const asset = readJson<unknown>(path);
  if (asset === null) {
    throw new BundleError("NOT_FOUND", `行业包「${slug}」声明的资产不可读取`);
  }
  return asset;
}

function workforceAssetIssues(error: unknown, assetPaths: string[]): string[] {
  return formatContractError(error).map((message) => {
    const matched = /^(\d+)(?:\.([^：]+))?：(.*)$/u.exec(message);
    if (!matched) return message;
    const assetPath = assetPaths[Number(matched[1])] ?? `第 ${Number(matched[1]) + 1} 个岗位资产`;
    return `${assetPath}${matched[2] ? `（${matched[2]}）` : ""}：${matched[3]}`;
  });
}

function parseBundleWorkforcePresets(
  manifest: BundleManifest,
  slug: string,
  root: string,
): WorkforcePreset[] {
  const assetPaths = manifest.workloom.provides.presets;
  const values = assetPaths.map((assetPath) => {
    try {
      return YAML.parse(readFileSync(verifiedAssetPath(slug, assetPath, root), "utf-8")) as unknown;
    } catch (error) {
      throw new BundleError(
        "INVALID_INPUT",
        `行业包「${slug}」岗位资产无法解析：${assetPath}（${String(error)}）`,
      );
    }
  });
  try {
    return parseWorkforcePresets(values);
  } catch (error) {
    throw new BundleError(
      "INVALID_INPUT",
      `行业包「${slug}」岗位契约无效：${workforceAssetIssues(error, assetPaths).join("；")}`,
    );
  }
}

/**
 * 读取经过 Bundle 完整性门禁与公共岗位 Schema 双重校验的班组资产。
 * runtime、投影和种子入口共用此函数，禁止对岗位字段各自猜默认值。
 */
export function loadVerifiedBundleWorkforcePresets(
  slug: string,
  root = bundlesRoot(),
): WorkforcePreset[] {
  const manifest = loadVerifiedBundleManifest(slug, root);
  return parseBundleWorkforcePresets(manifest, slug, root);
}

/**
 * 三端只消费这一份经过契约、兼容性与完整性校验的 UI 投影。
 * 禁止客户端自行读取 bundle.json、猜测当前行业，或在失败时回退到某个示例行业。
 */
export interface BundleUiProjection {
  /** 工作区唯一 active 装配所指向的主 Bundle；依赖包不产生第二条 active 安装。 */
  primaryBundleId?: string;
  bundleId: string;
  bundleName: string;
  bundleVersion: string;
  bundleStatus: BundleManifest["workloom"]["status"];
  contractVersion: string;
  integrityDigest: string | null;
  /** 稳定包已由 verifyBundleManifestDocument 无条件验签。 */
  signatureKeyId: string | null;
  /** 每个组成包的独立验签/兼容结果来源，供审计与事件写入保留 bundleId。 */
  sources?: Array<{
    bundleId: string;
    bundleName: string;
    bundleVersion: string;
    bundleStatus: BundleManifest["workloom"]["status"];
    integrityDigest: string | null;
    signatureKeyId: string | null;
    role: "primary" | "dependency";
    parentBundleId: string | null;
  }>;
  /** 仅由各导航槽位声明的权限并集；access.me 不把无槽位权限误当成导航授权。 */
  navigationPermissionUniverse?: string[];
  ui: Omit<BundleManifest["workloom"]["ui"], "navigation" | "home"> & {
    navigation: {
      slots: Array<BundleManifest["workloom"]["ui"]["navigation"]["slots"][number] & {
        sourceBundleId?: string;
      }>;
    };
    home: {
      widgets: Array<BundleManifest["workloom"]["ui"]["home"]["widgets"][number] & {
        sourceBundleId?: string;
      }>;
    };
    /** 字符串数组保留旧三端契约；带来源的条目用于账本、诊断和后续投影。 */
    objectEntries?: Array<{ label: string; sourceBundleIds: string[] }>;
    workflowEntries?: Array<{ label: string; sourceBundleIds: string[] }>;
    terminologySources?: Record<string, string[]>;
  };
}

function presetActorTerminology(manifest: BundleManifest, slug: string, root: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const preset of parseBundleWorkforcePresets(manifest, slug, root)) {
    const key = preset.preset_key;
    const name = preset.name;
    const terminologyKey = `actor.${key}`;
    labels[terminologyKey] = name;
  }
  return labels;
}

interface VerifiedProjectionSource {
  manifest: BundleManifest;
  parentBundleId: string | null;
  role: "primary" | "dependency";
}

function assertOwnedProjectionDeclarations(manifest: BundleManifest): void {
  const bundleId = manifest.workloom.industry;
  if (bundleId === "workloom") {
    throw new BundleError("INVALID_INPUT", "行业包不能占用 WorkLoom 公共能力命名空间");
  }
  const declaredPermissions = new Set(manifest.workloom.ui.permissions);
  for (const permission of declaredPermissions) {
    if (!permission.startsWith(`${bundleId}.`)) {
      throw new BundleError("INVALID_INPUT", `行业包「${bundleId}」声明了不属于自身命名空间的权限 ${permission}`);
    }
  }
  for (const slot of manifest.workloom.ui.navigation.slots) {
    if (!slot.capabilityId.startsWith(`${bundleId}.`)) {
      throw new BundleError("INVALID_INPUT", `行业包「${bundleId}」导航能力 ${slot.capabilityId} 越过自身命名空间`);
    }
    if (isWorkLoomReservedRoute(slot.route) || /^\/p\d+(?:\/|$)/.test(slot.route)) {
      throw new BundleError("INVALID_INPUT", `行业包「${bundleId}」导航路由 ${slot.route} 与公共能力冲突`);
    }
    for (const permission of slot.permissions) {
      if (!permission.startsWith(`${bundleId}.`) || !declaredPermissions.has(permission)) {
        throw new BundleError(
          "INVALID_INPUT",
          `行业包「${bundleId}」导航权限 ${permission} 未在自身权限清单中声明`,
        );
      }
    }
  }
}

function loadProjectionSources(primarySlug: string, root: string): VerifiedProjectionSource[] {
  const sources: VerifiedProjectionSource[] = [];
  const visiting: string[] = [];
  const seen = new Set<string>();

  const visit = (
    bundleId: string,
    expectedVersion: string | undefined,
    parentBundleId: string | null,
    role: "primary" | "dependency",
  ) => {
    if (visiting.includes(bundleId)) {
      throw new BundleError("INVALID_INPUT", `行业包组合依赖形成循环：${[...visiting, bundleId].join(" → ")}`);
    }
    if (seen.has(bundleId)) {
      throw new BundleError("INVALID_INPUT", `行业包组合重复引用「${bundleId}」，已拒绝装载`);
    }
    const manifest = loadVerifiedBundleManifest(bundleId, root);
    if (expectedVersion && manifest.version !== expectedVersion) {
      throw new BundleError(
        "INCOMPATIBLE",
        `行业包「${parentBundleId}」要求 ${bundleId}@${expectedVersion}，实际为 ${manifest.version}`,
      );
    }
    if (role === "dependency" && (manifest.workloom.status === "draft" || manifest.workloom.status === "retired")) {
      throw new BundleError("INCOMPATIBLE", `依赖行业包「${bundleId}」未处于可组合发布状态`);
    }
    assertOwnedProjectionDeclarations(manifest);
    visiting.push(bundleId);
    seen.add(bundleId);
    for (const dependency of manifest.workloom.dependencies ?? []) {
      visit(dependency.bundleId, dependency.version, bundleId, "dependency");
    }
    visiting.pop();
    sources.push({ manifest, parentBundleId, role });
  };

  visit(primarySlug, undefined, null, "primary");
  const primary = sources.at(-1)!.manifest;
  if (primary.workloom.status === "stable") {
    const untrusted = sources.find(({ manifest }) => manifest.workloom.status !== "stable");
    if (untrusted) {
      throw new BundleError(
        "INTEGRITY_FAILED",
        `稳定主行业包不能组合未稳定依赖「${untrusted.manifest.workloom.industry}」`,
      );
    }
  }
  return sources;
}

function mergeSourcedLabels(
  sources: readonly VerifiedProjectionSource[],
  field: "objects" | "workflows",
): { labels: string[]; entries: Array<{ label: string; sourceBundleIds: string[] }> } {
  const byLabel = new Map<string, string[]>();
  for (const { manifest } of sources) {
    const bundleId = manifest.workloom.industry;
    for (const label of manifest.workloom.ui[field]) {
      const sourceIds = byLabel.get(label) ?? [];
      sourceIds.push(bundleId);
      byLabel.set(label, sourceIds);
    }
  }
  return {
    labels: [...byLabel.keys()],
    entries: [...byLabel].map(([label, sourceBundleIds]) => ({ label, sourceBundleIds })),
  };
}

/**
 * 装配主 Bundle 及其签名清单内的精确版本依赖。合并规则：
 * - 导航 capabilityId/route 全局唯一且必须属于来源包命名空间；
 * - 术语同键同值可共用，异值拒绝；对象/流程按声明顺序去重并保留全部来源；
 * - 依赖之间不能争用同一首页槽位；主包可显式占用该槽位，成为唯一展示来源；
 * - welcome、serviceFront、inspection、theme、experiments 始终由主包裁决，依赖不能覆盖。
 */
export function loadBundleUiProjection(slug: string, root = bundlesRoot()): BundleUiProjection {
  const sources = loadProjectionSources(slug, root);
  const primarySource = sources.at(-1)!;
  const primary = primarySource.manifest;
  const terminology: Record<string, string> = {};
  const terminologySources: Record<string, string[]> = {};
  const navigationSlots: NonNullable<BundleUiProjection["ui"]["navigation"]>["slots"] = [];
  const seenCapabilities = new Set<string>();
  const seenRoutes = new Set<string>();

  for (const { manifest } of sources) {
    const bundleId = manifest.workloom.industry;
    const sourceTerminology = {
      ...presetActorTerminology(manifest, bundleId, root),
      ...manifest.workloom.ui.terminology,
    };
    for (const [key, value] of Object.entries(sourceTerminology)) {
      if (terminology[key] !== undefined && terminology[key] !== value) {
        throw new BundleError("INVALID_INPUT", `组合行业包术语「${key}」存在冲突，已拒绝装载`);
      }
      terminology[key] = value;
      terminologySources[key] = [...new Set([...(terminologySources[key] ?? []), bundleId])];
    }
    for (const slot of manifest.workloom.ui.navigation.slots) {
      if (seenCapabilities.has(slot.capabilityId)) {
        throw new BundleError("INVALID_INPUT", `组合行业包导航能力 ${slot.capabilityId} 重复`);
      }
      if (seenRoutes.has(slot.route)) {
        throw new BundleError("INVALID_INPUT", `组合行业包导航路由 ${slot.route} 重复`);
      }
      seenCapabilities.add(slot.capabilityId);
      seenRoutes.add(slot.route);
      navigationSlots.push({ ...slot, sourceBundleId: bundleId });
    }
  }

  const dependencyWidgets: BundleUiProjection["ui"]["home"]["widgets"] = [];
  const occupiedDependencySlots = new Set<string>();
  for (const { manifest, role } of sources) {
    if (role === "primary") continue;
    for (const widget of manifest.workloom.ui.home.widgets) {
      for (const client of widget.clients) {
        const key = `${widget.slot}:${client}`;
        if (occupiedDependencySlots.has(key)) {
          throw new BundleError("INVALID_INPUT", `组合依赖争用首页槽位 ${widget.slot}（${client}）`);
        }
        occupiedDependencySlots.add(key);
      }
      dependencyWidgets.push({ ...widget, sourceBundleId: manifest.workloom.industry });
    }
  }
  const primarySlotClients = new Set(primary.workloom.ui.home.widgets.flatMap((widget) =>
    widget.clients.map((client) => `${widget.slot}:${client}`)));
  const homeWidgets = dependencyWidgets.flatMap((widget) => {
    const remainingClients = widget.clients.filter((client) => !primarySlotClients.has(`${widget.slot}:${client}`));
    return remainingClients.length > 0 ? [{ ...widget, clients: remainingClients }] : [];
  });
  homeWidgets.push(...primary.workloom.ui.home.widgets.map((widget) => ({
    ...widget,
    sourceBundleId: primary.workloom.industry,
  })));

  const objects = mergeSourcedLabels(sources, "objects");
  const workflows = mergeSourcedLabels(sources, "workflows");
  const navigationPermissionUniverse = [...new Set(navigationSlots.flatMap((slot) => slot.permissions))].sort();
  return {
    primaryBundleId: primary.workloom.industry,
    bundleId: primary.workloom.industry,
    bundleName: primary.workloom.displayName,
    bundleVersion: primary.version,
    bundleStatus: primary.workloom.status,
    contractVersion: primary.workloom.compatibility.contract,
    integrityDigest: primary.integrity?.digest ?? null,
    signatureKeyId: primary.integrity?.signature?.keyId ?? null,
    sources: sources.map(({ manifest, role, parentBundleId }) => ({
      bundleId: manifest.workloom.industry,
      bundleName: manifest.workloom.displayName,
      bundleVersion: manifest.version,
      bundleStatus: manifest.workloom.status,
      integrityDigest: manifest.integrity?.digest ?? null,
      signatureKeyId: manifest.integrity?.signature?.keyId ?? null,
      role,
      parentBundleId,
    })),
    navigationPermissionUniverse,
    ui: {
      ...primary.workloom.ui,
      terminology,
      terminologySources,
      navigation: { slots: navigationSlots },
      home: { widgets: homeWidgets },
      objects: objects.labels,
      objectEntries: objects.entries,
      workflows: workflows.labels,
      workflowEntries: workflows.entries,
      // 以下高影响投影由主包唯一裁决，低信任依赖不得覆盖。
      welcome: primary.workloom.ui.welcome,
      serviceFront: primary.workloom.ui.serviceFront,
      inspection: primary.workloom.ui.inspection,
      theme: primary.workloom.ui.theme,
      permissions: [...new Set(sources.flatMap(({ manifest }) => manifest.workloom.ui.permissions))].sort(),
      experiments: primary.workloom.ui.experiments,
    },
  };
}

/**
 * 面向首次开通的行业包注册表条目。
 *
 * 磁盘目录存在不等于“可安装”：只有契约、兼容性、完整性均通过，且已经
 * 进入 stable、明确声明 example=true 的 Bundle 才能出现在自助开通页。
 * 平台内用包、候选包、草稿包仍可在装配台治理，但不会误放给新客户选择。
 */
export interface SelfServiceBundleEntry {
  slug: string;
  displayName: string;
  description: string;
  version: string;
  serviceFrontEnabled: boolean;
  provisioningMode: "guided-assembly";
}

export interface SelfServiceBundleRegistry {
  version: string;
  entries: SelfServiceBundleEntry[];
  rejected: Array<{ slug: string; reason: string }>;
}

export function listSelfServiceBundles(root = bundlesRoot()): SelfServiceBundleRegistry {
  const entries: SelfServiceBundleEntry[] = [];
  const rejected: Array<{ slug: string; reason: string }> = [];
  for (const slug of listProfileSlugs(root)) {
    try {
      const manifest = loadVerifiedBundleManifest(slug, root);
      const visibleInCurrentChannel = manifest.workloom.status === "stable"
        || (process.env.NODE_ENV !== "production" && manifest.workloom.status === "candidate");
      if (!visibleInCurrentChannel) {
        rejected.push({ slug, reason: "尚未进入稳定发布状态" });
        continue;
      }
      if (!manifest.workloom.example) {
        rejected.push({ slug, reason: "未开放自助开通" });
        continue;
      }
      entries.push({
        slug,
        displayName: manifest.workloom.displayName,
        description: manifest.workloom.description,
        version: manifest.version,
        serviceFrontEnabled: manifest.workloom.ui.serviceFront.enabled,
        provisioningMode: "guided-assembly",
      });
    } catch (error) {
      rejected.push({ slug, reason: error instanceof Error ? error.message : "行业包校验失败" });
    }
  }
  return {
    version: createHash("sha256")
      .update(JSON.stringify(entries.map((entry) => [entry.slug, entry.version])))
      .digest("hex")
      .slice(0, 16),
    entries,
    rejected,
  };
}

interface FenceYml {
  version?: string;
  rules?: Array<{ rule_id: string; is_baseline?: boolean }>;
}

interface UiCasesJson {
  cases?: Array<{ page: string; name: string }>;
}

/** 注册表投影：扫描 bundles/ 下全部 profile（P7E1 数据来源） */
export function listProfileSlugs(root = bundlesRoot()): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "bundle.json")))
    .map((d) => d.name)
    .sort();
}

/* ================= 装配校验（F2.10 起飞前检查单） ================= */

/** 磁盘资产（M4-装配：全部磁盘 I/O 的纯读结果，进 DB 事务前一次性读完） */
export interface BundleDiskAssets {
  dir: string;
  bj: BundleJson;
  isDraft: boolean;
  /** 租户覆盖层（L2）：合并后的扩展资产与应用记录（无覆盖层=null，见 overlay/assembly-hook） */
  extra?: Record<string, unknown>;
  overlayApplied?: { tenantId: string; overlayVersion: number; audit: Array<{ path: string; action: string; detail: string }> } | null;
  archiveSchema: { properties?: Record<string, unknown>; required?: string[] } | null;
  objectsJson: { objects?: Array<{ type: string; label: string }> } | null;
  stagesJson: { stages?: Array<{ id: string; label: string }> } | null;
  presets: WorkforcePreset[];
  fenceFiles: string[];
  fencePacks: FenceYml[];
  uiCases: UiCasesJson | null;
  /** 第⑦槽：模型路由策略原文（缺失=null → 底座默认；非法 → 校验标红） */
  modelPolicyText: string | null;
}

/**
 * 纯磁盘读取（M4-装配）：readdirSync/readFileSync/YAML.parse 全部在此完成——
 * 磁盘 I/O 不进 DB 事务（事务内做慢 I/O 会拉长快照持有时间、放大锁与序列化冲突面；
 * 且磁盘读不参与事务回滚语义，放事务内纯属占坑）。读完再开事务做 DB 侧校验。
 */
function loadBundleDiskAssets(dir: string, slug: string): BundleDiskAssets {
  const raw = readJson(join(dir, "bundle.json"));
  if (!raw) throw new BundleError("NOT_FOUND", `行业 Bundle「${slug}」不存在（bundles/${slug}/bundle.json 缺失）`);
  // 只消费 provides 声明的资产。候选/稳定包还会在这里逐文件核验内容摘要；
  // 未声明文件即使被放入 presets/fences 目录，也绝不进入运行时装配。
  const bundleRoot = dirname(dir);
  const bj = loadVerifiedBundleManifest(slug, bundleRoot);
  const provides = bj.workloom.provides;
  const schemaPath = (suffix: string) => provides.schemas.find((path) => path.endsWith(suffix));
  const uiCasesPath = provides.ui.find((path) => path.endsWith("/cases.json"));
  const readDeclaredJson = <T,>(assetPath: string | undefined): T | null => assetPath
    ? readJson<T>(verifiedAssetPath(slug, assetPath, bundleRoot))
    : null;
  const fenceAssets = provides.fences.map((assetPath) => ({
    assetPath,
    value: YAML.parse(readFileSync(verifiedAssetPath(slug, assetPath, bundleRoot), "utf-8")) as FenceYml,
  }));
  return {
    dir,
    bj,
    isDraft: bj.workloom.status === "draft",
    archiveSchema: readDeclaredJson(schemaPath("/archive.schema.json")),
    objectsJson: readDeclaredJson(schemaPath("/objects.json")),
    stagesJson: readDeclaredJson(schemaPath("/stages.json")),
    presets: parseBundleWorkforcePresets(bj, slug, bundleRoot),
    fenceFiles: fenceAssets.map(({ assetPath }) => assetPath.split("/").at(-1) ?? assetPath),
    fencePacks: fenceAssets.map(({ value }) => value).filter((fence) => fence?.version),
    uiCases: readDeclaredJson(uiCasesPath),
    modelPolicyText: provides.modelPolicy
      ? readFileSync(verifiedAssetPath(slug, provides.modelPolicy, bundleRoot), "utf-8")
      : null,
  };
}

export async function computeAssembly(
  app: pg.Pool,
  scope: Scope,
  slug: string,
  root = bundlesRoot(),
): Promise<BundleProfile> {
  // M4-装配：先纯磁盘读（事务外），再开 DB 事务做库侧校验
  const assets = loadBundleDiskAssets(join(root, slug), slug);

  // 每连接重设租户/工作区上下文（编码铁律：RLS 依赖 set_config）
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    // 租户覆盖层（L2）：L0 基座→L1 行业包→L2 租户覆盖层逐层合并（无覆盖层=零行为变化）
    await maybeApplyOverlay(client, scope, slug, assets);
    return await computeAssemblyScoped(client, scope, slug, assets);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

async function computeAssemblyScoped(
  client: pg.PoolClient,
  scope: Scope,
  slug: string,
  assets: BundleDiskAssets,
): Promise<BundleProfile> {
  const { bj, isDraft } = assets;
  // 当前工作区是否已激活本 profile（激活态才复核档案/阶段与工作区实物的一致性）
  const ws = await client.query<{ industry: string; stage: string | null }>(
    `SELECT industry, stage FROM workspaces WHERE id=$1`, [scope.workspaceId],
  );
  const isActive = ws.rows[0]?.industry === slug;

  /* ---------- 槽① 档案 Schema + 校验① 档案 forbidden ---------- */
  const archiveSchema = assets.archiveSchema;
  const prof = isActive
    ? await client.query<{ archive: Record<string, unknown> | null }>(
        `SELECT archive FROM profiles WHERE workspace_id=$1`, [scope.workspaceId])
    : { rows: [] as Array<{ archive: Record<string, unknown> | null }> };
  const archive = prof.rows[0]?.archive ?? null;
  const forbiddenCount = Array.isArray((archive as { forbidden?: unknown[] } | null)?.forbidden)
    ? ((archive as { forbidden: unknown[] }).forbidden.length)
    : 0;
  const fieldGroups = archiveSchema?.properties ? Object.keys(archiveSchema.properties).length : 0;
  const requiredMissing = isActive && archiveSchema?.required
    ? archiveSchema.required.filter((k) => !archive || !(k in archive))
    : [];
  const checkArchive: CheckItem = !archiveSchema
    ? { key: "archive", label: "档案 forbidden 校验", ok: false, slot: "archive",
        detail: "缺少 schemas/archive.schema.json", fix: "补齐档案 Schema（五要素之①档案，§2.3）" }
    : requiredMissing.length > 0
      ? { key: "archive", label: "档案 forbidden 校验", ok: false, slot: "archive",
          detail: `一店一档缺必填字段组：${requiredMissing.join("、")}`, fix: "回 P3 补齐一店一档必填字段组" }
      : forbiddenCount === 0 && isActive
        ? { key: "archive", label: "档案 forbidden 校验", ok: false, slot: "archive",
            detail: "档案 forbidden 硬约束为空（L1.6 至少 1 条）", fix: "回 P3 档案补 forbidden 硬约束" }
        : { key: "archive", label: "档案 forbidden 校验", ok: true, slot: "archive",
            detail: `一店一档 ${fieldGroups} 字段组 · forbidden 硬约束 ${isActive ? forbiddenCount : "激活时复核"} 条` };

  /* ---------- 槽② 枚举 + 校验② 枚举冲突检测 ---------- */
  const objectsJson = assets.objectsJson;
  const stagesJson = assets.stagesJson;
  const objTypes = (objectsJson?.objects ?? []).map((o) => o.type);
  const stageIds = (stagesJson?.stages ?? []).map((s) => s.id);
  const dupObj = objTypes.filter((t, i) => objTypes.indexOf(t) !== i);
  const dupStage = stageIds.filter((t, i) => stageIds.indexOf(t) !== i);
  const stageConflict = isActive && ws.rows[0]?.stage && !stageIds.includes(ws.rows[0].stage)
    ? [`当前经营阶段「${ws.rows[0].stage}」不在枚举内`]
    : [];
  const enumConflicts = [
    ...dupObj.map((t) => `对象枚举「${t}」重复定义`),
    ...dupStage.map((t) => `阶段枚举「${t}」重复定义`),
    ...stageConflict,
  ];
  const checkEnums: CheckItem = !objectsJson || !stagesJson
    ? { key: "enums", label: "枚举冲突检测", ok: false, slot: "enums",
        detail: "缺少 schemas/objects.json 或 schemas/stages.json", fix: "补齐对象与阶段枚举（五要素之②枚举）" }
    : enumConflicts.length > 0
      ? { key: "enums", label: "枚举冲突检测", ok: false, slot: "enums",
          detail: enumConflicts.join("；"), fix: "消除枚举冲突后重跑校验" }
      : { key: "enums", label: "枚举冲突检测", ok: true, slot: "enums",
          detail: `${objTypes.length} 对象 × 经营${stageIds.length}阶段，无冲突` };

  /* ---------- 槽③ 工具集 + 校验③ 工具探针健康 ---------- */
  const presets = assets.presets;
  const toolNames = [...new Set(presets.flatMap((p) => (p.tools ?? []).map((t) => t.name)))];
  const agentRows = presets.length > 0
    ? (await client.query<{
        id: string; preset_key: string; name: string; version: string;
        status: string; readonly: boolean; fence_bindings: string[];
      }>(
        `SELECT id, preset_key, name, version, status, readonly, fence_bindings
         FROM agents WHERE workspace_id=$1 AND preset_key = ANY($2::text[]) ORDER BY preset_key`,
        [scope.workspaceId, presets.map((p) => p.preset_key!)],
      )).rows
    : [];
  const probeFails: string[] = [];
  for (const p of presets) {
    const a = agentRows.find((r) => r.preset_key === p.preset_key);
    if (!a) probeFails.push(`「${p.name ?? p.preset_key}」未注册实例`);
    else if (a.status !== "ready") probeFails.push(`「${a.name} ${a.version}」状态 ${a.status}（invalid/disabled 不可装配 L3.7）`);
  }
  const checkTools: CheckItem = presets.length === 0
    ? { key: "tools", label: "工具探针健康", ok: false, slot: "tools",
        detail: "无 preset 可探针（presets/*.yml 缺失）", fix: "补齐 Agent preset（五要素之⑤班组）" }
    : probeFails.length > 0
      ? { key: "tools", label: "工具探针健康", ok: false, slot: "presets",
          detail: probeFails.join("；"), fix: "修复 preset 实例状态（→P8 船员名册）" }
      : { key: "tools", label: "工具探针健康", ok: true, slot: "tools",
          detail: `${presets.length} preset 探针全绿 · 工具 ${toolNames.length} 项` };

  /* ---------- 槽④ 围栏包 + 校验④ 围栏绑定完整 ---------- */
  const fenceFiles = assets.fenceFiles;
  const fencePacks = assets.fencePacks;
  const ruleCount = fencePacks.reduce((n, f) => n + (f.rules?.length ?? 0), 0);
  const baselineCount = fencePacks.reduce((n, f) => n + (f.rules?.filter((r) => r.is_baseline).length ?? 0), 0);
  // 每位班组成员：fence_bindings 非空且每条规则在围栏注册表 active（F2.10 未声明即禁写）
  const fenceRuleRows = agentRows.length > 0
    ? (await client.query<{ rule_id: string }>(
        `SELECT DISTINCT rule_id FROM fence_rules
         WHERE status='active' AND (workspace_id='*' OR workspace_id=$1)`,
        [scope.workspaceId],
      )).rows.map((r) => r.rule_id)
    : [];
  const activeRules = new Set(fenceRuleRows);
  const fenceFails: string[] = [];
  const agentsOut: BundleAgentRow[] = agentRows.map((a) => {
    let fenceOk = true;
    if (!a.readonly) {
      if (!a.fence_bindings || a.fence_bindings.length === 0) {
        fenceOk = false;
        fenceFails.push(`「${a.name} ${a.version}」未声明 fence_bindings → 系统级禁写（F2.10）`);
      } else {
        const missing = a.fence_bindings.filter((r) => !activeRules.has(r));
        if (missing.length > 0) {
          fenceOk = false;
          fenceFails.push(`「${a.name} ${a.version}」绑定规则 ${missing.join("/")} 非 active`);
        }
      }
    }
    return {
      id: a.id, presetKey: a.preset_key, name: a.name, version: a.version,
      status: a.status, readonly: a.readonly, fenceBindings: a.fence_bindings ?? [], fenceOk,
    };
  });
  const checkFences: CheckItem = fencePacks.length === 0
    ? { key: "fences", label: "围栏绑定完整", ok: false, slot: "fences",
        detail: "缺少 fences/*.yml 围栏包", fix: "补齐围栏包（五要素之④围栏）" }
    : fenceFails.length > 0
      ? { key: "fences", label: "围栏绑定完整", ok: false, slot: "presets",
          detail: fenceFails.join("；"), fix: "在 preset 中补齐围栏声明（F2.10）" }
      : { key: "fences", label: "围栏绑定完整", ok: true, slot: "fences",
          detail: `基线 ${baselineCount} 条 🔒 单调守卫 · ${agentsOut.filter((a) => !a.readonly).length} 员绑定全合法` };

  /* ---------- 槽⑥ 工作台 UI + 校验⑤ UI 用例同步 ---------- */
  const uiCases = assets.uiCases;
  const cases = uiCases?.cases ?? [];
  const casePages = [...new Set(cases.map((c) => c.page))];
  const unregistered = casePages.filter((p) => !(REGISTERED_PAGES as readonly string[]).includes(p));
  const checkUi: CheckItem = !uiCases
    ? { key: "ui", label: "UI 用例同步", ok: false, slot: "ui",
        detail: "缺少 ui/cases.json 状态用例清单", fix: "补齐工作台 UI 用例（五要素之⑥皮肤）" }
    : unregistered.length > 0
      ? { key: "ui", label: "UI 用例同步", ok: false, slot: "ui",
          detail: `用例引用未注册页面：${unregistered.join("、")}`, fix: "同步页面注册表或修正用例" }
      : { key: "ui", label: "UI 用例同步", ok: true, slot: "ui",
          detail: `${casePages.length} 页 · 状态用例 ${cases.length} 条同步` };

  /* ---------- 槽⑦ 模型路由策略（v3.0：非阻断——缺失用底座默认；存在但非法 → 标红拒绝激活） ---------- */
  let modelPolicyScenes = 0;
  let checkModelPolicy: CheckItem;
  if (assets.modelPolicyText === null) {
    checkModelPolicy = { key: "model_policy", label: "模型路由策略", ok: true, slot: "model-policy",
      detail: "未提供 model-policy.yml，使用底座默认路由策略（L2.6 行业可覆盖）" };
  } else {
    const parsed = parseModelPolicy(assets.modelPolicyText);
    if (parsed.policy) {
      modelPolicyScenes = Object.keys(parsed.policy.scenes).length;
      checkModelPolicy = { key: "model_policy", label: "模型路由策略", ok: true, slot: "model-policy",
        detail: `model-policy.yml 合法 · ${modelPolicyScenes} 场景（含底座继承）· 三档套餐映射` };
    } else {
      checkModelPolicy = { key: "model_policy", label: "模型路由策略", ok: false, slot: "model-policy",
        detail: `model-policy.yml 非法：${parsed.issues.join("；")}`, fix: "修正场景表（tier 须为 L1/L2/L3）后重跑校验" };
    }
  }

  const checks = [checkArchive, checkEnums, checkTools, checkFences, checkUi, checkModelPolicy];
  const failedSlots = new Set(checks.filter((c) => !c.ok).map((c) => c.slot));

  const slots: SlotState[] = [
    { id: "archive", label: "① 档案 Schema", filled: !!archiveSchema, failed: failedSlots.has("archive"),
      summary: checkArchive.detail },
    { id: "enums", label: "② 对象与阶段枚举", filled: !!objectsJson && !!stagesJson, failed: failedSlots.has("enums"),
      summary: objectsJson && stagesJson ? `${objTypes.length} 对象 × 经营${stageIds.length}阶段` : "待填充" },
    { id: "tools", label: "③ 工具集", filled: toolNames.length > 0, failed: false,
      summary: toolNames.length > 0 ? toolNames.slice(0, 5).join(" · ") + (toolNames.length > 5 ? ` 等 ${toolNames.length} 项` : "") : "待填充" },
    { id: "fences", label: "④ 围栏包 / 群规", filled: fencePacks.length > 0, failed: failedSlots.has("fences"),
      summary: fencePacks.length > 0 ? `${fenceFiles[0]} · 基线 ${baselineCount} 条 🔒 单调守卫` : "待填充", go: "p5" },
    { id: "presets", label: "⑤ Agent 班组 / 通讯录", filled: presets.length > 0 && agentRows.length > 0,
      failed: failedSlots.has("presets"),
      summary: presets.length > 0
        ? `${presets.length} preset · 围栏绑定校验 ${fenceFails.length > 0 ? `${fenceFails.length} 项失败` : "✓"}`
        : "待填充", go: "p8" },
    { id: "ui", label: "⑥ 工作台 UI / 皮肤", filled: !!uiCases, failed: failedSlots.has("ui"),
      summary: uiCases ? `${casePages.length} 页 · 状态用例 ${cases.length} 条同步` : "待填充" },
    { id: "model-policy", label: "⑦ 模型路由策略", filled: assets.modelPolicyText !== null,
      failed: failedSlots.has("model-policy"),
      summary: assets.modelPolicyText !== null
        ? (checkModelPolicy.ok ? `model-policy.yml · ${modelPolicyScenes} 场景` : checkModelPolicy.detail)
        : "底座默认（可经 model-policy.yml 覆盖）" },
  ];

  return {
    slug,
    name: bj.name ?? `@workloom/${slug}`,
    displayName: bj.workloom?.displayName ?? slug,
    version: bj.version ?? "0.0.0",
    description: bj.workloom?.description ?? "",
    status: isDraft ? "draft" : isActive ? "active" : "available",
    slots,
    filledCount: slots.filter((s) => s.filled).length,
    checks,
    canActivate: checks.every((c) => c.ok),
    agents: agentsOut,
    checkedAt: new Date().toISOString(),
  };
}

/* ================= 写路径（全部事件化 P7-⑤） ================= */

/** 激活/切换 profile（F2.10：五项校验任一失败拒绝激活，不静默 L9.2；留痕 bundle.activate） */
export async function activateBundle(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  slug: string,
  by: string,
  root = bundlesRoot(),
): Promise<{ eventId: string; profile: BundleProfile }> {
  const profile = await computeAssembly(app, scope, slug, root);
  if (!profile.canActivate) {
    const failed = profile.checks.filter((c) => !c.ok);
    throw new BundleError(
      "ASSEMBLY_CHECK_FAILED",
      `装配校验未通过，已拒绝激活（F2.10）：${failed.map((c) => c.label).join("、")}`,
      profile.checks,
    );
  }
  const client = await app.connect();
  let actEventId = "";
  let prevIndustry: string | null = null;
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    // M4-装配：先记激活前 industry（磁盘翻转失败时补偿回滚的还原点）
    const cur = await client.query<{ industry: string | null }>(
      `SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
    prevIndustry = cur.rows[0]?.industry ?? null;
    await client.query(`UPDATE workspaces SET industry=$2 WHERE id=$1`, [scope.workspaceId, slug]);
    // D16（#1/A）：profile 切换与激活事件同一事务同一 COMMIT
    actEventId = (await gatewayAppendOnClient(client, {
      tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      actor: { id: by, type: "human" },
    }, {
      who: { type: "human", id: by },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "bundle", id: slug },
      decision: {
        action: "bundle.activate",
        after: { slug, version: profile.version, checks: profile.checks.map((c) => ({ key: c.key, ok: c.ok })) },
        basis: ["F2.10 起飞前检查单五项全通过", "§2.3 profile 切换=整套皮肤+通讯录+群规生效"],
      },
      rule_impact: [],
    })).eventId;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
  // 草稿激活即转正（§2.3：草稿不进分发；通过检查单激活后脱离草稿态，bundle.json 实物同步）
  //
  // M4-装配 · DB/磁盘非原子收口口径：DB 翻转已在上面事务内完成；磁盘 bundle.json
  // status 翻转放在事务提交之后。磁盘写失败时**补偿回滚 DB**（industry 恢复激活前
  // 原值 + 追加 bundle.activate_compensated 补偿事件；append-only 铁律下原激活事件
  // 不删，以补偿事件收口）——选补偿回滚而非仅告警：草稿态 bundle.json 滞留会误导
  // 后续分发判定（§2.3 草稿不进分发），半激活中间态比显式失败更危险。
  if (profile.status === "draft") {
    const bjPath = join(root, slug, "bundle.json");
    try {
      const bj = readJson<BundleJson>(bjPath);
      if (bj?.workloom) {
        // “已激活”属于工作区安装台账；行业包从草稿晋级候选，仍需考试、
        // 灰度与发布签名后才能成为稳定制品。
        bj.workloom.status = "candidate";
        bj.integrity = sealBundleWithoutSignature(slug, bj, root);
        writeFileSync(bjPath, `${JSON.stringify(bj, null, 2)}\n`, "utf-8");
      }
    } catch (diskErr) {
      try {
        const c2 = await app.connect();
        try {
          await c2.query("BEGIN");
          await c2.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
          await c2.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
          await c2.query(`UPDATE workspaces SET industry=$2 WHERE id=$1`, [scope.workspaceId, prevIndustry]);
          await gatewayAppendOnClient(c2, {
            tenantId: scope.tenantId, workspaceId: scope.workspaceId,
            actor: { id: by, type: "human" },
          }, {
            who: { type: "human", id: by },
            context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
            object: { type: "bundle", id: slug },
            decision: {
              action: "bundle.activate_compensated",
              after: { slug, restoredIndustry: prevIndustry, diskError: String(diskErr instanceof Error ? diskErr.message : diskErr) },
              basis: ["磁盘 bundle.json 翻转失败 → 补偿回滚 DB 激活态（M4-装配 非原子收口）"],
            },
            rule_impact: [],
            links: [actEventId],
          });
          await c2.query("COMMIT");
        } catch (compErr) {
          await c2.query("ROLLBACK").catch(() => undefined);
          console.error(`❌ 激活补偿回滚失败（需人工介入）：${compErr instanceof Error ? compErr.message : compErr}`);
        } finally {
          c2.release();
        }
      } finally {
        // 无论补偿成败，激活整体按失败抛出（调用方视为未激活）
      }
      throw new BundleError(
        "ASSEMBLY_CHECK_FAILED",
        `行业 Bundle「${slug}」磁盘 bundle.json 翻转失败，DB 激活已补偿回滚：${diskErr instanceof Error ? diskErr.message : diskErr}`,
      );
    }
  }
  // D24 第⑧装配槽（反馈枚举表）：激活成功后即时注册到本工作区——
  // decide 驳回原因自此按受控词表校验（未提供第⑧槽的 Bundle 注销旧表，按未装配放行）。
  // 磁盘读取失败不阻断激活（激活主流程已收口；枚举缺失仅影响校验严格度，下次启动 bootstrap 兜底）。
  try {
    const defs = loadFeedbackEnumsFromBundle(join(root, slug));
    if (defs && defs.length > 0) {
      registerFeedbackEnums(scope.workspaceId, defs);
    } else {
      unregisterFeedbackEnums(scope.workspaceId);
    }
  } catch (enumErr) {
    console.warn(`第⑧槽反馈枚举表注册失败（不阻断激活）：${enumErr instanceof Error ? enumErr.message : enumErr}`);
  }
  return { eventId: actEventId, profile: { ...profile, status: "active" } };
}

/** 重跑校验并留痕（P7E3：校验记录留痕可查；数据活算，重算即重跑） */
export async function recheckBundle(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  slug: string,
  by: string,
  root = bundlesRoot(),
): Promise<{ eventId: string; profile: BundleProfile }> {
  const profile = await computeAssembly(app, scope, slug, root);
  const r = await gatewayAppend(gateway, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: by, type: "human" },
  }, {
    who: { type: "human", id: by },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "bundle", id: slug },
    decision: {
      action: "bundle.check_run",
      after: {
        canActivate: profile.canActivate,
        results: profile.checks.map((c) => ({ key: c.key, ok: c.ok, detail: c.detail })),
      },
      basis: ["P7E3 装配校验记录留痕"],
    },
    rule_impact: [],
  });
  return { eventId: r.eventId, profile };
}

/** 新建行业 Bundle 五要素向导（P7E5/§2.3）：产出草稿骨架，草稿不进分发 */
export interface DraftInput {
  slug: string;
  displayName: string;
  version: string;
  changelog: string;
  fenceRef: string;
  ownerMemberNo: string;
}

export function scaffoldDraft(input: DraftInput, root = bundlesRoot()): void {
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(input.slug)) {
    throw new BundleError("INVALID_INPUT", "行业标识须为小写字母/数字/连字符（2–32 位）");
  }
  const dir = join(root, input.slug);
  if (existsSync(dir)) throw new BundleError("ALREADY_EXISTS", `行业 Bundle「${input.slug}」已存在`);
  for (const sub of ["schemas", "presets", "fences", "skills", "ui"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  writeFileSync(join(dir, "bundle.json"), `${JSON.stringify({
    schemaVersion: "workloom.bundle/v1",
    name: `@workloom/${input.slug}`,
    version: input.version,
    workloom: {
      industry: input.slug,
      displayName: input.displayName,
      description: input.changelog,
      status: "draft", // §2.3：草稿态不进入分发
      owner: input.ownerMemberNo,
      example: false,
      fenceRef: input.fenceRef,
      compatibility: {
        base: `>=${RUNTIME_BASE_VERSION} <1.0.0`,
        ui: `>=${RUNTIME_UI_VERSION} <1.0.0`,
        contract: INDUSTRY_CONTRACT_VERSION,
      },
      provides: {
        presets: [], fences: [], skills: [], schemas: [], ui: [], serviceFront: [], seeds: [],
        modelPolicy: "model-policy.yml",
      },
      ui: {
        schemaVersion: "workloom.bundle.ui/v1",
        terminology: {},
        navigation: { slots: [] },
        home: { widgets: [] },
        objects: [],
        workflows: [],
        serviceFront: { enabled: false, identityPolicy: "disabled", tabs: [], services: [] },
        theme: { brand: {} },
        permissions: [],
        experiments: [],
      },
    },
  }, null, 2)}\n`, "utf-8");
  // 第⑦槽骨架：新行业默认继承底座路由策略，按行业特点增量覆盖场景即可
  writeFileSync(join(dir, "model-policy.yml"), [
    `# ${input.displayName} 模型路由策略（bundle 第⑦装配槽，v3.0）`,
    `# 场景未点名时继承底座 DEFAULT_MODEL_POLICY；tier: L1(0.2×)/L2(1×)/L3(3×)`,
    `version: "v3.0"`,
    `scenes:`,
    `  # 示例：`,
    `  # cs-answer: { tier: L1, escalateOn: [low-confidence, thumbs-down] }`,
    `  # deep-report: { tier: L3, noDowngrade: true }`,
    `plans:`,
    `  lite:     { defaultShift: -1 }   # 智享版：整体压一档`,
    `  standard: { defaultShift: 0 }    # 标准版：标准混合`,
    `  smart:    { defaultShift: 1 }    # 智能版：整体抬一档`,
    ``,
  ].join("\n"), "utf-8");
}

export function removeDraft(slug: string, root = bundlesRoot()): void {
  const dir = join(root, slug);
  const bj = readJson<BundleJson>(join(dir, "bundle.json"));
  if (bj?.workloom?.status !== "draft") {
    throw new BundleError("INVALID_INPUT", "仅草稿态 Bundle 可移除（已分发/已激活 profile 受 §2.3 保护）");
  }
  rmSync(dir, { recursive: true, force: true });
}

export async function createBundleDraft(
  gateway: pg.Pool,
  scope: Scope,
  input: DraftInput,
  by: string,
  root = bundlesRoot(),
): Promise<{ eventId: string; slug: string }> {
  scaffoldDraft(input, root);
  const r = await gatewayAppend(gateway, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: by, type: "human" },
  }, {
    who: { type: "human", id: by },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "bundle", id: input.slug },
    decision: {
      action: "bundle.draft_created",
      after: {
        slug: input.slug, displayName: input.displayName, version: input.version,
        changelog: input.changelog, fenceRef: input.fenceRef, owner: input.ownerMemberNo,
      },
      basis: ["P7E5 五要素向导", "§2.3 草稿态不进入分发"],
    },
    rule_impact: [],
  });
  return { eventId: r.eventId, slug: input.slug };
}
