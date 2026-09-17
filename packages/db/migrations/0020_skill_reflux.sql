-- 0020_skill_reflux.sql · 技能保鲜环 P1：上行回流通道 + 官方消化流水线
-- 背景：方案 v0.2 §4——客户优秀技能脱敏回流 → 官方聚类评分 → 抽象完善 → 再分发（闭环）。
-- 红线（D19 四条）：opt-in 默认关 / 预览即所发 / PII 脱敏管道且不含经营数据 / 发送行为入事件库。
-- 表设计：
--   skill_reflux_outbox（客户侧，RLS 工作区隔离）：待发送/已发送/失败的回流草案；
--   skill_reflux_inbox（官方侧，平台级表无 RLS，与 skills 全局表同口径）：
--     官方运营台实例接收的草案——只在官方部署（SKILL_OPS_MODE=official）写入，
--     客户实例永不写此表（客户端只经 HTTPS POST 上送）。

-- ① 回流 opt-in 开关（D19：默认不发送，可随时关闭）
ALTER TABLE skill_dist_policy ADD COLUMN IF NOT EXISTS reflux_opt_in BOOLEAN NOT NULL DEFAULT false;

-- ② 客户侧 outbox（RLS 工作区隔离）
CREATE TABLE IF NOT EXISTS skill_reflux_outbox (
  id            TEXT PRIMARY KEY,                    -- rfo-<skillId>-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  skill_id      TEXT NOT NULL,
  payload       JSONB NOT NULL,                      -- 脱敏后的完整上送包（预览即所发的「所发」）
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ
);
ALTER TABLE skill_reflux_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_skill_reflux_outbox_ws ON skill_reflux_outbox
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ③ 官方侧 inbox（平台级表：无 RLS——官方运营台跨工作区视角；仅官方部署写入）
CREATE TABLE IF NOT EXISTS skill_reflux_inbox (
  id            TEXT PRIMARY KEY,                    -- rfi-<毫秒>-<随机尾>
  from_tenant   TEXT NOT NULL,                       -- 来源归属（数据=列值，不靠 RLS）
  from_workspace TEXT NOT NULL,
  skill_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL DEFAULT '1.0.0',
  description   TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  meta          JSONB NOT NULL DEFAULT '{}',
  signals       JSONB NOT NULL DEFAULT '{}',         -- 客户侧六信号摘要（预览即所发内含）
  cluster_key   TEXT NOT NULL DEFAULT '',            -- 聚类键（名称归一化）
  status        TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox','officialized','rejected')),
  reviews       JSONB NOT NULL DEFAULT '[]',         -- 双人复核手势（D15-② 同构）
  decided_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ
);

-- 授权（与 0001/0006/0018 同口径）
GRANT SELECT, INSERT, UPDATE, DELETE ON skill_reflux_outbox TO workloom_app;
GRANT SELECT ON skill_reflux_outbox TO workloom_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON skill_reflux_inbox TO workloom_app;
GRANT SELECT ON skill_reflux_inbox TO workloom_gateway;
