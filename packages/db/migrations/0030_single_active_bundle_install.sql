-- 0030_single_active_bundle_install.sql · 每个工作区最多一套生效装配
-- 原子切换/回滚会在同一事务中先停用旧装配、再启用目标装配；数据库约束阻止旁路写出双 active。

DO $$
BEGIN
  IF EXISTS (
    SELECT workspace_id
    FROM bundle_installs
    WHERE status = 'active'
    GROUP BY workspace_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'bundle_installs 存在同一工作区多套 active 装配；请先完成台账修复再应用 0030';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bundle_installs_one_active
  ON bundle_installs (workspace_id)
  WHERE status = 'active';
