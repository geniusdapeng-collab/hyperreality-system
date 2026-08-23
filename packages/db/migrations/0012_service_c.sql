-- 0010_service_c.sql · AI 服务前台（ToBToC：B 端经营底座延伸出服务 C 端用户的企业客服）
-- 数据模型：知识库（kb_*）+ C 端会话（c_*）+ 工单（c_ticket*）
-- 纪律与 0001 同：全部带 workspace_id + RLS（app.workspace_id 连接级隔离，越权返回空 L7.1）；
-- 双角色授权（workloom_app / workloom_gateway 读写；bigserial 序列单独授权）。

-- ---------- 知识库（service-kb） ----------

CREATE TABLE kb_collections (                                     -- 知识集合（分组容器）
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_kb_collections_ws ON kb_collections (workspace_id, status);

CREATE TABLE kb_documents (                                       -- 知识文档（版本并存）
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  collection_id TEXT NOT NULL REFERENCES kb_collections(id),
  title         TEXT NOT NULL,
  source_kind   TEXT NOT NULL
                CHECK (source_kind IN ('upload','official_site','manual')),
  source_url    TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'pending_review'
                CHECK (status IN ('active','disabled','pending_review')),
  content_md    TEXT NOT NULL DEFAULT '',
  hash          TEXT,                                             -- 内容指纹（幂等：同 hash 不重复建版）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_kb_documents_ws_coll ON kb_documents (workspace_id, collection_id, status);
CREATE INDEX idx_kb_documents_hash    ON kb_documents (workspace_id, hash);

CREATE TABLE kb_chunks (                                          -- 语义切块（混合检索载体）
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  document_id   TEXT NOT NULL REFERENCES kb_documents(id),
  chunk_index   INTEGER NOT NULL,
  heading       TEXT NOT NULL DEFAULT '',                         -- 标题路径（如「前台政策/退房时间」）
  content       TEXT NOT NULL,
  embedding     vector(1536),                                     -- 可空：无 embedder 时走关键词兜底
  keywords      TSVECTOR,                                         -- 可空：分词兜底位
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX idx_kb_chunks_ws_doc  ON kb_chunks (workspace_id, document_id);
CREATE INDEX idx_kb_chunks_embed   ON kb_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_kb_chunks_kw      ON kb_chunks USING GIN (keywords);

CREATE TABLE kb_sources (                                         -- 官网等定时抓取源（diffScan）
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  url             TEXT NOT NULL,
  fingerprint     TEXT,                                           -- 上次抓取内容指纹（变化检测）
  last_crawled_at TIMESTAMPTZ,
  schedule_cron   TEXT NOT NULL DEFAULT '0 3 * * *',
  status          TEXT NOT NULL DEFAULT 'active',
  UNIQUE (workspace_id, url)
);

-- ---------- C 端会话（service-dialog） ----------

CREATE TABLE c_users (                                            -- C 端用户（渠道 openid 归一）
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  channel       TEXT NOT NULL,
  openid        TEXT NOT NULL,
  nickname      TEXT,
  member_id     TEXT,                                             -- 可选：关联 B 端会员
  phone_hash    TEXT,                                             -- 手机号哈希（verifyIdentity 后回填）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, channel, openid)                          -- resolveCUser 幂等键
);

CREATE TABLE c_conversations (                                    -- 会话（一用户多渠道多会话）
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  c_user_id       TEXT NOT NULL REFERENCES c_users(id),
  channel         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ
);
CREATE INDEX idx_c_conv_ws_user ON c_conversations (workspace_id, c_user_id, status);

CREATE TABLE c_messages (                                         -- 消息（含意图/置信度/引用留痕）
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES c_conversations(id),
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content         TEXT NOT NULL,
  intent          TEXT,
  confidence      REAL,
  citations       JSONB NOT NULL DEFAULT '[]',
  latency_ms      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_c_messages_ws_conv ON c_messages (workspace_id, conversation_id, id);

-- ---------- 工单（service-ticket） ----------

CREATE TABLE c_tickets (                                          -- 工单（状态机 + 幂等键）
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  c_user_id        TEXT REFERENCES c_users(id),
  conversation_id  TEXT,
  kind             TEXT NOT NULL,                                 -- delivery/repair/complaint/other（酒店预置）
  title            TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'created'
                   CHECK (status IN ('created','assigned','processing','done','closed')),
  priority         TEXT NOT NULL DEFAULT 'normal',
  dept             TEXT,
  assignee         TEXT,
  sla_due_at       TIMESTAMPTZ,
  result           JSONB,
  idempotency_key  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)                          -- createTicket 幂等（冲突返回原单）
);
CREATE INDEX idx_c_tickets_ws_status ON c_tickets (workspace_id, status, priority);
CREATE INDEX idx_c_tickets_ws_user   ON c_tickets (workspace_id, c_user_id);
CREATE INDEX idx_c_tickets_sla       ON c_tickets (workspace_id, sla_due_at)
  WHERE status IN ('created','assigned','processing');            -- slaScan 半索引

CREATE TABLE c_ticket_events (                                    -- 工单流转留痕（append-only 语义由服务层保证）
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  ticket_id     TEXT NOT NULL REFERENCES c_tickets(id),
  action        TEXT NOT NULL,                                    -- created/assigned/advanced/completed/closed/sla_escalated
  actor_type    TEXT NOT NULL,                                    -- human/agent/system/c_user
  actor_id      TEXT NOT NULL,
  detail        JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_c_ticket_events_ws_ticket ON c_ticket_events (workspace_id, ticket_id, id);

CREATE TABLE c_notifications (                                    -- 推送通知箱（mock 投递必落库可查）
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  c_user_id     TEXT NOT NULL REFERENCES c_users(id),
  channel       TEXT NOT NULL,
  kind          TEXT NOT NULL,                                    -- ticket_update/message/system
  payload       JSONB NOT NULL DEFAULT '{}',
  driver        TEXT NOT NULL DEFAULT 'mock',                     -- mock/wechat-subscribe/alipay-notify
  status        TEXT NOT NULL DEFAULT 'delivered',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_c_notifications_ws_user ON c_notifications (workspace_id, c_user_id, id);

-- ============================================================================
-- 权限：双角色授权（与 0001 同口径）—— app/gateway 均可读写；bigserial 序列单独授权
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
  kb_collections, kb_documents, kb_chunks, kb_sources,
  c_users, c_conversations, c_messages,
  c_tickets, c_ticket_events, c_notifications
TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  kb_collections, kb_documents, kb_chunks, kb_sources,
  c_users, c_conversations, c_messages,
  c_tickets, c_ticket_events, c_notifications
TO workloom_gateway;
GRANT USAGE, SELECT ON SEQUENCE kb_chunks_id_seq TO workloom_app, workloom_gateway;
GRANT USAGE, SELECT ON SEQUENCE c_messages_id_seq TO workloom_app, workloom_gateway;
GRANT USAGE, SELECT ON SEQUENCE c_ticket_events_id_seq TO workloom_app, workloom_gateway;
GRANT USAGE, SELECT ON SEQUENCE c_notifications_id_seq TO workloom_app, workloom_gateway;

-- ============================================================================
-- RLS 行级隔离（F7.1）：DO 块批量启用，策略同 0001（app.workspace_id 过滤，
-- 未设置时全不可见=安全默认值；越权返回空而非 403 L7.1；表 owner 默认绕过）。
-- ============================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'kb_collections','kb_documents','kb_chunks','kb_sources',
    'c_users','c_conversations','c_messages',
    'c_tickets','c_ticket_events','c_notifications'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY p_%I_ws ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t, t);
  END LOOP;
END $$;
