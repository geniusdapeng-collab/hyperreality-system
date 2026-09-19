/**
 * profile.mjs · 真机验收 profile 加载与校验（RDAS v1）
 *
 * 事实源：本仓 `acceptance/profile.json`（行业语义：角色/旅程/路由/阈值/启动命令）。
 * 基座只提供默认值与**阈值下限**：行业可以把要求调严，不能悄悄放宽（放宽必须写进报告并说明）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PROFILE_SCHEMA = "workloom.acceptance-profile/v1";

/** 阈值下限（行业 profile 的取值不得低于这里的默认值） */
export const THRESHOLD_FLOORS = {
  firstValueMs: 20000,
  dispatchMs: 60000,
  approvalMs: 30000,
  traceClicks: 2,
  guestFirstReplyMs: 30000,
  decisionQuota: 7,
  minContrastRatio: 4.5,
  idleInterruptionWindowS: 20,
};

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

/** 读取 profile；缺失时返回 isDefault=true 的默认 profile（并在报告里告警） */
export function loadProfile(repoRoot = findRepoRoot(), explicitPath = null) {
  const path = explicitPath ? resolve(explicitPath) : join(repoRoot, "acceptance", "profile.json");
  const warnings = [];
  if (!existsSync(path)) {
    warnings.push(`未找到 ${path}，使用基座默认 profile（行业角色/旅程/阈值可能不适用）`);
    return {
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
        thresholds: { ...THRESHOLD_FLOORS },
        journeys: DEFAULT_BUILTIN_JOURNEYS,
        notes: "",
      },
    };
  }
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (raw.schemaVersion !== PROFILE_SCHEMA) warnings.push(`profile.schemaVersion=${raw.schemaVersion}，期望 ${PROFILE_SCHEMA}`);
  const thresholds = { ...THRESHOLD_FLOORS, ...(raw.thresholds ?? {}) };
  for (const [key, floor] of Object.entries(THRESHOLD_FLOORS)) {
    const value = thresholds[key];
    if (typeof value !== "number") {
      warnings.push(`thresholds.${key} 非数字，已回落默认值 ${floor}`);
      thresholds[key] = floor;
      continue;
    }
    // 时间/次数类阈值“越大越松”，对比度“越大越严”，分别判定
    if (key === "minContrastRatio") {
      if (value < floor) { warnings.push(`thresholds.minContrastRatio=${value} 低于 AA 下限 ${floor}，已抬到下限`); thresholds[key] = floor; }
    } else if (value > floor) {
      warnings.push(`thresholds.${key}=${value} 比基座下限 ${floor} 更宽松，需在报告中说明理由`);
    }
  }
  const journeys = Array.isArray(raw.journeys) && raw.journeys.length ? raw.journeys : DEFAULT_BUILTIN_JOURNEYS;
  const profile = {
    ...raw,
    thresholds,
    journeys,
    startup: { command: "pnpm preview:all", ports: { pc: 3000, bMobile: 3001, cMobile: 3002, server: 8787 }, ...(raw.startup ?? {}) },
    identity: { human: "MEM-001", workspaceSlug: null, guest: "demo-direct", ...(raw.identity ?? {}) },
    surfaces: { pcRoutes: ["/"], bMobileRoutes: ["/"], cRoutes: ["#chat"], ...(raw.surfaces ?? {}) },
    routes: { ...DEFAULT_ROUTES, ...(raw.routes ?? {}) },
    storage: { ...(raw.storage ?? {}) },
  };
  return { isDefault: false, warnings, profile, path };
}

export function urlsOf(profile) {
  const p = profile.startup.ports;
  return {
    pc: `http://localhost:${p.pc}`,
    bMobile: `http://localhost:${p.bMobile}`,
    cMobile: `http://localhost:${p.cMobile}`,
    api: `http://127.0.0.1:${p.server}`,
  };
}

/** CLI 小工具：--profile <path> --out <dir> --workspace <id> --bundle <slug> */
export function cliArgs(argv = process.argv.slice(2)) {
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    profilePath: value("--profile") ?? null,
    outDir: value("--out") ?? null,
    workspaceId: value("--workspace") ?? null,
    primaryBundle: value("--bundle") ?? null,
    has: (flag) => argv.includes(flag),
  };
}
