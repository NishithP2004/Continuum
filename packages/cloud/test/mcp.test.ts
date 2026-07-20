import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  boundedContextDiffV1,
  boundedContextPackV1,
  boundedTimelinePageV1,
  GraphSnapshotV1Schema,
  McpContextDiffV1Schema,
  McpContextPackV1Schema,
  McpTimelinePageV1Schema
} from "@continuum/contracts";
import { describe, expect, it } from "vitest";
import type { Principal } from "../src/auth/authenticator.js";
import type { GraphQuery, GraphSnapshot } from "../src/contracts.js";
import type { ContextDataSource } from "../src/context/data-source.js";
import { createRemoteMcpServer } from "../src/mcp/server.js";

const eventId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const generatedAt = "2026-07-20T12:00:00.000Z";
const checkpoint = {
  version: "1" as const,
  id: "checkpoint-live-1",
  projectId: "project-live",
  deviceId,
  windowId: "window-live-1",
  eventIds: [eventId],
  goal: "Ship remote MCP",
  focus: "Validate exact shared contracts",
  summary: "The remote context is synchronized and tenant-scoped.",
  progress: [{ text: "Validated the current context", eventIds: [eventId] }],
  blockers: [],
  hypotheses: [{ text: "The client supports structured content", status: "active" as const, eventIds: [eventId] }],
  decisions: [],
  questions: [],
  entities: [{ kind: "file" as const, key: "src/mcp.ts", label: "src/mcp.ts", eventIds: [eventId] }],
  importance: 0.9,
  confidence: 0.9,
  provider: "ollama" as const,
  model: "gemma3n:e2b",
  createdAt: generatedAt
};

function contextPack() {
  return {
    version: "1" as const,
    projectId: "project-live",
    generatedAt,
    currentGoal: checkpoint.goal,
    currentFocus: checkpoint.focus,
    checkpoints: [{ checkpoint, score: 1, reasons: ["remote test"] }],
    blockers: checkpoint.blockers,
    hypotheses: checkpoint.hypotheses,
    decisions: checkpoint.decisions,
    questions: checkpoint.questions,
    files: checkpoint.entities,
    commits: [],
    entities: checkpoint.entities,
    provenance: {
      checkpointIds: [checkpoint.id],
      deviceIds: [deviceId],
      rankingVersion: "remote-test-v1",
      degraded: false,
      maxCharacters: 12_000
    },
    approximateCharacters: 0
  };
}

class RecordingSource implements ContextDataSource {
  accounts: string[] = [];
  private record(accountId: string) {
    this.accounts.push(accountId);
  }
  async current(accountId: string) { this.record(accountId); return contextPack(); }
  async timeline(accountId: string) {
    this.record(accountId);
    return { version: "1" as const, projectId: "project-live", checkpoints: [checkpoint], nextCursor: null, truncated: false };
  }
  async search(accountId: string) { this.record(accountId); return contextPack(); }
  async resume(accountId: string) { this.record(accountId); return contextPack(); }
  async diff(accountId: string) {
    this.record(accountId);
    return {
      version: "1" as const,
      projectId: "project-live",
      deviceIds: [deviceId],
      baselineCheckpointId: checkpoint.id,
      currentCheckpointId: checkpoint.id,
      generatedAt,
      changes: [],
      addedBlockers: [],
      resolvedBlockers: [],
      changedHypotheses: checkpoint.hypotheses,
      newDecisions: [],
      newFiles: checkpoint.entities,
      newCommits: [],
      newEntities: checkpoint.entities
    };
  }
  async graph(accountId: string, _query: GraphQuery): Promise<GraphSnapshot> {
    this.record(accountId);
    return {
      version: "1",
      projectId: "project-live",
      generatedAt,
      nodes: Array.from({ length: 600 }, (_, index) => ({
        id: `node-${String(index).padStart(4, "0")}`,
        kind: "concept",
        label: `Bounded synchronized concept ${index}`,
        checkpointIds: [checkpoint.id],
        metadata: {}
      })),
      edges: [],
      nextCursor: null,
      truncated: false,
      degraded: false
    };
  }
}

const principal: Principal = {
  accountId: "account-a",
  subject: "auth0|user-a",
  clientId: "test",
  scopes: ["context:read"],
  token: "opaque-test-token",
  method: "oauth"
};

describe("remote MCP", () => {
  it("shares exact bounded read-only contracts and preserves tenant context", async () => {
    const source = new RecordingSource();
    const server = createRemoteMcpServer(principal, source);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "continuum-cloud-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["current", "diff", "graph", "resume", "search", "timeline"]);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);

    const calls = [
      ["current", {}, McpContextPackV1Schema],
      ["timeline", {}, McpTimelinePageV1Schema],
      ["search", { query: "remote MCP" }, McpContextPackV1Schema],
      ["resume", {}, McpContextPackV1Schema],
      ["diff", {}, McpContextDiffV1Schema],
      ["graph", {}, GraphSnapshotV1Schema]
    ] as const;
    for (const [name, args, schema] of calls) {
      const output = await client.callTool({ name, arguments: args });
      const structured = output.structuredContent as { data: unknown };
      expect(schema.safeParse(structured.data).success).toBe(true);
      expect(JSON.stringify(structured.data).length).toBeLessThanOrEqual(12_000);
      const content = Array.isArray(output.content) ? output.content as unknown[] : [];
      const text = content.find((item): item is { type: "text"; text: string } =>
        Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text"
      );
      expect(text?.text ?? "").toContain("Hypotheses are unverified");
    }

    const graph = await client.callTool({ name: "graph", arguments: {} });
    const graphData = (graph.structuredContent as { data: { nodes: unknown[]; edges: unknown[]; truncated: boolean } }).data;
    expect(graphData.nodes.length).toBeLessThanOrEqual(500);
    expect(graphData.edges.length).toBeLessThanOrEqual(1_000);
    expect(graphData.truncated).toBe(true);
    expect(source.accounts).toEqual(Array(7).fill("account-a"));
    await client.close();
    await server.close();
  });
});

describe("shared MCP caps", () => {
  it("keeps aggregate ContextPack facts attached to returned checkpoint provenance", () => {
    const graphEntities = Array.from({ length: 40 }, (_, index) => ({
      kind: "file" as const,
      key: `src/generated/${String(index).padStart(2, "0")}-${"k".repeat(120)}.ts`,
      label: `Generated context file ${index} ${"l".repeat(100)}`,
      eventIds: [eventId]
    }));
    const unbounded = {
      ...contextPack(),
      files: graphEntities,
      entities: graphEntities,
      provenance: { ...contextPack().provenance, maxCharacters: 12_000 }
    };
    expect(JSON.stringify(unbounded).length).toBeGreaterThan(12_000);
    const bounded = boundedContextPackV1(unbounded, 12_000);
    const facts = [...bounded.blockers, ...bounded.hypotheses, ...bounded.decisions, ...bounded.questions, ...bounded.files, ...bounded.commits, ...bounded.entities];
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(12_000);
    expect(facts.length).toBeGreaterThan(0);
    expect(bounded.checkpoints.length).toBeGreaterThan(0);
    expect(bounded.provenance.checkpointIds).toEqual(bounded.checkpoints.map((item) => item.checkpoint.id));
    expect(bounded.provenance.deviceIds).toEqual([deviceId]);
  });

  it("advances an empty oversized timeline page past its terminal checkpoint", () => {
    const evidence = Array.from({ length: 12 }, (_, index) => ({ text: `${index}:${"x".repeat(390)}`, eventIds: [eventId] }));
    const oversized = {
      ...checkpoint,
      id: "checkpoint-oversized-new",
      windowId: "window-oversized-new",
      summary: "s".repeat(1_200),
      progress: evidence,
      decisions: evidence,
      questions: evidence
    };
    const terminal = {
      ...oversized,
      id: "checkpoint-oversized-old",
      windowId: "window-oversized-old",
      createdAt: "2026-07-19T12:00:00.000Z"
    };
    const page = boundedTimelinePageV1({
      version: "1",
      projectId: "project-live",
      checkpoints: [oversized, terminal],
      nextCursor: null,
      truncated: false
    }, 1_000);
    expect(page.checkpoints).toEqual([]);
    expect(page.nextCursor).toBe(terminal.id);
    expect(page.truncated).toBe(true);
  });

  it("never retains a capped diff fact after its checkpoint-cited change is removed", () => {
    const addedBlockers = Array.from({ length: 12 }, (_, index) => ({
      text: `Cited blocker ${index} ${"b".repeat(280)}`,
      status: "open" as const,
      eventIds: [eventId]
    }));
    const bounded = boundedContextDiffV1({
      version: "1",
      projectId: "project-live",
      deviceIds: [deviceId],
      baselineCheckpointId: checkpoint.id,
      currentCheckpointId: checkpoint.id,
      generatedAt,
      changes: addedBlockers.map((item) => ({ type: "blocker_added" as const, text: item.text, checkpointIds: [checkpoint.id] })),
      addedBlockers,
      resolvedBlockers: [],
      changedHypotheses: [],
      newDecisions: [],
      newFiles: [],
      newCommits: [],
      newEntities: []
    }, 6_000);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(6_000);
    expect(bounded.addedBlockers.length).toBeGreaterThan(0);
    for (const item of bounded.addedBlockers) {
      expect(bounded.changes).toContainEqual(expect.objectContaining({
        type: "blocker_added",
        text: item.text,
        checkpointIds: [checkpoint.id]
      }));
    }
  });
});
