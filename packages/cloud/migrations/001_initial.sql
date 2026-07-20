CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  platform text NOT NULL CHECK (char_length(platform) BETWEEN 1 AND 64),
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_sequence bigint NOT NULL DEFAULT 0,
  last_hlc text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id varchar(12) NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  digest bytea NOT NULL,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (account_id, id),
  UNIQUE (id)
);

CREATE TABLE IF NOT EXISTS sync_operations (
  server_sequence bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  device_id text NOT NULL,
  device_sequence bigint NOT NULL CHECK (device_sequence > 0),
  hlc text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  tombstone boolean NOT NULL DEFAULT false,
  payload jsonb,
  sync_eligible boolean NOT NULL CHECK (sync_eligible),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (account_id, id),
  UNIQUE (account_id, device_id, device_sequence),
  FOREIGN KEY (account_id, device_id) REFERENCES devices(account_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_entities (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  hlc text NOT NULL,
  device_id text NOT NULL,
  payload jsonb,
  search_text text NOT NULL DEFAULT '',
  tombstone boolean NOT NULL,
  sync_eligible boolean NOT NULL CHECK (sync_eligible),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (account_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS sync_operations_pull_idx
  ON sync_operations (account_id, server_sequence);
CREATE INDEX IF NOT EXISTS sync_operations_expiry_idx
  ON sync_operations (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS sync_entities_live_idx
  ON sync_entities (account_id, entity_type, updated_at DESC) WHERE NOT tombstone;
CREATE INDEX IF NOT EXISTS sync_entities_expiry_idx
  ON sync_entities (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS sync_entities_search_idx
  ON sync_entities USING gin (to_tsvector('simple', search_text))
  WHERE NOT tombstone;

CREATE TABLE IF NOT EXISTS projection_outbox (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, operation_id),
  FOREIGN KEY (account_id, operation_id) REFERENCES sync_operations(account_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS projection_outbox_pending_idx
  ON projection_outbox (next_attempt_at, id) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS projection_state (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_projected_at timestamptz,
  last_error text,
  degraded boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE sync_operations IS 'Append-only tenant-scoped sync oplog. Event rows are capped at 24 hours.';
COMMENT ON TABLE sync_entities IS 'Latest HLC winner for each synchronized entity; Neo4j is rebuilt from this table.';
