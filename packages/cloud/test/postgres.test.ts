import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { SyncOperationSchema, SyncPushSchema } from "../src/contracts.js";
import { defaultCloudPrivacyPolicy } from "../src/privacy.js";
import {
  assertImmutableEntityValue,
  DeviceCredentialError,
  DeviceRevokedError,
  PostgresStore,
  SyncConflictError
} from "../src/db/postgres.js";

describe("immutable synchronized entities", () => {
  const existing = { payload: { id: "checkpoint-1", summary: "Live summary", nested: { b: 2, a: 1 } }, tombstone: false };

  it("accepts idempotent content regardless of object key order", () => {
    expect(() => assertImmutableEntityValue("checkpoint", "checkpoint-1", existing, {
      tombstone: false,
      payload: { nested: { a: 1, b: 2 }, summary: "Live summary", id: "checkpoint-1" }
    })).not.toThrow();
  });

  it("rejects content replacement and resurrection under an immutable global ID", () => {
    expect(() => assertImmutableEntityValue("checkpoint", "checkpoint-1", existing, {
      tombstone: false,
      payload: { id: "checkpoint-1", summary: "Replacement" }
    })).toThrow(SyncConflictError);
    expect(() => assertImmutableEntityValue("event", "event-1", { payload: null, tombstone: true }, {
      tombstone: false,
      payload: { id: "event-1" }
    })).toThrow("immutable");
  });

  it("allows payload-free deletion tombstones", () => {
    expect(() => assertImmutableEntityValue("chat_message", "message-1", existing, { tombstone: true })).not.toThrow();
  });
});

describe("pull pagination", () => {
  it("filters the requesting device in SQL and advances past a self-only tail", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT * FROM sync_operations")) {
        expect(sql).toContain("device_id <> $4");
        expect(values).toEqual(["account-a", 7, 3, "device-a"]);
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("COALESCE(max(server_sequence)")) return { rows: [{ cursor: "12" }], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const store = new PostgresStore({ query } as unknown as Pool);
    await expect(store.pull("account-a", 7, 2, "device-a")).resolves.toEqual({ operations: [], cursor: 12, hasMore: false });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("keeps the delivered cursor while another non-self page remains", async () => {
    const row = (sequence: number) => ({
      server_sequence: sequence,
      id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      device_id: "device-b",
      device_sequence: sequence,
      hlc: `1760000000000:${sequence}:device-b`,
      entity_type: "checkpoint",
      entity_id: `checkpoint-${sequence}`,
      tombstone: false,
      payload: { id: `checkpoint-${sequence}` },
      occurred_at: new Date("2026-07-20T10:00:00.000Z"),
      received_at: new Date("2026-07-20T10:00:01.000Z")
    });
    const query = vi.fn(async () => ({ rows: [row(8), row(9), row(10)], rowCount: 3 }));
    const store = new PostgresStore({ query } as unknown as Pool);
    const page = await store.pull("account-a", 7, 2, "device-a");
    expect(page.operations.map((operation) => operation.serverSequence)).toEqual([8, 9]);
    expect(page).toMatchObject({ cursor: 9, hasMore: true });
    expect(query).toHaveBeenCalledOnce();
  });
});

describe("device-bound API keys", () => {
  function bindingStore(options: { boundDeviceId?: string; revoked?: boolean } = {}) {
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO devices")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT revoked_at FROM devices")) {
        return { rows: [{ revoked_at: options.revoked ? new Date() : null }], rowCount: 1 };
      }
      if (sql.includes("UPDATE api_keys SET device_id")) {
        return { rows: [{ device_id: options.boundDeviceId ?? "device-a" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE devices SET last_seen_at")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const store = new PostgresStore({ connect: async () => ({ query, release }) } as unknown as Pool);
    return { store, query, release };
  }

  it("atomically binds an unbound API key on its first sync use", async () => {
    const { store, query, release } = bindingStore();
    await expect(store.authorizeApiKeyDevice("account-a", "key-a", "device-a")).resolves.toBeUndefined();
    expect(query.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
    expect(query.mock.calls.map(([sql]) => sql)).not.toContain("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects reuse on another device and rolls the attempted binding back", async () => {
    const { store, query } = bindingStore({ boundDeviceId: "device-a" });
    await expect(store.authorizeApiKeyDevice("account-a", "key-a", "device-b"))
      .rejects.toThrow(DeviceCredentialError);
    expect(query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
  });

  it("will not bind a fresh credential to an already revoked device", async () => {
    const { store, query } = bindingStore({ revoked: true });
    await expect(store.authorizeApiKeyDevice("account-a", "key-a", "device-a"))
      .rejects.toThrow(DeviceRevokedError);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE api_keys SET device_id"))).toBe(false);
    expect(query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  });

  it("revokes the device and every credential bound to it in one statement", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ revoked: true }], rowCount: 1 }));
    const store = new PostgresStore({ query } as unknown as Pool);
    await expect(store.revokeDevice("account-a", "device-a")).resolves.toBe(true);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("UPDATE api_keys");
    expect(query.mock.calls[0]?.[0]).toContain("key.device_id = device.id");
    expect(query.mock.calls[0]?.[1]).toEqual(["account-a", "device-a"]);
  });
});

describe("OAuth device revocation", () => {
  it("registers a new OAuth device and rejects the same device after revocation", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ revoked_at: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ revoked_at: new Date("2026-07-20T10:00:00.000Z") }], rowCount: 1 });
    const store = new PostgresStore({ query } as unknown as Pool);

    await expect(store.authorizeOAuthDevice("account-a", "device-oauth-a")).resolves.toBeUndefined();
    await expect(store.authorizeOAuthDevice("account-a", "device-oauth-a")).rejects.toThrow(DeviceRevokedError);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (account_id, id)");
    expect(query.mock.calls[0]?.[1]).toEqual(["account-a", "device-oauth-a", "Continuum device-o"]);
  });
});

describe("transactional relationship validation", () => {
  it("rejects a checkpoint whose cited event is unavailable before writing any operation", async () => {
    const deviceId = "device-reference-test";
    const projectId = "b78a3b30-0f9c-45ec-86ab-e0ca2c6fdddc";
    const eventId = "67df844d-dcff-4c20-af54-34a952727d3f";
    const checkpointId = "b9c2faec-61a3-43ed-8cb1-6e34f23ee665";
    const operation = SyncOperationSchema.parse({
      version: "1",
      id: "b453dc3c-b27f-472a-bda4-7686255d1cc4",
      deviceId,
      sequence: 1,
      hlc: `1760000000000:0:${deviceId}`,
      entityType: "checkpoint",
      entityId: checkpointId,
      tombstone: false,
      payload: {
        version: "1",
        id: checkpointId,
        projectId,
        windowId: "window-reference-test",
        eventIds: [eventId],
        goal: "Validate evidence",
        focus: "Cloud relationship boundary",
        summary: "The checkpoint must cite synchronized project events.",
        progress: [{ text: "Checked evidence", eventIds: [eventId] }],
        blockers: [], hypotheses: [], decisions: [], questions: [], entities: [],
        importance: 0.5,
        confidence: 1,
        provider: "openai",
        model: "gpt-5.6-terra",
        createdAt: "2026-07-20T10:00:00.000Z"
      },
      occurredAt: "2026-07-20T10:00:00.000Z"
    });
    const input = SyncPushSchema.parse({ deviceId, operations: [operation] });
    const query = vi.fn(async (sql: string) => {
      if (["BEGIN", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO devices")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT last_sequence, last_hlc, revoked_at")) {
        return { rows: [{ last_sequence: "0", last_hlc: null, revoked_at: null }], rowCount: 1 };
      }
      if (sql.includes("FROM sync_operations")) return { rows: [], rowCount: 0 };
      if (sql.includes("entity_type = 'privacy_policy'")) {
        return { rows: [{ payload: defaultCloudPrivacyPolicy(new Date("2026-07-20T10:00:00.000Z")) }], rowCount: 1 };
      }
      if (sql.includes("SELECT entity_id, payload FROM sync_entities")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const store = new PostgresStore({ connect: async () => ({ query, release }) } as unknown as Pool);

    await expect(store.push("account-a", input)).rejects.toThrow("checkpoint evidence event is unavailable");
    expect(query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO sync_operations"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("per-device operation ordering", () => {
  it("rejects an HLC that does not advance with the device sequence", async () => {
    const deviceId = "device-clock-test";
    const operation = SyncOperationSchema.parse({
      version: "1",
      id: "a2b54745-1090-45fe-b335-4be54c31fb6c",
      deviceId,
      sequence: 2,
      hlc: `1760000000000:0:${deviceId}`,
      entityType: "device",
      entityId: deviceId,
      tombstone: false,
      payload: { displayName: "Continuum Mac", lastSeenAt: "2026-07-20T10:00:00.000Z" },
      occurredAt: "2026-07-20T10:00:00.000Z"
    });
    const query = vi.fn(async (sql: string) => {
      if (["BEGIN", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO devices")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT last_sequence, last_hlc, revoked_at")) {
        return {
          rows: [{ last_sequence: "1", last_hlc: `1760000000001:0:${deviceId}`, revoked_at: null }],
          rowCount: 1
        };
      }
      if (sql.includes("FROM sync_operations")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const store = new PostgresStore({ connect: async () => ({ query, release }) } as unknown as Pool);

    await expect(store.push("account-a", SyncPushSchema.parse({ deviceId, operations: [operation] })))
      .rejects.toThrow("device HLC must increase");
    expect(query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO sync_operations"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("turns an ambiguous stricter-policy retry into a new cursor-visible server tombstone", async () => {
    const deviceId = "device-redaction-test";
    const operationId = "7d3846bf-85f2-474a-9f70-13a060a5a2e0";
    const occurredAt = "2026-07-20T10:00:00.000Z";
    const incoming = SyncOperationSchema.parse({
      version: "1",
      id: operationId,
      deviceId,
      sequence: 1,
      hlc: `1760000000000:0:${deviceId}`,
      entityType: "settings",
      entityId: "models",
      tombstone: true,
      occurredAt
    });
    const insertedOperations: unknown[][] = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO devices")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT last_sequence, last_hlc, revoked_at")) {
        return { rows: [{ last_sequence: "1", last_hlc: incoming.hlc, revoked_at: null }], rowCount: 1 };
      }
      if (sql.includes("FROM sync_operations") && sql.includes("device_sequence")) {
        return {
          rows: [{
            id: operationId,
            device_id: deviceId,
            device_sequence: "1",
            hlc: incoming.hlc,
            entity_type: "settings",
            entity_id: "models",
            tombstone: false,
            payload: { activeChatProvider: "openai" },
            occurred_at: new Date(occurredAt)
          }],
          rowCount: 1
        };
      }
      if (sql.includes("SELECT tombstone, hlc FROM sync_entities")) {
        return { rows: [{ tombstone: false, hlc: incoming.hlc }], rowCount: 1 };
      }
      if (sql.includes("SELECT last_sequence, last_hlc FROM devices")) {
        return { rows: [{ last_sequence: "4", last_hlc: "1760000000001:0:continuum-cloud-account-a" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO sync_operations")) {
        insertedOperations.push(values ?? []);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO sync_entities") || sql.includes("INSERT INTO projection_outbox") || sql.includes("UPDATE devices SET")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("COALESCE(max(server_sequence)")) return { rows: [{ cursor: "9" }], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const store = new PostgresStore({ connect: async () => ({ query, release }) } as unknown as Pool);

    await expect(store.push("account-a", SyncPushSchema.parse({ deviceId, operations: [incoming] }))).resolves.toEqual({
      acceptedIds: [],
      duplicateIds: [operationId],
      cursor: 9
    });
    expect(insertedOperations).toHaveLength(1);
    expect(insertedOperations[0]?.[5]).toBe("settings");
    expect(insertedOperations[0]?.[6]).toBe("models");
    expect(insertedOperations[0]?.[7]).toBe(true);
    expect(insertedOperations[0]?.[8]).toBeNull();
    expect(query.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("expiry and projection durability", () => {
  it("retains expired projected entities and operations while their outbox job is pending", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 });
    const store = new PostgresStore({ query } as unknown as Pool);

    await expect(store.purgeExpired()).resolves.toEqual({ operations: 3, entities: 2 });
    expect(query.mock.calls[0]?.[0]).toContain("outbox.processed_at IS NULL");
    expect(query.mock.calls[1]?.[0]).toContain("outbox.processed_at IS NULL");
    expect(query.mock.calls[0]?.[0]).toContain("entity.entity_type = 'event'");
    expect(query.mock.calls[1]?.[0]).toContain("operation.entity_type = 'event'");
  });

  it("reports projection degradation whenever the account still has pending jobs", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        cursor: "18",
        devices: "2",
        pending: "3",
        degraded: false,
        last_error: null,
        last_projected_at: null
      }],
      rowCount: 1
    }));
    const store = new PostgresStore({ query } as unknown as Pool);

    await expect(store.status("account-a")).resolves.toMatchObject({
      projection: { degraded: true, pending: 3 }
    });
  });

  it("keeps projection state degraded after a success while other work remains", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 1 }));
    const store = new PostgresStore({ query } as unknown as Pool);
    await store.projectionSucceeded({
      outboxId: 7,
      accountId: "account-a",
      operationId: "operation-a",
      entityType: "graph_node",
      entityId: "node-a",
      tombstone: false,
      payload: { label: "A" }
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(query).toHaveBeenCalledOnce();
    expect(sql).toContain("processed_at IS NULL AND id <> $2");
    expect(sql).toContain("WHEN EXCLUDED.degraded THEN COALESCE");
    expect(query.mock.calls[0]?.[1]).toEqual(["account-a", 7]);
  });

  it("reconciles stored health from the complete outstanding account queue", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 1 }));
    const store = new PostgresStore({ query } as unknown as Pool);
    await store.reconcileProjectionState(["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"]);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([["11111111-1111-4111-8111-111111111111"]]);
    expect(query.mock.calls[0]?.[0]).toContain("count(outbox.id) FILTER (WHERE outbox.processed_at IS NULL)");
  });
});

describe("account event retention", () => {
  const accountId = "11111111-1111-4111-8111-111111111111";
  const deviceId = "device-retention-test";
  const eventId = "22222222-2222-4222-8222-222222222222";
  const operationId = "33333333-3333-4333-8333-333333333333";

  function eventOperation(eventDeviceId = deviceId) {
    const occurredAt = "2026-07-20T10:00:00.000Z";
    const hlc = `1784541600000:0:${eventDeviceId}`;
    return SyncOperationSchema.parse({
      version: "1",
      id: operationId,
      deviceId: eventDeviceId,
      sequence: 1,
      hlc,
      entityType: "event",
      entityId: eventId,
      tombstone: false,
      payload: {
        version: "2",
        id: eventId,
        deviceId: eventDeviceId,
        occurredAt,
        hlc,
        source: "vscode",
        eventType: "file.saved",
        projectId: "44444444-4444-4444-8444-444444444444",
        title: "Saved source file",
        attributes: { relativePath: "src/live.ts" },
        privacy: { classification: "public", rules: ["adapter_allowlist_v1"] },
        relevance: { decision: "keep", reason: "trusted workspace save" },
        confidence: 0.98,
        policyVersion: 3,
        syncEligibility: "cloud_eligible"
      },
      occurredAt
    });
  }

  it("uses the current account retention window for device-pushed event rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    try {
      const policy = { ...defaultCloudPrivacyPolicy(), retentionHours: 3 };
      const expiries: unknown[] = [];
      const operation = eventOperation();
      const query = vi.fn(async (sql: string, values?: unknown[]) => {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
        if (sql.includes("INSERT INTO devices")) return { rows: [], rowCount: 1 };
        if (sql.includes("SELECT last_sequence, last_hlc, revoked_at")) {
          return { rows: [{ last_sequence: "0", last_hlc: null, revoked_at: null }], rowCount: 1 };
        }
        if (sql.includes("FROM sync_operations") && sql.includes("device_sequence")) return { rows: [], rowCount: 0 };
        if (sql.includes("entity_type = 'privacy_policy'")) return { rows: [{ payload: policy }], rowCount: 1 };
        if (sql.includes("SELECT payload, tombstone FROM sync_entities")) return { rows: [], rowCount: 0 };
        if (sql.includes("INSERT INTO sync_operations")) {
          expiries.push(values?.[10]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO sync_entities")) {
          expiries.push(values?.[8]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO projection_outbox") || sql.includes("UPDATE devices SET")) return { rows: [], rowCount: 1 };
        if (sql.includes("COALESCE(max(server_sequence)")) return { rows: [{ cursor: "1" }], rowCount: 1 };
        throw new Error(`unexpected query: ${sql}`);
      });
      const release = vi.fn();
      const store = new PostgresStore({ connect: async () => ({ query, release }) } as unknown as Pool);

      await store.push(accountId, SyncPushSchema.parse({ deviceId, operations: [operation] }));
      expect(expiries).toEqual(["2026-07-20T13:00:00.000Z", "2026-07-20T13:00:00.000Z"]);
      expect(query.mock.calls.find(([sql]) => sql.includes("pg_advisory_xact_lock"))?.[1]).toEqual([accountId]);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a queued device event that is already outside the current retention window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    try {
      const strict = { ...defaultCloudPrivacyPolicy(), retentionHours: 1 };
      const query = vi.fn(async (sql: string) => {
        if (["BEGIN", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes("pg_advisory_xact_lock") || sql.includes("INSERT INTO devices")) return { rows: [], rowCount: 1 };
        if (sql.includes("SELECT last_sequence, last_hlc, revoked_at")) {
          return { rows: [{ last_sequence: "0", last_hlc: null, revoked_at: null }], rowCount: 1 };
        }
        if (sql.includes("FROM sync_operations") && sql.includes("device_sequence")) return { rows: [], rowCount: 0 };
        if (sql.includes("entity_type = 'privacy_policy'")) return { rows: [{ payload: strict }], rowCount: 1 };
        if (sql.includes("SELECT payload, tombstone FROM sync_entities")) return { rows: [], rowCount: 0 };
        throw new Error(`unexpected query: ${sql}`);
      });
      const release = vi.fn();
      const store = new PostgresStore({ connect: async () => ({ query, release }) } as unknown as Pool);

      await expect(store.push(accountId, SyncPushSchema.parse({ deviceId, operations: [eventOperation()] })))
        .rejects.toThrow("older than the current account retention policy");
      expect(query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
      expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO sync_operations("))).toBe(false);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the current account retention window for server-authored event rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    try {
      const serverDeviceId = `continuum-cloud-${accountId}`;
      const policy = { ...defaultCloudPrivacyPolicy(), retentionHours: 3 };
      const operation = eventOperation(serverDeviceId);
      const expiries: unknown[] = [];
      const query = vi.fn(async (sql: string, values?: unknown[]) => {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
        if (sql.includes("INSERT INTO devices")) return { rows: [], rowCount: 1 };
        if (sql.includes("SELECT last_sequence, last_hlc FROM devices")) return { rows: [{ last_sequence: "0", last_hlc: null }], rowCount: 1 };
        if (sql.includes("SELECT hlc FROM sync_entities")) return { rows: [], rowCount: 0 };
        if (sql.includes("entity_type = 'privacy_policy'")) return { rows: [{ payload: policy }], rowCount: 1 };
        if (sql.includes("SELECT payload, tombstone FROM sync_entities")) return { rows: [], rowCount: 0 };
        if (sql.includes("INSERT INTO sync_operations")) {
          expiries.push(values?.[10]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO sync_entities")) {
          expiries.push(values?.[8]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO projection_outbox") || sql.includes("UPDATE devices SET")) return { rows: [], rowCount: 1 };
        throw new Error(`unexpected query: ${sql}`);
      });
      const release = vi.fn();
      const store = new PostgresStore({ connect: async () => ({ query, release }) } as unknown as Pool);
      await store.writeServerEntity(accountId, "event", eventId, operation.payload as Record<string, unknown>);

      expect(expiries).toEqual(["2026-07-20T13:00:00.000Z", "2026-07-20T13:00:00.000Z"]);
      expect(query.mock.calls.find(([sql]) => sql.includes("pg_advisory_xact_lock"))?.[1]).toEqual([accountId]);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits payload-free tombstones and redacts stale event payload operations when policy tightens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
    try {
      const strict = { ...defaultCloudPrivacyPolicy(), revision: 2, retentionHours: 1 };
      const inserted: unknown[][] = [];
      let staleReads = 0;
      let deviceStateReads = 0;
      const query = vi.fn(async (sql: string, values?: unknown[]) => {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
        if (sql.includes("INSERT INTO devices")) return { rows: [], rowCount: 1 };
        if (sql.includes("SELECT last_sequence, last_hlc FROM devices")) {
          deviceStateReads += 1;
          return { rows: [{ last_sequence: deviceStateReads === 1 ? "0" : "1", last_hlc: null }], rowCount: 1 };
        }
        if (sql.includes("SELECT hlc FROM sync_entities")) return { rows: [], rowCount: 0 };
        if (sql.includes("entity_type = 'privacy_policy'") && sql.includes("SELECT payload")) return { rows: [{ payload: strict }], rowCount: 1 };
        if (sql.includes("SELECT entity_id FROM sync_entities")) {
          staleReads += 1;
          return staleReads === 1 ? { rows: [{ entity_id: eventId }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (sql.includes("SELECT tombstone, hlc FROM sync_entities")) {
          return { rows: [{ tombstone: false, hlc: `1784534400000:0:${deviceId}` }], rowCount: 1 };
        }
        if (sql.includes("SELECT payload, tombstone FROM sync_entities")) {
          return { rows: [{ payload: eventOperation().payload, tombstone: false }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO sync_operations")) {
          inserted.push(values ?? []);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO sync_entities") || sql.includes("INSERT INTO projection_outbox") || sql.includes("UPDATE devices SET")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("UPDATE sync_operations SET") && sql.includes("payload = NULL")) {
          expect(values).toEqual([accountId, 1]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("UPDATE sync_operations AS operation") || sql.includes("UPDATE sync_entities AS entity")) {
          expect(values).toEqual([accountId, 1]);
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected query: ${sql}`);
      });
      const release = vi.fn();
      const store = new PostgresStore({ connect: async () => ({ query, release }) } as unknown as Pool);
      await store.writeServerEntity(accountId, "privacy_policy", "current", strict);

      const tombstone = inserted.find((values) => values[5] === "event");
      expect(tombstone?.[6]).toBe(eventId);
      expect(tombstone?.[7]).toBe(true);
      expect(tombstone?.[8]).toBeNull();
      expect(query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM projection_outbox"))).toBe(false);
      expect(query.mock.calls.findIndex(([sql]) => String(sql).includes("UPDATE devices SET")))
        .toBeLessThan(query.mock.calls.findIndex(([sql]) => String(sql).includes("SELECT entity_id FROM sync_entities")));
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server-authored operation clocks", () => {
  it("advances beyond both the cloud device clock and the current entity clock", async () => {
    const entityHlc = "9999999999999999998:7:remote-device";
    let insertedHlc = "";
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO devices")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT last_sequence, last_hlc FROM devices")) {
        return { rows: [{ last_sequence: "2", last_hlc: "1760000000000:0:continuum-cloud-account-a" }], rowCount: 1 };
      }
      if (sql.includes("SELECT hlc FROM sync_entities")) return { rows: [{ hlc: entityHlc }], rowCount: 1 };
      if (sql.includes("entity_type = 'privacy_policy'")) {
        return { rows: [{ payload: defaultCloudPrivacyPolicy(new Date("2026-07-20T10:00:00.000Z")) }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO sync_operations")) {
        insertedHlc = String(values?.[4]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO sync_entities") || sql.includes("INSERT INTO projection_outbox") || sql.includes("UPDATE devices SET")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const store = new PostgresStore({ connect: async () => ({ query, release }) } as unknown as Pool);

    await store.writeServerEntity("account-a", "settings", "models", {
      activeCheckpointProvider: "ollama",
      activeChatProvider: "ollama",
      appleModel: "apple-system-default",
      ollamaModel: "gemma3n:e2b",
      openaiModel: "gpt-5.6-terra"
    });

    expect(insertedHlc).toBe("9999999999999999998:8:continuum-cloud-account-a");
    expect(query.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });
});
