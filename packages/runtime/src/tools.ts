/**
 * runtime · 工具执行面（F3.9 五级分层：首版走 L3 确定性剧本——生产主路径）
 * 每个工具产出 { result, receipt }；receipt 是「回执位」（L3.6/E3.7）：
 * 关键数字必须来自工具回执，无回执标「未核实」不得宣称完成。
 * 首版工具为确定性演示剧本（真实业务系统/渠道适配器进 L1/L2 层，触发条件见总纲 §7）。
 */

export interface ToolReceipt {
  synced: boolean;
  snapshot_uri?: string;
  verified_at?: string;
}

export interface ToolResult {
  result: Record<string, unknown>;
  receipt: ToolReceipt;
}

export type ToolFn = (params: Record<string, unknown>) => Promise<ToolResult>;

const ok = (result: Record<string, unknown>): ToolResult => ({
  result,
  receipt: { synced: true, snapshot_uri: `data/snapshots/${Date.now().toString(36)}.png`, verified_at: new Date().toISOString() },
});

/**
 * 架构 K 修复：mock 工具随机返回 synced:false，让 E3.7 回执校验路径在开发阶段就被走到。
 * 通过环境变量 TOOL_UNVERIFIED_RATE 控制比例（默认 0 关闭；工程混沌测试时显式设 0.1——
 *  生产/演示默认确定性，避免「3/3 完成仍 failed」的偶发；suite/demo 门禁显式置 0 同口径）。
 * 仅作用于 demo 工具，不影响真实适配器。
 */
const UNVERIFIED_RATE = Number(process.env.TOOL_UNVERIFIED_RATE ?? "0");
function maybeUnverified(result: Record<string, unknown>): ToolResult {
  if (Math.random() < UNVERIFIED_RATE) {
    return { result, receipt: { synced: false } }; // 无回执=未核实（E3.7）
  }
  return ok(result);
}

/** 确定性剧本工具表（内置演示口径；数字与种子剧本一致） */
export const DEMO_TOOLS: Record<string, ToolFn> = {
  "biz.price.read": async (p) => maybeUnverified({ object_id: p.object_id ?? "OBJ-DLX-01", current: 458, sold_7d: 126 }),
  "biz.price.write": async (p) => maybeUnverified({ object_id: p.object_id, price: p.price, applied: true }),
  "channel.price.write": async (p) => maybeUnverified({ channel: p.channel ?? "美团", price: p.price, applied: true }),
  "competitor.fetch": async () => maybeUnverified({ card: "竞品门店", price: 472, ts: new Date().toISOString() }),
  "review.list": async () => maybeUnverified({ fresh: [{ id: "RV-66413", rating: 2, channel: "评价平台", text: "设备异响影响使用" }] }),
  "review.reply": async (p) => maybeUnverified({ review_id: p.review_id, published: true }),
  "order.list": async () => maybeUnverified({ count: 37, total: 18234.5 }),
  "order.reconcile": async () => maybeUnverified({ diff: 0, rounds: 3 }),
  "refund.apply": async (p) => maybeUnverified({ order_id: p.order_id, amount: p.amount, refunded: true }),
  "content.draft": async (p) => maybeUnverified({ title: p.title ?? "秋日特惠套餐", draft_id: `CT-${Date.now().toString(36)}` }),
  "content.publish": async (p) => maybeUnverified({ title: p.title, published: true }),
  // 内容域（ai-video / geo-growth 双域经营演示口径；与种子剧本一致）
  "intel.collect": async () => maybeUnverified({ topics: [{ q: "激光切割机怎么选", heat: 1842, confidence: "confirmed", suggest: "双用" }, { q: "CE certified laser cutter China", heat: 967, confidence: "reported", suggest: "GEO 图文" }] }),
  "script.draft": async (p) => maybeUnverified({ script_id: `SC-${Date.now().toString(36)}`, shots: 3, has_ai_answer_variant: true, char_check: { withinSpec: true } }),
  "content.submit": async (p) => maybeUnverified({ submitted: true, fact_check: "passed", entity_anchors: "12/12 一致" }),
  "publish.execute": async (p) => maybeUnverified({ platform: p.platform ?? "tiktok", url: "https://example.invalid/published/001", published: true }),
  "metrics.collect": async () => maybeUnverified({ plays_24h: 21437, inquiries: 4, visibility: { mention_rate: 0.11, first_rate: 0.02 } }),
};

export async function executeTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
  const fn = DEMO_TOOLS[name];
  if (!fn) throw new Error(`工具 ${name} 未注册（演示面只含 L3 确定性剧本工具）`);
  return fn(params);
}
