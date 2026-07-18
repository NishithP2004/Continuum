#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { loadRuntimeConfig } from "../runtime.js";
import { createEngine } from "../server/engine.js";
import { replayFixture } from "../fixtures/replay.js";
import { OllamaProvider } from "../providers/ollama.js";
import { OpenAIProvider } from "../providers/openai.js";
import { CheckpointV1Schema, NormalizedEventV1Schema } from "@continuum/contracts";
import { projectIdForPath } from "../project-identity.js";
import { ContinuumDatabase } from "../db/database.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function replay(path: string): Promise<void> {
  const config = await loadRuntimeConfig();
  const engine = await createEngine(config);
  try {
    const result = await replayFixture(engine, resolve(path));
    const pack = await engine.contexts.pack({ projectId: result.projectId });
    const diff = engine.contexts.diff({ projectId: result.projectId });
    process.stdout.write(`${JSON.stringify({ label: "Synthetic deterministic replay", ...result, events: result.events.length, checkpoints: result.checkpoints.length, pack, diff }, null, 2)}\n`);
  } finally {
    engine.close();
  }
}

async function doctor(): Promise<void> {
  const config = await loadRuntimeConfig();
  const engine = await createEngine(config);
  try {
    const settings = engine.database.getModelSettings();
    const providerHealth = await engine.providers.health(settings);
    const report = {
      node: process.version,
      databasePath: config.databasePath,
      tokenPath: config.tokenPath,
      sqliteVector: engine.database.vectorAvailable,
      embedding: await engine.embeddings.status(),
      ollama: providerHealth.ollama,
      openai: providerHealth.openai,
      settings
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    engine.close();
  }
}

async function postEvent(): Promise<void> {
  const { EventsBatchSchema } = await import("@continuum/contracts");
  const config = await loadRuntimeConfig();
  const raw = await readStdin();
  const event = JSON.parse(raw) as unknown;
  const batch = EventsBatchSchema.parse({ events: [event] });
  const response = await fetch(`http://${config.host}:${config.port}/v1/events/batch`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify(batch)
  });
  if (!response.ok) throw new Error(`Engine rejected event: HTTP ${response.status}`);
  process.stdout.write(`${await response.text()}\n`);
}

function printMcpConfig(): void {
  const root = resolve(import.meta.dirname, "../../../..");
  const wrapper = resolve(root, "script/run_mcp.sh");
  process.stdout.write(`[mcp_servers.continuum]\ncommand = "${wrapper}"\nargs = []\ncwd = "${root}"\nenabled_tools = ["current", "timeline", "search", "resume", "diff"]\nstartup_timeout_sec = 10\ntool_timeout_sec = 30\n`);
}

function printProjectId(input?: string): void {
  process.stdout.write(`${projectIdForPath(input ? resolve(input) : process.cwd())}\n`);
}

async function collectTerminal(args: string[]): Promise<void> {
  const mode = args[0];
  if (!mode || !["start", "complete", "flush"].includes(mode)) {
    throw new Error("Usage: continuum collect terminal <start|complete|flush> [arguments]");
  }
  const root = resolve(import.meta.dirname, "../../../..");
  const collector = resolve(root, "integrations/zsh/collector.mjs");
  await new Promise<void>((resolveChild, reject) => {
    const child = spawn(process.execPath, [collector, ...args], {
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveChild();
      else reject(new Error(`terminal collector exited ${signal ?? code ?? "unknown"}`));
    });
  });
}

async function exportRecording(outputPath: string, projectId?: string): Promise<void> {
  const config = await loadRuntimeConfig();
  const database = new ContinuumDatabase(config.databasePath, { readOnly: true });
  try {
    if (database.hasDemoEvents(projectId)) {
      throw new Error("Refusing to label a project containing synthetic demo events as a recorded live session");
    }
    const events = database.eventsForExport(projectId);
    const sources = new Set(events.map((event) => event.source));
    const required = ["vscode", "terminal", "git", "chrome"];
    const missing = required.filter((source) => !sources.has(source as typeof events[number]["source"]));
    if (missing.length > 0) throw new Error(`A recorded live session requires all four collectors; missing: ${missing.join(", ")}`);
    const destination = resolve(outputPath);
    const content = [
      "# Recorded live session — sanitized metadata exported by Continuum",
      ...events.map((event) => JSON.stringify(event))
    ].join("\n") + "\n";
    await writeFile(destination, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ label: "Recorded live session", path: destination, events: events.length, sources: required }, null, 2)}\n`);
  } finally {
    database.close();
  }
}

async function smokeProvider(kind: string, modelOverride?: string): Promise<void> {
  const config = await loadRuntimeConfig();
  const source = NormalizedEventV1Schema.parse({
    version: "1",
    id: "60000000-0000-4000-8000-000000000001",
    occurredAt: new Date().toISOString(),
    source: "demo",
    eventType: "demo.progress",
    projectId: "continuum-provider-smoke",
    title: "Provider smoke checkpoint",
    attributes: { kind: "progress" },
    privacy: { classification: "public", rules: ["provider-smoke"] },
    relevance: { decision: "keep", reason: "explicit provider smoke test" },
    confidence: 1,
    dedupeKey: "provider-smoke-event-0001"
  });
  const provider = kind === "ollama"
    ? new OllamaProvider(modelOverride ?? "gemma3n:e2b", config.ollamaUrl)
    : kind === "openai"
      ? new OpenAIProvider(modelOverride ?? "gpt-5.6-terra", config.openaiApiKey ?? (() => { throw new Error("OPENAI_API_KEY is not configured"); })())
      : undefined;
  if (!provider) throw new Error("Usage: continuum smoke-provider <ollama|openai> [model]");
  const draft = await provider.createCheckpoint({ projectId: source.projectId, events: [source] });
  process.stdout.write(`${JSON.stringify({ provider: provider.id, model: provider.model, valid: true, summary: draft.summary }, null, 2)}\n`);
}

async function benchmarkRetrieval(countInput?: string): Promise<void> {
  const count = Math.min(100_000, Math.max(100, Number(countInput ?? 10_000)));
  if (!Number.isInteger(count)) throw new Error("benchmark count must be an integer");
  const dataDir = await mkdtemp(join(tmpdir(), "continuum-retrieval-benchmark-"));
  process.env.CONTINUUM_DISABLE_EMBEDDINGS = "1";
  const config = await loadRuntimeConfig({
    dataDir,
    databasePath: join(dataDir, "benchmark.sqlite"),
    tokenPath: join(dataDir, "auth.token")
  });
  const engine = await createEngine(config);
  try {
    const projectId = "continuum-benchmark";
    engine.database.ensureProject(projectId);
    const insertWindow = engine.database.raw.prepare(`
      INSERT INTO windows(id, project_id, started_at, ended_at, status, provider, model, cloud_eligible, created_at)
      VALUES (?, ?, ?, ?, 'complete', 'deterministic', 'benchmark', 1, ?)
    `);
    const insertCheckpoint = engine.database.raw.prepare(`
      INSERT INTO checkpoints(id, project_id, window_id, goal, focus, summary, importance, provider, model, checkpoint_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          createdAt
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
      throw new Error("benchmark query did not retrieve the seeded checkpoint");
    }
    if (retrievalMs >= 500) throw new Error(`retrieval exceeded 500 ms: ${retrievalMs.toFixed(1)} ms`);
    process.stdout.write(`${JSON.stringify({ checkpoints: count, setupMs: Math.round(setupMs), retrievalMs: Number(retrievalMs.toFixed(1)), mode: "fts_graph", passed: true }, null, 2)}\n`);
  } finally {
    engine.close();
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.CONTINUUM_DISABLE_EMBEDDINGS;
  }
}

const command = process.argv[2] ?? "help";
try {
  if (command === "demo") {
    const config = await loadRuntimeConfig();
    await replay(config.fixturePath);
  } else if (command === "replay") {
    const path = process.argv[3];
    if (!path) throw new Error("Usage: continuum replay <fixture.jsonl>");
    await replay(path);
  } else if (command === "doctor") {
    await doctor();
  } else if (command === "emit") {
    await postEvent();
  } else if (command === "project-id") {
    printProjectId(process.argv[3]);
  } else if (command === "collect") {
    if (process.argv[3] !== "terminal") {
      throw new Error("Usage: continuum collect terminal <start|complete|flush> [arguments]");
    }
    await collectTerminal(process.argv.slice(4));
  } else if (command === "export-recording") {
    const output = process.argv[3];
    if (!output) throw new Error("Usage: continuum export-recording <output.jsonl> [projectId]");
    await exportRecording(output, process.argv[4]);
  } else if (command === "mcp-config") {
    printMcpConfig();
  } else if (command === "smoke-provider") {
    await smokeProvider(process.argv[3] ?? "", process.argv[4]);
  } else if (command === "benchmark-retrieval") {
    await benchmarkRetrieval(process.argv[3]);
  } else {
    process.stdout.write("Continuum CLI\n\nCommands: demo, replay <jsonl>, doctor, emit, project-id [path], collect terminal <start|complete|flush>, export-recording <output.jsonl> [projectId], mcp-config, smoke-provider <ollama|openai> [model], benchmark-retrieval [count]\n");
  }
} catch (error) {
  process.stderr.write(`continuum: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
