-- ============================================================================
-- WorkLoom IM 底座 · 0002_bugfix.sql
-- Bug 修复批次：#13 threads.paused_by / #17 skill_installs.fence_bindings_snapshot
-- 对齐：审计报告 Bug #13（resumeNight 覆盖手动暂停）/ #17（技能 fence_bindings 绕过冲突检测）
-- ============================================================================

-- ---------- #13: threads.paused_by 区分夜班暂停与手动暂停 ----------
-- pauseAll 暂停时写入 'night-shift'；resumeNight 只恢复该标记的线程，不覆盖手动暂停
ALTER TABLE threads ADD COLUMN IF NOT EXISTS paused_by TEXT;
CREATE INDEX IF NOT EXISTS idx_threads_ws_paused_by ON threads (workspace_id, status, paused_by);

-- ---------- #17: skill_installs.fence_bindings_snapshot 安装时快照 ----------
-- 安装技能时快照其 fence_bindings；运行时读快照而非实时值，防止技能作者更新绑定绕过冲突检测
ALTER TABLE skill_installs ADD COLUMN IF NOT EXISTS fence_bindings_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ---------- #16: skills 表加 CHECK 约束强制 team 级技能 ID 以 skill-t- 开头 ----------
-- 此前 isSignedSource 只检查 ID 前缀，无 DB 约束；任何能 INSERT skills 表的人可伪造签名
-- 加 CHECK 后 DB 层强制 team 级技能 ID 必须以 skill-t- 开头，与 isSignedSource 逻辑一致
ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_team_id_format;
ALTER TABLE skills ADD CONSTRAINT skills_team_id_format
  CHECK (level != 'team' OR id LIKE 'skill-t-%');
