-- ============================================================================
-- WorkLoom IM 底座 · 0001_init.sql
-- DDL 事实源（手写 SQL 入库可审计；packages/db/src/schema.ts 仅为类型镜像）
-- 对齐：PRD V2.5 附录 E（五元事件 Schema）/ L1.1（append-only）/ F1.2（仅网关可写）
--      / F7.1（RLS 行级隔离）/ L7.1（越权返回空而非 403）
-- 执行前提：migrate.ts 已创建 workloom_app / workloom_gateway 两个角色
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------- 组织模型（M7） ----------

CREATE TABLE tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'pro'
              CHECK (plan IN ('community','pro','teams','vpc')),      -- F7.2 版本能力矩阵
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  industry      TEXT NOT NULL DEFAULT 'hotel',                        -- §2.2 装配槽：行业 bundle 名
  stage         TEXT,                                                 -- 经营阶段（枚举行业化）
  night_config  JSONB NOT NULL DEFAULT '{}',                          -- F4.8 夜班配置
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE members (                                                -- 人类成员（F5.6）
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  member_no     TEXT NOT NULL,                                        -- MEM-041
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'readonly'
                CHECK (role IN ('owner','manager','readonly','group','channel')),
  im_openids    JSONB NOT NULL DEFAULT '{}',                          -- openid→成员映射（E5.2）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, member_no)
);

CREATE TABLE agents (                                                 -- Agent 一等公民（IM.5）
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  preset_key      TEXT NOT NULL,
  name            TEXT NOT NULL,
  version         TEXT NOT NULL,                                      -- who.version 归因必需
  kind            TEXT NOT NULL,
  readonly        BOOLEAN NOT NULL DEFAULT false,                     -- L9.1 只读 preset
  fence_bindings  JSONB NOT NULL DEFAULT '[]',                        -- F2.10 未声明即禁写
  skills          JSONB NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'ready'
                  CHECK (status IN ('ready','disabled','invalid')),
  invalid_reason  TEXT,
  meta            JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 消息总线层（M1） ----------

CREATE TABLE profiles (                                               -- 一 X 一档（槽①）
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  industry      TEXT NOT NULL,
  archive       JSONB NOT NULL,
  forbidden     JSONB NOT NULL DEFAULT '[]',                          -- 禁用承诺，硬约束（L1.6）
  pii_vault     JSONB,                                                -- F1.10 PII 保险柜（密文）
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE biz_events (                                             -- 五元事件库（append-only）
  seq           BIGSERIAL PRIMARY KEY,                                -- 服务端单调递增（L1.4）
  event_id      TEXT NOT NULL,                                        -- E-88xx
  tenant_id     TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  session_id    TEXT,                                                 -- 会话=线程（IM.3）
  payload       JSONB NOT NULL,                                       -- 完整五元消息（zod 校验后写入）
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL,                                        -- sha256(prev_hash || payload)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_id)                                        -- 幂等键：重复写入丢弃（L1.4）
);

CREATE INDEX idx_events_ws_time ON biz_events (workspace_id, created_at DESC);
CREATE INDEX idx_events_object  ON biz_events ((payload->'object'->>'type'), (payload->'object'->>'id'));
CREATE INDEX idx_events_action  ON biz_events ((payload->'decision'->>'action'));
CREATE INDEX idx_events_session ON biz_events (session_id, created_at);
CREATE INDEX idx_events_rule    ON biz_events USING GIN ((payload->'rule_impact'));  -- G1 ≤3s 机制

-- append-only 防改写触发器（L1.1：回滚/删除均为新事件，原事件永不修改）
CREATE OR REPLACE FUNCTION workloom_no_mutate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'biz_events is append-only: % not allowed (PRD L1.1)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_biz_events_no_update
  BEFORE UPDATE ON biz_events FOR EACH ROW EXECUTE FUNCTION workloom_no_mutate();
CREATE TRIGGER trg_biz_events_no_delete
  BEFORE DELETE ON biz_events FOR EACH ROW EXECUTE FUNCTION workloom_no_mutate();

CREATE TABLE org_memory (                                             -- 组织统一记忆（F1.4）
  memory_id      TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('workspace','agent','run')),
  kind           TEXT NOT NULL CHECK (kind IN ('preference','pattern','sop','forbidden')),
  content        TEXT NOT NULL,                                       -- 脱敏后的模式化结论（F1.8）
  embedding      vector(1536),
  source_events  TEXT[] NOT NULL DEFAULT '{}',                        -- 来源事件（归因）
  confidence     REAL NOT NULL DEFAULT 0.5,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','superseded','recalled')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_memory_ws_scope ON org_memory (workspace_id, scope, status);

CREATE TABLE memory_usage (                                           -- 记忆使用归因（F1.4）
  memory_id  TEXT NOT NULL REFERENCES org_memory(memory_id),
  event_id   TEXT NOT NULL,
  used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, event_id)
);

-- ---------- 行动权限层（M2） ----------

CREATE TABLE fence_rules (                                            -- 围栏规则（版本化 F2.4）
  id                TEXT PRIMARY KEY,
  rule_id           TEXT NOT NULL,                                    -- R1…R6
  version           TEXT NOT NULL,
  workspace_id      TEXT NOT NULL DEFAULT '*',                        -- '*' = 全局/行业基线
  name              TEXT NOT NULL,
  level             TEXT NOT NULL CHECK (level IN ('auto','review','block')),
  match_spec        JSONB NOT NULL,                                   -- { object_types, actions, when }
  action            JSONB NOT NULL,                                   -- { result, notify? }
  is_baseline       BOOLEAN NOT NULL DEFAULT false,                   -- 单调守卫（F2.3）
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','pending_approval','active','rolled_back')),
  created_by        TEXT NOT NULL,
  approved_event_id TEXT,                                             -- 变更审批留痕（F2.4）
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_id, version, workspace_id)
);

CREATE TABLE fence_dry_runs (                                         -- dry-run 回放报告（F2.5）
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  rule_id       TEXT NOT NULL,
  rule_version  TEXT NOT NULL,
  report        JSONB NOT NULL,        -- { replayed, would_block[], would_review[], impact }
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 会话与审批（M3 / M5） ----------

CREATE TABLE threads (                                                -- 任务线程（F3.4 状态机）
  id              TEXT PRIMARY KEY,                                   -- T-102
  tenant_id       TEXT NOT NULL,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  title           TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'quest' CHECK (mode IN ('ask','agent','quest')),
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','pending_review','completed','failed','paused')),
  progress_done   INTEGER NOT NULL DEFAULT 0,
  progress_total  INTEGER NOT NULL DEFAULT 0,
  current_action  TEXT,
  created_by      TEXT NOT NULL,
  agent_id        TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ
);
CREATE INDEX idx_threads_ws_status ON threads (workspace_id, status);

CREATE TABLE approvals (                                              -- 审批队列（原生消息类型 M5）
  approval_id   TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  event_id      TEXT NOT NULL,                                        -- 被审批的动作事件
  channel       TEXT NOT NULL DEFAULT 'inapp'
                CHECK (channel IN ('inapp','dingtalk','wecom','feishu','slack')),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','edited','rejected','expired')),
  gesture       JSONB,                  -- { type, weight(1/2/3), reason_enum, reason_text, edited_after }
  snapshot      JSONB NOT NULL DEFAULT '{}',                          -- { before, after, expires_at }（E5.3）
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, channel)                                          -- 同事件同渠道幂等（L5.3）
);
CREATE INDEX idx_approvals_ws_status ON approvals (workspace_id, status);

-- ---------- 夜班与自动化（M4 / M9） ----------

CREATE TABLE night_runs (                                             -- 夜班班次（F4.8）
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id),
  run_date                TEXT NOT NULL,                              -- 班次日期
  status                  TEXT NOT NULL DEFAULT 'ready'
                          CHECK (status IN ('ready','running','paused','package_generated')),
  fence_snapshot_version  TEXT,                                       -- F2.6 当晚围栏版本
  candidate_count         INTEGER NOT NULL DEFAULT 0,                 -- F4.1 候选清单计数
  stats                   JSONB NOT NULL DEFAULT '{}',                -- 三栏统计（F4.4）
  started_at              TIMESTAMPTZ,
  package_event_id        TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_night_runs_ws_date ON night_runs (workspace_id, run_date);

CREATE TABLE triggers (                                               -- 自动化触发器（F4.7/L4.4）
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('cron','event')),
  schedule      TEXT NOT NULL,                                        -- cron 表达式 / 事件订阅条件
  action        JSONB NOT NULL,                                       -- 派遣模板
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 资产与商业化（M8 / M7） ----------

CREATE TABLE skills (                                                 -- 技能（F8.1 三级体系）
  id              TEXT PRIMARY KEY,
  level           TEXT NOT NULL CHECK (level IN ('official','team','industry')),
  bundle          TEXT,                                               -- 来源 bundle
  name            TEXT NOT NULL,
  version         TEXT NOT NULL DEFAULT '1.0.0',
  description     TEXT NOT NULL DEFAULT '',
  fence_bindings  JSONB NOT NULL DEFAULT '[]',                        -- F8.2 绑定围栏
  body            TEXT NOT NULL DEFAULT '',                           -- SKILL.md 正文
  desensitized    BOOLEAN NOT NULL DEFAULT false,                     -- L8.1 共享前必须脱敏
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE skill_installs (                                         -- 安装即绑定（F8.2/L8.3）
  skill_id      TEXT NOT NULL REFERENCES skills(id),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  installed_by  TEXT NOT NULL,
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, workspace_id)
);

CREATE TABLE industry_assets (                                        -- 行业知识资产（F8.6）
  asset_id      TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  perf          JSONB NOT NULL DEFAULT '{}',
  share_scope   TEXT NOT NULL DEFAULT 'workspace'
                CHECK (share_scope IN ('workspace','org','industry')),
  desensitized  BOOLEAN NOT NULL DEFAULT false,                       -- L8.1/E8.4
  embedding     vector(1536),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE credentials (                                            -- 凭据引用（F7.7/L7.3）
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  provider      TEXT NOT NULL,
  ref_key       TEXT NOT NULL,
  secret_enc    TEXT NOT NULL,                                        -- AES-256-GCM 密文（无明文落盘）
  scopes        JSONB NOT NULL DEFAULT '[]',
  health        TEXT NOT NULL DEFAULT 'unknown'
                CHECK (health IN ('healthy','failing','unknown')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at    TIMESTAMPTZ
);

-- ============================================================================
-- 权限：旁路直写防控（F1.2）—— biz_events 仅 workloom_gateway 可 INSERT；
-- workloom_app 对其余 17 表可读写、对 biz_events 只读。
-- ============================================================================
GRANT USAGE ON SCHEMA public TO workloom_app, workloom_gateway;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, workspaces, members, agents, profiles,
  org_memory, memory_usage, fence_rules, fence_dry_runs,
  threads, approvals, night_runs, triggers,
  skills, skill_installs, industry_assets, credentials
TO workloom_app;
GRANT SELECT ON biz_events TO workloom_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, workspaces, members, agents, profiles,
  org_memory, memory_usage, fence_rules, fence_dry_runs,
  threads, approvals, night_runs, triggers,
  skills, skill_installs, industry_assets, credentials
TO workloom_gateway;
GRANT SELECT, INSERT ON biz_events TO workloom_gateway;
GRANT USAGE, SELECT ON SEQUENCE biz_events_seq_seq TO workloom_gateway; -- bigserial 列名 seq → 序列名 biz_events_seq_seq

-- ============================================================================
-- RLS 行级隔离（F7.1）：按 app.workspace_id / app.tenant_id 连接级设置过滤；
-- 未设置时所有行不可见（安全默认值）；越权查询返回空而非 403（L7.1）。
-- 注：表 owner（迁移/种子账号）默认绕过策略；FORCE RLS 进停车场（总纲 §7）。
-- memory_usage / skills 为全局引用表，由服务层按键控权，不设 RLS。
-- ============================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'members','agents','profiles','biz_events','org_memory','fence_dry_runs',
    'threads','approvals','night_runs','triggers','skill_installs',
    'industry_assets','credentials'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%I_ws ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t, t);
  END LOOP;
END $$;

ALTER TABLE fence_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_fence_rules_ws ON fence_rules
  USING (workspace_id = current_setting('app.workspace_id', true) OR workspace_id = '*')
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true) OR workspace_id = '*');

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_workspaces_ws ON workspaces
  USING (id = current_setting('app.workspace_id', true)
         OR tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_tenants_tenant ON tenants
  USING (id = current_setting('app.tenant_id', true))
  WITH CHECK (id = current_setting('app.tenant_id', true));
