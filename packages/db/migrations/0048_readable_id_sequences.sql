-- 0048 · 可读号源序列化（GR-02）
--
-- 背景（2026-09-28 压测 + IM ST-02/P0-2）：0016 的 `threads_max_t_no()` / `video_projects_max_vid_no()`
-- 是 SECURITY DEFINER 的 `SELECT max(...)` 包装——解决跨工作区撞号，但并发事务读到同一最大值的问题
-- 原样保留（12 路并发实测 7/12 duplicate key → 裸 500）。
-- 口径：改真正的 SEQUENCE（原子 nextval）；起点 setval 对齐现网最大值（幂等）。
-- 兼容：**视频号源只在存在 video_projects 的仓创建**（基座无视频表；growth/ai-video 车道才有）。

CREATE SEQUENCE IF NOT EXISTS public.thread_no_seq START WITH 101;

SELECT setval(
  'public.thread_no_seq',
  GREATEST(
    (SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::bigint), 100)
       FROM public.threads WHERE id ~ '^T-[0-9]+$'),
    (SELECT last_value FROM public.thread_no_seq)
  ),
  true
);

CREATE OR REPLACE FUNCTION public.threads_max_t_no()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$ SELECT nextval('public.thread_no_seq')::bigint $$;

GRANT USAGE, SELECT ON SEQUENCE public.thread_no_seq TO workloom_app, workloom_gateway;
GRANT EXECUTE ON FUNCTION public.threads_max_t_no() TO workloom_app, workloom_gateway;

-- 视频号源（条件创建）
DO $outer$
BEGIN
  IF to_regclass('public.video_projects') IS NULL THEN
    RAISE NOTICE '跳过 video_project_no_seq：本仓无 video_projects 表';
    RETURN;
  END IF;
  EXECUTE 'CREATE SEQUENCE IF NOT EXISTS public.video_project_no_seq START WITH 1001';
  PERFORM setval('public.video_project_no_seq', GREATEST(
    (SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::bigint), 1000)
       FROM public.video_projects WHERE id ~ '^VID-[0-9]+$'),
    (SELECT last_value FROM public.video_project_no_seq)
  ), true);
  EXECUTE $f$
    CREATE OR REPLACE FUNCTION public.video_projects_max_vid_no()
    RETURNS bigint
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $body$ SELECT nextval('public.video_project_no_seq')::bigint $body$;
  $f$;
  EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.video_project_no_seq TO workloom_app, workloom_gateway';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.video_projects_max_vid_no() TO workloom_app, workloom_gateway';
END
$outer$;
