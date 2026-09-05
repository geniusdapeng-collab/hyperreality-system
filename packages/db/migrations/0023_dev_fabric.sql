-- 0023_dev_fabric.sql · 开发场域（DevFabric）——AI Coding 工具接入与开发闭环
-- 范围：设备探测台账 / 仓库白名单 / 开发任务单 / 机床会话 / 会话事件流 /
--       变更回收（三道关结果）/ 版本台账 / 围栏拦截留痕
-- 纪律：RLS 工作区隔离（与 0021/0022 同口径）；机床只活 worktree，主分支零直写；
--      dev_repos 与 releases 属客户资产——一键清空不删（红线同 biz_events）。

-- ① 设备探测台账（本机 AI Coding CLI：codex / claude-code / aider …）
CREATE TABLE IF NOT EXISTS dev_tool_installs (
  id            TEXT PRIMARY KEY,                    -- dti-<tool_key>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  tool_key      TEXT NOT NULL,                       -- codex / claude-code / aider
  bin_path      TEXT NOT NULL,
  version       TEXT NOT NULL DEFAULT 'unknown',
  capabilities  JSONB NOT NULL DEFAULT '{}',         -- { headless, streamEvents, sessionResume, sandboxFlag }
  credential_health TEXT NOT NULL DEFAULT 'unknown' CHECK (credential_health IN ('healthy','missing','unknown')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','lost')),
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, tool_key)
);
ALTER TABLE dev_tool_installs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_dev_tool_installs_ws ON dev_tool_installs;
CREATE POLICY p_dev_tool_installs_ws ON dev_tool_installs
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ② 仓库白名单（人类登记——未登记的目录机床一寸都进不去）
CREATE TABLE IF NOT EXISTS dev_repos (
  id            TEXT PRIMARY KEY,                    -- dr-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  path          TEXT NOT NULL,                       -- 本机绝对路径（登记时校验确为 git 仓库）
  baseline_branch TEXT NOT NULL DEFAULT 'main',
  allowed_dirs  JSONB NOT NULL DEFAULT '[]',         -- 额外约束：机床只许碰的目录（空=仓库内不限）
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  registered_by TEXT NOT NULL,                       -- 人类成员 member_no（供给纪律）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, path)
);
ALTER TABLE dev_repos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_dev_repos_ws ON dev_repos;
CREATE POLICY p_dev_repos_ws ON dev_repos
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ③ 开发任务单（S2 拆解产物；状态机：draft→confirmed→running→auditing→pending_approval→released/rejected/failed/canceled）
CREATE TABLE IF NOT EXISTS dev_tasks (
  id            TEXT PRIMARY KEY,                    -- dt-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  prd_ref       TEXT,                                -- 来源 PRD（documents id 或标题）
  repo_id       TEXT NOT NULL REFERENCES dev_repos(id),
  title         TEXT NOT NULL,
  task_prompt   TEXT NOT NULL,                       -- 任务书（buildTaskPrompt 产物）
  acceptance    JSONB NOT NULL DEFAULT '[]',         -- 验收标准逐条
  constraints   JSONB NOT NULL DEFAULT '[]',
  assigned_tool TEXT,                                -- codex / claude-code / aider（空=自动选派）
  change_kind   TEXT NOT NULL DEFAULT 'feat' CHECK (change_kind IN ('feat','fix','breaking','chore')),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','confirmed','running','auditing','pending_approval','released','rejected','failed','canceled')),
  repair_round  INT NOT NULL DEFAULT 0,              -- 返修轮次（上限 2，再败转人工）
  review_note   TEXT,                                -- 人类打回意见（回灌重排）
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE dev_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_dev_tasks_ws ON dev_tasks;
CREATE POLICY p_dev_tasks_ws ON dev_tasks
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE INDEX IF NOT EXISTS idx_dev_tasks_ws ON dev_tasks (workspace_id, status);

-- ④ 机床会话（一次派发一次会话；快照锚点随行）
CREATE TABLE IF NOT EXISTS dev_sessions (
  id            TEXT PRIMARY KEY,                    -- ds-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  task_id       TEXT NOT NULL REFERENCES dev_tasks(id),
  tool_key      TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch        TEXT NOT NULL,
  baseline_commit TEXT NOT NULL,                     -- 快照：基线 commit
  status_fingerprint TEXT NOT NULL,                  -- 快照：status 指纹
  thread_id     TEXT,                                -- 工具侧会话 ID（返修续跑用）
  exit_reason   TEXT CHECK (exit_reason IN ('done','error','timeout','fence_break','canceled')),
  last_message  TEXT,                                -- 机床自总结
  usage         JSONB,                               -- { inputTokens, outputTokens, costUsd }
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ
);
ALTER TABLE dev_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_dev_sessions_ws ON dev_sessions;
CREATE POLICY p_dev_sessions_ws ON dev_sessions
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE INDEX IF NOT EXISTS idx_dev_sessions_task ON dev_sessions (workspace_id, task_id);

-- ⑤ 会话事件流（归一化 DevEvent 落库；payload 已脱敏——凭据模式过滤）
CREATE TABLE IF NOT EXISTS dev_events (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  session_id    TEXT NOT NULL REFERENCES dev_sessions(id),
  seq           INT NOT NULL,
  type          TEXT NOT NULL,                       -- started/progress/file_edited/command_run/usage/done/error/fence_verdict
  payload       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE dev_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_dev_events_ws ON dev_events;
CREATE POLICY p_dev_events_ws ON dev_events
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE INDEX IF NOT EXISTS idx_dev_events_session ON dev_events (workspace_id, session_id, seq);

-- ⑥ 变更回收（S4：diff + 三道关结果——硬门禁/LLM 评审/上线考）
CREATE TABLE IF NOT EXISTS dev_changesets (
  id            TEXT PRIMARY KEY,                    -- dc-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  session_id    TEXT NOT NULL REFERENCES dev_sessions(id),
  task_id       TEXT NOT NULL REFERENCES dev_tasks(id),
  diff_stat     TEXT NOT NULL DEFAULT '',
  files         JSONB NOT NULL DEFAULT '[]',         -- [{ path, added, deleted }]
  untracked     JSONB NOT NULL DEFAULT '[]',
  self_summary  TEXT NOT NULL DEFAULT '',            -- 机床自总结
  gate_results  JSONB NOT NULL DEFAULT '{}',         -- { hardGates:[{name,ok,log}], llmReview:{ok,report}, exam:{examId,score,verdict} }
  gates_passed  BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE dev_changesets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_dev_changesets_ws ON dev_changesets;
CREATE POLICY p_dev_changesets_ws ON dev_changesets
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ⑦ 版本台账（S6：releases 属客户资产，一键清空不删）
CREATE TABLE IF NOT EXISTS releases (
  id            TEXT PRIMARY KEY,                    -- rel-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  repo_id       TEXT NOT NULL REFERENCES dev_repos(id),
  version       TEXT NOT NULL,                       -- v<x.y.z>
  tasks         JSONB NOT NULL DEFAULT '[]',         -- 包含的 task_id 清单
  audit_hash    TEXT,                                -- 审计报告哈希（对照面）
  merge_commit  TEXT,
  changelog     TEXT NOT NULL DEFAULT '',
  released_by   TEXT NOT NULL,                       -- 批准人（人类裁决留痕）
  released_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, repo_id, version)
);
ALTER TABLE releases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_releases_ws ON releases;
CREATE POLICY p_releases_ws ON releases
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ⑧ 围栏拦截留痕（复盘素材：机床试图干过什么）
CREATE TABLE IF NOT EXISTS dev_fences_audit (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  session_id    TEXT NOT NULL REFERENCES dev_sessions(id),
  cmd           TEXT NOT NULL,
  verdict       TEXT NOT NULL CHECK (verdict IN ('deny','escalate')),
  rule_id       TEXT,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE dev_fences_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_dev_fences_audit_ws ON dev_fences_audit;
CREATE POLICY p_dev_fences_audit_ws ON dev_fences_audit
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- 授权（与 0018/0021/0022 同口径：app 角色全 CRUD；序列附USAGE）
GRANT SELECT, INSERT, UPDATE, DELETE ON dev_tool_installs TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON dev_repos TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON dev_tasks TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON dev_sessions TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON dev_events TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON dev_changesets TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON releases TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON dev_fences_audit TO workloom_app;
GRANT USAGE, SELECT ON SEQUENCE dev_events_id_seq TO workloom_app;
GRANT USAGE, SELECT ON SEQUENCE dev_fences_audit_id_seq TO workloom_app;
