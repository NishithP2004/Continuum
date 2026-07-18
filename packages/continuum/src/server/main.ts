#!/usr/bin/env node
import { loadRuntimeConfig } from "../runtime.js";
import { createEngine } from "./engine.js";
import { buildApp } from "./app.js";

const config = await loadRuntimeConfig();
const engine = await createEngine(config);
const app = await buildApp(engine);

const shutdown = async (): Promise<void> => {
  await app.close();
  engine.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.listen({ host: config.host, port: config.port });
app.log.info({ host: config.host, port: config.port, databasePath: config.databasePath, tokenPath: config.tokenPath }, "Continuum engine ready");
