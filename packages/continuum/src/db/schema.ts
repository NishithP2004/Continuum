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
  event_id TEXT,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  rule TEXT NOT NULL,
  action TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_privacy_audit_event ON privacy_audit(event_id) WHERE event_id IS NOT NULL;
`;
