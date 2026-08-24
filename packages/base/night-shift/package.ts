/**
 * night-shift · 清晨决策包（F4.4/H-7）：08:30 对夜间事件流做三段投影
 *   已完成（done）/ 待审批（pending）/ 需介入（need_human）
 * 铁律口径：
 *  - 不是报表，是日志的一次视图查询（纯投影，H-7 代码走查项：禁止另写汇总表）
 *  - 字段：动作摘要 / before-after / 命中围栏版本 / 证据快照链接
 *  - 整包 ≤20 条，超出按严重度截断（G6/APPROVAL_LIMITS.packageMaxItems）
 *  - 生成后写 night.package.deliver 事件（留痕 G8）+ 状态机 → package_generated
 */
import type pg from "pg";
import { APPROVAL_LIMITS, type BusinessEvent } from "@workloom/shared";
import { gatewayAppendOnClient } from "../workdata/gateway.js";

/* ---------- 三段投影（纯函数，H-7 走查核心） ---------- */

export interface PackageItem {
  eventId: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  fenceVersions: string[];
  snapshotUri?: string;
  /** 严重度（截断排序用）：need_human 3 > pending 2 > done 1 */
  severity: 1 | 2 | 3;
}

export interface NightPackage {
  done: PackageItem[];
  pending: PackageItem[];
  needHuman: PackageItem[];
  truncated: number;
  stats: { done: number; pending: number; need_human: number; credits_used: number };
}

/** 夜间事件流 → 三段投影（纯函数） */
export function projectNightPackage(events: BusinessEvent[]): NightPackage {
  const done: PackageItem[] = [];
  const pending: PackageItem[] = [];
  const needHuman: PackageItem[] = [];
  let credits = 0;

  for (const ev of events) {
    credits += ev.model_trace?.credits ?? 0;
    const impacts = ev.rule_impact ?? [];
    const item: PackageItem = {
      eventId: ev.event_id,
      summary: `${ev.who.id} · ${ev.decision.action}${ev.object.id ? `（${ev.object.id}）` : ""}`,
      before: ev.decision.before,
      after: ev.decision.after,
      fenceVersions: [...new Set(impacts.map((i) => `${i.rule_id}@${i.version}`))],
      snapshotUri: ev.receipt?.snapshot_uri,
      severity: 1,
    };
    if (impacts.some((i) => i.result === "blocked")) {
      item.severity = 3;
      needHuman.push(item); // 熔断/担保异常 → 需介入（L4.2 口径：不确定性只写需介入）
    } else if (impacts.some((i) => i.result === "review")) {
      item.severity = 2;
      pending.push(item); // 越围栏挂起 → 待审批
    } else if (ev.receipt?.synced || impacts.length === 0) {
      done.push(item); // 有回执的系统动作/只读动作 → 已完成
    } else {
      item.severity = 3; // 无回执 = 未核实（E3.7）→ 需介入
      item.summary += "（未核实）";
      needHuman.push(item);
    }
  }

  // 整包 ≤20 条，超出按严重度截断（G6）
  const all = [...needHuman, ...pending, ...done];
  const overflow = all.length - APPROVAL_LIMITS.packageMaxItems;
  let truncated = 0;
  if (overflow > 0) {
    truncated = overflow;
    let cut = overflow;
    while (cut > 0 && done.length > 0) { done.pop(); cut--; }
    while (cut > 0 && pending.length > 0) { pending.pop(); cut--; }
    while (cut > 0 && needHuman.length > 0) { needHuman.pop(); cut--; }
  }

  return {
    done, pending, needHuman, truncated,
    stats: { done: done.length, pending: pending.length, need_human: needHuman.length, credits_used: credits },
  };
}

/* ---------- PG 装配：取夜间窗口事件 → 投影 → 落库留痕 ---------- */

export async function deliverPackage(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: { tenantId: string; workspaceId: string },
  runId: string,
  window: { from: string; to: string },
): Promise<NightPackage> {
  const client = await app.connect();
  let events: BusinessEvent[];
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<{ payload: BusinessEvent }>(
      `SELECT payload FROM biz_events
       WHERE tenant_id=$1 AND workspace_id=$2 AND created_at >= $3::timestamptz AND created_at <= $4::timestamptz
       ORDER BY seq`,
      [scope.tenantId, scope.workspaceId, window.from, window.to],
    );
    events = r.rows.map((x) => x.payload);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const pkg = projectNightPackage(events);

  // 状态机 → package_generated + 统计回写（F4.4/F4.8）
  const c2 = await app.connect();
  try {
    await c2.query("BEGIN");
    await c2.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await c2.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const upd = await c2.query(
      `UPDATE night_runs SET status='package_generated', stats=$3 WHERE id=$1 AND workspace_id=$2 AND status IN ('running','paused','ready')`,
      [runId, scope.workspaceId, JSON.stringify(pkg.stats)],
    );
    // 幂等：已 package_generated（或班次不存在）→ rowCount=0，直接返回不重写投递事件（G8 留痕唯一）
    if (upd.rowCount === 0) {
      await c2.query("COMMIT");
      return pkg;
    }
    // D16（#1/A）：状态回写与投递事件同一事务同一 COMMIT（G8）
    await gatewayAppendOnClient(c2, {
      tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      actor: { id: "night-shift", type: "system" },
    }, {
      who: { type: "system", id: "night-shift" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "夜班" },
      object: { type: "store", id: scope.workspaceId },
      decision: {
        action: "night.package.deliver",
        after: { runId, stats: pkg.stats, truncated: pkg.truncated, package: pkg },
      },
      rule_impact: [],
    } as never);
    await c2.query("COMMIT");
  } catch (err) {
    await c2.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c2.release();
  }

  return pkg;
}
