#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { PostgresStore } from "./db/postgres.js";
import { createNeo4jDriver, Neo4jProjector } from "./graph/neo4j.js";
import { ProjectionWorker } from "./worker.js";

const config = loadConfig();
const store = new PostgresStore(config.DATABASE_URL);
await store.migrate();
const driver = createNeo4jDriver(config.NEO4J_URI, config.NEO4J_USER, config.NEO4J_PASSWORD);
const projector = new Neo4jProjector(driver);
const worker = new ProjectionWorker(store, projector);
let stopping = false;

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

if (process.argv.includes("--rebuild")) {
  if (process.env.CONTINUUM_CONFIRM_REBUILD !== "1") throw new Error("Set CONTINUUM_CONFIRM_REBUILD=1 to rebuild the Neo4j projection");
  await projector.clearProjection();
  await store.resetProjectionOutbox();
}

try {
  while (!stopping) {
    const result = await worker.runOnce();
    if (result.projected === 0 && result.failed === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, config.PROJECTION_INTERVAL_MS));
    }
  }
} finally {
  await driver.close();
  await store.close();
}
