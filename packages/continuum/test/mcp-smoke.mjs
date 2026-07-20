#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  GraphSnapshotV1Schema,
  McpContextDiffV1Schema,
  McpContextPackV1Schema,
  McpTimelinePageV1Schema
} from "@continuum/contracts";
import { ContinuumDatabase } from "../dist/db/database.js";

const root = resolve(import.meta.dirname, "../../..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "continuum-mcp-smoke-"));
const databasePath = join(temporaryDirectory, "continuum.sqlite");
const mcpWrapper = join(root, "script", "run_mcp.sh");
const localOnlyMarker = "CONFIDENTIAL_LOCAL_ONLY_MCP_CANARY";
const projectId = randomUUID();

function addCheckpoint(database, checkpoint, cloudEligible) {
  database.raw.prepare(`
    INSERT INTO windows(id, project_id, started_at, ended_at, status, provider, model, cloud_eligible, created_at)
    VALUES (?, ?, ?, ?, 'complete', 'deterministic', 'mcp-smoke', ?, ?)
  `).run(checkpoint.windowId, projectId, checkpoint.createdAt, checkpoint.createdAt, cloudEligible ? 1 : 0, checkpoint.createdAt);
  database.insertCheckpoint(checkpoint);
}

let client;
try {
  const writableDatabase = new ContinuumDatabase(databasePath);
  writableDatabase.ensureProject(projectId, "Live MCP smoke project");
  const baselineEventId = randomUUID();
  const eligibleBaselineId = "eligible-mcp-checkpoint-0001";
  const baselineCreatedAt = new Date(Date.now() - 60_000).toISOString();
  addCheckpoint(writableDatabase, {
    version: "1",
    id: eligibleBaselineId,
    projectId,
    windowId: "eligible-mcp-window-0001",
    eventIds: [baselineEventId],
    goal: "Resume live collector integration",
    focus: "Verify grounded MCP context",
    summary: "The live engine produced a cloud-eligible checkpoint.",
    progress: [{ text: "Live collector integration is ready", eventIds: [baselineEventId] }],
    blockers: [],
    hypotheses: [{ text: "Graph expansion may improve retrieval", status: "active", eventIds: [baselineEventId] }],
    decisions: [],
    questions: [],
    entities: [
      { kind: "file", key: "src/live-engine.ts", label: "src/live-engine.ts", eventIds: [baselineEventId] },
      { kind: "commit", key: "a0ada710a0ada710a0ada710a0ada710a0ada710", label: "Commit a0ada710a0ad", eventIds: [baselineEventId] }
    ],
    importance: 0.8,
    confidence: 1,
    provider: "deterministic",
    model: "mcp-smoke",
    createdAt: baselineCreatedAt
  }, true);

  const largeEventId = randomUUID();
  const largeCheckpointId = "large-mcp-checkpoint-0001";
  const largeCreatedAt = new Date(Date.now() - 30_000).toISOString();
  const evidence = Array.from({ length: 12 }, (_, index) => ({
    text: `Bounded timeline evidence ${index}: ${"x".repeat(210)}`,
    eventIds: [largeEventId]
  }));
  addCheckpoint(writableDatabase, {
    version: "1",
    id: largeCheckpointId,
    projectId,
    windowId: "large-mcp-window-0001",
    eventIds: [largeEventId],
    goal: "Exercise the MCP timeline hard cap",
    focus: "Large evidence-backed checkpoint",
    summary: "s".repeat(240),
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
  }, true);

  const localEventId = randomUUID();
  const localCheckpointId = "local-only-mcp-checkpoint-0001";
  const localCreatedAt = new Date().toISOString();
  addCheckpoint(writableDatabase, {
    version: "1",
    id: localCheckpointId,
    projectId,
    windowId: "local-only-mcp-window-0001",
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
  }, false);
  writableDatabase.acknowledge(projectId, localCheckpointId);
  writableDatabase.close();

  const mcpEnvironment = { ...process.env, CONTINUUM_DATA_DIR: temporaryDirectory, CONTINUUM_DISABLE_EMBEDDINGS: "1" };
  delete mcpEnvironment.CONTINUUM_DB;
  const transport = new StdioClientTransport({
    command: mcpWrapper,
    args: [],
    cwd: root,
    env: mcpEnvironment,
    stderr: "pipe"
  });
  client = new Client({ name: "continuum-smoke", version: "0.1.0" });
  await client.connect(transport);

  const discovery = await client.listTools();
  const expectedTools = ["current", "timeline", "search", "resume", "diff", "graph"];
  const discoveredNames = new Set(discovery.tools.map((tool) => tool.name));
  for (const name of expectedTools) if (!discoveredNames.has(name)) throw new Error(`MCP discovery omitted ${name}`);

  const calls = [
    ["current", { projectId }],
    ["timeline", { projectId, limit: 2 }],
    ["search", { projectId, query: localOnlyMarker, limit: 1 }],
    ["resume", { projectId, maxChars: 12_000 }],
    ["diff", { projectId, sinceCheckpointId: eligibleBaselineId, maxChars: 12_000 }],
    ["graph", { projectId, limit: 100, hops: 1 }]
  ];
  const outputSchemas = {
    current: McpContextPackV1Schema,
    timeline: McpTimelinePageV1Schema,
    search: McpContextPackV1Schema,
    resume: McpContextPackV1Schema,
    diff: McpContextDiffV1Schema,
    graph: GraphSnapshotV1Schema
  };

  for (const [name, args] of calls) {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name} returned an MCP error: ${JSON.stringify(result)}`);
    const text = result.content?.find((item) => item.type === "text")?.text;
    if (!text) throw new Error(`${name} omitted compatibility text`);
    if (!text.includes("Hypotheses are unverified")) throw new Error(`${name} omitted the unverified-hypothesis warning`);
    const serialized = text.slice(text.indexOf("\n") + 1);
    JSON.parse(serialized);
    if (!result.structuredContent || !("data" in result.structuredContent)) throw new Error(`${name} omitted structuredContent.data`);
    if (!outputSchemas[name].safeParse(result.structuredContent.data).success) throw new Error(`${name} violated its shared output contract`);
    if (JSON.stringify(result).includes(localOnlyMarker)) throw new Error(`${name} leaked a local-only privacy canary`);
    if (JSON.stringify(result.structuredContent.data).length > 12_000) throw new Error(`${name} exceeded the 12,000-character hard limit`);
    if (name === "search" && result.structuredContent.data.checkpoints.length > 1) throw new Error("search ignored its checkpoint limit");
    if (name === "timeline" && result.structuredContent.data.truncated !== true) throw new Error("timeline hard-cap fixture did not exercise truncation");
    if (name === "graph" && result.structuredContent.data.nodes.length === 0) throw new Error("graph returned no eligible nodes");
  }

  for (const request of [
    { name: "diff", arguments: { projectId, maxChars: 12_000 } },
    { name: "diff", arguments: { projectId, sinceCheckpointId: localCheckpointId, maxChars: 12_000 } },
    { name: "timeline", arguments: { projectId, cursor: localCheckpointId, limit: 2 } }
  ]) {
    const result = await client.callTool(request);
    if (!result.isError) throw new Error(`${request.name} accepted a local-only checkpoint boundary`);
  }

  const tightlyBoundedDiff = await client.callTool({
    name: "diff",
    arguments: { projectId, sinceCheckpointId: eligibleBaselineId, maxChars: 1_000 }
  });
  if (JSON.stringify(tightlyBoundedDiff.structuredContent?.data).length > 1_000) throw new Error("diff ignored maxChars");

  const before = await readFile(databasePath);
  await client.callTool({ name: "resume", arguments: { projectId } });
  const after = await readFile(databasePath);
  if (!before.equals(after)) throw new Error("Read-only MCP call modified SQLite");

  process.stdout.write(`MCP smoke passed: ${expectedTools.join(", ")}\n`);
} finally {
  if (client) await client.close().catch(() => undefined);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
