#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { loadRuntimeConfig, resolveDatabasePath } from "../runtime.js";
import { createEngine } from "../server/engine.js";
import { ContinuumDatabase } from "../db/database.js";
import { formatMcpConfig } from "./mcp-config.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function doctor(): Promise<void> {
  const config = await loadRuntimeConfig();
  const engine = await createEngine(config);
  try {
    const settings = engine.database.getModelSettings();
    const providerHealth = await engine.providers.health(settings);
    const report = {
      node: process.version,
      databasePath: config.databasePath,
      tokenPath: config.tokenPath,
      sqliteVector: engine.database.vectorAvailable,
      embedding: await engine.embeddings.status(),
      apple: providerHealth.apple,
      ollama: providerHealth.ollama,
      openai: providerHealth.openai,
      sync: engine.sync.status(),
      settings
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    engine.close();
  }
}

async function postEvent(): Promise<void> {
  const { EventsBatchSchema } = await import("@continuum/contracts");
  const config = await loadRuntimeConfig();
  const raw = await readStdin();
  const event = JSON.parse(raw) as unknown;
  const batch = EventsBatchSchema.parse({ events: [event] });
  const response = await fetch(`http://${config.host}:${config.port}/v1/events/batch`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify(batch)
  });
  if (!response.ok) throw new Error(`Engine rejected event: HTTP ${response.status}`);
  process.stdout.write(`${await response.text()}\n`);
}

function printMcpConfig(): void {
  const root = resolve(import.meta.dirname, "../../../..");
  process.stdout.write(formatMcpConfig(root, resolveDatabasePath()));
}

async function collectTerminal(args: string[]): Promise<void> {
  const mode = args[0];
  if (!mode || !["start", "complete", "flush"].includes(mode)) {
    throw new Error("Usage: continuum collect terminal <start|complete|flush> [arguments]");
  }
  const root = resolve(import.meta.dirname, "../../../..");
  const collector = resolve(root, "integrations/zsh/collector.mjs");
  await new Promise<void>((resolveChild, reject) => {
    const child = spawn(process.execPath, [collector, ...args], {
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveChild();
      else reject(new Error(`terminal collector exited ${signal ?? code ?? "unknown"}`));
    });
  });
}

async function exportRecording(outputPath: string, projectId?: string): Promise<void> {
  const config = await loadRuntimeConfig();
  const database = new ContinuumDatabase(config.databasePath, { readOnly: true });
  try {
    if (database.hasDemoEvents(projectId)) {
      throw new Error("Refusing to label a project containing synthetic demo events as a recorded live session");
    }
    const events = database.eventsForExport(projectId);
    const sources = new Set(events.map((event) => event.source));
    const required = ["vscode", "terminal", "git", "chrome"];
    const missing = required.filter((source) => !sources.has(source as typeof events[number]["source"]));
    if (missing.length > 0) throw new Error(`A recorded live session requires all four collectors; missing: ${missing.join(", ")}`);
    const destination = resolve(outputPath);
    const content = [
      "# Recorded live session — sanitized metadata exported by Continuum",
      ...events.map((event) => JSON.stringify(event))
    ].join("\n") + "\n";
    await writeFile(destination, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ label: "Recorded live session", path: destination, events: events.length, sources: required }, null, 2)}\n`);
  } finally {
    database.close();
  }
}

const command = process.argv[2] ?? "help";
try {
  if (command === "doctor") {
    await doctor();
  } else if (command === "emit") {
    await postEvent();
  } else if (command === "collect") {
    if (process.argv[3] !== "terminal") {
      throw new Error("Usage: continuum collect terminal <start|complete|flush> [arguments]");
    }
    await collectTerminal(process.argv.slice(4));
  } else if (command === "export-recording") {
    const output = process.argv[3];
    if (!output) throw new Error("Usage: continuum export-recording <output.jsonl> [projectId]");
    await exportRecording(output, process.argv[4]);
  } else if (command === "mcp-config") {
    printMcpConfig();
  } else {
    process.stdout.write("Continuum CLI\n\nCommands: doctor, emit, collect terminal <start|complete|flush>, export-recording <output.jsonl> [projectId], mcp-config\n");
  }
} catch (error) {
  process.stderr.write(`continuum: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
