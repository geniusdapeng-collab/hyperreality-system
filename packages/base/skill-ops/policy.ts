/**
 * skill-ops · 静默策略（工作区级）
 *
 * silent（默认）：L0/L1 夜班窗口静默装载，角标提示不打扰；
 * prompt：L0/L1 也只入 staging 待人工装载（"提示后升级"全局开关）。
 * L2 无静默选项——策略只作用于内容面，执行面/权限面永远走审批（铁律不可配置）。
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "../workdata/gateway.js";
import type { SilentMode } from "./types.js";

interface Scope { tenantId: string; workspaceId: string }

export async function getSilentMode(app: pg.Pool, scope: Scope): Promise<SilentMode> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{ silent_mode: SilentMode }>(
      `SELECT silent_mode FROM skill_dist_policy WHERE workspace_id=$1`, [scope.workspaceId]);
    await client.query("COMMIT");
    return r.rows[0]?.silent_mode ?? "silent"; // 默认静默（方案 §4.1 决策点①推荐口径）
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

export async function getAutoSync(app: pg.Pool, scope: Scope): Promise<boolean> {
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    const r = await client.query<{ auto_sync: boolean }>(
      `SELECT auto_sync FROM skill_dist_policy WHERE workspace_id=$1`, [scope.workspaceId]);
    await client.query("COMMIT");
    return r.rows[0]?.auto_sync ?? true; // 默认自动同步（机制即自动；客户可关=治理主权）
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

/** 策略变更（D16：策略行与 skill.dist.policy 事件同一事务同一 COMMIT；upsert 幂等）
 *  mode 与 autoSync 均可选——传谁改谁，至少传一个 */
export async function setSilentMode(
  app: pg.Pool, gateway: pg.Pool, scope: Scope,
  input: { mode?: SilentMode; autoSync?: boolean; by: string },
): Promise<{ mode?: SilentMode; autoSync?: boolean }> {
  void gateway; // 事件走 app 池事务内 OnClient 通道（D16 双池一致性；gateway 参数保留统一签名）
  if (input.mode === undefined && input.autoSync === undefined) {
    throw new Error("setSilentMode：mode 与 autoSync 至少传一个");
  }
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query(
      `INSERT INTO skill_dist_policy (workspace_id, silent_mode, auto_sync, updated_by, updated_at)
       VALUES ($1, COALESCE($2, 'silent'), COALESCE($3, true), $4, now())
       ON CONFLICT (workspace_id) DO UPDATE SET
         silent_mode = COALESCE($2, skill_dist_policy.silent_mode),
         auto_sync   = COALESCE($3, skill_dist_policy.auto_sync),
         updated_by  = $4, updated_at = now()`,
      [scope.workspaceId, input.mode ?? null, input.autoSync ?? null, input.by]);
    await gatewayAppendOnClient(client, {
      tenantId: scope.tenantId, workspaceId: scope.workspaceId,
      actor: { id: input.by, type: "human" },
    }, {
      who: { type: "human", id: input.by },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "skill_dist_policy", id: scope.workspaceId },
      decision: {
        action: "skill.dist.policy",
        after: { silentMode: input.mode ?? null, autoSync: input.autoSync ?? null },
        basis: ["静默策略仅作用于 L0/L1 内容面；L2 执行面/权限面永不静默（方案 v0.2 §3.3 红线）；auto_sync 是客户侧自动同步总开关（治理主权）"],
      } as never,
      rule_impact: [],
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally { client.release(); }
  return { mode: input.mode, autoSync: input.autoSync };
}
