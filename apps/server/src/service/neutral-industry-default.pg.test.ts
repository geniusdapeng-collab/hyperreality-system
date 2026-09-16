/** 新工作区中性行业默认值：迁移只改未来默认值，不批量改写已有事实或账本。 */
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const migration = readFileSync(
  new URL("../../../../packages/db/migrations/0033_neutral_workspace_industry_default.sql", import.meta.url),
  "utf8",
);

describe("0033 中性行业默认值迁移", () => {
  it("只修改列默认值，不包含数据改写或账本操作", () => {
    const executable = migration.replace(/--.*$/gm, "");
    expect(executable).toMatch(/ALTER TABLE workspaces ALTER COLUMN industry SET DEFAULT 'general'/);
    expect(executable).not.toMatch(/\b(?:UPDATE|DELETE|INSERT|TRUNCATE)\b/i);
    expect(executable).not.toMatch(/biz_events/i);
  });
});

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
describe.runIf(RUN_DB)("0033 中性行业默认值 PG 契约", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenantId = `tenant-neutral-${suffix}`;
  const workspaceId = `ws-neutral-${suffix}`;

  afterAll(async () => {
    await owner.query(`DELETE FROM workspaces WHERE id=$1`, [workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    await owner.end();
  });

  it("省略 industry 的新工作区得到 general，显式行业值仍由调用方控制", async () => {
    const column = await owner.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name='workspaces' AND column_name='industry'`,
    );
    expect(column.rows[0]?.column_default).toContain("general");
    await owner.query(`INSERT INTO tenants (id, name, plan) VALUES ($1,$2,'community')`, [tenantId, "中性默认值验收租户"]);
    const workspace = await owner.query<{ industry: string }>(
      `INSERT INTO workspaces (id, tenant_id, name, slug) VALUES ($1,$2,$3,$4) RETURNING industry`,
      [workspaceId, tenantId, "中性默认值工作区", `neutral-${suffix}`],
    );
    expect(workspace.rows[0]?.industry).toBe("general");
  });
});
