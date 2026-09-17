-- 0033_neutral_workspace_industry_default.sql
-- 基座不得把新建工作区默认为任一示例行业。这里只修改“未来 INSERT 未显式
-- 提供 industry 时”的列默认值；已有工作区的明确行业值与事件账本均不改写。

ALTER TABLE workspaces ALTER COLUMN industry SET DEFAULT 'general';

COMMENT ON COLUMN workspaces.industry IS
  '当前工作区行业标识；未装配行业包的新工作区使用中性 general，激活 Bundle 后写入其行业标识';
