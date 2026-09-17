-- ============================================================================
-- WorkLoom IM 底座 · 0013_pipeline_hardening.sql
-- 数据管道审计加固（迁移/RLS/夜班/认证/连接池 配套 DDL；全部幂等）
--
-- ① P0-3 事件编号全局序列 biz_events_eid_seq（E-<digits> 唯一命名空间；
--    回放/补偿走 E-SEED-/E-RPL- 前缀，与数字空间硬隔离）
-- ② append_event_insert 升级：advisory 链锁移进 DB 层；event_id 冲突比对
--    payload md5——一致幂等丢弃，不一致按抢占攻击拒绝
-- ③ fence_rules 基线守卫触发器覆盖 DELETE（OLD.workspace_id='*' 同口径拒）
-- ④ workspaces RLS 收紧：去掉 tenant 直通分支，只留 id=workspace GUC
-- ⑤ night_runs 主键改复合 (workspace_id, run_date)；id 保留唯一约束兼容旧查询
-- ⑥ org_memory + subject_id；memory_usage + workspace_id 并纳入 RLS
-- ⑦ trigger_fires 触发账本（cron 幂等去重）
-- ⑧ skill_revocations 收回 app 角色写权（吊销走 owner 通道）
-- ⑨ memory_usage / trigger_fires 的 GRANT 与 RLS 补齐
-- ============================================================================

-- ---------- ① 全局事件号序列（P0-3） ----------
CREATE SEQUENCE IF NOT EXISTS biz_events_eid_seq START 9100;

DO $$
DECLARE
  v_max          BIGINT;
  v_last         BIGINT;
  v_called       BOOLEAN;
  v_next_needed  BIGINT;
  v_next_current BIGINT;
BEGIN
  -- 全库现有 E-<digits> 事件号最大值（回放前缀 E-SEED-/E-RPL- 不在数字空间，天然排除）
  SELECT COALESCE(MAX(substring(event_id from '^E-(\d+)$')::bigint), 0)
    INTO v_max FROM biz_events;
  SELECT s.last_value, s.is_called INTO v_last, v_called FROM biz_events_eid_seq s;
  v_next_needed  := v_max + 1;
  v_next_current := CASE WHEN v_called THEN v_last + 1 ELSE v_last END;
  -- 只前进不后退：保护已分配区间（并发库可能已发过更大的号）
  IF v_next_needed > v_next_current THEN
    PERFORM setval('biz_events_eid_seq', v_next_needed, false);
  END IF;
END $$;

GRANT USAGE, SELECT ON SEQUENCE biz_events_eid_seq TO workloom_app, workloom_gateway;

-- ---------- ② append_event_insert 升级（P0-3 冲突语义 + P1-5 锁下沉） ----------
-- 链锁 key 与 packages/base/workdata/events.ts 的 chainLockKey 同口径
-- （'event-chain:'||tenant||':'||workspace；函数体内同 key 可重入，xact 锁不叠加死锁）
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
BEGIN
  -- 锁移进函数体（P1-5：workspace 粒度链串行化；与调用方同 key 可重入）
  PERFORM pg_advisory_xact_lock(hashtext('event-chain:' || p_tenant_id || ':' || p_workspace_id));

  -- ① 上下文一致性：RLS GUC 必须与事件归属一致（防跨区伪造写入）
  IF current_setting('app.tenant_id', true) IS DISTINCT FROM p_tenant_id
     OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'append_event_insert: 上下文与事件归属不一致（D16 防伪造）';
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

-- ---------- ③ fence_rules 基线守卫覆盖 DELETE（0005 续：删基线同口径拒） ----------
CREATE OR REPLACE FUNCTION workloom_fence_baseline_guard() RETURNS trigger AS $$
BEGIN
  -- DELETE 校验 OLD；INSERT/UPDATE 校验 NEW（'*' 全局基线仅 owner 可写，F2.3/audit #31）
  IF TG_OP = 'DELETE' THEN
    IF OLD.workspace_id = '*' AND current_user IN ('workloom_app', 'workloom_gateway') THEN
      RAISE EXCEPTION 'fence_rules 全局基线行（workspace_id=''*''）仅 owner 可删（F2.3, audit #31）';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.workspace_id = '*' AND current_user IN ('workloom_app', 'workloom_gateway') THEN
    RAISE EXCEPTION 'fence_rules 全局基线行（workspace_id=''*''）仅 owner 可写（F2.3, audit #31）';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fence_rules_baseline_guard ON fence_rules;
CREATE TRIGGER trg_fence_rules_baseline_guard
  BEFORE INSERT OR UPDATE OR DELETE ON fence_rules
  FOR EACH ROW EXECUTE FUNCTION workloom_fence_baseline_guard();

-- ---------- ④ workspaces RLS 收紧：去 tenant 直通，只留 id=workspace GUC ----------
-- 影响评估（实测核对）：
--  - loginAs / onboarding（store.ts/gateway.ts）：走 owner 池（RLS 不生效），不受影响；
--  - 业务读路径全部 WHERE id=$1 + workspace GUC 同事务设置，口径一致不受影响；
--  - tenant 级聚合（集团CEO 跨区协奏等）：按既有口径逐工作区轮询（与 0009 注释同），
--    不开跨区直读后门——本收紧正是封死「只知 tenant_id 即可读全部 workspace」的开口。
DROP POLICY IF EXISTS p_workspaces_ws ON workspaces;
CREATE POLICY p_workspaces_ws ON workspaces
  USING (id = current_setting('app.workspace_id', true))
  WITH CHECK (id = current_setting('app.workspace_id', true));

-- ---------- ⑤ night_runs 复合主键（同工作区同日期唯一一班） ----------
-- 存量数据 id 原样保留；新 PK (workspace_id, run_date)；
-- id 另加唯一约束——兼容旧 id 直查与种子 ON CONFLICT (id) 幂等。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='night_runs'::regclass AND contype='p'
      AND pg_get_constraintdef(oid)='PRIMARY KEY (id)'
  ) THEN
    ALTER TABLE night_runs DROP CONSTRAINT night_runs_pkey;
    ALTER TABLE night_runs ADD PRIMARY KEY (workspace_id, run_date);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_night_runs_id ON night_runs (id);

-- ---------- ⑥ org_memory.subject_id + memory_usage.workspace_id（纳入 RLS） ----------
ALTER TABLE org_memory ADD COLUMN IF NOT EXISTS subject_id TEXT;

ALTER TABLE memory_usage ADD COLUMN IF NOT EXISTS workspace_id TEXT;
-- 回填：从关联 org_memory 推导（FK 保证可归因；残留 NULL 才置 NOT NULL 失败=数据异常暴露）
UPDATE memory_usage mu SET workspace_id = om.workspace_id
  FROM org_memory om
 WHERE mu.memory_id = om.memory_id AND mu.workspace_id IS NULL;
ALTER TABLE memory_usage ALTER COLUMN workspace_id SET NOT NULL;

-- ---------- ⑦ trigger_fires 触发账本（cron 每分钟幂等去重，F4.7） ----------
CREATE TABLE IF NOT EXISTS trigger_fires (
  trigger_id   TEXT NOT NULL REFERENCES triggers(id),
  fire_minute  TIMESTAMPTZ NOT NULL,                    -- date_trunc('minute', fire_at)
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (trigger_id, fire_minute)
);
CREATE INDEX IF NOT EXISTS idx_trigger_fires_ws ON trigger_fires (workspace_id, fire_minute DESC);

-- ---------- ⑧ skill_revocations：吊销收口 owner 通道 ----------
-- app 角色只读（安装/装配排除判定），INSERT/DELETE 吊销操作仅 owner（运维 kill switch）
REVOKE INSERT, DELETE ON skill_revocations FROM workloom_app;

-- ---------- ⑨ GRANT 与 RLS 补齐 ----------
GRANT SELECT, INSERT, UPDATE, DELETE ON memory_usage TO workloom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memory_usage TO workloom_gateway;
GRANT SELECT, INSERT ON trigger_fires TO workloom_app;
GRANT SELECT, INSERT ON trigger_fires TO workloom_gateway;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['memory_usage','trigger_fires'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS p_%I_ws ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY p_%I_ws ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t, t, t);
  END LOOP;
END $$;
