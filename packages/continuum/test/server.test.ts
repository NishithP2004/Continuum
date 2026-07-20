import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { Engine } from "../src/server/engine.js";
import { createEngine } from "../src/server/engine.js";
import { buildApp } from "../src/server/app.js";
import { event, testConfig } from "./helpers.js";
import { DeterministicTestProvider } from "./deterministic-provider.js";
import { OpenAIProvider } from "../src/providers/openai.js";

describe("daemon API", () => {
  let engine: Engine;
  let app: FastifyInstance;
  let dataDir: string;
  const authorization = { authorization: "Bearer test-token" };
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    process.env.CONTINUUM_DISABLE_EMBEDDINGS = "1";
    const config = await testConfig();
    config.openaiApiKey = "test-key";
    dataDir = config.dataDir;
    engine = await createEngine(config);
    app = await buildApp(engine);
  });

  afterEach(async () => {
    await app.close();
    engine.close();
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.CONTINUUM_DISABLE_EMBEDDINGS;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("keeps health public and protects data routes", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/state" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/state", headers: authorization })).statusCode).toBe(200);
  });

  it("configures remote sync in memory without returning or persisting the access token", async () => {
    const accessToken = "oauth-access-token-that-must-stay-in-memory";
    const configured = await app.inject({
      method: "PATCH",
      url: "/v1/settings/sync",
      headers: authorization,
      payload: { endpoint: "https://continuum.example.test/", accessToken }
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json().sync).toMatchObject({
      configured: true,
      authenticated: true,
      endpoint: "https://continuum.example.test"
    });
    expect(configured.body).not.toContain(accessToken);
    expect(engine.database.syncEndpoint()).toBe("https://continuum.example.test");
    expect(JSON.stringify(engine.database.raw.prepare("SELECT key, value FROM settings").all())).not.toContain(accessToken);

    const disconnected = await app.inject({
      method: "PATCH",
      url: "/v1/settings/sync",
      headers: authorization,
      payload: { disconnect: true }
    });
    expect(disconnected.json().sync).toMatchObject({ configured: true, authenticated: false, connected: false });
    expect(disconnected.body).not.toContain(accessToken);

    const insecure = await app.inject({
      method: "PATCH",
      url: "/v1/settings/sync",
      headers: authorization,
      payload: { endpoint: "http://continuum.example.test", accessToken }
    });
    expect(insecure.statusCode).toBe(400);
    expect(insecure.json().error).toBe("invalid_sync_settings");
  });

  it("deduplicates accepted events and audits secrets", async () => {
    const accepted = event({ id: "40000000-0000-4000-8000-000000000001", dedupeKey: "same-event" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { ...authorization, "content-type": "application/json" },
      payload: { events: [accepted, accepted, event({ id: "40000000-0000-4000-8000-000000000002", privacy: { classification: "secret", rules: [] } })] }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: 1, duplicate: 1, dropped: 1, secret: 1 });
  });

  it("starts empty and establishes a live active-project lease", async () => {
    const initial = (await app.inject({ method: "GET", url: "/v1/state", headers: authorization })).json();
    expect(initial).toMatchObject({ eventCount: 0, checkpointCount: 0, activeProject: null });
    expect((await app.inject({ method: "POST", url: "/v1/demo/replay", headers: authorization, payload: {} })).statusCode).toBe(404);

    const live = event({ eventType: "vscode.editor_focus", attributes: { workspace: "continuum-live", path: "src/index.ts" } });
    const ingestion = await app.inject({ method: "POST", url: "/v1/events/batch", headers: authorization, payload: { events: [live] } });
    const projectId = ingestion.json().projectIds[0] as string;
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/i);
    const active = (await app.inject({ method: "GET", url: "/v1/projects/active", headers: authorization })).json();
    expect(active.lease).toMatchObject({ projectId, source: "vscode", projectName: "continuum-live" });
    const leaseExpiry = active.lease.expiresAt;

    const deviceId = engine.database.deviceId();
    const osEvent = {
      version: "2",
      id: crypto.randomUUID(),
      deviceId,
      occurredAt: new Date().toISOString(),
      hlc: `${Date.now()}:0:${deviceId}`,
      source: "os",
      eventType: "app_activated",
      title: "Terminal app activated",
      attributes: { bundleId: "com.apple.Terminal", appName: "Terminal", action: "app_activated" },
      privacy: { classification: "personal", rules: ["native_allowlist"] },
      relevance: { decision: "keep", reason: "native_os_metadata" },
      confidence: 0.7,
      dedupeKey: `os-app-${crypto.randomUUID()}`,
      policyVersion: 1,
      syncEligibility: "local_only"
    };
    const osIngestion = await app.inject({ method: "POST", url: "/v1/events/batch", headers: authorization, payload: { events: [osEvent] } });
    expect(osIngestion.json().projectIds).toContain(projectId);
    expect(engine.database.recentEvents(projectId).some((candidate) => candidate.source === "os")).toBe(true);
    expect(engine.database.activeProjectLease()?.expiresAt).toBe(leaseExpiry);

    const graph = await app.inject({ method: "POST", url: "/v1/graph/query", headers: authorization, payload: { projectId } });
    expect(graph.statusCode).toBe(200);
    expect(graph.json()).toMatchObject({ projectId, nodes: [], edges: [] });
  });

  it("lists ambiguous clone identities and requires an explicit candidate confirmation", async () => {
    const fingerprint = "f".repeat(64);
    const firstProjectId = "21c06809-b799-4fc1-8865-07d310fa9fb5";
    const secondProjectId = "72de67f6-1597-4ba3-8981-d30d25ef170f";
    engine.database.resolveProjectIdentity(firstProjectId, "Continuum", fingerprint, "device-a");
    engine.database.resolveProjectIdentity(secondProjectId, "Continuum", fingerprint, "device-b");
    const resolution = engine.database.resolveProjectIdentity("a".repeat(64), "Continuum", fingerprint, "device-c");
    expect(resolution).toMatchObject({ status: "ambiguous", candidateProjectIds: [firstProjectId, secondProjectId] });

    const listed = await app.inject({
      method: "GET",
      url: "/v1/projects/identity/conflicts",
      headers: authorization
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().conflicts).toHaveLength(1);
    expect(listed.json().conflicts[0]).toMatchObject({ id: resolution.conflictId, status: "pending" });

    const invalid = await app.inject({
      method: "POST",
      url: `/v1/projects/identity/conflicts/${resolution.conflictId}/confirm`,
      headers: authorization,
      payload: { targetProjectId: "ba103731-da2f-4705-ae59-8f4a01e6ee46" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("invalid_project_identity_target");

    const confirmed = await app.inject({
      method: "POST",
      url: `/v1/projects/identity/conflicts/${resolution.conflictId}/confirm`,
      headers: authorization,
      payload: { targetProjectId: firstProjectId }
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().conflict).toMatchObject({ status: "confirmed", confirmedProjectId: firstProjectId });

    const pending = await app.inject({
      method: "GET",
      url: "/v1/projects/identity/conflicts",
      headers: authorization
    });
    expect(pending.json()).toEqual({ conflicts: [] });
    expect(engine.database.resolveProjectIdentity("a".repeat(64), "Continuum", fingerprint, "device-c"))
      .toMatchObject({ status: "resolved", projectId: firstProjectId, matchedBy: "local_alias" });
  });

  it("refuses a GPT briefing when any diff checkpoint is local-only", async () => {
    const local = event({ privacy: { classification: "confidential", rules: ["test"] } });
    const ingestion = await engine.pipeline.ingest({ events: [local] });
    const projectId = ingestion.projectIds[0]!;
    await engine.pipeline.flush(projectId, new DeterministicTestProvider());
    engine.database.setModelSettings({ activeCheckpointProvider: "openai", ollamaModel: "gemma3n:e2b", openaiModel: "gpt-5.6-terra" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/diff/briefing",
      headers: { ...authorization, "content-type": "application/json" },
      payload: { projectId }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("local_only_evidence");
    expect(response.json().message).toMatch(/local-only evidence/);
  });

  it("requires active cloud consent before GPT briefing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/diff/briefing",
      headers: { ...authorization, "content-type": "application/json" },
      payload: { projectId: "continuum-demo" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("cloud_provider_not_selected");
  });

  it("turns collector aggregate events into deduplicated audit-only counters", async () => {
    const aggregate = event({
      id: "40000000-0000-4000-8000-000000000003",
      source: "terminal",
      eventType: "privacy.drop.aggregate",
      attributes: { rule: "private-command", count: 3 },
      title: "Sensitive terminal event dropped"
    });
    const first = await app.inject({ method: "POST", url: "/v1/events/batch", headers: authorization, payload: { events: [aggregate] } });
    const retry = await app.inject({ method: "POST", url: "/v1/events/batch", headers: authorization, payload: { events: [aggregate] } });
    expect(first.json()).toMatchObject({ accepted: 0, dropped: 3, secret: 3 });
    expect(retry.json()).toMatchObject({ accepted: 0, duplicate: 1 });
    expect(engine.database.counts()).toMatchObject({ eventCount: 0, droppedSecretCount: 3 });
    expect(engine.database.privacyRuleCounts()).toContainEqual({ rule: "private_command", count: 3 });
  });

  it("has no fixture or replay API", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/demo/replay",
      headers: authorization,
      payload: { fixturePath: "/etc/passwd" }
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("root:x:");
  });

  it("returns a generic REST failure and stores no invalid-model canary", async () => {
    const canary = "REST_MODEL_OUTPUT_CANARY";
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ message: { content: `{\"summary\":\"${canary}` } }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
    const source = event({ id: "40000000-0000-4000-8000-000000000004" });
    await app.inject({ method: "POST", url: "/v1/events/batch", headers: authorization, payload: { events: [source] } });
    const response = await app.inject({ method: "POST", url: "/v1/windows/flush", headers: authorization, payload: { projectId: source.projectId } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "operation_failed", message: "The operation could not be completed." });
    expect(response.body).not.toContain(canary);
    const persisted = JSON.stringify({
      windows: engine.database.raw.prepare("SELECT error FROM windows").all(),
      runs: engine.database.raw.prepare("SELECT error FROM provider_runs").all()
    });
    expect(persisted).not.toContain(canary);
  });

  it("rejects secret-shaped chat before persistence or provider invocation", async () => {
    const projectId = crypto.randomUUID();
    const created = await app.inject({ method: "POST", url: "/v1/chat/sessions", headers: authorization, payload: { projectId } });
    const sessionId = created.json().session.id as string;
    const provider = vi.spyOn(engine.chatProviders, "provider");
    const response = await app.inject({
      method: "POST",
      url: `/v1/chat/sessions/${sessionId}/messages`,
      headers: authorization,
      payload: { text: "Use sk-thisisasynthetickey123456789" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("secret_rejected");
    expect(provider).not.toHaveBeenCalled();
    expect(engine.database.chatMessages(sessionId)).toEqual([]);
  });

  it("rejects secret-shaped provider output before persistence or synchronization", async () => {
    const projectId = crypto.randomUUID();
    const session = (await app.inject({ method: "POST", url: "/v1/chat/sessions", headers: authorization, payload: { projectId } })).json().session;
    vi.spyOn(engine.chatProviders, "provider").mockReturnValue({
      chat: async () => ({ text: "Generated sk-provideroutputsecret123456789", provider: "ollama", model: "test-chat" })
    } as ReturnType<typeof engine.chatProviders.provider>);
    const response = await app.inject({
      method: "POST",
      url: `/v1/chat/sessions/${session.id}/messages`,
      headers: authorization,
      payload: { text: "Give me a grounded summary" }
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe("secret_rejected");
    expect(engine.database.chatMessages(session.id).map((message) => message.role)).toEqual(["user"]);
    expect(JSON.stringify(engine.database.raw.prepare("SELECT * FROM chat_messages").all())).not.toContain("provideroutputsecret");
  });

  it("validates a caller-provided chat run ID before persisting the user message", async () => {
    const projectId = crypto.randomUUID();
    const session = (await app.inject({ method: "POST", url: "/v1/chat/sessions", headers: authorization, payload: { projectId } })).json().session;
    const provider = vi.spyOn(engine.chatProviders, "provider");
    const response = await app.inject({
      method: "POST",
      url: `/v1/chat/sessions/${session.id}/messages`,
      headers: authorization,
      payload: { text: "Do not persist this request", runId: "not-a-uuid" }
    });
    expect(response.statusCode).toBe(400);
    expect(engine.database.chatMessages(session.id)).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
  });

  it("limits a paired Chrome credential to Chrome collector routes and events", async () => {
    const challenge = "chrome-pairing-challenge-123456";
    const requested = await app.inject({
      method: "POST",
      url: "/v1/pairing/chrome/request",
      headers: { origin: "chrome-extension://abcdefghijklmnop", "content-type": "application/json" },
      payload: { clientId: "chrome-client-0001", challenge }
    });
    const pairingId = requested.json().pairing.id as string;
    expect((await app.inject({ method: "POST", url: `/v1/pairing/chrome/${pairingId}/approve`, headers: authorization })).statusCode).toBe(200);
    const completed = await app.inject({
      method: "POST",
      url: `/v1/pairing/chrome/${pairingId}/status`,
      headers: { origin: "chrome-extension://abcdefghijklmnop" },
      payload: { challenge }
    });
    const token = completed.json().token as string;
    expect(token).toMatch(/^ctc_/);
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { authorization: `Bearer ${token}` },
      payload: { events: [event({ source: "terminal", eventType: "terminal.command_finished" })] }
    });
    expect(rejected.statusCode).toBe(403);
    expect(engine.database.counts().eventCount).toBe(0);
    expect((await app.inject({ method: "GET", url: "/v1/state", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });

  it("keeps disabled Chrome host metadata out of storage, providers, REST, and MCP context", async () => {
    const hiddenHost = "private-project.example.test";
    const projectId = crypto.randomUUID();
    const deviceId = engine.database.deviceId();
    const currentPolicy = engine.database.getPrivacyPolicy();
    const policy = engine.database.setPrivacyPolicy({
      ...currentPolicy,
      revision: currentPolicy.revision + 1,
      updatedAt: new Date().toISOString(),
      metadata: {
        ...currentPolicy.metadata,
        urlHosts: false,
        urlPaths: true,
        personalCloudEligibility: true
      }
    });
    const eventId = crypto.randomUUID();
    let providerRequest = "";
    globalThis.fetch = vi.fn(async (_input, init) => {
      if (init?.body) providerRequest = String(init.body);
      const draft = {
        goal: "Review browser context",
        focus: "Browser activity",
        summary: "A permitted documentation path was viewed.",
        progress: [{ text: "Reviewed documentation", eventIds: [eventId] }],
        blockers: [], hypotheses: [], decisions: [], questions: [], entities: [],
        importance: 0.5,
        confidence: 1
      };
      return new Response(JSON.stringify({
        id: "resp_url_privacy",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-5.6-terra",
        output: [{
          id: "msg_url_privacy",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(draft), annotations: [] }]
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const ingestion = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: authorization,
      payload: { events: [{
        version: "2",
        id: eventId,
        deviceId,
        occurredAt: new Date().toISOString(),
        hlc: `${Date.now()}:0:${deviceId}`,
        source: "chrome",
        eventType: "tab.activated",
        projectId,
        title: `Viewing ${hiddenHost}`,
        attributes: {
          host: hiddenHost,
          origin: `https://${hiddenHost}`,
          url: `https://${hiddenHost}/reference/api?view=discarded#fragment`
        },
        privacy: { classification: "personal", rules: ["foreground-tab-only"] },
        relevance: { decision: "keep", reason: "allowlisted_foreground_tab" },
        confidence: 1,
        dedupeKey: `chrome-${crypto.randomUUID()}`,
        policyVersion: policy.revision,
        syncEligibility: "cloud_eligible"
      }] }
    });
    expect(ingestion.statusCode).toBe(202);
    expect(ingestion.json().accepted).toBe(1);
    const sanitizedEvents = engine.database.pendingEvents(projectId, 15);
    expect(sanitizedEvents).toHaveLength(1);
    await new OpenAIProvider("gpt-5.6-terra", "test-key").createCheckpoint({ projectId, events: sanitizedEvents });
    await engine.pipeline.flush(projectId, new DeterministicTestProvider());

    const persisted = JSON.stringify({
      events: engine.database.raw.prepare("SELECT title, attributes_json FROM events").all(),
      checkpoints: engine.database.raw.prepare("SELECT checkpoint_json FROM checkpoints").all()
    });
    const state = await app.inject({ method: "GET", url: "/v1/state", headers: authorization });
    const search = await app.inject({
      method: "POST", url: "/v1/search", headers: authorization,
      payload: { projectId, query: "Browser activity" }
    });
    const mcpContext = await engine.contexts.pack({ projectId, maxCharacters: 12_000 });
    const exposed = JSON.stringify({ persisted, providerRequest, state: state.json(), search: search.json(), mcpContext });
    expect(exposed).not.toContain(hiddenHost);
    expect(providerRequest).toContain("Browser activity");
    expect(persisted).toContain("/reference/api");
  });

  it("keeps confidential conversations local and excludes local-only context from synchronized chat", async () => {
    const projectId = crypto.randomUUID();
    const privateMarker = "INTERNAL_CUSTOMER_CODENAME_LOCAL_ONLY";
    const confidential = event({ projectId, title: privateMarker, privacy: { classification: "confidential", rules: ["test"] } });
    await engine.pipeline.ingest({ events: [confidential] });
    await engine.pipeline.flush(projectId, new DeterministicTestProvider());
    const publicEvent = event({ projectId, title: "Public checkpoint evidence", privacy: { classification: "public", rules: ["test"] } });
    await engine.pipeline.ingest({ events: [publicEvent] });
    await engine.pipeline.flush(projectId, new DeterministicTestProvider());

    let providerContext = "";
    vi.spyOn(engine.chatProviders, "provider").mockReturnValue({
      chat: async (input) => {
        providerContext = JSON.stringify(input.context);
        return { text: "Continue from the public checkpoint.", provider: "ollama", model: "test-chat" };
      }
    } as ReturnType<typeof engine.chatProviders.provider>);
    const cloudSession = (await app.inject({
      method: "POST",
      url: "/v1/chat/sessions",
      headers: authorization,
      payload: { projectId, classification: "public", syncEligibility: "cloud_eligible" }
    })).json().session;
    const response = await app.inject({
      method: "POST", url: `/v1/chat/sessions/${cloudSession.id}/messages`, headers: authorization, payload: { text: "What should I do next?" }
    });
    expect(response.statusCode).toBe(200);
    expect(providerContext).toContain("Public checkpoint evidence");
    expect(providerContext).not.toContain(privateMarker);
    expect(engine.database.chatMessages(cloudSession.id).every((message) => message.syncEligibility === "cloud_eligible")).toBe(true);

    engine.database.setModelSettings({ activeChatProvider: "openai" });
    const localSession = (await app.inject({
      method: "POST", url: "/v1/chat/sessions", headers: authorization, payload: { projectId, syncEligibility: "local_only" }
    })).json().session;
    const blocked = await app.inject({
      method: "POST", url: `/v1/chat/sessions/${localSession.id}/messages`, headers: authorization, payload: { text: "Summarize local context" }
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("local_chat_cloud_blocked");
  });

  it("executes read actions immediately and confirms state-changing chat actions", async () => {
    const projectId = crypto.randomUUID();
    vi.spyOn(engine.chatProviders, "provider").mockReturnValue({
      chat: async () => ({ text: "Grounded response.", provider: "ollama", model: "test-chat" })
    } as ReturnType<typeof engine.chatProviders.provider>);
    const session = (await app.inject({ method: "POST", url: "/v1/chat/sessions", headers: authorization, payload: { projectId } })).json().session;
    const searched = await app.inject({
      method: "POST", url: `/v1/chat/sessions/${session.id}/messages`, headers: authorization, payload: { text: "Search my context for authentication" }
    });
    expect(searched.json().actions[0]).toMatchObject({ name: "search_context", mutating: false, status: "completed" });

    const proposed = await app.inject({
      method: "POST", url: `/v1/chat/sessions/${session.id}/messages`, headers: authorization, payload: { text: "Switch to this project" }
    });
    const action = proposed.json().actions[0];
    expect(action).toMatchObject({ name: "select_project", mutating: true, status: "proposed" });
    expect(engine.database.activeProjectLease()).toBeUndefined();
    const confirmed = await app.inject({ method: "POST", url: `/v1/chat/actions/${action.id}/confirm`, headers: authorization });
    expect(confirmed.json().action.status).toBe("completed");
    expect(engine.database.activeProjectLease()).toMatchObject({ projectId, source: "manual" });
  });

  it("cancels an active streaming chat run", async () => {
    const projectId = crypto.randomUUID();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    vi.spyOn(engine.chatProviders, "provider").mockReturnValue({
      chat: async (_input, signal) => await new Promise((_resolve, reject) => {
        markStarted();
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })
    } as ReturnType<typeof engine.chatProviders.provider>);
    const session = (await app.inject({ method: "POST", url: "/v1/chat/sessions", headers: authorization, payload: { projectId } })).json().session;
    const runId = crypto.randomUUID();
    const streamPromise = app.inject({
      method: "POST",
      url: `/v1/chat/sessions/${session.id}/messages`,
      headers: { ...authorization, accept: "text/event-stream", "content-type": "application/json" },
      payload: { text: "Wait for cancellation", runId }
    });
    await started;
    const cancelled = await app.inject({ method: "POST", url: `/v1/chat/runs/${runId}/cancel`, headers: authorization });
    expect(cancelled.statusCode).toBe(200);
    const stream = await streamPromise;
    expect(stream.body).toContain(`"runId":"${runId}"`);
    expect(stream.body).toContain("event: cancelled");
  });
});
