-- 0052_approval_one_time_consumption.sql
-- B-02 修复（排雷台账 / L3.5「逐次授权」）：高危 Agent 授权票据一次性消费。
--
-- 问题：workdata/gateway.ts 段③ checkHighRiskAuthorization 此前只 SELECT 验真
-- （status='approved'、未过期、绑定字段全等），全函数无任何写入——同一 approvalRef
-- 可驱动任意多次写动作，且 snapshot 无绑定字段时视为通用授权放行，等于一张
-- 「approved」审批就是永久通行证。
--
-- 本迁移增加 consumed_at：验真通过后在同一事务内原子消费
-- （UPDATE ... WHERE consumed_at IS NULL，rowCount=0 即拒绝）。
-- 语义：一张审批只放行一次高危写落库；重试/重放须重新审批（逐次授权原意）。
-- 兼容：consumed_at 可空，存量审批不受影响；审批状态机（pending→approved 等）不变。

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS consumed_at timestamptz;

-- 已消费索引（验真+消费的热路径按主键即可，此处仅供审计查询「哪些票据已被使用」）
CREATE INDEX IF NOT EXISTS idx_approvals_consumed ON approvals (workspace_id, consumed_at) WHERE consumed_at IS NOT NULL;
