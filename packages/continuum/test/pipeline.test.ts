import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import type { Engine } from "../src/server/engine.js";
import { createEngine } from "../src/server/engine.js";
import { replayFixture } from "../src/fixtures/replay.js";
import { event, testConfig } from "./helpers.js";

const originalFetch = globalThis.fetch;

describe("fixture pipeline", () => {
  let engine: Engine;
  let dataDir: string;

  beforeEach(async () => {
    process.env.CONTINUUM_DISABLE_EMBEDDINGS = "1";
    const config = await testConfig();
    dataDir = config.dataDir;
    engine = await createEngine(config);
  });

  afterEach(async () => {
    engine.close();
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.CONTINUUM_DISABLE_EMBEDDINGS;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("turns Friday/Monday events into grounded checkpoints and a context diff", async () => {
    const result = await replayFixture(engine, engine.config.fixturePath);
    expect(result.checkpoints).toHaveLength(3);
    expect(result.secret).toBe(1);
    expect(engine.database.baseline("continuum-demo")).toBe(result.checkpoints[1]?.id);

    const diff = engine.contexts.diff({ projectId: "continuum-demo" });
    expect(diff.changes.length).toBeGreaterThanOrEqual(4);
    expect(diff.resolvedBlockers.some((item) => /401/i.test(item.text))).toBe(true);
    expect(diff.changedHypotheses.some((item) => item.status === "disproven")).toBe(true);
    expect(diff.newCommits.some((entity) => entity.key === "a0ada710a0ada710a0ada710a0ada710a0ada710")).toBe(true);

    const pack = await engine.contexts.pack({ projectId: "continuum-demo" });
    expect(pack.approximateCharacters).toBeLessThanOrEqual(12_000);
    expect(pack.checkpoints.length).toBeGreaterThan(0);
    expect(pack.provenance.degraded).toBe(true);
    expect(pack.blockers.some((item) => /401/i.test(item.text))).toBe(true);

    const tightlyBoundedPack = await engine.contexts.pack({ projectId: "continuum-demo", maxCharacters: 1_000 });
    expect(JSON.stringify(tightlyBoundedPack).length).toBeLessThanOrEqual(1_000);

    const row = engine.database.raw.prepare("SELECT count(*) AS count FROM graph_nodes").get() as { count: number };
    expect(Number(row.count)).toBeGreaterThan(0);
  });

  it("never stores the privacy canary", async () => {
    await replayFixture(engine, engine.config.fixturePath);
    const events = engine.database.raw.prepare("SELECT title, attributes_json FROM events").all();
    const checkpoints = engine.database.raw.prepare("SELECT checkpoint_json FROM checkpoints").all();
    const serialized = JSON.stringify({ events, checkpoints });
    expect(serialized).not.toContain("CONTINUUM_DEMO_SECRET_SHOULD_NEVER_APPEAR");
    const source = await readFile(engine.config.fixturePath, "utf8");
    expect(source).toContain("CONTINUUM_DEMO_SECRET_SHOULD_NEVER_APPEAR");
  });

  it("physically expires normalized events while retaining checkpoints", async () => {
    await replayFixture(engine, engine.config.fixturePath);
    const checkpointCount = engine.database.counts().checkpointCount;
    const expired = engine.database.purgeExpiredEvents(-24 * 365);
    expect(expired).toBeGreaterThan(0);
    expect(engine.database.counts().eventCount).toBe(0);
    expect(engine.database.expiredEventCount()).toBe(expired);
    expect(engine.database.counts().checkpointCount).toBe(checkpointCount);
  });

  it("expires future-dated events from server receipt time", () => {
    const future = event({ occurredAt: "2099-01-01T00:00:00.000Z" });
    expect(engine.database.insertEvent(future)).toBe(true);
    engine.database.raw.prepare("UPDATE events SET received_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", future.id);
    expect(engine.database.purgeExpiredEvents()).toBe(1);
    expect(engine.database.counts().eventCount).toBe(0);
  });

  it("persists stable provider error codes without model-output snippets", async () => {
    const canary = "INTERNAL_MODEL_OUTPUT_CANARY";
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ message: { content: `{\"summary\":\"${canary}` } }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
    const source = event({
      id: "50000000-0000-4000-8000-000000000003",
      privacy: { classification: "confidential", rules: ["test-local"] }
    });
    await engine.pipeline.ingest({ events: [source] });
    await expect(engine.pipeline.flush(source.projectId)).rejects.toThrow("provider_invalid_response");
    const rows = {
      windows: engine.database.raw.prepare("SELECT error FROM windows").all(),
      runs: engine.database.raw.prepare("SELECT error FROM provider_runs").all()
    };
    const serialized = JSON.stringify(rows);
    expect(serialized).toContain("provider_invalid_response");
    expect(serialized).not.toContain(canary);
  });

  it("never sends confidential events or prior local-only checkpoint text to OpenAI", async () => {
    const confidentialTitle = "Internal customer codename must stay local";
    const confidential = event({
      id: "50000000-0000-4000-8000-000000000001",
      title: confidentialTitle,
      privacy: { classification: "confidential", rules: ["test-confidential"] }
    });
    await engine.pipeline.ingest({ events: [confidential] });
    await engine.pipeline.flush(confidential.projectId, "deterministic");

    engine.config.openaiApiKey = "test-key";
    engine.database.setModelSettings({
      activeCheckpointProvider: "openai",
      ollamaModel: "gemma3n:e2b",
      openaiModel: "gpt-5.6-terra"
    });
    const publicEvent = event({
      id: "50000000-0000-4000-8000-000000000002",
      title: "Public provider boundary verification",
      privacy: { classification: "public", rules: ["test-public"] }
    });
    let serializedRequest = "";
    globalThis.fetch = vi.fn(async (_input, init) => {
      serializedRequest = String(init?.body);
      const draft = {
        goal: "Validate cloud boundary",
        focus: "Public provider event",
        summary: "Only eligible metadata reached the provider.",
        progress: [{ text: "Boundary checked", eventIds: [publicEvent.id] }],
        blockers: [], hypotheses: [], decisions: [], questions: [], entities: [],
        importance: 0.5,
        confidence: 1
      };
      return new Response(JSON.stringify({
        id: "resp_boundary",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-5.6-terra",
        output: [{
          id: "msg_boundary",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(draft), annotations: [] }]
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await engine.pipeline.ingest({ events: [publicEvent] });
    await engine.pipeline.flush(publicEvent.projectId);
    expect(serializedRequest).toContain(publicEvent.title);
    expect(serializedRequest).not.toContain(confidentialTitle);
    expect(JSON.parse(serializedRequest)).toMatchObject({ store: false, model: "gpt-5.6-terra" });
  });
});
