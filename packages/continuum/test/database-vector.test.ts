import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import type { CheckpointV1, NormalizedEventV1 } from "@continuum/contracts";
import { ContinuumDatabase } from "../src/db/database.js";
import { event, testConfig } from "./helpers.js";

describe("sqlite-vec checkpoint persistence", () => {
  let database: ContinuumDatabase;
  let dataDir: string;

  beforeEach(async () => {
    const config = await testConfig();
    dataDir = config.dataDir;
    database = new ContinuumDatabase(config.databasePath);
    expect(await database.initializeVector()).toBe(true);
  });

  afterEach(async () => {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function createCheckpoint(suffix: string): { checkpoint: CheckpointV1; embedding: number[] } {
    const capturedEvent: NormalizedEventV1 = event({
      projectId: "vector-project",
      title: `Vector checkpoint ${suffix}`
    });
    expect(database.insertEvent(capturedEvent)).toBe(true);
    const windowId = database.createWindow(
      capturedEvent.projectId,
      [capturedEvent],
      "deterministic",
      "fixture-v1",
      true
    );
    const checkpoint: CheckpointV1 = {
      version: "1",
      id: `vector-checkpoint-${suffix}`,
      projectId: capturedEvent.projectId,
      windowId,
      eventIds: [capturedEvent.id],
      goal: `Validate vector persistence ${suffix}`,
      focus: "sqlite-vec integration",
      summary: "A deterministic embedding is stored and remains searchable.",
      progress: [{ text: "Prepared deterministic embedding", eventIds: [capturedEvent.id] }],
      blockers: [],
      hypotheses: [],
      decisions: [],
      questions: [],
      entities: [{ kind: "file", key: `src/${suffix}.ts`, label: `src/${suffix}.ts`, eventIds: [capturedEvent.id] }],
      importance: 0.8,
      confidence: 1,
      provider: "deterministic",
      model: "fixture-v1",
      createdAt: new Date().toISOString()
    };
    const embedding = Array.from({ length: 384 }, (_, index) => index === 0 ? 1 : 0);
    return { checkpoint, embedding };
  }

  it("stores a checkpoint vector with an integer rowid and retrieves it", () => {
    const { checkpoint, embedding } = createCheckpoint("searchable");

    database.insertCheckpoint(checkpoint, embedding);

    expect(database.vectorSearch(checkpoint.projectId, embedding, 5)).toEqual([
      { checkpointId: checkpoint.id, distance: 0 }
    ]);
    const vectorCount = database.raw.prepare("SELECT count(*) AS count FROM checkpoint_vec").get() as { count: number };
    expect(Number(vectorCount.count)).toBe(1);
  });

  it("rolls back checkpoint, FTS, graph, window, and revision state when vector insertion fails", () => {
    const { checkpoint, embedding } = createCheckpoint("rollback");
    const beforeRevision = database.revision();
    const beforeCounts = database.counts();
    const beforeGraph = database.graphCounts();
    const beforeFts = database.raw.prepare("SELECT count(*) AS count FROM checkpoint_fts").get() as { count: number };
    database.raw.exec("DROP TABLE checkpoint_vec");

    expect(() => database.insertCheckpoint(checkpoint, embedding)).toThrow(/checkpoint_vec/);

    expect(database.counts()).toEqual(beforeCounts);
    expect(database.graphCounts()).toEqual(beforeGraph);
    const afterFts = database.raw.prepare("SELECT count(*) AS count FROM checkpoint_fts").get() as { count: number };
    expect(Number(afterFts.count)).toBe(Number(beforeFts.count));
    expect(database.getCheckpoint(checkpoint.id)).toBeUndefined();
    const window = database.raw.prepare("SELECT status FROM windows WHERE id = ?").get(checkpoint.windowId) as { status: string };
    expect(window.status).toBe("processing");
    expect(database.revision()).toBe(beforeRevision);
  });
});
