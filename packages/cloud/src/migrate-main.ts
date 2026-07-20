#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { PostgresStore } from "./db/postgres.js";

const config = loadConfig();
const store = new PostgresStore(config.DATABASE_URL);
try {
  await store.migrate();
  process.stderr.write("Continuum cloud migrations are current.\n");
} finally {
  await store.close();
}
