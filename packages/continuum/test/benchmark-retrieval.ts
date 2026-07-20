import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointV1Schema } from "@continuum/contracts";
import { loadRuntimeConfig } from "../src/runtime.js";
import { createEngine } from "../src/server/engine.js";

const count = Math.min(100_000, Math.max(100, Number(process.argv[2] ?? 10_000)));
if (!Number.isInteger(count)) throw new Error("benchmark count must be an integer");
const dataDir = await mkdtemp(join(tmpdir(), "continuum-retrieval-benchmark-"));
const previousEmbeddingSetting = process.env.CONTINUUM_DISABLE_EMBEDDINGS;
process.env.CONTINUUM_DISABLE_EMBEDDINGS = "1";
const config = await loadRuntimeConfig({
  dataDir,
  databasePath: join(dataDir, "benchmark.sqlite"),
  tokenPath: join(dataDir, "auth.token")
});
const engine = await createEngine(config);

try {
  const projectId = crypto.randomUUID();
  const deviceId = engine.database.deviceId();
  engine.database.ensureProject(projectId, "Retrieval benchmark");
  const insertWindow = engine.database.raw.prepare(`
    INSERT INTO windows(id, project_id, started_at, ended_at, status, provider, model, cloud_eligible, created_at)
    VALUES (?, ?, ?, ?, 'complete', 'deterministic', 'benchmark', 1, ?)
  `);
  const insertCheckpoint = engine.database.raw.prepare(`
    INSERT INTO checkpoints(id, project_id, window_id, goal, focus, summary, importance, provider, model, checkpoint_json, created_at, device_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = engine.database.raw.prepare(
    "INSERT INTO checkpoint_fts(rowid, project_id, goal, focus, summary, items) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const setupStarted = performance.now();
  engine.database.raw.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < count; index += 1) {
      const suffix = index.toString().padStart(8, "0");
      const id = `benchmark-checkpoint-${suffix}`;
      const windowId = `benchmark-window-${suffix}`;
      const createdAt = new Date(Date.UTC(2025, 0, 1) + index * 1_000).toISOString();
      const needle = index === 42;
      const checkpoint = CheckpointV1Schema.parse({
        version: "1",
        id,
        projectId,
        deviceId,
        windowId,
        eventIds: [`benchmark-event-${suffix}`],
        goal: needle ? "Resolve dataset UUID dashboard 401" : `Synthetic checkpoint ${suffix}`,
        focus: needle ? "Preserve the RLS clause" : "Benchmark retrieval",
        summary: needle ? "Needle checkpoint for lexical retrieval." : "Synthetic checkpoint used only for latency measurement.",
        progress: [{ text: "Indexed checkpoint", eventIds: [`benchmark-event-${suffix}`] }],
        blockers: [],
        hypotheses: [],
        decisions: [],
        questions: [],
        entities: [],
        importance: needle ? 1 : 0.2,
        confidence: 1,
        provider: "deterministic",
        model: "benchmark",
        createdAt
      });
      insertWindow.run(windowId, projectId, createdAt, createdAt, createdAt);
      const inserted = insertCheckpoint.run(
        id,
        projectId,
        windowId,
        checkpoint.goal,
        checkpoint.focus,
        checkpoint.summary,
        checkpoint.importance,
        checkpoint.provider,
        checkpoint.model,
        JSON.stringify(checkpoint),
        createdAt,
        deviceId
      );
      insertFts.run(inserted.lastInsertRowid, projectId, checkpoint.goal, checkpoint.focus, checkpoint.summary, checkpoint.progress[0]?.text ?? "");
    }
    engine.database.raw.exec("COMMIT");
  } catch (error) {
    engine.database.raw.exec("ROLLBACK");
    throw error;
  }
  const setupMs = performance.now() - setupStarted;
  const retrievalStarted = performance.now();
  const pack = await engine.contexts.pack({ projectId, query: "dataset UUID dashboard 401" });
  const retrievalMs = performance.now() - retrievalStarted;
  if (!pack.provenance.checkpointIds.includes("benchmark-checkpoint-00000042")) {
    throw new Error("benchmark query did not retrieve the test checkpoint");
  }
  if (retrievalMs >= 500) throw new Error(`retrieval exceeded 500 ms: ${retrievalMs.toFixed(1)} ms`);
  process.stdout.write(`${JSON.stringify({ checkpoints: count, setupMs: Math.round(setupMs), retrievalMs: Number(retrievalMs.toFixed(1)), mode: "fts_graph", passed: true }, null, 2)}\n`);
} finally {
  engine.close();
  await rm(dataDir, { recursive: true, force: true });
  if (previousEmbeddingSetting === undefined) delete process.env.CONTINUUM_DISABLE_EMBEDDINGS;
  else process.env.CONTINUUM_DISABLE_EMBEDDINGS = previousEmbeddingSetting;
}
