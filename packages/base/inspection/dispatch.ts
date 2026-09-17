/**
 * inspection · 一键派单与回链（F9.3，E9.3，L9.3 幂等）
 *  - 以异常事件为输入唤起对应业务 Agent 建任务（threads 行 + inspect.dispatch 事件 links 回链）
 *  - 处理结果回链异常事件：成功 → inspect.resolved；失败 → 升级一级严重度 + 转需介入（E9.3）
 *  - 幂等：同一异常事件重复派单/重复回链只处理首次（不重复建单、不重复推送）
 */
import type pg from "pg";
import { gatewayAppend, gatewayAppendOnClient } from "../workdata/gateway.js";
import { makeReadableId } from "@workloom/shared";
import type { Severity } from "./checks.js";

interface Scope { tenantId: string; workspaceId: string }

export class DispatchError extends Error {
  constructor(public readonly code: "ANOMALY_NOT_FOUND" | "ALREADY_HANDLED", message: string) {
    super(message);
    this.name = "DispatchError";
  }
}

/** 严重度升一级（E9.3）：low→medium→high；high 保持 high 并转需介入 */
export function escalateSeverity(s: Severity): Severity {
  return s === "low" ? "medium" : "high";
}

/** 事务内事件留痕（D16：调用方持有事务，与业务写同一 COMMIT） */
async function emitInTx(
  client: pg.PoolClient,
  scope: Scope,
  actorId: string,
  actorType: "human" | "system",
  decision: Record<string, unknown>,
  object: { type: string; id?: string },
  links?: string[],
  sessionId?: string | null,
): Promise<string> {
  const r = await gatewayAppendOnClient(client, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: actorId, type: actorType },
    sessionId: sessionId ?? null,
  }, {
    who: { type: actorType, id: actorId },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object,
    decision: decision as never,
    rule_impact: [],
    links,
  });
  return r.eventId;
}

async function emit(
  gateway: pg.Pool,
  scope: Scope,
  actorId: string,
  actorType: "human" | "system",
  decision: Record<string, unknown>,
  object: { type: string; id?: string },
  links?: string[],
  sessionId?: string | null,
): Promise<string> {
  const r = await gatewayAppend(gateway, {
    tenantId: scope.tenantId, workspaceId: scope.workspaceId,
    actor: { id: actorId, type: actorType },
    sessionId: sessionId ?? null,
  }, {
    who: { type: actorType, id: actorId },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
    object,
    decision: decision as never,
    rule_impact: [],
    links,
  });
  return r.eventId;
}

/** 查异常事件（本工作区内；越权返回空——L7.1 口径由调用层 RLS 保证） */
async function getAnomalyEvent(
  app: pg.Pool,
  scope: Scope,
  anomalyEventId: string,
): Promise<{ eventId: string; summary: string; severity: Severity; objectType: string; objectId?: string } | null> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const r = await client.query<{
      event_id: string;
      payload: { decision: { after?: { summary?: string; severity?: Severity } }; object: { type: string; id?: string } };
    }>(
      `SELECT event_id, payload FROM biz_events
       WHERE workspace_id=$1 AND event_id=$2 AND payload->'decision'->>'action' = 'inspect.anomaly'`,
      [scope.workspaceId, anomalyEventId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      eventId: row.event_id,
      summary: row.payload.decision.after?.summary ?? "",
      severity: row.payload.decision.after?.severity ?? "low",
      objectType: row.payload.object.type,
      objectId: row.payload.object.id,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

/** 幂等检查：该异常是否已有派单/回链（L9.3 同源纪律：同事件不重复推送/建单） */
async function findExisting(app: pg.Pool, scope: Scope, anomalyEventId: string, action: string): Promise<string | null> {
  const client = await app.connect();
  try {
    // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{ event_id: string }>(
      `SELECT event_id FROM biz_events
       WHERE workspace_id=$1 AND payload->'decision'->>'action' = $2 AND payload->'links' @> $3::jsonb
       LIMIT 1`,
      [scope.workspaceId, action, JSON.stringify([anomalyEventId])],
    );
    return r.rows[0]?.event_id ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

/**
 * 一键派单（F9.3）：异常事件 → 建 thread（queued，由 runtime 拉取/立即执行）+ 派单留痕
 * 处理结果由 resolveAnomaly 回链（线程完成/失败后调用）。
 */
export async function dispatchFromAnomaly(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  input: { anomalyEventId: string; presetKey: string; by: string },
): Promise<{ threadId: string; eventId: string; deduped: boolean }> {
  const anomaly = await getAnomalyEvent(app, scope, input.anomalyEventId);
  if (!anomaly) {
    throw new DispatchError("ANOMALY_NOT_FOUND", `异常事件 ${input.anomalyEventId} 不存在或不属本工作区`);
  }
  // 幂等：已派过单 → 返回原单（不重复建）
  const existing = await findExisting(app, scope, input.anomalyEventId, "inspect.dispatch");
  if (existing) {
    const client = await app.connect();
    try {
      // 事务级 RLS 上下文必须在显式事务内设置：autocommit 下 set_config(...,true) 语句结束即失效
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      const ev = await client.query<{ payload: { decision: { after?: { threadId?: string } } } }>(
        `SELECT payload FROM biz_events WHERE workspace_id=$1 AND event_id=$2`,
        [scope.workspaceId, existing],
      );
      return { threadId: ev.rows[0]?.payload.decision.after?.threadId ?? "", eventId: existing, deduped: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      await client.query("COMMIT").catch(() => undefined);
      client.release();
    }
  }

  const title = `【巡检派单】${anomaly.summary}`;
  // D16（#1/A）：线程创建与派单事件同一事务同一 COMMIT
  const client = await app.connect();
  let threadId: string;
  let eventId: string;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    // 号源走 SECURITY DEFINER 函数（0016：全库最大值绕 RLS，跨工作区不撞号）
    const max = await client.query<{ n: number }>(
      `SELECT public.threads_max_t_no() AS n`,
    );
    threadId = makeReadableId("T", Number(max.rows[0]?.n ?? 100) + 1);
    await client.query(
      `INSERT INTO threads (id, tenant_id, workspace_id, title, mode, status, created_by, agent_id)
       VALUES ($1,$2,$3,$4,'quest','queued',$5,$6)`,
      [threadId, scope.tenantId, scope.workspaceId, title, input.by, input.presetKey],
    );
    eventId = await emitInTx(client, scope, input.by, "human", {
      action: "inspect.dispatch",
      after: { threadId, anomalyEventId: input.anomalyEventId, presetKey: input.presetKey, severity: anomaly.severity },
      basis: ["一键派单：以异常事件为输入唤起业务 Agent（F9.3）", "处理结果将回链异常事件（F9.3/E9.3）"],
      // #38 修复：派单事件挂 sessionId=threadId——此前仅 links 回链，
      // threads.events（按 session_id 投影线程事件流）看不到派单事件，P2 行动消息流缺环
    }, { type: anomaly.objectType, id: anomaly.objectId }, [input.anomalyEventId], threadId);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
  return { threadId, eventId, deduped: false };
}

/**
 * 处理结果回链（F9.3/E9.3）：
 *  - ok=true  → inspect.resolved（回链异常事件 + 线程）
 *  - ok=false → 升级一级严重度 + 转需介入（inspect.escalated）
 * 幂等：同一异常重复回链只处理首次（L9.3）
 */
export async function resolveAnomaly(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  input: { anomalyEventId: string; threadId: string; ok: boolean; note?: string; by: string },
): Promise<{ eventId: string; deduped: boolean; escalatedTo?: Severity }> {
  const anomaly = await getAnomalyEvent(app, scope, input.anomalyEventId);
  if (!anomaly) {
    throw new DispatchError("ANOMALY_NOT_FOUND", `异常事件 ${input.anomalyEventId} 不存在或不属本工作区`);
  }
  const existing = (await findExisting(app, scope, input.anomalyEventId, input.ok ? "inspect.resolved" : "inspect.escalated"))
    ?? (await findExisting(app, scope, input.anomalyEventId, input.ok ? "inspect.escalated" : "inspect.resolved"));
  if (existing) return { eventId: existing, deduped: true };

  if (input.ok) {
    const eventId = await emit(gateway, scope, input.by, "system", {
      action: "inspect.resolved",
      after: { anomalyEventId: input.anomalyEventId, threadId: input.threadId, note: input.note ?? "" },
      basis: ["处理结果回链异常事件（F9.3）"],
    }, { type: anomaly.objectType, id: anomaly.objectId }, [input.anomalyEventId, input.threadId]);
    return { eventId, deduped: false };
  }

  const escalatedTo = escalateSeverity(anomaly.severity);
  const eventId = await emit(gateway, scope, input.by, "system", {
    action: "inspect.escalated",
    after: {
      anomalyEventId: input.anomalyEventId, threadId: input.threadId,
      fromSeverity: anomaly.severity, toSeverity: escalatedTo,
      need_human: true, note: input.note ?? "",
    },
    basis: ["派单后处理失败：回链并升级一级严重度，转需介入（E9.3）"],
  }, { type: anomaly.objectType, id: anomaly.objectId }, [input.anomalyEventId, input.threadId]);
  return { eventId, deduped: false, escalatedTo };
}
