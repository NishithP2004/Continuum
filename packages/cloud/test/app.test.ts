import { describe, expect, it, vi } from "vitest";
import { createCloudApp } from "../src/app.js";
import { StaticAuthenticator, type Principal } from "../src/auth/authenticator.js";
import type { ContextDataSource } from "../src/context/data-source.js";
import type { PostgresStore } from "../src/db/postgres.js";
import { DeviceCredentialError, DeviceRevokedError } from "../src/db/postgres.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sseEvents(body: string): Array<Record<string, unknown>> {
  return body.split("\n\n").flatMap((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return data ? [JSON.parse(data) as Record<string, unknown>] : [];
  });
}

const principal: Principal = {
  accountId: "d21561a5-9ac6-4e4e-915a-a33f79a733be",
  subject: "auth0|tenant-a",
  clientId: "web",
  scopes: ["context:read", "sync:read", "sync:write", "devices:write", "keys:write"],
  token: "tenant-a-token",
  method: "oauth"
};

let writtenEntity: { type: string; id: string; payload: Record<string, unknown> } | undefined;
const store = {
  query: async () => ({ rows: [], rowCount: 0 }),
  purgeExpired: async () => ({ operations: 0, entities: 0 }),
  status: async (accountId: string) => ({ accountId, cursor: 4 }),
  push: async (_accountId: string, input: { operations: Array<{ id: string }> }) => ({ acceptedIds: input.operations.map((operation) => operation.id), duplicateIds: [], cursor: 5 }),
  pull: async () => ({ operations: [{ id: "remote-op-1" }], cursor: 6, hasMore: false }),
  listDevices: async () => [],
  listApiKeys: async () => [],
  authorizeOAuthDevice: async () => undefined,
  entityPayload: async () => null,
  entityPayloads: async () => [],
  entityCounts: async () => ({}),
  writeServerEntity: async (_accountId: string, type: string, id: string, payload: Record<string, unknown>) => {
    writtenEntity = { type, id, payload };
    return {};
  }
} as unknown as PostgresStore;

const context = {
  current: async (accountId: string) => ({ accountId, checkpointIds: [] }),
  timeline: async () => ({}), search: async () => ({}), resume: async () => ({}), diff: async () => ({}),
  graph: async () => ({ version: "1" as const, projectId: "", generatedAt: new Date().toISOString(), nodes: [], edges: [], nextCursor: null, truncated: false, degraded: true })
} satisfies ContextDataSource;

describe("cloud HTTP boundary", () => {
  it("publishes RFC 9728 metadata and requires scoped bearer auth", async () => {
    const app = createCloudApp({
      store,
      context,
      authenticator: new StaticAuthenticator((token) => token === principal.token ? principal : null),
      apiKeyPepper: "a-test-pepper-with-at-least-thirty-two-characters",
      auth0Issuer: "https://continuum.us.auth0.com/",
      publicBaseUrl: "https://continuum.example.com"
    });
    const metadata = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/mcp" });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({
      resource: "https://continuum.example.com/mcp",
      authorization_servers: ["https://continuum.us.auth0.com/"],
      scopes_supported: expect.arrayContaining(["context:read", "sync:write"])
    });
    const unauthorized = await app.inject({ method: "GET", url: "/v1/context/current" });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toContain("oauth-protected-resource/mcp");
    const authorized = await app.inject({ method: "GET", url: "/v1/context/current", headers: { authorization: `Bearer ${principal.token}` } });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({ accountId: principal.accountId, checkpointIds: [] });
    await app.close();
  });

  it("uses the live engine sync push/pull wire format", async () => {
    const app = createCloudApp({
      store,
      context,
      authenticator: new StaticAuthenticator((token) => token === principal.token ? principal : null),
      apiKeyPepper: "a-test-pepper-with-at-least-thirty-two-characters",
      auth0Issuer: "https://continuum.us.auth0.com/",
      publicBaseUrl: "https://continuum.example.com"
    });
    const operationId = "67df844d-dcff-4c20-af54-34a952727d3f";
    const deviceId = "device-live-01";
    const push = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers: { authorization: `Bearer ${principal.token}` },
      payload: {
        deviceId,
        operations: [{
          version: "1", id: operationId, deviceId, sequence: 1, hlc: `1760000000000:0:${deviceId}`,
          entityType: "checkpoint", entityId: "checkpoint-live-1", payload: { projectId: "project-live" },
          tombstone: false, occurredAt: "2026-07-20T10:00:00.000Z"
        }]
      }
    });
    expect(push.statusCode).toBe(200);
    expect(push.json()).toEqual({ acceptedIds: [operationId], duplicateIds: [], cursor: 5 });
    const pull = await app.inject({
      method: "POST",
      url: "/v1/sync/pull",
      headers: { authorization: `Bearer ${principal.token}` },
      payload: { deviceId, cursor: 5, limit: 200 }
    });
    expect(pull.statusCode).toBe(200);
    expect(pull.json()).toEqual({ operations: [{ id: "remote-op-1" }], nextCursor: 6, hasMore: false });
    await app.close();
  });

  it("binds API keys to one device and enforces OAuth device revocation", async () => {
    let binding: string | undefined;
    const authorizeApiKeyDevice = vi.fn(async (_accountId: string, _keyId: string, deviceId: string) => {
      if (binding && binding !== deviceId) throw new DeviceCredentialError("API key is bound to a different device");
      binding = deviceId;
    });
    const authorizeOAuthDevice = vi.fn(async (_accountId: string, deviceId: string) => {
      if (deviceId === "device-revoked") throw new DeviceRevokedError("device is revoked");
    });
    const pull = vi.fn(async () => ({ operations: [], cursor: 0, hasMore: false }));
    const boundStore = { ...store, authorizeApiKeyDevice, authorizeOAuthDevice, pull } as unknown as PostgresStore;
    const apiPrincipal: Principal = {
      ...principal,
      subject: "api-key:key-device-1",
      clientId: "key-device-1",
      credentialId: "key-device-1",
      token: "api-key-token",
      scopes: ["sync:read"],
      method: "api_key"
    };
    const app = createCloudApp({
      store: boundStore,
      context,
      authenticator: new StaticAuthenticator((token) => token === apiPrincipal.token ? apiPrincipal : token === principal.token ? principal : null),
      apiKeyPepper: "a-test-pepper-with-at-least-thirty-two-characters",
      auth0Issuer: "https://continuum.us.auth0.com/",
      publicBaseUrl: "https://continuum.example.com"
    });

    const first = await app.inject({
      method: "POST", url: "/v1/sync/pull",
      headers: { authorization: `Bearer ${apiPrincipal.token}` },
      payload: { deviceId: "device-a", cursor: 0, limit: 10 }
    });
    expect(first.statusCode).toBe(200);
    const wrongDevice = await app.inject({
      method: "POST", url: "/v1/sync/pull",
      headers: { authorization: `Bearer ${apiPrincipal.token}` },
      payload: { deviceId: "device-b", cursor: 0, limit: 10 }
    });
    expect(wrongDevice.statusCode).toBe(403);
    expect(wrongDevice.json()).toEqual({ error: "API key is bound to a different device" });
    expect(pull).toHaveBeenCalledOnce();

    const oauth = await app.inject({
      method: "POST", url: "/v1/sync/pull",
      headers: { authorization: `Bearer ${principal.token}` },
      payload: { deviceId: "device-oauth", cursor: 0, limit: 10 }
    });
    expect(oauth.statusCode).toBe(200);
    const revokedOauth = await app.inject({
      method: "POST", url: "/v1/sync/pull",
      headers: { authorization: `Bearer ${principal.token}` },
      payload: { deviceId: "device-revoked", cursor: 0, limit: 10 }
    });
    expect(revokedOauth.statusCode).toBe(403);
    expect(revokedOauth.json()).toEqual({ error: "device is revoked" });
    expect(authorizeApiKeyDevice).toHaveBeenCalledTimes(2);
    expect(authorizeOAuthDevice).toHaveBeenCalledTimes(2);
    expect(pull).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("allows privacy switches while forcing immutable protections on", async () => {
    writtenEntity = undefined;
    const app = createCloudApp({
      store,
      context,
      authenticator: new StaticAuthenticator((token) => token === principal.token ? principal : null),
      apiKeyPepper: "a-test-pepper-with-at-least-thirty-two-characters",
      auth0Issuer: "https://continuum.us.auth0.com/",
      publicBaseUrl: "https://continuum.example.com"
    });
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/settings/privacy",
      headers: { authorization: `Bearer ${principal.token}` },
      payload: {
        sources: { osWindows: true },
        immutableProtections: {
          secretDetection: false,
          attributeAllowlist: false,
          prohibitedContentExclusion: false,
          confidentialCloudBlock: false
        }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().policy.sources.osWindows).toBe(true);
    expect(response.json().policy.immutableProtections).toEqual({
      secretDetection: true,
      attributeAllowlist: true,
      prohibitedContentExclusion: true,
      confidentialCloudBlock: true
    });
    expect(writtenEntity).toMatchObject({ type: "privacy_policy", id: "current" });
    await app.close();
  });

  it("rejects an already-expired API key request as invalid input", async () => {
    const app = createCloudApp({
      store,
      context,
      authenticator: new StaticAuthenticator((token) => token === principal.token ? principal : null),
      apiKeyPepper: "a-test-pepper-with-at-least-thirty-two-characters",
      auth0Issuer: "https://continuum.us.auth0.com/",
      publicBaseUrl: "https://continuum.example.com"
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/api-keys",
      headers: { authorization: `Bearer ${principal.token}` },
      payload: {
        name: "Expired key",
        scopes: ["context:read"],
        expiresAt: "2020-01-01T00:00:00.000Z"
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "API key expiry must be in the future" });
    await app.close();
  });

  it("serves authenticated Streamable HTTP MCP initialization", async () => {
    const app = createCloudApp({
      store,
      context,
      authenticator: new StaticAuthenticator((token) => token === principal.token ? principal : null),
      apiKeyPepper: "a-test-pepper-with-at-least-thirty-two-characters",
      auth0Issuer: "https://continuum.us.auth0.com/",
      publicBaseUrl: "https://continuum.example.com"
    });
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${principal.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cloud-test", version: "1" } }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("continuum-remote");
    expect(response.body).toContain("2025-06-18");
    const tools = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${principal.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18"
      },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.body).toContain('"name":"resume"');
    await app.close();
  });

  it("accepts the PWA chat wire format and streams a grounded cited answer", async () => {
    const sessionId = "ef02f37d-4817-4404-a0f8-c336babead0d";
    const persisted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const chatStore = {
      ...store,
      entityPayload: async (_accountId: string, type: string, id: string) => type === "chat_session" && id === sessionId ? {
        version: "1", id: sessionId, projectId: "project-live", title: "Live context",
        createdAt: "2026-07-20T10:00:00.000Z", updatedAt: "2026-07-20T10:00:00.000Z", syncEligibility: "cloud_eligible"
      } : null,
      writeServerEntity: async (_accountId: string, type: string, _id: string, payload: Record<string, unknown>) => {
        persisted.push({ type, payload });
        return {};
      }
    } as unknown as PostgresStore;
    const chatContext = {
      ...context,
      resume: async () => ({
        version: "1",
        projectId: "project-live",
        currentFocus: "Repair remote authentication",
        checkpoints: [{
          id: "checkpoint-live-1", projectId: "project-live", focus: "Repair remote authentication",
          summary: "Audience validation passes", blockers: [{ text: "Pair another device", status: "open" }],
          decisions: [{ text: "Require the MCP audience" }], hypotheses: [{ text: "The mobile token uses an old audience" }],
          entities: [{ kind: "file", key: "packages/cloud/src/app.ts", label: "Cloud API" }]
        }]
      })
    } satisfies ContextDataSource;
    const app = createCloudApp({
      store: chatStore,
      context: chatContext,
      authenticator: new StaticAuthenticator((token) => token === principal.token ? principal : null),
      apiKeyPepper: "a-test-pepper-with-at-least-thirty-two-characters",
      auth0Issuer: "https://continuum.us.auth0.com/",
      publicBaseUrl: "https://continuum.example.com"
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/chat/sessions/${sessionId}/messages`,
      headers: { authorization: `Bearer ${principal.token}`, accept: "text/event-stream" },
      payload: { text: "Where did I leave off?" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('"type":"delta"');
    expect(response.body).toContain('"type":"citation"');
    expect(response.body).toContain('"type":"done"');
    expect(response.body).toContain("Audience validation passes");
    expect(response.body).toContain("checkpoint-live-1");
    expect(persisted).toHaveLength(2);
    expect(persisted.map((item) => item.payload.role)).toEqual(["user", "assistant"]);
    await app.close();
  });

  it("keeps a remote run cancellable while context is loading and never persists a completed assistant after accepting cancellation", async () => {
    const sessionId = "ef02f37d-4817-4404-a0f8-c336babead0d";
    const runId = "dbba3d52-cd68-4c7d-8f6f-1687d8737538";
    const pendingContext = deferred<Record<string, unknown>>();
    const writes = vi.fn(async () => ({}));
    const resume = vi.fn(() => pendingContext.promise);
    const cancellableStore = {
      ...store,
      entityPayload: async (_accountId: string, type: string, id: string) => type === "chat_session" && id === sessionId ? {
        version: "1", id: sessionId, projectId: "90743b58-3aa1-4850-a2a7-81079830df8c", title: "Live context",
        classification: "personal", createdAt: "2026-07-20T10:00:00.000Z", updatedAt: "2026-07-20T10:00:00.000Z",
        syncEligibility: "cloud_eligible"
      } : null,
      writeServerEntity: writes
    } as unknown as PostgresStore;
    const app = createCloudApp({
      store: cancellableStore,
      context: { ...context, resume } satisfies ContextDataSource,
      authenticator: new StaticAuthenticator((token) => token === principal.token ? principal : null),
      apiKeyPepper: "a-test-pepper-with-at-least-thirty-two-characters",
      auth0Issuer: "https://continuum.us.auth0.com/",
      publicBaseUrl: "https://continuum.example.com"
    });

    const responsePromise = app.inject({
      method: "POST", url: `/v1/chat/sessions/${sessionId}/messages`,
      headers: { authorization: `Bearer ${principal.token}`, accept: "text/event-stream" },
      payload: { text: "Where did I leave off?", runId }
    });
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    const cancellation = await app.inject({
      method: "POST", url: `/v1/chat/runs/${runId}/cancel`,
      headers: { authorization: `Bearer ${principal.token}` }
    });
    expect(cancellation.statusCode).toBe(200);
    expect(cancellation.json()).toEqual({ cancelled: true, runId });
    pendingContext.resolve({
      version: "1", projectId: "90743b58-3aa1-4850-a2a7-81079830df8c",
      checkpoints: [{ id: "checkpoint-live-1", focus: "Cancellation", summary: "This must not be persisted" }]
    });
    const response = await responsePromise;
    const events = sseEvents(response.body);
    expect(events.map((event) => event.type)).toEqual(["run_started", "cancelled"]);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(writes).not.toHaveBeenCalled();
    await app.close();
  });

  it("executes read actions immediately and requires confirmation for the bounded mutating action set", async () => {
    const sessionId = "ef02f37d-4817-4404-a0f8-c336babead0d";
    const projectId = "90743b58-3aa1-4850-a2a7-81079830df8c";
    const writes: Array<{ type: string; id: string; payload: Record<string, unknown> }> = [];
    const actionStore = {
      ...store,
      entityPayload: async (_accountId: string, type: string, id: string) => type === "chat_session" && id === sessionId ? {
        version: "1", id: sessionId, projectId, title: "Live context", classification: "personal",
        createdAt: "2026-07-20T10:00:00.000Z", updatedAt: "2026-07-20T10:00:00.000Z", syncEligibility: "cloud_eligible"
      } : null,
      writeServerEntity: async (_accountId: string, type: string, id: string, payload: Record<string, unknown>) => {
        writes.push({ type, id, payload });
        return {};
      }
    } as unknown as PostgresStore;
    const evidence = {
      version: "1", projectId, currentFocus: "Finish action safety",
      checkpoints: [{ id: "checkpoint-live-1", projectId, focus: "Finish action safety", summary: "Action boundary is explicit" }]
    };
    const diff = vi.fn(async () => ({ version: "1", projectId, changes: [{ type: "decision_added", text: "Confirm mutations" }], checkpointIds: ["checkpoint-live-1"] }));
    const actionContext = {
      ...context,
      resume: async () => evidence,
      diff,
      current: async () => ({
        version: "1",
        projectId,
        provenance: { checkpointIds: ["checkpoint-live-1"] }
      })
    } satisfies ContextDataSource;
    const app = createCloudApp({
      store: actionStore,
      context: actionContext,
      authenticator: new StaticAuthenticator((token) => token === principal.token ? principal : null),
      apiKeyPepper: "a-test-pepper-with-at-least-thirty-two-characters",
      auth0Issuer: "https://continuum.us.auth0.com/",
      publicBaseUrl: "https://continuum.example.com"
    });
    const authorization = { authorization: `Bearer ${principal.token}`, accept: "text/event-stream" };

    const readResponse = await app.inject({
      method: "POST", url: `/v1/chat/sessions/${sessionId}/messages`, headers: authorization,
      payload: { text: "What changed since my baseline?" }
    });
    const readAction = sseEvents(readResponse.body).find((event) => event.type === "action_result")?.action as Record<string, unknown>;
    expect(readAction).toMatchObject({ name: "get_diff", mutating: false, status: "completed" });
    expect(diff).toHaveBeenCalledOnce();

    const checkpointResponse = await app.inject({
      method: "POST", url: `/v1/chat/sessions/${sessionId}/messages`, headers: authorization,
      payload: { text: "Create a checkpoint now" }
    });
    const checkpointAction = sseEvents(checkpointResponse.body).find((event) => event.type === "action_proposed")?.action as Record<string, unknown>;
    expect(checkpointAction).toMatchObject({ name: "create_checkpoint", mutating: true, status: "proposed" });
    const writesBeforeUnavailableConfirmation = writes.length;
    const unavailable = await app.inject({
      method: "POST", url: `/v1/chat/actions/${String(checkpointAction.id)}/confirm`,
      headers: { authorization: `Bearer ${principal.token}` }, payload: {}
    });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toMatchObject({
      error: "paired_mac_required",
      action: { name: "create_checkpoint", status: "failed", result: { code: "paired_mac_required" } }
    });
    expect(writes).toHaveLength(writesBeforeUnavailableConfirmation);

    const baselineResponse = await app.inject({
      method: "POST", url: `/v1/chat/sessions/${sessionId}/messages`, headers: authorization,
      payload: { text: "Mark this checkpoint as my baseline" }
    });
    const baselineAction = sseEvents(baselineResponse.body).find((event) => event.type === "action_proposed")?.action as Record<string, unknown>;
    expect(baselineAction).toMatchObject({ name: "ack_baseline", mutating: true, status: "proposed" });
    expect(writes.filter((write) => write.type === "baseline")).toHaveLength(0);
    const confirmed = await app.inject({
      method: "POST", url: `/v1/chat/actions/${String(baselineAction.id)}/confirm`,
      headers: { authorization: `Bearer ${principal.token}` }, payload: {}
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ action: { name: "ack_baseline", status: "completed" } });
    expect(writes.filter((write) => write.type === "baseline")).toEqual([{
      type: "baseline", id: projectId, payload: { projectId, checkpointId: "checkpoint-live-1" }
    }]);
    await app.close();
  });

  it("rejects chat secrets before context lookup or persistence", async () => {
    const writes = vi.fn(async () => ({}));
    const resume = vi.fn(async () => ({}));
    const app = createCloudApp({
      store: { ...store, writeServerEntity: writes } as unknown as PostgresStore,
      context: { ...context, resume } satisfies ContextDataSource,
      authenticator: new StaticAuthenticator((token) => token === principal.token ? principal : null),
      apiKeyPepper: "a-test-pepper-with-at-least-thirty-two-characters",
      auth0Issuer: "https://continuum.us.auth0.com/",
      publicBaseUrl: "https://continuum.example.com"
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/sessions/ef02f37d-4817-4404-a0f8-c336babead0d/messages",
      headers: { authorization: `Bearer ${principal.token}` },
      payload: { text: "Use api_key=super-secret-value please" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "secret_rejected" });
    expect(writes).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    await app.close();
  });
});
