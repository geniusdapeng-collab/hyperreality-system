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

/* ---------- YAML 装载（L2.5：schema 校验先行） ---------- */

const RuleSchema = z.object({
  rule_id: z.string().regex(/^R\d+$/, "rule_id 形如 R1"),
  name: z.string().min(1),
  level: z.enum(["auto", "review", "block"]),
  is_baseline: z.boolean().default(false),
  match: z.object({
    object_types: z.array(z.string().min(1)).min(1),
    actions: z.array(z.string().min(1)).min(1),
  }),
  when: z.string().default(""),
  note: z.string().optional(),
});

const PackSchema = z.object({
  version: z.string().min(1),
  default_level: z.enum(["auto", "review", "block"]),
  rules: z.array(RuleSchema).min(1),
});

export interface FencePack {
  version: string;
  defaultLevel: FenceLevel;
  rules: RuntimeRule[];
}

/** 装载围栏包：YAML 文本 → 校验 → 运行时形态（不合法抛错，装载即失败） */
export function loadFencePack(yamlText: string): FencePack {
  const raw = YAML.parse(yamlText);
  const pack = PackSchema.parse(raw);
  return {
    version: pack.version,
    defaultLevel: pack.default_level,
    rules: pack.rules.map((r) => ({
      rule_id: r.rule_id,
      version: pack.version,
      name: r.name,
      level: r.level,
      is_baseline: r.is_baseline,
      objectTypes: r.match.object_types,
      actions: r.match.actions,
      when: r.when,
    })),
  };
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

/**
 * 校验 patch（候选规则集）相对当前生效规则集是否单调加严。
 * 口径：
 *  - 基线规则（is_baseline）在 patch 中必须保留且 is_baseline 仍为 true
 *  - 基线 level 只可加严（STRICTNESS 不降）
 *  - 非基线规则自由演进（版本化由 fence_rules 表承载，F2.4）
 */
export function checkMonotonic(current: RuntimeRule[], patch: RuntimeRule[]): MonotonicResult {
  const violations: MonotonicViolation[] = [];
  const patchById = new Map(patch.map((r) => [r.rule_id, r]));
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
  }
  return { ok: violations.length === 0, violations };
}
