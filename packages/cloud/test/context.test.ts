import { describe, expect, it, vi } from "vitest";
import { GraphSnapshotV1Schema, McpContextDiffV1Schema, McpContextPackV1Schema } from "@continuum/contracts";
import { PostgresContextDataSource } from "../src/context/postgres-source.js";
import type { SqlExecutor } from "../src/db/postgres.js";

const fridayEventId = "11111111-1111-4111-8111-111111111111";
const mondayEventId = "22222222-2222-4222-8222-222222222222";
const deviceId = "33333333-3333-4333-8333-333333333333";

const baseline = {
  version: "1" as const,
  id: "checkpoint-friday",
  projectId: "project-live",
  deviceId,
  windowId: "window-friday",
  eventIds: [fridayEventId],
  goal: "Ship live sync",
  focus: "Repair authentication",
  summary: "Authentication is failing",
  progress: [{ text: "Reproduced the rejection", eventIds: [fridayEventId] }],
  blockers: [{ text: "Bearer rejected", status: "open", eventIds: [fridayEventId] }],
  hypotheses: [{ text: "Audience mismatch", status: "active", eventIds: [fridayEventId] }],
  decisions: [],
  questions: [],
  entities: [],
  importance: 0.8,
  confidence: 0.8,
  provider: "ollama" as const,
  model: "gemma3n:e2b",
  createdAt: "2026-07-17T12:00:00.000Z"
};

const current = {
  version: "1" as const,
  id: "checkpoint-monday",
  projectId: "project-live",
  deviceId,
  windowId: "window-monday",
  eventIds: [mondayEventId],
  goal: "Ship live sync",
  focus: "Exercise remote MCP",
  summary: "Authentication now passes",
  progress: [{ text: "Authenticated the remote client", eventIds: [mondayEventId] }],
  blockers: [{ text: "Bearer rejected", status: "resolved", eventIds: [mondayEventId] }],
  hypotheses: [{ text: "Audience mismatch", status: "supported", eventIds: [mondayEventId] }],
  decisions: [{ text: "Validate the audience", eventIds: [mondayEventId] }],
  questions: [],
  entities: [
    { kind: "commit" as const, key: "abc123", label: "Fix auth", eventIds: [mondayEventId] },
    { kind: "file" as const, key: "src/auth.ts", label: "src/auth.ts", eventIds: [mondayEventId] }
  ],
  importance: 0.9,
  confidence: 0.9,
  provider: "ollama" as const,
  model: "gemma3n:e2b",
  createdAt: "2026-07-20T12:00:00.000Z"
};

describe("remote context diff", () => {
  it("uses the synchronized acknowledged baseline even when it is outside the timeline window", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("entity_type = 'baseline'")) return { rows: [{ payload: { projectId: "project-live", checkpointId: "checkpoint-friday" } }], rowCount: 1 };
      if (sql.includes("entity_id = $2")) return { rows: [{ entity_id: baseline.id, payload: baseline, updated_at: new Date("2026-07-17T12:00:00Z") }], rowCount: 1 };
      if (sql.includes("ORDER BY updated_at DESC")) return { rows: [{ entity_id: current.id, payload: current, updated_at: new Date("2026-07-20T12:00:00Z") }], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const source = new PostgresContextDataSource({ query } as unknown as SqlExecutor);
    const diff = await source.diff("account-a", { projectId: "project-live", maxChars: 12_000 });
    expect(McpContextDiffV1Schema.safeParse(diff).success).toBe(true);
    expect(diff).toMatchObject({
      baselineCheckpointId: "checkpoint-friday",
      currentCheckpointId: "checkpoint-monday"
    });
    expect(diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "blocker_resolved", text: "Bearer rejected" }),
      expect.objectContaining({ type: "hypothesis_changed", text: "supported: Audience mismatch" }),
      expect.objectContaining({ type: "decision_added", text: "Validate the audience" }),
      expect.objectContaining({ type: "commit_added", text: "Fix auth" })
    ]));
    expect(query.mock.calls.some(([sql]) => String(sql).includes("entity_type = 'baseline'"))).toBe(true);
  });
});

describe("remote project redirects", () => {
  it("returns provisional immutable checkpoints through the confirmed canonical project", async () => {
    const provisionalProjectId = "11111111-1111-4111-8111-111111111111";
    const targetProjectId = "22222222-2222-4222-8222-222222222222";
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(sql).toContain("WITH RECURSIVE live_project_redirects");
      expect(sql).toContain("canonical_redirects");
      expect(sql).toContain("AS canonical_project_id");
      expect(values).toEqual(["account-a", targetProjectId]);
      return {
        rows: [{
          entity_id: "checkpoint-provisional",
          payload: { ...current, id: "checkpoint-provisional", projectId: provisionalProjectId },
          canonical_project_id: targetProjectId,
          updated_at: new Date("2026-07-20T12:00:00Z")
        }],
        rowCount: 1
      };
    });
    const source = new PostgresContextDataSource({ query } as unknown as SqlExecutor);
    const result = await source.current("account-a", { projectId: targetProjectId, maxChars: 12_000 });
    expect(McpContextPackV1Schema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      projectId: targetProjectId,
      provenance: { checkpointIds: ["checkpoint-provisional"], deviceIds: [deviceId] },
      files: [{ key: "src/auth.ts" }],
      commits: [{ key: "abc123" }],
      entities: expect.arrayContaining([expect.objectContaining({ key: "src/auth.ts" }), expect.objectContaining({ key: "abc123" })])
    });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(12_000);
    expect(query).toHaveBeenCalledOnce();
  });
});

describe("PostgreSQL degraded graph projection", () => {
  it("expands the selected neighborhood before pagination and accepts legacy project metadata", async () => {
    const edge = {
      entity_id: "edge-center-neighbor",
      payload: {
        source: "node-center",
        target: "node-neighbor",
        kind: "BLOCKS",
        checkpointIds: ["checkpoint-live"]
      },
      updated_at: new Date("2026-07-20T12:00:00Z")
    };
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("payload->>'source' = ANY($2::text[]) OR")) {
        expect(values).toEqual(["account-a", ["node-center"], ["BLOCKS"], 10_001]);
        return { rows: [edge], rowCount: 1 };
      }
      if (sql.includes("entity_type = 'graph_node'")) {
        expect(sql).toContain("COALESCE(payload->>'projectId', payload->'metadata'->>'projectId')");
        expect(values).toEqual(["account-a", "project-live", ["node-center", "node-neighbor"], 3, 0]);
        return {
          rows: [
            {
              entity_id: "node-center",
              payload: { kind: "task", label: "Center", checkpointIds: ["checkpoint-live"], metadata: { projectId: "project-live" } },
              updated_at: new Date("2026-07-20T12:00:00Z")
            },
            {
              entity_id: "node-neighbor",
              payload: { kind: "blocker", label: "Neighbor", checkpointIds: ["checkpoint-live"], metadata: { projectId: "project-live" } },
              updated_at: new Date("2026-07-20T12:00:00Z")
            }
          ],
          rowCount: 2
        };
      }
      if (sql.includes("payload->>'source' = ANY($2::text[]) AND")) {
        expect(values).toEqual(["account-a", ["node-center", "node-neighbor"], ["BLOCKS"], 1_001]);
        return { rows: [edge], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const source = new PostgresContextDataSource({ query } as unknown as SqlExecutor);
    const graph = await source.graph("account-a", {
      projectId: "project-live",
      aroundNodeId: "node-center",
      hops: 1,
      edgeKinds: ["BLOCKS"],
      limit: 2
    });

    expect(GraphSnapshotV1Schema.safeParse(graph).success).toBe(true);
    expect(graph.nodes.map((node) => node.id)).toEqual(["node-center", "node-neighbor"]);
    expect(graph.nodes.every((node) => node.projectId === "project-live")).toBe(true);
    expect(graph.edges).toEqual([expect.objectContaining({ source: "node-center", target: "node-neighbor", kind: "BLOCKS" })]);
    expect(graph.degraded).toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
  });
});
