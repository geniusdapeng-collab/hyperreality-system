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
import { classifyAction } from "../workdata/gateway.js";

export type FenceLevel = "auto" | "review" | "block";
export type RuleResult = "pass" | "review" | "blocked" | "conflict";

/** 判定输入（五元事件的动作上下文快照） */
export interface JudgeInput {
  object: { type: string; id?: string };
  action: string;
  /**
   * 动作效应（HP-02）：调用方（运行时）按 preset 工具声明的 access 显式告知读/写。
   * 缺省时回落到动作分类：显式读 → 只读；显式写与**未分类**一律按写（fail-closed）。
   */
  effect?: "read" | "write";
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
 * 动作匹配（HP-02 DSL 语义，三档，命中任一即可）：
 *  ① 精确匹配：rule.actions 含 action 本身；
 *  ② 单段动作词按**动词段**匹配：`write` 命中 `kb.write` / `metrics_store.write`；
 *     单段词必须与 object_types 同时声明（否则词面过宽，由装载期/评审约束）；
 *  ③ 多段动作词按**命名空间后缀**匹配：`price.adjust` 命中 `pms.price.write` / `ota.price.write`
 *     （同域规则覆盖该域下所有工具，避免"规则写领域动词、运行时用工具名"两套词表互不命中）。
 * 该口径只放大"命中"（更严），不会让规则漏判；未命中仍走 default_level（未知写 fail-closed）。
 */
export function actionMatches(ruleAction: string, action: string, mode: "read" | "write" = "write"): boolean {
  if (ruleAction === action) return true;
  const rParts = ruleAction.split(".").filter(Boolean);
  const aParts = action.split(".").filter(Boolean);
  if (rParts.length === 0 || aParts.length === 0) return false;
  // 单段动作词按动词段匹配（读写通用）：write 命中 kb.write；read 命中 kb.read
  if (rParts.length === 1) return aParts[aParts.length - 1] === ruleAction;
  // 命名空间后缀扩展只对**写动作**生效：read 视图（如 pms.price.read / review.list）
  // 不允许被写规则的域段带出，否则只读步骤会被数值门槛规则误伤成熔断。
  if (mode === "read") return false;
  // 且只允许"工具名比规则动作多一层以上前缀"的场景（price.adjust ← pms.price.write / ota.price.write）。
  // 同深度的不同动词视为不同业务动作（order.refund ≠ order.reconcile），
  // 否则一个域里互不相干的规则会互相串味（实测：对账被"大额退款必审"误熔断）。
  if (aParts.length <= rParts.length) return false;
  const rNs = rParts.slice(0, -1);
  const aNs = aParts.slice(0, -1);
  if (rNs.length <= aNs.length
    && rNs.every((seg, i) => aNs[aNs.length - rNs.length + i] === seg)) return true;
  return false;
}

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
    const viewMode: "read" | "write" = input.effect
      ?? (classifyAction(input.action) === "read" ? "read" : "write");
    if (!rule.actions.some((a) => actionMatches(a, input.action, viewMode))) continue;
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
  // 显式 effect 优先；缺省按动作分类，**未分类按写**（HP-02：未知写不得静默 auto）
  const write = input.effect ? input.effect === "write" : classifyAction(input.action) !== "read";
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

/**
 * 多视图判定（HP-02）：同一次执行可能同时有「语义动作名」（如 price.adjust）与
 * 「工具名」（如 pms.price.write）两个标识，规则词表可能命中其一。对每个视图分别判定，
 * 取**最严**结论（block > review > auto）并合并留痕——避免 LLM 规划出的动作名绕开按工具名
 * 编写的规则，也避免规则按语义动词编写时工具名视图漏判。
 */
export function judgeViews(inputs: JudgeInput[], rules: RuntimeRule[], defaultLevel: FenceLevel): JudgeVerdict {
  const verdicts = inputs.map((input) => judge(input, rules, defaultLevel));
  const level = verdicts.reduce<FenceLevel>(
    (acc, v) => (LEVEL_RANK[v.level] > LEVEL_RANK[acc] ? v.level : acc), "auto");
  const seen = new Set<string>();
  const impacts: RuleImpact[] = [];
  for (const v of verdicts) {
    for (const impact of v.impacts) {
      const key = `${impact.rule_id}:${impact.result}`;
      if (seen.has(key)) continue;
      seen.add(key);
      impacts.push(impact);
    }
  }
  return {
    level,
    impacts,
    triggeredBy: [...new Set(verdicts.flatMap((v) => v.triggeredBy))],
    evalErrors: [...new Set(verdicts.flatMap((v) => v.evalErrors))],
  };
}
