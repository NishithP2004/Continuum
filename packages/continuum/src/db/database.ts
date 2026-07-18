import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type {
  CheckpointV1,
  ContextDiffV1,
  Entity,
  ModelSettings,
  NormalizedEventV1
} from "@continuum/contracts";
import { CheckpointV1Schema, ModelSettingsSchema, NormalizedEventV1Schema } from "@continuum/contracts";
import { schemaSql } from "./schema.js";

type Row = Record<string, unknown>;

export interface CheckpointQueryOptions {
  cloudEligibleOnly?: boolean;
}

const defaultSettings: ModelSettings = {
  activeCheckpointProvider: "ollama",
  ollamaModel: "gemma3n:e2b",
  openaiModel: "gpt-5.6-terra"
};

// tsup removes the `node:` prefix from static built-in imports. That is safe for
// long-standing modules such as `crypto`, but `sqlite` only exists as
// `node:sqlite`. Resolve it through Node's loader so the production bundle keeps
// the canonical specifier.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export class ContinuumDatabase {
  readonly raw: DatabaseSyncType;
  private readonly readOnly: boolean;
  private vectorSerializer?: (input: number[]) => Uint8Array;
  vectorAvailable = false;

  constructor(readonly path: string, options: { readOnly?: boolean } = {}) {
    this.readOnly = options.readOnly ?? false;
    this.raw = new DatabaseSync(path, { readOnly: this.readOnly, allowExtension: true });
    if (this.readOnly) {
      this.raw.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
    } else {
      this.raw.exec(schemaSql);
      const windowColumns = this.raw.prepare("PRAGMA table_info(windows)").all() as Row[];
      if (!windowColumns.some((column) => String(column.name) === "cloud_eligible")) {
        this.raw.exec("ALTER TABLE windows ADD COLUMN cloud_eligible INTEGER NOT NULL DEFAULT 0");
      }
      const privacyColumns = this.raw.prepare("PRAGMA table_info(privacy_audit)").all() as Row[];
      if (!privacyColumns.some((column) => String(column.name) === "event_id")) {
        this.raw.exec("ALTER TABLE privacy_audit ADD COLUMN event_id TEXT");
      }
      if (!privacyColumns.some((column) => String(column.name) === "count")) {
        this.raw.exec("ALTER TABLE privacy_audit ADD COLUMN count INTEGER NOT NULL DEFAULT 1");
      }
      this.raw.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_privacy_audit_event ON privacy_audit(event_id) WHERE event_id IS NOT NULL");
      this.raw.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
      this.ensureSettings();
    }
  }

  async initializeVector(): Promise<boolean> {
    try {
      const sqliteVec = await import("sqlite-vec");
      sqliteVec.load(this.raw);
      if (!this.readOnly) {
        this.raw.exec("CREATE VIRTUAL TABLE IF NOT EXISTS checkpoint_vec USING vec0(embedding float[384]);");
      } else {
        const row = this.raw.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'checkpoint_vec'").get() as Row | undefined;
        if (!row) throw new Error("checkpoint_vec is not initialized");
      }
      this.vectorSerializer = (values) => new Uint8Array(new Float32Array(values).buffer);
      this.vectorAvailable = true;
    } catch {
      this.vectorAvailable = false;
    }
    return this.vectorAvailable;
  }

  close(): void {
    this.raw.close();
  }

  private ensureSettings(): void {
    const statement = this.raw.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(defaultSettings)) statement.run(key, JSON.stringify(value));
    statement.run("capturePaused", "false");
    statement.run("revision", "0");
    statement.run("expiredEventCount", "0");
  }

  private bumpRevision(): void {
    const revision = this.revision() + 1;
    this.raw.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('revision', ?)").run(String(revision));
  }

  revision(): number {
    const row = this.raw.prepare("SELECT value FROM settings WHERE key = 'revision'").get() as Row | undefined;
    return Number(row?.value ?? 0);
  }

  capturePaused(): boolean {
    const row = this.raw.prepare("SELECT value FROM settings WHERE key = 'capturePaused'").get() as Row | undefined;
    return row?.value === "true";
  }

  setCapturePaused(paused: boolean): void {
    this.raw.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('capturePaused', ?)").run(String(paused));
    this.bumpRevision();
  }

  getModelSettings(): ModelSettings {
    const rows = this.raw.prepare("SELECT key, value FROM settings WHERE key IN ('activeCheckpointProvider','ollamaModel','openaiModel')").all() as Row[];
    const values = Object.fromEntries(rows.map((row) => [String(row.key), JSON.parse(String(row.value))]));
    return ModelSettingsSchema.parse({ ...defaultSettings, ...values });
  }

  setModelSettings(settings: ModelSettings): ModelSettings {
    const parsed = ModelSettingsSchema.parse(settings);
    const statement = this.raw.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(parsed)) statement.run(key, JSON.stringify(value));
    this.bumpRevision();
    return parsed;
  }

  ensureProject(projectId: string, label = projectId): void {
    const now = new Date().toISOString();
    this.raw.prepare(`
      INSERT INTO projects(id, label, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(projectId, label.slice(0, 256), now, now);
  }

  insertEvent(event: NormalizedEventV1): boolean {
    this.ensureProject(event.projectId);
    const result = this.raw.prepare(`
      INSERT OR IGNORE INTO events(
        id, occurred_at, received_at, source, event_type, project_id, session_id,
        title, attributes_json, privacy, relevance, confidence, dedupe_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.occurredAt,
      new Date().toISOString(),
      event.source,
      event.eventType,
      event.projectId,
      event.sessionId ?? null,
      event.title,
      JSON.stringify(event.attributes),
      event.privacy.classification,
      event.relevance.decision,
      event.confidence,
      event.dedupeKey ?? null
    );
    if (Number(result.changes) > 0) this.bumpRevision();
    return Number(result.changes) > 0;
  }

  auditPrivacy(source: string, rule: string, action: "drop" | "redact", count = 1, eventId?: string): boolean {
    const boundedCount = Math.min(10_000, Math.max(1, Math.trunc(count)));
    const result = this.raw.prepare("INSERT OR IGNORE INTO privacy_audit(event_id, occurred_at, source, rule, action, count) VALUES (?, ?, ?, ?, ?, ?)")
      .run(eventId ?? null, new Date().toISOString(), source, rule.slice(0, 256), action, boundedCount);
    if (Number(result.changes) > 0) this.bumpRevision();
    return Number(result.changes) > 0;
  }

  purgeExpiredEvents(hours = 24): number {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const result = this.raw.prepare("DELETE FROM events WHERE received_at < ?").run(cutoff);
    const expired = Number(result.changes);
    if (expired > 0) {
      const previous = this.expiredEventCount();
      this.raw.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('expiredEventCount', ?)")
        .run(String(previous + expired));
      this.bumpRevision();
    }
    return expired;
  }

  expiredEventCount(): number {
    const row = this.raw.prepare("SELECT value FROM settings WHERE key = 'expiredEventCount'").get() as Row | undefined;
    return Number(row?.value ?? 0);
  }

  projectsWithPendingEvents(): string[] {
    const rows = this.raw.prepare("SELECT DISTINCT project_id FROM events WHERE window_id IS NULL ORDER BY project_id").all() as Row[];
    return rows.map((row) => String(row.project_id));
  }

  pendingEvents(projectId: string, limit = 15): NormalizedEventV1[] {
    const rows = this.raw.prepare(`
      SELECT * FROM events WHERE project_id = ? AND window_id IS NULL
      ORDER BY occurred_at ASC LIMIT ?
    `).all(projectId, limit) as Row[];
    return rows.map((row) => ({
      version: "1",
      id: String(row.id),
      occurredAt: String(row.occurred_at),
      source: String(row.source) as NormalizedEventV1["source"],
      eventType: String(row.event_type),
      projectId: String(row.project_id),
      ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
      title: String(row.title),
      attributes: JSON.parse(String(row.attributes_json)) as Record<string, unknown>,
      privacy: { classification: String(row.privacy) as NormalizedEventV1["privacy"]["classification"], rules: ["persisted_sanitized"] },
      relevance: { decision: String(row.relevance) as NormalizedEventV1["relevance"]["decision"], reason: "persisted" },
      confidence: Number(row.confidence),
      ...(row.dedupe_key ? { dedupeKey: String(row.dedupe_key) } : {})
    }));
  }

  createWindow(projectId: string, events: NormalizedEventV1[], provider: string, model: string, cloudSafe: boolean): string {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.raw.prepare(`
      INSERT INTO windows(id, project_id, started_at, ended_at, status, provider, model, cloud_eligible, created_at)
      VALUES (?, ?, ?, ?, 'processing', ?, ?, ?, ?)
    `).run(id, projectId, events.at(0)?.occurredAt ?? createdAt, events.at(-1)?.occurredAt ?? createdAt, provider, model, cloudSafe ? 1 : 0, createdAt);
    const assign = this.raw.prepare("UPDATE events SET window_id = ? WHERE id = ? AND window_id IS NULL");
    for (const event of events) assign.run(id, event.id);
    this.bumpRevision();
    return id;
  }

  markWindowFailed(windowId: string, error: string): void {
    this.raw.prepare("UPDATE windows SET status = 'failed', error = ? WHERE id = ?").run(error.slice(0, 2000), windowId);
    this.raw.prepare("UPDATE events SET window_id = NULL WHERE window_id = ?").run(windowId);
    this.bumpRevision();
  }

  recordProviderRun(input: {
    id: string;
    windowId: string;
    provider: string;
    model: string;
    status: "success" | "failed";
    latencyMs: number;
    eventIds: string[];
    error?: string;
  }): void {
    this.raw.prepare(`
      INSERT INTO provider_runs(id, window_id, provider, model, status, latency_ms, input_event_ids_json, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.windowId, input.provider, input.model, input.status, input.latencyMs, JSON.stringify(input.eventIds), input.error ?? null, new Date().toISOString());
  }

  insertCheckpoint(checkpoint: CheckpointV1, embedding?: number[]): void {
    const parsed = CheckpointV1Schema.parse(checkpoint);
    this.raw.exec("SAVEPOINT continuum_insert_checkpoint");
    try {
      const result = this.raw.prepare(`
        INSERT INTO checkpoints(id, project_id, window_id, goal, focus, summary, importance, provider, model, checkpoint_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        parsed.id,
        parsed.projectId,
        parsed.windowId,
        parsed.goal,
        parsed.focus,
        parsed.summary,
        parsed.importance,
        parsed.provider,
        parsed.model,
        JSON.stringify(parsed),
        parsed.createdAt
      );
      const rowid = result.lastInsertRowid;
      const items = [
        ...parsed.progress,
        ...parsed.blockers,
        ...parsed.hypotheses,
        ...parsed.decisions,
        ...parsed.questions
      ].map((item) => item.text).join(" ");
      this.raw.prepare("INSERT INTO checkpoint_fts(rowid, project_id, goal, focus, summary, items) VALUES (?, ?, ?, ?, ?, ?)")
        .run(rowid, parsed.projectId, parsed.goal, parsed.focus, parsed.summary, items);
      this.insertGraph(parsed);
      if (embedding && embedding.length === 384 && this.vectorAvailable && this.vectorSerializer) {
        const vectorRowid = typeof rowid === "bigint" ? rowid : BigInt(rowid);
        this.raw.prepare("INSERT INTO checkpoint_vec(rowid, embedding) VALUES (?, ?)")
          .run(vectorRowid, this.vectorSerializer(embedding));
      }
      this.raw.prepare("UPDATE windows SET status = 'complete', error = NULL WHERE id = ?").run(parsed.windowId);
      this.bumpRevision();
      this.raw.exec("RELEASE SAVEPOINT continuum_insert_checkpoint");
    } catch (error) {
      this.raw.exec("ROLLBACK TO SAVEPOINT continuum_insert_checkpoint");
      this.raw.exec("RELEASE SAVEPOINT continuum_insert_checkpoint");
      throw error;
    }
  }

  private upsertNode(projectId: string, kind: string, key: string, label: string): number {
    this.raw.prepare(`
      INSERT INTO graph_nodes(project_id, kind, key, label) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, kind, key) DO UPDATE SET label = excluded.label
    `).run(projectId, kind, key, label);
    const row = this.raw.prepare("SELECT id FROM graph_nodes WHERE project_id = ? AND kind = ? AND key = ?").get(projectId, kind, key) as Row;
    return Number(row.id);
  }

  private insertGraph(checkpoint: CheckpointV1): void {
    const projectNode = this.upsertNode(checkpoint.projectId, "project", checkpoint.projectId, checkpoint.projectId);
    const checkpointNode = this.upsertNode(checkpoint.projectId, "checkpoint", checkpoint.id, checkpoint.summary);
    const edge = this.raw.prepare(`
      INSERT OR IGNORE INTO graph_edges(project_id, from_node, to_node, relation, checkpoint_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    edge.run(checkpoint.projectId, projectNode, checkpointNode, "HAS_CHECKPOINT", checkpoint.id);

    for (const entity of checkpoint.entities) {
      const node = this.upsertNode(checkpoint.projectId, entity.kind, entity.key, entity.label);
      const relation = entity.kind === "file" ? "TOUCHES" : entity.kind === "blocker" ? "BLOCKED_BY" : entity.kind === "decision" ? "DECIDES" : "MENTIONS";
      edge.run(checkpoint.projectId, checkpointNode, node, relation, checkpoint.id);
    }
    for (const blocker of checkpoint.blockers) {
      const key = blocker.text.toLowerCase().slice(0, 512);
      const node = this.upsertNode(checkpoint.projectId, "blocker", key, blocker.text);
      edge.run(checkpoint.projectId, checkpointNode, node, blocker.status === "resolved" ? "RESOLVES" : "BLOCKED_BY", checkpoint.id);
    }
    for (const decision of checkpoint.decisions) {
      const key = decision.text.toLowerCase().slice(0, 512);
      const node = this.upsertNode(checkpoint.projectId, "decision", key, decision.text);
      edge.run(checkpoint.projectId, checkpointNode, node, "DECIDES", checkpoint.id);
    }
    for (const hypothesis of checkpoint.hypotheses) {
      const key = hypothesis.text.toLowerCase().slice(0, 512);
      const node = this.upsertNode(checkpoint.projectId, "concept", key, hypothesis.text);
      edge.run(checkpoint.projectId, checkpointNode, node, `HYPOTHESIS_${hypothesis.status.toUpperCase()}`, checkpoint.id);
    }
  }

  listCheckpoints(
    projectId?: string,
    limit = 100,
    after?: string,
    before?: string,
    options: CheckpointQueryOptions = {}
  ): CheckpointV1[] {
    let sql = "SELECT c.checkpoint_json FROM checkpoints c";
    if (options.cloudEligibleOnly) sql += " JOIN windows w ON w.id = c.window_id";
    sql += " WHERE 1=1";
    const params: Array<string | number> = [];
    if (projectId) { sql += " AND c.project_id = ?"; params.push(projectId); }
    if (after) { sql += " AND c.created_at > ?"; params.push(after); }
    if (before) { sql += " AND c.created_at < ?"; params.push(before); }
    if (options.cloudEligibleOnly) sql += " AND w.cloud_eligible = 1";
    sql += " ORDER BY c.created_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.raw.prepare(sql).all(...params) as Row[];
    return rows.map((row) => CheckpointV1Schema.parse(JSON.parse(String(row.checkpoint_json))));
  }

  getCheckpoint(id: string, options: CheckpointQueryOptions = {}): CheckpointV1 | undefined {
    const row = options.cloudEligibleOnly
      ? this.raw.prepare(`
          SELECT c.checkpoint_json
          FROM checkpoints c JOIN windows w ON w.id = c.window_id
          WHERE c.id = ? AND w.cloud_eligible = 1
        `).get(id) as Row | undefined
      : this.raw.prepare("SELECT checkpoint_json FROM checkpoints WHERE id = ?").get(id) as Row | undefined;
    return row ? CheckpointV1Schema.parse(JSON.parse(String(row.checkpoint_json))) : undefined;
  }

  requireCheckpointForProject(
    projectId: string,
    checkpointId: string,
    options: CheckpointQueryOptions = {}
  ): CheckpointV1 {
    const checkpoint = this.getCheckpoint(checkpointId);
    if (!checkpoint) throw new Error(`Unknown checkpoint: ${checkpointId}`);
    if (checkpoint.projectId !== projectId) {
      throw new Error(`Checkpoint ${checkpointId} does not belong to project ${projectId}`);
    }
    if (options.cloudEligibleOnly && !this.getCheckpoint(checkpointId, options)) {
      throw new Error(`Checkpoint ${checkpointId} is not available in the cloud-eligible MCP view`);
    }
    return checkpoint;
  }

  checkpointsCloudEligible(checkpointIds: string[]): boolean {
    const ids = [...new Set(checkpointIds)];
    if (ids.length === 0) return true;
    const placeholders = ids.map(() => "?").join(",");
    const row = this.raw.prepare(`
      SELECT count(*) AS total,
             sum(CASE WHEN w.cloud_eligible = 1 THEN 1 ELSE 0 END) AS eligible
      FROM checkpoints c JOIN windows w ON w.id = c.window_id
      WHERE c.id IN (${placeholders})
    `).get(...ids) as Row;
    return Number(row.total) === ids.length && Number(row.eligible) === ids.length;
  }

  latestProjectId(options: CheckpointQueryOptions = {}): string | undefined {
    const row = options.cloudEligibleOnly
      ? this.raw.prepare(`
          SELECT c.project_id AS id
          FROM checkpoints c JOIN windows w ON w.id = c.window_id
          WHERE w.cloud_eligible = 1
          ORDER BY c.created_at DESC LIMIT 1
        `).get() as Row | undefined
      : this.raw.prepare("SELECT id FROM projects ORDER BY updated_at DESC LIMIT 1").get() as Row | undefined;
    return row ? String(row.id) : undefined;
  }

  baseline(projectId: string): string | null {
    const row = this.raw.prepare("SELECT baseline_checkpoint_id FROM projects WHERE id = ?").get(projectId) as Row | undefined;
    return row?.baseline_checkpoint_id ? String(row.baseline_checkpoint_id) : null;
  }

  acknowledge(projectId: string, checkpointId: string): void {
    this.requireCheckpointForProject(projectId, checkpointId);
    const result = this.raw.prepare("UPDATE projects SET baseline_checkpoint_id = ?, updated_at = ? WHERE id = ?")
      .run(checkpointId, new Date().toISOString(), projectId);
    if (Number(result.changes) !== 1) throw new Error(`Unknown project: ${projectId}`);
    this.bumpRevision();
  }

  lexicalSearch(
    projectId: string,
    query: string,
    limit = 30,
    options: CheckpointQueryOptions = {}
  ): Array<{ rowid: number; checkpointId: string; rank: number }> {
    const tokens = query.split(/\s+/).map((token) => token.replace(/[^A-Za-z0-9_.\/-]/g, "")).filter(Boolean);
    if (tokens.length === 0) return [];
    const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
    const rows = this.raw.prepare(`
      SELECT f.rowid, c.id AS checkpoint_id, bm25(checkpoint_fts) AS rank
      FROM checkpoint_fts f JOIN checkpoints c ON c.rowid = f.rowid
      ${options.cloudEligibleOnly ? "JOIN windows w ON w.id = c.window_id" : ""}
      WHERE checkpoint_fts MATCH ? AND f.project_id = ?
        ${options.cloudEligibleOnly ? "AND w.cloud_eligible = 1" : ""}
      ORDER BY rank LIMIT ?
    `).all(match, projectId, limit) as Row[];
    return rows.map((row) => ({ rowid: Number(row.rowid), checkpointId: String(row.checkpoint_id), rank: Number(row.rank) }));
  }

  vectorSearch(
    projectId: string,
    embedding: number[],
    limit = 30,
    options: CheckpointQueryOptions = {}
  ): Array<{ checkpointId: string; distance: number }> {
    if (!this.vectorAvailable || !this.vectorSerializer || embedding.length !== 384) return [];
    const rows = this.raw.prepare(`
      SELECT c.id AS checkpoint_id, v.distance
      FROM checkpoint_vec v JOIN checkpoints c ON c.rowid = v.rowid
      ${options.cloudEligibleOnly ? "JOIN windows w ON w.id = c.window_id" : ""}
      WHERE v.embedding MATCH ? AND k = ? AND c.project_id = ?
        ${options.cloudEligibleOnly ? "AND w.cloud_eligible = 1" : ""}
      ORDER BY v.distance
    `).all(this.vectorSerializer(embedding), limit, projectId) as Row[];
    return rows.map((row) => ({ checkpointId: String(row.checkpoint_id), distance: Number(row.distance) }));
  }

  graphRelated(
    projectId: string,
    checkpointIds: string[],
    limit = 30,
    options: CheckpointQueryOptions = {}
  ): string[] {
    if (checkpointIds.length === 0) return [];
    const placeholders = checkpointIds.map(() => "?").join(",");
    const rows = this.raw.prepare(`
      SELECT DISTINCT related.checkpoint_id
      FROM graph_edges seed
      JOIN graph_edges related ON related.to_node = seed.to_node OR related.from_node = seed.to_node
      ${options.cloudEligibleOnly ? "JOIN checkpoints related_checkpoint ON related_checkpoint.id = related.checkpoint_id JOIN windows related_window ON related_window.id = related_checkpoint.window_id" : ""}
      WHERE seed.project_id = ? AND seed.checkpoint_id IN (${placeholders})
        ${options.cloudEligibleOnly ? "AND related_window.cloud_eligible = 1" : ""}
      LIMIT ?
    `).all(projectId, ...checkpointIds, limit) as Row[];
    return rows.map((row) => String(row.checkpoint_id));
  }

  graphEntities(
    projectId: string,
    checkpointIds: string[],
    options: CheckpointQueryOptions = {}
  ): Entity[] {
    if (checkpointIds.length === 0) return [];
    const placeholders = checkpointIds.map(() => "?").join(",");
    const rows = this.raw.prepare(`
      SELECT DISTINCT n.kind, n.key, n.label, e.checkpoint_id, c.checkpoint_json
      FROM graph_edges e
      JOIN graph_nodes n ON n.id = e.to_node
      JOIN checkpoints c ON c.id = e.checkpoint_id
      ${options.cloudEligibleOnly ? "JOIN windows w ON w.id = c.window_id" : ""}
      WHERE e.project_id = ? AND e.checkpoint_id IN (${placeholders}) AND n.kind != 'checkpoint'
        ${options.cloudEligibleOnly ? "AND w.cloud_eligible = 1" : ""}
      ORDER BY n.kind, n.label
    `).all(projectId, ...checkpointIds) as Row[];
    const aggregated = new Map<string, Entity>();
    for (const row of rows) {
      const kind = String(row.kind) as Entity["kind"];
      const key = String(row.key);
      const checkpoint = CheckpointV1Schema.parse(JSON.parse(String(row.checkpoint_json)));
      const direct = checkpoint.entities.find((entity) => entity.kind === kind && entity.key === key);
      const normalizedKey = key.toLowerCase().slice(0, 512);
      const evidenceIds = direct?.eventIds
        ?? (kind === "blocker" ? checkpoint.blockers.find((item) => item.text.toLowerCase().slice(0, 512) === normalizedKey)?.eventIds : undefined)
        ?? (kind === "decision" ? checkpoint.decisions.find((item) => item.text.toLowerCase().slice(0, 512) === normalizedKey)?.eventIds : undefined)
        ?? (kind === "concept" ? checkpoint.hypotheses.find((item) => item.text.toLowerCase().slice(0, 512) === normalizedKey)?.eventIds : undefined);
      if (!evidenceIds || evidenceIds.length === 0) continue;
      const aggregateKey = `${kind}:${key}`;
      const existing = aggregated.get(aggregateKey);
      aggregated.set(aggregateKey, {
        kind,
        key,
        label: String(row.label),
        eventIds: [...new Set([...(existing?.eventIds ?? []), ...evidenceIds])].slice(0, 8)
      });
    }
    return [...aggregated.values()];
  }

  counts(): { eventCount: number; checkpointCount: number; droppedSecretCount: number } {
    const event = this.raw.prepare("SELECT count(*) AS count FROM events").get() as Row;
    const checkpoint = this.raw.prepare("SELECT count(*) AS count FROM checkpoints").get() as Row;
    const secret = this.raw.prepare("SELECT coalesce(sum(count), 0) AS count FROM privacy_audit WHERE action = 'drop' AND rule NOT LIKE 'irrelevant:%'").get() as Row;
    return { eventCount: Number(event.count), checkpointCount: Number(checkpoint.count), droppedSecretCount: Number(secret.count) };
  }

  privacyAudit(limit = 100): Array<{ occurredAt: string; source: string; rule: string; action: string; count: number }> {
    const rows = this.raw.prepare("SELECT occurred_at, source, rule, action, count FROM privacy_audit ORDER BY id DESC LIMIT ?").all(limit) as Row[];
    return rows.map((row) => ({ occurredAt: String(row.occurred_at), source: String(row.source), rule: String(row.rule), action: String(row.action), count: Number(row.count) }));
  }

  recentEvents(projectId?: string, limit = 50): Array<{
    id: string;
    timestamp: string;
    source: string;
    eventType: string;
    title: string;
    relevance: string;
  }> {
    let sql = "SELECT id, occurred_at, source, event_type, title, relevance FROM events WHERE 1=1";
    const params: Array<string | number> = [];
    if (projectId) {
      sql += " AND project_id = ?";
      params.push(projectId);
    }
    sql += " ORDER BY occurred_at DESC LIMIT ?";
    params.push(Math.min(100, Math.max(1, limit)));
    const rows = this.raw.prepare(sql).all(...params) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      timestamp: String(row.occurred_at),
      source: String(row.source),
      eventType: String(row.event_type),
      title: String(row.title),
      relevance: String(row.relevance)
    }));
  }

  eventsForExport(projectId?: string): NormalizedEventV1[] {
    let sql = "SELECT * FROM events WHERE 1=1";
    const params: string[] = [];
    if (projectId) {
      sql += " AND project_id = ?";
      params.push(projectId);
    }
    sql += " ORDER BY occurred_at ASC";
    const rows = this.raw.prepare(sql).all(...params) as Row[];
    return rows.map((row) => NormalizedEventV1Schema.parse({
      version: "1",
      id: String(row.id),
      occurredAt: String(row.occurred_at),
      source: String(row.source),
      eventType: String(row.event_type),
      projectId: String(row.project_id),
      ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
      title: String(row.title),
      attributes: JSON.parse(String(row.attributes_json)),
      privacy: { classification: String(row.privacy), rules: ["persisted_sanitized_export"] },
      relevance: { decision: String(row.relevance), reason: "persisted_sanitized_export" },
      confidence: Number(row.confidence),
      ...(row.dedupe_key ? { dedupeKey: String(row.dedupe_key) } : {})
    }));
  }

  hasDemoEvents(projectId?: string): boolean {
    const row = projectId
      ? this.raw.prepare("SELECT 1 AS present FROM events WHERE source = 'demo' AND project_id = ? LIMIT 1").get(projectId) as Row | undefined
      : this.raw.prepare("SELECT 1 AS present FROM events WHERE source = 'demo' LIMIT 1").get() as Row | undefined;
    return Boolean(row);
  }

  collectorNames(): string[] {
    const rows = this.raw.prepare("SELECT DISTINCT source FROM events ORDER BY source").all() as Row[];
    return rows.map((row) => String(row.source));
  }

  graphCounts(): { graphNodeCount: number; graphEdgeCount: number } {
    const nodes = this.raw.prepare("SELECT count(*) AS count FROM graph_nodes").get() as Row;
    const edges = this.raw.prepare("SELECT count(*) AS count FROM graph_edges").get() as Row;
    return { graphNodeCount: Number(nodes.count), graphEdgeCount: Number(edges.count) };
  }

  pendingEventCount(projectId?: string): number {
    const row = projectId
      ? this.raw.prepare("SELECT count(*) AS count FROM events WHERE window_id IS NULL AND project_id = ?").get(projectId) as Row
      : this.raw.prepare("SELECT count(*) AS count FROM events WHERE window_id IS NULL").get() as Row;
    return Number(row.count);
  }

  confidentialEventCount(): number {
    const row = this.raw.prepare("SELECT count(*) AS count FROM events WHERE privacy = 'confidential'").get() as Row;
    return Number(row.count);
  }

  privacyRuleCounts(limit = 50): Array<{ rule: string; count: number }> {
    const rows = this.raw.prepare(`
      SELECT rule, sum(count) AS count
      FROM privacy_audit
      GROUP BY rule
      ORDER BY count DESC, rule ASC
      LIMIT ?
    `).all(limit) as Row[];
    return rows.map((row) => ({ rule: String(row.rule), count: Number(row.count) }));
  }
}
