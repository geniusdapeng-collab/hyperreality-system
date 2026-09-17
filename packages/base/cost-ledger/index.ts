/**
 * cost-ledger —— 通用成本台账底座包（U7；0011_biz_expansion budget_ledger 表）
 *
 * 范围：逐事件计量落账（recordCost，幂等键去重）+ 项目/集/镜头三级归集（aggregate）
 *      + 预算阈值判定（checkBudget，超阈值产出 tighten 建议供 captain 熔断联动 G11）。
 * 纪律：一切写入经 workdata 安全网关落五元事件（D16：台账行与事件同一 COMMIT）；
 *      重复计量凭 idempotency_key 返回已有行，不重复写行不重复写事件（L1.4 同源）。
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";

interface Scope { tenantId: string; workspaceId: string }

export const COST_KINDS = ["render", "ads_spend", "creator_fee", "license", "tools", "labor", "other"] as const;
export type CostKind = (typeof COST_KINDS)[number];

export class CostLedgerError extends Error {
  constructor(
    public readonly code: "BAD_COST_KIND" | "BAD_AMOUNT" | "BAD_BUDGET",
    message: string,
  ) {
    super(message);
    this.name = "CostLedgerError";
  }
}

/** 事务内事件留痕（D16：调用方持有事务，与台账行同一 COMMIT） */
async function emitInTx(
  client: pg.PoolClient,
  scope: Scope,
  objectId: string,
  decision: Record<string, unknown>,
): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: "cost-ledger", type: "system" },
  }, {
    who: { type: "system", id: "cost-ledger" },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object: { type: "budget_ledger", id: objectId },
    decision: decision as never,
    rule_impact: [],
  });
  return r.eventId;
}

/* ================= recordCost：逐事件计量落账 ================= */

export interface CostEntry {
  projectId?: string;
  episode?: string;
  shotId?: string;
  costKind: CostKind;
  /** 金额（正=支出；负=冲销），必须有限数 */
  amount: number;
  currency?: string;
  /** 计量幂等键（事件溯源同源：同键重复记账返回已有行） */
  idempotencyKey: string;
  meta?: Record<string, unknown>;
  occurredAt?: string;
  by: string;
}

export interface BudgetLedgerRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  episode: string | null;
  shot_id: string | null;
  cost_kind: CostKind;
  amount: string;
  currency: string;
  idempotency_key: string;
  ref_event_id: string | null;
  meta: Record<string, unknown>;
  occurred_at: string;
}

/**
 * 计量落账：INSERT budget_ledger + 同事务 budget.cost_recorded 事件（D16）。
 * 幂等：同 (workspace_id, idempotency_key) 已存在 → 返回已有行 deduped=true，不写行不写事件。
 */
export async function recordCost(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  entry: CostEntry,
): Promise<{ row: BudgetLedgerRow; deduped: boolean; eventId: string | null }> {
  if (!COST_KINDS.includes(entry.costKind)) {
    throw new CostLedgerError("BAD_COST_KIND", `非法成本类型「${entry.costKind}」（${COST_KINDS.join("/")}）`);
  }
  if (!Number.isFinite(entry.amount)) {
    throw new CostLedgerError("BAD_AMOUNT", "金额必须为有限数");
  }
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求

    // 幂等去重（L1.4 同源）
    const dup = await client.query<BudgetLedgerRow>(
      `SELECT * FROM budget_ledger WHERE workspace_id=$1 AND idempotency_key=$2`,
      [scope.workspaceId, entry.idempotencyKey],
    );
    if (dup.rows[0]) {
      await client.query("COMMIT");
      return { row: dup.rows[0], deduped: true, eventId: null };
    }

    const ins = await client.query<BudgetLedgerRow>(
      `INSERT INTO budget_ledger
         (workspace_id, project_id, episode, shot_id, cost_kind, amount, currency, idempotency_key, meta, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)
       RETURNING *`,
      [
        scope.workspaceId, entry.projectId ?? null, entry.episode ?? null, entry.shotId ?? null,
        entry.costKind, entry.amount, entry.currency ?? "CNY", entry.idempotencyKey,
        JSON.stringify(entry.meta ?? {}), entry.occurredAt ?? new Date().toISOString(),
      ],
    );
    const row = ins.rows[0]!;
    // D16（#1/A）：台账行与计量事件同一事务同一 COMMIT；ref_event_id 互证
    const eventId = await emitInTx(client, scope, String(row.id), {
      action: "budget.cost_recorded",
      after: {
        ledgerId: row.id, projectId: entry.projectId ?? null, episode: entry.episode ?? null,
        shotId: entry.shotId ?? null, costKind: entry.costKind, amount: entry.amount,
        currency: entry.currency ?? "CNY", idempotencyKey: entry.idempotencyKey,
      },
      basis: ["成本逐事件计量落账（U7；UNIQUE(workspace_id,idempotency_key) 幂等）"],
    });
    await client.query(
      `UPDATE budget_ledger SET ref_event_id=$3 WHERE workspace_id=$1 AND id=$2`,
      [scope.workspaceId, row.id, eventId],
    );
    await client.query("COMMIT");
    return { row: { ...row, ref_event_id: eventId }, deduped: false, eventId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ================= aggregate：项目/集/镜头三级归集 ================= */

export interface CostAggregate {
  projectId: string | null;
  total: number;
  byCostKind: Record<string, number>;
  /** 二级：集/期归集 */
  byEpisode: Array<{ episode: string | null; total: number }>;
  /** 三级：镜头归集 */
  byShot: Array<{ episode: string | null; shotId: string; total: number }>;
  entries: number;
}

/** 三级归集（纯读，越权返回空 L7.1 同源）；projectId 缺省 = 工作区全量 */
export async function aggregate(
  app: pg.Pool,
  scope: Scope,
  filter: { projectId?: string } = {},
): Promise<CostAggregate> {
  const clauses = ["workspace_id = $1"];
  const params: unknown[] = [scope.workspaceId];
  if (filter.projectId) {
    params.push(filter.projectId);
    clauses.push(`project_id = $${params.length}`);
  }
  const where = clauses.join(" AND ");
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const total = await client.query<{ total: string | null; entries: string }>(
      `SELECT SUM(amount)::text AS total, COUNT(*)::text AS entries FROM budget_ledger WHERE ${where}`,
      params,
    );
    const byKind = await client.query<{ cost_kind: string; total: string }>(
      `SELECT cost_kind, SUM(amount)::text AS total FROM budget_ledger WHERE ${where} GROUP BY cost_kind`,
      params,
    );
    const byEpisode = await client.query<{ episode: string | null; total: string }>(
      `SELECT episode, SUM(amount)::text AS total FROM budget_ledger WHERE ${where} GROUP BY episode ORDER BY episode NULLS LAST`,
      params,
    );
    const byShot = await client.query<{ episode: string | null; shot_id: string; total: string }>(
      `SELECT episode, shot_id, SUM(amount)::text AS total FROM budget_ledger
       WHERE ${where} AND shot_id IS NOT NULL GROUP BY episode, shot_id ORDER BY episode, shot_id`,
      params,
    );
    await client.query("COMMIT");
    return {
      projectId: filter.projectId ?? null,
      total: Number(total.rows[0]?.total ?? 0),
      entries: Number(total.rows[0]?.entries ?? 0),
      byCostKind: Object.fromEntries(byKind.rows.map((r) => [r.cost_kind, Number(r.total)])),
      byEpisode: byEpisode.rows.map((r) => ({ episode: r.episode, total: Number(r.total) })),
      byShot: byShot.rows.map((r) => ({ episode: r.episode, shotId: r.shot_id, total: Number(r.total) })),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ================= checkBudget：阈值判定 → tighten 建议 ================= */

export interface BudgetThreshold {
  /** 预算上限（同币种） */
  budget: number;
  /** 预警线占比（默认 0.8） */
  warnRatio?: number;
}

export interface TightenAdvice {
  /** 收紧动作：暂停渲染提交（G11 联动锚点）/ 后续支出一律上浮 L4 审批 */
  action: "pause_render_submit" | "escalate_l4";
  reason: string;
}

export interface BudgetVerdict {
  spent: number;
  budget: number;
  /** spent/budget；budget≤0 时为 null（不可用，level=ok 防除零误报） */
  ratio: number | null;
  level: "ok" | "warn" | "exceeded";
  /** 超阈值时的收紧建议（供 captain 熔断联动） */
  tighten: TightenAdvice | null;
}

/** 阈值判定（纯函数）：budget≤0 不判定（无预算口径，防除零误报） */
export function evalBudget(spent: number, threshold: BudgetThreshold): BudgetVerdict {
  const { budget } = threshold;
  if (budget <= 0) {
    return { spent, budget, ratio: null, level: "ok", tighten: null };
  }
  const warnRatio = threshold.warnRatio ?? 0.8;
  const ratio = spent / budget;
  if (ratio > 1) {
    return {
      spent, budget, ratio, level: "exceeded",
      tighten: {
        action: "pause_render_submit",
        reason: `支出 ${spent.toFixed(2)} 超预算 ${budget.toFixed(2)}（${(ratio * 100).toFixed(1)}%）→ 建议暂停渲染提交（G11）并将后续支出上浮 L4 审批`,
      },
    };
  }
  if (ratio >= warnRatio) {
    return {
      spent, budget, ratio, level: "warn",
      tighten: {
        action: "escalate_l4",
        reason: `支出达预算 ${(ratio * 100).toFixed(1)}%（预警线 ${(warnRatio * 100).toFixed(0)}%）→ 建议后续支出一律上浮 L4 审批`,
      },
    };
  }
  return { spent, budget, ratio, level: "ok", tighten: null };
}

/**
 * 预算巡检：aggregate → evalBudget；超阈值写 budget.threshold_exceeded 事件（D16 同事务），
 * 返回 verdict（含 tighten 建议，captain 熔断联动消费侧）。
 */
export async function checkBudget(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  filter: { projectId?: string },
  threshold: BudgetThreshold,
): Promise<BudgetVerdict> {
  if (!Number.isFinite(threshold.budget) || threshold.budget < 0) {
    throw new CostLedgerError("BAD_BUDGET", "预算上限必须为非负有限数");
  }
  const agg = await aggregate(app, scope, filter);
  const verdict = evalBudget(agg.total, threshold);
  if (verdict.level === "exceeded" && verdict.tighten) {
    const client = await app.connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
      await emitInTx(client, scope, filter.projectId ?? scope.workspaceId, {
        action: "budget.threshold_exceeded",
        after: {
          projectId: filter.projectId ?? null, spent: verdict.spent, budget: verdict.budget,
          ratio: verdict.ratio, tighten: verdict.tighten,
        },
        basis: [verdict.tighten.reason],
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  return verdict;
}
