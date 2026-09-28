-- 0050 · 号源函数加"现存最大值下限"（GR-02 收口）
--
-- 0048 改 SEQUENCE 后暴露边界：序列起点可能落后于手写/历史 id（实测干净库跑套件时
-- 迁移先于种子执行 → 序列只到 100，而种子随后写 T-101/102/103，首次派遣即 duplicate key）。
-- 口径：每次取号返回 `GREATEST(nextval, 现存最大号)`，并发原子性与不撞号兼得；调用方仍按 +1 使用。
-- 兼容：视频号源函数只在存在 video_projects 的仓重定义。

CREATE OR REPLACE FUNCTION public.threads_max_t_no()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(
    nextval('public.thread_no_seq'),
    (SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::bigint), 100)
       FROM public.threads WHERE id ~ '^T-[0-9]+$')
  )
$$;

GRANT EXECUTE ON FUNCTION public.threads_max_t_no() TO workloom_app, workloom_gateway;

DO $outer$
BEGIN
  IF to_regclass('public.video_projects') IS NULL THEN
    RAISE NOTICE '跳过 video_projects_max_vid_no()：本仓无 video_projects 表';
    RETURN;
  END IF;
  EXECUTE $f$
    CREATE OR REPLACE FUNCTION public.video_projects_max_vid_no()
    RETURNS bigint
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $body$
      SELECT GREATEST(
        nextval('public.video_project_no_seq'),
        (SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '[^0-9]', '', 'g'), '')::bigint), 1000)
           FROM public.video_projects WHERE id ~ '^VID-[0-9]+$')
      )
    $body$;
  $f$;
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.video_projects_max_vid_no() TO workloom_app, workloom_gateway';
END
$outer$;
