ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS device_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'api_keys_device_fk'
      AND conrelid = 'api_keys'::regclass
  ) THEN
    ALTER TABLE api_keys
      ADD CONSTRAINT api_keys_device_fk
      FOREIGN KEY (account_id, device_id)
      REFERENCES devices(account_id, id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS api_keys_device_idx
  ON api_keys (account_id, device_id)
  WHERE device_id IS NOT NULL;

COMMENT ON COLUMN api_keys.device_id IS
  'Physical device bound on first sync use. Device revocation also revokes every bound key.';
