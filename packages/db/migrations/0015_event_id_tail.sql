-- 0015_event_id_tail.sql · 事件号源尾部函数（D28 号源纪律落地）
-- 背景：appendEventInTx 的号源查询在 RLS 上下文内执行，只能看到当前工作区的事件，
--       导致各工作区"各自为政"分配 event_id，跨工作区撞号后被 ON CONFLICT 幂等静默吞掉
--       （ws-yunqi 计数器冲进 ws-geo 种子号段 9901-9960 时 60 条事件被吞，套件 R 域连环失败）。
-- 方案：SECURITY DEFINER 函数以属主身份读取全租户事件号最大值（绕过 RLS，只读、只暴露一个数字）。
CREATE OR REPLACE FUNCTION public.biz_events_max_event_no(p_tenant_id text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_max BIGINT;
BEGIN
  SELECT max((regexp_replace(e.event_id, '^E-', ''))::bigint)
    INTO v_max
    FROM biz_events e
   WHERE e.tenant_id = p_tenant_id
     AND e.event_id ~ '^E-[0-9]+$';
  RETURN COALESCE(v_max, 8800);
END;
$function$;

-- app/gateway 角色均可调用（与 append_event_insert 同口径）
GRANT EXECUTE ON FUNCTION public.biz_events_max_event_no(text) TO workloom_app;
GRANT EXECUTE ON FUNCTION public.biz_events_max_event_no(text) TO workloom_gateway;
