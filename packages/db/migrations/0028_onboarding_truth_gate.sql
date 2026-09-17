-- 0028_onboarding_truth_gate.sql · 定制装配与正式运行真实性门禁
-- 纪律：草案确认后先形成不可运行的 staged 候选；考试必须绑定候选版本与哈希；
--       只有绑定考试通过后，候选资产才可在同一事务内切换为 active/ready。

-- ① 编制草案补齐来源、不可变指纹与恢复状态。
ALTER TABLE wizard_staffing_drafts
  DROP CONSTRAINT IF EXISTS wizard_staffing_drafts_status_check;
ALTER TABLE wizard_staffing_drafts
  ADD CONSTRAINT wizard_staffing_drafts_status_check
  CHECK (status IN ('draft','confirmed','assembled','exam_failed','active','retired'));
ALTER TABLE wizard_staffing_drafts
  ADD COLUMN IF NOT EXISTS generation_mode TEXT NOT NULL DEFAULT 'unknown'
    CHECK (generation_mode IN ('real','mock','unknown')),
  ADD COLUMN IF NOT EXISTS draft_hash TEXT,
  ADD COLUMN IF NOT EXISTS confirmed_by TEXT,
  ADD COLUMN IF NOT EXISTS assembly_version INTEGER,
  ADD COLUMN IF NOT EXISTS assembly_hash TEXT,
  ADD COLUMN IF NOT EXISTS assembled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

-- ② 装配台账增加 staged 状态与考试绑定；旧 active/uninstalled 行保持兼容。
ALTER TABLE bundle_installs
  DROP CONSTRAINT IF EXISTS bundle_installs_status_check;
ALTER TABLE bundle_installs
  ADD CONSTRAINT bundle_installs_status_check
  CHECK (status IN ('staged','active','uninstalled'));
ALTER TABLE bundle_installs
  ADD COLUMN IF NOT EXISTS draft_id TEXT REFERENCES wizard_staffing_drafts(id),
  ADD COLUMN IF NOT EXISTS assembly_version INTEGER,
  ADD COLUMN IF NOT EXISTS assembly_hash TEXT,
  ADD COLUMN IF NOT EXISTS qualified_exam_id TEXT,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bundle_installs_draft
  ON bundle_installs (workspace_id, draft_id) WHERE draft_id IS NOT NULL;

-- ③ 考试场次写入不可变的候选目标。NOT VALID 仅兼容历史无绑定 wizard 场次；新写入立即受约束。
ALTER TABLE eval_exams
  ADD COLUMN IF NOT EXISTS target_install_id TEXT REFERENCES bundle_installs(id),
  ADD COLUMN IF NOT EXISTS target_draft_id TEXT REFERENCES wizard_staffing_drafts(id),
  ADD COLUMN IF NOT EXISTS target_version INTEGER,
  ADD COLUMN IF NOT EXISTS target_hash TEXT,
  ADD COLUMN IF NOT EXISTS assessment_kind TEXT NOT NULL DEFAULT 'shared-dialog'
    CHECK (assessment_kind IN ('shared-dialog','candidate-role'));
ALTER TABLE eval_exams
  ADD CONSTRAINT eval_exams_wizard_target_check
  CHECK (
    trigger_source <> 'wizard'
    OR (
      target_install_id IS NOT NULL
      AND target_draft_id IS NOT NULL
      AND target_version IS NOT NULL
      AND target_hash IS NOT NULL
      AND assessment_kind = 'candidate-role'
    )
  ) NOT VALID;

ALTER TABLE bundle_installs
  ADD CONSTRAINT bundle_installs_qualified_exam_fk
  FOREIGN KEY (qualified_exam_id) REFERENCES eval_exams(id);

-- ④ 定制上岗考逐候选留卷。题面、原始答卷、四维成绩与能力声明均绑定同一装配指纹。
CREATE TABLE IF NOT EXISTS eval_candidate_results (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  exam_id           TEXT NOT NULL REFERENCES eval_exams(id),
  install_id        TEXT NOT NULL REFERENCES bundle_installs(id),
  draft_id          TEXT NOT NULL REFERENCES wizard_staffing_drafts(id),
  assembly_version  INTEGER NOT NULL,
  assembly_hash     TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  role_title        TEXT NOT NULL,
  question          JSONB NOT NULL,
  raw_answer        TEXT NOT NULL DEFAULT '',
  parsed_answer     JSONB,
  dimension_scores  JSONB NOT NULL,
  declared_skills   JSONB NOT NULL DEFAULT '[]',
  installed_skills  JSONB NOT NULL DEFAULT '[]',
  installed_tools   JSONB NOT NULL DEFAULT '[]',
  passed            BOOLEAN NOT NULL,
  red_line_hit      BOOLEAN NOT NULL DEFAULT false,
  failure_reasons   JSONB NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (exam_id, agent_id)
);
ALTER TABLE eval_candidate_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_eval_candidate_results_ws ON eval_candidate_results
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON eval_candidate_results TO workloom_app;
GRANT SELECT ON eval_candidate_results TO workloom_gateway;

CREATE INDEX IF NOT EXISTS idx_bundle_installs_assembly
  ON bundle_installs (workspace_id, status, assembly_version DESC);
CREATE INDEX IF NOT EXISTS idx_eval_exams_target
  ON eval_exams (workspace_id, target_install_id, target_version, target_hash);
CREATE INDEX IF NOT EXISTS idx_eval_candidate_results_exam
  ON eval_candidate_results (workspace_id, exam_id, agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_eval_wizard_running_install
  ON eval_exams (target_install_id)
  WHERE trigger_source='wizard' AND status='running' AND target_install_id IS NOT NULL;
