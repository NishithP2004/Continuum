import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { ContinuumDatabase } from "../src/db/database.js";
import { SyncClient } from "../src/sync/client.js";
import { testConfig } from "./helpers.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("background synchronization", () => {
  it("persists only the remote endpoint and keeps session credentials in memory", async () => {
    const config = await testConfig();
    const database = new ContinuumDatabase(config.databasePath);
    const first = new SyncClient(database, {});
    const status = first.configure({
      endpoint: "https://sync.example.test/",
      accessToken: "temporary-oauth-access-token"
    });
    expect(status).toMatchObject({ configured: true, authenticated: true, endpoint: "https://sync.example.test" });
    expect(database.syncEndpoint()).toBe("https://sync.example.test");
    expect(JSON.stringify(database.raw.prepare("SELECT key, value FROM settings").all())).not.toContain("temporary-oauth-access-token");
    first.close();

    const restored = new SyncClient(database, {});
    expect(restored.status()).toMatchObject({ configured: true, authenticated: false, endpoint: "https://sync.example.test" });
    restored.close();
    database.close();
    await rm(config.dataDir, { recursive: true, force: true });
  });

  it("rejects remote endpoints containing credentials, query strings, or fragments", async () => {
    const config = await testConfig();
    const database = new ContinuumDatabase(config.databasePath);
    const client = new SyncClient(database, {});
    for (const endpoint of [
      "https://user:password@sync.example.test",
      "https://sync.example.test?access_token=secret",
      "https://sync.example.test/#secret"
    ]) {
      expect(() => client.configure({ endpoint })).toThrow(/credentials, a query, or a fragment/);
    }
    expect(database.syncEndpoint()).toBeUndefined();
    client.close();
    database.close();
    await rm(config.dataDir, { recursive: true, force: true });
  });

  it("pushes eligible operations, pulls by numeric cursor, and applies remote operations idempotently", async () => {
    const config = await testConfig();
    const database = new ContinuumDatabase(config.databasePath);
    const local = database.enqueueSyncOperation({
      entityType: "device",
      entityId: database.deviceId(),
      payload: { displayName: "Local Mac", lastSeenAt: new Date().toISOString() },
      tombstone: false
    });
    const remoteOccurredAt = new Date().toISOString();
    const remote = {
      version: "1" as const,
      id: crypto.randomUUID(),
      deviceId: "remote-device-0001",
      sequence: 1,
      hlc: `${Date.now()}:0:remote-device-0001`,
      entityType: "device" as const,
      entityId: "remote-device-0001",
      payload: { displayName: "Remote Mac", lastSeenAt: remoteOccurredAt },
      tombstone: false,
      occurredAt: remoteOccurredAt
    };
    const requests: Array<{ url: string; body?: Record<string, unknown>; authorization?: string }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ url, ...(body ? { body } : {}), authorization: new Headers(init?.headers).get("authorization") ?? undefined });
      if (url.endsWith("/v1/sync/push")) {
        const operationIds = Array.isArray(body?.operations)
          ? body.operations.map((operation) => (operation as { id: string }).id)
          : [local.id];
        return Response.json({ acceptedIds: operationIds, duplicateIds: [], cursor: 1 });
      }
      return Response.json({ operations: [remote], nextCursor: 5, hasMore: false });
    }) as typeof fetch;

    const client = new SyncClient(database, { syncUrl: "https://sync.example.test", syncToken: "ctm_test_secret" });
    const status = await client.reconnect();
    expect(status).toMatchObject({ configured: true, connected: true, pendingOperations: 0, cursor: "5" });
    expect(requests[0]?.authorization).toBe("Bearer ctm_test_secret");
    expect(requests[0]?.body).toMatchObject({
      deviceId: database.deviceId(),
      device: {
        name: `Continuum Mac ${database.deviceId().slice(0, 8)}`,
        platform: "macos"
      }
    });
    expect((requests[0]?.body?.device as { capabilities?: unknown })?.capabilities).toEqual(expect.any(Array));
    expect(requests[1]?.body).toMatchObject({ cursor: 0, limit: 500 });
    expect(database.applySyncOperations([remote])).toEqual({ applied: 0, duplicate: 1 });
    expect(database.raw.prepare("SELECT display_name FROM device_state WHERE id = ?").get(remote.deviceId)).toMatchObject({ display_name: "Remote Mac" });

    client.close();
    database.close();
    await rm(config.dataDir, { recursive: true, force: true });
  });
});
