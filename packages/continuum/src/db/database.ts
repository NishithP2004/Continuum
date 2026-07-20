import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import type {
  ActiveProjectLeaseV1,
  ChatMessageV1,
  ChatSessionV1,
  CheckpointV1,
  ContextActionV1,
  ContextDiffV1,
  Entity,
  GraphQueryV1,
  GraphEdgeV1,
  GraphNodeV1,
  GraphSnapshotV1,
  ModelSettings,
  NormalizedEvent,
  NormalizedEventV1,
  PrivacyPolicyV1,
  ProjectSyncPayloadV1,
  SyncOperationV1
} from "@continuum/contracts";
import {
  ActiveProjectLeaseV1Schema,
  ChatMessageV1Schema,
  ChatSessionV1Schema,
  CheckpointV1Schema,
  ContextActionV1Schema,
  GraphQueryV1Schema,
  GraphEdgeV1Schema,
  GraphNodeV1Schema,
  GraphSnapshotV1Schema,
  ModelSettingsSchema,
  NormalizedEventSchema,
  NormalizedEventV1Schema,
  NormalizedEventV2Schema,
  PrivacyPolicyV1Schema,
  ProjectSyncPayloadV1Schema,
  SyncOperationV1Schema
} from "@continuum/contracts";
import { livePlatformSchemaSql, schemaSql } from "./schema.js";
import { defaultPrivacyPolicy } from "../privacy-policy.js";

type Row = Record<string, unknown>;

export interface CheckpointQueryOptions {
  cloudEligibleOnly?: boolean;
}

export type ProjectIdentityMatch =
  | {
      status: "unmatched";
      normalizedName: string;
      candidateProjectIds: [];
    }
  | {
      status: "resolved";
      normalizedName: string;
      projectId: string;
      matchedBy: "global_id" | "local_alias" | "repository_fingerprint";
      candidateProjectIds: [string];
    }
  | {
      status: "ambiguous";
      normalizedName: string;
      candidateProjectIds: string[];
    };

export interface ProjectIdentityResolution {
  status: "resolved" | "created" | "ambiguous";
  projectId: string;
  normalizedName: string;
  matchedBy: "global_id" | "local_alias" | "repository_fingerprint" | "new_project";
  candidateProjectIds: string[];
  conflictId?: string;
}

export interface ProjectIdentityConflict {
  version: "1";
  id: string;
  deviceId: string;
  localAlias: string;
  normalizedName: string;
  repositoryFingerprint: string;
  assignedProjectId: string;
  candidates: Array<{ projectId: string; label: string }>;
  status: "pending" | "confirmed";
  confirmedProjectId?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export type ProjectIdentityConfirmation =
  | { status: "confirmed"; conflict: ProjectIdentityConflict }
  | { status: "not_found" }
  | { status: "invalid_target"; candidateProjectIds: string[] }
  | { status: "stale_alias"; currentProjectId?: string };

const defaultSettings: ModelSettings = {
  activeCheckpointProvider: "ollama",
  activeChatProvider: "ollama",
  appleModel: "apple-system-default",
  ollamaModel: "gemma3n:e2b",
  openaiModel: "gpt-5.6-terra"
};

const unassignedProjectId = "00000000-0000-4000-8000-000000000000";

const allowedPrivacyAuditRules = new Set([
  "authorization_header",
  "chat_authorization_header",
  "chat_env_file",
  "chat_generic_secret_assignment",
  "chat_openai_api_key",
  "chat_private_key",
  "collector_rejection",
  "collector_secret",
  "confidential_collection_disabled",
  "domain_not_allowed",
  "empty_command",
  "empty_subject",
  "environment_assignment",
  "env_file",
  "generic_secret_assignment",
  "git_internal_path",
  "heredoc_command",
  "ignored_domain",
  "ignored_generated_path",
  "ignored_path",
  "invalid_schema",
  "irrelevant_event",
  "leading_space_private_command",
  "multiline_command",
  "native_secret_guard",
  "non_relative_path",
  "openai_api_key",
  "outside_workspace",
  "oversized_command",
  "personal_metadata_disabled",
  "private_command",
  "private_key",
  "runtime_demo_source_disabled",
  "secret_path",
  "secret_pattern",
  "secret_subject",
  "source_disabled_by_policy",
  "unsafe_executable_token"
]);

function privacyAuditRuleId(input: string): string {
  const normalized = input.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96);
  return allowedPrivacyAuditRules.has(normalized) ? normalized : "collector_rejection";
}

function parseHlc(value: string): { physical: bigint; logical: bigint; node: string } {
  const [physical, logical, ...node] = value.split(":");
  return { physical: BigInt(physical ?? 0), logical: BigInt(logical ?? 0), node: node.join(":") };
}

function compareHlc(left: string, right: string): number {
  const a = parseHlc(left);
  const b = parseHlc(right);
  if (a.physical !== b.physical) return a.physical > b.physical ? 1 : -1;
  if (a.logical !== b.logical) return a.logical > b.logical ? 1 : -1;
  return a.node.localeCompare(b.node);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const globalUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isGlobalUuid(value: unknown): value is string {
  return typeof value === "string" && globalUuidPattern.test(value);
}

function replaceHlcDevice(hlc: string, previous: string, replacement: string): string {
  const suffix = `:${previous}`;
  return hlc.endsWith(suffix) ? `${hlc.slice(0, -suffix.length)}:${replacement}` : hlc;
}

function replaceJsonDeviceIdentity(value: unknown, previous: string, replacement: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => replaceJsonDeviceIdentity(item, previous, replacement));
  }
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    if (key === "deviceId" && item === previous) output[key] = replacement;
    else if (key === "hlc" && typeof item === "string") output[key] = replaceHlcDevice(item, previous, replacement);
    else if (key === "entityId" && input.entityType === "device" && item === previous) output[key] = replacement;
    else output[key] = replaceJsonDeviceIdentity(item, previous, replacement);
  }
  return output;
}

// tsup removes the `node:` prefix from static built-in imports. That is safe for
// long-standing modules such as `crypto`, but `sqlite` only exists as
// `node:sqlite`. Resolve it through Node's loader so the production bundle keeps
// the canonical specifier.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export class ContinuumDatabase {
  readonly raw: DatabaseSyncType;
  private readonly readOnly: boolean;
  private vectorSerializer?: (input: number[]) => Uint8Array;
  private applyingSync = false;
  private readonly deviceIdentityPath: string;
  private resolvedDeviceIdentity?: string;
  private legacyDeviceIdentity?: string;
  private deviceIdentityNeedsPersistence = false;
  vectorAvailable = false;

  constructor(readonly path: string, options: { readOnly?: boolean; deviceIdentityPath?: string } = {}) {
    this.readOnly = options.readOnly ?? false;
    this.deviceIdentityPath = options.deviceIdentityPath ?? join(dirname(path), "device-id");
    const existedBeforeOpen = path !== ":memory:" && existsSync(path);
    this.raw = new DatabaseSync(path, { readOnly: this.readOnly, allowExtension: true });
    if (this.readOnly) {
      this.raw.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
    } else {
      this.raw.exec(schemaSql);
      this.ensureSettings();
      this.expireMigrationBackups();
      const current = this.currentMigrationVersion();
      if (existedBeforeOpen && current < 9) {
        this.purgeExpiredRawBeforeMigration();
        this.backupBeforeMigration(current);
      }
      if (current < 1) this.markMigration(1);
      if (current < 2) this.applyLivePlatformMigration();
      if (current < 3) this.applyLiveOnlyMigration();
      if (current < 4) this.applySyncClockMigration();
      if (current < 5) this.applyPrivacyAuditMigration();
      if (current < 6) this.applyProjectIdentityConflictMigration();
      if (current < 7) this.applyCheckpointDeviceProvenanceMigration();
      if (current < 8) this.applyProjectRedirectMigration();
      if (current < 9) this.applyDeviceIdentityMigration();
      else if (this.deviceIdentityNeedsPersistence) this.repairDeviceIdentity();
    }
  }

  private currentMigrationVersion(): number {
    const row = this.raw.prepare("SELECT coalesce(max(version), 0) AS version FROM schema_migrations").get() as Row;
    return Number(row.version ?? 0);
  }

  private markMigration(version: number): void {
    this.raw.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(version, new Date().toISOString());
  }

  private applyProjectRedirectMigration(): void {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      this.addColumn("projects", "redirect_to_project_id", "TEXT");
      this.markMigration(8);
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  private applyDeviceIdentityMigration(): void {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      this.repairDeviceIdentityRecords();
      this.markMigration(9);
      this.raw.exec("COMMIT");
      this.deviceIdentityNeedsPersistence = false;
      this.legacyDeviceIdentity = undefined;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  private repairDeviceIdentity(): void {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      this.repairDeviceIdentityRecords();
      this.raw.exec("COMMIT");
      this.deviceIdentityNeedsPersistence = false;
      this.legacyDeviceIdentity = undefined;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  private repairDeviceIdentityRecords(): void {
    const replacement = this.resolvedDeviceIdentity;
    if (!replacement || !isGlobalUuid(replacement)) throw new Error("Continuum could not establish a valid device UUID");
    const previous = this.legacyDeviceIdentity;
    if (previous && previous !== replacement) {
      this.raw.prepare("UPDATE events SET device_id = ?, hlc = CASE WHEN hlc IS NULL THEN NULL ELSE replace(hlc, ?, ?) END WHERE device_id = ?")
        .run(replacement, `:${previous}`, `:${replacement}`, previous);

      const checkpoints = this.raw.prepare("SELECT id, checkpoint_json FROM checkpoints WHERE device_id = ? OR checkpoint_json LIKE ?")
        .all(previous, `%\"deviceId\":\"${previous.replaceAll("%", "\\%").replaceAll("_", "\\_")}\"%`) as Row[];
      const updateCheckpoint = this.raw.prepare("UPDATE checkpoints SET checkpoint_json = ?, device_id = CASE WHEN device_id = ? THEN ? ELSE device_id END WHERE id = ?");
      for (const row of checkpoints) {
        const checkpoint = replaceJsonDeviceIdentity(JSON.parse(String(row.checkpoint_json)), previous, replacement);
        updateCheckpoint.run(JSON.stringify(checkpoint), previous, replacement, String(row.id));
      }

      this.raw.prepare("UPDATE project_aliases SET device_id = ? WHERE device_id = ?").run(replacement, previous);
      this.raw.prepare("UPDATE project_identity_conflicts SET device_id = ? WHERE device_id = ?").run(replacement, previous);
      this.raw.prepare("UPDATE active_project_leases SET device_id = ? WHERE device_id = ?").run(replacement, previous);

      const outboxRows = this.raw.prepare("SELECT id, hlc, entity_type, entity_id, operation_json FROM sync_outbox WHERE device_id = ?")
        .all(previous) as Row[];
      const updateOutbox = this.raw.prepare("UPDATE sync_outbox SET device_id = ?, hlc = ?, entity_id = ?, operation_json = ? WHERE id = ?");
      for (const row of outboxRows) {
        const entityId = String(row.entity_type) === "device" && String(row.entity_id) === previous
          ? replacement
          : String(row.entity_id);
        const operation = replaceJsonDeviceIdentity(JSON.parse(String(row.operation_json)), previous, replacement);
        updateOutbox.run(
          replacement,
          replaceHlcDevice(String(row.hlc), previous, replacement),
          entityId,
          JSON.stringify(operation),
          String(row.id)
        );
      }

      this.raw.prepare("UPDATE sync_inbox SET device_id = ?, hlc = replace(hlc, ?, ?) WHERE device_id = ?")
        .run(replacement, `:${previous}`, `:${replacement}`, previous);
      this.raw.prepare("UPDATE sync_entity_clock SET device_id = ? WHERE device_id = ?").run(replacement, previous);
      this.raw.prepare("UPDATE sync_entity_clock SET entity_id = ? WHERE entity_type = 'device' AND entity_id = ?")
        .run(replacement, previous);
      this.raw.prepare("UPDATE device_state SET id = ? WHERE id = ?").run(replacement, previous);

      const lastHlc = this.raw.prepare("SELECT value FROM settings WHERE key = 'lastHlc'").get() as Row | undefined;
      if (lastHlc) {
        this.raw.prepare("UPDATE settings SET value = ? WHERE key = 'lastHlc'")
          .run(replaceHlcDevice(String(lastHlc.value), previous, replacement));
      }
    }
    this.raw.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('deviceId', ?)")
      .run(JSON.stringify(replacement));
  }

  private applyCheckpointDeviceProvenanceMigration(): void {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const deviceId = this.deviceId();
      const rows = this.raw.prepare("SELECT id, checkpoint_json, device_id FROM checkpoints").all() as Row[];
      const update = this.raw.prepare("UPDATE checkpoints SET checkpoint_json = ?, device_id = ? WHERE id = ?");
      for (const row of rows) {
        const checkpoint = JSON.parse(String(row.checkpoint_json)) as Record<string, unknown>;
        const checkpointDeviceId = isGlobalUuid(checkpoint.deviceId)
          ? checkpoint.deviceId
          : isGlobalUuid(row.device_id)
            ? row.device_id
            : deviceId;
        checkpoint.deviceId = checkpointDeviceId;
        update.run(JSON.stringify(checkpoint), checkpointDeviceId, String(row.id));
      }
      this.markMigration(7);
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  private backupBeforeMigration(version: number): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${this.path}.backup-v${version}-${stamp}`;
    this.raw.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    this.scrubRawEventsFromBackup(backupPath);
    chmodSync(backupPath, 0o600);
    const expiry = setTimeout(() => {
      try { unlinkSync(backupPath); } catch { /* It may already have been removed on a later launch. */ }
    }, 24 * 60 * 60 * 1_000);
    expiry.unref();
  }

  private expireMigrationBackups(): void {
    if (this.path === ":memory:") return;
    const directory = dirname(this.path);
    const prefix = `${basename(this.path)}.backup-v`;
    const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
    try {
      for (const entry of readdirSync(directory)) {
        if (!entry.startsWith(prefix)) continue;
        const candidate = join(directory, entry);
        if (statSync(candidate).mtimeMs < cutoff) unlinkSync(candidate);
        else {
          this.scrubRawEventsFromBackup(candidate);
          chmodSync(candidate, 0o600);
        }
      }
    } catch {
      // A backup cleanup failure must not make the local source of truth unavailable.
    }
  }

  private scrubRawEventsFromBackup(backupPath: string): void {
    let backup: DatabaseSyncType | undefined;
    try {
      backup = new DatabaseSync(backupPath);
      const hasTable = (name: string): boolean => Boolean(
        backup!.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
      );
      if (hasTable("events")) backup.exec("DELETE FROM events");
      if (hasTable("sync_outbox")) backup.exec("DELETE FROM sync_outbox WHERE entity_type = 'event'");
      // Rewrite free pages so raw payload bytes are not recoverable from the
      // migration copy after their rows are removed.
      backup.exec("VACUUM");
    } finally {
      backup?.close();
    }
  }

  private purgeExpiredRawBeforeMigration(): void {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    if (this.raw.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'events'").get()) {
      this.raw.prepare("DELETE FROM events WHERE received_at < ?").run(cutoff);
    }
    if (this.raw.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sync_outbox'").get()) {
      this.raw.prepare("DELETE FROM sync_outbox WHERE entity_type = 'event' AND occurred_at < ?").run(cutoff);
    }
  }

  private addColumn(table: string, name: string, definition: string): void {
    const columns = this.raw.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!columns.some((column) => String(column.name) === name)) {
      this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }

  private applyLivePlatformMigration(): void {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      this.addColumn("windows", "cloud_eligible", "INTEGER NOT NULL DEFAULT 0");
      this.addColumn("privacy_audit", "count", "INTEGER NOT NULL DEFAULT 1");
      this.addColumn("privacy_audit", "policy_version", "INTEGER NOT NULL DEFAULT 1");
      this.addColumn("events", "device_id", "TEXT");
      this.addColumn("events", "policy_version", "INTEGER NOT NULL DEFAULT 1");
      this.addColumn("events", "sync_eligibility", "TEXT NOT NULL DEFAULT 'local_only'");
      this.addColumn("events", "hlc", "TEXT");
      this.addColumn("events", "project_locator_json", "TEXT");
      this.addColumn("graph_nodes", "stable_id", "TEXT");
      this.addColumn("checkpoints", "device_id", "TEXT");
      this.raw.exec(livePlatformSchemaSql);
      this.raw.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_nodes_stable ON graph_nodes(stable_id) WHERE stable_id IS NOT NULL");
      this.markMigration(2);
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  private applyLiveOnlyMigration(): void {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const demoCheckpointRows = this.raw.prepare(`
        SELECT DISTINCT c.rowid, c.id, c.window_id
        FROM checkpoints c
        LEFT JOIN events e ON e.window_id = c.window_id
        GROUP BY c.id
        HAVING c.project_id = 'continuum-demo'
          OR c.model = 'fixture-rules-v1'
          OR (count(e.id) > 0 AND sum(CASE WHEN e.source != 'demo' THEN 1 ELSE 0 END) = 0)
      `).all() as Row[];
      const deleteEdge = this.raw.prepare("DELETE FROM graph_edges WHERE checkpoint_id = ?");
      const deleteFts = this.raw.prepare("DELETE FROM checkpoint_fts WHERE rowid = ?");
      const deleteCheckpoint = this.raw.prepare("DELETE FROM checkpoints WHERE id = ?");
      for (const row of demoCheckpointRows) {
        deleteEdge.run(String(row.id));
        deleteFts.run(Number(row.rowid));
        deleteCheckpoint.run(String(row.id));
      }
      this.raw.exec("DELETE FROM windows WHERE id NOT IN (SELECT DISTINCT window_id FROM checkpoints) AND id NOT IN (SELECT DISTINCT window_id FROM events WHERE window_id IS NOT NULL AND source != 'demo')");
      this.raw.exec("DELETE FROM events WHERE source = 'demo'");
      this.raw.exec("DELETE FROM graph_nodes WHERE id NOT IN (SELECT from_node FROM graph_edges) AND id NOT IN (SELECT to_node FROM graph_edges)");
      this.raw.exec("DELETE FROM projects WHERE id != '00000000-0000-4000-8000-000000000000' AND id NOT IN (SELECT project_id FROM events) AND id NOT IN (SELECT project_id FROM checkpoints)");
      const legacyProjects = (this.raw.prepare("SELECT * FROM projects").all() as Row[])
        .filter((project) => !isGlobalUuid(project.id));
      const localDeviceId = this.deviceId();
      for (const project of legacyProjects) {
        const legacyId = String(project.id);
        if (legacyId === unassignedProjectId) continue;
        const globalId = randomUUID();
        const now = new Date().toISOString();
        this.raw.prepare("INSERT INTO projects(id, label, baseline_checkpoint_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .run(globalId, String(project.label), project.baseline_checkpoint_id ? String(project.baseline_checkpoint_id) : null, String(project.created_at), String(project.updated_at));
        this.raw.prepare("UPDATE events SET project_id = ? WHERE project_id = ?").run(globalId, legacyId);
        this.raw.prepare("UPDATE windows SET project_id = ? WHERE project_id = ?").run(globalId, legacyId);
        this.raw.prepare("UPDATE checkpoints SET project_id = ? WHERE project_id = ?").run(globalId, legacyId);
        this.raw.prepare("UPDATE checkpoint_fts SET project_id = ? WHERE project_id = ?").run(globalId, legacyId);
        this.raw.prepare("UPDATE graph_nodes SET project_id = ?, stable_id = NULL WHERE project_id = ?").run(globalId, legacyId);
        this.raw.prepare("UPDATE graph_edges SET project_id = ? WHERE project_id = ?").run(globalId, legacyId);
        const checkpointRows = this.raw.prepare("SELECT id, checkpoint_json FROM checkpoints WHERE project_id = ?").all(globalId) as Row[];
        for (const checkpointRow of checkpointRows) {
          const checkpoint = JSON.parse(String(checkpointRow.checkpoint_json)) as Record<string, unknown>;
          checkpoint.projectId = globalId;
          this.raw.prepare("UPDATE checkpoints SET checkpoint_json = ? WHERE id = ?")
            .run(JSON.stringify(checkpoint), String(checkpointRow.id));
        }
        this.raw.prepare(`
          INSERT INTO project_aliases(id, project_id, device_id, local_path_hash, display_name, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), globalId, localDeviceId, legacyId, String(project.label), now, now);
        this.raw.prepare("DELETE FROM projects WHERE id = ?").run(legacyId);
      }
      const graphRows = this.raw.prepare("SELECT id, project_id, kind, key FROM graph_nodes WHERE stable_id IS NULL").all() as Row[];
      for (const node of graphRows) {
        const stableId = `node:${String(node.project_id)}:${String(node.kind)}:${Buffer.from(String(node.key)).toString("base64url")}`;
        this.raw.prepare("UPDATE graph_nodes SET stable_id = ? WHERE id = ?").run(stableId, Number(node.id));
      }
      this.markMigration(3);
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  private applySyncClockMigration(): void {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      this.addColumn("chat_sessions", "classification", "TEXT NOT NULL DEFAULT 'personal'");
      this.addColumn("graph_edges", "stable_id", "TEXT");
      this.raw.exec(`
        CREATE TABLE IF NOT EXISTS sync_entity_clock (
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          hlc TEXT NOT NULL,
          device_id TEXT NOT NULL,
          PRIMARY KEY(entity_type, entity_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_stable ON graph_edges(stable_id) WHERE stable_id IS NOT NULL;
      `);
      const edges = this.raw.prepare(`
        SELECT ge.id, ge.relation, ge.checkpoint_id, source.stable_id AS source_id, target.stable_id AS target_id
        FROM graph_edges ge
        JOIN graph_nodes source ON source.id = ge.from_node
        JOIN graph_nodes target ON target.id = ge.to_node
        WHERE ge.stable_id IS NULL
      `).all() as Row[];
      for (const edge of edges) {
        const digest = createHash("sha256")
          .update(`${String(edge.source_id)}\0${String(edge.relation)}\0${String(edge.target_id)}\0${String(edge.checkpoint_id)}`)
          .digest("base64url");
        const stableId = `edge:${digest}`;
        this.raw.prepare("UPDATE graph_edges SET stable_id = ? WHERE id = ?").run(stableId, Number(edge.id));
      }
      this.markMigration(4);
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  private applyPrivacyAuditMigration(): void {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const columns = this.raw.prepare("PRAGMA table_info(privacy_audit)").all() as Row[];
      if (columns.some((column) => String(column.name) === "event_id")) {
        this.raw.exec(`
          DROP TABLE IF EXISTS privacy_audit_dedupe;
          CREATE TABLE privacy_audit_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            occurred_at TEXT NOT NULL,
            source TEXT NOT NULL,
            rule TEXT NOT NULL,
            action TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 1
          );
          INSERT INTO privacy_audit_v2(id, occurred_at, source, rule, action, count)
            SELECT id, occurred_at, source, rule, action, count FROM privacy_audit;
          DROP INDEX IF EXISTS idx_privacy_audit_event;
          DROP TABLE privacy_audit;
          ALTER TABLE privacy_audit_v2 RENAME TO privacy_audit;
        `);
      }
      this.raw.exec(`
        CREATE TABLE IF NOT EXISTS privacy_audit_dedupe (
          dedupe_hash TEXT PRIMARY KEY,
          audit_id INTEGER NOT NULL,
          FOREIGN KEY(audit_id) REFERENCES privacy_audit(id) ON DELETE CASCADE
        );
      `);
      this.markMigration(5);
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  private applyProjectIdentityConflictMigration(): void {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      this.raw.exec(`
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
      `);
      this.markMigration(6);
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  async initializeVector(): Promise<boolean> {
    try {
      const sqliteVec = await import("sqlite-vec");
      sqliteVec.load(this.raw);
      if (!this.readOnly) {
        this.raw.exec("CREATE VIRTUAL TABLE IF NOT EXISTS checkpoint_vec USING vec0(embedding float[384]);");
        this.raw.exec("DELETE FROM checkpoint_vec WHERE rowid NOT IN (SELECT rowid FROM checkpoints)");
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
    const deviceId = this.resolveSharedDeviceId();
    statement.run("deviceId", JSON.stringify(deviceId));
    statement.run("syncSequence", "0");
    statement.run("providerAutoSelect", "true");
  }

  private resolveSharedDeviceId(): string {
    const persisted = this.raw.prepare("SELECT value FROM settings WHERE key = 'deviceId'").get() as Row | undefined;
    let existing: string | undefined;
    try { existing = persisted ? String(JSON.parse(String(persisted.value))) : undefined; } catch { existing = undefined; }
    let fromFile: string | undefined;
    try { fromFile = readFileSync(this.deviceIdentityPath, "utf8").trim(); } catch { fromFile = undefined; }
    const override = process.env.CONTINUUM_DEVICE_ID?.trim();
    if (override && !isGlobalUuid(override)) throw new Error("CONTINUUM_DEVICE_ID must be a UUID");
    let selected = isGlobalUuid(existing) ? existing : override ?? (isGlobalUuid(fromFile) ? fromFile : randomUUID());
    this.resolvedDeviceIdentity = selected;
    this.deviceIdentityNeedsPersistence = !isGlobalUuid(existing);
    if (typeof existing === "string" && existing.length > 0 && !isGlobalUuid(existing)) this.legacyDeviceIdentity = existing;
    try {
      mkdirSync(dirname(this.deviceIdentityPath), { recursive: true, mode: 0o700 });
      if (!existsSync(this.deviceIdentityPath)) {
        try {
          const descriptor = openSync(this.deviceIdentityPath, "wx", 0o600);
          writeFileSync(descriptor, `${selected}\n`, "utf8");
          closeSync(descriptor);
        } catch (error) {
          const raced = readFileSync(this.deviceIdentityPath, "utf8").trim();
          if (!isGlobalUuid(existing) && !override && isGlobalUuid(raced)) {
            selected = raced;
            this.resolvedDeviceIdentity = selected;
          }
          else throw error;
        }
      } else if (fromFile !== selected) {
        writeFileSync(this.deviceIdentityPath, `${selected}\n`, { encoding: "utf8", mode: 0o600 });
      }
      chmodSync(this.deviceIdentityPath, 0o600);
    } catch {
      // The daemon remains usable if a legacy installation cannot yet write
      // the shared collector identity file; health/onboarding can surface it.
    }
    return selected;
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
    const rows = this.raw.prepare("SELECT key, value FROM settings WHERE key IN ('activeCheckpointProvider','activeChatProvider','appleModel','ollamaModel','openaiModel')").all() as Row[];
    const values = Object.fromEntries(rows.map((row) => [String(row.key), JSON.parse(String(row.value))]));
    return ModelSettingsSchema.parse({ ...defaultSettings, ...values });
  }

  shouldAutoSelectProvider(): boolean {
    const row = this.raw.prepare("SELECT value FROM settings WHERE key = 'providerAutoSelect'").get() as Row | undefined;
    return row?.value === "true";
  }

  deviceId(): string {
    if (this.resolvedDeviceIdentity) return this.resolvedDeviceIdentity;
    const row = this.raw.prepare("SELECT value FROM settings WHERE key = 'deviceId'").get() as Row | undefined;
    if (!row) throw new Error("Continuum device identity is unavailable");
    const value = String(JSON.parse(String(row.value)));
    if (!isGlobalUuid(value)) throw new Error("Continuum device identity is not a UUID; launch the writable daemon to repair it");
    return value;
  }

  syncEndpoint(): string | undefined {
    const row = this.raw.prepare("SELECT value FROM settings WHERE key = 'syncEndpoint'").get() as Row | undefined;
    if (!row) return undefined;
    try {
      const value = JSON.parse(String(row.value));
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  setSyncEndpoint(endpoint: string | undefined): void {
    if (endpoint) {
      this.raw.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('syncEndpoint', ?)")
        .run(JSON.stringify(endpoint));
    } else {
      this.raw.prepare("DELETE FROM settings WHERE key = 'syncEndpoint'").run();
    }
    this.bumpRevision();
  }

  setModelSettings(settings: Partial<ModelSettings>, options: { automatic?: boolean } = {}): ModelSettings {
    const parsed = ModelSettingsSchema.parse({ ...this.getModelSettings(), ...settings });
    const statement = this.raw.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(parsed)) statement.run(key, JSON.stringify(value));
    if (!options.automatic) statement.run("providerAutoSelect", "false");
    this.bumpRevision();
    if (!this.applyingSync) this.enqueueSyncOperation({ entityType: "settings", entityId: "models", payload: parsed, tombstone: false });
    return parsed;
  }

  ensureProject(projectId: string, label = projectId): void {
    const now = new Date().toISOString();
    this.raw.prepare(`
      INSERT INTO projects(id, label, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(projectId, label.slice(0, 256), now, now);
  }

  canonicalProjectId(projectId: string): string {
    let current = projectId;
    const visited = new Set<string>();
    for (let depth = 0; depth < 64; depth += 1) {
      if (visited.has(current)) throw new Error(`Cyclic project redirect detected for ${projectId}`);
      visited.add(current);
      const row = this.raw.prepare("SELECT redirect_to_project_id FROM projects WHERE id = ?").get(current) as Row | undefined;
      if (!row?.redirect_to_project_id) return current;
      current = String(row.redirect_to_project_id);
    }
    throw new Error(`Project redirect chain is too deep for ${projectId}`);
  }

  private projectScope(projectId: string): { canonicalId: string; projectIds: string[] } {
    const canonicalId = this.canonicalProjectId(projectId);
    const rows = this.raw.prepare("SELECT id FROM projects").all() as Row[];
    const projectIds = rows
      .map((row) => String(row.id))
      .filter((candidate) => this.canonicalProjectId(candidate) === canonicalId);
    if (!projectIds.includes(canonicalId)) projectIds.push(canonicalId);
    return { canonicalId, projectIds };
  }

  private setProjectRedirect(redirectFrom: string, redirectTo: string, now = new Date().toISOString()): string {
    if (redirectFrom === redirectTo) throw new Error("Project redirect cannot target itself");
    this.ensureProject(redirectFrom);
    this.ensureProject(redirectTo);
    const canonicalTarget = this.canonicalProjectId(redirectTo);
    if (canonicalTarget === redirectFrom) throw new Error("Project redirect would create a cycle");
    this.raw.prepare("UPDATE projects SET redirect_to_project_id = ?, updated_at = ? WHERE id = ?")
      .run(canonicalTarget, now, redirectFrom);
    return canonicalTarget;
  }

  private canonicalCheckpoint(checkpoint: CheckpointV1): CheckpointV1 {
    const projectId = this.canonicalProjectId(checkpoint.projectId);
    return projectId === checkpoint.projectId ? checkpoint : CheckpointV1Schema.parse({ ...checkpoint, projectId });
  }

  projectLabel(projectId: string): string {
    const canonicalId = this.canonicalProjectId(projectId);
    const row = this.raw.prepare("SELECT label FROM projects WHERE id = ?").get(canonicalId) as Row | undefined;
    return row ? String(row.label) : canonicalId;
  }

  inspectProjectIdentityMatch(
    candidate: string,
    label = candidate,
    repositoryFingerprint?: string,
    deviceId = this.deviceId()
  ): ProjectIdentityMatch {
    const normalizedName = label
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .replace(/\.git$/i, "")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/[-_.]{2,}/g, "-")
      .replace(/^[-_.]+|[-_.]+$/g, "")
      .slice(0, 80) || "project";
    if (isGlobalUuid(candidate)) {
      const projectId = this.canonicalProjectId(candidate);
      return {
        status: "resolved", normalizedName, projectId,
        matchedBy: "global_id", candidateProjectIds: [projectId]
      };
    }
    const existing = this.raw.prepare("SELECT project_id FROM project_aliases WHERE device_id = ? AND local_path_hash = ?")
      .get(deviceId, candidate) as Row | undefined;
    if (existing) {
      const projectId = this.canonicalProjectId(String(existing.project_id));
      return {
        status: "resolved", normalizedName, projectId,
        matchedBy: "local_alias", candidateProjectIds: [projectId]
      };
    }
    if (repositoryFingerprint) {
      const matches = this.raw.prepare("SELECT DISTINCT project_id, display_name FROM project_aliases WHERE repository_fingerprint = ?")
        .all(repositoryFingerprint) as Row[];
      const normalizedMatches = matches.filter((row) => {
        const storedName = String(row.display_name)
          .normalize("NFKC")
          .toLocaleLowerCase("en-US")
          .replace(/\.git$/i, "")
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/[-_.]{2,}/g, "-")
          .replace(/^[-_.]+|[-_.]+$/g, "")
          .slice(0, 80) || "project";
        return storedName === normalizedName;
      });
      const candidateProjectIds = [...new Set(normalizedMatches.map((row) => this.canonicalProjectId(String(row.project_id))))].sort();
      if (candidateProjectIds.length === 1) {
        return {
          status: "resolved", normalizedName, projectId: candidateProjectIds[0]!,
          matchedBy: "repository_fingerprint", candidateProjectIds: [candidateProjectIds[0]!]
        };
      }
      if (candidateProjectIds.length > 1) {
        return { status: "ambiguous", normalizedName, candidateProjectIds };
      }
    }
    return { status: "unmatched", normalizedName, candidateProjectIds: [] };
  }

  resolveProjectIdentity(
    candidate: string,
    label = candidate,
    repositoryFingerprint?: string,
    deviceId = this.deviceId()
  ): ProjectIdentityResolution {
    const match = this.inspectProjectIdentityMatch(candidate, label, repositoryFingerprint, deviceId);
    const projectId = match.status === "resolved" ? match.projectId : randomUUID();
    const now = new Date().toISOString();
    let conflictId: string | undefined;
    let aliasInserted = false;
    this.raw.exec("SAVEPOINT continuum_project_identity");
    try {
      this.ensureProject(projectId, match.normalizedName);
      if (repositoryFingerprint || match.status !== "resolved" || match.matchedBy !== "global_id") {
        const alias = this.raw.prepare(`
          INSERT OR IGNORE INTO project_aliases(id, project_id, device_id, local_path_hash, display_name, repository_fingerprint, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), projectId, deviceId, candidate, match.normalizedName, repositoryFingerprint ?? null, now, now);
        aliasInserted = Number(alias.changes) > 0;
      }
      if (match.status === "ambiguous" && repositoryFingerprint) {
        const existing = this.raw.prepare(`
          SELECT id FROM project_identity_conflicts WHERE device_id = ? AND local_path_hash = ?
        `).get(deviceId, candidate) as Row | undefined;
        conflictId = existing ? String(existing.id) : randomUUID();
        this.raw.prepare(`
          INSERT INTO project_identity_conflicts(
            id, device_id, local_path_hash, normalized_name, repository_fingerprint,
            provisional_project_id, candidate_project_ids_json, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          ON CONFLICT(device_id, local_path_hash) DO UPDATE SET
            normalized_name = excluded.normalized_name,
            repository_fingerprint = excluded.repository_fingerprint,
            provisional_project_id = excluded.provisional_project_id,
            candidate_project_ids_json = excluded.candidate_project_ids_json,
            updated_at = excluded.updated_at
          WHERE project_identity_conflicts.status = 'pending'
        `).run(
          conflictId,
          deviceId,
          candidate,
          match.normalizedName,
          repositoryFingerprint,
          projectId,
          JSON.stringify(match.candidateProjectIds),
          now,
          now
        );
      }
      this.raw.exec("RELEASE SAVEPOINT continuum_project_identity");
    } catch (error) {
      this.raw.exec("ROLLBACK TO SAVEPOINT continuum_project_identity");
      this.raw.exec("RELEASE SAVEPOINT continuum_project_identity");
      throw error;
    }
    if (aliasInserted && repositoryFingerprint && match.status !== "ambiguous" && !this.applyingSync) {
      this.enqueueSyncOperation({
        entityType: "project",
        entityId: projectId,
        payload: {
          id: projectId,
          label: match.normalizedName,
          normalizedName: match.normalizedName,
          repositoryFingerprint
        },
        tombstone: false
      });
    }
    return {
      status: match.status === "resolved" ? "resolved" : match.status === "ambiguous" ? "ambiguous" : "created",
      projectId,
      normalizedName: match.normalizedName,
      matchedBy: match.status === "resolved" ? match.matchedBy : "new_project",
      candidateProjectIds: match.candidateProjectIds,
      ...(conflictId ? { conflictId } : {})
    };
  }

  private projectIdentityConflictFromRow(row: Row): ProjectIdentityConflict {
    const candidateProjectIds = JSON.parse(String(row.candidate_project_ids_json)) as string[];
    const label = this.raw.prepare("SELECT label FROM projects WHERE id = ?");
    return {
      version: "1",
      id: String(row.id),
      deviceId: String(row.device_id),
      localAlias: String(row.local_path_hash),
      normalizedName: String(row.normalized_name),
      repositoryFingerprint: String(row.repository_fingerprint),
      assignedProjectId: String(row.provisional_project_id),
      candidates: candidateProjectIds.map((projectId) => {
        const project = label.get(projectId) as Row | undefined;
        return { projectId, label: project ? String(project.label) : projectId };
      }),
      status: String(row.status) as "pending" | "confirmed",
      ...(row.confirmed_project_id ? { confirmedProjectId: String(row.confirmed_project_id) } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.resolved_at ? { resolvedAt: String(row.resolved_at) } : {})
    };
  }

  listProjectIdentityConflicts(status: "pending" | "confirmed" | "all" = "pending"): ProjectIdentityConflict[] {
    const rows = status === "all"
      ? this.raw.prepare("SELECT * FROM project_identity_conflicts ORDER BY updated_at DESC, id").all() as Row[]
      : this.raw.prepare("SELECT * FROM project_identity_conflicts WHERE status = ? ORDER BY updated_at DESC, id").all(status) as Row[];
    return rows.map((row) => this.projectIdentityConflictFromRow(row));
  }

  confirmProjectIdentityConflict(conflictId: string, targetProjectId: string): ProjectIdentityConfirmation {
    this.raw.exec("SAVEPOINT continuum_confirm_project_identity");
    let transactionOpen = true;
    const release = (): void => {
      this.raw.exec("RELEASE SAVEPOINT continuum_confirm_project_identity");
      transactionOpen = false;
    };
    try {
      const row = this.raw.prepare("SELECT * FROM project_identity_conflicts WHERE id = ?").get(conflictId) as Row | undefined;
      if (!row) {
        release();
        return { status: "not_found" };
      }
      const candidateProjectIds = JSON.parse(String(row.candidate_project_ids_json)) as string[];
      if (!candidateProjectIds.includes(targetProjectId)) {
        release();
        return { status: "invalid_target", candidateProjectIds };
      }
      targetProjectId = this.canonicalProjectId(targetProjectId);
      if (String(row.status) === "confirmed") {
        const conflict = this.projectIdentityConflictFromRow(row);
        release();
        if (String(row.confirmed_project_id) !== targetProjectId) return { status: "invalid_target", candidateProjectIds };
        return { status: "confirmed", conflict };
      }
      const alias = this.raw.prepare(`
        SELECT project_id FROM project_aliases WHERE device_id = ? AND local_path_hash = ?
      `).get(String(row.device_id), String(row.local_path_hash)) as Row | undefined;
      const currentProjectId = alias ? String(alias.project_id) : undefined;
      if (currentProjectId !== String(row.provisional_project_id) && currentProjectId !== targetProjectId) {
        release();
        return { status: "stale_alias", ...(currentProjectId ? { currentProjectId } : {}) };
      }
      const target = this.raw.prepare("SELECT 1 AS present FROM projects WHERE id = ?").get(targetProjectId) as Row | undefined;
      if (!target) {
        release();
        return { status: "invalid_target", candidateProjectIds };
      }
      const now = new Date().toISOString();
      if (currentProjectId !== targetProjectId) {
        const provisionalProjectId = String(row.provisional_project_id);
        this.setProjectRedirect(provisionalProjectId, targetProjectId, now);
        this.raw.prepare("UPDATE project_aliases SET project_id = ?, updated_at = ? WHERE device_id = ? AND local_path_hash = ?")
          .run(targetProjectId, now, String(row.device_id), String(row.local_path_hash));
        this.raw.prepare("UPDATE active_project_leases SET project_id = ?, project_name = ? WHERE project_id = ?")
          .run(targetProjectId, this.projectLabel(targetProjectId), provisionalProjectId);
      }
      this.raw.prepare(`
        UPDATE project_identity_conflicts
        SET status = 'confirmed', confirmed_project_id = ?, updated_at = ?, resolved_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(targetProjectId, now, now, conflictId);
      const confirmed = this.raw.prepare("SELECT * FROM project_identity_conflicts WHERE id = ?").get(conflictId) as Row;
      const conflict = this.projectIdentityConflictFromRow(confirmed);
      release();
      this.bumpRevision();
      if (!this.applyingSync) {
        const provisionalProjectId = String(row.provisional_project_id);
        const payload: ProjectSyncPayloadV1 = ProjectSyncPayloadV1Schema.parse({
          id: provisionalProjectId,
          label: String(row.normalized_name),
          normalizedName: String(row.normalized_name),
          repositoryFingerprint: String(row.repository_fingerprint),
          redirectFrom: provisionalProjectId,
          redirectTo: targetProjectId
        });
        this.enqueueSyncOperation({
          entityType: "project",
          entityId: provisionalProjectId,
          payload,
          tombstone: false
        });
      }
      return { status: "confirmed", conflict };
    } catch (error) {
      if (transactionOpen) {
        this.raw.exec("ROLLBACK TO SAVEPOINT continuum_confirm_project_identity");
        this.raw.exec("RELEASE SAVEPOINT continuum_confirm_project_identity");
      }
      throw error;
    }
  }

  resolveProjectId(candidate: string, label = candidate, repositoryFingerprint?: string, deviceId = this.deviceId()): string {
    return this.resolveProjectIdentity(candidate, label, repositoryFingerprint, deviceId).projectId;
  }

  insertEvent(event: NormalizedEvent): boolean {
    const projectId = event.projectId ?? unassignedProjectId;
    this.ensureProject(projectId, event.projectId ? projectId : "Unassigned activity");
    const deviceId = event.version === "2" ? event.deviceId : this.deviceId();
    const policyVersion = event.version === "2" ? event.policyVersion : 1;
    const syncEligibility = event.version === "2" ? event.syncEligibility : "local_only";
    const hlc = event.version === "2" ? event.hlc : null;
    const locator = event.version === "2" ? event.projectLocator : undefined;
    const result = this.raw.prepare(`
      INSERT OR IGNORE INTO events(
        id, occurred_at, received_at, source, event_type, project_id, session_id,
        title, attributes_json, privacy, relevance, confidence, dedupe_key,
        device_id, policy_version, sync_eligibility, hlc, project_locator_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.occurredAt,
      new Date().toISOString(),
      event.source,
      event.eventType,
      projectId,
      event.sessionId ?? null,
      event.title,
      JSON.stringify(event.attributes),
      event.privacy.classification,
      event.relevance.decision,
      event.confidence,
      event.dedupeKey ?? null,
      deviceId,
      policyVersion,
      syncEligibility,
      hlc,
      locator ? JSON.stringify(locator) : null
    );
    if (Number(result.changes) > 0) this.bumpRevision();
    if (Number(result.changes) > 0 && !this.applyingSync && event.version === "2" && event.syncEligibility === "cloud_eligible") {
      this.enqueueSyncOperation({ entityType: "event", entityId: event.id, payload: { ...event, projectId }, tombstone: false });
    }
    return Number(result.changes) > 0;
  }

  auditPrivacy(source: string, rule: string, action: "drop" | "redact", count = 1, eventId?: string): boolean {
    const boundedCount = Math.min(10_000, Math.max(1, Math.trunc(count)));
    const ruleId = privacyAuditRuleId(rule);
    const dedupeHash = eventId ? createHash("sha256").update(eventId).digest("hex") : undefined;
    if (dedupeHash && this.raw.prepare("SELECT 1 AS present FROM privacy_audit_dedupe WHERE dedupe_hash = ?").get(dedupeHash)) return false;
    this.raw.exec("SAVEPOINT continuum_privacy_audit");
    try {
      const result = this.raw.prepare("INSERT INTO privacy_audit(occurred_at, source, rule, action, count) VALUES (?, ?, ?, ?, ?)")
        .run(new Date().toISOString(), source.slice(0, 32), ruleId, action, boundedCount);
      if (dedupeHash) {
        this.raw.prepare("INSERT INTO privacy_audit_dedupe(dedupe_hash, audit_id) VALUES (?, ?)")
          .run(dedupeHash, result.lastInsertRowid);
      }
      this.raw.exec("RELEASE SAVEPOINT continuum_privacy_audit");
      this.bumpRevision();
      return true;
    } catch (error) {
      this.raw.exec("ROLLBACK TO SAVEPOINT continuum_privacy_audit");
      this.raw.exec("RELEASE SAVEPOINT continuum_privacy_audit");
      throw error;
    }
  }

  purgeExpiredEvents(hours = 24): number {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const staleOutbox = this.raw.prepare(`
      SELECT sync_outbox.id, sync_outbox.operation_json FROM sync_outbox
      WHERE sync_outbox.entity_type = 'event'
        AND sync_outbox.acknowledged_at IS NULL
        AND (
          sync_outbox.occurred_at < ?
          OR EXISTS (
            SELECT 1 FROM events
            WHERE events.id = sync_outbox.entity_id
              AND events.received_at < ?
          )
        )
    `).all(cutoff, cutoff) as Row[];
    const rewrite = this.raw.prepare("UPDATE sync_outbox SET operation_json = ?, tombstone = 1 WHERE id = ? AND acknowledged_at IS NULL");
    for (const row of staleOutbox) {
      if (!row.operation_json) continue;
      const operation = SyncOperationV1Schema.parse(JSON.parse(String(row.operation_json)));
      const tombstone = SyncOperationV1Schema.parse({
        version: "1",
        id: operation.id,
        deviceId: operation.deviceId,
        sequence: operation.sequence,
        hlc: operation.hlc,
        entityType: "event",
        entityId: operation.entityId,
        tombstone: true,
        occurredAt: operation.occurredAt
      });
      rewrite.run(JSON.stringify(tombstone), String(row.id));
    }
    this.raw.prepare(`
      DELETE FROM sync_outbox
      WHERE entity_type = 'event'
        AND acknowledged_at IS NOT NULL
        AND (
          occurred_at < ?
          OR EXISTS (
            SELECT 1 FROM events
            WHERE events.id = sync_outbox.entity_id
              AND events.received_at < ?
          )
        )
    `).run(cutoff, cutoff);
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
    const rows = this.raw.prepare("SELECT DISTINCT project_id FROM events WHERE window_id IS NULL AND project_id != ? ORDER BY project_id")
      .all(unassignedProjectId) as Row[];
    return [...new Set(rows.map((row) => this.canonicalProjectId(String(row.project_id))))];
  }

  pendingEvents(projectId: string, limit = 15): NormalizedEvent[] {
    const scope = this.projectScope(projectId);
    const placeholders = scope.projectIds.map(() => "?").join(",");
    const rows = this.raw.prepare(`
      SELECT * FROM events WHERE project_id IN (${placeholders}) AND window_id IS NULL
      ORDER BY occurred_at ASC LIMIT ?
    `).all(...scope.projectIds, limit) as Row[];
    return rows.map((row) => row.hlc && row.device_id
      ? NormalizedEventV2Schema.parse({
          version: "2",
          id: String(row.id),
          deviceId: String(row.device_id),
          occurredAt: String(row.occurred_at),
          hlc: String(row.hlc),
          source: String(row.source),
          eventType: String(row.event_type),
          projectId: scope.canonicalId,
          ...(row.project_locator_json ? { projectLocator: JSON.parse(String(row.project_locator_json)) } : {}),
          ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
          title: String(row.title),
          attributes: JSON.parse(String(row.attributes_json)),
          privacy: { classification: String(row.privacy), rules: ["persisted_sanitized"] },
          relevance: { decision: String(row.relevance), reason: "persisted" },
          confidence: Number(row.confidence),
          ...(row.dedupe_key ? { dedupeKey: String(row.dedupe_key) } : {}),
          policyVersion: Number(row.policy_version ?? 1),
          syncEligibility: String(row.sync_eligibility ?? "local_only")
        })
      : NormalizedEventV1Schema.parse({
          version: "1",
          id: String(row.id),
          occurredAt: String(row.occurred_at),
          source: String(row.source),
          eventType: String(row.event_type),
          projectId: scope.canonicalId,
          ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
          title: String(row.title),
          attributes: JSON.parse(String(row.attributes_json)),
          privacy: { classification: String(row.privacy), rules: ["persisted_sanitized"] },
          relevance: { decision: String(row.relevance), reason: "persisted" },
          confidence: Number(row.confidence),
          ...(row.dedupe_key ? { dedupeKey: String(row.dedupe_key) } : {})
        }));
  }

  createWindow(projectId: string, events: NormalizedEvent[], provider: string, model: string, cloudSafe: boolean): string {
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
    const input = CheckpointV1Schema.parse(checkpoint);
    const parsed = CheckpointV1Schema.parse({ ...input, deviceId: input.deviceId ?? this.deviceId() });
    this.raw.exec("SAVEPOINT continuum_insert_checkpoint");
    try {
      const result = this.raw.prepare(`
        INSERT INTO checkpoints(id, project_id, window_id, goal, focus, summary, importance, provider, model, checkpoint_json, created_at, device_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        parsed.createdAt,
        parsed.deviceId!
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
      const cloudRow = this.raw.prepare("SELECT cloud_eligible FROM windows WHERE id = ?").get(parsed.windowId) as Row | undefined;
      if (!this.applyingSync && Number(cloudRow?.cloud_eligible ?? 0) === 1) {
        this.enqueueSyncOperation({ entityType: "checkpoint", entityId: parsed.id, payload: parsed, tombstone: false });
        this.enqueueGraphForCheckpoint(parsed);
      }
      this.raw.exec("RELEASE SAVEPOINT continuum_insert_checkpoint");
    } catch (error) {
      this.raw.exec("ROLLBACK TO SAVEPOINT continuum_insert_checkpoint");
      this.raw.exec("RELEASE SAVEPOINT continuum_insert_checkpoint");
      throw error;
    }
  }

  private upsertNode(projectId: string, kind: string, key: string, label: string): number {
    const stableId = `node:${projectId}:${kind}:${Buffer.from(key).toString("base64url")}`;
    this.raw.prepare(`
      INSERT INTO graph_nodes(project_id, kind, key, label, stable_id) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, kind, key) DO UPDATE SET label = excluded.label, stable_id = excluded.stable_id
    `).run(projectId, kind, key, label, stableId);
    const row = this.raw.prepare("SELECT id FROM graph_nodes WHERE project_id = ? AND kind = ? AND key = ?").get(projectId, kind, key) as Row;
    return Number(row.id);
  }

  private upsertGraphEdge(projectId: string, fromNode: number, toNode: number, relation: string, checkpointId: string): void {
    const nodes = this.raw.prepare("SELECT id, stable_id FROM graph_nodes WHERE id IN (?, ?)").all(fromNode, toNode) as Row[];
    const source = nodes.find((node) => Number(node.id) === fromNode)?.stable_id;
    const target = nodes.find((node) => Number(node.id) === toNode)?.stable_id;
    if (!source || !target) throw new Error("Graph edge endpoints require stable identifiers");
    const digest = createHash("sha256").update(`${source}\0${relation}\0${target}\0${checkpointId}`).digest("base64url");
    const stableId = `edge:${digest}`;
    this.raw.prepare(`
      INSERT INTO graph_edges(project_id, from_node, to_node, relation, checkpoint_id, stable_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(from_node, to_node, relation, checkpoint_id) DO UPDATE SET stable_id = excluded.stable_id
    `).run(projectId, fromNode, toNode, relation, checkpointId, stableId);
  }

  private insertGraph(checkpoint: CheckpointV1): void {
    const projectNode = this.upsertNode(checkpoint.projectId, "project", checkpoint.projectId, checkpoint.projectId);
    const checkpointNode = this.upsertNode(checkpoint.projectId, "checkpoint", checkpoint.id, checkpoint.summary);
    this.upsertGraphEdge(checkpoint.projectId, projectNode, checkpointNode, "HAS_CHECKPOINT", checkpoint.id);

    for (const entity of checkpoint.entities) {
      const node = this.upsertNode(checkpoint.projectId, entity.kind, entity.key, entity.label);
      const relation = entity.kind === "file" ? "TOUCHES" : entity.kind === "blocker" ? "BLOCKED_BY" : entity.kind === "decision" ? "DECIDES" : "MENTIONS";
      this.upsertGraphEdge(checkpoint.projectId, checkpointNode, node, relation, checkpoint.id);
    }
    for (const blocker of checkpoint.blockers) {
      const key = blocker.text.toLowerCase().slice(0, 512);
      const node = this.upsertNode(checkpoint.projectId, "blocker", key, blocker.text);
      this.upsertGraphEdge(checkpoint.projectId, checkpointNode, node, blocker.status === "resolved" ? "RESOLVES" : "BLOCKED_BY", checkpoint.id);
    }
    for (const decision of checkpoint.decisions) {
      const key = decision.text.toLowerCase().slice(0, 512);
      const node = this.upsertNode(checkpoint.projectId, "decision", key, decision.text);
      this.upsertGraphEdge(checkpoint.projectId, checkpointNode, node, "DECIDES", checkpoint.id);
    }
    for (const hypothesis of checkpoint.hypotheses) {
      const key = hypothesis.text.toLowerCase().slice(0, 512);
      const node = this.upsertNode(checkpoint.projectId, "concept", key, hypothesis.text);
      this.upsertGraphEdge(checkpoint.projectId, checkpointNode, node, `HYPOTHESIS_${hypothesis.status.toUpperCase()}`, checkpoint.id);
    }
  }

  private enqueueGraphForCheckpoint(checkpoint: CheckpointV1): void {
    const nodes = this.raw.prepare(`
      SELECT DISTINCT n.stable_id, n.kind, n.key, n.label
      FROM graph_nodes n
      JOIN graph_edges e ON e.from_node = n.id OR e.to_node = n.id
      WHERE e.checkpoint_id = ? AND n.stable_id IS NOT NULL
    `).all(checkpoint.id) as Row[];
    for (const row of nodes) {
      const node: GraphNodeV1 = GraphNodeV1Schema.parse({
        id: String(row.stable_id),
        kind: String(row.kind),
        label: String(row.label),
        projectId: checkpoint.projectId,
        checkpointIds: [checkpoint.id],
        metadata: { key: String(row.key) }
      });
      this.enqueueSyncOperation({ entityType: "graph_node", entityId: node.id, payload: node, tombstone: false });
    }
    const edges = this.raw.prepare(`
      SELECT e.stable_id, e.relation, source.stable_id AS source_id, target.stable_id AS target_id
      FROM graph_edges e
      JOIN graph_nodes source ON source.id = e.from_node
      JOIN graph_nodes target ON target.id = e.to_node
      WHERE e.checkpoint_id = ? AND e.stable_id IS NOT NULL
    `).all(checkpoint.id) as Row[];
    for (const row of edges) {
      const edge: GraphEdgeV1 = GraphEdgeV1Schema.parse({
        id: String(row.stable_id),
        source: String(row.source_id),
        target: String(row.target_id),
        kind: String(row.relation),
        checkpointIds: [checkpoint.id]
      });
      this.enqueueSyncOperation({ entityType: "graph_edge", entityId: edge.id, payload: edge, tombstone: false });
    }
  }

  listCheckpoints(
    projectId?: string,
    limit = 100,
    after?: string,
    before?: string,
    options: CheckpointQueryOptions = {}
  ): CheckpointV1[] {
    const scope = projectId ? this.projectScope(projectId) : undefined;
    let sql = "SELECT c.checkpoint_json FROM checkpoints c";
    if (options.cloudEligibleOnly) sql += " JOIN windows w ON w.id = c.window_id";
    sql += " WHERE 1=1";
    const params: Array<string | number> = [];
    if (scope) {
      sql += ` AND c.project_id IN (${scope.projectIds.map(() => "?").join(",")})`;
      params.push(...scope.projectIds);
    }
    if (after) { sql += " AND c.created_at > ?"; params.push(after); }
    if (before) { sql += " AND c.created_at < ?"; params.push(before); }
    if (options.cloudEligibleOnly) sql += " AND w.cloud_eligible = 1";
    sql += " ORDER BY c.created_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.raw.prepare(sql).all(...params) as Row[];
    return rows.map((row) => this.canonicalCheckpoint(CheckpointV1Schema.parse(JSON.parse(String(row.checkpoint_json)))));
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
    if (this.canonicalProjectId(checkpoint.projectId) !== this.canonicalProjectId(projectId)) {
      throw new Error(`Checkpoint ${checkpointId} does not belong to project ${projectId}`);
    }
    if (options.cloudEligibleOnly && !this.getCheckpoint(checkpointId, options)) {
      throw new Error(`Checkpoint ${checkpointId} is not available in the cloud-eligible MCP view`);
    }
    return this.canonicalCheckpoint(checkpoint);
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
      : this.raw.prepare("SELECT id FROM projects WHERE id != ? ORDER BY updated_at DESC LIMIT 1").get(unassignedProjectId) as Row | undefined;
    return row ? this.canonicalProjectId(String(row.id)) : undefined;
  }

  baseline(projectId: string): string | null {
    const scope = this.projectScope(projectId);
    const rows = this.raw.prepare(`
      SELECT id, baseline_checkpoint_id FROM projects
      WHERE id IN (${scope.projectIds.map(() => "?").join(",")}) AND baseline_checkpoint_id IS NOT NULL
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1
    `).all(...scope.projectIds, scope.canonicalId) as Row[];
    return rows[0]?.baseline_checkpoint_id ? String(rows[0].baseline_checkpoint_id) : null;
  }

  acknowledge(projectId: string, checkpointId: string): void {
    const canonicalId = this.canonicalProjectId(projectId);
    this.requireCheckpointForProject(canonicalId, checkpointId);
    const result = this.raw.prepare("UPDATE projects SET baseline_checkpoint_id = ?, updated_at = ? WHERE id = ?")
      .run(checkpointId, new Date().toISOString(), canonicalId);
    if (Number(result.changes) !== 1) throw new Error(`Unknown project: ${canonicalId}`);
    this.bumpRevision();
    if (!this.applyingSync) this.enqueueSyncOperation({ entityType: "baseline", entityId: canonicalId, payload: { projectId: canonicalId, checkpointId }, tombstone: false });
  }

  lexicalSearch(
    projectId: string,
    query: string,
    limit = 30,
    options: CheckpointQueryOptions = {}
  ): Array<{ rowid: number; checkpointId: string; rank: number }> {
    const tokens = query.split(/\s+/).map((token) => token.replace(/[^A-Za-z0-9_.\/-]/g, "")).filter(Boolean);
    if (tokens.length === 0) return [];
    const scope = this.projectScope(projectId);
    const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
    const rows = this.raw.prepare(`
      SELECT f.rowid, c.id AS checkpoint_id, bm25(checkpoint_fts) AS rank
      FROM checkpoint_fts f JOIN checkpoints c ON c.rowid = f.rowid
      ${options.cloudEligibleOnly ? "JOIN windows w ON w.id = c.window_id" : ""}
      WHERE checkpoint_fts MATCH ? AND f.project_id IN (${scope.projectIds.map(() => "?").join(",")})
        ${options.cloudEligibleOnly ? "AND w.cloud_eligible = 1" : ""}
      ORDER BY rank LIMIT ?
    `).all(match, ...scope.projectIds, limit) as Row[];
    return rows.map((row) => ({ rowid: Number(row.rowid), checkpointId: String(row.checkpoint_id), rank: Number(row.rank) }));
  }

  vectorSearch(
    projectId: string,
    embedding: number[],
    limit = 30,
    options: CheckpointQueryOptions = {}
  ): Array<{ checkpointId: string; distance: number }> {
    if (!this.vectorAvailable || !this.vectorSerializer || embedding.length !== 384) return [];
    const scope = this.projectScope(projectId);
    const rows = this.raw.prepare(`
      SELECT c.id AS checkpoint_id, v.distance
      FROM checkpoint_vec v JOIN checkpoints c ON c.rowid = v.rowid
      ${options.cloudEligibleOnly ? "JOIN windows w ON w.id = c.window_id" : ""}
      WHERE v.embedding MATCH ? AND k = ? AND c.project_id IN (${scope.projectIds.map(() => "?").join(",")})
        ${options.cloudEligibleOnly ? "AND w.cloud_eligible = 1" : ""}
      ORDER BY v.distance
    `).all(this.vectorSerializer(embedding), limit, ...scope.projectIds) as Row[];
    return rows.map((row) => ({ checkpointId: String(row.checkpoint_id), distance: Number(row.distance) }));
  }

  graphRelated(
    projectId: string,
    checkpointIds: string[],
    limit = 30,
    options: CheckpointQueryOptions = {}
  ): string[] {
    if (checkpointIds.length === 0) return [];
    const scope = this.projectScope(projectId);
    const placeholders = checkpointIds.map(() => "?").join(",");
    const rows = this.raw.prepare(`
      SELECT DISTINCT related.checkpoint_id
      FROM graph_edges seed
      JOIN graph_edges related ON related.to_node = seed.to_node OR related.from_node = seed.to_node
      ${options.cloudEligibleOnly ? "JOIN checkpoints related_checkpoint ON related_checkpoint.id = related.checkpoint_id JOIN windows related_window ON related_window.id = related_checkpoint.window_id" : ""}
      WHERE seed.project_id IN (${scope.projectIds.map(() => "?").join(",")}) AND seed.checkpoint_id IN (${placeholders})
        ${options.cloudEligibleOnly ? "AND related_window.cloud_eligible = 1" : ""}
      LIMIT ?
    `).all(...scope.projectIds, ...checkpointIds, limit) as Row[];
    return rows.map((row) => String(row.checkpoint_id));
  }

  graphEntities(
    projectId: string,
    checkpointIds: string[],
    options: CheckpointQueryOptions = {}
  ): Entity[] {
    if (checkpointIds.length === 0) return [];
    const scope = this.projectScope(projectId);
    const placeholders = checkpointIds.map(() => "?").join(",");
    const rows = this.raw.prepare(`
      SELECT DISTINCT n.kind, n.key, n.label, e.checkpoint_id, c.checkpoint_json
      FROM graph_edges e
      JOIN graph_nodes n ON n.id = e.to_node
      JOIN checkpoints c ON c.id = e.checkpoint_id
      ${options.cloudEligibleOnly ? "JOIN windows w ON w.id = c.window_id" : ""}
      WHERE e.project_id IN (${scope.projectIds.map(() => "?").join(",")}) AND e.checkpoint_id IN (${placeholders}) AND n.kind != 'checkpoint'
        ${options.cloudEligibleOnly ? "AND w.cloud_eligible = 1" : ""}
      ORDER BY n.kind, n.label
    `).all(...scope.projectIds, ...checkpointIds) as Row[];
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

  getPrivacyPolicy(): PrivacyPolicyV1 {
    const row = this.raw.prepare("SELECT policy_json FROM privacy_policies ORDER BY revision DESC LIMIT 1").get() as Row | undefined;
    if (row) return PrivacyPolicyV1Schema.parse(JSON.parse(String(row.policy_json)));
    const policy = defaultPrivacyPolicy();
    if (!this.readOnly) this.setPrivacyPolicy(policy);
    return policy;
  }

  setPrivacyPolicy(policy: PrivacyPolicyV1): PrivacyPolicyV1 {
    const parsed = PrivacyPolicyV1Schema.parse(policy);
    const current = this.raw.prepare("SELECT coalesce(max(revision), 0) AS revision FROM privacy_policies").get() as Row;
    if (parsed.revision <= Number(current.revision ?? 0)) {
      throw new Error("Privacy policy revision must increase monotonically");
    }
    this.raw.prepare("INSERT INTO privacy_policies(revision, policy_json, updated_at) VALUES (?, ?, ?)")
      .run(parsed.revision, JSON.stringify(parsed), parsed.updatedAt);
    this.bumpRevision();
    if (!this.applyingSync) this.enqueueSyncOperation({ entityType: "privacy_policy", entityId: "current", payload: parsed, tombstone: false });
    // Retention tightening is effective immediately. This also replaces any
    // still-pending event sync payloads with payload-free tombstones before the
    // shorter policy can be synchronized to another device.
    this.purgeExpiredEvents(parsed.retentionHours);
    return parsed;
  }

  setActiveProjectLease(lease: ActiveProjectLeaseV1): ActiveProjectLeaseV1 {
    const projectId = this.canonicalProjectId(lease.projectId);
    const canonicalLease = ActiveProjectLeaseV1Schema.parse({ ...lease, projectId });
    this.ensureProject(projectId, lease.projectName);
    const current = this.activeProjectLease(lease.deviceId);
    const authority = (source: ActiveProjectLeaseV1["source"]): number => {
      if (source === "manual") return 4;
      if (source === "vscode" || source === "terminal") return 3;
      return 2;
    };
    if (current) {
      const currentAuthority = authority(current.source);
      const incomingAuthority = authority(lease.source);
      if (currentAuthority > incomingAuthority || (currentAuthority === incomingAuthority && current.issuedAt > lease.issuedAt)) return current;
    }
    this.raw.prepare(`
      INSERT INTO active_project_leases(device_id, project_id, project_name, source, confidence, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        project_id = excluded.project_id,
        project_name = excluded.project_name,
        source = excluded.source,
        confidence = excluded.confidence,
        issued_at = excluded.issued_at,
        expires_at = excluded.expires_at
      WHERE excluded.issued_at >= active_project_leases.issued_at
    `).run(canonicalLease.deviceId, canonicalLease.projectId, canonicalLease.projectName, canonicalLease.source, canonicalLease.confidence, canonicalLease.issuedAt, canonicalLease.expiresAt);
    this.bumpRevision();
    return canonicalLease;
  }

  activeProjectLease(deviceId = this.deviceId(), now = new Date()): ActiveProjectLeaseV1 | undefined {
    this.raw.prepare("DELETE FROM active_project_leases WHERE expires_at <= ?").run(now.toISOString());
    const row = this.raw.prepare("SELECT * FROM active_project_leases WHERE device_id = ? AND expires_at > ?")
      .get(deviceId, now.toISOString()) as Row | undefined;
    if (!row) return undefined;
    const projectId = this.canonicalProjectId(String(row.project_id));
    return {
      version: "1",
      projectId,
      projectName: this.projectLabel(projectId),
      source: String(row.source) as ActiveProjectLeaseV1["source"],
      confidence: Number(row.confidence),
      deviceId: String(row.device_id),
      issuedAt: String(row.issued_at),
      expiresAt: String(row.expires_at)
    };
  }

  graphSnapshot(input: GraphQueryV1, options: CheckpointQueryOptions = {}): GraphSnapshotV1 {
    const query = GraphQueryV1Schema.parse(input);
    const requestedProjectId = query.projectId ?? this.latestProjectId();
    if (!requestedProjectId) {
      return GraphSnapshotV1Schema.parse({
        version: "1", projectId: "", generatedAt: new Date().toISOString(), nodes: [], edges: [],
        nextCursor: null, truncated: false, degraded: !this.vectorAvailable
      });
    }
    const scope = this.projectScope(requestedProjectId);
    const projectId = scope.canonicalId;
    const projectPlaceholders = scope.projectIds.map(() => "?").join(",");
    const nodeRows = this.raw.prepare(options.cloudEligibleOnly ? `
      SELECT DISTINCT gn.id, gn.stable_id, gn.kind, gn.key, gn.label
      FROM graph_nodes gn
      JOIN graph_edges ge ON ge.from_node = gn.id OR ge.to_node = gn.id
      JOIN checkpoints c ON c.id = ge.checkpoint_id
      JOIN windows w ON w.id = c.window_id AND w.cloud_eligible = 1
      WHERE gn.project_id IN (${projectPlaceholders})
      ORDER BY gn.kind, gn.label, gn.id
      LIMIT 5000
    ` : `
      SELECT id, stable_id, kind, key, label
      FROM graph_nodes
      WHERE project_id IN (${projectPlaceholders})
      ORDER BY kind, label, id
      LIMIT 5000
    `).all(...scope.projectIds) as Row[];
    const edgeRows = this.raw.prepare(options.cloudEligibleOnly ? `
      SELECT ge.id, ge.stable_id, ge.from_node, ge.to_node, ge.relation, ge.checkpoint_id
      FROM graph_edges ge
      JOIN checkpoints c ON c.id = ge.checkpoint_id
      JOIN windows w ON w.id = c.window_id AND w.cloud_eligible = 1
      WHERE ge.project_id IN (${projectPlaceholders})
      ORDER BY ge.id
      LIMIT 10000
    ` : `
      SELECT id, stable_id, from_node, to_node, relation, checkpoint_id
      FROM graph_edges
      WHERE project_id IN (${projectPlaceholders})
      ORDER BY id
      LIMIT 10000
    `).all(...scope.projectIds) as Row[];
    const allowedKinds = new Set(query.kinds ?? []);
    const term = query.query?.trim().toLocaleLowerCase();
    const numericToStable = new Map<number, string>();
    const rawNodes = nodeRows.map((row) => {
      const numericId = Number(row.id);
      const kindValue = String(row.kind);
      const kind = kindValue === "person" ? "concept" : kindValue;
      const stable = row.stable_id
        ? String(row.stable_id)
        : `node:${projectId}:${kind}:${Buffer.from(String(row.key)).toString("base64url")}`;
      numericToStable.set(numericId, stable);
      return { numericId, stable, kind, key: String(row.key), label: String(row.label) };
    });
    const adjacency = new Map<string, Set<string>>();
    for (const edge of edgeRows) {
      const from = numericToStable.get(Number(edge.from_node));
      const to = numericToStable.get(Number(edge.to_node));
      if (!from || !to) continue;
      if (!adjacency.has(from)) adjacency.set(from, new Set());
      if (!adjacency.has(to)) adjacency.set(to, new Set());
      adjacency.get(from)!.add(to);
      adjacency.get(to)!.add(from);
    }
    let selected = rawNodes.filter((node) =>
      (allowedKinds.size === 0 || allowedKinds.has(node.kind as never))
      && (!term || `${node.label} ${node.key}`.toLocaleLowerCase().includes(term))
    );
    if (query.aroundNodeId) {
      const visited = new Set([query.aroundNodeId]);
      let frontier = new Set([query.aroundNodeId]);
      for (let hop = 0; hop < query.hops; hop += 1) {
        const next = new Set<string>();
        for (const id of frontier) for (const neighbor of adjacency.get(id) ?? []) {
          if (!visited.has(neighbor)) { visited.add(neighbor); next.add(neighbor); }
        }
        frontier = next;
      }
      selected = selected.filter((node) => visited.has(node.stable));
    }
    const offset = Math.max(0, Number.parseInt(query.cursor ?? "0", 10) || 0);
    const page = selected.slice(offset, offset + query.limit);
    const selectedIds = new Set(page.map((node) => node.stable));
    const checkpointsByNode = new Map<string, Set<string>>();
    const edges = [] as GraphSnapshotV1["edges"];
    for (const edge of edgeRows) {
      const source = numericToStable.get(Number(edge.from_node));
      const target = numericToStable.get(Number(edge.to_node));
      if (!source || !target || !selectedIds.has(source) || !selectedIds.has(target)) continue;
      const kind = String(edge.relation);
      if (query.edgeKinds && !query.edgeKinds.includes(kind)) continue;
      const checkpointId = String(edge.checkpoint_id);
      for (const id of [source, target]) {
        if (!checkpointsByNode.has(id)) checkpointsByNode.set(id, new Set());
        checkpointsByNode.get(id)!.add(checkpointId);
      }
      if (edges.length < 1000) edges.push({
        id: edge.stable_id
          ? String(edge.stable_id)
          : `edge:${createHash("sha256").update(`${source}\0${kind}\0${target}\0${checkpointId}`).digest("base64url")}`,
        source,
        target,
        kind,
        checkpointIds: [checkpointId]
      });
    }
    const nodes: GraphSnapshotV1["nodes"] = page.map((node) => ({
      id: node.stable,
      kind: node.kind as GraphSnapshotV1["nodes"][number]["kind"],
      label: node.label.slice(0, 256),
      projectId,
      checkpointIds: [...(checkpointsByNode.get(node.stable) ?? [])].slice(0, 64),
      metadata: { key: node.key }
    }));
    const truncated = offset + page.length < selected.length || edges.length >= 1000;
    return GraphSnapshotV1Schema.parse({
      version: "1",
      projectId,
      generatedAt: new Date().toISOString(),
      nodes,
      edges,
      nextCursor: offset + page.length < selected.length ? String(offset + page.length) : null,
      truncated,
      degraded: !this.vectorAvailable
    });
  }

  createChatSession(
    projectId: string,
    title = "New conversation",
    syncEligibility: ChatSessionV1["syncEligibility"] = "local_only",
    classification: ChatSessionV1["classification"] = "personal"
  ): ChatSessionV1 {
    projectId = this.canonicalProjectId(projectId);
    this.ensureProject(projectId);
    const now = new Date().toISOString();
    const session = ChatSessionV1Schema.parse({ version: "1", id: randomUUID(), projectId, title, classification, createdAt: now, updatedAt: now, syncEligibility });
    this.raw.prepare("INSERT INTO chat_sessions(id, project_id, title, classification, sync_eligibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(session.id, session.projectId, session.title, session.classification, session.syncEligibility, session.createdAt, session.updatedAt);
    this.bumpRevision();
    if (!this.applyingSync && session.syncEligibility === "cloud_eligible") {
      this.enqueueSyncOperation({ entityType: "chat_session", entityId: session.id, payload: session, tombstone: false });
    }
    return session;
  }

  listChatSessions(projectId?: string, limit = 50): ChatSessionV1[] {
    const scope = projectId ? this.projectScope(projectId) : undefined;
    const rows = scope
      ? this.raw.prepare(`SELECT * FROM chat_sessions WHERE deleted_at IS NULL AND project_id IN (${scope.projectIds.map(() => "?").join(",")}) ORDER BY updated_at DESC LIMIT ?`).all(...scope.projectIds, limit) as Row[]
      : this.raw.prepare("SELECT * FROM chat_sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map((row) => ChatSessionV1Schema.parse({
      version: "1", id: String(row.id), projectId: this.canonicalProjectId(String(row.project_id)), title: String(row.title),
      classification: String(row.classification ?? "personal"),
      syncEligibility: String(row.sync_eligibility), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    }));
  }

  chatSession(id: string): ChatSessionV1 | undefined {
    return this.listChatSessions(undefined, 500).find((session) => session.id === id);
  }

  addChatMessage(message: ChatMessageV1): ChatMessageV1 {
    const parsed = ChatMessageV1Schema.parse(message);
    const session = this.raw.prepare("SELECT id FROM chat_sessions WHERE id = ? AND deleted_at IS NULL").get(parsed.sessionId);
    if (!session) throw new Error("Unknown chat session");
    this.raw.prepare(`
      INSERT INTO chat_messages(id, session_id, role, text, citations_json, hypotheses_json, provider, model, sync_eligibility, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(parsed.id, parsed.sessionId, parsed.role, parsed.text, JSON.stringify(parsed.citations), JSON.stringify(parsed.unverifiedHypotheses), parsed.provider, parsed.model, parsed.syncEligibility, parsed.createdAt);
    this.raw.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(parsed.createdAt, parsed.sessionId);
    this.bumpRevision();
    if (!this.applyingSync && parsed.syncEligibility === "cloud_eligible") {
      this.enqueueSyncOperation({ entityType: "chat_message", entityId: parsed.id, payload: parsed, tombstone: false });
    }
    return parsed;
  }

  chatMessages(sessionId: string, limit = 200): ChatMessageV1[] {
    const rows = this.raw.prepare("SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?")
      .all(sessionId, Math.min(500, Math.max(1, limit))) as Row[];
    return rows.map((row) => ChatMessageV1Schema.parse({
      version: "1", id: String(row.id), sessionId: String(row.session_id), role: String(row.role), text: String(row.text),
      citations: JSON.parse(String(row.citations_json)), unverifiedHypotheses: JSON.parse(String(row.hypotheses_json)),
      provider: String(row.provider), model: String(row.model), syncEligibility: String(row.sync_eligibility), createdAt: String(row.created_at)
    }));
  }

  createContextAction(sessionId: string, input: Omit<ContextActionV1, "id" | "version" | "status">): ContextActionV1 {
    const now = new Date().toISOString();
    const action = ContextActionV1Schema.parse({ ...input, version: "1", id: randomUUID(), status: "proposed" });
    this.raw.prepare(`
      INSERT INTO context_actions(id, session_id, name, arguments_json, mutating, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(action.id, sessionId, action.name, JSON.stringify(action.arguments), action.mutating ? 1 : 0, action.status, now, now);
    this.bumpRevision();
    return action;
  }

  contextAction(id: string): ContextActionV1 | undefined {
    const row = this.raw.prepare("SELECT * FROM context_actions WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    return ContextActionV1Schema.parse({
      version: "1", id: String(row.id), name: String(row.name), arguments: JSON.parse(String(row.arguments_json)),
      mutating: Boolean(row.mutating), status: String(row.status),
      ...(row.result_json ? { result: JSON.parse(String(row.result_json)) } : {})
    });
  }

  updateContextAction(id: string, status: ContextActionV1["status"], result?: unknown): ContextActionV1 {
    const update = this.raw.prepare("UPDATE context_actions SET status = ?, result_json = ?, updated_at = ? WHERE id = ?")
      .run(status, result === undefined ? null : JSON.stringify(result), new Date().toISOString(), id);
    if (Number(update.changes) !== 1) throw new Error("Unknown context action");
    this.bumpRevision();
    return this.contextAction(id)!;
  }

  enqueueSyncOperation(input: Omit<SyncOperationV1, "id" | "sequence" | "deviceId" | "hlc" | "occurredAt" | "version">): SyncOperationV1 {
    const deviceId = this.deviceId();
    const now = Date.now();
    this.raw.exec("SAVEPOINT continuum_sync_enqueue");
    try {
      const sequence = Number((this.raw.prepare("SELECT value FROM settings WHERE key = 'syncSequence'").get() as Row | undefined)?.value ?? 0) + 1;
      const lastHlc = (this.raw.prepare("SELECT value FROM settings WHERE key = 'lastHlc'").get() as Row | undefined)?.value;
      let physical = BigInt(now);
      let logical = 0n;
      if (typeof lastHlc === "string") {
        const previous = parseHlc(lastHlc);
        if (previous.physical >= physical) {
          physical = previous.physical;
          logical = previous.logical + 1n;
        }
      }
      const hlc = `${physical}:${logical}:${deviceId}`;
      const operation = SyncOperationV1Schema.parse({
        version: "1", id: randomUUID(), deviceId, sequence, hlc,
        occurredAt: new Date(now).toISOString(), ...input
      });
      this.raw.prepare(`
        INSERT INTO sync_outbox(id, device_id, sequence, hlc, entity_type, entity_id, operation_json, tombstone, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(operation.id, operation.deviceId, operation.sequence, operation.hlc, operation.entityType, operation.entityId, JSON.stringify(operation), operation.tombstone ? 1 : 0, operation.occurredAt);
      this.raw.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('syncSequence', ?)").run(String(sequence));
      this.raw.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('lastHlc', ?)").run(hlc);
      this.raw.prepare(`
        INSERT INTO sync_entity_clock(entity_type, entity_id, hlc, device_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET hlc = excluded.hlc, device_id = excluded.device_id
      `).run(operation.entityType, operation.entityId, operation.hlc, operation.deviceId);
      this.raw.exec("RELEASE SAVEPOINT continuum_sync_enqueue");
      return operation;
    } catch (error) {
      this.raw.exec("ROLLBACK TO SAVEPOINT continuum_sync_enqueue");
      this.raw.exec("RELEASE SAVEPOINT continuum_sync_enqueue");
      throw error;
    }
  }

  pendingSyncOperations(limit = 200): SyncOperationV1[] {
    const rows = this.raw.prepare("SELECT operation_json FROM sync_outbox WHERE acknowledged_at IS NULL ORDER BY sequence LIMIT ?")
      .all(Math.min(500, Math.max(1, limit))) as Row[];
    return rows.map((row) => SyncOperationV1Schema.parse(JSON.parse(String(row.operation_json))));
  }

  updatePendingSyncOperation(operation: SyncOperationV1): void {
    const parsed = SyncOperationV1Schema.parse(operation);
    const existing = this.raw.prepare(`
      SELECT device_id, sequence, entity_type, entity_id FROM sync_outbox
      WHERE id = ? AND acknowledged_at IS NULL
    `).get(parsed.id) as Row | undefined;
    if (!existing
      || String(existing.device_id) !== parsed.deviceId
      || Number(existing.sequence) !== parsed.sequence
      || String(existing.entity_type) !== parsed.entityType
      || String(existing.entity_id) !== parsed.entityId) {
      throw new Error("Cannot replace an unknown or mismatched pending synchronization operation");
    }
    this.raw.prepare("UPDATE sync_outbox SET operation_json = ?, tombstone = ? WHERE id = ? AND acknowledged_at IS NULL")
      .run(JSON.stringify(parsed), parsed.tombstone ? 1 : 0, parsed.id);
  }

  acknowledgeSyncOperations(ids: string[]): number {
    const statement = this.raw.prepare("UPDATE sync_outbox SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL");
    let count = 0;
    const now = new Date().toISOString();
    for (const id of [...new Set(ids)].slice(0, 500)) count += Number(statement.run(now, id).changes);
    return count;
  }

  syncCursor(): string | null {
    const row = this.raw.prepare("SELECT value FROM settings WHERE key = 'syncCursor'").get() as Row | undefined;
    return row ? String(row.value) : null;
  }

  setSyncCursor(cursor: string): void {
    if (!/^[-A-Za-z0-9_.:]{1,256}$/.test(cursor)) throw new Error("Invalid synchronization cursor");
    this.raw.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('syncCursor', ?)").run(cursor);
    this.bumpRevision();
  }

  private syncOperationWins(operation: SyncOperationV1): boolean {
    const row = this.raw.prepare("SELECT hlc, device_id FROM sync_entity_clock WHERE entity_type = ? AND entity_id = ?")
      .get(operation.entityType, operation.entityId) as Row | undefined;
    if (!row) return true;
    const comparison = compareHlc(operation.hlc, String(row.hlc));
    return comparison > 0 || (comparison === 0 && operation.deviceId > String(row.device_id));
  }

  private recordSyncClock(operation: SyncOperationV1): void {
    this.raw.prepare(`
      INSERT INTO sync_entity_clock(entity_type, entity_id, hlc, device_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET hlc = excluded.hlc, device_id = excluded.device_id
    `).run(operation.entityType, operation.entityId, operation.hlc, operation.deviceId);
    this.observeHlc(operation.hlc);
  }

  private observeHlc(hlc: string): void {
    const row = this.raw.prepare("SELECT value FROM settings WHERE key = 'lastHlc'").get() as Row | undefined;
    if (!row || compareHlc(hlc, String(row.value)) > 0) {
      this.raw.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('lastHlc', ?)").run(hlc);
    }
  }

  private recordSyncInbox(operation: SyncOperationV1): void {
    this.raw.prepare("INSERT INTO sync_inbox(id, device_id, sequence, hlc, applied_at) VALUES (?, ?, ?, ?, ?)")
      .run(operation.id, operation.deviceId, operation.sequence, operation.hlc, new Date().toISOString());
  }

  private deleteSynchronizedEntity(operation: SyncOperationV1): void {
    if (operation.entityType === "event") this.raw.prepare("DELETE FROM events WHERE id = ?").run(operation.entityId);
    else if (operation.entityType === "chat_message") this.raw.prepare("DELETE FROM chat_messages WHERE id = ?").run(operation.entityId);
    else if (operation.entityType === "chat_session") this.raw.prepare("UPDATE chat_sessions SET deleted_at = ? WHERE id = ?").run(operation.occurredAt, operation.entityId);
    else if (operation.entityType === "graph_edge") this.raw.prepare("DELETE FROM graph_edges WHERE stable_id = ?").run(operation.entityId);
    else if (operation.entityType === "graph_node") {
      const node = this.raw.prepare("SELECT id FROM graph_nodes WHERE stable_id = ?").get(operation.entityId) as Row | undefined;
      if (node) {
        this.raw.prepare("DELETE FROM graph_edges WHERE from_node = ? OR to_node = ?").run(Number(node.id), Number(node.id));
        this.raw.prepare("DELETE FROM graph_nodes WHERE id = ?").run(Number(node.id));
      }
    } else if (operation.entityType === "checkpoint") {
      const checkpoint = this.raw.prepare("SELECT rowid, window_id FROM checkpoints WHERE id = ?").get(operation.entityId) as Row | undefined;
      if (checkpoint) {
        this.raw.prepare("DELETE FROM graph_edges WHERE checkpoint_id = ?").run(operation.entityId);
        this.raw.prepare("DELETE FROM checkpoint_fts WHERE rowid = ?").run(Number(checkpoint.rowid));
        if (this.vectorAvailable) this.raw.prepare("DELETE FROM checkpoint_vec WHERE rowid = ?").run(Number(checkpoint.rowid));
        this.raw.prepare("DELETE FROM checkpoints WHERE id = ?").run(operation.entityId);
        this.raw.prepare("DELETE FROM windows WHERE id = ?").run(String(checkpoint.window_id));
      }
    } else if (operation.entityType === "baseline") {
      this.raw.prepare("UPDATE projects SET baseline_checkpoint_id = NULL, updated_at = ? WHERE id = ?").run(operation.occurredAt, operation.entityId);
    } else if (operation.entityType === "device") {
      this.raw.prepare("UPDATE device_state SET revoked_at = ?, last_seen_at = ? WHERE id = ?")
        .run(operation.occurredAt, operation.occurredAt, operation.entityId);
    } else if (operation.entityType === "settings") {
      if (operation.entityId === "models") {
        const statement = this.raw.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)");
        for (const [key, value] of Object.entries(defaultSettings)) statement.run(key, JSON.stringify(value));
      }
    } else if (operation.entityType === "privacy_policy") {
      const fallback = defaultPrivacyPolicy(new Date(operation.occurredAt));
      const revision = Number((this.raw.prepare("SELECT coalesce(max(revision), 0) AS revision FROM privacy_policies").get() as Row).revision) + 1;
      const policy = PrivacyPolicyV1Schema.parse({ ...fallback, revision });
      this.raw.prepare("INSERT INTO privacy_policies(revision, policy_json, updated_at) VALUES (?, ?, ?)")
        .run(policy.revision, JSON.stringify(policy), policy.updatedAt);
    } else if (operation.entityType === "project") {
      this.raw.prepare(`
        DELETE FROM projects WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM events WHERE project_id = ?)
          AND NOT EXISTS (SELECT 1 FROM checkpoints WHERE project_id = ?)
          AND NOT EXISTS (SELECT 1 FROM chat_sessions WHERE project_id = ?)
      `).run(operation.entityId, operation.entityId, operation.entityId, operation.entityId);
    }
  }

  applySyncOperations(inputs: SyncOperationV1[]): { applied: number; duplicate: number } {
    const operations = inputs.slice(0, 500).map((input) => SyncOperationV1Schema.parse(input));
    let applied = 0;
    let duplicate = 0;
    this.raw.exec("BEGIN IMMEDIATE");
    this.applyingSync = true;
    try {
      for (const operation of operations) {
        if (this.raw.prepare("SELECT 1 AS present FROM sync_inbox WHERE id = ? OR (device_id = ? AND sequence = ?)")
          .get(operation.id, operation.deviceId, operation.sequence)) {
          duplicate += 1;
          continue;
        }
        const immutable = operation.entityType === "event" || operation.entityType === "checkpoint" || operation.entityType === "chat_message";
        if ((!immutable || operation.tombstone) && !this.syncOperationWins(operation)) {
          this.observeHlc(operation.hlc);
          this.recordSyncInbox(operation);
          applied += 1;
          continue;
        }
        if (operation.tombstone) {
          this.deleteSynchronizedEntity(operation);
        } else if (operation.entityType === "event") {
          const event = NormalizedEventV2Schema.parse(operation.payload);
          if (event.syncEligibility !== "cloud_eligible") throw new Error("Refusing to apply a local-only synchronized event");
          const existing = this.raw.prepare("SELECT source, event_type, project_id, title, attributes_json, privacy, device_id FROM events WHERE id = ?")
            .get(event.id) as Row | undefined;
          if (existing) {
            const matches = String(existing.source) === event.source
              && String(existing.event_type) === event.eventType
              && String(existing.project_id) === (event.projectId ?? unassignedProjectId)
              && String(existing.title) === event.title
              && canonicalJson(JSON.parse(String(existing.attributes_json))) === canonicalJson(event.attributes)
              && String(existing.privacy) === event.privacy.classification
              && String(existing.device_id) === event.deviceId;
            if (!matches) throw new Error(`Immutable synchronized event collision: ${event.id}`);
          } else this.insertEvent(event);
        } else if (operation.entityType === "project") {
          const payload = ProjectSyncPayloadV1Schema.parse(operation.payload);
          if (payload.id !== operation.entityId) throw new Error("Synchronized project entity ID does not match its payload");
          const id = payload.id;
          const label = payload.label;
          this.ensureProject(id, label);
          if (payload.redirectFrom && payload.redirectTo) {
            this.setProjectRedirect(payload.redirectFrom, payload.redirectTo, operation.occurredAt);
          }
          if (payload.repositoryFingerprint) {
            const displayName = payload.normalizedName ?? label;
            const now = new Date().toISOString();
            this.raw.prepare(`
              INSERT OR IGNORE INTO project_aliases(
                id, project_id, device_id, local_path_hash, display_name,
                repository_fingerprint, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              randomUUID(),
              id,
              operation.deviceId,
              `remote:${id}:${payload.repositoryFingerprint}`,
              displayName,
              payload.repositoryFingerprint,
              now,
              now
            );
          }
        } else if (operation.entityType === "checkpoint") {
          const checkpoint = CheckpointV1Schema.parse(operation.payload);
          const existing = this.getCheckpoint(checkpoint.id);
          if (existing && canonicalJson(existing) !== canonicalJson(checkpoint)) {
            throw new Error(`Immutable synchronized checkpoint collision: ${checkpoint.id}`);
          }
          this.ensureProject(checkpoint.projectId);
          this.raw.prepare(`
            INSERT OR IGNORE INTO windows(id, project_id, started_at, ended_at, status, provider, model, cloud_eligible, created_at)
            VALUES (?, ?, ?, ?, 'complete', ?, ?, 1, ?)
          `).run(checkpoint.windowId, checkpoint.projectId, checkpoint.createdAt, checkpoint.createdAt, checkpoint.provider, checkpoint.model, checkpoint.createdAt);
          if (!existing) this.insertCheckpoint(checkpoint);
        } else if (operation.entityType === "privacy_policy") {
          const policy = PrivacyPolicyV1Schema.parse(operation.payload);
          const revision = Number((this.raw.prepare("SELECT coalesce(max(revision), 0) AS revision FROM privacy_policies").get() as Row).revision) + 1;
          const effective = PrivacyPolicyV1Schema.parse({ ...policy, revision });
          this.raw.prepare("INSERT INTO privacy_policies(revision, policy_json, updated_at) VALUES (?, ?, ?)")
            .run(effective.revision, JSON.stringify(effective), effective.updatedAt);
        } else if (operation.entityType === "settings") {
          const settings = ModelSettingsSchema.parse(operation.payload);
          const statement = this.raw.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)");
          for (const [key, value] of Object.entries(settings)) statement.run(key, JSON.stringify(value));
          statement.run("providerAutoSelect", "false");
        } else if (operation.entityType === "chat_session") {
          const session = ChatSessionV1Schema.parse(operation.payload);
          if (session.syncEligibility !== "cloud_eligible" || session.classification === "confidential") {
            throw new Error("Refusing to apply a local-only synchronized chat session");
          }
          const projectId = this.canonicalProjectId(session.projectId);
          this.ensureProject(projectId);
          this.raw.prepare(`
            INSERT INTO chat_sessions(id, project_id, title, classification, sync_eligibility, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title,
              classification = excluded.classification, sync_eligibility = excluded.sync_eligibility,
              updated_at = excluded.updated_at, deleted_at = NULL
          `).run(session.id, projectId, session.title, session.classification, session.syncEligibility, session.createdAt, session.updatedAt);
        } else if (operation.entityType === "chat_message") {
          const message = ChatMessageV1Schema.parse(operation.payload);
          if (message.syncEligibility !== "cloud_eligible") throw new Error("Refusing to apply a local-only synchronized chat message");
          const existing = this.raw.prepare("SELECT * FROM chat_messages WHERE id = ?").get(message.id) as Row | undefined;
          if (existing) {
            const stored = ChatMessageV1Schema.parse({
              version: "1", id: String(existing.id), sessionId: String(existing.session_id), role: String(existing.role), text: String(existing.text),
              citations: JSON.parse(String(existing.citations_json)), unverifiedHypotheses: JSON.parse(String(existing.hypotheses_json)),
              provider: String(existing.provider), model: String(existing.model), createdAt: String(existing.created_at),
              syncEligibility: String(existing.sync_eligibility)
            });
            if (canonicalJson(stored) !== canonicalJson(message)) throw new Error(`Immutable synchronized chat message collision: ${message.id}`);
          } else this.addChatMessage(message);
        } else if (operation.entityType === "baseline") {
          const payload = operation.payload as { projectId?: unknown; checkpointId?: unknown };
          if (typeof payload?.projectId !== "string" || typeof payload.checkpointId !== "string") throw new Error("Invalid synchronized baseline");
          const projectId = this.canonicalProjectId(payload.projectId);
          this.requireCheckpointForProject(projectId, payload.checkpointId);
          this.ensureProject(projectId);
          this.raw.prepare("UPDATE projects SET baseline_checkpoint_id = ?, updated_at = ? WHERE id = ?")
            .run(payload.checkpointId, operation.occurredAt, projectId);
        } else if (operation.entityType === "graph_node") {
          const node = GraphNodeV1Schema.parse(operation.payload);
          const metadataProject = node.metadata.projectId;
          const sourceProjectId = node.projectId ?? (typeof metadataProject === "string" ? metadataProject : node.id.split(":")[1]);
          if (!sourceProjectId) throw new Error("Synchronized graph node has no project provenance");
          const projectId = this.canonicalProjectId(sourceProjectId);
          this.ensureProject(projectId);
          const key = typeof node.metadata.key === "string" ? node.metadata.key : node.id;
          this.raw.prepare("INSERT OR IGNORE INTO graph_nodes(project_id, kind, key, label, stable_id) VALUES (?, ?, ?, ?, ?)")
            .run(projectId, node.kind, key, node.label, node.id);
          this.raw.prepare("UPDATE graph_nodes SET label = ?, stable_id = ? WHERE project_id = ? AND kind = ? AND key = ?")
            .run(node.label, node.id, projectId, node.kind, key);
        } else if (operation.entityType === "graph_edge") {
          const edge = GraphEdgeV1Schema.parse(operation.payload);
          const source = this.raw.prepare("SELECT id, project_id FROM graph_nodes WHERE stable_id = ?").get(edge.source) as Row | undefined;
          const target = this.raw.prepare("SELECT id, project_id FROM graph_nodes WHERE stable_id = ?").get(edge.target) as Row | undefined;
          if (!source || !target || String(source.project_id) !== String(target.project_id)) throw new Error("Synchronized graph edge endpoints are unavailable");
          const checkpointId = edge.checkpointIds[0];
          if (!checkpointId || !this.getCheckpoint(checkpointId)) throw new Error("Synchronized graph edge has no available checkpoint provenance");
          this.raw.prepare(`
            INSERT OR IGNORE INTO graph_edges(project_id, from_node, to_node, relation, checkpoint_id, stable_id)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(String(source.project_id), Number(source.id), Number(target.id), edge.kind, checkpointId, edge.id);
          this.raw.prepare(`
            UPDATE graph_edges SET stable_id = ?
            WHERE project_id = ? AND from_node = ? AND to_node = ? AND relation = ? AND checkpoint_id = ?
          `).run(edge.id, String(source.project_id), Number(source.id), Number(target.id), edge.kind, checkpointId);
        } else if (operation.entityType === "device") {
          const payload = operation.payload as { displayName?: unknown; lastSeenAt?: unknown; revokedAt?: unknown };
          this.raw.prepare(`
            INSERT INTO device_state(id, display_name, last_sequence, last_hlc, last_seen_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, last_sequence = max(device_state.last_sequence, excluded.last_sequence),
              last_hlc = excluded.last_hlc, last_seen_at = excluded.last_seen_at, revoked_at = excluded.revoked_at
          `).run(operation.entityId, typeof payload.displayName === "string" ? payload.displayName : operation.entityId, operation.sequence, operation.hlc,
            typeof payload.lastSeenAt === "string" ? payload.lastSeenAt : operation.occurredAt,
            typeof payload.revokedAt === "string" ? payload.revokedAt : null);
        } else {
          throw new Error(`Unsupported synchronized entity type: ${operation.entityType satisfies never}`);
        }
        this.recordSyncClock(operation);
        this.recordSyncInbox(operation);
        applied += 1;
      }
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    } finally {
      this.applyingSync = false;
    }
    if (applied > 0) this.bumpRevision();
    return { applied, duplicate };
  }

  requestCollectorPairing(kind: "chrome", clientId: string, challenge: string): { id: string; kind: string; clientId: string; status: string; expiresAt: string } {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(clientId)) throw new Error("Invalid collector client ID");
    if (!/^[A-Za-z0-9_-]{24,256}$/.test(challenge)) throw new Error("Invalid pairing challenge");
    const id = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 5 * 60_000).toISOString();
    const challengeHash = createHash("sha256").update(challenge).digest("hex");
    this.raw.prepare(`
      INSERT INTO collector_pairings(id, kind, client_id, challenge_hash, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, kind, clientId, challengeHash, createdAt.toISOString(), expiresAt);
    this.bumpRevision();
    return { id, kind, clientId, status: "pending", expiresAt };
  }

  collectorPairings(kind = "chrome", limit = 50): Array<{ id: string; kind: string; clientId: string; status: string; createdAt: string; expiresAt: string; approvedAt?: string; revokedAt?: string }> {
    const rows = this.raw.prepare("SELECT * FROM collector_pairings WHERE kind = ? ORDER BY created_at DESC LIMIT ?").all(kind, limit) as Row[];
    return rows.map((row) => ({
      id: String(row.id), kind: String(row.kind), clientId: String(row.client_id), status: String(row.status),
      createdAt: String(row.created_at), expiresAt: String(row.expires_at),
      ...(row.approved_at ? { approvedAt: String(row.approved_at) } : {}),
      ...(row.revoked_at ? { revokedAt: String(row.revoked_at) } : {})
    }));
  }

  approveCollectorPairing(id: string): void {
    const now = new Date().toISOString();
    const result = this.raw.prepare(`
      UPDATE collector_pairings SET status = 'approved', approved_at = ?
      WHERE id = ? AND status = 'pending' AND expires_at > ?
    `).run(now, id, now);
    if (Number(result.changes) !== 1) throw new Error("Pairing request is missing or expired");
    this.bumpRevision();
  }

  completeCollectorPairing(id: string, challenge: string): { status: string; token?: string; expiresAt?: string } {
    const row = this.raw.prepare("SELECT * FROM collector_pairings WHERE id = ?").get(id) as Row | undefined;
    if (!row) return { status: "missing" };
    if (String(row.expires_at) <= new Date().toISOString() && ["pending", "approved"].includes(String(row.status))) {
      this.raw.prepare("UPDATE collector_pairings SET status = 'expired' WHERE id = ? AND status IN ('pending', 'approved')").run(id);
      this.bumpRevision();
      return { status: "expired" };
    }
    const expected = Buffer.from(String(row.challenge_hash), "hex");
    const actual = createHash("sha256").update(challenge).digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { status: "missing" };
    if (row.revoked_at) return { status: "revoked" };
    if (String(row.status) !== "approved") return { status: String(row.status), expiresAt: String(row.expires_at) };
    if (row.token_hash) return { status: "paired" };
    const token = `ctc_${randomBytes(32).toString("base64url")}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    this.raw.prepare("UPDATE collector_pairings SET status = 'paired', token_hash = ? WHERE id = ?").run(tokenHash, id);
    this.bumpRevision();
    return { status: "paired", token };
  }

  verifyCollectorToken(token: string): boolean {
    if (!token.startsWith("ctc_")) return false;
    const hash = createHash("sha256").update(token).digest("hex");
    const rows = this.raw.prepare("SELECT token_hash FROM collector_pairings WHERE status = 'paired' AND revoked_at IS NULL AND token_hash IS NOT NULL").all() as Row[];
    const actual = Buffer.from(hash, "hex");
    return rows.some((row) => {
      const expected = Buffer.from(String(row.token_hash), "hex");
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    });
  }

  revokeCollectorPairing(id: string): void {
    const now = new Date().toISOString();
    const result = this.raw.prepare("UPDATE collector_pairings SET status = 'revoked', revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
    if (Number(result.changes) !== 1) throw new Error("Unknown or already revoked collector pairing");
    this.bumpRevision();
  }

  counts(): { eventCount: number; checkpointCount: number; droppedSecretCount: number } {
    const event = this.raw.prepare("SELECT count(*) AS count FROM events").get() as Row;
    const checkpoint = this.raw.prepare("SELECT count(*) AS count FROM checkpoints").get() as Row;
    const secret = this.raw.prepare(`
      SELECT coalesce(sum(count), 0) AS count FROM privacy_audit
      WHERE action = 'drop' AND rule IN (
        'authorization_header', 'chat_authorization_header', 'chat_env_file',
        'chat_generic_secret_assignment', 'chat_openai_api_key', 'chat_private_key',
        'collector_secret', 'env_file', 'generic_secret_assignment', 'native_secret_guard',
        'openai_api_key', 'private_command', 'private_key', 'secret_path',
        'secret_pattern', 'secret_subject'
      )
    `).get() as Row;
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
      const scope = this.projectScope(projectId);
      sql += ` AND project_id IN (${scope.projectIds.map(() => "?").join(",")})`;
      params.push(...scope.projectIds);
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
    const scope = projectId ? this.projectScope(projectId) : undefined;
    const row = scope
      ? this.raw.prepare(`SELECT count(*) AS count FROM events WHERE window_id IS NULL AND project_id IN (${scope.projectIds.map(() => "?").join(",")})`).get(...scope.projectIds) as Row
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
