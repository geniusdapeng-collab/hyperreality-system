-- 0019_skill_ops_autosync.sql · 技能保鲜环：夜班窗口自动同步（机制即自动，客户零操作）
-- 背景：产品要求「技能下发后客户端自动同步，不让客户操作」。
--      auto_sync=false 是留给客户的总开关（治理主权），默认 true。
ALTER TABLE skill_dist_policy ADD COLUMN IF NOT EXISTS auto_sync BOOLEAN NOT NULL DEFAULT true;
