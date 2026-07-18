#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "continuum-mcp-smoke-"));
const databasePath = join(temporaryDirectory, "continuum.sqlite");
const fixturePath = join(root, "fixtures", "jwt-friday-monday.jsonl");
const cliPath = join(root, "packages", "continuum", "dist", "cli", "main.js");
const mcpPath = join(root, "packages", "continuum", "dist", "mcp", "main.js");
const localOnlyMarker = "CONFIDENTIAL_LOCAL_ONLY_MCP_CANARY";

let client;
try {
  const replay = spawnSync(process.execPath, [cliPath, "replay", fixturePath], {
    cwd: root,
    env: {
      ...process.env,
      CONTINUUM_DATA_DIR: temporaryDirectory,
      CONTINUUM_DB: databasePath,
      CONTINUUM_DISABLE_EMBEDDINGS: "1"
    },
    encoding: "utf8"
  });
  if (replay.status !== 0) {
    throw new Error(`Fixture replay failed: ${replay.stderr || replay.stdout}`);
  }

  const writableDatabase = new DatabaseSync(databasePath);
  const projectId = "continuum-demo";
  const baselineRow = writableDatabase.prepare("SELECT baseline_checkpoint_id FROM projects WHERE id = ?").get(projectId);
  const eligibleBaselineId = String(baselineRow?.baseline_checkpoint_id ?? "");
  if (!eligibleBaselineId) throw new Error("Fixture replay did not create an acknowledged baseline");
  const localWindowId = "local-only-mcp-window-0001";
  const localCheckpointId = "local-only-mcp-checkpoint-0001";
  const localEventId = "00000000-0000-4000-8000-000000000002";
  const localCreatedAt = new Date(Date.now() + 60_000).toISOString();
  const localCheckpoint = {
    version: "1",
    id: localCheckpointId,
    projectId,
    windowId: localWindowId,
    eventIds: [localEventId],
    goal: localOnlyMarker,
    focus: localOnlyMarker,
    summary: localOnlyMarker,
    progress: [{ text: localOnlyMarker, eventIds: [localEventId] }],
    blockers: [{ text: localOnlyMarker, status: "open", eventIds: [localEventId] }],
    hypotheses: [],
    decisions: [],
    questions: [],
    entities: [{ kind: "blocker", key: "local-only-mcp", label: localOnlyMarker, eventIds: [localEventId] }],
    importance: 1,
    confidence: 1,
    provider: "deterministic",
    model: "mcp-smoke",
    createdAt: localCreatedAt
  };
  writableDatabase.prepare(`
    INSERT INTO windows(id, project_id, started_at, ended_at, status, provider, model, cloud_eligible, created_at)
    VALUES (?, ?, ?, ?, 'complete', 'deterministic', 'mcp-smoke', 0, ?)
  `).run(localWindowId, projectId, localCreatedAt, localCreatedAt, localCreatedAt);
  const inserted = writableDatabase.prepare(`
    INSERT INTO checkpoints(id, project_id, window_id, goal, focus, summary, importance, provider, model, checkpoint_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    localCheckpointId,
    projectId,
    localWindowId,
    localOnlyMarker,
    localOnlyMarker,
    localOnlyMarker,
    1,
    "deterministic",
    "mcp-smoke",
    JSON.stringify(localCheckpoint),
    localCreatedAt
  );
  writableDatabase.prepare("INSERT INTO checkpoint_fts(rowid, project_id, goal, focus, summary, items) VALUES (?, ?, ?, ?, ?, ?)")
    .run(inserted.lastInsertRowid, projectId, localOnlyMarker, localOnlyMarker, localOnlyMarker, localOnlyMarker);

  const largeWindowId = "large-mcp-window-0001";
  const largeCheckpointId = "large-mcp-checkpoint-0001";
  const largeEventId = "00000000-0000-4000-8000-000000000003";
  const largeCreatedAt = new Date(Date.now() + 30_000).toISOString();
  const evidence = Array.from({ length: 12 }, (_, index) => ({
    text: `Bounded timeline evidence ${index}: ${"x".repeat(340)}`,
    eventIds: [largeEventId]
  }));
  const largeCheckpoint = {
    version: "1",
    id: largeCheckpointId,
    projectId,
    windowId: largeWindowId,
    eventIds: [largeEventId],
    goal: "Exercise the MCP timeline hard cap",
    focus: "Large evidence-backed checkpoint",
    summary: "s".repeat(1_100),
    progress: evidence,
    blockers: [],
    hypotheses: [],
    decisions: evidence,
    questions: evidence,
    entities: [],
    importance: 0.9,
    confidence: 1,
    provider: "deterministic",
    model: "mcp-smoke",
    createdAt: largeCreatedAt
  };
  writableDatabase.prepare(`
    INSERT INTO windows(id, project_id, started_at, ended_at, status, provider, model, cloud_eligible, created_at)
    VALUES (?, ?, ?, ?, 'complete', 'deterministic', 'mcp-smoke', 1, ?)
  `).run(largeWindowId, projectId, largeCreatedAt, largeCreatedAt, largeCreatedAt);
  const largeInserted = writableDatabase.prepare(`
    INSERT INTO checkpoints(id, project_id, window_id, goal, focus, summary, importance, provider, model, checkpoint_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    largeCheckpointId,
    projectId,
    largeWindowId,
    largeCheckpoint.goal,
    largeCheckpoint.focus,
    largeCheckpoint.summary,
    largeCheckpoint.importance,
    largeCheckpoint.provider,
    largeCheckpoint.model,
    JSON.stringify(largeCheckpoint),
    largeCreatedAt
  );
  writableDatabase.prepare("INSERT INTO checkpoint_fts(rowid, project_id, goal, focus, summary, items) VALUES (?, ?, ?, ?, ?, ?)")
    .run(largeInserted.lastInsertRowid, projectId, largeCheckpoint.goal, largeCheckpoint.focus, largeCheckpoint.summary, evidence.map((item) => item.text).join(" "));
  writableDatabase.prepare("UPDATE projects SET baseline_checkpoint_id = ? WHERE id = ?").run(localCheckpointId, projectId);
  writableDatabase.close();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpPath, "--db", databasePath],
    cwd: root,
    env: { ...process.env, CONTINUUM_DISABLE_EMBEDDINGS: "1" },
    stderr: "pipe"
  });
  client = new Client({ name: "continuum-smoke", version: "0.1.0" });
  await client.connect(transport);

  const discovery = await client.listTools();
  const expectedTools = ["current", "timeline", "search", "resume", "diff"];
  const discoveredNames = new Set(discovery.tools.map((tool) => tool.name));
  for (const name of expectedTools) {
    if (!discoveredNames.has(name)) throw new Error(`MCP discovery omitted ${name}`);
  }

  const calls = [
    ["current", { projectId: "continuum-demo" }],
    ["timeline", { projectId: "continuum-demo", limit: 2 }],
    ["search", { projectId: "continuum-demo", query: localOnlyMarker, limit: 1 }],
    ["resume", { projectId: "continuum-demo", maxChars: 12_000 }],
    ["diff", { projectId: "continuum-demo", sinceCheckpointId: eligibleBaselineId, maxChars: 12_000 }]
  ];

  for (const [name, args] of calls) {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name} returned an MCP error`);
    const text = result.content?.find((item) => item.type === "text")?.text;
    if (!text) throw new Error(`${name} omitted compatibility text`);
    JSON.parse(text);
    if (!result.structuredContent || !("data" in result.structuredContent)) {
      throw new Error(`${name} omitted structuredContent.data`);
    }
    if (JSON.stringify(result).includes("CONTINUUM_DEMO_SECRET_SHOULD_NEVER_APPEAR") || JSON.stringify(result).includes(localOnlyMarker)) {
      throw new Error(`${name} leaked a privacy canary`);
    }
    if (JSON.stringify(result.structuredContent.data).length > 12_000) {
      throw new Error(`${name} exceeded the 12,000-character hard limit`);
    }
    if (name === "search" && result.structuredContent.data.checkpoints.length > 1) {
      throw new Error("search ignored its checkpoint limit");
    }
    if (name === "timeline" && result.structuredContent.data.truncated !== true) {
      throw new Error("timeline hard-cap fixture did not exercise truncation");
    }
  }

  const rejectedLocalBaseline = await client.callTool({ name: "diff", arguments: { projectId, maxChars: 12_000 } });
  if (!rejectedLocalBaseline.isError) throw new Error("diff accepted an acknowledged local-only baseline");
  const rejectedExplicitLocalBaseline = await client.callTool({
    name: "diff",
    arguments: { projectId, sinceCheckpointId: localCheckpointId, maxChars: 12_000 }
  });
  if (!rejectedExplicitLocalBaseline.isError) throw new Error("diff accepted an explicit local-only baseline");
  const rejectedLocalCursor = await client.callTool({
    name: "timeline",
    arguments: { projectId, cursor: localCheckpointId, limit: 2 }
  });
  if (!rejectedLocalCursor.isError) throw new Error("timeline accepted a local-only cursor");

  const tightlyBoundedDiff = await client.callTool({
    name: "diff",
    arguments: { projectId: "continuum-demo", sinceCheckpointId: eligibleBaselineId, maxChars: 1_000 }
  });
  if (JSON.stringify(tightlyBoundedDiff.structuredContent?.data).length > 1_000) {
    throw new Error("diff ignored an explicit maxChars limit");
  }

  const before = await readFile(databasePath);
  await client.callTool({ name: "resume", arguments: { projectId: "continuum-demo" } });
  const after = await readFile(databasePath);
  if (!before.equals(after)) throw new Error("Read-only MCP call modified SQLite");

  process.stdout.write(`MCP smoke passed: ${expectedTools.join(", ")}\n`);
} finally {
  if (client) await client.close().catch(() => undefined);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
