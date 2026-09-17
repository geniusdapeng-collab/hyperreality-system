-- 0029_onboarding_continuity.sql · 首次欢迎与落地向导服务端连续性
-- 纪律：欢迎进度按「账号（无账号的开发成员退回 member）× 角色 × 工作区 × 旅程版本」隔离；
--       标准落地向导草稿按工作区版本化，密钥等秘密不得进入 payload。

CREATE TABLE IF NOT EXISTS onboarding_progress (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  identity_key       TEXT NOT NULL, -- account:<id>；开发/迁移成员可为 member:<id>
  account_id         TEXT REFERENCES accounts(id),
  member_id          TEXT NOT NULL REFERENCES members(id),
  role               TEXT NOT NULL,
  journey_key        TEXT NOT NULL,
  journey_version    INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'not_started'
                     CHECK (status IN ('not_started','in_progress','paused','completed')),
  current_step       TEXT NOT NULL DEFAULT 'start',
  progress           JSONB NOT NULL DEFAULT '{}',
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  replay_count       INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, identity_key, role, journey_key, journey_version)
);
ALTER TABLE onboarding_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_onboarding_progress_ws ON onboarding_progress
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_subject
  ON onboarding_progress (workspace_id, identity_key, role, updated_at DESC);

CREATE TABLE IF NOT EXISTS onboarding_wizard_drafts (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id),
  journey_key            TEXT NOT NULL DEFAULT 'real-mode-setup',
  version                INTEGER NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','completed','abandoned')),
  current_step           INTEGER NOT NULL DEFAULT 0 CHECK (current_step BETWEEN 0 AND 4),
  payload                JSONB NOT NULL DEFAULT '{}',
  responsible_member_id  TEXT NOT NULL REFERENCES members(id),
  responsible_role       TEXT NOT NULL,
  created_by             TEXT NOT NULL REFERENCES members(id),
  updated_by             TEXT NOT NULL REFERENCES members(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at           TIMESTAMPTZ,
  UNIQUE (workspace_id, journey_key)
);
ALTER TABLE onboarding_wizard_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_onboarding_wizard_drafts_ws ON onboarding_wizard_drafts
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE INDEX IF NOT EXISTS idx_onboarding_wizard_responsible
  ON onboarding_wizard_drafts (workspace_id, responsible_member_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_progress TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_wizard_drafts TO workloom_app;
