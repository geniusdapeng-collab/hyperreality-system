/**
 * night-shift · 自动化触发器引擎（F4.7）：事件流订阅 + cron 双入口
 *  - 触发器本身是围栏管辖对象：CRUD/启停全部事件化（L4.4），触发的动作照常过围栏瀑布
 *  - cron 匹配：5 字段（分 时 日 月 周），支持星号、逗号、步进（每 n 单位）、单值——确定性实现
 *  - 触发即写 trigger.fired 事件 + 返回派遣模板（由 runtime 装配执行）
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";

/* ---------- 最小 cron 求值（确定性；完整 cron 库进停车场） ---------- */

export function cronMatches(expr: string, at: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron 表达式须 5 字段：${expr}`);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short", hour12: false,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekdayMap: Record<string, number> = { 周日: 0, 周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6 };
  const values = [
    Number(get("minute")),
    Number(get("hour")),
    Number(get("day")),
    Number(get("month")),
    weekdayMap[get("weekday")] ?? -1,
  ];
  const ranges: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return fields.every((f, i) => fieldMatches(f!, values[i]!, ranges[i]!));
}

function fieldMatches(field: string, value: number, [min, max]: [number, number]): boolean {
  return field.split(",").some((part) => {
    const stepMatch = /^\*\/(\d+)$/.exec(part);
    if (stepMatch) return (value - min) % Number(stepMatch[1]) === 0;
    if (part === "*") return true;
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) return value >= Number(range[1]) && value <= Number(range[2]);
    const single = Number(part);
    return Number.isInteger(single) && single === value && single >= min && single <= max;
  });
}

/* ---------- 触发器 CRUD（事件化 L4.4） ---------- */

interface Scope { tenantId: string; workspaceId: string }

export async function upsertTrigger(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  input: { id: string; name: string; kind: "cron" | "event"; schedule: string; action: Record<string, unknown>; createdBy: string },
): Promise<void> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query(
      `INSERT INTO triggers (id, workspace_id, name, kind, schedule, action, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, schedule=EXCLUDED.schedule, action=EXCLUDED.action, updated_at=now()`,
      [input.id, scope.workspaceId, input.name, input.kind, input.schedule, JSON.stringify(input.action), input.createdBy],
    );
    // D16（#1/A）：触发器行与事件同一事务同一 COMMIT
    await gatewayAppendOnClient(client, {
      tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      actor: { id: input.createdBy, type: "human" },
    }, {
      who: { type: "human", id: input.createdBy },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "staff", id: input.id },
      decision: { action: "trigger.upsert", after: { id: input.id, kind: input.kind, schedule: input.schedule } },
      rule_impact: [],
    } as never);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function setTriggerEnabled(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  id: string,
  enabled: boolean,
  by: string,
): Promise<void> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
    const r = await client.query(
      `UPDATE triggers SET enabled=$3, updated_at=now() WHERE id=$1 AND workspace_id=$2`,
      [id, scope.workspaceId, enabled],
    );
    if (r.rowCount === 0) throw new Error(`触发器 ${id} 不存在`);
    // D16（#1/A）：启停状态与事件同一事务同一 COMMIT
    await gatewayAppendOnClient(client, {
      tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      actor: { id: by, type: "human" },
    }, {
      who: { type: "human", id: by },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "staff", id },
      decision: { action: enabled ? "trigger.enable" : "trigger.disable", after: { id, enabled } },
      rule_impact: [],
    } as never);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ---------- tick：cron 触发评估（由调度循环每分钟调用；演示期手动调用） ---------- */

export interface FiredTrigger {
  id: string;
  name: string;
  action: Record<string, unknown>;
  firedEventId: string;
}

/**
 * cron tick（幂等 + 多副本安全）：
 *  - pg_try_advisory_xact_lock 抢本工作区 tick 权：多副本并发只有一个真正评估，其余空转返回 []
 *  - 每个命中的触发器先落 trigger_fires 账本（ON CONFLICT DO NOTHING 占位）：
 *    同 trigger 同分钟已触发过 → 跳过（重复触发/重试/多副本均不产生第二个 trigger.fired 事件）
 *  - 账本占位与 trigger.fired 事件同一事务同一 COMMIT（D16）
 */
export async function tickTriggers(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  at: Date = new Date(),
): Promise<FiredTrigger[]> {
  const fired: FiredTrigger[] = [];
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]); // D16：append_event_insert 双 GUC 校验要求
    // 多副本抢 tick 权（xact 锁：COMMIT/ROLLBACK 自动释放）；抢不到 = 别的副本在跑，本轮空转
    const lock = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`,
      [`trigger-tick:${scope.workspaceId}`],
    );
    if (!lock.rows[0]?.ok) {
      await client.query("ROLLBACK");
      return [];
    }
    const r = await client.query<{ id: string; name: string; schedule: string; action: Record<string, unknown> }>(
      `SELECT id, name, schedule, action FROM triggers WHERE workspace_id=$1 AND enabled=true AND kind='cron'`,
      [scope.workspaceId],
    );
    for (const t of r.rows) {
      if (!cronMatches(t.schedule, at)) continue;
      // 幂等占位：同 trigger 同 fire_minute 已落账 → 跳过（不重复触发、不重写事件）
      const claim = await client.query(
        `INSERT INTO trigger_fires (trigger_id, fire_minute, workspace_id)
         VALUES ($1, date_trunc('minute', $2::timestamptz), $3)
         ON CONFLICT (trigger_id, fire_minute) DO NOTHING`,
        [t.id, at.toISOString(), scope.workspaceId],
      );
      if (claim.rowCount === 0) continue;
      // 账本占位与 trigger.fired 事件同一 COMMIT（D16）
      const ev = await gatewayAppendOnClient(client, {
        tenantId: scope.tenantId, workspaceId: scope.workspaceId,
        actor: { id: "trigger-engine", type: "system" },
      }, {
        who: { type: "system", id: "trigger-engine" },
        context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: at.toISOString(), channel: "inapp" },
        object: { type: "staff", id: t.id },
        decision: { action: "trigger.fired", after: { id: t.id, schedule: t.schedule, dispatch: t.action } },
        rule_impact: [],
      } as never);
      fired.push({ id: t.id, name: t.name, action: t.action, firedEventId: ev.eventId });
    }
    await client.query("COMMIT");
    return fired;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
