-- ============================================================================
-- WorkLoom IM 底座 · 0005_fence_baseline_guard.sql
-- #31 fence_rules 全局基线（workspace_id='*'）写入 DB 层收口
-- 对齐：审计第 1 轮 P3-1——RLS 策略 p_fence_rules_ws 的 WITH CHECK 允许
--      `workspace_id = current_setting OR workspace_id='*'`，意味着任何工作区上下文
--      可经 workloom_app / workloom_gateway 角色 INSERT/UPDATE 一条 '*' 全局基线行，
--      影响全部租户（服务层有审批流兜底，但 DB 层未强制，F2.3 基线单调守卫失守面）。
--      本触发器：app/gateway 角色禁止写 '*' 行；owner（迁移/种子/运维）放行。
--      工作区级行（workspace_id != '*'）的既有读写路径不受影响。
-- ============================================================================

CREATE OR REPLACE FUNCTION workloom_fence_baseline_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id = '*' AND current_user IN ('workloom_app', 'workloom_gateway') THEN
    RAISE EXCEPTION 'fence_rules 全局基行（workspace_id=''*''）仅 owner 可写（F2.3, audit #31）';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fence_rules_baseline_guard ON fence_rules;
CREATE TRIGGER trg_fence_rules_baseline_guard
  BEFORE INSERT OR UPDATE ON fence_rules
  FOR EACH ROW EXECUTE FUNCTION workloom_fence_baseline_guard();
