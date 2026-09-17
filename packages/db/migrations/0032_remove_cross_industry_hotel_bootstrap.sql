-- 0032_remove_cross_industry_hotel_bootstrap.sql
-- 历史 service/store.ts 会在进程首次启动时把固定酒店演示数据写入每个工作区。
-- 现已改为“公共表只读核验 + 活动 Bundle 显式适配”，这里精准清理稳定元数据
-- 未标记为酒店的工作区中的旧固定夹具，避免升级后 AI PM/其他行业继续检索到酒店内容。
--
-- 只匹配历史引导使用的固定 ID、标题、姓名/手机号；行业方自有数据不在范围内。

-- 先解除被历史演示身份绑定的 C 用户，避免界面继续显示伪业务身份。
UPDATE c_users AS u
SET member_id = NULL, phone_hash = NULL
WHERE u.member_id IN ('M-1001', 'M-1002')
  AND EXISTS (
    SELECT 1 FROM demo_members AS m
    WHERE m.workspace_id = u.workspace_id
      AND (
        (m.member_id = 'M-1001' AND m.name = '张伟' AND m.phone = '13800000001')
        OR (m.member_id = 'M-1002' AND m.name = '刘芳' AND m.phone = '13800000002')
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspaces AS w
    WHERE w.id = u.workspace_id
      AND (w.bundle_id = 'hotel' OR w.industry = 'hotel')
  );

-- 订单必须先于会员删除，遵守复合外键。
DELETE FROM demo_orders AS o
WHERE (
    (o.order_id = 'O-20260820-001' AND o.member_id = 'M-1001' AND o.room_type = '豪华大床房'
      AND o.check_in = DATE '2026-08-21' AND o.check_out = DATE '2026-08-23'
      AND o.amount_fen = 117600 AND o.status = '已确认')
    OR (o.order_id = 'O-20260818-002' AND o.member_id = 'M-1001' AND o.room_type = '行政双床房'
      AND o.check_in = DATE '2026-08-18' AND o.check_out = DATE '2026-08-19'
      AND o.amount_fen = 68800 AND o.status = '已完成')
    OR (o.order_id = 'O-20260822-003' AND o.member_id = 'M-1002' AND o.room_type = '山景大床房'
      AND o.check_in = DATE '2026-08-25' AND o.check_out = DATE '2026-08-26'
      AND o.amount_fen = 52800 AND o.status = '已确认')
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspaces AS w
    WHERE w.id = o.workspace_id
      AND (w.bundle_id = 'hotel' OR w.industry = 'hotel')
  );

DELETE FROM demo_members AS m
WHERE (
    (m.member_id = 'M-1001' AND m.name = '张伟' AND m.phone = '13800000001')
    OR (m.member_id = 'M-1002' AND m.name = '刘芳' AND m.phone = '13800000002')
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspaces AS w
    WHERE w.id = m.workspace_id
      AND (w.bundle_id = 'hotel' OR w.industry = 'hotel')
  )
  AND NOT EXISTS (
    SELECT 1 FROM demo_orders AS o
    WHERE o.workspace_id = m.workspace_id AND o.member_id = m.member_id
  );

-- 精确删除历史“云栖酒店住客服务须知”的切块与文档。
DELETE FROM kb_chunks AS c
USING kb_documents AS d
WHERE c.workspace_id = d.workspace_id
  AND c.document_id = d.id
  AND d.id = 'kbd-' || d.workspace_id || '-notice'
  AND d.title = '云栖酒店住客服务须知'
  AND NOT EXISTS (
    SELECT 1 FROM workspaces AS w
    WHERE w.id = d.workspace_id
      AND (w.bundle_id = 'hotel' OR w.industry = 'hotel')
  );

DELETE FROM kb_documents AS d
WHERE d.id = 'kbd-' || d.workspace_id || '-notice'
  AND d.title = '云栖酒店住客服务须知'
  AND NOT EXISTS (
    SELECT 1 FROM workspaces AS w
    WHERE w.id = d.workspace_id
      AND (w.bundle_id = 'hotel' OR w.industry = 'hotel')
  );

DELETE FROM kb_collections AS c
WHERE c.id = 'kbc-' || c.workspace_id || '-welcome'
  AND c.name = '住客服务知识库'
  AND NOT EXISTS (
    SELECT 1 FROM workspaces AS w
    WHERE w.id = c.workspace_id
      AND (w.bundle_id = 'hotel' OR w.industry = 'hotel')
  )
  AND NOT EXISTS (
    SELECT 1 FROM kb_documents AS d
    WHERE d.workspace_id = c.workspace_id AND d.collection_id = c.id
  );
