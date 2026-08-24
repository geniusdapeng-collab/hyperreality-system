-- 0016_readable_id_tail.sql · 可读编号号源函数（D29 跨工作区撞号治理·续 0015）
-- 背景：threads / video_projects 的可读编号（T-### / VID-###）按「当前工作区最大值 +1」分配，
--       但主键是全库唯一的 id——RLS 上下文内只见本区数据，必然与他区已占用编号撞库。
--       表现为：任一工作区第二次派遣即 duplicate key（ASK/QUEST 主链路故障，发布红线实证）。
--       另：原查询 regexp_replace(id, '\D', ...) 用了 PostgreSQL 不支持的 \d 简写，号段过滤恒为空。
-- 方案：SECURITY DEFINER 函数以属主身份读全库最大值（绕 RLS，只读、只暴露一个数字），
--       同时把 \d 修正为 [^0-9]。
CREATE OR REPLACE FUNCTION public.threads_max_t_no()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_max BIGINT;
BEGIN
  SELECT max(NULLIF(regexp_replace(t.id, '[^0-9]', '', 'g'), '')::bigint)
    INTO v_max
    FROM threads t
   WHERE t.id ~ '^T-[0-9]+$';
  RETURN COALESCE(v_max, 100);
END;
$function$;

CREATE OR REPLACE FUNCTION public.video_projects_max_vid_no()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_max BIGINT;
BEGIN
  SELECT max(NULLIF(regexp_replace(v.id, '[^0-9]', '', 'g'), '')::bigint)
    INTO v_max
    FROM video_projects v
   WHERE v.id ~ '^VID-[0-9]+$';
  RETURN COALESCE(v_max, 1000);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.threads_max_t_no() TO workloom_app;
GRANT EXECUTE ON FUNCTION public.threads_max_t_no() TO workloom_gateway;
GRANT EXECUTE ON FUNCTION public.video_projects_max_vid_no() TO workloom_app;
GRANT EXECUTE ON FUNCTION public.video_projects_max_vid_no() TO workloom_gateway;
