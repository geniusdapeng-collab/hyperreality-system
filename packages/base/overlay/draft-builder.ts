/**
 * 租户覆盖层 · L1 配置层对接（M3-2）
 * 「客户说人话，AI 结构化，系统来落地」的最后一公里：
 * 接待班/小织把客户的自然语言诉求澄清为结构化意图（L1 产物），
 * 本模块负责：意图 → 覆盖项草稿（类型安全转换）→ 语义校验 → 存草稿 →（可选）直接进流水线。
 * 设计纪律：
 *  - 意图白名单六种（tone/faq/threshold/crew/skill/brand）——AI 只能在这些槽位里填，防"创意越界"；
 *  - 每条意图都经 parseOverlay 全量校验，越界即拒（与手工编辑同一道闸）；
 *  - 生成的草稿一律带 source: "l1-intake" 溯源标记，账本可查"这句话是谁说进来的"。
 */
import { z } from "zod";
import { parseOverlay, type OverlayDoc, type OverlayItem } from "./model.js";
import { saveDraft, type OverlayScope } from "./store.js";
import type { Queryable } from "./pipeline.js";

/** L1 结构化意图（AI 澄清产物；kind 白名单六种） */
export const L1IntentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tone"),
    /** 例："对带孩子的家庭更亲切一些" → AI 结构化后的完整话术风格描述 */
    tone: z.string().min(2).max(500),
  }),
  z.object({
    kind: z.literal("faq"),
    question: z.string().min(2).max(200),
    answer: z.string().min(2).max(2000),
  }),
  z.object({
    kind: z.literal("threshold"),
    /** 例：approval/refund-credits（阈值键） */
    key: z.string().min(1),
    value: z.number(),
    /** 基座允许区间（AI 从阈值目录读出后填入，模型层校验 value 在界内） */
    bounds: z.object({ min: z.number(), max: z.number() }),
  }),
  z.object({
    kind: z.literal("crew"),
    preset_key: z.string().regex(/^[a-z0-9-]+$/),
    /** true=停用该员工；false/缺省=启用 */
    disable: z.boolean().optional(),
    /** 参数微调（只允许改参数，不允许新增员工——新增走 L3 生成层） */
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("skill"),
    name: z.string().regex(/^[a-z0-9-]+$/),
    /** true=停用 */
    disable: z.boolean(),
  }),
  z.object({
    kind: z.literal("brand"),
    /** 数字人名字（mate-name）/ 品牌名（name）/ 主题（theme）/ logo */
    field: z.enum(["name", "logo", "theme", "mate-name"]),
    value: z.string().min(1).max(200),
  }),
]);
export type L1Intent = z.infer<typeof L1IntentSchema>;

/** 意图 → 覆盖项（纯函数，可单测） */
export function intentToItems(intent: L1Intent): OverlayItem[] {
  switch (intent.kind) {
    case "tone":
      return [{ type: "persona", op: "override", path: "service-front/tone", value: intent.tone }];
    case "faq":
      return [{
        type: "kb", op: "append", path: "faq",
        value: { q: intent.question, a: intent.answer, source: "l1-intake" },
      }];
    case "threshold":
      return [{
        type: "threshold", op: "override", path: intent.key,
        value: intent.value, bounds: intent.bounds,
      }];
    case "crew": {
      const items: OverlayItem[] = [];
      if (intent.disable) items.push({ type: "crew", op: "disable", path: `presets/${intent.preset_key}` });
      if (intent.params) items.push({ type: "crew", op: "params", path: `presets/${intent.preset_key}`, value: intent.params });
      return items;
    }
    case "skill":
      return intent.disable
        ? [{ type: "skill", op: "disable", path: `skills/${intent.name}` }]
        : [{ type: "skill", op: "params", path: `skills/${intent.name}`, value: { enabled: true } }];
    case "brand":
      return [{ type: "brand", op: "override", path: intent.field, value: intent.value }];
  }
}

export class L1IntakeError extends Error {
  constructor(message: string, readonly code: "EMPTY" | "INVALID") { super(message); this.name = "L1IntakeError"; }
}

/** 多条意图 → 覆盖层草稿（合并、全量校验；与手工编辑同一道闸） */
export function buildDraftFromIntents(
  scope: OverlayScope, baseBundle: string, baseVersion: string, intents: L1Intent[],
  opts?: { note?: string; canaryScope?: OverlayDoc["canary_scope"] },
): Omit<OverlayDoc, "overlay_version" | "status"> {
  if (intents.length === 0) throw new L1IntakeError("意图列表为空", "EMPTY");
  const parsed = intents.map((i) => L1IntentSchema.parse(i));
  const items = parsed.flatMap(intentToItems);
  // 与手工编辑同一道闸：parseOverlay 语义校验（边界/围栏纪律/canary 纪律）全量过
  return parseOverlay({
    tenant_id: scope.tenantId,
    base_bundle: baseBundle,
    base_version: baseVersion,
    overlay_version: 1, // 占位（saveDraft 会分配真实版本号）
    status: "draft",
    canary_scope: opts?.canaryScope,
    items,
    note: opts?.note ?? `L1 自然语言录入（${intents.length} 条意图）`,
  });
}

/** L1 落库：意图 → 校验 → 存草稿（返回可进流水线的版本号） */
export async function ingestL1(
  q: Queryable, scope: OverlayScope, baseBundle: string, baseVersion: string,
  intents: L1Intent[], opts?: { note?: string; createdBy?: string; canaryScope?: OverlayDoc["canary_scope"] },
): Promise<OverlayDoc> {
  const draft = buildDraftFromIntents(scope, baseBundle, baseVersion, intents, opts);
  return saveDraft(q, scope, { ...draft, createdBy: opts?.createdBy });
}
