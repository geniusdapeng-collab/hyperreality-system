-- ============================================================================
-- HyperReality · 0009_video_studio.sql
-- 视频工作室数据模型扩展（docs/fusion-design.md §5）：asset-cms / publish-rpa /
-- social-listening 三个新增底座包的落库表。
-- 口径：全部带 workspace_id + RLS 行级隔离（模仿 0001；越权返回空 L7.1）；
--      双角色授权（workloom_app 读写 / workloom_gateway 读写）；事件联动不经本文件——
--      五元事件仍走 biz_events append-only（0001）+ append_event_insert（0007 D16）。
-- 执行前提：0001_init.sql 已执行（workspaces/tenants/双角色存在）。
-- ============================================================================

-- ---------- 项目（一部片子/一个营销 Campaign） ----------

CREATE TABLE video_projects (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  thread_id     TEXT,                                                   -- 关联任务线程（M3）
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'narrative'
                CHECK (kind IN ('narrative','marketing','account_ops')), -- §4 管线模板
  prd           JSONB NOT NULL DEFAULT '{}',                            -- G4 PRD（时长唯一权威）
  status        TEXT NOT NULL DEFAULT 'preproduction'
                CHECK (status IN ('preproduction','production','published','archived')),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_video_projects_ws_status ON video_projects (workspace_id, status);

-- ---------- 素材库（商品图/参考图/定妆照/片段/成片） ----------

CREATE TABLE video_assets (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  project_id    TEXT REFERENCES video_projects(id),
  chain_id      TEXT NOT NULL,                                          -- 版本链根（v1 的 id）
  kind          TEXT NOT NULL
                CHECK (kind IN ('product_image','reference_image','portrait','clip','final_cut')),
  version       INTEGER NOT NULL DEFAULT 1,
  parent_id     TEXT,                                                   -- 上一版本行（版本链）
  source_url    TEXT NOT NULL,
  provenance    JSONB NOT NULL DEFAULT '{}',                            -- 来源：生成/上传/抓取 + 上游事件链
  license_risk  TEXT NOT NULL DEFAULT 'unknown'
                CHECK (license_risk IN ('none','low','high','unknown')),
  hero_image_id TEXT,                                                   -- 首图/主图绑定
  sha256        TEXT NOT NULL,
  meta          JSONB NOT NULL DEFAULT '{}',                            -- 成片扩展：{platforms,durationSeconds,prdId,shotPackageVersion}
  publish_at    TIMESTAMPTZ,                                            -- 内容日历排期（成片专用）
  status        TEXT NOT NULL DEFAULT 'registered'
                CHECK (status IN ('registered','draft','scheduled','published','archived')),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, sha256),                                        -- sha256 幂等去重（L1.4 同源）
  UNIQUE (workspace_id, chain_id, version)                              -- 版本链唯一
);
CREATE INDEX idx_video_assets_ws_kind ON video_assets (workspace_id, kind);
CREATE INDEX idx_video_assets_chain ON video_assets (workspace_id, chain_id, version);
CREATE INDEX idx_video_assets_calendar ON video_assets (workspace_id, publish_at) WHERE publish_at IS NOT NULL;

-- ---------- 渲染脚本 CMS（§6：版本链 + 版本即审批对象） ----------

CREATE TABLE render_scripts (
  id                TEXT PRIMARY KEY,                                   -- <script_key>-v<n>
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  project_id        TEXT NOT NULL REFERENCES video_projects(id),
  shot_id           TEXT NOT NULL,
  script_key        TEXT NOT NULL,                                      -- 逻辑脚本（同镜头多版本共享）
  version           INTEGER NOT NULL DEFAULT 1,
  parent_version    INTEGER,                                            -- 版本链
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','approved','submitted','rendering','done','failed')),
  md                TEXT NOT NULL,                                      -- MD 正文（工作台展示/本地编辑）
  fields            JSONB NOT NULL DEFAULT '{}',                        -- 25/30 字段 JSON
  char_check        JSONB NOT NULL DEFAULT '{}',                        -- 字符数校验快照（2470-3000/≤3000）
  diff_summary      TEXT,                                               -- 与 parent_version 的 diff 摘要
  approved_event_id TEXT,                                               -- G8 审批留痕
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, script_key, version)
);
CREATE INDEX idx_render_scripts_project ON render_scripts (workspace_id, project_id, shot_id);

-- ---------- Seedance 提交记录 ----------

CREATE TABLE render_jobs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  project_id      TEXT NOT NULL REFERENCES video_projects(id),
  script_id       TEXT NOT NULL REFERENCES render_scripts(id),
  script_version  INTEGER NOT NULL,
  task_id         TEXT,                                                 -- Seedance 任务 ID
  cost            NUMERIC(10,2),                                        -- 烧额度
  status          TEXT NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted','rendering','done','failed')),
  result_url      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_render_jobs_ws_status ON render_jobs (workspace_id, status);

-- ---------- 发布任务（§7 全平台 RPA） ----------

CREATE TABLE publish_tasks (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  platform      TEXT NOT NULL
                CHECK (platform IN ('douyin','tiktok','xiaohongshu','shipinhao','bilibili','youtube')),
  account_id    TEXT NOT NULL,
  asset_id      TEXT REFERENCES video_assets(id),                       -- 关联成片
  video_path    TEXT NOT NULL,
  cover_path    TEXT,
  caption       TEXT NOT NULL DEFAULT '',
  tags          JSONB NOT NULL DEFAULT '[]',
  schedule_at   TIMESTAMPTZ,                                            -- 定时发布
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','pending_review','succeeded','failed','manual')),
  receipt       JSONB,                                                  -- 发布回执（平台帖子 ID/URL/证据）
  error         TEXT,
  executed_at   TIMESTAMPTZ,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_publish_tasks_ws_status ON publish_tasks (workspace_id, status);
CREATE INDEX idx_publish_tasks_account_day ON publish_tasks (workspace_id, account_id, executed_at); -- 单账号日上限

-- ---------- 账号/视频指标时序（夜班采集落账） ----------

CREATE TABLE account_metrics (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  platform      TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  video_id      TEXT,                                                   -- 空 = 账号级快照
  captured_at   TIMESTAMPTZ NOT NULL,
  plays         BIGINT NOT NULL DEFAULT 0,
  likes         BIGINT NOT NULL DEFAULT 0,
  comments      BIGINT NOT NULL DEFAULT 0,
  shares        BIGINT NOT NULL DEFAULT 0,
  conversions   BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_account_metrics_series ON account_metrics (workspace_id, account_id, captured_at DESC);
CREATE INDEX idx_account_metrics_video ON account_metrics (workspace_id, video_id, captured_at DESC);

-- ---------- 评论采集与回复（G10 三级分流） ----------

CREATE TABLE comments (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id),
  platform             TEXT NOT NULL,
  account_id           TEXT NOT NULL,
  video_id             TEXT,
  platform_comment_id  TEXT,                                            -- 平台侧 ID（采集幂等键）
  author               TEXT,
  text                 TEXT NOT NULL,
  intent               TEXT CHECK (intent IN ('praise','query','complaint','crisis','other')),
  route_level          TEXT CHECK (route_level IN ('auto','review','block')),  -- G10 分流结果
  status               TEXT NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new','pending_review','replied','blocked','manual')),
  collected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, platform, platform_comment_id)                  -- 采集幂等（L1.4 同源）
);
CREATE INDEX idx_comments_ws_status ON comments (workspace_id, status);
CREATE INDEX idx_comments_video ON comments (workspace_id, video_id, collected_at DESC);

CREATE TABLE comment_replies (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  comment_id    TEXT NOT NULL REFERENCES comments(id),
  text          TEXT NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'rpa',
  status        TEXT NOT NULL DEFAULT 'candidate'
                CHECK (status IN ('candidate','sent','failed')),
  receipt       JSONB,                                                  -- 外发回执（L3.6/E3.7：无回执=未核实）
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_comment_replies_comment ON comment_replies (workspace_id, comment_id);

-- ============================================================================
-- 权限（模仿 0001）：app/gateway 双角色读写；biz_events 不在本文件（仍仅网关可写）。
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
  video_projects, video_assets, render_scripts, render_jobs,
  publish_tasks, account_metrics, comments, comment_replies
TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  video_projects, video_assets, render_scripts, render_jobs,
  publish_tasks, account_metrics, comments, comment_replies
TO workloom_gateway;
GRANT USAGE, SELECT ON SEQUENCE account_metrics_id_seq TO workloom_app;
GRANT USAGE, SELECT ON SEQUENCE account_metrics_id_seq TO workloom_gateway;

-- ============================================================================
-- RLS 行级隔离（模仿 0001 DO 块）：按 app.workspace_id 连接级设置过滤；
-- 未设置时所有行不可见（安全默认值）；越权查询返回空而非 403（L7.1）。
-- ============================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'video_projects','video_assets','render_scripts','render_jobs',
    'publish_tasks','account_metrics','comments','comment_replies'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%I_ws ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t, t);
  END LOOP;
END $$;
