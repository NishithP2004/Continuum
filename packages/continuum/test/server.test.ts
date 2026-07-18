import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { Engine } from "../src/server/engine.js";
import { createEngine } from "../src/server/engine.js";
import { buildApp } from "../src/server/app.js";
import { event, testConfig } from "./helpers.js";

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

  it("replays the demo through the real API", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/demo/replay", headers: authorization, payload: {} });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.label).toBe("Synthetic deterministic replay");
    expect(body.checkpoints).toHaveLength(3);
    expect(body.diff.changes.length).toBeGreaterThanOrEqual(4);

    const stateResponse = await app.inject({ method: "GET", url: "/v1/state", headers: authorization });
    const state = stateResponse.json();
    expect(state.currentCheckpoint.projectId).toBe("continuum-demo");
    expect(state.recentActivity.map((item: { source: string }) => item.source)).toEqual(
      expect.arrayContaining(["vscode", "terminal", "git", "chrome"])
    );
    expect(state.collectorNames).toEqual(expect.arrayContaining(["vscode", "terminal", "git", "chrome"]));

    const privacyResponse = await app.inject({ method: "GET", url: "/v1/privacy", headers: authorization });
    expect(privacyResponse.json()).toMatchObject({ droppedSecrets: 1 });
  });

  it("refuses a GPT briefing when any diff checkpoint is local-only", async () => {
    await app.inject({ method: "POST", url: "/v1/demo/replay", headers: authorization, payload: {} });
    engine.database.setModelSettings({ activeCheckpointProvider: "openai", ollamaModel: "gemma3n:e2b", openaiModel: "gpt-5.6-terra" });
    engine.database.raw.prepare("UPDATE windows SET cloud_eligible = 0").run();
    const response = await app.inject({
      method: "POST",
      url: "/v1/diff/briefing",
      headers: { ...authorization, "content-type": "application/json" },
      payload: { projectId: "continuum-demo" }
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
    expect(engine.database.privacyRuleCounts()).toContainEqual({ rule: "private-command", count: 3 });
  });

  it("does not accept a request-selected fixture path", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/demo/replay",
      headers: authorization,
      payload: { fixturePath: "/etc/passwd" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().label).toBe("Synthetic deterministic replay");
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
});
