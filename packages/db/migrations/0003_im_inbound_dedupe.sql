-- ============================================================================
-- WorkLoom IM 底座 · 0003_im_inbound_dedupe.sql
-- #29 IM 入站消息幂等键表：消除 ingestInbound「查重→写事件」TOCTOU 双写窗口
-- 对齐：审计报告 #29（通道并发重推时 findInboundEvent 与 gatewayAppend 非原子，
--      同一条 (channel, channel_msg_id) 可能落两条事件）
-- 口径：先占位登记（主键冲突即重复投递）→ 写事件 → 回填 event_id；
--      事件写入失败补偿删除占位（窄窗口，不残留幽灵占位）
-- ============================================================================

CREATE TABLE IF NOT EXISTS im_inbound_dedupe (
  workspace_id   TEXT NOT NULL,
  channel        TEXT NOT NULL,
  channel_msg_id TEXT NOT NULL,
  event_id       TEXT NOT NULL DEFAULT '',        -- 占位时空串，事件落库后回填
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, channel, channel_msg_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON im_inbound_dedupe TO workloom_app;
GRANT SELECT ON im_inbound_dedupe TO workloom_gateway;

ALTER TABLE im_inbound_dedupe ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_im_inbound_dedupe_ws ON im_inbound_dedupe
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
