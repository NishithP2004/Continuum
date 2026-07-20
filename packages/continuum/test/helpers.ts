import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedEventV1 } from "@continuum/contracts";
import type { RuntimeConfig } from "../src/runtime.js";

export async function testConfig(): Promise<RuntimeConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "continuum-test-"));
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    databasePath: join(dataDir, "continuum.sqlite"),
    tokenPath: join(dataDir, "auth.token"),
    token: "test-token",
    deviceIdentityPath: join(dataDir, "device-id"),
    ollamaUrl: "http://127.0.0.1:9"
  };
}

export function event(overrides: Partial<NormalizedEventV1> = {}): NormalizedEventV1 {
  return {
    version: "1",
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    source: "vscode",
    eventType: "vscode.progress",
    projectId: "test-project",
    title: "Made meaningful progress",
    attributes: { windowId: "test" },
    privacy: { classification: "public", rules: ["test"] },
    relevance: { decision: "keep", reason: "test" },
    confidence: 1,
    ...overrides
  };
}
