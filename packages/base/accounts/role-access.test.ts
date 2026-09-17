/**
 * 0026/0027 运行时角色回归：
 *  - workloom_app 只拥有账号域/覆盖层所需的精确动作；
 *  - workloom_gateway 对这些表保持零权限；
 *  - workspace/tenant 业务表必须启用 RLS，未设 scope 默认不可见且跨 scope 写入失败；
 *  - 唯一允许的 DELETE 是验证码发送失败补偿。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";

const RUN_DB = process.env.RUN_DB_TESTS === "1"
  && !!process.env.DATABASE_URL
  && !!process.env.DATABASE_APP_URL
  && !!process.env.DATABASE_GATEWAY_URL;
const d = RUN_DB ? describe : describe.skip;

const TABLE_PRIVILEGES: Record<string, string[]> = {
  accounts: ["INSERT", "SELECT", "UPDATE"],
  api_keys: ["INSERT", "SELECT", "UPDATE"],
  approval_policies: ["INSERT", "SELECT", "UPDATE"],
  auth_sessions: ["INSERT", "SELECT", "UPDATE"],
  login_events: ["INSERT", "SELECT"],
  member_invites: ["INSERT", "SELECT", "UPDATE"],
  partner_grants: ["INSERT", "SELECT", "UPDATE"],
  partner_sessions: ["INSERT", "SELECT", "UPDATE"],
  partners: ["INSERT", "SELECT"],
  tenant_overlay_snapshots: ["INSERT", "SELECT"],
  tenant_overlays: ["INSERT", "SELECT", "UPDATE"],
  tenant_relations: ["INSERT", "SELECT"],
  verification_codes: ["DELETE", "INSERT", "SELECT", "UPDATE"],
};

const RLS_TABLES = [
  "api_keys",
  "approval_policies",
  "member_invites",
  "partner_grants",
  "tenant_overlay_snapshots",
  "tenant_overlays",
  "tenant_relations",
].sort();

d("PG 权限 · 账号域与租户覆盖层最小授权", () => {
  let owner: Pool;
  let app: Pool;
  let gateway: Pool;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenantId = `tenant-role-${suffix}`;
  const workspaceA = `ws-role-a-${suffix}`;
  const workspaceB = `ws-role-b-${suffix}`;
  const accountId = `acc-role-${suffix}`;
  const verificationId = `vcode-role-${suffix}`;
  let overlayId: number | undefined;
  let snapshotId: number | undefined;

  beforeAll(async () => {
    const pg = (await import("pg")).default;
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
    gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });

    await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'pro')`, [tenantId, "角色回归租户"]);
    await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage, night_config)
       VALUES ($1,$3,'权限工作区甲',$4,'test','stable','{}'),
              ($2,$3,'权限工作区乙',$5,'test','stable','{}')`,
      [workspaceA, workspaceB, tenantId, `role-a-${suffix}`, `role-b-${suffix}`],
    );
  });

  afterAll(async () => {
    if (owner) {
      await owner.query(`DELETE FROM tenant_overlay_snapshots WHERE workspace_id = ANY($1::text[])`, [[workspaceA, workspaceB]]).catch(() => undefined);
      await owner.query(`DELETE FROM tenant_overlays WHERE workspace_id = ANY($1::text[])`, [[workspaceA, workspaceB]]).catch(() => undefined);
      await owner.query(`DELETE FROM verification_codes WHERE id=$1`, [verificationId]).catch(() => undefined);
      await owner.query(`DELETE FROM accounts WHERE id=$1`, [accountId]).catch(() => undefined);
      await owner.query(`DELETE FROM workspaces WHERE id = ANY($1::text[])`, [[workspaceA, workspaceB]]).catch(() => undefined);
      await owner.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    }
    await Promise.all([owner?.end(), app?.end(), gateway?.end()]);
  });

  it("workloom_app 权限与白名单逐表完全一致，gateway 无旁路权限", async () => {
    const tableNames = Object.keys(TABLE_PRIVILEGES);
    const grants = await owner.query<{ grantee: string; table_name: string; privilege_type: string }>(
      `SELECT grantee, table_name, privilege_type
       FROM information_schema.role_table_grants
       WHERE table_schema='public'
         AND grantee IN ('workloom_app','workloom_gateway')
         AND table_name = ANY($1::text[])
       ORDER BY grantee, table_name, privilege_type`,
      [tableNames],
    );

    const appPrivileges: Record<string, string[]> = {};
    for (const row of grants.rows.filter((row) => row.grantee === "workloom_app")) {
      (appPrivileges[row.table_name] ??= []).push(row.privilege_type);
    }
    expect(appPrivileges).toEqual(TABLE_PRIVILEGES);
    expect(grants.rows.filter((row) => row.grantee === "workloom_gateway")).toEqual([]);

    const sequenceGrants = await owner.query<{ grantee: string; object_name: string; privilege_type: string }>(
      `SELECT grantee, object_name, privilege_type
       FROM information_schema.role_usage_grants
       WHERE object_schema='public'
         AND object_type='SEQUENCE'
         AND object_name = ANY($1::text[])
         AND grantee IN ('workloom_app','workloom_gateway')
       ORDER BY grantee, object_name, privilege_type`,
      [["tenant_overlays_id_seq", "tenant_overlay_snapshots_id_seq"]],
    );
    expect(sequenceGrants.rows).toEqual([
      { grantee: "workloom_app", object_name: "tenant_overlay_snapshots_id_seq", privilege_type: "USAGE" },
      { grantee: "workloom_app", object_name: "tenant_overlays_id_seq", privilege_type: "USAGE" },
    ]);
  });

  it("所有带 scope 的 0026/0027 表均启用 RLS", async () => {
    const result = await owner.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity
       FROM pg_class
       WHERE relnamespace='public'::regnamespace AND relname = ANY($1::text[])
       ORDER BY relname`,
      [RLS_TABLES],
    );
    expect(result.rows.map((row) => row.relname)).toEqual(RLS_TABLES);
    expect(result.rows.every((row) => row.relrowsecurity)).toBe(true);
  });

  it("覆盖层必要读写可用，未设 scope 默认空，跨工作区写入被数据库拒绝", async () => {
    const inserted = await inScope(app, { tenantId, workspaceId: workspaceA }, async (client) => {
      const result = await client.query<{ id: number }>(
        `INSERT INTO tenant_overlays
           (workspace_id, tenant_id, base_bundle, base_version, overlay_version, status, items)
         VALUES ($1,$2,'test','1.0.0',1,'draft','[]') RETURNING id`,
        [workspaceA, tenantId],
      );
      await client.query(`UPDATE tenant_overlays SET note='权限回归' WHERE id=$1`, [result.rows[0]!.id]);
      const visible = await client.query(`SELECT id FROM tenant_overlays WHERE id=$1`, [result.rows[0]!.id]);
      expect(visible.rows).toHaveLength(1);
      return result.rows[0]!.id;
    });
    overlayId = inserted;

    expect((await app.query(`SELECT id FROM tenant_overlays WHERE id=$1`, [overlayId])).rows).toEqual([]);
    expect((await inScope(app, { tenantId, workspaceId: workspaceB }, (client) =>
      client.query(`SELECT id FROM tenant_overlays WHERE id=$1`, [overlayId]))).rows).toEqual([]);

    await expect(inScope(app, { tenantId, workspaceId: workspaceA }, (client) =>
      client.query(
        `INSERT INTO tenant_overlays
           (workspace_id, tenant_id, base_bundle, base_version, overlay_version, status, items)
         VALUES ($1,$2,'test','1.0.0',2,'draft','[]')`,
        [workspaceB, tenantId],
      ))).rejects.toMatchObject({ code: "42501" });
  });

  it("未授权删除/快照更新失败，快照写入仍可用", async () => {
    expect(overlayId).toBeDefined();
    snapshotId = await inScope(app, { tenantId, workspaceId: workspaceA }, async (client) => {
      const result = await client.query<{ id: number }>(
        `INSERT INTO tenant_overlay_snapshots
           (workspace_id, tenant_id, base_bundle, overlay_version, doc)
         VALUES ($1,$2,'test',1,'{}') RETURNING id`,
        [workspaceA, tenantId],
      );
      return result.rows[0]!.id;
    });

    await expect(inScope(app, { tenantId, workspaceId: workspaceA }, (client) =>
      client.query(`DELETE FROM tenant_overlays WHERE id=$1`, [overlayId]))).rejects.toMatchObject({ code: "42501" });
    await expect(inScope(app, { tenantId, workspaceId: workspaceA }, (client) =>
      client.query(`UPDATE tenant_overlay_snapshots SET doc='{"changed":true}' WHERE id=$1`, [snapshotId]))).rejects.toMatchObject({ code: "42501" });
  });

  it("全局身份域可完成必要操作，但只允许验证码补偿删除", async () => {
    await app.query(
      `INSERT INTO accounts (id, phone, display_name) VALUES ($1,$2,'角色回归账号')`,
      [accountId, `199${String(Date.now()).slice(-8)}`],
    );
    await app.query(`UPDATE accounts SET display_name='角色回归账号（已更新）' WHERE id=$1`, [accountId]);
    expect((await app.query(`SELECT id FROM accounts WHERE id=$1`, [accountId])).rows).toHaveLength(1);
    await expect(app.query(`DELETE FROM accounts WHERE id=$1`, [accountId])).rejects.toMatchObject({ code: "42501" });

    await app.query(
      `INSERT INTO verification_codes (id, channel, target, purpose, code_hash, expires_at)
       VALUES ($1,'phone','19900000000','login','hash',now()+interval '5 minutes')`,
      [verificationId],
    );
    await app.query(`DELETE FROM verification_codes WHERE id=$1`, [verificationId]);
    expect((await owner.query(`SELECT id FROM verification_codes WHERE id=$1`, [verificationId])).rows).toEqual([]);
  });

  it("workloom_gateway 无法读取账号域，避免事件网关越权", async () => {
    await expect(gateway.query(`SELECT id FROM accounts LIMIT 1`)).rejects.toMatchObject({ code: "42501" });
  });
});

async function inScope<T>(
  pool: Pool,
  scope: { tenantId: string; workspaceId: string },
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [scope.tenantId]);
    await client.query("SELECT set_config('app.workspace_id',$1,true)", [scope.workspaceId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
