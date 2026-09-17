/**
 * overlay/store.test.ts —— 覆盖层 DB 存储集成测试（PG 可用时运行，否则跳过）
 * 链路：草稿 → 灰度 → 激活（快照）→ 版本递增 → 回滚 → 导出 → 非法流转拒绝
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { saveDraft, transition, rollbackToLatestSnapshot, loadActiveOverlay, exportSnapshot, listVersions } from "./store.js";

const DATABASE_URL = process.env.DATABASE_URL
  ?? "postgres://postgres:workloom@127.0.0.1:5432/workloom";
const scope = { workspaceId: "ws-overlay-test", tenantId: "t-overlay-test" };

let pool: pg.Pool | null = null;
let available = false;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await pool.query("SELECT 1");
    // 确保迁移表存在（本地 dev 环境幂等）
    await pool.query(`CREATE TABLE IF NOT EXISTS tenant_overlays (
      id BIGSERIAL PRIMARY KEY, workspace_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
      base_bundle TEXT NOT NULL, base_version TEXT NOT NULL, overlay_version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','canary','active','rolled_back')),
      canary_scope JSONB, items JSONB NOT NULL DEFAULT '[]', note TEXT, created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, base_bundle, overlay_version))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tenant_overlay_snapshots (
      id BIGSERIAL PRIMARY KEY, workspace_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
      base_bundle TEXT NOT NULL, overlay_version INTEGER NOT NULL, doc JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`SELECT set_config('app.workspace_id', $1, true)`, [scope.workspaceId]);
    await pool.query("DELETE FROM tenant_overlays WHERE workspace_id=$1", [scope.workspaceId]);
    await pool.query("DELETE FROM tenant_overlay_snapshots WHERE workspace_id=$1", [scope.workspaceId]);
    available = true;
  } catch { available = false; }
});

afterAll(async () => { await pool?.end(); });

function items(n: number) {
  return [{ type: "persona", op: "override", path: `service-front/tone-${n}`, value: `风格 v${n}` }] as never;
}

describe("覆盖层 DB 存储（集成）", () => {
  it("草稿→灰度→激活（快照）→版本递增→回滚→导出→非法流转拒绝", async () => {
    if (!available || !pool) return;
    const q = { query: pool.query.bind(pool) } as never;

    // v1 草稿 → 灰度 → 激活
    const d1 = await saveDraft(q, scope, {
      tenant_id: scope.tenantId, base_bundle: "hotel", base_version: "2.3.0",
      items: items(1), note: "初版", createdBy: "tester",
    });
    expect(d1.overlay_version).toBe(1);
    expect(d1.status).toBe("draft");

    await expect(transition(q, scope, "hotel", 1, "canary"))
      .rejects.toThrowError(/canary_scope/); // 灰度必须带范围
    const d1c = await saveDraft(q, scope, {
      tenant_id: scope.tenantId, base_bundle: "hotel", base_version: "2.3.0",
      canary_scope: { scenes: ["night"] }, items: items(1), note: "初版灰度",
    });
    expect(d1c.overlay_version).toBe(2);
    await transition(q, scope, "hotel", 2, "canary");
    await transition(q, scope, "hotel", 2, "active");

    const active = await loadActiveOverlay(q, scope, "hotel");
    expect(active?.overlay_version).toBe(2);

    // 非法流转：draft 不可跳过 canary 直激活（完整流水线纪律）
    await expect(transition(q, scope, "hotel", 1, "active")).rejects.toThrowError(/非法状态流转/);

    // v3 激活后，v2 自动转 rolled_back；快照有两份
    const d3 = await saveDraft(q, scope, {
      tenant_id: scope.tenantId, base_bundle: "hotel", base_version: "2.3.0",
      canary_scope: { ratio: 0.1 }, items: items(3),
    });
    expect(d3.overlay_version).toBe(3);
    await transition(q, scope, "hotel", 3, "canary");   // 完整流水线：草稿→灰度→全量
    await transition(q, scope, "hotel", 3, "active");
    const after = await listVersions(q, scope, "hotel");
    expect(after[0]).toMatchObject({ overlay_version: 3, status: "active" });

    // 一键回滚：恢复最近快照（v3 的快照即 v3 自身内容），新版本号 v4 且直接 active
    const rb = await rollbackToLatestSnapshot(q, scope, "hotel", "tester");
    expect(rb.overlay_version).toBe(4);
    expect(rb.status).toBe("active");
    expect(rb.note).toContain("回滚自 v3");

    // 导出快照（客户资产归属）
    const exp = await exportSnapshot(q, scope, "hotel");
    expect(exp?.doc.overlay_version).toBe(4);
    expect(exp?.doc.items.length).toBeGreaterThan(0);
  });
});
