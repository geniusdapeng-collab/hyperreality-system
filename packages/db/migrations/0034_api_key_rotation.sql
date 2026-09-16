-- 0034_api_key_rotation.sql —— 系统接入密钥无中断轮换
-- 新旧密钥只在限定窗口内并存；到期由认证/清单读取路径自动落成已吊销。

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotation_of TEXT REFERENCES api_keys(id);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS replaced_by TEXT REFERENCES api_keys(id);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS overlap_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_rotation_of_unique
  ON api_keys(rotation_of) WHERE rotation_of IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_replaced_by_unique
  ON api_keys(replaced_by) WHERE replaced_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_rotation_expiry
  ON api_keys(overlap_expires_at) WHERE revoked_at IS NULL AND overlap_expires_at IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='api_keys_rotation_window_check'
  ) THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_rotation_window_check
      CHECK (overlap_expires_at IS NULL OR replaced_by IS NOT NULL);
  END IF;
END $$;
