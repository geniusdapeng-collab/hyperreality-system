-- 0026_tenant_overlay.sql · 租户覆盖层（Tenant Overlay，方案 V1.1 对焦确认版）
-- 三层资产栈：L0 基座 → L1 行业包 → L2 租户覆盖层；DB 为主存储 + 可导出快照。
-- 铁律：叠加不分叉（Overlay, never Fork）；覆盖声明按租户隔离（RLS），版本单调递增。

-- 覆盖层文档（每租户 × 每行业包一份活跃文档；历史版本全部留档供回滚与审计）
CREATE TABLE IF NOT EXISTS tenant_overlays (
  id               BIGSERIAL PRIMARY KEY,
  workspace_id     TEXT NOT NULL,
  tenant_id        TEXT NOT NULL,
  base_bundle      TEXT NOT NULL,                 -- 对齐的行业包（如 hotel）
  base_version     TEXT NOT NULL,                 -- rebase 锚点：当前对齐的行业包版本
  overlay_version  INTEGER NOT NULL,              -- 覆盖层自身版本号（每次变更 +1）
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','canary','active','rolled_back')),
  canary_scope     JSONB,                         -- 灰度范围（status=canary 时必填）
  items            JSONB NOT NULL DEFAULT '[]',   -- 七类覆盖声明数组
  note             TEXT,
  created_by       TEXT,                          -- 变更人（五元组之"谁"）
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, base_bundle, overlay_version)
);
CREATE INDEX IF NOT EXISTS idx_tenant_overlays_active
  ON tenant_overlays (tenant_id, base_bundle, status);
CREATE INDEX IF NOT EXISTS idx_tenant_overlays_ws
  ON tenant_overlays (workspace_id, base_bundle);

ALTER TABLE tenant_overlays ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_tenant_overlays_ws ON tenant_overlays
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- 激活快照（每次进入 active 时自动留档；一键回滚=恢复最近快照并新版本号激活）
CREATE TABLE IF NOT EXISTS tenant_overlay_snapshots (
  id               BIGSERIAL PRIMARY KEY,
  workspace_id     TEXT NOT NULL,
  tenant_id        TEXT NOT NULL,
  base_bundle      TEXT NOT NULL,
  overlay_version  INTEGER NOT NULL,              -- 快照来源版本
  doc              JSONB NOT NULL,                -- 完整覆盖层文档快照（可导出）
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_overlay_snapshots_lookup
  ON tenant_overlay_snapshots (tenant_id, base_bundle, overlay_version DESC);

ALTER TABLE tenant_overlay_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_tenant_overlay_snapshots_ws ON tenant_overlay_snapshots
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
