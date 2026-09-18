-- 0035_tenant_overlay_single_active.sql · 每个 (tenant, base_bundle) 最多一个 active 覆盖层
--
-- 背景（HP-01 审计）：0026 只有 UNIQUE(tenant_id, base_bundle, overlay_version)，
-- 没有任何约束阻止同一租户同一行业包出现两行 status='active'。并发「灰度→全量」或并发回滚
-- 会在数据库层留下双 active，使 loadActiveOverlay 的 ORDER BY overlay_version DESC LIMIT 1
-- 变成「谁是新版本谁说了算」的随机裁决，租户实际生效的配置不可预期。
-- 修复口径与 0030（单 active 装配）一致：应用层在同一事务内「先清退旧 active、再 CAS 激活目标」，
-- 数据库部分唯一索引兜底，任何旁路写入都无法产生双 active。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tenant_overlays
    WHERE status = 'active'
    GROUP BY tenant_id, base_bundle
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'tenant_overlays 存在同一 (tenant_id, base_bundle) 多行 active；请先完成台账修复再应用 0035';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_overlays_one_active
  ON tenant_overlays (tenant_id, base_bundle)
  WHERE status = 'active';
