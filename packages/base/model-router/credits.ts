/**
 * model-router · 积分计量与三池账本（v3.0 第三部分·换算关系落码）
 *
 * 计量锚点：1 积分 = 1,000 tokens（L2 基准）
 *   单次消耗 = tokens/1000 × 档位倍率（L1 0.2 / L2 1.0 / L3 3.0）× 峰谷系数（谷时 ×0.2）
 * 三池账本：赠送（1 个月有效）→ 加油包（6 个月）→ 本金（不过期），先扣先到期；
 *   账本 = 事件投影（credits.grant/credits.purchase 入，model.call 计量出），不重算（L6.3 同纪律）。
 */
import { OFF_PEAK_RATE_RATIO } from "@workloom/shared";
import { TIER_MULTIPLIER, type Tier3 } from "./policy.js";
import type { Window } from "./router.js";

/** 单次调用积分（精度 0.0001；下限 0.01 保证任何真实调用可计量） */
export function computeCredits(args: {
  tier: Tier3; promptTokens: number; completionTokens: number; window: Window;
}): number {
  const base = (args.promptTokens + args.completionTokens) / 1000;
  const rate = args.window === "off-peak" ? OFF_PEAK_RATE_RATIO : 1;
  const credits = base * TIER_MULTIPLIER[args.tier] * rate;
  return Math.max(0.01, Math.round(credits * 10000) / 10000);
}

/* ================= 三池账本（纯函数；存储走事件投影） ================= */

export type PoolName = "gift" | "pack" | "principal";

export interface CreditPool {
  name: PoolName;
  amount: number;
  /** ISO 时间；null = 不过期（本金池） */
  expiresAt: string | null;
}

/** 扣减顺序即数组顺序：gift → pack → principal（先扣先到期） */
export type CreditLedger = CreditPool[];

export interface DeductResult {
  ledger: CreditLedger;
  /** 各池实际扣减明细（留痕用） */
  deductions: Array<{ pool: PoolName; amount: number }>;
  /** 余额不足缺口（>0 即欠费；调用方决定挂起或降级） */
  shortfall: number;
}

export function deduct(ledger: CreditLedger, amount: number, now = new Date()): DeductResult {
  let remain = amount;
  const deductions: DeductResult["deductions"] = [];
  const next = ledger.map((p) => {
    // 过期池视为冻结（不扣、不删，审计可见）
    if (p.expiresAt && new Date(p.expiresAt) <= now) return { ...p };
    const take = Math.min(p.amount, remain);
    if (take > 0) deductions.push({ pool: p.name, amount: round4(take) });
    remain -= take;
    return { ...p, amount: round4(p.amount - take) };
  });
  return { ledger: next, deductions, shortfall: round4(Math.max(0, remain)) };
}

export function balance(ledger: CreditLedger, now = new Date()): number {
  return round4(ledger
    .filter((p) => !p.expiresAt || new Date(p.expiresAt) > now)
    .reduce((s, p) => s + p.amount, 0));
}

/* ================= 事件投影 → 账本（账单=事件投影，不重算） ================= */

export interface CreditEvent {
  action: string;
  after?: Record<string, unknown>;
  model_trace?: { credits?: number };
  time?: string;
}

/** 赠送/加油包有效期（发行纪律：赠送 1 个月、加油包 6 个月、本金不过期） */
export const POOL_TTL_DAYS: Record<PoolName, number | null> = { gift: 30, pack: 180, principal: null };

/**
 * 从事件流投影三池账本：
 *   credits.grant（赠送，after {amount}）/ credits.purchase（after {amount, pool: pack|principal}）入池；
 *   model.call（model_trace.credits）按扣减顺序出账。
 */
export function projectLedger(events: CreditEvent[], now = new Date()): CreditLedger {
  let ledger: CreditLedger = [];
  for (const e of events) {
    if (e.action === "credits.grant" || e.action === "credits.purchase") {
      const amount = Number(e.after?.amount ?? 0);
      if (amount <= 0) continue;
      const pool: PoolName = e.action === "credits.grant"
        ? "gift"
        : (e.after?.pool === "principal" ? "principal" : "pack");
      ledger = grant(ledger, pool, amount, e.time ? new Date(e.time) : now);
    } else if (e.action === "model.call" && e.model_trace?.credits) {
      // 平台成本场景（售前体检报告 bill_to=platform）不扣客户积分（5.6 获客补贴）
      if (e.after?.bill_to === "platform") continue;
      ledger = deduct(ledger, e.model_trace.credits, now).ledger;
    }
  }
  return ledger;
}

/** 入池（合并同名且同到期的池；有效期按发行纪律自动计算） */
export function grant(ledger: CreditLedger, pool: PoolName, amount: number, at = new Date()): CreditLedger {
  const ttl = POOL_TTL_DAYS[pool];
  const expiresAt = ttl === null ? null : new Date(at.getTime() + ttl * 86_400_000).toISOString();
  const existing = ledger.find((p) => p.name === pool && p.expiresAt === expiresAt);
  const next = existing
    ? ledger.map((p) => (p === existing ? { ...p, amount: round4(p.amount + amount) } : p))
    : [...ledger, { name: pool, amount: round4(amount), expiresAt }];
  // 维持扣减顺序 gift → pack → principal
  const order: PoolName[] = ["gift", "pack", "principal"];
  return next.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
