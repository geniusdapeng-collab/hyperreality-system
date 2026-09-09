-- 0027_accounts.sql —— 账号体系（客户域+伙伴域；平台域表在仙女座一方仓）
-- 原则：真人=全局账号（accounts），与企业关系=成员关系（members 演化为挂 account_id）；
-- 既有 members/Identity/RLS 全部兼容——账号登录最终仍解析为工作区成员身份。

-- ============ 全局真人账号 ============
CREATE TABLE IF NOT EXISTS accounts (
  id               TEXT PRIMARY KEY,                  -- acc-xxxxxxxx
  phone            TEXT UNIQUE,
  email            TEXT UNIQUE,
  wechat_openid    TEXT UNIQUE,
  display_name     TEXT NOT NULL DEFAULT '',
  password_hash    TEXT,                              -- scrypt（格式 scrypt:N:r:p:salt:hash）
  totp_secret      TEXT,                              -- 可选二次验证
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','locked','disabled')),
  failed_attempts  INT NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at    TIMESTAMPTZ
);

-- 短信/通用一次性验证码（散列存储、一次性、限速）
CREATE TABLE IF NOT EXISTS verification_codes (
  id           TEXT PRIMARY KEY,
  channel      TEXT NOT NULL,                         -- phone / email
  target       TEXT NOT NULL,                         -- 手机号/邮箱
  purpose      TEXT NOT NULL,                         -- login / activate / invite / danger-confirm
  code_hash    TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  attempts     INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vcodes_target ON verification_codes(channel, target, purpose, created_at DESC);

-- 会话与刷新令牌（散列入库，可踢出）
CREATE TABLE IF NOT EXISTS auth_sessions (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  refresh_token_hash  TEXT NOT NULL UNIQUE,
  device_name         TEXT NOT NULL DEFAULT '',
  device_trusted      BOOLEAN NOT NULL DEFAULT false,
  ip                  TEXT NOT NULL DEFAULT '',
  ua                  TEXT NOT NULL DEFAULT '',
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON auth_sessions(account_id) WHERE revoked_at IS NULL;

-- members 演化：挂全局账号 + 快切 PIN + 点状权限 + 显示名
ALTER TABLE members ADD COLUMN IF NOT EXISTS account_id    TEXT REFERENCES accounts(id);
ALTER TABLE members ADD COLUMN IF NOT EXISTS quick_pin_hash TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS permissions   JSONB NOT NULL DEFAULT '{}';
ALTER TABLE members ADD COLUMN IF NOT EXISTS alias         TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','invited','removed'));
CREATE INDEX IF NOT EXISTS idx_members_account ON members(account_id) WHERE account_id IS NOT NULL;

-- staff 角色入列（成员角色扩编：owner/manager/staff/readonly/group/channel）
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_role_check;
ALTER TABLE members ADD CONSTRAINT members_role_check
  CHECK (role IN ('owner','manager','staff','readonly','group','channel'));

-- ============ 伙伴域 ============
CREATE TABLE IF NOT EXISTS partners (
  id                  TEXT PRIMARY KEY,               -- ptr-xxxxxxxx
  name                TEXT NOT NULL,
  type                TEXT NOT NULL CHECK (type IN ('agency','contractor','observer')),
  contact_account_id  TEXT NOT NULL REFERENCES accounts(id),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partner_grants (           -- 客户 owner 签发；伙伴权限唯一来源
  id             TEXT PRIMARY KEY,                    -- grt-xxxxxxxx
  partner_id     TEXT NOT NULL REFERENCES partners(id),
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  workspaces     JSONB NOT NULL DEFAULT '[]',         -- 授权门店（workspace id 清单）
  capabilities   JSONB NOT NULL DEFAULT '[]',         -- ticket.handle / ops.execute / report.view / deliverable.view …
  constraints    JSONB NOT NULL DEFAULT '{}',         -- dailyLimit / ipAllowlist
  issued_by      TEXT NOT NULL,                       -- 签发人（members.id）
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revoke_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_grants_partner ON partner_grants(partner_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_grants_tenant ON partner_grants(tenant_id) WHERE revoked_at IS NULL;

-- 伙伴会话（独立表，不与客户会话混）
CREATE TABLE IF NOT EXISTS partner_sessions (
  id                  TEXT PRIMARY KEY,
  partner_id          TEXT NOT NULL REFERENCES partners(id),
  refresh_token_hash  TEXT NOT NULL UNIQUE,
  device_name         TEXT NOT NULL DEFAULT '',
  ip                  TEXT NOT NULL DEFAULT '',
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ
);

-- ============ 审批策略（每工作区一张，业态模板预填） ============
CREATE TABLE IF NOT EXISTS approval_policies (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  action_class   TEXT NOT NULL,                       -- daily / business / finance / redline
  fence_level    TEXT NOT NULL CHECK (fence_level IN ('auto','review','block')),
  approver_rule  JSONB NOT NULL DEFAULT '{}',         -- {role:'owner'} / {role:'manager',escalate:'owner'} / {digitalCeo:{band:'…'}}
  delegation     JSONB NOT NULL DEFAULT '{}',         -- AB 角/休假委托/数字 CEO 授权带
  updated_by     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, action_class)
);

-- ============ API 密钥（客户系统对接） ============
CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,                     -- key-xxxxxxxx
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  key_prefix    TEXT NOT NULL,                        -- 展示用 wlk_xxxx…
  capabilities  JSONB NOT NULL DEFAULT '[]',
  rate_limit    INT NOT NULL DEFAULT 60,              -- 次/分钟
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ 集团租户层级 ============
CREATE TABLE IF NOT EXISTS tenant_relations (
  id                TEXT PRIMARY KEY,
  parent_tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  child_tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  relation          TEXT NOT NULL CHECK (relation IN ('direct','franchise')),
  settlement        TEXT NOT NULL DEFAULT 'self_pay' CHECK (settlement IN ('group_pool','self_pay')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parent_tenant_id, child_tenant_id)
);

-- ============ 登录与安全事件（审计；写五元事件之外的查询友好台账） ============
CREATE TABLE IF NOT EXISTS login_events (
  id           TEXT PRIMARY KEY,
  account_id   TEXT REFERENCES accounts(id),
  kind         TEXT NOT NULL,      -- login.ok / login.fail / login.locked / logout / session.revoked / pin.fail / invite.accept / activate.ok
  workspace_id TEXT,
  ip           TEXT NOT NULL DEFAULT '',
  device       TEXT NOT NULL DEFAULT '',
  detail       JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_events_account ON login_events(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_ws ON login_events(workspace_id, created_at DESC);

-- ============ 邀请 ============
CREATE TABLE IF NOT EXISTS member_invites (
  id            TEXT PRIMARY KEY,                     -- inv-xxxxxxxx
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  phone         TEXT,                                 -- 二选一
  email         TEXT,
  role          TEXT NOT NULL CHECK (role IN ('owner','manager','staff','readonly')),
  code_hash     TEXT NOT NULL,                        -- 邀请码（散列）
  invited_by    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','cancelled')),
  expires_at    TIMESTAMPTZ NOT NULL,
  accepted_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invites_ws ON member_invites(workspace_id) WHERE status='pending';
