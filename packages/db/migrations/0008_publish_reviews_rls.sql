-- 0008 · #42 skill_publish_reviews 跨工作区越权修复（第 11 轮审计）
-- 0006 建表漏 RLS：无行级安全且 reviewPublish 查询不带 workspace 过滤——
-- 任何工作区上下文可读写他区上架审核单（恶意驳回/伪造复核）。
-- skill_revocations 为全局 kill switch 表（无 workspace 维度，按设计全租户可见），不在本迁移范围。

ALTER TABLE skill_publish_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_publish_reviews FORCE ROW LEVEL SECURITY;

CREATE POLICY publish_reviews_ws_isolation ON skill_publish_reviews
  USING (from_workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (from_workspace_id = current_setting('app.workspace_id', true));
