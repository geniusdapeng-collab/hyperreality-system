-- 0049 · 线程新增 cancelled 终态（GR-10）
--
-- 背景：步骤级审批被驳回后，原实现只改审批状态，线程永远停在 pending_review（僵尸化，
-- 既不推进也不可再 run）。GR-10 要求驳回联动线程终态 → 需要状态机接纳 cancelled。

ALTER TABLE threads DROP CONSTRAINT IF EXISTS threads_status_check;
ALTER TABLE threads ADD CONSTRAINT threads_status_check
  CHECK (status IN ('queued','running','pending_review','completed','failed','paused','cancelled'));
