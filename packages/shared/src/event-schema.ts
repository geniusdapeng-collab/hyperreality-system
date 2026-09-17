/**
 * 五元事件 Schema v1（冻结）—— 对齐 PRD V2.5 附录 E
 * 铁律：v1 字段只读冻结；行业扩展仅允许在 context / object / decision 内加字段（.loose()）。
 * 编号回引：F1.1（五元写入）/ L1.4（幂等键）/ F1.1 receipt 位 / L3.6 / E3.7（回执）/ M6（model_trace）
 */
import { z } from "zod";

/** 事件编号：服务端单调递增，幂等键（L1.4），形如 E-8806 */
export const EventIdSchema = z
  .string()
  .regex(/^E-\d+$/, "event_id 必须形如 E-12345");
export type EventId = z.infer<typeof EventIdSchema>;

/** Who：谁做的。Agent 必须带 version（归因必需，IM.5 身份与归因） */
export const WhoSchema = z.looseObject({
  type: z.enum(["human", "agent", "system"]),
  id: z.string().min(1),
  version: z.string().optional(),
});
export type Who = z.infer<typeof WhoSchema>;

/** Context：租户/工作区/时间为必填；行业字段集（如 store/channel/stage）由 bundle 扩展 */
export const ContextSchema = z.looseObject({
  tenant_id: z.string().min(1),
  workspace_id: z.string().min(1),
  /** 附录 E 示例带 +08:00 偏移，须允许 offset（A5 批次修复：原 z.iso.datetime() 只认 Z） */
  time: z.iso.datetime({ offset: true }),
  channel: z.string().optional(),
  stage: z.string().optional(),
});
export type EventContext = z.infer<typeof ContextSchema>;

/** Object：对象枚举行业化（内置=价格/渠道/订单/顾客/评价/门店/员工；行业对象型由 bundle 扩展） */
export const ObjectSchema = z.looseObject({
  type: z.string().min(1),
  id: z.string().optional(),
});
export type EventObject = z.infer<typeof ObjectSchema>;

/** Decision：动作 + before/after + 依据 + 引用记忆 ID 列表（F1.4 归因闭环） */
export const DecisionSchema = z.looseObject({
  action: z.string().min(1),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  basis: z.array(z.string()).optional(),
  memory_refs: z.array(z.string()).optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/** RuleImpact：命中规则 ID + 版本 + 判定结果 */
export const RuleImpactSchema = z.object({
  rule_id: z.string().min(1),
  version: z.string().min(1),
  result: z.enum(["pass", "review", "blocked", "conflict"]),
});
export type RuleImpact = z.infer<typeof RuleImpactSchema>;

/** Receipt：执行回执位——外部系统是否生效 + 证据快照；无回执 = 未核实（L3.6/E3.7） */
export const ReceiptSchema = z.object({
  synced: z.boolean().optional(),
  snapshot_uri: z.string().optional(),
  verified_at: z.iso.datetime({ offset: true }).optional(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

/** ModelTrace：模型计量位（M6 逐事件计量，账单=事件投影 L6.3）
 *  tier 枚举兼容两代：旧两档 standard|flagship + v3.0 三档 L1|L2|L3 */
export const ModelTraceSchema = z.looseObject({
  model_id: z.string().min(1),
  tier: z.enum(["standard", "flagship", "L1", "L2", "L3", "gen"]).optional(),
  window: z.enum(["peak", "off-peak"]).optional(),
  credits: z.number().optional(),
});
export type ModelTrace = z.infer<typeof ModelTraceSchema>;

/** 五元事件完整 Schema */
export const BusinessEventSchema = z.looseObject({
  event_id: EventIdSchema,
  who: WhoSchema,
  context: ContextSchema,
  object: ObjectSchema,
  decision: DecisionSchema,
  rule_impact: z.array(RuleImpactSchema),
  receipt: ReceiptSchema.optional(),
  model_trace: ModelTraceSchema.optional(),
  /** 上游事件链（采集/记忆调用/审批引用） */
  links: z.array(z.string()).optional(),
  /** 前序事件哈希链字段，防篡改（技术新增量 A1） */
  hash: z.string().optional(),
  ts: z.iso.datetime({ offset: true }).optional(),
});
export type BusinessEvent = z.infer<typeof BusinessEventSchema>;

/** 校验入口：合法返回 parsed，非法抛出带中文说明的 ZodError */
export function parseBusinessEvent(input: unknown): BusinessEvent {
  return BusinessEventSchema.parse(input);
}

/** 安静校验：返回 { ok, issues } 而不抛出（供网关/测试用） */
export function safeParseBusinessEvent(input: unknown) {
  return BusinessEventSchema.safeParse(input);
}
