-- ============================================================================
-- HyperReality · 0011_biz_expansion.sql
-- 经营扩张数据模型（bundles/ai-video/schemas/objects.json 30 类对象之新增 12 类）：
--   选题/排期/变体（topic_card / content_calendar / platform_variant）
--   商单全周期（deal_order / deal_milestone / settlement_statement）
--   投放（ads_campaign / ads_creative）
--   达人合作（creator_collab）
--   版权资产（ip_asset）
--   送审（review_submission）
--   预算台账（budget_ledger）
-- 口径：全部带 workspace_id + RLS 行级隔离（模仿 0009/0008 的 DO 块；越权返回空 L7.1）；
--      双角色授权（workloom_app / workloom_gateway 读写）；
--      状态 CHECK 内联枚举；写路径事件仍走 biz_events append-only（0001）
--      + append_event_insert（0007 D16），本文件不含事件表。
-- 执行前提：0001_init.sql 已执行（workspaces/双角色存在）；0009 视频域表已建
--      （video_projects/video_assets 供 project/asset 外键引用，均为弱引用 TEXT 不强制 FK
--       的除外——本文件外键仅引用同库已建表，全部加 FK 且带 workspace_id 谓词由服务层保证）。
-- ============================================================================

-- ---------- 选题卡（选题池：题材/钩子假设/目标平台/优先级） ----------

CREATE TABLE topic_cards (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  project_id    TEXT REFERENCES video_projects(id),
  title         TEXT NOT NULL,
  hook          TEXT NOT NULL DEFAULT '',                                -- 钩子假设
  target_platforms JSONB NOT NULL DEFAULT '[]',                          -- 目标平台集
  priority      INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  status        TEXT NOT NULL DEFAULT 'pool'
                CHECK (status IN ('pool','scheduled','produced','published','dropped')),
  expected      JSONB NOT NULL DEFAULT '{}',                             -- 预期指标 {plays,likes,follows} 供命中率回测
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_topic_cards_ws_status ON topic_cards (workspace_id, status);
CREATE INDEX idx_topic_cards_project ON topic_cards (workspace_id, project_id);

-- ---------- 内容日历（账号级发布排期：多平台错峰 + G9b 频控载体） ----------

CREATE TABLE content_calendar (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  account_id    TEXT NOT NULL,
  platform      TEXT NOT NULL,
  topic_card_id TEXT REFERENCES topic_cards(id),
  asset_id      TEXT,                                                    -- 关联成片（video_assets 弱引用）
  slot_at       TIMESTAMPTZ NOT NULL,                                    -- 排期时点
  status        TEXT NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned','locked','published','skipped','conflict')),
  conflict_note TEXT,                                                    -- 排期冲突裁决说明
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, account_id, platform, slot_at)                   -- 同账号同平台同时点幂等（L1.4 同源）
);
CREATE INDEX idx_content_calendar_ws_slot ON content_calendar (workspace_id, slot_at);
CREATE INDEX idx_content_calendar_account ON content_calendar (workspace_id, account_id, slot_at);

-- ---------- 平台变体（一片多发：画幅/时长/文案/封面按平台派生，只改表达不改事实） ----------

CREATE TABLE platform_variants (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  asset_id      TEXT NOT NULL,                                           -- 源成片
  platform      TEXT NOT NULL
                CHECK (platform IN ('douyin','tiktok','xiaohongshu','shipinhao','bilibili','youtube')),
  aspect_ratio  TEXT,                                                    -- 画幅（9:16/16:9/1:1）
  duration_sec  NUMERIC(10,2),
  caption       TEXT NOT NULL DEFAULT '',
  cover_ref     TEXT,
  derived_meta  JSONB NOT NULL DEFAULT '{}',                             -- 派生参数（剪辑点/字幕样式等）
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','ready','published','archived')),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, asset_id, platform)                              -- 同成片同平台唯一变体（幂等）
);
CREATE INDEX idx_platform_variants_asset ON platform_variants (workspace_id, asset_id);

-- ---------- 商单订单（线索→报价→合同→履约→回款全周期；G15 对外文件必审） ----------

CREATE TABLE deal_orders (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  brand         TEXT NOT NULL,                                           -- 品牌方
  contact       TEXT,                                                    -- 联系人
  amount        NUMERIC(14,2) NOT NULL DEFAULT 0,                        -- 成交金额（分币种统一计量口径由服务层保证）
  quote_band    JSONB NOT NULL DEFAULT '{}',                             -- 报价带 {floor,ceiling,currency}
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','quoting','contracted','fulfilling','settling','closed','lost')),
  channel       TEXT NOT NULL DEFAULT 'dm'
                CHECK (channel IN ('dm','email','platform_msg','offline','other')),  -- 线索来源渠道
  lead_comment_id TEXT,                                                  -- 来源评论线索（comments 弱引用）
  project_id    TEXT REFERENCES video_projects(id),
  payment_terms JSONB NOT NULL DEFAULT '{}',                             -- 账期 {days, milestones[]}
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  UNIQUE (workspace_id, brand, lead_comment_id)                          -- 同线索不重复建单（幂等；lead 为空时 PG NULL 不参与去重，服务层兜底）
);
CREATE INDEX idx_deal_orders_ws_status ON deal_orders (workspace_id, status);
CREATE INDEX idx_deal_orders_brand ON deal_orders (workspace_id, brand);

-- ---------- 商单履约节点（brief 确认/初稿/终稿/发布/验收；逾期前 48h 预警） ----------

CREATE TABLE deal_milestones (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  order_id      TEXT NOT NULL REFERENCES deal_orders(id),
  kind          TEXT NOT NULL
                CHECK (kind IN ('brief','draft_v1','final_cut','publish','acceptance','payment')),
  due_at        TIMESTAMPTZ,                                             -- 到期时点（预警锚点）
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','done','overdue','waived')),
  done_at       TIMESTAMPTZ,
  note          TEXT,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, order_id, kind)                                  -- 同单同节点唯一（幂等）
);
CREATE INDEX idx_deal_milestones_order ON deal_milestones (workspace_id, order_id, status);
CREATE INDEX idx_deal_milestones_due ON deal_milestones (workspace_id, due_at) WHERE status = 'pending';

-- ---------- 分账结算单（应结 vs 实结逐笔比对；±10% 差异 G13 告警） ----------

CREATE TABLE settlement_statements (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  order_id      TEXT REFERENCES deal_orders(id),
  period        TEXT NOT NULL,                                           -- 结算周期（如 2026-08）
  due_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,                        -- 应结
  paid_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,                        -- 实结
  currency      TEXT NOT NULL DEFAULT 'CNY',
  diff_ratio    NUMERIC(8,4),                                            -- 差异率（服务层计算回填；超 ±0.10 触发 G13）
  status        TEXT NOT NULL DEFAULT 'issued'
                CHECK (status IN ('issued','confirmed','disputed','settled')),
  line_items    JSONB NOT NULL DEFAULT '[]',                             -- 逐笔明细（比例公开、基数不公开由视图层保证）
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, order_id, period)                                -- 同单同周期唯一（幂等）
);
CREATE INDEX idx_settlement_ws_status ON settlement_statements (workspace_id, status);

-- ---------- 投放计划（消耗/转化阈值监控；加投 G12 必审不可降级） ----------

CREATE TABLE ads_campaigns (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  platform      TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  objective     TEXT NOT NULL DEFAULT 'conversion'
                CHECK (objective IN ('awareness','traffic','conversion','followers')),
  budget        NUMERIC(14,2) NOT NULL DEFAULT 0,
  spent         NUMERIC(14,2) NOT NULL DEFAULT 0,
  conversions   BIGINT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','running','paused','finished','terminated')),
  thresholds    JSONB NOT NULL DEFAULT '{}',                             -- {max_daily_spend,min_cpa} 阈值监控口径
  external_ref  TEXT,                                                    -- 平台侧计划 ID（Mock/接口预留）
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, platform, external_ref)                          -- 平台侧计划 ID 幂等（NULL 不参与）
);
CREATE INDEX idx_ads_campaigns_ws_status ON ads_campaigns (workspace_id, status);

-- ---------- 投放素材（钩子变体绑定投放数据；连续低效入淘汰清单） ----------

CREATE TABLE ads_creatives (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  campaign_id   TEXT NOT NULL REFERENCES ads_campaigns(id),
  asset_id      TEXT,                                                    -- 关联素材（video_assets 弱引用）
  hook_variant  TEXT NOT NULL DEFAULT '',                                -- 钩子变体名
  impressions   BIGINT NOT NULL DEFAULT 0,
  clicks        BIGINT NOT NULL DEFAULT 0,
  conversions   BIGINT NOT NULL DEFAULT 0,
  spend         NUMERIC(14,2) NOT NULL DEFAULT 0,
  efficiency    NUMERIC(10,4),                                           -- 效率分（服务层口径，如转化/千次曝光）
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','low_efficiency','retired')),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ads_creatives_campaign ON ads_creatives (workspace_id, campaign_id, status);

-- ---------- 达人合作单（筛选依据/建联/Brief/交付验收/效果回填） ----------

CREATE TABLE creator_collabs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  creator_id    TEXT NOT NULL,                                           -- 达人平台 ID
  creator_name  TEXT NOT NULL,
  platform      TEXT NOT NULL,
  selection_basis JSONB NOT NULL DEFAULT '{}',                           -- 筛选依据（粉丝画像/历史 CPM 等）
  brief         TEXT NOT NULL DEFAULT '',
  deliverables  JSONB NOT NULL DEFAULT '[]',                             -- 交付物清单
  fee           NUMERIC(14,2),
  status        TEXT NOT NULL DEFAULT 'screening'
                CHECK (status IN ('screening','contacted','briefed','delivered','accepted','reviewed','dropped')),
  effect        JSONB NOT NULL DEFAULT '{}',                             -- 效果回填 {plays,conversions,roi}
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, creator_id, platform)                            -- 同达人同平台单档唯一（幂等）
);
CREATE INDEX idx_creator_collabs_ws_status ON creator_collabs (workspace_id, status);

-- ---------- 版权资产台账（授权范围 + 来源凭证；无凭证禁止使用） ----------

CREATE TABLE ip_assets (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  kind          TEXT NOT NULL
                CHECK (kind IN ('music','font','footage','portrait','trademark','other')),
  name          TEXT NOT NULL,
  asset_ref     TEXT NOT NULL,                                           -- 资产引用（URL/文件哈希）
  provenance    TEXT NOT NULL DEFAULT '',                                -- 来源凭证说明
  license_scope JSONB NOT NULL DEFAULT '{}',                             -- 授权范围 {usage,platforms,regions,expires_at}
  license_risk  TEXT NOT NULL DEFAULT 'unknown'
                CHECK (license_risk IN ('none','low','high','unknown')),
  auth_chain    JSONB NOT NULL DEFAULT '[]',                             -- 授权链（逐环节凭证数组，空=无凭证禁用）
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','expired','revoked')),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, asset_ref)                                 -- 同类同引用幂等去重（L1.4 同源）
);
CREATE INDEX idx_ip_assets_ws_kind ON ip_assets (workspace_id, kind, license_risk);

-- ---------- 送审单（三级预检全绿方可提交；G14 阻断；驳回案例回写规则库） ----------

CREATE TABLE review_submissions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  platform      TEXT NOT NULL,
  asset_id      TEXT,                                                    -- 送审成片/素材（弱引用）
  variant_id    TEXT REFERENCES platform_variants(id),
  precheck      JSONB NOT NULL DEFAULT '{}',                             -- 三级预检快照 {content,legal,technical}
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','submitted','approved','rejected','appealed')),
  reject_reasons JSONB NOT NULL DEFAULT '[]',                            -- 驳回理由（回写规则库素材）
  submitted_at  TIMESTAMPTZ,
  decided_at    TIMESTAMPTZ,
  external_ref  TEXT,                                                    -- 平台侧送审单号（Mock/接口预留）
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_review_submissions_ws_status ON review_submissions (workspace_id, status);
CREATE INDEX idx_review_submissions_platform ON review_submissions (workspace_id, platform, created_at DESC);

-- ---------- 预算台账（项目/账号级预算与算力计量；G11/G12 判定依据） ----------

CREATE TABLE budget_ledger (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  project_id    TEXT,                                                    -- 项目级归集（可空=账号/工作区级）
  episode       TEXT,                                                    -- 集/期（三级归集第二级）
  shot_id       TEXT,                                                    -- 镜头级归集（三级归集第三级）
  cost_kind     TEXT NOT NULL
                CHECK (cost_kind IN ('render','ads_spend','creator_fee','license','tools','labor','other')),
  amount        NUMERIC(14,2) NOT NULL,                                  -- 金额（正=支出；负=冲销）
  currency      TEXT NOT NULL DEFAULT 'CNY',
  idempotency_key TEXT NOT NULL,                                         -- 计量幂等键（事件溯源同源）
  ref_event_id  TEXT,                                                    -- 关联五元事件（D16 同事务留痕互证）
  meta          JSONB NOT NULL DEFAULT '{}',
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)                                 -- 计量幂等（重复记账返回已有行）
);
CREATE INDEX idx_budget_ledger_project ON budget_ledger (workspace_id, project_id, episode, shot_id);
CREATE INDEX idx_budget_ledger_kind ON budget_ledger (workspace_id, cost_kind, occurred_at DESC);

-- ============================================================================
-- 权限（模仿 0009）：app/gateway 双角色读写；biz_events 不在本文件（仍仅网关可写）。
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
  topic_cards, content_calendar, platform_variants,
  deal_orders, deal_milestones, settlement_statements,
  ads_campaigns, ads_creatives, creator_collabs,
  ip_assets, review_submissions, budget_ledger
TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  topic_cards, content_calendar, platform_variants,
  deal_orders, deal_milestones, settlement_statements,
  ads_campaigns, ads_creatives, creator_collabs,
  ip_assets, review_submissions, budget_ledger
TO workloom_gateway;
GRANT USAGE, SELECT ON SEQUENCE budget_ledger_id_seq TO workloom_app;
GRANT USAGE, SELECT ON SEQUENCE budget_ledger_id_seq TO workloom_gateway;

-- ============================================================================
-- RLS 行级隔离（模仿 0009/0008 DO 块）：按 app.workspace_id 连接级设置过滤；
-- 未设置时所有行不可见（安全默认值）；越权查询返回空而非 403（L7.1）。
-- ============================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'topic_cards','content_calendar','platform_variants',
    'deal_orders','deal_milestones','settlement_statements',
    'ads_campaigns','ads_creatives','creator_collabs',
    'ip_assets','review_submissions','budget_ledger'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%I_ws ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t, t);
  END LOOP;
END $$;
