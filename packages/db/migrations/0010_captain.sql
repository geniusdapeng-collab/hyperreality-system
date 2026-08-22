-- 0009_captain.sql · 数字CEO（D21）：审批分级路由 tier
-- 五级路由（方案 §三）：L1 auto（无审批行）/ L2 公司CEO裁决 / L3 集团CEO裁决 / L4 董事长请示 / L5 block（无审批行）
-- 存量审批行默认 l2_captain（原「店长级 review」在 CEO 模式下由公司CEO汇聚裁决）

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'l2_captain'
  CHECK (tier IN ('l2_captain','l3_fleet','l4_chairman'));

CREATE INDEX IF NOT EXISTS idx_approvals_tier ON approvals (workspace_id, tier, status);

-- 集团CEO 跨工作区协奏的审批可见性：tier 审批行仍属原工作区（RLS 不变），
-- 集团CEO视图按租户逐工作区轮询聚合（与 twin.stores 同构），不开跨区直读后门。
