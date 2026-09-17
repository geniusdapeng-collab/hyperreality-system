-- 0011_service_c_hardening.sql · AI 服务前台审计加固
-- ① S1 幽灵表补 DDL：demo_members / demo_orders（server store.ts/biz-hotel.ts 引用，此前无表结构）
--    口径与 0010 同：workspace_id + RLS（app.workspace_id 连接级隔离）+ 双角色授权；
-- ② H8 版本链幂等：kb_documents 加 UNIQUE(workspace_id, hash)（同内容指纹不重复建版，NULL 不冲突）。

-- ---------- 酒店演示会员（biz-hotel 适配器数据源；演示数据，真实部署换挂业务库） ----------
CREATE TABLE IF NOT EXISTS demo_members (
  member_id     TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  phone         TEXT,
  tier          TEXT NOT NULL DEFAULT '普通',
  points        INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_demo_members_ws ON demo_members (workspace_id, member_id);

-- ---------- 酒店演示订单 ----------
CREATE TABLE IF NOT EXISTS demo_orders (
  order_id      TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  member_id     TEXT NOT NULL REFERENCES demo_members(member_id),
  room_type     TEXT NOT NULL,
  check_in      DATE NOT NULL,
  check_out     DATE,
  amount_fen    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT '已确认',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_demo_orders_ws_member ON demo_orders (workspace_id, member_id, check_in DESC);

-- ---------- H8：kb_documents 内容指纹幂等（同工作区同 hash 唯一；NULL 不参与冲突） ----------
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_documents_ws_hash ON kb_documents (workspace_id, hash);

-- ============================================================================
-- 权限：双角色授权（与 0010 同口径）
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON demo_members, demo_orders TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON demo_members, demo_orders TO workloom_gateway;

-- ============================================================================
-- RLS 行级隔离（策略同 0010：app.workspace_id 过滤，未设置全不可见=安全默认值）
-- ============================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['demo_members','demo_orders'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS p_%I_ws ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY p_%I_ws ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t, t);
  END LOOP;
END $$;
