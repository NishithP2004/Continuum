import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { CheckpointV1Schema, type CheckpointV1 } from "@continuum/contracts";
import { ContextService } from "../src/retrieval/context-service.js";
import { createEngine, type Engine } from "../src/server/engine.js";
import { replayFixture } from "./replay-fixture.js";
import { testConfig } from "./helpers.js";

const LOCAL_ONLY_MARKER = "CONFIDENTIAL_LOCAL_ONLY_MCP_CANARY";
const fixturePath = resolve(import.meta.dirname, "fixtures/jwt-friday-monday.jsonl");

function insertLocalOnlyCheckpoint(engine: Engine, projectId: string): CheckpointV1 {
  const createdAt = new Date(Date.now() + 1_000).toISOString();
  const windowId = "local-only-window-0001";
  const eventId = "00000000-0000-4000-8000-000000000001";
  engine.database.raw.prepare(`
    INSERT INTO windows(id, project_id, started_at, ended_at, status, provider, model, cloud_eligible, created_at)
    VALUES (?, ?, ?, ?, 'processing', 'deterministic', 'test', 0, ?)
  `).run(windowId, projectId, createdAt, createdAt, createdAt);
  const checkpoint = CheckpointV1Schema.parse({
    version: "1",
    id: "local-only-checkpoint-0001",
    projectId,
    windowId,
    eventIds: [eventId],
    goal: LOCAL_ONLY_MARKER,
    focus: LOCAL_ONLY_MARKER,
    summary: LOCAL_ONLY_MARKER,
    progress: [{ text: LOCAL_ONLY_MARKER, eventIds: [eventId] }],
    blockers: [{ text: LOCAL_ONLY_MARKER, status: "open", eventIds: [eventId] }],
    hypotheses: [],
    decisions: [],
    questions: [],
    entities: [{ kind: "blocker", key: "local-only", label: LOCAL_ONLY_MARKER, eventIds: [eventId] }],
    importance: 1,
    confidence: 1,
    provider: "deterministic",
    model: "test",
    createdAt
  });
  engine.database.insertCheckpoint(checkpoint);
  return checkpoint;
}

describe("cloud-eligible context boundary", () => {
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
  });

  it("filters local-only checkpoints from packs, search expansion, and diffs", async () => {
    const replay = await replayFixture(engine, fixturePath);
    const projectId = replay.projectId!;
    insertLocalOnlyCheckpoint(engine, projectId);
    const contexts = new ContextService(engine.database, engine.embeddings, { cloudEligibleOnly: true });

    const current = await contexts.pack({ projectId });
    const search = await contexts.pack({ projectId, query: LOCAL_ONLY_MARKER, limit: 1 });
    const diff = contexts.diff({ projectId });
    const serialized = JSON.stringify({ current, search, diff });

    expect(serialized).not.toContain(LOCAL_ONLY_MARKER);
    expect(search.checkpoints).toHaveLength(1);
    expect(diff.addedBlockers.some((item) => /401/i.test(item.text))).toBe(false);
    expect(diff.resolvedBlockers.some((item) => /401/i.test(item.text))).toBe(true);
    expect(diff.changedHypotheses).toHaveLength(1);
    expect(diff.changedHypotheses[0]?.status).toBe("disproven");
  });

  it("rejects unknown, cross-project, and local-only baselines", async () => {
    const replay = await replayFixture(engine, fixturePath);
    const projectId = replay.projectId!;
    const eligibleCheckpoint = replay.checkpoints[0]!;
    const localOnly = insertLocalOnlyCheckpoint(engine, projectId);
    const contexts = new ContextService(engine.database, engine.embeddings, { cloudEligibleOnly: true });

    expect(() => engine.database.acknowledge("another-project", eligibleCheckpoint.id)).toThrow(/does not belong/);
    expect(() => engine.database.acknowledge(projectId, "unknown-checkpoint-id")).toThrow(/Unknown checkpoint/);
    expect(() => contexts.diff({ projectId: "another-project", sinceCheckpointId: eligibleCheckpoint.id })).toThrow(/does not belong/);
    expect(() => contexts.diff({ projectId, sinceCheckpointId: "unknown-checkpoint-id" })).toThrow(/Unknown checkpoint/);

    engine.database.acknowledge(projectId, localOnly.id);
    expect(() => contexts.diff({ projectId })).toThrow(/not available in the cloud-eligible MCP view/);
    expect(() => contexts.diff({ projectId, sinceCheckpointId: localOnly.id })).toThrow(/not available in the cloud-eligible MCP view/);
  });
});
