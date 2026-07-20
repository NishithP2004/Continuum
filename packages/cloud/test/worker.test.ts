import { describe, expect, it, vi } from "vitest";
import type { PostgresStore, ProjectionJob } from "../src/db/postgres.js";
import type { Neo4jProjector } from "../src/graph/neo4j.js";
import { ProjectionWorker } from "../src/worker.js";

const jobs: ProjectionJob[] = [
  { outboxId: 1, accountId: "account-a", operationId: "op-a", entityType: "graph_node", entityId: "node-a", tombstone: false, payload: { label: "A" } },
  { outboxId: 2, accountId: "account-b", operationId: "op-b", entityType: "graph_node", entityId: "node-b", tombstone: false, payload: { label: "B" } }
];

describe("Neo4j projection outage", () => {
  it("checks connectivity once and marks every leased tenant job degraded", async () => {
    const failed = vi.fn(async () => undefined);
    const reconciled = vi.fn(async () => undefined);
    const store = {
      leaseProjectionJobs: vi.fn(async () => jobs),
      projectionSucceeded: vi.fn(async () => undefined),
      projectionFailed: failed,
      reconcileProjectionState: reconciled
    } as unknown as PostgresStore;
    const projector = {
      verifyConnectivity: vi.fn(async () => { throw new Error("neo4j offline"); }),
      project: vi.fn(async () => undefined)
    } as unknown as Neo4jProjector;
    const result = await new ProjectionWorker(store, projector).runOnce();
    expect(result).toEqual({ projected: 0, failed: 2 });
    expect(projector.verifyConnectivity).toHaveBeenCalledOnce();
    expect(projector.project).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(2);
    expect(reconciled).toHaveBeenCalledWith(["account-a", "account-b"]);
  });

  it("reconciles account health after a mixed batch instead of treating one success as recovery", async () => {
    const sameAccountJobs = jobs.map((job) => ({ ...job, accountId: "account-a" }));
    const succeeded = vi.fn(async () => undefined);
    const failed = vi.fn(async () => undefined);
    const reconciled = vi.fn(async () => undefined);
    const store = {
      leaseProjectionJobs: vi.fn(async () => sameAccountJobs),
      projectionSucceeded: succeeded,
      projectionFailed: failed,
      reconcileProjectionState: reconciled
    } as unknown as PostgresStore;
    const projector = {
      verifyConnectivity: vi.fn(async () => undefined),
      project: vi.fn(async (job: ProjectionJob) => {
        if (job.outboxId === 1) throw new Error("one projection failed");
      })
    } as unknown as Neo4jProjector;

    await expect(new ProjectionWorker(store, projector).runOnce()).resolves.toEqual({ projected: 1, failed: 1 });
    expect(failed).toHaveBeenCalledWith(sameAccountJobs[0], expect.any(Error));
    expect(succeeded).toHaveBeenCalledWith(sameAccountJobs[1]);
    expect(reconciled).toHaveBeenCalledWith(["account-a", "account-a"]);
  });
});
