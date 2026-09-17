-- 0024_secretary.sql · 织伴（LoomMate）24h 贴身小秘书（基座能力）
-- 范围：个人设置（人设/音色/尺寸/勿扰/通道）/ 六层个人记忆 / 提醒收件箱 / 定时提醒
-- 纪律：RLS 工作区隔离（同 0021-0023 口径）；个人记忆 member 维度（查询层强制），
--      与 org_memory（组织层）分野；全部写操作五元事件留痕。

-- ① 个人设置（人设/音色/尺寸/勿扰/IM 与眼镜通道）
CREATE TABLE IF NOT EXISTS secretary_settings (
  id            TEXT PRIMARY KEY,                    -- ss-<member_no>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  member_no     TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '董事长',       -- 它怎么称呼你
  persona_key   TEXT NOT NULL DEFAULT 'tianmei',     -- 人设预设：tianmei(甜妹) / yuanqi(元气) / chenwen(沉稳) / custom
  persona_custom JSONB NOT NULL DEFAULT '{}',        -- { name, tone } 客户自写人设
  voice_key     TEXT NOT NULL DEFAULT 'sweet',       -- 音色：sweet/bright/soft/calm
  voice_on      BOOLEAN NOT NULL DEFAULT true,
  widget_size   TEXT NOT NULL DEFAULT 'large' CHECK (widget_size IN ('large','small')),
  quiet_start   TEXT NOT NULL DEFAULT '22:00',
  quiet_end     TEXT NOT NULL DEFAULT '08:00',
  channels      JSONB NOT NULL DEFAULT '{}',         -- { im: {provider, target}, outbox_urls: [] }
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, member_no)
);
ALTER TABLE secretary_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_secretary_settings_ws ON secretary_settings;
CREATE POLICY p_secretary_settings_ws ON secretary_settings
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- ② 六层个人记忆（身份/事实/偏好/关系/情景/工作）
CREATE TABLE IF NOT EXISTS personal_memory (
  id            TEXT PRIMARY KEY,                    -- pm-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  member_no     TEXT NOT NULL,
  layer         TEXT NOT NULL CHECK (layer IN ('profile','facts','preferences','relations','episodic','working')),
  mkey          TEXT NOT NULL,                       -- 层内键（如 "q4-plan"）
  content       TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'said' CHECK (source IN ('said','observed','inferred')),
  confidence    NUMERIC(3,2) NOT NULL DEFAULT 1.0,
  expires_at    TIMESTAMPTZ,                         -- NULL=永久（身份层）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, member_no, layer, mkey)
);
ALTER TABLE personal_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_personal_memory_ws ON personal_memory;
CREATE POLICY p_personal_memory_ws ON personal_memory
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE INDEX IF NOT EXISTS idx_personal_memory_member ON personal_memory (workspace_id, member_no, layer);

-- ③ 提醒收件箱（浮层气泡/IM/眼镜同源；source_key 幂等去重）
CREATE TABLE IF NOT EXISTS secretary_inbox (
  id            TEXT PRIMARY KEY,                    -- si-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  member_no     TEXT NOT NULL,
  source_key    TEXT NOT NULL,                       -- 事件源键（appr-<id>/dev-pend-<id>/exam-<id>…）
  kind          TEXT NOT NULL CHECK (kind IN ('judge','done','alert','daily')),
  level         TEXT NOT NULL CHECK (level IN ('red','high','mid','low')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  actions       JSONB NOT NULL DEFAULT '[]',         -- [{label, link}]
  link          TEXT,                                -- 跳转路径（/p4 /p25 …）
  status        TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','read','acted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, member_no, source_key)
);
ALTER TABLE secretary_inbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_secretary_inbox_ws ON secretary_inbox;
CREATE POLICY p_secretary_inbox_ws ON secretary_inbox
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE INDEX IF NOT EXISTS idx_secretary_inbox_member ON secretary_inbox (workspace_id, member_no, status, created_at DESC);

-- ④ 定时提醒（你随口定的："明早八点提醒我过审批"）
CREATE TABLE IF NOT EXISTS secretary_reminders (
  id            TEXT PRIMARY KEY,                    -- sr-<毫秒>-<随机尾>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  member_no     TEXT NOT NULL,
  text          TEXT NOT NULL,
  due_at        TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fired','canceled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE secretary_reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_secretary_reminders_ws ON secretary_reminders;
CREATE POLICY p_secretary_reminders_ws ON secretary_reminders
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE INDEX IF NOT EXISTS idx_secretary_reminders_due ON secretary_reminders (workspace_id, status, due_at);

-- 授权（与 0021-0023 同口径）
GRANT SELECT, INSERT, UPDATE, DELETE ON secretary_settings TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON personal_memory TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON secretary_inbox TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON secretary_reminders TO workloom_app;
