-- 0031_accounts_overlay_least_privilege.sql
-- 修复 0026/0027 新表遗漏的运行时角色权限，并把带工作区/租户键的账号域表纳入 RLS。
--
-- 纪律：
--   1. workloom_app 只获得当前服务代码实际需要的动作；除验证码发送失败补偿外不授予 DELETE；
--   2. workloom_gateway 不参与覆盖层或账号域读写，保持零权限；
--   3. 全局账号、验证码和会话表在身份建立前必须可访问，因此不伪造工作区 RLS；
--      带 workspace_id / tenant_id 的业务关系表继续以数据库 RLS 兜底隔离。

-- 先撤销可能由人工运维遗留的宽权限，再按白名单重授。表 owner/迁移账号不受影响。
REVOKE ALL PRIVILEGES ON TABLE
  tenant_overlays,
  tenant_overlay_snapshots,
  accounts,
  verification_codes,
  auth_sessions,
  partners,
  partner_grants,
  partner_sessions,
  approval_policies,
  api_keys,
  tenant_relations,
  login_events,
  member_invites
FROM PUBLIC, workloom_app, workloom_gateway;

GRANT SELECT, INSERT, UPDATE ON tenant_overlays TO workloom_app;
GRANT SELECT, INSERT ON tenant_overlay_snapshots TO workloom_app;

-- BIGSERIAL 只需 nextval/currval 能力；不授予序列 UPDATE（setval）。
REVOKE ALL PRIVILEGES ON SEQUENCE
  tenant_overlays_id_seq,
  tenant_overlay_snapshots_id_seq
FROM PUBLIC, workloom_app, workloom_gateway;
GRANT USAGE ON SEQUENCE
  tenant_overlays_id_seq,
  tenant_overlay_snapshots_id_seq
TO workloom_app;

-- 身份建立前/跨工作区账号视图所需的全局身份域。
GRANT SELECT, INSERT, UPDATE ON accounts TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON verification_codes TO workloom_app;
GRANT SELECT, INSERT, UPDATE ON auth_sessions TO workloom_app;
GRANT SELECT, INSERT ON partners TO workloom_app;
GRANT SELECT, INSERT, UPDATE ON partner_sessions TO workloom_app;
GRANT SELECT, INSERT ON login_events TO workloom_app;

-- 已建立身份后，必须在 app.workspace_id / app.tenant_id 事务上下文中访问。
GRANT SELECT, INSERT, UPDATE ON partner_grants TO workloom_app;
GRANT SELECT, INSERT, UPDATE ON approval_policies TO workloom_app;
GRANT SELECT, INSERT, UPDATE ON api_keys TO workloom_app;
GRANT SELECT, INSERT ON tenant_relations TO workloom_app;
GRANT SELECT, INSERT, UPDATE ON member_invites TO workloom_app;

-- 0026 已定义策略；升级库再次显式启用，防止历史环境被人工关闭后带病发布。
ALTER TABLE tenant_overlays ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_overlay_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE partner_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_partner_grants_tenant ON partner_grants;
CREATE POLICY p_partner_grants_tenant ON partner_grants
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE approval_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_approval_policies_ws ON approval_policies;
CREATE POLICY p_approval_policies_ws ON approval_policies
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_api_keys_ws ON api_keys;
CREATE POLICY p_api_keys_ws ON api_keys
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE member_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_member_invites_ws ON member_invites;
CREATE POLICY p_member_invites_ws ON member_invites
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE tenant_relations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p_tenant_relations_parent ON tenant_relations;
CREATE POLICY p_tenant_relations_parent ON tenant_relations
  USING (parent_tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (parent_tenant_id = current_setting('app.tenant_id', true));
