/**
 * model-router · 路由策略（v3.0 通用模型路由系统 · 底座内核，行业无关）
 *
 * 三档模型体系（L1 轻量 / L2 中坚 / L3 旗舰）+ 场景路由表 + 套餐默认映射：
 *   - 场景路由表：bundle 第⑦装配槽 model-policy.yml 注入（L2.6 行业可覆盖，底座零行业数值）；
 *   - 套餐策略：智享 lite / 标准 standard / 智能 smart——三档差异 = 默认模型映射不同，
 *     不是功能墙（任何档都可经升级重答触达 L3，按倍率实扣）；
 *   - 降级语义行业化：downgrade（降档重答）/ passthrough-disclose（金融：宁可不答不可错答）/
 *     queue（谷时排队）/ rule-template（确定性模板兜底）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

/* ================= 三档模型体系 ================= */

export type Tier3 = "L1" | "L2" | "L3";
export const TIER3_ORDER: readonly Tier3[] = ["L1", "L2", "L3"];

/** 积分倍率（第三部分·换算关系：1 积分 = 1,000 tokens L2 基准；谷时再 ×OFF_PEAK_RATE_RATIO） */
export const TIER_MULTIPLIER: Record<Tier3, number> = { L1: 0.2, L2: 1.0, L3: 3.0 };

export function tierUp(t: Tier3): Tier3 | null {
  return t === "L1" ? "L2" : t === "L2" ? "L3" : null;
}
export function tierDown(t: Tier3): Tier3 | null {
  return t === "L3" ? "L2" : t === "L2" ? "L1" : null;
}
/** 套餐整体位移：-1 压一档（智享）/ 0 / +1 抬一档（智能）；越界截断 */
export function shiftTier(t: Tier3, shift: -1 | 0 | 1): Tier3 {
  if (shift === -1) return tierDown(t) ?? t;
  if (shift === 1) return tierUp(t) ?? t;
  return t;
}

/** 旧两档（standard|flagship）→ 三档映射（向后兼容：standard→L2、flagship→L3） */
export function legacyTierToTier3(t: "standard" | "flagship"): Tier3 {
  return t === "flagship" ? "L3" : "L2";
}

/* ================= 场景路由表 ================= */

/** 降级/兜底语义（行业化；金融=透传披露禁止降档） */
export type FallbackMode = "downgrade" | "passthrough-disclose" | "queue" | "rule-template";

/** 自动升级触发信号 */
export type EscalateSignal = "low-confidence" | "thumbs-down" | "redteam-fail" | "parse-fail" | "gate-blocked";

export interface ScenePolicy {
  /** 默认模型档 */
  tier: Tier3;
  /** 降级语义（默认 downgrade） */
  fallback?: FallbackMode;
  /** 触发自动升级的信号 */
  escalateOn?: EscalateSignal[];
  /** 禁止降档（质量红线，如体检报告/六步深度管线） */
  noDowngrade?: boolean;
  /** 计费归属：tenant 客户积分 / platform 平台成本（售前体检报告） */
  billTo?: "tenant" | "platform";
  /** 调度窗口偏好：any / off-peak-only（非实时批量，可排队等谷时） */
  window?: "any" | "off-peak-only";
}

/* ================= 套餐策略 ================= */

export type PlanId = "lite" | "standard" | "smart";
export const PLAN_LABELS: Record<PlanId, string> = {
  lite: "智享版", standard: "标准版", smart: "智能版",
};

export interface PlanStrategy {
  label?: string;
  /** 整体位移：智享 -1 / 标准 0 / 智能 +1（场景表未点名时生效） */
  defaultShift: -1 | 0 | 1;
  /** 点名场景级覆盖（优先级高于 defaultShift） */
  tierOverrides?: Record<string, Tier3>;
}

export interface ModelPolicy {
  version: string;
  scenes: Record<string, ScenePolicy>;
  plans: Record<PlanId, PlanStrategy>;
}

/* ================= 底座默认策略（行业无关通用场景） ================= */

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  version: "v3.0",
  scenes: {
    "generic": { tier: "L2" },
    "intent-classify": { tier: "L1", fallback: "rule-template" },
    "nl-translate": { tier: "L1", fallback: "rule-template" },
    "cs-answer": { tier: "L1", escalateOn: ["low-confidence", "thumbs-down"] },
    "ask-synthesize": { tier: "L1", escalateOn: ["thumbs-down"] },
    "comment-classify": { tier: "L1", window: "off-peak-only" },
    "quest-plan": { tier: "L2" },
    "content-generate": { tier: "L2", escalateOn: ["redteam-fail", "thumbs-down"] },
    "briefing": { tier: "L2" },
    "ceo-decision": { tier: "L2" },
    "ceo-deep-analysis": { tier: "L3", noDowngrade: true, fallback: "downgrade" },
    "hr-replacement": { tier: "L3", noDowngrade: true },
    "kb-extract": { tier: "L2", window: "off-peak-only" },
    "fast-scan-report": { tier: "L3", noDowngrade: true, billTo: "platform" },
  },
  plans: {
    lite: { label: "智享版", defaultShift: -1 },
    standard: { label: "标准版", defaultShift: 0 },
    smart: {
      label: "智能版", defaultShift: 1,
      tierOverrides: {
        // 简单任务也保底 L2（又快又准）；意图分类/翻译保持 L1 快速款（延迟红线）
        "cs-answer": "L2", "ask-synthesize": "L2", "ceo-decision": "L3",
        "intent-classify": "L1", "nl-translate": "L1",
      },
    },
  },
};

/* ================= 档位解析（场景 × 套餐） ================= */

export function resolveScene(policy: ModelPolicy, scene: string): ScenePolicy {
  return policy.scenes[scene] ?? policy.scenes["generic"] ?? { tier: "L2" };
}

/** 场景最终档位 = 套餐点名覆盖 → 场景默认档经套餐位移；noDowngrade 场景免疫下压 */
export function resolveTier(policy: ModelPolicy, scene: string, plan: PlanId): Tier3 {
  const sp = resolveScene(policy, scene);
  const ps = policy.plans[plan] ?? policy.plans.standard;
  const override = ps.tierOverrides?.[scene];
  if (override) return sp.noDowngrade ? (TIER3_ORDER.indexOf(override) < TIER3_ORDER.indexOf(sp.tier) ? sp.tier : override) : override;
  const shifted = shiftTier(sp.tier, ps.defaultShift);
  // noDowngrade：套餐下压不得生效（质量红线只升不降）
  return sp.noDowngrade && TIER3_ORDER.indexOf(shifted) < TIER3_ORDER.indexOf(sp.tier) ? sp.tier : shifted;
}

/* ================= bundle 第⑦装配槽：model-policy.yml 加载与校验 ================= */

const VALID_TIERS: readonly string[] = TIER3_ORDER;
const VALID_FALLBACKS: readonly FallbackMode[] = ["downgrade", "passthrough-disclose", "queue", "rule-template"];
const VALID_SIGNALS: readonly EscalateSignal[] = ["low-confidence", "thumbs-down", "redteam-fail", "parse-fail", "gate-blocked"];

/** 解析并校验 model-policy.yml 文本；issues 为空即合法（纯函数，装配校验器复用） */
export function parseModelPolicy(text: string): { policy: ModelPolicy | null; issues: string[] } {
  const issues: string[] = [];
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    return { policy: null, issues: [`YAML 解析失败：${err instanceof Error ? err.message : String(err)}`] };
  }
  const doc = raw as Partial<ModelPolicy> | null;
  if (!doc || typeof doc !== "object") return { policy: null, issues: ["model-policy.yml 内容为空或不是对象"] };
  const scenes = (doc.scenes ?? {}) as Record<string, ScenePolicy>;
  for (const [name, sp] of Object.entries(scenes)) {
    if (!sp || typeof sp !== "object") { issues.push(`场景「${name}」定义非法`); continue; }
    if (!VALID_TIERS.includes(sp.tier)) issues.push(`场景「${name}」tier 非法：${String(sp.tier)}（须为 L1/L2/L3）`);
    if (sp.fallback && !VALID_FALLBACKS.includes(sp.fallback)) issues.push(`场景「${name}」fallback 非法：${String(sp.fallback)}`);
    for (const s of sp.escalateOn ?? []) {
      if (!VALID_SIGNALS.includes(s)) issues.push(`场景「${name}」escalateOn 信号非法：${String(s)}`);
    }
    if (sp.billTo && !["tenant", "platform"].includes(sp.billTo)) issues.push(`场景「${name}」billTo 非法：${String(sp.billTo)}`);
    if (sp.window && !["any", "off-peak-only"].includes(sp.window)) issues.push(`场景「${name}」window 非法：${String(sp.window)}`);
  }
  const plans = (doc.plans ?? DEFAULT_MODEL_POLICY.plans) as Record<PlanId, PlanStrategy>;
  for (const [pid, ps] of Object.entries(plans)) {
    if (!["lite", "standard", "smart"].includes(pid)) { issues.push(`套餐「${pid}」非法（须为 lite/standard/smart）`); continue; }
    for (const [scene, tier] of Object.entries(ps.tierOverrides ?? {})) {
      if (!VALID_TIERS.includes(tier)) issues.push(`套餐「${pid}」覆盖场景「${scene}」tier 非法：${String(tier)}`);
      if (!scenes[scene]) issues.push(`套餐「${pid}」覆盖了未定义场景「${scene}」`);
    }
  }
  if (issues.length > 0) return { policy: null, issues };
  return {
    policy: {
      version: String(doc.version ?? "v3.0"),
      scenes: { ...DEFAULT_MODEL_POLICY.scenes, ...scenes }, // 行业场景覆盖底座默认，未点名场景继承
      plans: { ...DEFAULT_MODEL_POLICY.plans, ...plans },
    },
    issues: [],
  };
}

/** 从 bundle 目录加载 model-policy.yml；文件缺失 → null（装配层按「使用底座默认」处理） */
export function loadModelPolicy(bundleDir: string): { policy: ModelPolicy | null; issues: string[]; path: string } {
  const path = join(bundleDir, "model-policy.yml");
  if (!existsSync(path)) return { policy: null, issues: [], path };
  const r = parseModelPolicy(readFileSync(path, "utf-8"));
  return { ...r, path };
}
