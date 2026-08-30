/**
 * bundles —— 行业装配域（L2 Base Bundle 六插件之六「行业 Bundle 装载」，F11）
 * PRD P7 舰船换装坞：换行业 = 换一套成员/群规/皮肤，底座代码零改动（§2.2/§2.3/§2.4）
 *
 * 数据来源口径（P7-⑤）：槽位状态 = bundle 注册表投影（磁盘 bundles/<slug>/ 实物扫描）；
 * 校验结果 = 装配校验器运行记录（recheck/activate 留痕 biz_events，不静默 L9.2）。
 *
 * 六装配槽（P7E1/§2.2）：① 档案 Schema ② 对象与阶段枚举 ③ 工具集 ④ 围栏包 ⑤ Agent 班组 ⑥ 工作台 UI
 * 起飞前检查单（P7E3/F2.10）：档案 forbidden 校验 / 枚举冲突检测 / 工具探针健康 /
 *   围栏绑定完整 / UI 用例同步 —— 任一失败拒绝激活；修复后重跑（数据活算，重查即重跑）。
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import YAML from "yaml";
import { gatewayAppend, gatewayAppendOnClient } from "../workdata/gateway.js";
import { parseModelPolicy } from "../model-router/policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 仓库 bundles/ 根（packages/base/bundles → 上三级）；测试可用 BUNDLES_ROOT 指到临时目录 */
export const DEFAULT_BUNDLES_ROOT = join(__dirname, "..", "..", "..", "bundles");
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
    public readonly code: "NOT_FOUND" | "ALREADY_EXISTS" | "INVALID_INPUT" | "ASSEMBLY_CHECK_FAILED",
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

interface BundleJson {
  name?: string;
  version?: string;
  workloom?: {
    industry?: string;
    displayName?: string;
    description?: string;
    status?: string;
    owner?: string;
    provides?: Record<string, string[]>;
  };
}

interface PresetYml {
  preset_key?: string;
  name?: string;
  version?: string;
  readonly?: boolean;
  fence_bindings?: string[];
  tools?: Array<{ name: string }>;
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
interface BundleDiskAssets {
  dir: string;
  bj: BundleJson;
  isDraft: boolean;
  archiveSchema: { properties?: Record<string, unknown>; required?: string[] } | null;
  objectsJson: { objects?: Array<{ type: string; label: string }> } | null;
  // D27：account_stages（账号生命周期）与内容 stages 并集均为合法枚举
  stagesJson: { stages?: Array<{ id: string; label: string }>; account_stages?: Array<{ id: string; label: string }> } | null;
  presets: PresetYml[];
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
  const bj = readJson<BundleJson>(join(dir, "bundle.json"));
  if (!bj) throw new BundleError("NOT_FOUND", `行业 Bundle「${slug}」不存在（bundles/${slug}/bundle.json 缺失）`);
  const presetsDir = join(dir, "presets");
  const presetFiles = existsSync(presetsDir)
    ? readdirSync(presetsDir).filter((f) => f.endsWith(".yml")).sort()
    : [];
  const fencesDir = join(dir, "fences");
  const fenceFiles = existsSync(fencesDir)
    ? readdirSync(fencesDir).filter((f) => f.endsWith(".yml")).sort()
    : [];
  return {
    dir,
    bj,
    isDraft: bj.workloom?.status === "draft",
    archiveSchema: readJson(join(dir, "schemas/archive.schema.json")),
    objectsJson: readJson(join(dir, "schemas/objects.json")),
    stagesJson: readJson(join(dir, "schemas/stages.json")),
    presets: presetFiles
      .map((f) => YAML.parse(readFileSync(join(presetsDir, f), "utf-8")) as PresetYml)
      .filter((p) => p?.preset_key),
    fenceFiles,
    fencePacks: fenceFiles
      .map((f) => YAML.parse(readFileSync(join(fencesDir, f), "utf-8")) as FenceYml)
      .filter((f) => f?.version),
    uiCases: readJson(join(dir, "ui/cases.json")),
    modelPolicyText: existsSync(join(dir, "model-policy.yml"))
      ? readFileSync(join(dir, "model-policy.yml"), "utf-8")
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

  // Bundle 自家工作区（D28：探针/围栏注册表须在 Bundle 属地查验——同租户 RLS 放行 workspaces，
  // 非激活 Bundle 在他域视角不应恒红；无属地（未播种）则回退当前工作区，探针如实报缺）
  const home = await client.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE tenant_id=$1 AND industry=$2 ORDER BY created_at NULLS LAST, id LIMIT 1`,
    [scope.tenantId, slug],
  );
  const homeWsId = home.rows[0]?.id ?? scope.workspaceId;

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
  // 工作区 stage 属账号生命周期口径（D27 修复：account_stages 与内容 stages 并集均为合法枚举）
  const stageIds = [...(stagesJson?.stages ?? []), ...(stagesJson?.account_stages ?? [])].map((s) => s.id);
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
  await client.query("SELECT set_config('app.workspace_id', $1, true)", [homeWsId]);
  const agentRows = presets.length > 0
    ? (await client.query<{
        id: string; preset_key: string; name: string; version: string;
        status: string; readonly: boolean; fence_bindings: string[];
      }>(
        `SELECT a.id, a.preset_key, a.name, a.version, a.status, a.readonly, a.fence_bindings
         FROM agents a WHERE a.workspace_id = $1 AND a.preset_key = ANY($2::text[]) ORDER BY a.preset_key`,
        [homeWsId, presets.map((p) => p.preset_key!)],
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
        [homeWsId],
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

  await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);

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
        bj.workloom.status = "active";
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
    name: `@workloom/${input.slug}`,
    version: input.version,
    workloom: {
      industry: input.slug,
      displayName: input.displayName,
      description: input.changelog,
      status: "draft", // §2.3：草稿态不进入分发
      owner: input.ownerMemberNo,
      fenceRef: input.fenceRef,
      provides: { presets: [], fences: [], skills: [], schemas: [], ui: [] },
    },
  }, null, 2)}\n`, "utf-8");
  // 第⑦槽骨架：新行业默认继承底座路由策略，按行业特点增量覆盖场景即可
  writeFileSync(join(dir, "model-policy.yml"), [
    `# ${input.displayName} 模型路由策略（bundle 第⑦装配槽，v3.0）`,
    `version: "v3.0"`,
    `scenes:`,
    `  # 示例：`,
    `  # cs-answer: { tier: L1, escalateOn: [low-confidence, thumbs-down] }`,
    `plans:`,
    `  lite:     { defaultShift: -1 }`,
    `  standard: { defaultShift: 0 }`,
    `  smart:    { defaultShift: 1 }`,
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
