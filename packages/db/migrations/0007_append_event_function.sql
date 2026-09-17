-- 0007 · D16 双池事务一致性：append_event_insert 特权函数
-- SECURITY DEFINER（OWNER=workloom_gateway）：app 角色无 biz_events 直接 INSERT 权限，
-- 只能调用本函数在「自己的业务事务内」完成事件写入——业务状态与事件同一 COMMIT，原子。
-- 函数双校验：①GUC 上下文与事件归属一致（防伪造）；②prev_hash 与链尾一致（断链拒写，D13 口径）。

CREATE OR REPLACE FUNCTION append_event_insert(
  p_event_id     TEXT,
  p_tenant_id    TEXT,
  p_workspace_id TEXT,
  p_session_id   TEXT,
  p_payload      JSONB,
  p_prev_hash    TEXT,
  p_hash         TEXT,
  p_created_at   TIMESTAMPTZ
) RETURNS TABLE(seq BIGINT, inserted BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tail_hash TEXT;
  v_seq       BIGINT;
BEGIN
  -- ① 上下文一致性：RLS GUC 必须与事件归属一致（防跨区伪造写入）
  IF current_setting('app.tenant_id', true) IS DISTINCT FROM p_tenant_id
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'append_event_insert: 上下文与事件归属不一致（D16 防伪造）';
  END IF;

  -- ② 链式接龙自校验（D13：workspace 级审计链；空链起点 = 'GENESIS'）
  SELECT e.hash INTO v_tail_hash
    FROM biz_events e
   WHERE e.tenant_id = p_tenant_id AND e.workspace_id = p_workspace_id
   ORDER BY e.seq DESC LIMIT 1;
  IF p_prev_hash IS DISTINCT FROM COALESCE(v_tail_hash, 'GENESIS') THEN
    RAISE EXCEPTION 'append_event_insert: prev_hash 与链尾不符（断链拒写，D16）';
  END IF;

  INSERT INTO biz_events (event_id, tenant_id, workspace_id, session_id, payload, prev_hash, hash, created_at)
  VALUES (p_event_id, p_tenant_id, p_workspace_id, p_session_id, p_payload, p_prev_hash, p_hash, p_created_at)
  ON CONFLICT (tenant_id, event_id) DO NOTHING
  RETURNING biz_events.seq INTO v_seq;

  RETURN QUERY SELECT v_seq, (v_seq IS NOT NULL);
END;
$$;

ALTER FUNCTION append_event_insert(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TIMESTAMPTZ) OWNER TO workloom_gateway;
REVOKE ALL ON FUNCTION append_event_insert(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION append_event_insert(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TIMESTAMPTZ) TO workloom_app;
GRANT EXECUTE ON FUNCTION append_event_insert(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TIMESTAMPTZ) TO workloom_gateway;
