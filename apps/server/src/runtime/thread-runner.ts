/**
 * 线程执行装配（dispatch / threads.run / 审批自动续跑 / 调度器共用一条路径）。
 *
 * 背景（2026-09-21 真机修复 + GR-15/GR-16）：
 *  - 岗位解析要把 `agents.id`（线程里的 agent_id）归一成 preset_key，否则续跑必然「preset 未注册」；
 *  - 视觉目标必须关掉 LLM 规划（LLM 会给出空参步骤），走行业确定性规划器；
 *  - 真实执行器只在部署配置了执行桥时注入，否则保持 fail-closed（未核实）；
 *  - 派遣前要能回答「这条任务的写工具有没有连接器」（GR-15 第③条提示）。
 * 以上四条此前散落在 trpc router 的多个分支里，调度器无法复用——本模块把它们收成一处。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import YAML from "yaml";
import { getAppPool, getGatewayPool } from "@workloom/db";
import { bundlesRoot } from "@workloom/base/bundles";
import { assemblePreset, runQuest, type AssembledPreset, type QuestPlanner, type QuestRunResult } from "@workloom/runtime";
import { llmCall } from "../service/llm.js";
import { loadDeploymentToolExecutor, describeToolCoverage } from "./tool-executor.js";
import { preferredDispatchPresets } from "./dispatch-routing.js";

export interface Scope { tenantId: string; workspaceId: string }

/**
 * 行业规划器注册位（依赖倒置）。
 *
 * 为什么不让本文件直接 import 行业规划器：本文件属**基座公共分发面**（会下发给全部子仓），
 * 而行业规划器是行业仓保留资产（`apps/server/src/industry/**` 在 sync 白名单之外）。
 * 公共面到行业资产新增相对依赖会被 base-sync 的依赖闭包门禁拒绝
 * （`relative-target-excluded`），因此行业仓在自己的组合根（trpc/router.ts）注册，
 * 基座缺省无行业规划器 → runQuest 退回确定性通用规划（不猜业务参数）。
 */
export type IndustryQuestPlannerFactory = (goal: string) => QuestPlanner | undefined;
let industryPlannerFactory: IndustryQuestPlannerFactory | null = null;

/** 行业仓组合根调用：注册/清理行业规划器（传 null 取消注册）。 */
export function registerIndustryQuestPlanner(factory: IndustryQuestPlannerFactory | null): void {
  industryPlannerFactory = factory;
}

/**
 * 行业语义域判定（MC-304）：`「目标 + 岗位」是否属于本行业能力域`。
 *
 * 由行业模块在加载时声明（词表只住在 `apps/server/src/industry/**`，base-sync 之外；
 * 基座不持有任何行业词，也不假设具体行业包形态）。
 * 基座在通用路由表未命中时用它逐岗位试算，避免落到 preset_key 字母序第一个无关岗位。
 * 未注册（基座形态/其它行业包未声明）时不做试算，保持原有兜底顺序不变。
 */
let industryGoalClaim: ((goal: string, preset: AssembledPreset) => boolean) | null = null;

/** 行业模块调用：声明/清理本行业的语义域判定。 */
export function registerIndustryGoalClaim(claim: ((goal: string, preset: AssembledPreset) => boolean) | null): void {
  industryGoalClaim = claim;
}

/** 指挥层兜底岗位（Bundle 清单不可用/未命中时） */
const DISPATCH_PRESET_FALLBACKS = ["company-ceo", "group-ceo", "growth-lead", "director"] as const;

/** 视觉目标词表（LLM 规划器对视觉目标会给空参步骤 → 关掉 LLM 规划，走确定性直译） */
export const VISUAL_GOAL_PATTERN = /海报|配图|封面|生图|出图|主视觉|图片|素材图|生成.{0,12}图|画一?[张幅].{0,12}图|做一?[张幅].{0,12}图/;

interface WorkspaceContext {
  industry: string | null;
  ready: string[];
}

async function workspaceContext(scope: Scope): Promise<WorkspaceContext> {
  const app = getAppPool();
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const ws = await client.query<{ industry: string | null }>(
      `SELECT industry FROM workspaces WHERE id=$1 AND tenant_id=$2`,
      [scope.workspaceId, scope.tenantId],
    );
    const ag = await client.query<{ preset_key: string }>(
      `SELECT preset_key FROM agents WHERE workspace_id=$1 AND status='ready' ORDER BY preset_key`,
      [scope.workspaceId],
    );
    await client.query("COMMIT");
    return { industry: ws.rows[0]?.industry ?? null, ready: ag.rows.map((r) => r.preset_key) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 岗位来源标记（MC-304）：调用方据此把“兜底派遣”显式告知用户，而不是静默派给第一个岗位。
 */
export type DispatchPresetSelection =
  | "explicit" | "semantic" | "orchestrator" | "industry-default" | "command"
  | "industry-plan" | "fallback";

export interface DispatchPresetResolution {
  presetKey: string;
  selection: DispatchPresetSelection;
}

/**
 * 派遣默认执行 preset 解析（MC-304 起返回来源）：任务语义偏好（N-14）→ Bundle 清单里的
 * orchestrator → 指挥层兜底 → **行业能力试算**（行业包声明的规划器能否为该目标产出计划）
 * → 任意就绪员工（最后兜底，调用方必须显式标注，不再当作“已理解目标”）；全无就绪员工即明确报错。
 */
export async function resolveDispatchPreset(scope: Scope, goal = ""): Promise<DispatchPresetResolution> {
  const { industry, ready } = await workspaceContext(scope);

  // 同一次语义匹配分两段取来源：industry=null 时只剩通用能力域规则，行业默认指挥岗单列
  const semanticOnly = preferredDispatchPresets({ goal, industry: null });
  const candidates: Array<{ key: string; selection: DispatchPresetSelection }> =
    preferredDispatchPresets({ goal, industry }).map((key) => ({
      key,
      selection: semanticOnly.includes(key) ? "semantic" as const : "industry-default" as const,
    }));
  // Bundle 声明顺序：bundles/<industry>/bundle.json → provides.presets → 文件内 kind: orchestrator
  try {
    const dir = join(bundlesRoot(), industry ?? "_default");
    const manifestPath = join(dir, "bundle.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        workloom?: { provides?: { presets?: string[] } };
      };
      for (const rel of manifest.workloom?.provides?.presets ?? []) {
        const p = join(dir, rel);
        if (!existsSync(p)) continue;
        const doc = YAML.parse(readFileSync(p, "utf-8")) as { preset_key?: unknown; kind?: unknown };
        if (doc?.kind === "orchestrator" && typeof doc.preset_key === "string") {
          candidates.push({ key: doc.preset_key, selection: "orchestrator" });
        }
      }
    }
  } catch {
    /* Bundle 清单不合法/缺目录 → 走下方指挥层兜底（不阻塞派遣） */
  }
  for (const key of DISPATCH_PRESET_FALLBACKS) candidates.push({ key, selection: "command" });

  const readySet = new Set(ready);
  for (const candidate of candidates) {
    if (readySet.has(candidate.key)) return { presetKey: candidate.key, selection: candidate.selection };
  }

  const byPlan = await industryPlannerPresetFor(scope, goal, ready);
  if (byPlan) return { presetKey: byPlan, selection: "industry-plan" };

  if (ready.length > 0) {
    // MC-304：最后的“任意就绪员工”兜底保留（派遣/并发/边界用例仍需要一个可执行岗位），
    // 但必须留下可见痕迹——日志 + 响应 presetSelection=fallback，不允许静默冒充“已理解目标”。
    console.warn(
      `[dispatch] 目标未命中语义域（industry=${industry ?? "-"}）：按兜底岗位 ${ready[0]} 派遣`,
    );
    return { presetKey: ready[0]!, selection: "fallback" };
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: "工作区没有可装配的数字员工（agents 全部未就绪），无法派遣任务——请先在名册完成上岗",
  });
}

/** 兼容旧调用点：只取岗位键（需要来源标记时用 resolveDispatchPreset）。 */
export async function resolveDispatchPresetKey(scope: Scope, goal = ""): Promise<string> {
  return (await resolveDispatchPreset(scope, goal)).presetKey;
}

/**
 * MC-304：行业能力试算——语义域词表不进基座，靠**行业包声明的 claimsGoal**回答“这个岗位认不认得这件事”。
 *
 * 背景（真机实证）：口语化目标未命中通用路由表时，旧实现落到 preset_key 字母序第一个就绪岗位，
 * 用与该目标无关的工具把步骤标 completed（假交付）。
 * 这里逐个试算就绪岗位：行业包声明「目标 + 岗位工具」语义相容即选中；都不相容才走显式兜底。
 * 行业词/对象/参数只写在 apps/server/src/industry/**（base-sync 之外），基座只做能力试算。
 */
async function industryPlannerPresetFor(scope: Scope, goal: string, ready: string[]): Promise<string | undefined> {
  const claimsGoal = industryGoalClaim;
  if (!claimsGoal || !goal.trim() || ready.length === 0) return undefined;
  for (const presetKey of ready) {
    try {
      const preset = await assemblePreset(getAppPool(), scope, { workspaceId: scope.workspaceId, presetKey, goal });
      if (claimsGoal(goal, preset)) {
        console.log(`[dispatch] 语义域未命中 → 行业能力试算命中 ${presetKey}（goal=${goal.slice(0, 40)}）`);
        return presetKey;
      }
    } catch {
      // 单个岗位装配失败（未安装/契约不符）不阻断路由，继续试下一个
    }
  }
  return undefined;
}

/**
 * 线程归属 preset 解析：`threads.agent_id` 存的是 **agents.id**——旧实现把它当 preset_key 直接喂给
 * runQuest，续跑时装配层直接拒绝「Agent preset 未注册」（视频任务在「审批通过 → 自动续跑」静默卡死）。
 * 这里把两种写法（agents.id / preset_key）统一归一成 preset_key；都解析不到时退回派遣默认。
 */
export async function resolveThreadPresetKey(scope: Scope, ref: string | null | undefined, goal = ""): Promise<string> {
  const candidate = ref?.trim();
  if (!candidate) return resolveDispatchPresetKey(scope, goal);
  const app = getAppPool();
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<{ preset_key: string }>(
      `SELECT preset_key FROM agents
        WHERE workspace_id=$1 AND (id=$2 OR preset_key=$2)
        ORDER BY (preset_key=$2) DESC
        LIMIT 1`,
      [scope.workspaceId, candidate],
    );
    await client.query("COMMIT");
    if (r.rows[0]?.preset_key) return r.rows[0].preset_key;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return resolveDispatchPresetKey(scope, goal);
}

/**
 * GR-15 第③条：派遣前覆盖度提示——preset 声明的写工具里，哪些没有可路由的执行桥。
 * 返回给客户端任务卡展示（"将以未核实收尾"），避免跑完才发现无连接器。
 */
export async function questCoverageWarnings(scope: Scope, presetKey: string, goal: string): Promise<string[]> {
  try {
    const preset = await assemblePreset(getAppPool(), scope, { workspaceId: scope.workspaceId, presetKey, goal });
    const writeTools = preset.tools.filter((tool) => tool.access !== "read").map((tool) => tool.name);
    if (writeTools.length === 0) return [];
    const coverage = await describeToolCoverage(scope, writeTools);
    if (coverage.bridges === 0) {
      return [`当前部署未配置工具执行桥，写动作（${writeTools.slice(0, 4).join("、")}${writeTools.length > 4 ? " 等" : ""}）将以「未核实」收尾`];
    }
    if (coverage.uncovered.length > 0) {
      return [`以下写动作没有连接器，将以「未核实」收尾：${coverage.uncovered.slice(0, 6).join("、")}${coverage.uncovered.length > 6 ? " 等" : ""}`];
    }
    return [];
  } catch {
    // 覆盖度提示是"锦上添花"，装配失败由 runQuest 自己抛明确错误，不在这里吞掉主错误语义
    return [];
  }
}

export interface ThreadQuestInput {
  threadId: string;
  goal: string;
  mode?: "quest" | "agent";
  /** preset 引用（preset_key 或 agents.id）；缺省按线程 agent_id / 派遣默认解析 */
  presetRef?: string | null;
  /** GR-01：显式重规划（缺省复用已持久化计划；replan 会失效本线程未决审批） */
  replan?: boolean;
  replanReason?: string;
  /** A-03：调用方已完成原子认领（调度器单语句 UPDATE 认领）时置 true，跳过入口 CAS */
  skipClaim?: boolean;
}

/**
 * GR-14：长任务目标档案（goalRef）读取。
 *
 * 背景：dispatch 的 title 契约是 ≤500 字索引，但视频 brief/营销方案这类目标动辄几千字，
 * 被硬截断后规划器看到的是残缺目标。这里支持把长文放在**一店一档**（profiles.archive）里，
 * 派遣时只传档案键，规划读全文。
 * 口径：
 *  - 支持两种键位：`archive.goals.<ref>`（结构化）或 `archive.<ref>`（直接键）；
 *  - 读取失败/键不存在 → **fail-closed**：返回 undefined，调用方按无档案处理（不猜目标）；
 *  - 档案版本一并返回，供审批快照记录（plan 版本漂移可追溯）。
 */
export async function loadGoalArchive(
  scope: Scope, ref: string,
): Promise<{ text: string; version: string } | undefined> {
  const client = await getAppPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<{ archive: Record<string, unknown> | null; updated?: string }>(
      `SELECT archive FROM profiles WHERE workspace_id=$1`,
      [scope.workspaceId],
    );
    await client.query("COMMIT");
    const archive = r.rows[0]?.archive;
    if (!archive || typeof archive !== "object") return undefined;
    const goals = (archive as { goals?: Record<string, unknown> }).goals;
    const raw = (goals && typeof goals === "object" && goals[ref] !== undefined ? goals[ref] : (archive as Record<string, unknown>)[ref]);
    const text = typeof raw === "string" ? raw
      : (raw && typeof raw === "object" && typeof (raw as { text?: unknown }).text === "string"
        ? (raw as { text: string }).text
        : undefined);
    if (!text || !text.trim()) return undefined;
    const version = raw && typeof raw === "object" && typeof (raw as { version?: unknown }).version === "string"
      ? (raw as { version: string }).version
      : "v1";
    return { text: text.trim(), version };
  } catch (error) {
    console.warn(
      "[goal-archive] 档案读取失败（fail-closed：按无档案处理，不猜目标）",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  } finally {
    client.release();
  }
}

export interface ThreadQuestOutcome extends QuestRunResult {
  /** GR-15：派遣/续跑前的连接器覆盖度提示 */
  warnings?: string[];
  /** 实际使用的岗位（复盘"派给了谁"） */
  presetKey: string;
}

/**
 * 线程执行唯一装配点：dispatch(runImmediately) / threads.run / 审批自动续跑 / 调度器都走这里。
 */
export async function runQuestForThread(scope: Scope, input: ThreadQuestInput): Promise<ThreadQuestOutcome> {
  /**
   * A-03 修复（来源：WorkLoom-growth 排雷 T-2026-0929-0003）：执行前原子认领（queued/paused→running CAS）。
   * 此前 SELECT 取线程到 runQuest 置 running 之间有装配+LLM 规划窗口（最长 120s），
   * dispatch(runImmediately) / threads.run / 多实例调度器可并发重入同一线程——
   * 写类工具重复执行＝重复扣费/重复发布。
   * 调度器已用自己的单语句认领，必须传 skipClaim 跳过本 CAS（否则自相挡死）。
   */
  if (!input.skipClaim) {
    const app0 = getAppPool();
    const c = await app0.connect();
    let blocked = false;
    try {
      /**
       * 认领必须带**事务级 RLS 上下文**：threads 表对 app 角色启用 RLS
       * （`workspace_id = current_setting('app.workspace_id', true)`），
       * 无 GUC 时那条 UPDATE 匹配 0 行 → CAS 静默空转、并发重入照旧放行
       * （2026-09-30 实测：线程置 running 后入口仍照常执行并写 3 条事件）。
       */
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const claimed = await c.query(
        `UPDATE threads SET status='running', updated_at=now()
          WHERE id=$1 AND workspace_id=$2 AND status IN ('queued','paused') RETURNING id`,
        [input.threadId, scope.workspaceId],
      );
      if ((claimed.rowCount ?? 0) === 0) {
        const cur = await c.query<{ status: string }>(
          `SELECT status FROM threads WHERE id=$1 AND workspace_id=$2`, [input.threadId, scope.workspaceId]);
        blocked = (cur.rows[0]?.status ?? "unknown") === "running";
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
    // 他方正在执行：幂等退出（不并发重入）；
    // pending_review/completed/failed 等维持原语义（审批续跑/重放由 runQuest 按事件态处理）
    if (blocked) {
      return { threadId: input.threadId, status: "running", stepsDone: 0, stepsTotal: 0, unverified: [], presetKey: "" };
    }
  }
  const presetKey = await resolveThreadPresetKey(scope, input.presetRef, input.goal);
  const toolExecutor = await loadDeploymentToolExecutor(scope);
  const visualGoal = VISUAL_GOAL_PATTERN.test(input.goal);
  const warnings = await questCoverageWarnings(scope, presetKey, input.goal);
  // GR-13：把本工作区 bundle 的对象枚举交给规划器（围栏词表由 runQuest 内部按 active 规则注入）
  const planVocabulary = await loadObjectVocabulary(scope);
  // 行业规划器由行业仓组合根注册；未注册（基座缺省）时不传 fallbackPlanner，退回通用确定性规划
  const fallbackPlanner = industryPlannerFactory?.(input.goal);
  const result = await runQuest(getAppPool(), getGatewayPool(), scope, {
    threadId: input.threadId,
    goal: input.goal,
    presetKey,
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.replan ? { replan: true, ...(input.replanReason ? { replanReason: input.replanReason } : {}) } : {}),
    // 视觉目标关掉 LLM 规划（空参步骤到桥侧必 bad_request），走行业确定性直译
    ...(visualGoal ? {} : { llmCall: llmCall("quest-plan") }),
    ...(fallbackPlanner ? { fallbackPlanner } : {}),
    ...(toolExecutor ? { toolExecutor } : {}),
    ...(planVocabulary.objectTypes.length ? { planVocabulary } : {}),
  });
  return { ...result, ...(warnings.length ? { warnings } : {}), presetKey };
}

/**
 * GR-13：读取本工作区所属行业包的对象枚举（`bundles/<industry>/schemas/objects.json`）。
 * 读不到就返回空（规划器退化为只用工具派生词，不报错）。
 */
async function loadObjectVocabulary(scope: Scope): Promise<{ objectTypes: string[]; actions: string[] }> {
  try {
    const industry = await industryOfWorkspace(scope);
    if (!industry) return { objectTypes: [], actions: [] };
    const file = join(bundlesRoot(), industry, "schemas", "objects.json");
    if (!existsSync(file)) return { objectTypes: [], actions: [] };
    const doc = JSON.parse(readFileSync(file, "utf-8")) as { objects?: Array<{ type?: unknown }> };
    const objectTypes = (doc.objects ?? [])
      .map((item) => (typeof item?.type === "string" ? item.type : ""))
      .filter(Boolean);
    return { objectTypes, actions: [] };
  } catch {
    return { objectTypes: [], actions: [] };
  }
}

/** 工作区行业（进程级缓存：派遣/续跑/调度器会反复问到，工作区行业极少变） */
const industryCache = new Map<string, string | null>();
async function industryOfWorkspace(scope: Scope): Promise<string | null> {
  const cached = industryCache.get(scope.workspaceId);
  if (cached !== undefined) return cached;
  const client = await getAppPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<{ industry: string | null }>(
      `SELECT industry FROM workspaces WHERE id=$1 AND tenant_id=$2`,
      [scope.workspaceId, scope.tenantId],
    );
    await client.query("COMMIT");
    const value = r.rows[0]?.industry ?? null;
    industryCache.set(scope.workspaceId, value);
    return value;
  } catch {
    // 查询失败不缓存（下次重试），同时不影响规划主链路（围栏词表仍由 runQuest 内部注入）
    return null;
  } finally {
    client.release();
  }
}
