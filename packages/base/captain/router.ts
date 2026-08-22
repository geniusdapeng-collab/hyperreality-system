/**
 * base/captain · 五级审批路由 + 公司CEO 裁决策略（D21，方案 §三）
 *
 * 路由（纯函数）：review 级审批行创建时定 tier——
 *   L4 董事长：命中宪章必请示清单 / 超出自治边界（价格带外、超采购上限）/ 跨工作区升级 / 围栏放宽 / 宪章变更
 *   L3 集团CEO：跨工作区事项（预留；单店模型下不产生）
 *   L2 公司CEO：其余全部（原「店长级 review」的 ~90%）
 * 裁决（consumeQueue）：公司CEO 对 L2 队列按宪章自动 approve/reject/escalate，逐件附 Decision Memo 留痕。
 */
import type { Charter } from "./charter.js";
import { effectiveAutonomy } from "./charter.js";

export type ApprovalTier = "l2_captain" | "l3_fleet" | "l4_chairman";

export interface RouteInput {
  action: string;
  params: Record<string, unknown>;
  /** 命中的围栏规则 ID 列表（用于识别价格/采购等敏感域） */
  ruleIds?: string[];
  crossWorkspace?: boolean;
  /** 价格语境：调整后价格与基准价（price.adjust 类） */
  priceCtx?: { afterPrice?: number; basePrice?: number };
  amountCtx?: { amount?: number }; // 采购/退款/营销金额
  isFenceWiden?: boolean;          // 围栏放宽提案（一律 L4）
  isCharterChange?: boolean;       // 宪章变更（一律 L4）
}

export function routeTier(c: Charter, i: RouteInput): ApprovalTier {
  if (i.isFenceWiden || i.isCharterChange) return "l4_chairman";
  const a = effectiveAutonomy(c);
  // 价格越自治带 → 董事长
  if (i.priceCtx?.afterPrice !== undefined && i.priceCtx.basePrice !== undefined && i.priceCtx.basePrice > 0) {
    const ratio = i.priceCtx.afterPrice / i.priceCtx.basePrice;
    if (ratio < a.price_band[0] || ratio > a.price_band[1]) return "l4_chairman";
  }
  // 金额超自治上限 → 董事长
  if (i.amountCtx?.amount !== undefined) {
    const cap = /采购|procurement/i.test(i.action) ? a.procurement_cap : a.campaign_cap;
    if (i.amountCtx.amount > cap) return "l4_chairman";
  }
  // 跨工作区 → 集团CEO
  if (i.crossWorkspace) return "l3_fleet";
  return "l2_captain";
}

/* ================= 公司CEO 裁决策略（L2 队列消费） ================= */

export interface QueueItem {
  approvalId: string;
  eventId: string;
  action: string;
  params: Record<string, unknown>;
  ruleIds: string[];
  priceCtx?: { afterPrice?: number; basePrice?: number };
  amountCtx?: { amount?: number };
  title: string;
}

export type CeoVerdict =
  | { kind: "approve"; rationale: string }
  | { kind: "reject"; rationale: string }
  | { kind: "escalate"; rationale: string }; // 升 L4 请董事长

/** 公司CEO 裁决：宪章内放行（approve），明显越界否决（reject），拿不准/临边上浮（escalate）。
 *  保守默认：无法判明一律 escalate（拒绝默认的镜像——宁可请示不可错放）。 */
export function decideForCaptain(c: Charter, item: QueueItem): CeoVerdict {
  const a = effectiveAutonomy(c);
  // 价格类：带内 approve；贴近带缘（±2% 内）escalate 让人看一眼；带外本不该在 L2（路由保证），兜底 escalate
  if (item.priceCtx?.afterPrice !== undefined && item.priceCtx.basePrice !== undefined && item.priceCtx.basePrice > 0) {
    const ratio = item.priceCtx.afterPrice / item.priceCtx.basePrice;
    const [lo, hi] = a.price_band;
    if (ratio < lo || ratio > hi) {
      return { kind: "escalate", rationale: `价格比 ${ratio.toFixed(3)} 超出自治带 [${lo}, ${hi}]，上浮董事长` };
    }
    const edge = 0.02;
    if (ratio - lo < edge || hi - ratio < edge) {
      return { kind: "escalate", rationale: `价格比 ${ratio.toFixed(3)} 贴近自治带边缘，谨慎起见上浮复核` };
    }
    return { kind: "approve", rationale: `价格比 ${ratio.toFixed(3)} 位于自治带 [${lo}, ${hi}] 内，符合宪章` };
  }
  // 金额类：上限 70% 以内 approve，70–100% escalate（临边谨慎），超上限 escalate
  if (item.amountCtx?.amount !== undefined) {
    const cap = /采购|procurement/i.test(item.action) ? a.procurement_cap : a.campaign_cap;
    const amt = item.amountCtx.amount;
    if (amt > cap) return { kind: "escalate", rationale: `金额 ¥${amt} 超自治上限 ¥${cap}，上浮董事长` };
    if (amt > cap * 0.7) return { kind: "escalate", rationale: `金额 ¥${amt} 达上限 70% 以上，谨慎上浮复核` };
    return { kind: "approve", rationale: `金额 ¥${amt} 在自治上限 ¥${cap} 的 70% 以内，符合宪章` };
  }
  // 无判据的杂项：保守上浮（拒绝默认镜像）
  return { kind: "escalate", rationale: "无明确自治判据，按保守默认上浮董事长复核" };
}
