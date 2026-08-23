-- 0012_service_c_demo_pk.sql · AI 服务前台演示表主键修正
-- 问题：demo_members/demo_orders 以 member_id/order_id 单列为主键，
--       多工作区仓库（如视频版 ws-video + ws-yunqi 并存）下第二工作区引导种子
--       因 ON CONFLICT DO NOTHING 被整体跳过。
-- 修法：先摘 demo_orders→demo_members 外键，主键改为 (workspace_id, *) 复合主键，
--       再按复合键重建外键（全程幂等守卫，兼容各库历史漂移）。

DO $$
BEGIN
  -- 摘外键（存在才摘；不同库该 FK 可能不存在）
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='demo_orders'::regclass AND conname='demo_orders_member_id_fkey') THEN
    ALTER TABLE demo_orders DROP CONSTRAINT demo_orders_member_id_fkey;
  END IF;

  -- demo_members：单列主键 → 复合主键
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='demo_members'::regclass AND contype='p'
      AND pg_get_constraintdef(oid)='PRIMARY KEY (member_id)'
  ) THEN
    ALTER TABLE demo_members DROP CONSTRAINT demo_members_pkey;
    ALTER TABLE demo_members ADD PRIMARY KEY (workspace_id, member_id);
  END IF;

  -- demo_orders：单列主键 → 复合主键
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='demo_orders'::regclass AND contype='p'
      AND pg_get_constraintdef(oid)='PRIMARY KEY (order_id)'
  ) THEN
    ALTER TABLE demo_orders DROP CONSTRAINT demo_orders_pkey;
    ALTER TABLE demo_orders ADD PRIMARY KEY (workspace_id, order_id);
  END IF;

  -- 按复合键重建外键（不存在才建）
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='demo_orders'::regclass AND conname='demo_orders_member_fk') THEN
    ALTER TABLE demo_orders
      ADD CONSTRAINT demo_orders_member_fk
      FOREIGN KEY (workspace_id, member_id) REFERENCES demo_members(workspace_id, member_id);
  END IF;
END $$;
