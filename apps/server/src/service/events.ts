/**
 * service · 五元事件写入助手（D16 同事务纪律）
 *  - serviceTx：BEGIN + set_config 双 GUC + tenantId 解析 → 回调 → COMMIT/ROLLBACK
 *  - appendEventOn：事务内经 gatewayAppendOnClient 落五元事件（三段瀑布 + 哈希链 + 幂等）
 * C 端 actor 为 c_user（who.type=human，id=cUserId）；B 端为成员编号（MEM-xxx）；系统动作 type=system。
 */
import type pg from "pg";
import { getAppPool } from "@workloom/db";
import { gatewayAppendOnClient, type ActorInfo } from "@workloom/base/workdata";

export interface ServiceScope { tenantId: string; workspaceId: string }

/** 在 RLS 上下文事务内执行（解析 tenantId 一并交给回调） */
export async function serviceTx<T>(
  workspaceId: string,
  fn: (client: pg.PoolClient, scope: ServiceScope) => Promise<T>,
): Promise<T> {
  const pool = getAppPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const ws = await client.query<{ tenant_id: string }>(`SELECT tenant_id FROM workspaces WHERE id=$1`, [workspaceId]);
    if (!ws.rows[0]?.tenant_id) throw new Error(`serviceTx: 工作区不存在 ${workspaceId}`); // M5 fail-closed：不写 tenant_id='' 孤儿事件
    const tenantId = ws.rows[0].tenant_id as string;
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client, { tenantId, workspaceId });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 单查询便捷封装：RLS 事务上下文内执行一条 SQL 并返回行（service 层全部读写必须走 RLS 上下文） */
export async function svcQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  workspaceId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return serviceTx(workspaceId, async (client) => {
    const r = await client.query(sql, params);
    return r.rows as T[];
  });
}

/** 事务内落五元事件（调用方须在 serviceTx 回调内使用，与业务写同一 COMMIT） */
export async function appendEventOn(
  client: pg.PoolClient,
  scope: ServiceScope,
  actor: ActorInfo,
  draft: { objectType: string; objectId: string; action: string; after?: unknown; channel?: string },
): Promise<{ eventId: string }> {
  const ev = await gatewayAppendOnClient(client, { ...scope, actor }, {
    who: { type: actor.type, id: actor.id },
    context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: draft.channel ?? "inapp" },
    object: { type: draft.objectType, id: draft.objectId },
    decision: { action: draft.action, after: draft.after },
    rule_impact: [],
  });
  return { eventId: ev.eventId };
}
