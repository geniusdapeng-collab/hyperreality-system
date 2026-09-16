import { z } from "zod";

export const BUNDLE_SCHEMA_VERSION = "workloom.bundle/v1" as const;
export const BUNDLE_UI_SCHEMA_VERSION = "workloom.bundle.ui/v1" as const;
export const INDUSTRY_CONTRACT_VERSION = "2.0.0" as const;

const Semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "必须是精确语义版本");
const CapabilityId = z.string().regex(/^[a-z][a-z0-9.-]{1,79}$/, "能力标识格式不正确");
const Route = z.string().regex(/^\/[a-z0-9][a-z0-9/-]*$/, "路由必须是语义化绝对路径");

/**
 * 基座页面、身份流程与诊断入口的受保护首段。行业 Bundle 与本地扩展共用这一份
 * 事实源，避免服务端接受了客户端必然拒绝（或反过来）的路由漂移。
 */
export const WORKLOOM_RESERVED_ROUTE_ROOTS = [
  "inbox", "tasks", "approvals", "reports", "service", "executive",
  "guardrails", "events", "event-ledger", "exams", "memory", "night",
  "models", "model-routing", "skills", "workspaces", "customize",
  "configuration", "assembly", "agents", "members", "partners", "account",
  "login", "activate", "invite", "onboarding", "dev",
  "p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9",
  "p21", "p22", "p23", "p24", "p26", "p27", "p28", "p29", "p30", "p31",
] as const;

/** Bundle 可引用的共享导航视觉契约；新增值必须先进入基座组件库。 */
export const WORKLOOM_NAVIGATION_GROUPS = [
  "today", "collaboration", "operations", "trust", "automation", "organization", "mine",
] as const;

export const WORKLOOM_BUNDLE_NAVIGATION_ICONS = [
  "home", "tasks", "report", "service", "approval", "ledger", "rules", "exam", "memory", "night",
  "model", "skills", "team", "workspace", "inbox", "account", "partner", "more", "executive", "customize",
  "configuration", "assembly", "agents", "developer", "menu", "close", "reset", "search", "notice", "chevron",
  "chat", "ticket", "star", "history", "warning", "check", "error", "edit", "lock", "pin", "book", "phone",
  "play", "copy", "like", "dislike", "gift", "cart", "radar", "send", "package", "experiment", "lightning",
  "medal", "rocket", "puzzle", "folder", "palette", "celebrate", "question", "brake", "circle", "document",
] as const;

export const WORKLOOM_BUNDLE_HOME_COMPONENTS = ["QuickTaskList"] as const;

const WORKLOOM_RESERVED_ROUTE_ROOT_SET = new Set<string>(WORKLOOM_RESERVED_ROUTE_ROOTS);

export function isWorkLoomReservedRoute(route: string): boolean {
  if (route === "/") return true;
  const root = route.split("/")[1];
  return Boolean(root && WORKLOOM_RESERVED_ROUTE_ROOT_SET.has(root));
}

const BundleAssetPath = z.string().min(1).max(300)
  .refine((value) => !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
  "资产路径必须是行业包内的规范相对路径");
const Sha256Digest = z.string().regex(/^[a-f0-9]{64}$/);
const RawClientField = /\b(?:[a-z][a-z0-9]*_[a-z0-9_]+|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)\b/;
const ChineseDisplayText = (max: number) => z.string().min(1).max(max)
  .refine((value) => /\p{Script=Han}/u.test(value), "面向用户的文案必须包含中文，不得直接释放代码字段")
  .refine((value) => !RawClientField.test(value), "面向用户的文案不得混入底层 snake_case 或 camelCase 字段");

const WorkforceCode = z.string().trim().regex(
  /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/,
  "必须使用小写英文、数字、连字符、下划线或点组成的受控标识",
);
const WorkforceEventPrefix = z.string().trim().regex(
  /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*\.$/,
  "必须是以点结尾的受控事件前缀",
);

/**
 * 岗位覆盖声明兼容历史 event_prefix 输入，但解析结果统一输出 eventPrefix。
 * 兼容只存在于契约边界；运行时不再分别猜测两套字段。
 */
export const WorkforceCoverageSchema = z.object({
  eventPrefix: WorkforceEventPrefix.optional(),
  event_prefix: WorkforceEventPrefix.optional(),
  label: ChineseDisplayText(80),
}).strict().superRefine((value, context) => {
  if ((value.eventPrefix ? 1 : 0) + (value.event_prefix ? 1 : 0) !== 1) {
    context.addIssue({
      code: "custom",
      path: ["eventPrefix"],
      message: "必须且只能声明一个事件前缀",
    });
  }
}).transform((value) => ({
  eventPrefix: value.eventPrefix ?? value.event_prefix!,
  label: value.label,
}));

export const WorkforceToolSchema = z.object({
  name: WorkforceCode,
  access: z.enum(["read", "write"]),
  desc: ChineseDisplayText(160),
}).strict();

/**
 * 行业 Bundle 的数字员工岗位契约。
 *
 * 核心治理字段必须显式存在；额外行业元数据允许透传，以便行业包扩展而不复制
 * 基座 Schema。写岗位必须同时具备事件覆盖、围栏和写工具；只读岗位不得伪装
 * 写工具。night_shift 不设默认值，避免缺字段时被运行时静默猜测。
 */
export const WorkforcePresetSchema = z.object({
  preset_key: z.string().trim().regex(/^[a-z][a-z0-9-]{1,79}$/, "岗位标识格式不正确"),
  name: ChineseDisplayText(80),
  version: z.string().trim().regex(/^v\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/, "岗位版本格式不正确"),
  kind: z.string().trim().regex(/^[a-z][a-z0-9-]{1,39}$/, "岗位类型格式不正确"),
  description: ChineseDisplayText(1000),
  readonly: z.boolean(),
  night_shift: z.boolean(),
  high_risk: z.boolean(),
  fence_bindings: z.array(z.string().trim().min(1).max(80)).max(100),
  coverage: z.array(WorkforceCoverageSchema).max(100),
  skills: z.array(WorkforceCode).max(200),
  tools: z.array(WorkforceToolSchema).max(200),
  prompt: z.record(z.string(), z.unknown()),
  write_back: z.array(WorkforceCode).max(200).default([]),
}).passthrough().superRefine((preset, context) => {
  const writeTools = preset.tools.filter((tool) => tool.access === "write");
  if (preset.readonly && writeTools.length > 0) {
    context.addIssue({ code: "custom", path: ["tools"], message: "只读岗位不得声明写工具" });
  }
  if (!preset.readonly && preset.fence_bindings.length === 0) {
    context.addIssue({ code: "custom", path: ["fence_bindings"], message: "可写岗位必须绑定围栏" });
  }
  if (!preset.readonly && writeTools.length === 0) {
    context.addIssue({ code: "custom", path: ["tools"], message: "可写岗位必须声明至少一个写工具" });
  }
  if (!preset.readonly && preset.coverage.length === 0) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "可写岗位必须声明至少一个事件覆盖" });
  }
});

/** 同一 Bundle 内岗位标识与事件域只能有一个责任人。 */
export const WorkforcePresetCollectionSchema = z.array(WorkforcePresetSchema).max(500)
  .superRefine((presets, context) => {
    const keys = new Map<string, number>();
    const eventPrefixes = new Map<string, string>();
    for (const [index, preset] of presets.entries()) {
      const previousKey = keys.get(preset.preset_key);
      if (previousKey !== undefined) {
        context.addIssue({
          code: "custom",
          path: [index, "preset_key"],
          message: `岗位标识与第 ${previousKey + 1} 个岗位重复`,
        });
      } else {
        keys.set(preset.preset_key, index);
      }
      for (const [coverageIndex, coverage] of preset.coverage.entries()) {
        const previous = eventPrefixes.get(coverage.eventPrefix);
        if (previous) {
          context.addIssue({
            code: "custom",
            path: [index, "coverage", coverageIndex, "eventPrefix"],
            message: `事件前缀 ${coverage.eventPrefix} 已由岗位 ${previous} 认领`,
          });
        } else {
          eventPrefixes.set(coverage.eventPrefix, preset.preset_key);
        }
      }
    }
  });

export type WorkforceCoverage = z.infer<typeof WorkforceCoverageSchema>;
export type WorkforceTool = z.infer<typeof WorkforceToolSchema>;
export type WorkforcePreset = z.infer<typeof WorkforcePresetSchema>;

export function parseWorkforcePreset(input: unknown): WorkforcePreset {
  return WorkforcePresetSchema.parse(input);
}

export function parseWorkforcePresets(input: unknown): WorkforcePreset[] {
  return WorkforcePresetCollectionSchema.parse(input);
}

export const BrandThemeSchema = z.object({
  primary: z.string().min(1).max(64).optional(),
  onPrimary: z.string().min(1).max(64).optional(),
  accent: z.string().min(1).max(64).optional(),
  logo: z.string().min(1).max(300).optional(),
  illustration: z.string().min(1).max(300).optional(),
}).strict();

export const BundleUiSchema = z.object({
  schemaVersion: z.literal(BUNDLE_UI_SCHEMA_VERSION),
  terminology: z.record(z.string(), ChineseDisplayText(80)).default({}),
  navigation: z.object({
    slots: z.array(z.object({
      capabilityId: CapabilityId,
      title: ChineseDisplayText(30),
      route: Route,
      group: z.enum(WORKLOOM_NAVIGATION_GROUPS),
      icon: z.enum(WORKLOOM_BUNDLE_NAVIGATION_ICONS),
      clients: z.array(z.enum(["pc", "b-mobile", "c-mobile"])).min(1),
      permissions: z.array(CapabilityId).default([]),
    }).strict()).max(80).default([]),
  }).strict(),
  home: z.object({
    widgets: z.array(z.object({
      slot: z.string().min(1).max(60),
      component: z.string().min(1).max(80),
      clients: z.array(z.enum(["pc", "b-mobile", "c-mobile"])).min(1),
      props: z.record(z.string(), z.unknown()).default({}),
    }).strict()).max(80).default([]),
  }).strict(),
  /**
   * 首次运行时的行业介绍只允许由 Bundle 投影提供。基座负责仪式、节奏与通用
   * 说明，不得根据行业标识内置文案分支。
   */
  welcome: z.object({
    system: z.array(ChineseDisplayText(240)).min(1).max(12),
    keywords: z.array(ChineseDisplayText(24)).min(1).max(6),
  }).strict().optional(),
  objects: z.array(ChineseDisplayText(80)).max(100).default([]),
  workflows: z.array(ChineseDisplayText(80)).max(100).default([]),
  serviceFront: z.object({
    enabled: z.boolean(),
    identityPolicy: z.enum(["oauth", "phone", "order-proof", "disabled"]),
    /**
     * 可选的服务前台业务适配器标识。只有经过 Bundle 完整性校验的投影
     * 才能把该标识交给服务端注册表；未声明时基座仅开放通用对话与工单。
     */
    adapterId: CapabilityId.optional(),
    tabs: z.array(ChineseDisplayText(30)).max(8).default([]),
    services: z.array(ChineseDisplayText(80)).max(80).default([]),
  }).strict(),
  /**
   * 行业巡检实现必须由 Bundle 显式选择；基座没有默认适配器。enabled=false
   * 表示该行业不启用巡检，enabled=true 时必须给出经服务端注册表审核的标识。
   */
  inspection: z.discriminatedUnion("enabled", [
    z.object({ enabled: z.literal(false) }).strict(),
    z.object({ enabled: z.literal(true), adapterId: CapabilityId }).strict(),
  ]).optional(),
  theme: z.object({ brand: BrandThemeSchema }).strict(),
  permissions: z.array(CapabilityId).max(100).default([]),
  experiments: z.array(z.object({
    id: CapabilityId,
    flag: z.string().min(1).max(100),
    killSwitch: z.string().min(1).max(100),
    fallback: z.string().min(1).max(120),
  }).strict()).max(30).default([]),
}).strict();

const ProvidesSchema = z.object({
  presets: z.array(BundleAssetPath).default([]),
  fences: z.array(BundleAssetPath).default([]),
  skills: z.array(BundleAssetPath).default([]),
  schemas: z.array(BundleAssetPath).default([]),
  ui: z.array(BundleAssetPath).default([]),
  pipelines: z.array(BundleAssetPath).default([]),
  library: z.array(BundleAssetPath).default([]),
  segmentDefaults: z.array(BundleAssetPath).default([]),
  connectors: z.array(BundleAssetPath).default([]),
  floorScene: BundleAssetPath.optional(),
  modelPolicy: BundleAssetPath.optional(),
  feedbackEnums: BundleAssetPath.optional(),
  serviceFront: z.array(BundleAssetPath).default([]),
  evalQuestions: BundleAssetPath.optional(),
  seeds: z.array(BundleAssetPath).default([]),
}).strict();

/**
 * 组合产品只在“主 Bundle”清单中声明精确版本依赖。主 Bundle 仍由工作区唯一的
 * active 装配确定；依赖不是第二个活动安装，也不能用范围版本在运行时漂移。
 */
export const BundleDependencySchema = z.object({
  bundleId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/),
  version: Semver,
}).strict();

export const BundleManifestSchema = z.object({
  schemaVersion: z.literal(BUNDLE_SCHEMA_VERSION),
  name: z.string().regex(/^@workloom\/[a-z0-9][a-z0-9-]*$/),
  version: Semver,
  workloom: z.object({
    industry: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/),
    displayName: ChineseDisplayText(100),
    description: ChineseDisplayText(1000),
    status: z.enum(["draft", "candidate", "stable", "retired"]),
    owner: z.string().min(1).max(100),
    example: z.boolean().default(false),
    fenceRef: z.string().min(1).max(160).optional(),
    compatibility: z.object({
      base: z.string().min(1).max(80),
      ui: z.string().min(1).max(80),
      contract: z.literal(INDUSTRY_CONTRACT_VERSION),
    }).strict(),
    dependencies: z.array(BundleDependencySchema).max(16).optional(),
    provides: ProvidesSchema,
    ui: BundleUiSchema,
  }).strict(),
  integrity: z.object({
    algorithm: z.literal("sha256"),
    digest: Sha256Digest,
    /**
     * 每个 provides 资产的内容摘要。稳定制品的签名同时覆盖该索引，
     * 因而修改 YAML/JSON/技能文档等任一资产都会使装载失败。
     */
    assets: z.record(BundleAssetPath, Sha256Digest).default({}),
    signature: z.object({
      algorithm: z.literal("ed25519"),
      keyId: z.string().min(1).max(100),
      value: z.string().min(80).max(120).regex(/^[A-Za-z0-9+/]+={0,2}$/, "签名必须是规范 Base64"),
    }).strict().optional(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.name !== `@workloom/${value.workloom.industry}`) {
    context.addIssue({ code: "custom", path: ["name"], message: "包名必须与行业标识一致" });
  }
  const seenCapabilities = new Set<string>();
  const seenRoutes = new Set<string>();
  const seenDependencies = new Set<string>();
  const permissionNamespace = `${value.workloom.industry}.`;
  const declaredPermissions = new Set(value.workloom.ui.permissions);
  for (const [index, permission] of value.workloom.ui.permissions.entries()) {
    if (!permission.startsWith(permissionNamespace)) {
      context.addIssue({ code: "custom", path: ["workloom", "ui", "permissions", index], message: "行业权限必须属于自身命名空间" });
    }
  }
  for (const [index, dependency] of (value.workloom.dependencies ?? []).entries()) {
    if (dependency.bundleId === value.workloom.industry) {
      context.addIssue({ code: "custom", path: ["workloom", "dependencies", index, "bundleId"], message: "行业包不能依赖自身" });
    }
    if (seenDependencies.has(dependency.bundleId)) {
      context.addIssue({ code: "custom", path: ["workloom", "dependencies", index, "bundleId"], message: "组合依赖重复" });
    }
    seenDependencies.add(dependency.bundleId);
  }
  for (const [index, item] of value.workloom.ui.navigation.slots.entries()) {
    if (!item.capabilityId.startsWith(permissionNamespace)) {
      context.addIssue({ code: "custom", path: ["workloom", "ui", "navigation", "slots", index, "capabilityId"], message: "行业导航能力必须属于自身命名空间" });
    }
    if (isWorkLoomReservedRoute(item.route) || /^\/p\d+(?:\/|$)/.test(item.route)) {
      context.addIssue({ code: "custom", path: ["workloom", "ui", "navigation", "slots", index, "route"], message: "行业导航不得覆盖基座路由" });
    }
    for (const [permissionIndex, permission] of item.permissions.entries()) {
      if (!permission.startsWith(permissionNamespace) || !declaredPermissions.has(permission)) {
        context.addIssue({
          code: "custom",
          path: ["workloom", "ui", "navigation", "slots", index, "permissions", permissionIndex],
          message: "行业导航权限必须属于自身命名空间并在权限清单中声明",
        });
      }
    }
    if (seenCapabilities.has(item.capabilityId)) {
      context.addIssue({ code: "custom", path: ["workloom", "ui", "navigation", "slots", index, "capabilityId"], message: "能力标识重复" });
    }
    if (seenRoutes.has(item.route)) {
      context.addIssue({ code: "custom", path: ["workloom", "ui", "navigation", "slots", index, "route"], message: "语义路由重复" });
    }
    seenCapabilities.add(item.capabilityId);
    seenRoutes.add(item.route);
  }
});

export type BundleManifest = z.infer<typeof BundleManifestSchema>;
export type BundleUi = z.infer<typeof BundleUiSchema>;

export function parseBundleManifest(input: unknown): BundleManifest {
  return BundleManifestSchema.parse(input);
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, ordered(child)]));
  }
  return value;
}

/** 清单规范形；integrity 自身不参与，避免摘要自引用。 */
export function canonicalBundlePayload(input: BundleManifest | Record<string, unknown>): string {
  const { integrity: _integrity, ...payload } = input as Record<string, unknown>;
  return JSON.stringify(ordered(payload));
}

/**
 * 发布制品规范形：清单本体 + 已排序的逐资产摘要索引。最终 digest/Ed25519 签名
 * 覆盖这两部分，运行时再把索引与磁盘真实内容逐文件比对。
 */
export function canonicalBundleArtifactPayload(
  input: BundleManifest | Record<string, unknown>,
  assets?: Record<string, string>,
): string {
  const embedded = (input as { integrity?: { assets?: Record<string, string> } }).integrity?.assets;
  return `${canonicalBundlePayload(input)}\n${JSON.stringify(ordered(assets ?? embedded ?? {}))}`;
}

export function formatContractError(error: unknown): string[] {
  if (!(error instanceof z.ZodError)) return [error instanceof Error ? error.message : String(error)];
  return error.issues.map((issue) => `${issue.path.join(".") || "根节点"}：${issue.message}`);
}

function numericVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** 支持发布契约采用的空格分隔比较式，例如 >=0.1.0 <1.0.0。 */
export function satisfiesCompatibility(version: string, range: string): boolean {
  const actual = numericVersion(version);
  if (!actual) return false;
  return range.trim().split(/\s+/).every((part) => {
    const match = /^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+)$/.exec(part);
    if (!match) return false;
    const target = numericVersion(match[2]!);
    if (!target) return false;
    const result = compare(actual, target);
    switch (match[1] ?? "=") {
      case ">=": return result >= 0;
      case "<=": return result <= 0;
      case ">": return result > 0;
      case "<": return result < 0;
      case "^": return actual[0] === target[0] && result >= 0;
      case "~": return actual[0] === target[0] && actual[1] === target[1] && result >= 0;
      default: return result === 0;
    }
  });
}

export function assertBundleCompatibility(manifest: BundleManifest, versions: { base: string; ui: string }): void {
  const failures = [
    !satisfiesCompatibility(versions.base, manifest.workloom.compatibility.base) ? `基座 ${versions.base} 不满足 ${manifest.workloom.compatibility.base}` : "",
    !satisfiesCompatibility(versions.ui, manifest.workloom.compatibility.ui) ? `共享界面 ${versions.ui} 不满足 ${manifest.workloom.compatibility.ui}` : "",
  ].filter(Boolean);
  if (failures.length) throw new Error(`行业包兼容性校验失败：${failures.join("；")}`);
}
