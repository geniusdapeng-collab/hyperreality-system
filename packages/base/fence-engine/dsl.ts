/**
 * fence-engine · 围栏包 YAML DSL 装载与单调守卫（F2.3/F2.4/L2.5）
 *
 *  - loadFencePack：YAML → zod 校验 → RuntimeRule[]（装载期校验不合法即拒，L2.5）
 *  - checkMonotonic：对 is_baseline 规则的 patch 只可加严不可放宽（F2.3 单调守卫）
 *    加严定义：level 严格度不降（auto→review→block 方向）；规则不得被删除/降级
 *    拒绝即返回留痕数据（调用方写 fence.patch_rejected 事件，H-3）
 */
import YAML from "yaml";
import { z } from "zod";
import type { FenceLevel, RuntimeRule } from "./judge.js";
import { registerWriteActions } from "../workdata/gateway.js";

/* ---------- YAML 装载（L2.5：schema 校验先行） ---------- */

const RuleSchema = z.object({
  // 出厂包存在两种命名：底座/酒店 `R1`，行业包 `R-PM1` / `R-PL4`（统一装载口径）
  rule_id: z.string().regex(/^R(?:-[A-Z0-9]+)?[0-9]+$/i, "rule_id 形如 R1 / R-PM1"),
  name: z.string().min(1),
  level: z.enum(["auto", "review", "block"]),
  // 行业围栏包（*-baseline.yml）里的规则默认即基线（只可加严）；显式 false 才退出基线保护
  is_baseline: z.boolean().default(true),
  match: z.object({
    object_types: z.array(z.string().min(1)).min(1),
    actions: z.array(z.string().min(1)).min(1),
  }),
  when: z.string().default(""),
  note: z.string().optional(),
});

const PackSchema = z
  .object({
    version: z.string().min(1),
    default_level: z.enum(["auto", "review", "block"]),
    rules: z.array(RuleSchema).min(1).optional(),
    // 出厂包顶层键双形态：hotel 用 `rules:`，ai-pm / platform 用 `fences:`（HP-02 统一）
    fences: z.array(RuleSchema).min(1).optional(),
  })
  // HP-02：rule_id 是规则身份（单调守卫、dry-run、fence_rules 行 id 都由它派生）。
  // 允许重复会让「按 rule_id 取规则」的调用点静默拿到任意一条（checkMonotonic 的 Map 只留最后一条），
  // 违反 L2.5「装载期校验不合法即拒」。
  .superRefine((pack, ctx) => {
    const list = pack.rules ?? pack.fences;
    if (!list) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rules"],
        message: "围栏包缺少 rules 或 fences 规则数组",
      });
      return;
    }
    const seen = new Set<string>();
    list.forEach((rule, index) => {
      if (seen.has(rule.rule_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "rule_id"],
          message: `rule_id 重复：${rule.rule_id}（规则身份必须唯一，否则单调守卫与 dry-run 会作用在错误的规则上）`,
        });
      }
      seen.add(rule.rule_id);
    });
  });

export interface FencePack {
  version: string;
  defaultLevel: FenceLevel;
  rules: RuntimeRule[];
}

/** 松散规则行（未走 zod 的消费方使用：装配校验、覆盖层视图、rebase 判定） */
export interface LooseFenceRule {
  rule_id?: unknown;
  name?: unknown;
  level?: unknown;
  is_baseline?: unknown;
  when?: unknown;
  match?: unknown;
  [key: string]: unknown;
}

/**
 * 统一读取围栏包内的规则数组（HP-02）：出厂包存在 `rules:` 与 `fences:` 两种顶层键，
 * 历史上三处消费方（DSL 装载器 / 装配校验 / 两个种子脚本）各写各的口径，
 * 导致同一份包在不同链路里"规则数不同、规则看不见"。本函数是唯一读取口径。
 */
export function fenceRulesOf(pack: unknown): LooseFenceRule[] {
  if (!pack || typeof pack !== "object") return [];
  const p = pack as { rules?: unknown; fences?: unknown };
  const arr = Array.isArray(p.rules) ? p.rules : Array.isArray(p.fences) ? p.fences : [];
  return arr.filter((r): r is LooseFenceRule => Boolean(r && typeof r === "object"));
}

/** 装载围栏包：YAML 文本 → 校验 → 运行时形态（不合法抛错，装载即失败） */
export function loadFencePack(yamlText: string): FencePack {
  const raw = YAML.parse(yamlText);
  const pack = PackSchema.parse(raw);
  const list = pack.rules ?? pack.fences ?? [];
  const rules: RuntimeRule[] = list.map((r) => ({
      rule_id: r.rule_id,
      version: pack.version,
      name: r.name,
      level: r.level,
      is_baseline: r.is_baseline,
      objectTypes: r.match.object_types,
      actions: r.match.actions,
      when: r.when,
    }));
  // HP-02：装载即登记本包声明的写类动作。gateway 段①（F2.10 未声明 fence_bindings 禁写）与
  // judge 的 default_level 兜底都以 isWriteAction 为前提；此前 registerWriteActions 只有测试调用，
  // 行业写类动作（如酒店 order.reconcile、电商 ads.budget.adjust）被当成读类 → 权限校验放行 + 判定器误判 auto。
  registerWriteActions(rules.flatMap((rule) => rule.actions));
  return { version: pack.version, defaultLevel: pack.default_level, rules };
}

/* ---------- 单调守卫（F2.3） ---------- */

const STRICTNESS: Record<FenceLevel, number> = { auto: 0, review: 1, block: 2 };

export interface MonotonicViolation {
  rule_id: string;
  reason: string;
}

export interface MonotonicResult {
  ok: boolean;
  violations: MonotonicViolation[];
}

export interface MonotonicOptions {
  /**
   * 是否允许改写基线规则的 when 条件（默认拒绝）。
   * 条件语义无法静态证明不放宽；只有调用方已持有 dry-run 回放 + 人工确认证据（L2.4）
   * 时才可显式放行，放行事实应由调用方以 fence.patch 事件留痕（H-3）。
   */
  allowWhenChange?: boolean;
}

/**
 * 校验 patch（候选规则集）相对当前生效规则集是否单调加严。
 * 口径：
 *  - 基线规则（is_baseline）在 patch 中必须保留且 is_baseline 仍为 true
 *  - 基线 level 只可加严（STRICTNESS 不降）
 *  - 基线 match 作用域只可扩大：objectTypes / actions 不得丢失既有取值（收窄=静默失效面，HP-02）
 *  - 基线 when 默认不可改写（fail-closed，须 dry-run 证据 + allowWhenChange 显式放行，HP-02）
 *  - 非基线规则自由演进（版本化由 fence_rules 表承载，F2.4）
 */
export function checkMonotonic(
  current: RuntimeRule[],
  patch: RuntimeRule[],
  opts: MonotonicOptions = {},
): MonotonicResult {
  const violations: MonotonicViolation[] = [];
  // patch 内重复 rule_id 一律拒绝：Map 只留最后一条，重复会让比对对象静默漂移
  // （装载期已拦一道，但调用方可以直接构造 patch —— 校验入口必须自洽）。
  const patchById = new Map<string, RuntimeRule>();
  for (const rule of patch) {
    if (patchById.has(rule.rule_id)) {
      violations.push({ rule_id: rule.rule_id, reason: `patch 内 rule_id ${rule.rule_id} 重复（禁止）` });
      continue;
    }
    patchById.set(rule.rule_id, rule);
  }
  for (const cur of current) {
    if (!cur.is_baseline) continue;
    const next = patchById.get(cur.rule_id);
    if (!next) {
      violations.push({ rule_id: cur.rule_id, reason: `基线规则 ${cur.rule_id} 在 patch 中被删除（禁止）` });
      continue;
    }
    if (!next.is_baseline) {
      violations.push({ rule_id: cur.rule_id, reason: `基线规则 ${cur.rule_id} 被取消 is_baseline 标记（禁止）` });
    }
    if (STRICTNESS[next.level] < STRICTNESS[cur.level]) {
      violations.push({
        rule_id: cur.rule_id,
        reason: `基线规则 ${cur.rule_id} level 被放宽：${cur.level} → ${next.level}（只可加严）`,
      });
    }
    // HP-02：match 作用域只可扩大。收窄（丢掉对象类型/动作）会让基线规则在实际调用里永不命中，
    // 等价于删除规则——此前只校验 rule_id 存在与 level 不降，留下静默失效面。
    for (const field of ["objectTypes", "actions"] as const) {
      const lost = cur[field].filter((v) => !next[field].includes(v));
      if (lost.length > 0) {
        violations.push({
          rule_id: cur.rule_id,
          reason: `基线规则 ${cur.rule_id} ${field} 被收窄，丢失 ${lost.join("、")}（只可扩大匹配范围）`,
        });
      }
    }
    // HP-02：when 改写默认按放宽处理（fail-closed）。
    if (next.when !== cur.when && !opts.allowWhenChange) {
      violations.push({
        rule_id: cur.rule_id,
        reason:
          `基线规则 ${cur.rule_id} when 被改写（${cur.when || "空"} → ${next.when || "空"}）：` +
          "条件语义无法静态证明不放宽，须先 dry-run 回放 + 人工确认（L2.4）后，在 fence.confirmDryRun 显式传 allowWhenChange=true 放行",
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 单条候选规则 vs 当前生效基线（HP-02：提案/激活路径的守卫入口）。
 * checkMonotonic 是"整包 patch"口径，会把不在 patch 里的基线判为删除；
 * 而提案/激活一次只提交一条候选，因此这里只取同 rule_id 的基线做单条比对。
 * 候选行本身不是基线，比对时按"继承基线身份"处理，只校验 level / when / 覆盖集是否被放宽。
 *
 * MC-109：锚点取"同 rule_id 当前 active 中最严的一条"，不再只认 is_baseline 行。
 * 覆盖层模型下同一 rule_id 可以同时有平台基线行与客户覆盖行（judge 取最严并集），
 * 若只认 is_baseline 行，一旦基线行被 rolled_back（历史实现会把基线行一起回滚），
 * 或客户先自定义一次再提第二次变更，守卫就找不到锚点而直接放行——"只可加严"失效。
 */
export function checkCandidateAgainstBaseline(
  current: RuntimeRule[],
  candidate: RuntimeRule,
  opts: MonotonicOptions = {},
): MonotonicResult {
  const sameRule = current.filter((r) => r.rule_id === candidate.rule_id);
  if (sameRule.length === 0) return { ok: true, violations: [] };
  // 同严度时优先平台基线行（is_baseline=true）：其 when/覆盖集是出厂口径，比对更稳定
  const anchor = sameRule.reduce((acc, row) => {
    const delta = STRICTNESS[row.level] - STRICTNESS[acc.level];
    if (delta > 0) return row;
    if (delta < 0) return acc;
    return row.is_baseline && !acc.is_baseline ? row : acc;
  });
  // 锚点统一按"基线身份"参与比对（覆盖行本身 is_baseline=false，但它是当前生效下界，
  // checkMonotonic 只对 is_baseline 行做单调校验，故此处显式抬高锚点身份）。
  return checkMonotonic([{ ...anchor, is_baseline: true }], [{ ...candidate, is_baseline: true }], opts);
}
