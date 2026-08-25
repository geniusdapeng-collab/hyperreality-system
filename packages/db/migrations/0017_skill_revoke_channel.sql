-- 0017_skill_revoke_channel.sql · 吊销 owner 通道函数（D31，承接 0013⑧ 设计意图）
-- 背景：0013⑧ REVOKE workloom_app 对 skill_revocations 的写权（吊销收口 owner 通道），
--       但 base/publish.ts revokeSkill 仍经 app 池直写——函数级通道补齐：
--       SECURITY DEFINER 以属主身份写入（幂等），应用侧仅可调用、不可直写。
CREATE OR REPLACE FUNCTION public.skill_revoke(p_skill_id text, p_reason text, p_by text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  INSERT INTO skill_revocations (skill_id, reason, revoked_by)
  VALUES (p_skill_id, p_reason, p_by)
  ON CONFLICT (skill_id) DO NOTHING;
  RETURN FOUND; -- true=本次插入；false=已存在（幂等语义回传）
END;
$function$;

GRANT EXECUTE ON FUNCTION public.skill_revoke(text, text, text) TO workloom_app;
GRANT EXECUTE ON FUNCTION public.skill_revoke(text, text, text) TO workloom_gateway;
