/**
 * overlay/model.ts —— 租户覆盖层（Tenant Overlay）类型系统与校验
 *
 * 方案 V1.1（对焦确认 2026-09-07）：七类资产全量 / DB 为主+可导出 /
 * 围栏只收紧禁放宽 / 草稿→考试→灰度→全量→回滚完整流水线。
 *
 * 铁律：叠加不分叉（Overlay, never Fork）——覆盖层是七类结构化资产的
 * 「覆盖声明」，白名单之外一律不可覆盖（围栏红线/账本/考试院/积分底层）。
 */
import { z } from "zod";

/* ================= 围栏严格度（与 fence-engine/dsl 对齐：auto→review→block） ================= */
export const FENCE_LEVELS = ["auto", "review", "block"] as const;
export type FenceLevel = (typeof FENCE_LEVELS)[number];
export const FENCE_STRICTNESS: Record<FenceLevel, number> = { auto: 0, review: 1, block: 2 };

/* ================= 覆盖层状态机（完整流水线） ================= */
export const OVERLAY_STATUS = ["draft", "canary", "active", "rolled_back"] as const;
export type OverlayStatus = (typeof OVERLAY_STATUS)[number];

/* ================= 七类覆盖声明（判别联合） ================= */

/** ① 话术与人格：覆盖（override） */
export const personaItem = z.object({
  type: z.literal("persona"),
  op: z.literal("override"),
  /** 例：service-front/tone、persona/style */
  path: z.string().min(1),
  value: z.string().min(1),
});

/** ② 知识：增 / 改 / 删（墓碑） */
export const kbItem = z.discriminatedUnion("op", [
  z.object({
    type: z.literal("kb"),
    op: z.literal("append"),
    /** 集合路径，例：faq、service-catalog */
    path: z.string().min(1),
    value: z.object({ q: z.string().min(1), a: z.string().min(1) }).passthrough(),
  }),
  z.object({
    type: z.literal("kb"),
    op: z.literal("override"),
    /** 条目路径，例：faq/standard-041（按 id 覆盖） */
    path: z.string().min(1),
    value: z.object({ q: z.string().min(1), a: z.string().min(1) }).partial().passthrough(),
  }),
  z.object({
    type: z.literal("kb"),
    op: z.literal("tombstone"),
    /** 条目路径，例：faq/standard-041 */
    path: z.string().min(1),
  }),
]);

/** ③ 编制：成员级开关/参数微调（不允许新增 preset——新增走 L3 生成层） */
export const crewItem = z.discriminatedUnion("op", [
  z.object({
    type: z.literal("crew"),
    op: z.literal("disable"),
    /** 例：presets/marketing-officer */
    path: z.string().regex(/^presets\/[a-z0-9-]+$/),
  }),
  z.object({
    type: z.literal("crew"),
    op: z.literal("params"),
    path: z.string().regex(/^presets\/[a-z0-9-]+$/),
    value: z.record(z.string(), z.unknown()),
  }),
]);

/** ④ 阈值与规则：覆盖 + 边界校验（不得超出基座允许区间） */
export const thresholdItem = z.object({
  type: z.literal("threshold"),
  op: z.literal("override"),
  /** 例：approval/refund-credits、sla/first-response-min */
  path: z.string().min(1),
  value: z.number(),
  bounds: z.object({ min: z.number(), max: z.number() }),
});

/** ⑤ 技能：开关 / 参数默认值（自定义技能挂接必须已过考试院硬轨） */
export const skillItem = z.discriminatedUnion("op", [
  z.object({
    type: z.literal("skill"),
    op: z.literal("disable"),
    /** 例：skills/marketing-auto */
    path: z.string().regex(/^skills\/[a-z0-9-]+$/),
  }),
  z.object({
    type: z.literal("skill"),
    op: z.literal("params"),
    path: z.string().regex(/^skills\/[a-z0-9-]+$/),
    value: z.record(z.string(), z.unknown()),
  }),
]);

/** ⑥ 围栏调整：只允许收紧（strictness 必须上升），block 级不可调 */
export const fenceItem = z.object({
  type: z.literal("fence"),
  op: z.literal("tighten"),
  /** 例：fences/R-MK2（行业包规则 rule_id） */
  path: z.string().regex(/^fences\/[A-Z0-9-]+$/i),
  from: z.enum(FENCE_LEVELS),
  to: z.enum(FENCE_LEVELS),
});

/** ⑦ 品牌外观：覆盖 */
export const brandItem = z.object({
  type: z.literal("brand"),
  op: z.literal("override"),
  /** 例：name、logo、theme、mate-name */
  path: z.enum(["name", "logo", "theme", "mate-name"]),
  value: z.string().min(1),
});

export const overlayItem = z.discriminatedUnion("type", [
  personaItem, kbItem, crewItem, thresholdItem, skillItem, fenceItem, brandItem,
]);
export type OverlayItem = z.infer<typeof overlayItem>;

/* ================= 覆盖层文档 ================= */
export const overlayDoc = z.object({
  tenant_id: z.string().min(1),
  base_bundle: z.string().min(1),
  /** 对齐的行业包版本（rebase 锚点） */
  base_version: z.string().min(1),
  /** 覆盖层自身版本号（每次变更 +1，单调递增） */
  overlay_version: z.number().int().positive(),
  status: z.enum(OVERLAY_STATUS),
  /** 灰度范围（status=canary 时生效）：如 { scenes:["night"], ratio:0.1 } */
  canary_scope: z.object({
    scenes: z.array(z.string()).optional(),
    ratio: z.number().min(0).max(1).optional(),
    note: z.string().optional(),
  }).optional(),
  items: z.array(overlayItem),
  note: z.string().optional(),
});
export type OverlayDoc = z.infer<typeof overlayDoc>;

/* ================= 校验错误 ================= */
export class OverlayError extends Error {
  constructor(
    public code:
      | "SCHEMA" | "FENCE_LOOSEN" | "FENCE_BLOCK_IMMUTABLE" | "FENCE_FROM_MISMATCH"
      | "THRESHOLD_OUT_OF_BOUNDS" | "PATH_NOT_FOUND" | "PRESET_NOT_FOUND"
      | "SKILL_NOT_FOUND" | "KB_ITEM_NOT_FOUND" | "STATUS_ILLEGAL",
    message: string,
  ) { super(message); this.name = "OverlayError"; }
}

/**
 * 跨字段校验（schema 之上的语义规则）：
 * - 围栏 tighten：to 的严格度必须高于 from；from=block 禁止（block 不可调）
 * - 阈值：value 必须在 bounds 内
 * - canary 状态必须带 canary_scope
 */
export function validateOverlay(doc: OverlayDoc): OverlayDoc {
  for (const it of doc.items) {
    if (it.type === "fence") {
      if (it.from === "block") {
        throw new OverlayError("FENCE_BLOCK_IMMUTABLE",
          `围栏 ${it.path} 当前为 block 级——红线不可调（只能保持，不能修改）`);
      }
      if (FENCE_STRICTNESS[it.to] <= FENCE_STRICTNESS[it.from]) {
        throw new OverlayError("FENCE_LOOSEN",
          `围栏 ${it.path} 只允许收紧（${it.from}→更严），拒绝放宽为 ${it.to}`);
      }
    }
    if (it.type === "threshold" && (it.value < it.bounds.min || it.value > it.bounds.max)) {
      throw new OverlayError("THRESHOLD_OUT_OF_BOUNDS",
        `阈值 ${it.path}=${it.value} 超出基座允许区间 [${it.bounds.min}, ${it.bounds.max}]`);
    }
  }
  if (doc.status === "canary" && !doc.canary_scope) {
    throw new OverlayError("STATUS_ILLEGAL", "status=canary 必须携带 canary_scope 灰度范围");
  }
  return doc;
}

/** 解析 + 语义校验（入口函数） */
export function parseOverlay(raw: unknown): OverlayDoc {
  return validateOverlay(overlayDoc.parse(raw));
}

/** 不可覆盖路径保护（保护清单延伸）：命中即拒绝 */
const FORBIDDEN_PATHS = [
  /^fences\/R-PL4$/i, /^fences\/R-PL10$/i,   // 平台红线示例（数据出库/触达频控）
  /^ledger\//, /^hash-chain\//, /^eval\//, /^exam\//,
  /^credits\/(pool|ledger)/, /^sync\//,
];
export function assertPathAllowed(path: string): void {
  for (const re of FORBIDDEN_PATHS) {
    if (re.test(path)) {
      throw new OverlayError("PATH_NOT_FOUND",
        `路径 ${path} 属不可覆盖清单（围栏红线/账本/考试院/积分底层/同步机制），覆盖被拒绝`);
    }
  }
}
