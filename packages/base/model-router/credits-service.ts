/**
 * model-router · 积分账本服务（v3.0 商业化 P1：加油包购买链路 + 三池余额产品化）
 *
 * 发行纪律（方案 1.6）：
 *   赠送池 gift（套餐月赠，30 天有效）/ 加油包池 pack（180 天）/ 本金池 principal（不过期）；
 *   入账 = credits.grant / credits.purchase 事件；出账 = model.call 逐事件计量（bill_to=platform 不扣）；
 *   余额 = 事件投影，不重算（L6.3 同纪律）；扣减顺序 gift → pack → principal（先扣先到期）。
 */
import type pg from "pg";
import { gatewayAppend } from "../workdata/gateway.js";
import {
  balance, projectLedger, type CreditLedger, type PoolName,
} from "./credits.js";

/* ================= 加油包价目（方案 5.5：五档阶梯，有效期 6 个月） ================= */

export interface CreditPack {
  id: string;
  credits: number;
  priceYuan: number;
  /** 单积分成本（元），展示用 */
  unitPrice: number;
}

export const CREDIT_PACKS: readonly CreditPack[] = [
  { id: "pack-5k", credits: 5_000, priceYuan: 450, unitPrice: 0.09 },
  { id: "pack-20k", credits: 20_000, priceYuan: 1_680, unitPrice: 0.084 },
  { id: "pack-50k", credits: 50_000, priceYuan: 3_900, unitPrice: 0.078 },
  { id: "pack-100k", credits: 100_000, priceYuan: 7_200, unitPrice: 0.072 },
  { id: "pack-200k", credits: 200_000, priceYuan: 13_800, unitPrice: 0.069 },
] as const;

/** 预充值最低档（方案 5.1：2 万积分起充） */
export const MIN_PURCHASE_CREDITS = 20_000;

interface Scope { tenantId: string; workspaceId: string }

/* ================= 入账（事件化，append-only） ================= */

/** 购买加油包/充值本金：credits.purchase 事件入账（支付对接为外部职责，本服务负责可信入账留痕） */
export async function purchaseCredits(
  gateway: pg.Pool,
  scope: Scope,
  input: { packId?: string; amount?: number; pool?: "pack" | "principal"; orderRef?: string; by: string },
): Promise<{ eventId: string; pack: CreditPack | null; amount: number; pool: PoolName }> {
  let amount: number;
  let pool: PoolName;
  let pack: CreditPack | null = null;
  if (input.packId) {
    pack = CREDIT_PACKS.find((p) => p.id === input.packId) ?? null;
    if (!pack) throw new Error(`未知加油包档位：${input.packId}`);
    amount = pack.credits;
    pool = "pack";
  } else {
    amount = Number(input.amount ?? 0);
    if (!Number.isFinite(amount) || amount < MIN_PURCHASE_CREDITS) {
      throw new Error(`充值最低 ${MIN_PURCHASE_CREDITS} 积分起（预充值纪律）`);
    }
    pool = input.pool ?? "principal";
  }
  const r = await gatewayAppend(gateway, { ...scope, actor: { id: input.by, type: "human" } }, {
    who: { type: "human", id: input.by },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "store", id: scope.workspaceId },
    decision: {
      action: "credits.purchase",
      after: {
        amount, pool, pack_id: pack?.id ?? null, price_yuan: pack?.priceYuan ?? null,
        order_ref: input.orderRef ?? null,
      },
      basis: ["v3.0 加油包/充值入账（三池：赠送→加油包→本金，先扣先到期）"],
    },
    rule_impact: [],
  });
  return { eventId: r.eventId, pack, amount, pool };
}

/** 套餐赠送入账：credits.grant 事件（系统动作；月赠/活动赠送/签到类运营赠送） */
export async function grantCredits(
  gateway: pg.Pool,
  scope: Scope,
  input: { amount: number; reason: string; by?: string },
): Promise<{ eventId: string }> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("赠送积分必须为正数");
  const r = await gatewayAppend(gateway, { ...scope, actor: { id: input.by ?? "credits-service", type: "system" } }, {
    who: { type: "system", id: input.by ?? "credits-service" },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
    object: { type: "store", id: scope.workspaceId },
    decision: {
      action: "credits.grant",
      after: { amount: input.amount, reason: input.reason },
      basis: ["v3.0 套餐赠送/运营赠送入账（gift 池 30 天有效）"],
    },
    rule_impact: [],
  });
  return { eventId: r.eventId };
}

/* ================= 余额与流水（事件投影，不重算） ================= */

export interface LedgerView {
  pools: CreditLedger;
  balance: number;
  totals: { granted: number; purchased: number; consumed: number; platformSubsidy: number };
  recent: Array<{ action: string; amount: number; detail: string; time: string }>;
}

/** 三池账本视图：从事件库投影（RLS 属地；近 20 条流水倒序展示） */
export async function ledgerOf(app: pg.Pool, scope: Scope): Promise<LedgerView> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置（编码铁律）
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const rows = await client.query<{
      payload: {
        decision?: { action?: string; after?: Record<string, unknown> };
        model_trace?: { credits?: number };
        context?: { time?: string };
      };
    }>(
      `SELECT payload FROM biz_events
       WHERE workspace_id=$1 AND payload->'decision'->>'action' IN ('credits.grant','credits.purchase','model.call')
       ORDER BY seq ASC`,
      [scope.workspaceId],
    );
    await client.query("COMMIT");
    const events = rows.rows.map((r) => ({
      action: r.payload.decision?.action ?? "",
      after: r.payload.decision?.after,
      model_trace: r.payload.model_trace,
      time: r.payload.context?.time,
    }));
    const ledger = projectLedger(events);
    let granted = 0; let purchased = 0; let consumed = 0; let platformSubsidy = 0;
    const recent: LedgerView["recent"] = [];
    for (const e of events) {
      if (e.action === "credits.grant") {
        const amt = Number(e.after?.amount ?? 0); granted += amt;
        recent.push({ action: "grant", amount: amt, detail: String(e.after?.reason ?? "赠送"), time: e.time ?? "" });
      } else if (e.action === "credits.purchase") {
        const amt = Number(e.after?.amount ?? 0); purchased += amt;
        recent.push({ action: "purchase", amount: amt, detail: String(e.after?.pack_id ?? "充值"), time: e.time ?? "" });
      } else if (e.action === "model.call") {
        const c = Number(e.model_trace?.credits ?? 0);
        if (e.after?.bill_to === "platform") platformSubsidy += c;
        else consumed += c;
      }
    }
    return {
      pools: ledger,
      balance: balance(ledger),
      totals: { granted, purchased, consumed, platformSubsidy },
      recent: recent.slice(-20).reverse(),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
