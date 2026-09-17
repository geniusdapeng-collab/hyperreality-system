-- 0006 · D15 industry 层开放前置机制位（第 9 轮）
-- ② 审核流水线：skill_publish_reviews（提案 + 双人复核）
-- ④ 全局吊销：skill_revocations（kill switch）
-- ⑤ 版本通道：skill_installs.installed_version（安装时版本，供更新对比）

-- ② 上架审核流水线：提案 → 两名不同成员复核 → 才可置 industry 共享
CREATE TABLE IF NOT EXISTS skill_publish_reviews (
  id                TEXT PRIMARY KEY,                          -- pub-<skillId>-<seq>
  skill_id          TEXT NOT NULL REFERENCES skills(id),
  from_workspace_id TEXT NOT NULL,                             -- 提案来源工作区
  proposed_by       TEXT NOT NULL,                             -- 提案人 member_no（禁止自批）
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','completed')),
  approvals         JSONB NOT NULL DEFAULT '[]',               -- 复核手势 [{member_no, gesture, at}]
  required_approvals INT NOT NULL DEFAULT 2,                   -- 双人复核（D15-②）
  reason            TEXT,                                      -- 驳回原因（reject 时必填）
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_publish_reviews_skill ON skill_publish_reviews(skill_id, status);

-- ④ 全局吊销（kill switch）：运营方可全局吊销恶意/缺陷技能；
-- installSkill 与 resolveAgentFenceBindings 双点排除（不删安装行，留痕）
CREATE TABLE IF NOT EXISTS skill_revocations (
  skill_id    TEXT PRIMARY KEY REFERENCES skills(id),
  reason      TEXT NOT NULL,
  revoked_by  TEXT NOT NULL,
  revoked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ⑤ 版本通道：安装时版本快照（既有行回填 skills.version 当前值）
ALTER TABLE skill_installs ADD COLUMN IF NOT EXISTS installed_version TEXT NOT NULL DEFAULT '';
UPDATE skill_installs si SET installed_version = s.version
  FROM skills s WHERE s.id = si.skill_id AND si.installed_version = '';

-- 授权（与 0003 同口径）
GRANT SELECT, INSERT, UPDATE, DELETE ON skill_publish_reviews TO workloom_app;
GRANT SELECT ON skill_publish_reviews TO workloom_gateway;
GRANT SELECT, INSERT, DELETE ON skill_revocations TO workloom_app;
GRANT SELECT ON skill_revocations TO workloom_gateway;
