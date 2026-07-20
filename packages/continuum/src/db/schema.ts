export const schemaSql = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  baseline_checkpoint_id TEXT,
  redirect_to_project_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_id TEXT,
  title TEXT NOT NULL,
  attributes_json TEXT NOT NULL,
  privacy TEXT NOT NULL,
  relevance TEXT NOT NULL,
  confidence REAL NOT NULL,
  dedupe_key TEXT,
  window_id TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe ON events(project_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_pending ON events(project_id, window_id, occurred_at);

CREATE TABLE IF NOT EXISTS windows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  cloud_eligible INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  window_id TEXT NOT NULL UNIQUE,
  goal TEXT NOT NULL,
  focus TEXT NOT NULL,
  summary TEXT NOT NULL,
  importance REAL NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(window_id) REFERENCES windows(id)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_project_time ON checkpoints(project_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS checkpoint_fts USING fts5(
  project_id UNINDEXED,
  goal,
  focus,
  summary,
  items,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  UNIQUE(project_id, kind, key)
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  from_node INTEGER NOT NULL,
  to_node INTEGER NOT NULL,
  relation TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  UNIQUE(from_node, to_node, relation, checkpoint_id),
  FOREIGN KEY(from_node) REFERENCES graph_nodes(id),
  FOREIGN KEY(to_node) REFERENCES graph_nodes(id),
  FOREIGN KEY(checkpoint_id) REFERENCES checkpoints(id)
);
CREATE INDEX IF NOT EXISTS idx_graph_checkpoint ON graph_edges(checkpoint_id);

CREATE TABLE IF NOT EXISTS provider_runs (
  id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  input_event_ids_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS privacy_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  rule TEXT NOT NULL,
  action TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS privacy_audit_dedupe (
  dedupe_hash TEXT PRIMARY KEY,
  audit_id INTEGER NOT NULL,
  FOREIGN KEY(audit_id) REFERENCES privacy_audit(id) ON DELETE CASCADE
);
`;

export const livePlatformSchemaSql = `
CREATE TABLE IF NOT EXISTS project_aliases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  local_path_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  repository_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(device_id, local_path_hash),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_alias_fingerprint ON project_aliases(repository_fingerprint);

CREATE TABLE IF NOT EXISTS project_identity_conflicts (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  local_path_hash TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  repository_fingerprint TEXT NOT NULL,
  provisional_project_id TEXT NOT NULL,
  candidate_project_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed')),
  confirmed_project_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(device_id, local_path_hash),
  FOREIGN KEY(provisional_project_id) REFERENCES projects(id),
  FOREIGN KEY(confirmed_project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_project_identity_conflicts_status
  ON project_identity_conflicts(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS active_project_leases (
  device_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_active_project_lease_expiry ON active_project_leases(expires_at);

CREATE TABLE IF NOT EXISTS privacy_policies (
  revision INTEGER PRIMARY KEY,
  policy_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'personal',
  sync_eligibility TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_project_time ON chat_sessions(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  citations_json TEXT NOT NULL,
  hypotheses_json TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  sync_eligibility TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_time ON chat_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS context_actions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT,
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  mutating INTEGER NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  hlc TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  tombstone INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  acknowledged_at TEXT,
  UNIQUE(device_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON sync_outbox(acknowledged_at, sequence);

CREATE TABLE IF NOT EXISTS sync_inbox (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  hlc TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  UNIQUE(device_id, sequence)
);

CREATE TABLE IF NOT EXISTS device_state (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  last_hlc TEXT,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS collector_pairings (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  challenge_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  token_hash TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_collector_pairings_status ON collector_pairings(kind, status, expires_at);

CREATE TABLE IF NOT EXISTS sync_entity_clock (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  device_id TEXT NOT NULL,
  PRIMARY KEY(entity_type, entity_id)
);
`;
