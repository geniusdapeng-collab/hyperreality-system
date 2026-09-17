-- 0013：memory_usage 工作区键 + RLS 入列（M3/M4）
--
-- 背景：该变更此前以带外方式落在现网库（加列 + 启用 RLS），但未沉淀为迁移，
-- 造成 schema 漂移——0001 注释仍称「memory_usage 不设 RLS」，drizzle schema 也缺列。
-- 服务层 recordMemoryUsage / getMemorySources 已按 workspace_id 读写；
-- review-console 驳回回流曾因漏写 workspace_id 触发 RLS 42501（WITH CHECK 拒绝 NULL）。
-- 本迁移幂等地补齐定义，消除迁移链与现网库的不一致。

ALTER TABLE memory_usage ADD COLUMN IF NOT EXISTS workspace_id TEXT;

ALTER TABLE memory_usage ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'memory_usage' AND p.polname = 'p_memory_usage_ws'
  ) THEN
    CREATE POLICY p_memory_usage_ws ON memory_usage
      USING (workspace_id = current_setting('app.workspace_id', true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
  END IF;
END $$;

-- 修正 0001 中的过时注释口径：memory_usage 不再是「不设 RLS 的全局引用表」，
-- 已按 app.workspace_id 行级隔离（F7.1/L7.1 同口径）。
COMMENT ON TABLE memory_usage IS '记忆使用归因（F1.4）；M3/M4 起按 workspace_id 行级隔离';
