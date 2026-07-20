#!/usr/bin/env node
import { ContinuumAuthenticator } from "./auth/authenticator.js";
import { createCloudApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PostgresContextDataSource } from "./context/postgres-source.js";
import { CompositeContextDataSource } from "./context/composite-source.js";
import { PostgresStore } from "./db/postgres.js";
import { createNeo4jDriver, Neo4jGraphReader } from "./graph/neo4j.js";

const config = loadConfig();
const store = new PostgresStore(config.DATABASE_URL);
await store.migrate();
await store.purgeExpired();
const postgresContext = new PostgresContextDataSource(store);
const neo4jDriver = createNeo4jDriver(config.NEO4J_URI, config.NEO4J_USER, config.NEO4J_PASSWORD);
const context = new CompositeContextDataSource(postgresContext, new Neo4jGraphReader(neo4jDriver));
const authenticator = new ContinuumAuthenticator(store, config.AUTH0_ISSUER, config.AUTH0_AUDIENCE, config.API_KEY_PEPPER);
const app = createCloudApp({
  store,
  context,
  authenticator,
  apiKeyPepper: config.API_KEY_PEPPER,
  auth0Issuer: config.AUTH0_ISSUER,
  publicBaseUrl: config.PUBLIC_BASE_URL,
  logger: { level: config.LOG_LEVEL }
});

await app.listen({ host: config.HOST, port: config.PORT });

const close = async () => {
  await app.close();
  await neo4jDriver.close();
  await store.close();
  process.exit(0);
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
