import type { PostgresStore } from "./db/postgres.js";
import type { Neo4jProjector } from "./graph/neo4j.js";

export class ProjectionWorker {
  constructor(private readonly store: PostgresStore, private readonly projector: Neo4jProjector) {}

  async runOnce(limit = 50): Promise<{ projected: number; failed: number }> {
    const jobs = await this.store.leaseProjectionJobs(limit);
    let projected = 0;
    let failed = 0;
    let connectivityError: unknown;
    if (jobs.length > 0) {
      try {
        await this.projector.verifyConnectivity();
      } catch (error) {
        connectivityError = error;
      }
    }
    for (const job of jobs) {
      try {
        if (connectivityError) throw connectivityError;
        await this.projector.project(job);
        await this.store.projectionSucceeded(job);
        projected += 1;
      } catch (error) {
        await this.store.projectionFailed(job, error);
        failed += 1;
      }
    }
    if (jobs.length > 0) {
      await this.store.reconcileProjectionState(jobs.map((job) => job.accountId));
    }
    return { projected, failed };
  }
}
