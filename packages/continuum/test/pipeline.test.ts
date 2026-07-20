import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Engine } from "../src/server/engine.js";
import { createEngine } from "../src/server/engine.js";
import { replayFixture } from "./replay-fixture.js";
import { event, testConfig } from "./helpers.js";
import { DeterministicTestProvider } from "./deterministic-provider.js";
import type { CheckpointDraft } from "@continuum/contracts";
import type { CheckpointInput, CheckpointProvider, ProviderHealth } from "../src/providers/types.js";

const originalFetch = globalThis.fetch;
const fixturePath = resolve(import.meta.dirname, "fixtures/jwt-friday-monday.jsonl");

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
    const result = await replayFixture(engine, fixturePath);
    const projectId = result.projectId!;
    expect(result.checkpoints).toHaveLength(3);
    expect(result.secret).toBe(1);
    expect(engine.database.baseline(projectId)).toBe(result.checkpoints[1]?.id);

    const diff = engine.contexts.diff({ projectId });
    expect(diff.changes.length).toBeGreaterThanOrEqual(4);
    expect(diff.resolvedBlockers.some((item) => /401/i.test(item.text))).toBe(true);
    expect(diff.changedHypotheses.some((item) => item.status === "disproven")).toBe(true);
    expect(diff.newCommits.some((entity) => entity.key === "a0ada710a0ada710a0ada710a0ada710a0ada710")).toBe(true);

    const pack = await engine.contexts.pack({ projectId });
    expect(pack.approximateCharacters).toBeLessThanOrEqual(12_000);
    expect(pack.checkpoints.length).toBeGreaterThan(0);
    expect(pack.provenance.degraded).toBe(true);
    expect(pack.blockers.some((item) => /401/i.test(item.text))).toBe(true);

    const tightlyBoundedPack = await engine.contexts.pack({ projectId, maxCharacters: 1_000 });
    expect(JSON.stringify(tightlyBoundedPack).length).toBeLessThanOrEqual(1_000);

    const row = engine.database.raw.prepare("SELECT count(*) AS count FROM graph_nodes").get() as { count: number };
    expect(Number(row.count)).toBeGreaterThan(0);
  });

  it("never stores the privacy canary", async () => {
    await replayFixture(engine, fixturePath);
    const events = engine.database.raw.prepare("SELECT title, attributes_json FROM events").all();
    const checkpoints = engine.database.raw.prepare("SELECT checkpoint_json FROM checkpoints").all();
    const serialized = JSON.stringify({ events, checkpoints });
    expect(serialized).not.toContain("CONTINUUM_DEMO_SECRET_SHOULD_NEVER_APPEAR");
    const source = await readFile(fixturePath, "utf8");
    expect(source).toContain("CONTINUUM_DEMO_SECRET_SHOULD_NEVER_APPEAR");
  });

  it("physically expires normalized events while retaining checkpoints", async () => {
    await replayFixture(engine, fixturePath);
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
    await engine.pipeline.flush(confidential.projectId, new DeterministicTestProvider());

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

  it("never seeds a sync-eligible local-provider checkpoint with a previous local-only checkpoint", async () => {
    const projectId = "checkpoint-eligibility-boundary";
    const timestamps = {
      eligible: "2026-07-20T08:00:00.000Z",
      local: "2026-07-20T08:01:00.000Z",
      current: "2026-07-20T08:02:00.000Z"
    };
    const canaries = {
      goal: "LOCAL_ONLY_GOAL_CANARY_9cdd92",
      focus: "LOCAL_ONLY_FOCUS_CANARY_3da474",
      summary: "LOCAL_ONLY_SUMMARY_CANARY_8f730b",
      blocker: "LOCAL_ONLY_BLOCKER_CANARY_2d865f",
      hypothesis: "LOCAL_ONLY_HYPOTHESIS_CANARY_56d2bc"
    };
    const health = async (): Promise<ProviderHealth> => ({ status: "available" });
    const draftFor = (sourceEvent: ReturnType<typeof event>, values: {
      goal: string;
      focus: string;
      summary: string;
      blocker?: string;
      hypothesis?: string;
    }): CheckpointDraft => ({
      goal: values.goal,
      focus: values.focus,
      summary: values.summary,
      progress: [{ text: `Observed ${sourceEvent.id}`, eventIds: [sourceEvent.id] }],
      blockers: values.blocker ? [{ text: values.blocker, status: "open", eventIds: [sourceEvent.id] }] : [],
      hypotheses: values.hypothesis ? [{ text: values.hypothesis, status: "active", eventIds: [sourceEvent.id] }] : [],
      decisions: [],
      questions: [],
      entities: [],
      importance: 0.5,
      confidence: 1
    });

    const eligibleEvent = event({
      id: "51000000-0000-4000-8000-000000000001",
      projectId,
      occurredAt: timestamps.eligible,
      title: "Eligible checkpoint before confidential work"
    });
    const eligibleProvider: CheckpointProvider = {
      id: "ollama",
      model: "eligibility-boundary-test",
      health,
      async createCheckpoint() {
        return draftFor(eligibleEvent, {
          goal: "SAFE_ELIGIBLE_GOAL",
          focus: "SAFE_ELIGIBLE_FOCUS",
          summary: "SAFE_ELIGIBLE_SUMMARY"
        });
      }
    };
    await engine.pipeline.ingest({ events: [eligibleEvent] });
    const [eligibleCheckpoint] = await engine.pipeline.flush(projectId, eligibleProvider);
    expect(eligibleCheckpoint).toBeDefined();
    expect(engine.database.checkpointsCloudEligible([eligibleCheckpoint!.id])).toBe(true);

    const localEvent = event({
      id: "51000000-0000-4000-8000-000000000002",
      projectId,
      occurredAt: timestamps.local,
      title: "Confidential work represented only by canaries",
      privacy: { classification: "confidential", rules: ["test-local-only"] }
    });
    const localProvider: CheckpointProvider = {
      id: "ollama",
      model: "eligibility-boundary-test",
      health,
      async createCheckpoint() {
        return draftFor(localEvent, canaries);
      }
    };
    await engine.pipeline.ingest({ events: [localEvent] });
    const [localCheckpoint] = await engine.pipeline.flush(projectId, localProvider);
    expect(localCheckpoint).toBeDefined();
    expect(engine.database.checkpointsCloudEligible([localCheckpoint!.id])).toBe(false);
    expect(JSON.stringify(localCheckpoint)).toContain(canaries.summary);

    const currentEvent = event({
      id: "51000000-0000-4000-8000-000000000003",
      projectId,
      occurredAt: timestamps.current,
      title: "Current public checkpoint evidence"
    });
    let capturedInput: CheckpointInput | undefined;
    const currentProvider: CheckpointProvider = {
      id: "ollama",
      model: "eligibility-boundary-test",
      health,
      async createCheckpoint(input) {
        capturedInput = input;
        const previous = input.previousCheckpoint;
        return draftFor(currentEvent, {
          // Model behavior is not a privacy boundary. Echo the supplied state so
          // this regression proves both the provider input and persisted/synced
          // output stay clean when the pipeline chooses the prior checkpoint.
          goal: previous?.goal ?? "CURRENT_SAFE_GOAL",
          focus: previous?.focus ?? "CURRENT_SAFE_FOCUS",
          summary: previous?.summary ?? "CURRENT_SAFE_SUMMARY",
          ...(previous?.blockers[0] ? { blocker: previous.blockers[0].text } : {}),
          ...(previous?.hypotheses[0] ? { hypothesis: previous.hypotheses[0].text } : {})
        });
      }
    };
    await engine.pipeline.ingest({ events: [currentEvent] });
    const [currentCheckpoint] = await engine.pipeline.flush(projectId, currentProvider);
    expect(currentCheckpoint).toBeDefined();
    expect(engine.database.checkpointsCloudEligible([currentCheckpoint!.id])).toBe(true);
    expect(capturedInput?.previousCheckpoint?.id).toBe(eligibleCheckpoint!.id);

    const serializedProviderInput = JSON.stringify(capturedInput);
    const serializedSyncedCheckpoint = JSON.stringify(
      engine.database.pendingSyncOperations().find((operation) =>
        operation.entityType === "checkpoint" && operation.entityId === currentCheckpoint!.id
      )
    );
    expect(serializedSyncedCheckpoint).not.toBeUndefined();
    for (const canary of Object.values(canaries)) {
      expect(serializedProviderInput).not.toContain(canary);
      expect(serializedSyncedCheckpoint).not.toContain(canary);
    }
  });
});
