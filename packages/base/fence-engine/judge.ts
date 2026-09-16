/**
 * fence-engine · 纯函数判定器（B4 核心，F2.1/F2.2/E2.1/E2.2）
 *
 * 语义（由当前已验证 Bundle 的围栏策略声明，基座只实现通用判定）：
 *  - match 命中（object_type ∈ object_types 且 action ∈ actions）后求值 when 表达式
 *  - 命中 → 按该规则 level 判定；deny 优先并集求值（E2.2）：block > review > auto
 *  - 写类动作无任何规则命中 → 按 default_level 处理（行业包提供，L2.6）
 *  - 求值异常 → 按 block（宁可错杀，E2.1）
 *  - 判定器是纯函数：输入=对象+动作+参数+上下文+规则集；子调用与普通调用同一瀑布（F2.1/H-4）
 */
import { evalCondition, FenceEvalError, type EvalScope } from "./expr.js";
import { isWriteAction } from "../workdata/gateway.js";

export type FenceLevel = "auto" | "review" | "block";
export type RuleResult = "pass" | "review" | "blocked" | "conflict";

/** 判定输入（五元事件的动作上下文快照） */
export interface JudgeInput {
  object: { type: string; id?: string };
  action: string;
  params?: Record<string, unknown>;
  before?: unknown;
  after?: unknown;
  context?: Record<string, unknown>;
}

/** 规则（围栏包 YAML 装载后的运行时形态） */
export interface RuntimeRule {
  rule_id: string;
  version: string;
  name: string;
  level: FenceLevel;
  is_baseline: boolean;
  objectTypes: string[];
  actions: string[];
  when: string;
}

export interface RuleImpact {
  rule_id: string;
  version: string;
  result: RuleResult;
}

export interface JudgeVerdict {
  /** 最终判定：auto 放行 / review 挂起必审 / block 熔断告警 */
  level: FenceLevel;
  /** 命中规则的判定明细（rule_impact 落库口径，附录 E） */
  impacts: RuleImpact[];
  /** 触发熔断/挂起的规则名（展示用） */
  triggeredBy: string[];
  /** 求值异常痕迹（E2.1：异常按 block，且留痕） */
  evalErrors: string[];
}

const LEVEL_RANK: Record<FenceLevel, number> = { auto: 0, review: 1, block: 2 };
const LEVEL_TO_RESULT: Record<FenceLevel, RuleResult> = { auto: "pass", review: "review", block: "blocked" };

/**
 * 判定（纯函数）。
 * @param input 动作上下文
 * @param rules 当前生效规则集（active；调用方负责装载 workspace 维度）
 * @param defaultLevel 写类动作无命中时的默认级别（围栏包 default_level；读类动作恒 auto）
 */
export function judge(input: JudgeInput, rules: RuntimeRule[], defaultLevel: FenceLevel): JudgeVerdict {
  const impacts: RuleImpact[] = [];
  const triggeredBy: string[] = [];
  const evalErrors: string[] = [];
  let maxLevel: FenceLevel | null = null;

  const scope: EvalScope = {
    before: input.before,
    after: input.after,
    params: input.params ?? {},
    context: input.context ?? {},
    object: input.object,
  };

  for (const rule of rules) {
    // match 段：对象类型 + 动作
    if (!rule.objectTypes.includes(input.object.type)) continue;
    if (!rule.actions.includes(input.action)) continue;
    // when 段：条件求值（命中才按 level 判定）
    let hit: boolean;
    try {
      hit = evalCondition(rule.when, scope);
    } catch (err) {
      // E2.1：求值异常按 block 处理（宁可错杀），并留痕
      evalErrors.push(`${rule.rule_id}: ${err instanceof FenceEvalError ? err.message : String(err)}`);
      impacts.push({ rule_id: rule.rule_id, version: rule.version, result: "blocked" });
      triggeredBy.push(`${rule.name}（求值异常→block）`);
      maxLevel = "block";
      continue;
    }
    if (!hit) continue;
    const result = LEVEL_TO_RESULT[rule.level];
    impacts.push({ rule_id: rule.rule_id, version: rule.version, result });
    if (rule.level !== "auto") triggeredBy.push(rule.name);
    if (maxLevel === null || LEVEL_RANK[rule.level] > LEVEL_RANK[maxLevel]) maxLevel = rule.level;
  }

  // 无命中：读类动作恒 auto；写类动作才按 default_level（围栏包头部口径逐字：「写类动作
  // 无任何规则命中 → 按 default_level 处理」。读类不进入 default，否则巡检/采集被误挂起）
  const write = isWriteAction(input.action);
  const level: FenceLevel = maxLevel ?? (write ? defaultLevel : "auto");
  if (maxLevel === null && write && defaultLevel !== "auto") {
    triggeredBy.push(`写类动作无规则命中 → default_level=${defaultLevel}`);
  }
  return { level, impacts, triggeredBy, evalErrors };
}

/**
 * 子调用同瀑布（F2.1/H-4）：AI–AI 子调用与普通调用走同一 judge。
 * 本函数只是语义标记 + 复用 judge——判定器无调用来源分支，即为「无后门」的代码证据。
 */
export function judgeSubCall(input: JudgeInput, rules: RuntimeRule[], defaultLevel: FenceLevel): JudgeVerdict {
  return judge(input, rules, defaultLevel);
}
