-- ============================================================================
-- WorkLoom IM 底座 · 0004_biz_events_no_truncate.sql
-- #30 append-only 第三道防线：TRUNCATE 触发器
-- 对齐：审计第 1 轮 P3-3——行级触发器只拦 UPDATE/DELETE，TRUNCATE 不走行触发器，
--      表 owner（迁移/种子账号）此前可一条 TRUNCATE 清空整个事件库。
--      本触发器对**所有角色**生效（含 owner）：清库只能 DROP + 重迁移（显式运维动作），
--      不存在「顺手 TRUNCATE」的误操作/提权破坏路径。
-- ============================================================================

CREATE OR REPLACE FUNCTION workloom_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'biz_events is append-only: TRUNCATE not allowed (PRD L1.1, audit #30)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_biz_events_no_truncate ON biz_events;
CREATE TRIGGER trg_biz_events_no_truncate
  BEFORE TRUNCATE ON biz_events
  FOR EACH STATEMENT EXECUTE FUNCTION workloom_no_truncate();
