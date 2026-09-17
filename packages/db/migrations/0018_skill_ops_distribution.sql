-- 0018_skill_ops_distribution.sql · 技能保鲜环 P0：下行分发通道（技能运营台 → 客户实例）
-- 背景：方案 v0.2 §3——技能分发元数据 + staging 区 + 回滚快照 + 静默策略 + 同步游标。
-- 红线：L0/L1（内容面）可静默；L2（新依赖/新工具/新出站域）永不静默、走审批；
--      staging 五道预检不过不装载；状态存表、事实进 biz_events 哈希链（一切技能操作皆事件）。

-- ① 技能分发元数据（类型事实源 = packages/base/skill-ops/types.ts 的 zod schema）
ALTER TABLE skills ADD COLUMN IF NOT EXISTS dist_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ② staging 区：下载的技能包在此完成五道预检与 L0/L1/L2 定级，L2 挂审批，不直接进运行时
CREATE TABLE IF NOT EXISTS skill_dist_staging (
  id            TEXT PRIMARY KEY,                    -- stg-<skillId>-<version>
  skill_id      TEXT NOT NULL,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  tier          TEXT NOT NULL CHECK (tier IN ('L0','L1','L2')),
  package       JSONB NOT NULL,                      -- 完整分发包（含签名与元数据）
  checks        JSONB NOT NULL DEFAULT '[]',         -- 五道预检结果明细
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','loaded','rejected','superseded')),
  approval_id   TEXT,                                -- L2 关联审批单
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ
);
ALTER TABLE skill_dist_staging ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_skill_dist_staging_ws ON skill_dist_staging
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ③ 回滚快照：装载前保存旧 skills 行 + 旧 install 行，回滚即恢复（快照口径与 #17 一致）
CREATE TABLE IF NOT EXISTS skill_dist_snapshots (
  id            TEXT PRIMARY KEY,                    -- snap-<skillId>-<毫秒>-<随机尾>
  skill_id      TEXT NOT NULL,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  skill_row     JSONB,                               -- 旧 skills 行（首装为 null）
  install_row   JSONB,                               -- 旧 skill_installs 行（未安装为 null）
  reason        TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE skill_dist_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_skill_dist_snapshots_ws ON skill_dist_snapshots
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ④ 静默策略（工作区级）：silent=L0/L1 默认静默；prompt=提示后升级（L2 无静默选项）
CREATE TABLE IF NOT EXISTS skill_dist_policy (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id),
  silent_mode   TEXT NOT NULL DEFAULT 'silent' CHECK (silent_mode IN ('silent','prompt')),
  updated_by    TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE skill_dist_policy ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_skill_dist_policy_ws ON skill_dist_policy
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ⑤ 同步游标（每工作区一行：上次成功拉取的 manifest 版本与时刻）
CREATE TABLE IF NOT EXISTS skill_dist_state (
  workspace_id          TEXT PRIMARY KEY REFERENCES workspaces(id),
  last_manifest_version TEXT NOT NULL DEFAULT '',
  last_sync_at          TIMESTAMPTZ
);
ALTER TABLE skill_dist_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_skill_dist_state_ws ON skill_dist_state
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- 授权（与 0001/0006 同口径：app 全 CRUD，gateway 只读——事件事实走 append_event_insert 通道）
GRANT SELECT, INSERT, UPDATE, DELETE ON skill_dist_staging TO workloom_app;
GRANT SELECT ON skill_dist_staging TO workloom_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON skill_dist_snapshots TO workloom_app;
GRANT SELECT ON skill_dist_snapshots TO workloom_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON skill_dist_policy TO workloom_app;
GRANT SELECT ON skill_dist_policy TO workloom_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON skill_dist_state TO workloom_app;
GRANT SELECT ON skill_dist_state TO workloom_gateway;
