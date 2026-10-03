/**
 * profile.mjs · 真机验收 profile 加载与校验（RDAS v1）
 *
 * 事实源：本仓 `acceptance/profile.json`（行业语义：角色/旅程/路由/阈值/启动命令）。
 * 基座只提供默认值与**阈值下限**：行业可以把要求调严，不能悄悄放宽（放宽必须写进报告并说明）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_ENVIRONMENT, ENVIRONMENT_KINDS, resolveEnvironment } from "./target.mjs";
import { LIVE_BUDGET_CAPS, normalizeBudgets } from "./live/budget.mjs";

export const PROFILE_SCHEMA = "workloom.acceptance-profile/v2";
export const LEGACY_PROFILE_SCHEMAS = ["workloom.acceptance-profile/v1"];

/**
 * 阈值下限（行业 profile 的取值不得比这里更宽松）。
 * 方向：
 *  - max：越小越严（时间/次数/比率上限）；
 *  - min：越大越严（成功率/量表/目标值）；
 *  - clamp：低于下限时直接抬到下限（AA 对比度这类硬标准）。
 */
export const THRESHOLD_FLOORS = {
  firstValueMs: { value: 20000, dir: "max" },
  dispatchMs: { value: 60000, dir: "max" },
  approvalMs: { value: 30000, dir: "max" },
  traceClicks: { value: 2, dir: "max" },
  guestFirstReplyMs: { value: 30000, dir: "max" },
  decisionQuota: { value: 7, dir: "max" },
  minContrastRatio: { value: 4.5, dir: "clamp" },
  idleInterruptionWindowS: { value: 20, dir: "max" },
  // v3：体验域
  taskSuccessP0: { value: 1.0, dir: "min" },
  taskSuccessP1: { value: 0.9, dir: "min" },
  susMin: { value: 68, dir: "min" },
  susTarget: { value: 80, dir: "min" },
  seqMin: { value: 5.5, dir: "min" },
  csatMin: { value: 4.2, dir: "min" },
  targetSizePx: { value: 24, dir: "min" },
  zoomPercent: { value: 200, dir: "min" },
  axCritical: { value: 0, dir: "max" },
  // v3：交付域 / ADR-HIR
  adr1Target: { value: 0.85, dir: "min" },
  hirNiMax: { value: 0.10, dir: "max" },
  h34Max: { value: 0.03, dir: "max" },
  hmpoMax: { value: 0.5, dir: "max" },
  passK: { value: 5, dir: "min" },
  p0PassKTarget: { value: 0.8, dir: "min" },
  offlineAuditSample: { value: 10, dir: "min" },
  soakHours: { value: 24, dir: "min" },
};

export const THRESHOLD_DEFAULTS = Object.fromEntries(Object.entries(THRESHOLD_FLOORS).map(([k, v]) => [k, v.value]));

export const DEFAULT_BUILTIN_JOURNEYS = [
  { id: "EXP-01", persona: "owner", title: "首启看到价值与待拍板", script: "builtin:first-value" },
  { id: "EXP-02", persona: "owner", title: "审批三手势写回", script: "builtin:approval" },
  { id: "EXP-03", persona: "owner", title: "一键溯源", script: "builtin:traceability" },
  { id: "EXP-04", persona: "owner", title: "紧急制动确认与撤回", script: "builtin:brake" },
  { id: "EXP-05", persona: "manager", title: "派活并看拆解", script: "builtin:dispatch" },
  { id: "EXP-06", persona: "manager", title: "统一待办聚合", script: "builtin:inbox" },
  { id: "EXP-07", persona: "staff", title: "移动端接活（390px）", script: "builtin:mobile-staff" },
  { id: "EXP-08", persona: "partner", title: "伙伴授权边界可见", script: "builtin:partner-scope" },
  { id: "EXP-09", persona: "guest", title: "C 端首响与转人工", script: "builtin:guest-service" },
  { id: "EXP-10", persona: "owner", title: "围栏 dry-run", script: "builtin:dry-run" },
];

/** 页面路径默认值（行业仓可覆盖：某些仓把入口改名/合并） */
export const DEFAULT_ROUTES = {
  home: "/",
  tasks: "/tasks",
  approvals: "/approvals",
  reports: "/reports",
  events: "/events",
  guardrails: "/guardrails",
  skills: "/skills",
  agents: "/agents",
  inbox: "/inbox",
  partners: "/partners",
  portfolio: "/portfolio",
  service: "/service",
};

/** v3 默认的 U/O/ADR 配置骨架；行业仓可在 profile 里覆盖。 */
export const DEFAULT_UX = {
  personas: [],
  journeys: [],
  tasks: [],
  research: { participants: [], methods: ["think-aloud", "first-click", "five-second"], instruments: ["SUS", "SEQ"] },
};
export const DEFAULT_OUTCOME = { roles: [], taskSuites: [], receipts: [] };
export const DEFAULT_AUTONOMY = {
  interventionTaxonomy: "H0-H4",
  fixtureFilters: ["suite.", "suite-", "apr-suite-", "apr-e-", "T-suite"],
  windows: ["4w"],
  targetPrecisionPp: 10,
  offlineAuditSample: 10,
};
export const DEFAULT_SOAK = { hours: [24, 168, 672], metrics: ["success", "latency", "cost", "drift"] };

/**
 * v3.1：生产实测默认骨架（P 域）。
 * `enabled: false` 表示本仓尚未声明真实模型任务——验收器会写「未验证」，不会伪造通过。
 * 模型清单与任务矩阵由各仓按自己的行业语义填写（基座只给内置三模型与硬上限）。
 */
export const DEFAULT_LIVE = {
  enabled: false,
  requireRealModels: false,
  allowDb: false,
  budgets: { ...LIVE_BUDGET_CAPS },
  models: [],
  tasks: [],
  notes: "",
};

export const LIVE_BUDGET_FLOORS = LIVE_BUDGET_CAPS;

export function findRepoRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "product.manifest.json")) || existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}

/** Tiger keeps its application assets in governance while exposing root CLI wrappers. */
export function bundleDirOf(repoRoot, primaryBundle) {
  if (typeof primaryBundle !== 'string' || !/^[A-Za-z0-9_-]+$/.test(primaryBundle)) throw new Error('primaryBundle 必须是本仓安全目录标识');
  const direct = join(repoRoot, 'bundles', primaryBundle);
  if (existsSync(join(direct, 'presets'))) return direct;
  const nested = join(repoRoot, 'governance', 'bundles', primaryBundle);
  const rootManifest = join(repoRoot, 'product.manifest.json');
  const nestedManifest = join(repoRoot, 'governance', 'product.manifest.json');
  if (existsSync(join(nested, 'presets')) && existsSync(rootManifest) && existsSync(nestedManifest)) {
    const root = JSON.parse(readFileSync(rootManifest, 'utf8'));
    const governance = JSON.parse(readFileSync(nestedManifest, 'utf8'));
    if (root.repository !== governance.repository || root.defaultBundle !== governance.defaultBundle || root.defaultBundle !== primaryBundle) throw new Error('governance Bundle 与根产品 manifest 不一致');
    return nested;
  }
  return direct;
}

/** 读取 profile；缺失时返回 isDefault=true 的默认 profile（并在报告里告警） */
export function loadProfile(repoRoot = findRepoRoot(), explicitPath = null) {
  const path = explicitPath ? resolve(explicitPath) : join(repoRoot, "acceptance", "profile.json");
  const warnings = [];
  if (!existsSync(path)) {
    warnings.push(`未找到 ${path}，使用基座默认 profile（行业角色/旅程/阈值可能不适用）`);
    const fallback = {
      isDefault: true,
      warnings,
      profile: {
        schemaVersion: PROFILE_SCHEMA,
        repo: "(unknown)",
        productName: "(unknown)",
        lane: "industry",
        primaryBundle: null,
        workspaceId: null,
        dataMode: "simulated",
        startup: { command: "pnpm preview:all", ports: { pc: 3000, bMobile: 3001, cMobile: 3002, server: 8787 } },
        identity: { human: "MEM-001", workspaceSlug: null, guest: "demo-direct" },
        surfaces: { pcRoutes: ["/"], bMobileRoutes: ["/"], cRoutes: ["#chat"] },
        routes: { ...DEFAULT_ROUTES },
        storage: {},
        thresholds: { ...THRESHOLD_DEFAULTS },
        ux: { ...DEFAULT_UX },
        outcome: { ...DEFAULT_OUTCOME },
        autonomy: { ...DEFAULT_AUTONOMY },
        soak: { ...DEFAULT_SOAK },
        environment: { ...DEFAULT_ENVIRONMENT },
        live: { ...DEFAULT_LIVE },
        journeys: DEFAULT_BUILTIN_JOURNEYS,
        notes: "",
      },
    };
    Object.defineProperty(fallback.profile, "environmentKindDeclared", { value: false });
    fallback.environment = resolveEnvironment(fallback.profile, { flag: cliArgs().environmentKind, allowProdWrites: cliArgs().has("--allow-prod-writes") });
    return fallback;
  }
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (raw.schemaVersion !== PROFILE_SCHEMA) {
    if (LEGACY_PROFILE_SCHEMAS.includes(raw.schemaVersion)) warnings.push(`profile.schemaVersion=${raw.schemaVersion}（v1 兼容读取）；建议升级到 ${PROFILE_SCHEMA} 以启用 U/O/ADR 配置`);
    else warnings.push(`profile.schemaVersion=${raw.schemaVersion}，期望 ${PROFILE_SCHEMA}`);
  }
  const thresholds = { ...THRESHOLD_DEFAULTS, ...(raw.thresholds ?? {}) };
  for (const [key, spec] of Object.entries(THRESHOLD_FLOORS)) {
    const floor = spec.value;
    const value = thresholds[key];
    if (typeof value !== "number") {
      warnings.push(`thresholds.${key} 非数字，已回落默认值 ${floor}`);
      thresholds[key] = floor;
      continue;
    }
    if (spec.dir === "clamp") {
      if (value < floor) { warnings.push(`thresholds.minContrastRatio=${value} 低于 AA 下限 ${floor}，已抬到下限`); thresholds[key] = floor; }
    } else if (spec.dir === "max" && value > floor) {
      warnings.push(`thresholds.${key}=${value} 比基座下限 ${floor} 更宽松（max 方向），需在报告中说明理由`);
    } else if (spec.dir === "min" && value < floor) {
      warnings.push(`thresholds.${key}=${value} 低于基座下限 ${floor}（min 方向），需在报告中说明理由`);
    }
  }
  const journeys = Array.isArray(raw.journeys) && raw.journeys.length ? raw.journeys : DEFAULT_BUILTIN_JOURNEYS;
  const environment = { ...DEFAULT_ENVIRONMENT, ...(raw.environment ?? {}) };
  if (!ENVIRONMENT_KINDS.includes(environment.kind)) {
    throw new Error(`profile.environment.kind 非法（可选 ${ENVIRONMENT_KINDS.join("/")}）`);
  }
  const live = { ...DEFAULT_LIVE, ...(raw.live ?? {}) };
  const normalizedBudgets = normalizeBudgets({ ...DEFAULT_LIVE.budgets, ...(raw.live?.budgets ?? {}) });
  live.budgets = normalizedBudgets.budgets;
  warnings.push(...normalizedBudgets.warnings);
  if (live.enabled && !Array.isArray(live.tasks)) {
    warnings.push("live.enabled=true 但 live.tasks 不是数组：P 域将按未配置处理（未验证）");
    live.tasks = [];
  }
  const profile = {
    ...raw,
    thresholds,
    journeys,
    environment,
    live,
    startup: { command: "pnpm preview:all", ports: { pc: 3000, bMobile: 3001, cMobile: 3002, server: 8787 }, ...(raw.startup ?? {}) },
    identity: { human: "MEM-001", workspaceSlug: null, guest: "demo-direct", ...(raw.identity ?? {}) },
    surfaces: { pcRoutes: ["/"], bMobileRoutes: ["/"], cRoutes: ["#chat"], ...(raw.surfaces ?? {}) },
    routes: { ...DEFAULT_ROUTES, ...(raw.routes ?? {}) },
    storage: { ...(raw.storage ?? {}) },
    ux: { ...DEFAULT_UX, ...(raw.ux ?? {}), research: { ...DEFAULT_UX.research, ...(raw.ux?.research ?? {}) } },
    outcome: { ...DEFAULT_OUTCOME, ...(raw.outcome ?? {}) },
    autonomy: { ...DEFAULT_AUTONOMY, ...(raw.autonomy ?? {}) },
    soak: { ...DEFAULT_SOAK, ...(raw.soak ?? {}) },
  };
  Object.defineProperty(profile, "environmentKindDeclared", { value: Object.hasOwn(raw.environment ?? {}, "kind") });
  const resolvedEnvironment = resolveEnvironment(profile, { flag: cliArgs().environmentKind, allowProdWrites: cliArgs().has("--allow-prod-writes") });
  return { isDefault: false, warnings, profile, path, environment: resolvedEnvironment };
}

export function urlsOf(profile) {
  const environment = resolveEnvironment(profile, { flag: cliArgs().environmentKind, allowProdWrites: cliArgs().has("--allow-prod-writes") });
  return { ...environment.urls, environmentKind: environment.kind };
}

/** CLI 小工具：--profile <path> --out <dir> --workspace <id> --bundle <slug> */
export function cliArgs(argv = process.argv.slice(2)) {
  const value = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    if (argv.indexOf(name, i + 1) >= 0 || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${name} 需要一个且仅一个值`);
    return argv[i + 1];
  };
  return {
    profilePath: value("--profile") ?? null,
    outDir: value("--out") ?? null,
    workspaceId: value("--workspace") ?? null,
    primaryBundle: value("--bundle") ?? null,
    environmentKind: value("--env") ?? null,
    has: (flag) => argv.includes(flag),
  };
}
