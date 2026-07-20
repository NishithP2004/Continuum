import type { Driver } from "neo4j-driver";
import { describe, expect, it, vi } from "vitest";
import { boundedGraphSnapshot, GraphSnapshotSchema, type GraphQuery } from "../src/contracts.js";
import type { ProjectionJob } from "../src/db/postgres.js";
import { Neo4jGraphReader, Neo4jProjector } from "../src/graph/neo4j.js";

interface DriverCall {
  query: string;
  parameters: Record<string, unknown>;
}

function record(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] };
}

function fakeDriver(results: Array<{ records: Array<ReturnType<typeof record>> }> = []) {
  const calls: DriverCall[] = [];
  const close = vi.fn(async () => undefined);
  const session = {
    run: vi.fn(async (query: string, parameters: Record<string, unknown> = {}) => {
      calls.push({ query, parameters });
      return results.shift() ?? { records: [] };
    }),
    close
  };
  const sessionFactory = vi.fn(() => session);
  const driver = {
    session: sessionFactory,
    verifyConnectivity: vi.fn(async () => undefined)
  } as unknown as Driver;
  return { calls, close, driver, sessionFactory };
}

function projectionJob(input: Partial<ProjectionJob> & Pick<ProjectionJob, "entityType" | "entityId">): ProjectionJob {
  return {
    outboxId: 1,
    accountId: "account-a",
    operationId: "operation-a",
    tombstone: false,
    payload: null,
    ...input
  };
}

function snapshot() {
  const nodes = Array.from({ length: 40 }, (_, index) => ({
    id: `node-${index}`,
    kind: "concept" as const,
    label: `Live concept ${index} ${"x".repeat(200)}`,
    checkpointIds: [`checkpoint-${index}`],
    metadata: { provenance: "live-sync" }
  }));
  return {
    version: "1" as const,
    projectId: "project-live",
    generatedAt: "2026-07-20T10:00:00.000Z",
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `edge-${index}`,
      source: nodes[index]!.id,
      target: node.id,
      kind: "relates",
      relation: "relates",
      checkpointIds: [`checkpoint-${index}`]
    })),
    nextCursor: null,
    truncated: false,
    degraded: false,
    projection: { status: "ready" as const }
  };
}

describe("remote graph response boundary", () => {
  it("enforces the response schema", () => {
    expect(() => GraphSnapshotSchema.parse({ ...snapshot(), unexpected: "payload" })).toThrow();
    expect(() => GraphSnapshotSchema.parse({ ...snapshot(), nodes: [{ ...snapshot().nodes[0], kind: "password" }] })).toThrow();
  });

  it("truncates nodes and dangling edges to the serialized character budget", () => {
    const result = boundedGraphSnapshot(snapshot(), 5_000);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(5_000);
    expect(result.truncated).toBe(true);
    expect(result.nodes.length).toBeLessThan(40);
    const nodeIds = new Set(result.nodes.map((node) => node.id));
    expect(result.edges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))).toBe(true);
  });
});

describe("Neo4j graph projection", () => {
  it("projects mutable redirects and re-homes existing provisional graph context", async () => {
    const fake = fakeDriver();
    const redirectFrom = "11111111-1111-4111-8111-111111111111";
    const redirectTo = "22222222-2222-4222-8222-222222222222";
    await new Neo4jProjector(fake.driver).project(projectionJob({
      entityType: "project",
      entityId: redirectFrom,
      payload: {
        id: redirectFrom,
        label: "Continuum",
        normalizedName: "continuum",
        repositoryFingerprint: "a".repeat(64),
        redirectFrom,
        redirectTo
      }
    }));

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.query).toContain("source.redirectTo = coalesce(target.redirectTo, $redirectTo)");
    expect(fake.calls[1]!.query).toContain("entity.projectId = $redirectFrom");
    expect(fake.calls[1]!.query).toContain("SET item.projectId = canonicalProjectId");
    expect(fake.calls[0]!.parameters).toMatchObject({ redirectFrom, redirectTo });
  });

  it("preserves shared graph-node provenance and legacy project scope", async () => {
    const fake = fakeDriver();
    const projector = new Neo4jProjector(fake.driver);

    await projector.project(projectionJob({
      entityType: "graph_node",
      entityId: "node:project-a:file:readme",
      payload: {
        kind: "file",
        label: "README.md",
        checkpointIds: ["checkpoint-a"],
        metadata: { projectId: "project-a", provenance: "live-sync", key: "README.md" }
      }
    }));

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.query).toContain("coalesce(n.checkpointIds, []) + $checkpointIds");
    expect(fake.calls[0]!.query).toContain("n.metadataJson");
    expect(fake.calls[0]!.parameters).toMatchObject({
      projectId: "project-a",
      checkpointIds: ["checkpoint-a"]
    });
    expect(JSON.parse(String(fake.calls[0]!.parameters.metadataJson))).toEqual({
      projectId: "project-a",
      provenance: "live-sync",
      key: "README.md"
    });
    expect(fake.close).toHaveBeenCalledOnce();

    const currentShape = fakeDriver();
    await new Neo4jProjector(currentShape.driver).project(projectionJob({
      entityType: "graph_node",
      entityId: "node:project-b:file:readme",
      payload: {
        kind: "file",
        label: "README.md",
        projectId: "project-b",
        checkpointIds: ["checkpoint-b"],
        metadata: { projectId: "legacy-project", key: "README.md" }
      }
    }));
    expect(currentShape.calls[0]!.parameters.projectId).toBe("project-b");
  });

  it("normalizes shared edge kinds and annotates mention-created nodes", async () => {
    const edgeFake = fakeDriver();
    await new Neo4jProjector(edgeFake.driver).project(projectionJob({
      entityType: "graph_edge",
      entityId: "edge-a",
      payload: {
        source: "node-a",
        target: "node-b",
        kind: "contains",
        checkpointIds: ["checkpoint-a"]
      }
    }));
    expect(edgeFake.calls[0]!.parameters.relation).toBe("contains");

    const checkpointFake = fakeDriver();
    await new Neo4jProjector(checkpointFake.driver).project(projectionJob({
      entityType: "checkpoint",
      entityId: "checkpoint-a",
      payload: {
        projectId: "project-a",
        goal: "Ship the graph",
        entities: [{ kind: "person", key: "Ada", label: "Ada Lovelace" }]
      }
    }));

    expect(checkpointFake.calls).toHaveLength(2);
    expect(checkpointFake.calls[0]!.parameters.checkpointIds).toEqual(["checkpoint-a"]);
    expect(checkpointFake.calls[1]!.query).toContain("coalesce(entity.checkpointIds, []) + [$entityId]");
    expect(checkpointFake.calls[1]!.query).toContain("entity.metadataJson");
    expect(checkpointFake.calls[1]!.parameters.projectId).toBe("project-a");
    expect(checkpointFake.calls[1]!.parameters.mentions).toEqual([{
      id: "concept:Ada",
      kind: "concept",
      label: "Ada Lovelace",
      metadataJson: JSON.stringify({ key: "Ada", provenance: "checkpoint_mention" })
    }]);
  });
});

describe("Neo4j graph expansion", () => {
  it("expands the selected node in Neo4j before applying the page", async () => {
    const fake = fakeDriver([
      { records: [
        record({ n: { properties: {
          entityId: "node-a", kind: "file", label: "A", projectId: "project-a",
          checkpointIds: ["checkpoint-a"], metadataJson: JSON.stringify({ provenance: "live-sync" })
        } } }),
        record({ n: { properties: {
          entityId: "node-b", kind: "file", label: "B", projectId: "project-a",
          checkpointIds: ["checkpoint-b"], metadataJson: JSON.stringify({ key: "B" })
        } } }),
        record({ n: { properties: { entityId: "node-c", kind: "file", label: "C" } } })
      ] },
      { records: [record({
        source: "node-a",
        target: "node-b",
        r: { properties: { edgeId: "edge-a", relation: "contains", checkpointIds: ["checkpoint-a"] } }
      })] }
    ]);
    const result = await new Neo4jGraphReader(fake.driver).graph("account-a", {
      projectId: "project-a",
      nodeKinds: ["file"],
      relations: ["contains"],
      aroundNodeId: "node-a",
      hops: 2,
      cursor: "4",
      limit: 2
    });

    const nodeCall = fake.calls[0]!;
    expect(nodeCall.query).toContain("MATCH path = (seed)-[:RELATES*0..2]-(n:ContinuumEntity)");
    expect(nodeCall.query).toContain("WITH DISTINCT n");
    expect(nodeCall.query).toContain("pathNode.accountId = $accountId");
    expect(nodeCall.query).toContain("relation.accountId = $accountId");
    expect(nodeCall.query.indexOf("MATCH path")).toBeLessThan(nodeCall.query.indexOf("SKIP $offset"));
    expect(nodeCall.parameters).toMatchObject({
      accountId: "account-a",
      projectId: "project-a",
      aroundNodeId: "node-a",
      nodeKinds: ["file"],
      relations: ["contains"]
    });
    expect((nodeCall.parameters.offset as { toNumber(): number }).toNumber()).toBe(4);
    expect((nodeCall.parameters.limit as { toNumber(): number }).toNumber()).toBe(3);
    expect(fake.calls[1]!.query).toContain("a.projectId = $projectId");
    expect(fake.calls[1]!.query).toContain("b.projectId = $projectId");
    expect(result.nodes.map((node) => node.id)).toEqual(["node-a", "node-b"]);
    expect(result.nodes[0]!.metadata).toEqual({ provenance: "live-sync" });
    expect(result.edges).toHaveLength(1);
    expect(result.nextCursor).toBe("6");
    expect(result.truncated).toBe(true);
  });

  it("uses a seed-only Neo4j query for zero hops", async () => {
    const fake = fakeDriver([
      { records: [record({ n: { properties: { entityId: "node-a", kind: "concept", label: "A" } } })] },
      { records: [] }
    ]);

    await new Neo4jGraphReader(fake.driver).graph("account-a", {
      aroundNodeId: "node-a",
      hops: 0,
      limit: 10
    });

    expect(fake.calls[0]!.query).toContain("entityId: $aroundNodeId");
    expect(fake.calls[0]!.query).not.toContain("MATCH path");
  });

  it("resolves a redirected project before filtering graph nodes", async () => {
    const redirectFrom = "11111111-1111-4111-8111-111111111111";
    const redirectTo = "22222222-2222-4222-8222-222222222222";
    const fake = fakeDriver([
      { records: [record({
        canonicalProjectId: redirectTo,
        n: { properties: { entityId: "node-old", kind: "file", label: "Old context", projectId: redirectTo } }
      })] },
      { records: [] }
    ]);
    const graph = await new Neo4jGraphReader(fake.driver).graph("account-a", {
      projectId: redirectFrom,
      hops: 1,
      limit: 10
    });

    expect(fake.calls[0]!.query).toContain("redirect.entityId = $projectId");
    expect(fake.calls[0]!.query).toContain("n.projectId = canonicalProjectId");
    expect(fake.calls[1]!.parameters.projectId).toBe(redirectTo);
    expect(graph.projectId).toBe(redirectTo);
    expect(graph.nodes[0]?.projectId).toBe(redirectTo);
  });

  it("rejects tenant, project, kind, and relation inputs beyond their caps", async () => {
    const fake = fakeDriver();
    const reader = new Neo4jGraphReader(fake.driver);
    const base = { hops: 1, limit: 10 };

    await expect(reader.graph("a".repeat(129), base)).rejects.toThrow("tenant cap");
    await expect(reader.graph("account-a", { ...base, projectId: "p".repeat(513) })).rejects.toThrow("projectId");
    await expect(reader.graph("account-a", {
      ...base,
      nodeKinds: Array.from({ length: 17 }, () => "concept")
    } as GraphQuery)).rejects.toThrow("nodeKinds");
    await expect(reader.graph("account-a", {
      ...base,
      relations: Array.from({ length: 33 }, (_, index) => `relation-${index}`)
    } as GraphQuery)).rejects.toThrow("relations");
    expect(fake.sessionFactory).not.toHaveBeenCalled();
  });
});
