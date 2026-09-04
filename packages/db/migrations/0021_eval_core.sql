-- 0021_eval_core.sql · 考试院 P0：内置 AI 员工评测体系（方案 V2.0 §11）
-- 范围：题库 / 考试场次 / 答题卡 / 判卷明细 / 判官校准 / 成绩单 / 客户自带题 / 设置
-- 纪律：
--   ① schema 先行——四维记分卡（accuracy/recall/latency/satisfaction）与
--      结构×维度双标签（single-single / single-multi / multi-single / multi-multi / adversarial）入库即定型；
--   ② 全部表 RLS 工作区隔离（与 skill_ops 同口径：app.workspace_id GUC）；
--   ③ 成绩单/卡晋升授权/处置动作后续写入事件库哈希链（P1 联动，表结构已留 event_id 位）。

-- ① 题库
CREATE TABLE IF NOT EXISTS eval_questions (
  id            TEXT PRIMARY KEY,                    -- evq-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  subject       TEXT NOT NULL,                       -- 七科：skill/fence/crew/knowledge-base/model-route/biz-flow/feedback
  structure     TEXT NOT NULL CHECK (structure IN (
                  'single-single','single-multi','multi-single','multi-multi','adversarial')),
  primary_dimensions JSONB NOT NULL DEFAULT '[]',    -- ['accuracy','recall','latency','satisfaction'] 子集
  red_line      BOOLEAN NOT NULL DEFAULT false,      -- 红线题：错一道即本科目不合格
  difficulty    TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  source        TEXT NOT NULL,                       -- fence-auto/kb-auto/seed/reject-convert/incident-convert/customer
  tags          JSONB NOT NULL DEFAULT '[]',
  scenario      JSONB NOT NULL,                      -- { turns: [{ role, input }] } 多轮按轮次
  assertions    JSONB NOT NULL DEFAULT '[]',         -- 硬断言集（断言 DSL，见 eval-core/assertions）
  judge_rubric  JSONB,                               -- 软题评分标准（L3 用，P1 启用）
  parameterized JSONB,                               -- 参数化变体模板（防背题，P2 启用）
  holdout       BOOLEAN NOT NULL DEFAULT false,      -- 隐藏集：不回流错题本（防应试）
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE eval_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_eval_questions_ws ON eval_questions
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE INDEX IF NOT EXISTS idx_eval_questions_subject ON eval_questions (workspace_id, subject, status);

-- ② 考试场次
CREATE TABLE IF NOT EXISTS eval_exams (
  id            TEXT PRIMARY KEY,                    -- evx-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  exam_type     TEXT NOT NULL CHECK (exam_type IN ('on-change','weekly','onboarding')),
  trigger_source TEXT NOT NULL DEFAULT 'manual',     -- manual/config-change/schedule/signal
  subject_scope JSONB NOT NULL DEFAULT '[]',         -- 参考科目（空=全科）
  total_questions INT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  total_score   NUMERIC(5,1),                        -- 加权总分（0-100）
  dim_scores    JSONB,                               -- { accuracy, recall, latency, satisfaction }
  red_line_hit  BOOLEAN NOT NULL DEFAULT false,      -- 是否触碰红线（一票否决）
  verdict       TEXT CHECK (verdict IN ('pass','warn','fail')),  -- ≥85 pass / 70-85 warn / <70 或红线 fail
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
ALTER TABLE eval_exams ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_eval_exams_ws ON eval_exams
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE INDEX IF NOT EXISTS idx_eval_exams_started ON eval_exams (workspace_id, started_at DESC);

-- ③ 答题卡（题目×场次）
CREATE TABLE IF NOT EXISTS eval_answers (
  id            TEXT PRIMARY KEY,                    -- eva-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  exam_id       TEXT NOT NULL REFERENCES eval_exams(id),
  question_id   TEXT NOT NULL REFERENCES eval_questions(id),
  conversation_id TEXT,                              -- 考场会话（事件链指针）
  replies       JSONB NOT NULL DEFAULT '[]',         -- 逐轮回复 [{ turn, text, citations, intent, latency_ms }]
  assertion_results JSONB NOT NULL DEFAULT '[]',     -- [{ assertion, pass, detail }]
  dim_scores    JSONB NOT NULL DEFAULT '{}',         -- 本题四维得分 { accuracy: 0|1, ... }
  passed        BOOLEAN NOT NULL,
  red_line_hit  BOOLEAN NOT NULL DEFAULT false,
  attribution   TEXT,                                -- 六分类：intent/skill/knowledge/tool/fence-config/model-tier
  suggestion    TEXT,                                -- 建议动作
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE eval_answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_eval_answers_ws ON eval_answers
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE INDEX IF NOT EXISTS idx_eval_answers_exam ON eval_answers (workspace_id, exam_id);

-- ④ 判卷明细（L3 阅卷留痕，P1 启用；表先建）
CREATE TABLE IF NOT EXISTS eval_judge_logs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  answer_id     TEXT NOT NULL REFERENCES eval_answers(id),
  dimension     TEXT NOT NULL,
  reasoning     TEXT NOT NULL,                       -- 先理由后打分（纪律）
  score         NUMERIC(4,1) NOT NULL,
  model_tier    TEXT NOT NULL DEFAULT 'L3',
  tokens_used   INT NOT NULL DEFAULT 0,
  double_judged BOOLEAN NOT NULL DEFAULT false,      -- 双判抽验标记
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE eval_judge_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_eval_judge_logs_ws ON eval_judge_logs
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ⑤ 判官校准（黄金集周检，P2 启用；表先建）
CREATE TABLE IF NOT EXISTS eval_judge_calibration (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  golden_id     TEXT NOT NULL,                       -- 黄金校准题 ID
  expected_band TEXT NOT NULL,                       -- 人工标定档位 full/partial/zero
  actual_band   TEXT NOT NULL,                       -- 判官实际档位
  drift_alert   BOOLEAN NOT NULL DEFAULT false,      -- 偏差>1 档告警
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE eval_judge_calibration ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_eval_judge_calibration_ws ON eval_judge_calibration
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ⑥ 成绩单（上链存证留位）
CREATE TABLE IF NOT EXISTS eval_reports (
  id            TEXT PRIMARY KEY,                    -- evr-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  exam_id       TEXT NOT NULL REFERENCES eval_exams(id),
  total_score   NUMERIC(5,1) NOT NULL,
  dim_scores    JSONB NOT NULL,
  subject_scores JSONB NOT NULL DEFAULT '{}',        -- 各科分数与涨落
  delta         JSONB,                               -- vs 上一场：{ total, per_subject }
  verdict       TEXT NOT NULL CHECK (verdict IN ('pass','warn','fail')),
  red_line_hit  BOOLEAN NOT NULL DEFAULT false,
  wrong_count   INT NOT NULL DEFAULT 0,
  suggestions   JSONB NOT NULL DEFAULT '[]',         -- 建议动作汇总
  event_id      TEXT,                                -- 事件库哈希链存证指针（P1 联动写入）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE eval_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_eval_reports_ws ON eval_reports
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ⑦ 客户自带题（自然语言出题，P2 启用；表先建）
CREATE TABLE IF NOT EXISTS eval_customer_rules (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  natural_text  TEXT NOT NULL,                       -- 主理人原文「凡是退款的回答都要考一遍措辞」
  compiled      JSONB,                               -- L3 编译产物（结构化考题草稿）
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','retired')),
  question_ids  JSONB NOT NULL DEFAULT '[]',         -- 入库后生成的题目
  stats         JSONB NOT NULL DEFAULT '{}',         -- 战绩：{ exams, intercepted }
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE eval_customer_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_eval_customer_rules_ws ON eval_customer_rules
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ⑧ 设置（频率/预算/卡晋升授权）
CREATE TABLE IF NOT EXISTS eval_settings (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id),
  on_change_enabled    BOOLEAN NOT NULL DEFAULT true,   -- 变更即考
  weekly_enabled       BOOLEAN NOT NULL DEFAULT true,   -- 周考
  promotion_gate       BOOLEAN NOT NULL DEFAULT false,  -- 卡晋升：默认关，主理人授权开启（留痕上链）
  promotion_gate_event_id TEXT,                         -- 授权动作上链指针
  budget_monthly_tokens BIGINT NOT NULL DEFAULT 2000000,-- 月度 token 预算上限
  pass_line     NUMERIC(4,1) NOT NULL DEFAULT 85,       -- 上岗线
  warn_line     NUMERIC(4,1) NOT NULL DEFAULT 70,       -- 预警线
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE eval_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_eval_settings_ws ON eval_settings
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ⑨ 授权（与 0018 同口径：app 角色全 CRUD；gateway 只读成绩单/场次用于 C 端只读场景预留）
GRANT SELECT, INSERT, UPDATE, DELETE ON eval_questions TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON eval_exams TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON eval_answers TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON eval_judge_logs TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON eval_judge_calibration TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON eval_reports TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON eval_customer_rules TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON eval_settings TO workloom_app;
GRANT SELECT ON eval_reports, eval_exams TO workloom_gateway;
