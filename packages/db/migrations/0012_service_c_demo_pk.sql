-- 0012_service_c_demo_pk.sql · AI 服务前台演示表主键修正
-- 问题：demo_members/demo_orders 以 member_id/order_id 单列为主键，
--       多工作区仓库（如视频版 ws-video + ws-yunqi 并存）下第二工作区引导种子
--       因 ON CONFLICT DO NOTHING 被整体跳过（订单/会员查询测试在 ws-yunqi 拿不到数据）。
-- 修法：主键改为 (workspace_id, member_id) / (workspace_id, order_id) 复合主键（幂等 DO 块）。

DO $$
BEGIN
  -- demo_members：若存在单列主键则替换为复合主键
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'demo_members'::regclass AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (member_id)'
  ) THEN
    ALTER TABLE demo_members DROP CONSTRAINT demo_members_pkey;
    ALTER TABLE demo_members ADD PRIMARY KEY (workspace_id, member_id);
  END IF;

  -- demo_orders：同上
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'demo_orders'::regclass AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (order_id)'
  ) THEN
    ALTER TABLE demo_orders DROP CONSTRAINT demo_orders_pkey;
    ALTER TABLE demo_orders ADD PRIMARY KEY (workspace_id, order_id);
  END IF;
END $$;
