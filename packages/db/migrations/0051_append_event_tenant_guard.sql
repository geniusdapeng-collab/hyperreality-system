-- 0051 · 事件归属一致性护栏（append_event_insert 加固）
--
-- 起因（2026-09-28 沙箱实证）：一个调试脚本把 tenant_id 写成 "demo"（工作区实际属主是
-- "tenant-demo"）就静默写进了 4 条事件——链是按 (tenant, workspace) 组织的，
-- 于是同一个工作区里出现了**第二条链**（链尾出现 GENESIS），套件的"本工作区哈希链自检"
-- 因此失败（append-only，删也删不掉）。
--
-- 口径（精准、不误伤）：
--  - 工作区在 workspaces 表里存在时，事件 tenant 必须等于该工作区属主租户，否则拒写（fail-closed）；
--  - 工作区不存在时放行——混沌/并发/多租户用例会使用**合成作用域**（ws-chaos-*/ws-suite-b-*），
--    它们本就没有属主行，不能被这条护栏挡住（实测 verify 库有 5 个这类合成作用域）。
-- 其余语义（上下文校验/冲突幂等/断链拒写/链锁）与 0016 完全一致，本迁移只加不改。

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
  v_existing  biz_events%ROWTYPE;
  v_owner     TEXT;
BEGIN
  -- 锁移进函数体（P1-5：workspace 粒度链串行化；与调用方同 key 可重入）
  PERFORM pg_advisory_xact_lock(hashtext('event-chain:' || p_tenant_id || ':' || p_workspace_id));

  -- ① 上下文一致性：RLS GUC 必须与事件归属一致（防跨区伪造写入）
  IF current_setting('app.tenant_id', true) IS DISTINCT FROM p_tenant_id
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'append_event_insert: 上下文与事件归属不一致（D16 防伪造）';
  END IF;

  -- ①' 归属护栏（0051）：工作区有属主行时，租户必须匹配——防止同一工作区被写成两条链
  SELECT w.tenant_id INTO v_owner FROM workspaces w WHERE w.id = p_workspace_id;
  IF FOUND AND v_owner IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'append_event_insert: 事件租户 % 与该工作区属主租户 % 不一致（0051 归属护栏）',
      p_tenant_id, v_owner;
  END IF;

  -- ② 冲突先判（P0-3）：同 event_id 已存在 → 比对 payload md5；
  --    不一致 = 抢占攻击（拒绝），一致 = 幂等丢弃（inserted=false）
  SELECT * INTO v_existing FROM biz_events e
   WHERE e.tenant_id = p_tenant_id AND e.event_id = p_event_id;
  IF FOUND THEN
    IF md5(v_existing.payload::text) IS DISTINCT FROM md5(p_payload::text) THEN
      RAISE EXCEPTION 'append_event_insert: event_id % 冲突且 payload 不一致（抢占攻击拒绝，P0-3）', p_event_id;
    END IF;
    RETURN QUERY SELECT NULL::BIGINT, FALSE;
    RETURN;
  END IF;

  -- ③ 链式接龙自校验（D13：workspace 级审计链；空链起点 = 'GENESIS'）
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
