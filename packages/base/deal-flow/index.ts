/**
 * deal-flow —— 商单域底座包（0011_biz_expansion deal_orders/deal_milestones/settlement_statements）
 *
 * 范围：线索建单（createFromLead，评论/私信线索 → deal_order 草稿）
 *      + 报价带校验（quoteCheck，超带 escalate L4 标记）
 *      + 节点推进（advanceMilestone，事件留痕）
 *      + 账期催款备稿（dunning，只生成备稿不外发——RPA/外部平台调用一律接口预留）
 *      + 结案报告聚合（closureReport，纯读）。
 * 纪律：一切写入经 workdata 安全网关落五元事件（D16 同一 COMMIT）；事件 action 统一 deal.* 前缀；
 *      催款备稿只产文本草稿，不外发（外发通道 seam 预留，Mock 兜底）。
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";

interface Scope { tenantId: string; workspaceId: string }

export class DealError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "BAD_STATE" | "BAD_BAND" | "LEAD_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "DealError";
  }
}

export const DEAL_STATUSES = ["draft", "quoting", "contracted", "fulfilling", "settling", "closed", "lost"] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const MILESTONE_KINDS = ["brief", "draft_v1", "final_cut", "publish", "acceptance", "payment"] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

export interface DealOrderRow {
  id: string;
  workspace_id: string;
  brand: string;
  contact: string | null;
  amount: string;
  quote_band: { floor?: number; ceiling?: number; currency?: string };
  status: DealStatus;
  channel: string;
  lead_comment_id: string | null;
  project_id: string | null;
  payment_terms: Record<string, unknown>;
  created_by: string;
  created_at: string;
  closed_at: string | null;
}

export interface DealMilestoneRow {
  id: string;
  workspace_id: string;
  order_id: string;
  kind: MilestoneKind;
  due_at: string | null;
  status: "pending" | "done" | "overdue" | "waived";
  done_at: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

/** 事务内事件留痕（D16：调用方持有事务，与商单行同一 COMMIT） */
async function emitInTx(
  client: pg.PoolClient,
  scope: Scope,
  by: string,
  objectType: string,
  objectId: string,
  decision: Record<string, unknown>,
): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: by, type: "system" },
  }, {
    who: { type: "system", id: by },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: objectType, id: objectId },
    decision: decision as never,
    rule_impact: [],
  });
  return r.eventId;
}

async function inTx<T>(app: pg.Pool, scope: Scope, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ================= ① createFromLead：线索建单 ================= */

export interface CreateFromLeadInput {
  id: string;
  /** 来源评论（comments 行；私信线索由采集层落成 comment 记录后传入） */
  commentId: string;
  brand: string;
  contact?: string;
  channel?: "dm" | "email" | "platform_msg" | "offline" | "other";
  quoteBand?: { floor?: number; ceiling?: number; currency?: string };
  projectId?: string;
  by: string;
}

/**
 * 从评论/私信线索建 deal_order 草稿（status=draft）。
 * 幂等：UNIQUE(workspace_id, brand, lead_comment_id) —— 同线索重复建单返回已有行 deduped=true。
 */
export async function createFromLead(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  input: CreateFromLeadInput,
): Promise<{ order: DealOrderRow; deduped: boolean }> {
  return inTx(app, scope, async (client) => {
    const lead = await client.query<{ id: string }>(
      `SELECT id FROM comments WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, input.commentId],
    );
    if (!lead.rows[0]) {
      throw new DealError("LEAD_NOT_FOUND", `线索评论 ${input.commentId} 不存在（不凭空建单）`);
    }
    const dup = await client.query<DealOrderRow>(
      `SELECT * FROM deal_orders WHERE workspace_id=$1 AND brand=$2 AND lead_comment_id=$3`,
      [scope.workspaceId, input.brand, input.commentId],
    );
    if (dup.rows[0]) return { order: dup.rows[0], deduped: true };
    const ins = await client.query<DealOrderRow>(
      `INSERT INTO deal_orders
         (id, workspace_id, brand, contact, quote_band, channel, lead_comment_id, project_id, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9)
       RETURNING *`,
      [
        input.id, scope.workspaceId, input.brand, input.contact ?? null,
        JSON.stringify(input.quoteBand ?? {}), input.channel ?? "dm",
        input.commentId, input.projectId ?? null, input.by,
      ],
    );
    // D16（#1/A）：订单行与建档事件同一事务同一 COMMIT
    await emitInTx(client, scope, input.by, "deal_order", input.id, {
      action: "deal.created_from_lead",
      after: {
        orderId: input.id, brand: input.brand, channel: input.channel ?? "dm",
        leadCommentId: input.commentId, quoteBand: input.quoteBand ?? {},
      },
      basis: ["评论/私信线索建商单草稿（同线索幂等去重）"],
    });
    return { order: ins.rows[0]!, deduped: false };
  });
}

/* ================= ② quoteCheck：报价带校验 ================= */

export interface QuoteBand { floor?: number; ceiling?: number; currency?: string }

export interface QuoteVerdict {
  amount: number;
  band: QuoteBand;
  inBand: boolean;
  /** 超带 → 上浮 L4 董事长审批标记（G15 联动） */
  escalate: "l4_chairman" | null;
  reason: string;
}

/**
 * 报价带校验（纯函数）：floor/ceiling 均未设 = 无报价带，恒 inBand（不伪造限制）；
 * 低于 floor 或高于 ceiling → inBand=false + escalate=l4_chairman。
 */
export function quoteCheck(amount: number, band: QuoteBand): QuoteVerdict {
  const hasFloor = typeof band.floor === "number" && Number.isFinite(band.floor);
  const hasCeiling = typeof band.ceiling === "number" && Number.isFinite(band.ceiling);
  if (!hasFloor && !hasCeiling) {
    return { amount, band, inBand: true, escalate: null, reason: "未设报价带，免校验" };
  }
  if (hasFloor && amount < band.floor!) {
    return { amount, band, inBand: false, escalate: "l4_chairman", reason: `报价 ${amount} 低于报价带下限 ${band.floor}，超带上浮 L4 审批` };
  }
  if (hasCeiling && amount > band.ceiling!) {
    return { amount, band, inBand: false, escalate: "l4_chairman", reason: `报价 ${amount} 高于报价带上限 ${band.ceiling}，超带上浮 L4 审批` };
  }
  return { amount, band, inBand: true, escalate: null, reason: "报价在带内" };
}

/**
 * 报价落单：quoteCheck → 更新订单（amount + status=quoting）+ deal.quoted 事件（含 escalate 标记）。
 * 超带不阻断落单（业务上允许报价，但事件 escalate 标记供审批层上浮 L4）。
 */
export async function applyQuote(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  orderId: string,
  input: { amount: number; by: string },
): Promise<{ order: DealOrderRow; verdict: QuoteVerdict }> {
  return inTx(app, scope, async (client) => {
    const cur = await client.query<DealOrderRow>(
      `SELECT * FROM deal_orders WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, orderId],
    );
    const order = cur.rows[0];
    if (!order) throw new DealError("NOT_FOUND", `商单 ${orderId} 不存在`);
    if (order.status === "closed" || order.status === "lost") {
      throw new DealError("BAD_STATE", `商单 ${orderId} 已结案（${order.status}），不可再报价`);
    }
    const verdict = quoteCheck(input.amount, order.quote_band ?? {});
    const upd = await client.query<DealOrderRow>(
      `UPDATE deal_orders SET amount=$3, status='quoting' WHERE workspace_id=$1 AND id=$2 RETURNING *`,
      [scope.workspaceId, orderId, input.amount],
    );
    await emitInTx(client, scope, input.by, "deal_order", orderId, {
      action: "deal.quoted",
      after: {
        orderId, amount: input.amount, quoteBand: order.quote_band,
        inBand: verdict.inBand, escalate: verdict.escalate,
      },
      basis: [verdict.reason],
    });
    return { order: upd.rows[0]!, verdict };
  });
}

/* ================= ③ advanceMilestone：节点推进 ================= */

/**
 * 节点推进：pending/overdue → done（done_at=now）+ deal.milestone_advanced 事件。
 * 幂等：已 done 直接返回现状（重复推进不重复写事件）；waived 拒绝推进。
 */
export async function advanceMilestone(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  milestoneId: string,
  input: { by: string; note?: string },
): Promise<{ milestone: DealMilestoneRow; advanced: boolean }> {
  return inTx(app, scope, async (client) => {
    const cur = await client.query<DealMilestoneRow>(
      `SELECT * FROM deal_milestones WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, milestoneId],
    );
    const ms = cur.rows[0];
    if (!ms) throw new DealError("NOT_FOUND", `履约节点 ${milestoneId} 不存在`);
    if (ms.status === "done") return { milestone: ms, advanced: false };
    if (ms.status === "waived") {
      throw new DealError("BAD_STATE", `履约节点 ${milestoneId} 已豁免（waived），不可推进`);
    }
    const upd = await client.query<DealMilestoneRow>(
      `UPDATE deal_milestones SET status='done', done_at=now(), note=COALESCE($3, note)
       WHERE workspace_id=$1 AND id=$2 RETURNING *`,
      [scope.workspaceId, milestoneId, input.note ?? null],
    );
    await emitInTx(client, scope, input.by, "deal_milestone", milestoneId, {
      action: "deal.milestone_advanced",
      after: {
        milestoneId, orderId: ms.order_id, kind: ms.kind,
        from: ms.status, to: "done", note: input.note ?? null,
      },
      basis: [`履约节点推进：${ms.kind}（${ms.status} → done）`],
    });
    return { milestone: upd.rows[0]!, advanced: true };
  });
}

/* ================= ④ dunning：账期催款备稿 ================= */

export interface DunningItem {
  orderId: string;
  brand: string;
  amount: number;
  milestoneId: string;
  dueAt: string;
  daysOverdue: number;
  /** 催款备稿文本（只生成不外发；外发通道 seam 预留） */
  draft: string;
  /** 本次是否新转 overdue（false = 此前已逾期，仅复述） */
  newlyOverdue: boolean;
}

/** 催款备稿模板（确定性文案；LLM 润色走 model-router seam 预留） */
export function dunningDraft(brand: string, amount: number, dueAt: string, daysOverdue: number): string {
  return `【催款备稿】${brand} 您好：贵方商单应结款项 ¥${amount.toFixed(2)} 已于 ${dueAt.slice(0, 10)} 到期（逾期 ${daysOverdue} 天），`
    + `请安排回款。如对结算明细有疑问请联系我方核对。（本稿为系统备稿，外发前须经人工确认）`;
}

/**
 * 账期巡检：payment 节点 due_at 已过且未 done/waived → 转 overdue + 逐单催款备稿
 * + deal.dunning_drafted 事件（D16 同事务）。已 overdue 的复述备稿但不重复写事件。
 */
export async function dunning(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  opts: { now?: string; by?: string } = {},
): Promise<DunningItem[]> {
  const now = opts.now ?? new Date().toISOString();
  const by = opts.by ?? "deal-flow";
  return inTx(app, scope, async (client) => {
    const r = await client.query<DealMilestoneRow & { brand: string; amount: string }>(
      `SELECT m.*, o.brand, o.amount
       FROM deal_milestones m
       JOIN deal_orders o ON o.workspace_id = m.workspace_id AND o.id = m.order_id
       WHERE m.workspace_id=$1 AND m.kind='payment' AND m.status IN ('pending','overdue')
         AND m.due_at IS NOT NULL AND m.due_at < $2::timestamptz
       ORDER BY m.due_at`,
      [scope.workspaceId, now],
    );
    const items: DunningItem[] = [];
    for (const row of r.rows) {
      const daysOverdue = Math.max(0, Math.floor((Date.parse(now) - Date.parse(row.due_at!)) / 86400e3));
      const amount = Number(row.amount);
      const draft = dunningDraft(row.brand, amount, row.due_at!, daysOverdue);
      const newlyOverdue = row.status === "pending";
      if (newlyOverdue) {
        await client.query(
          `UPDATE deal_milestones SET status='overdue' WHERE workspace_id=$1 AND id=$2`,
          [scope.workspaceId, row.id],
        );
        // D16（#1/A）：逾期状态推进与备稿事件同一事务同一 COMMIT
        await emitInTx(client, scope, by, "deal_order", row.order_id, {
          action: "deal.dunning_drafted",
          after: {
            orderId: row.order_id, brand: row.brand, amount, milestoneId: row.id,
            dueAt: row.due_at, daysOverdue, draft,
          },
          basis: [`账期到期：payment 节点逾期 ${daysOverdue} 天，生成催款备稿（只备稿不外发）`],
        });
      }
      items.push({
        orderId: row.order_id, brand: row.brand, amount,
        milestoneId: row.id, dueAt: row.due_at!, daysOverdue, draft, newlyOverdue,
      });
    }
    return items;
  });
}

/* ================= ⑤ closureReport：结案报告聚合（纯读） ================= */

export interface ClosureReport {
  order: DealOrderRow;
  milestones: Array<{ kind: MilestoneKind; status: string; dueAt: string | null; doneAt: string | null }>;
  settlement: {
    dueTotal: number;
    paidTotal: number;
    /** (paid-due)/due；无结算单或应结为 0 = null（不伪造） */
    diffRatio: number | null;
    statements: number;
  };
  /** 里程碑完成率 done/(非 waived 总数)；无节点 = null */
  milestoneCompletion: number | null;
  notes: string[];
}

/** 结案报告数据聚合（订单 + 节点 + 结算比对；纯读，越权返回 null L7.1 同源） */
export async function closureReport(
  app: pg.Pool,
  scope: Scope,
  orderId: string,
): Promise<ClosureReport | null> {
  return inTx(app, scope, async (client) => {
    const o = await client.query<DealOrderRow>(
      `SELECT * FROM deal_orders WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, orderId],
    );
    const order = o.rows[0];
    if (!order) return null;
    const ms = await client.query<DealMilestoneRow>(
      `SELECT * FROM deal_milestones WHERE workspace_id=$1 AND order_id=$2 ORDER BY created_at`,
      [scope.workspaceId, orderId],
    );
    const st = await client.query<{ due_total: string | null; paid_total: string | null; n: string }>(
      `SELECT SUM(due_amount)::text AS due_total, SUM(paid_amount)::text AS paid_total, COUNT(*)::text AS n
       FROM settlement_statements WHERE workspace_id=$1 AND order_id=$2`,
      [scope.workspaceId, orderId],
    );
    const dueTotal = Number(st.rows[0]?.due_total ?? 0);
    const paidTotal = Number(st.rows[0]?.paid_total ?? 0);
    const statements = Number(st.rows[0]?.n ?? 0);
    const countable = ms.rows.filter((m) => m.status !== "waived");
    return {
      order,
      milestones: ms.rows.map((m) => ({ kind: m.kind, status: m.status, dueAt: m.due_at, doneAt: m.done_at })),
      settlement: {
        dueTotal, paidTotal, statements,
        diffRatio: statements > 0 && dueTotal > 0 ? (paidTotal - dueTotal) / dueTotal : null,
      },
      milestoneCompletion: countable.length > 0
        ? countable.filter((m) => m.status === "done").length / countable.length
        : null,
      notes: ["结算差异超 ±10% 触发 G13 告警由 settlement 巡检消费（diffRatio 为本报告口径输出）"],
    };
  });
}
