-- 0022_bundle_mechanism.sql · 行业装配通用机制（方案 V4 §1.1/§1.3/§1.5）
-- 范围：命名三层（members.alias）/ 示例包标记（workspaces.bundle_id+is_example）
--       / 装配台账（bundle_installs）/ 清空快照（bundle_snapshots）/ 编制草案（wizard_staffing_drafts）
-- 纪律：RLS 工作区隔离；授权与 0018/0021 同口径（app 全 CRUD）。

-- ① 命名三层：agents.alias（数字员工别名层）+ members.alias（人类成员别名层）
--    显示规则：displayName = alias ?? role_title(bundle name) ?? 兜底名；ID 永不变，改名零迁移
ALTER TABLE agents ADD COLUMN IF NOT EXISTS alias TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS alias TEXT;

-- ② 工作区行业包标记（示例明示驱动）
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS bundle_id TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_example BOOLEAN NOT NULL DEFAULT false;

-- ③ 装配台账（一键清空的精确卸载依据——装载即登记，卸载按台账）
CREATE TABLE IF NOT EXISTS bundle_installs (
  id            TEXT PRIMARY KEY,                    -- bi-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  bundle_id     TEXT NOT NULL,                       -- 如 ai-pm / hotel
  assets        JSONB NOT NULL DEFAULT '{}',         -- { preset_ids:[], skill_bindings:[], fence_rule_ids:[], kb_collection_ids:[], seed_batch_id, floor_scene_id }
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','uninstalled')),
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  uninstalled_at TIMESTAMPTZ
);
ALTER TABLE bundle_installs ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_bundle_installs_ws ON bundle_installs
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE INDEX IF NOT EXISTS idx_bundle_installs_ws ON bundle_installs (workspace_id, status);

-- ④ 清空快照（30 天可回滚；快照未成功写入禁止清空——清空前强制检查）
CREATE TABLE IF NOT EXISTS bundle_snapshots (
  id            TEXT PRIMARY KEY,                    -- bs-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  bundle_id     TEXT NOT NULL,
  install_id    TEXT REFERENCES bundle_installs(id),
  payload       JSONB NOT NULL,                      -- 装配+关联数据全量快照（预览即所删的对照面）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  restored_at   TIMESTAMPTZ
);
ALTER TABLE bundle_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_bundle_snapshots_ws ON bundle_snapshots
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ⑤ L3 编制生成草案（人审前零写入——草案先行，确认才装配）
CREATE TABLE IF NOT EXISTS wizard_staffing_drafts (
  id            TEXT PRIMARY KEY,                    -- wsd-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  industry_text TEXT NOT NULL,                       -- 客户自然语言行业描述原文
  compiled      JSONB NOT NULL,                      -- L3 编译产物（team/fences/skills_suggested 契约结构）
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','assembled','retired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at  TIMESTAMPTZ
);
ALTER TABLE wizard_staffing_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_wizard_staffing_drafts_ws ON wizard_staffing_drafts
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ⑥ 授权（与 0018/0021 同口径）
GRANT SELECT, INSERT, UPDATE, DELETE ON bundle_installs TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON bundle_snapshots TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON wizard_staffing_drafts TO workloom_app;
