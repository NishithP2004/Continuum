import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContinuumDatabase } from "../src/db/database.js";
import { event, testConfig } from "./helpers.js";

const openDatabases: ContinuumDatabase[] = [];
const dataDirectories: string[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const directory of dataDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function database(): Promise<ContinuumDatabase> {
  const config = await testConfig();
  dataDirectories.push(config.dataDir);
  const result = new ContinuumDatabase(config.databasePath);
  openDatabases.push(result);
  return result;
}

function remoteOperation(overrides: Record<string, unknown>) {
  const now = Date.now();
  return {
    version: "1" as const,
    id: crypto.randomUUID(),
    deviceId: "remote-device-0001",
    sequence: 1,
    hlc: `${now + 10_000}:0:remote-device-0001`,
    entityType: "settings" as const,
    entityId: "models",
    payload: {
      activeCheckpointProvider: "ollama",
      activeChatProvider: "ollama",
      appleModel: "apple-system-default",
      ollamaModel: "remote-newer",
      openaiModel: "gpt-5.6-terra"
    },
    tombstone: false,
    occurredAt: new Date(now).toISOString(),
    ...overrides
  };
}

describe("live platform persistence invariants", () => {
  it("stores fixed privacy rule identifiers and keeps dedupe hashes out of audit entries", async () => {
    const db = await database();
    expect(db.auditPrivacy("terminal", "customer secret from rejected payload", "drop", 1, "event-sensitive-id")).toBe(true);
    expect(db.auditPrivacy("terminal", "another attacker-controlled value", "drop", 1, "event-sensitive-id")).toBe(false);
    expect(db.privacyAudit()).toEqual([
      expect.objectContaining({ source: "terminal", rule: "collector_rejection", action: "drop", count: 1 })
    ]);
    const columns = db.raw.prepare("PRAGMA table_info(privacy_audit)").all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).not.toContain("event_id");
    expect(JSON.stringify(db.raw.prepare("SELECT * FROM privacy_audit").all())).not.toContain("event-sensitive-id");
  });

  it("generates monotonic HLC values and applies mutable records by HLC rather than delivery order", async () => {
    const db = await database();
    vi.spyOn(Date, "now").mockReturnValue(1_784_558_000_000);
    const first = db.enqueueSyncOperation({ entityType: "device", entityId: "local-device-one", payload: {}, tombstone: false });
    const second = db.enqueueSyncOperation({ entityType: "device", entityId: "local-device-two", payload: {}, tombstone: false });
    expect(first.hlc.split(":").slice(0, 2)).toEqual(["1784558000000", "0"]);
    expect(second.hlc.split(":").slice(0, 2)).toEqual(["1784558000000", "1"]);

    vi.spyOn(Date, "now").mockRestore();
    const newer = remoteOperation({ sequence: 2 });
    const older = remoteOperation({
      id: crypto.randomUUID(),
      sequence: 1,
      hlc: `${BigInt(newer.hlc.split(":")[0]!) - 1n}:9:remote-device-0001`,
      payload: { ...newer.payload, ollamaModel: "remote-older" }
    });
    db.applySyncOperations([newer]);
    db.applySyncOperations([older]);
    expect(db.getModelSettings().ollamaModel).toBe("remote-newer");
  });

  it("scrubs expired event payloads from both SQLite events and the pending outbox", async () => {
    const db = await database();
    const source = event({ title: "RAW_EVENT_PAYLOAD_CANARY", privacy: { classification: "public", rules: ["test"] } });
    const accepted = {
      ...source,
      version: "2" as const,
      source: "vscode" as const,
      deviceId: db.deviceId(),
      hlc: `${Date.now()}:0:${db.deviceId()}`,
      projectId: crypto.randomUUID(),
      policyVersion: 1,
      syncEligibility: "cloud_eligible" as const
    };
    expect(db.insertEvent(accepted)).toBe(true);
    expect(db.purgeExpiredEvents(-1)).toBe(1);
    const row = db.raw.prepare("SELECT operation_json, tombstone FROM sync_outbox WHERE entity_type = 'event'").get() as { operation_json: string; tombstone: number };
    expect(row.tombstone).toBe(1);
    expect(row.operation_json).not.toContain("RAW_EVENT_PAYLOAD_CANARY");
    expect(JSON.parse(row.operation_json)).not.toHaveProperty("payload");
  });

  it("applies a shorter privacy retention period immediately", async () => {
    const db = await database();
    const source = event({ title: "RETENTION_TIGHTENING_CANARY" });
    expect(db.insertEvent({
      ...source,
      version: "2",
      source: "vscode",
      deviceId: db.deviceId(),
      hlc: `${Date.now()}:0:${db.deviceId()}`,
      projectId: crypto.randomUUID(),
      policyVersion: db.getPrivacyPolicy().revision,
      syncEligibility: "cloud_eligible"
    })).toBe(true);
    db.raw.prepare("UPDATE events SET received_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(), source.id);

    const current = db.getPrivacyPolicy();
    db.setPrivacyPolicy({
      ...current,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      retentionHours: 1
    });

    expect(db.raw.prepare("SELECT count(*) AS count FROM events WHERE id = ?").get(source.id)).toMatchObject({ count: 0 });
    const row = db.raw.prepare("SELECT operation_json, tombstone FROM sync_outbox WHERE entity_type = 'event' AND entity_id = ?")
      .get(source.id) as { operation_json: string; tombstone: number };
    expect(row.tombstone).toBe(1);
    expect(row.operation_json).not.toContain("RETENTION_TIGHTENING_CANARY");
  });

  it("expires an approved Chrome pairing if it was not redeemed within five minutes", async () => {
    const db = await database();
    const challenge = "a-valid-pairing-challenge-123456";
    const pairing = db.requestCollectorPairing("chrome", "chrome-client-0001", challenge);
    db.approveCollectorPairing(pairing.id);
    db.raw.prepare("UPDATE collector_pairings SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), pairing.id);
    expect(db.completeCollectorPairing(pairing.id, challenge)).toEqual({ status: "expired" });
  });

  it("backs up and removes legacy privacy-audit identifiers during migration", async () => {
    const config = await testConfig();
    dataDirectories.push(config.dataDir);
    const initial = new ContinuumDatabase(config.databasePath);
    expect(initial.insertEvent(event({ title: "MIGRATION_BACKUP_RAW_EVENT_CANARY" }))).toBe(true);
    initial.raw.exec("ALTER TABLE privacy_audit ADD COLUMN event_id TEXT");
    initial.raw.exec("DELETE FROM schema_migrations WHERE version >= 5");
    initial.close();

    const migrated = new ContinuumDatabase(config.databasePath);
    openDatabases.push(migrated);
    const columns = migrated.raw.prepare("PRAGMA table_info(privacy_audit)").all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).not.toContain("event_id");
    const files = await readdir(config.dataDir);
    const backupName = files.find((file) => file.startsWith("continuum.sqlite.backup-v4-"));
    expect(backupName).toBeTruthy();
    const backupPath = join(config.dataDir, backupName!);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    const backup = new ContinuumDatabase(backupPath, { readOnly: true });
    openDatabases.push(backup);
    expect(backup.raw.prepare("SELECT count(*) AS count FROM events").get()).toMatchObject({ count: 0 });
    expect(JSON.stringify(backup.raw.prepare("SELECT * FROM sync_outbox").all())).not.toContain("MIGRATION_BACKUP_RAW_EVENT_CANARY");
  });

  it("applies the ordered project-identity conflict migration from version five", async () => {
    const config = await testConfig();
    dataDirectories.push(config.dataDir);
    const initial = new ContinuumDatabase(config.databasePath);
    initial.raw.exec("DROP TABLE project_identity_conflicts; DELETE FROM schema_migrations WHERE version >= 6");
    initial.close();

    const migrated = new ContinuumDatabase(config.databasePath);
    openDatabases.push(migrated);
    const version = migrated.raw.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number };
    const table = migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_identity_conflicts'").get();
    expect(version.version).toBe(9);
    expect(table).toBeTruthy();
    const files = await readdir(config.dataDir);
    expect(files.some((file) => file.startsWith("continuum.sqlite.backup-v5-"))).toBe(true);
  });

  it("backs up and adds originating-device provenance to legacy checkpoints", async () => {
    const config = await testConfig();
    dataDirectories.push(config.dataDir);
    const initial = new ContinuumDatabase(config.databasePath);
    const projectId = crypto.randomUUID();
    const windowId = crypto.randomUUID();
    const checkpointId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    initial.ensureProject(projectId, "Legacy live project");
    initial.raw.prepare(`
      INSERT INTO windows(id, project_id, started_at, ended_at, status, provider, model, cloud_eligible, created_at)
      VALUES (?, ?, ?, ?, 'complete', 'ollama', 'gemma3n:e2b', 0, ?)
    `).run(windowId, projectId, createdAt, createdAt, createdAt);
    initial.raw.prepare(`
      INSERT INTO checkpoints(id, project_id, window_id, goal, focus, summary, importance, provider, model, checkpoint_json, created_at, device_id)
      VALUES (?, ?, ?, 'Preserve live context', 'Migration', 'Legacy checkpoint', 0.8, 'ollama', 'gemma3n:e2b', ?, ?, NULL)
    `).run(checkpointId, projectId, windowId, JSON.stringify({
      version: "1",
      id: checkpointId,
      projectId,
      windowId,
      eventIds: [crypto.randomUUID()],
      goal: "Preserve live context",
      focus: "Migration",
      summary: "Legacy checkpoint",
      progress: [],
      blockers: [],
      hypotheses: [],
      decisions: [],
      questions: [],
      entities: [],
      importance: 0.8,
      confidence: 1,
      provider: "ollama",
      model: "gemma3n:e2b",
      createdAt
    }), createdAt);
    initial.raw.exec("DELETE FROM schema_migrations WHERE version >= 7");
    initial.close();

    const migrated = new ContinuumDatabase(config.databasePath);
    openDatabases.push(migrated);
    const checkpoint = migrated.getCheckpoint(checkpointId);
    expect(checkpoint?.deviceId).toBe(migrated.deviceId());
    const row = migrated.raw.prepare("SELECT device_id FROM checkpoints WHERE id = ?").get(checkpointId) as { device_id: string };
    expect(row.device_id).toBe(migrated.deviceId());
    const files = await readdir(config.dataDir);
    expect(files.some((file) => file.startsWith("continuum.sqlite.backup-v6-"))).toBe(true);
  });

  it("atomically repairs a legacy local device ID without losing live provenance", async () => {
    const config = await testConfig();
    dataDirectories.push(config.dataDir);
    const initial = new ContinuumDatabase(config.databasePath, { deviceIdentityPath: config.deviceIdentityPath });
    const originalDeviceId = initial.deviceId();
    const legacyDeviceId = "legacy-device-identity";
    const projectId = crypto.randomUUID();
    const source = event({ projectId, title: "Preserve this live event" });
    initial.ensureProject(projectId, "Live identity migration project");
    expect(initial.insertEvent(source)).toBe(true);
    const windowId = initial.createWindow(projectId, [source], "ollama", "gemma3n:e2b", false);
    const checkpointId = crypto.randomUUID();
    initial.insertCheckpoint({
      version: "1",
      id: checkpointId,
      projectId,
      deviceId: originalDeviceId,
      windowId,
      eventIds: [source.id],
      goal: "Preserve live identity provenance",
      focus: "Device UUID migration",
      summary: "A live checkpoint must survive identity repair.",
      progress: [{ text: "Captured live context", eventIds: [source.id] }],
      blockers: [],
      hypotheses: [],
      decisions: [],
      questions: [],
      entities: [],
      importance: 0.8,
      confidence: 1,
      provider: "ollama",
      model: "gemma3n:e2b",
      createdAt: new Date().toISOString()
    });
    const aliasId = crypto.randomUUID();
    const now = new Date().toISOString();
    initial.raw.prepare(`
      INSERT INTO project_aliases(id, project_id, device_id, local_path_hash, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(aliasId, projectId, originalDeviceId, "a".repeat(64), "Live identity migration project", now, now);

    const checkpointRow = initial.raw.prepare("SELECT checkpoint_json FROM checkpoints WHERE id = ?")
      .get(checkpointId) as { checkpoint_json: string };
    const checkpointJson = JSON.parse(checkpointRow.checkpoint_json) as Record<string, unknown>;
    checkpointJson.deviceId = legacyDeviceId;
    initial.raw.prepare("UPDATE checkpoints SET device_id = ?, checkpoint_json = ? WHERE id = ?")
      .run(legacyDeviceId, JSON.stringify(checkpointJson), checkpointId);
    initial.raw.prepare("UPDATE events SET device_id = ? WHERE id = ?").run(legacyDeviceId, source.id);
    initial.raw.prepare("UPDATE project_aliases SET device_id = ? WHERE id = ?").run(legacyDeviceId, aliasId);
    initial.raw.prepare("UPDATE settings SET value = ? WHERE key = 'deviceId'").run(JSON.stringify(legacyDeviceId));
    initial.raw.exec("DELETE FROM schema_migrations WHERE version >= 9");
    await writeFile(config.deviceIdentityPath, `${legacyDeviceId}\n`, { mode: 0o600 });
    initial.close();

    const migrated = new ContinuumDatabase(config.databasePath, { deviceIdentityPath: config.deviceIdentityPath });
    openDatabases.push(migrated);
    const repairedDeviceId = migrated.deviceId();
    expect(repairedDeviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(repairedDeviceId).not.toBe(legacyDeviceId);
    expect((await readFile(config.deviceIdentityPath, "utf8")).trim()).toBe(repairedDeviceId);
    expect(migrated.raw.prepare("SELECT count(*) AS count FROM events WHERE id = ? AND device_id = ?").get(source.id, repairedDeviceId))
      .toMatchObject({ count: 1 });
    expect(migrated.getCheckpoint(checkpointId)).toMatchObject({ id: checkpointId, deviceId: repairedDeviceId });
    expect(migrated.raw.prepare("SELECT count(*) AS count FROM project_aliases WHERE id = ? AND device_id = ?").get(aliasId, repairedDeviceId))
      .toMatchObject({ count: 1 });
    expect(migrated.raw.prepare("SELECT max(version) AS version FROM schema_migrations").get()).toMatchObject({ version: 9 });
    const files = await readdir(config.dataDir);
    expect(files.some((file) => file.startsWith("continuum.sqlite.backup-v8-"))).toBe(true);
  });

  it("preserves project UUID versions one through eight during the live-only migration", async () => {
    const config = await testConfig();
    dataDirectories.push(config.dataDir);
    const initial = new ContinuumDatabase(config.databasePath, { deviceIdentityPath: config.deviceIdentityPath });
    const globalProjectIds = [
      "f47ac10b-58cc-1a2b-a567-0e02b2c3d479",
      "f47ac10b-58cc-2a2b-a567-0e02b2c3d479",
      "f47ac10b-58cc-3a2b-a567-0e02b2c3d479",
      "f47ac10b-58cc-4a2b-a567-0e02b2c3d479",
      "f47ac10b-58cc-5a2b-a567-0e02b2c3d479",
      "f47ac10b-58cc-6a2b-a567-0e02b2c3d479",
      "01890f2e-6c3a-7cc0-98b9-bd0c2c1a9a88",
      "f47ac10b-58cc-8a2b-a567-0e02b2c3d479"
    ];
    const legacyPathId = "legacy-path-derived-project";
    const ids = [...globalProjectIds, legacyPathId];
    for (const projectId of ids) {
      initial.ensureProject(projectId, projectId);
      expect(initial.insertEvent(event({ id: crypto.randomUUID(), projectId, title: `Live event for ${projectId}` }))).toBe(true);
    }
    initial.raw.exec("DELETE FROM schema_migrations WHERE version >= 3");
    initial.close();

    const migrated = new ContinuumDatabase(config.databasePath, { deviceIdentityPath: config.deviceIdentityPath });
    openDatabases.push(migrated);
    const projectIds = new Set((migrated.raw.prepare("SELECT id FROM projects").all() as Array<{ id: string }>).map(({ id }) => id));
    for (const projectId of globalProjectIds) expect(projectIds.has(projectId)).toBe(true);
    expect(projectIds.has(legacyPathId)).toBe(false);
    const migratedLegacy = migrated.raw.prepare("SELECT project_id FROM events WHERE title = ?")
      .get(`Live event for ${legacyPathId}`) as { project_id: string };
    expect(migratedLegacy.project_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});
