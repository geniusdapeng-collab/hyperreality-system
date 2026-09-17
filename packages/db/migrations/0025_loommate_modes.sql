-- 0025_loommate_modes.sql · 织伴形态三模式：small(96px) / large(480px·屏幕 1/4 级) / fullscreen(屏保)
-- 背景：用户反馈 200px 大尺寸不够——远距可见性不足；新增全屏屏保模式（秘书守场照看团队）
ALTER TABLE secretary_settings DROP CONSTRAINT IF EXISTS secretary_settings_widget_size_check;
ALTER TABLE secretary_settings
  ADD CONSTRAINT secretary_settings_widget_size_check
  CHECK (widget_size IN ('small', 'large', 'fullscreen'));
