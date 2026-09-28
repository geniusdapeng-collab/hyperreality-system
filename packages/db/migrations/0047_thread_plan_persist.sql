-- 0047 · 计划持久化与审批失效态（GR-01）
--
-- 背景（2026-09-28 growth 压测 + IM ST-01/P1-3）：
--  · runQuest 每次执行都无条件全量重规划（planQuestSmart）——LLM 重规划把同一 step_id 换成
--    别的动作/参数时，旧审批被新动作消费（审批漂移），已执行步骤也会被错误跳过（假交付）；
--  · 批准后自动续跑（apps/server scheduleQuestResumeAfterApproval）会立刻触发一次重规划，
--    漂移窗口在真实使用中必然被踩到。
--
-- 口径：计划落库（threads.plan + plan_version），replay 复用原计划；只有显式 replan 才重规划，
-- 并把该线程未决审批置 superseded（旧审批不得再消费）。

ALTER TABLE threads ADD COLUMN IF NOT EXISTS plan JSONB;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS plan_version INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN threads.plan IS 'Quest 计划快照（QuestStep[]；GR-01 计划持久化，replay 复用不再重规划）';
COMMENT ON COLUMN threads.plan_version IS '计划版本号（每次显式 replan +1；0 表示从未规划）';

-- 审批终态新增 superseded（计划重规划 → 未决审批失效，不再可被消费）
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check
  CHECK (status IN ('pending','approved','edited','rejected','expired','superseded'));
