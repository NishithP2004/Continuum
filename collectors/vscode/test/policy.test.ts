import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyVscodePolicy,
  failClosedPrivacyPolicy,
  PrivacyPolicyCache,
} from "../src/policy";
import { DurableEventQueue } from "../src/queue";
import { EventTransport } from "../src/transport";
import type { NormalizedEventV2Draft, PrivacyPolicyV1 } from "../src/types";

function enabledPolicy(overrides: {
  revision?: number;
  sources?: Partial<PrivacyPolicyV1["sources"]>;
  metadata?: Partial<PrivacyPolicyV1["metadata"]>;
  ignoredPathPatterns?: string[];
} = {}): PrivacyPolicyV1 {
  const policy = failClosedPrivacyPolicy();
  return {
    ...policy,
    revision: overrides.revision ?? 6,
    updatedAt: new Date().toISOString(),
    sources: { ...policy.sources, vscode: true, ...overrides.sources },
    metadata: {
      ...policy.metadata,
      relativeFilePaths: true,
      personalMetadata: true,
      ...overrides.metadata,
    },
    ignoredPathPatterns: overrides.ignoredPathPatterns ?? [],
  };
}

function event(): NormalizedEventV2Draft {
  return {
    version: "2",
    id: "0177902e-cd33-4e67-b31b-c2a4148bdd68",
    deviceId: "device-vscode-policy",
    occurredAt: new Date().toISOString(),
    hlc: `${Date.now()}:0:device-vscode-policy`,
    source: "vscode",
    eventType: "file.saved",
    projectLocator: { localAlias: "a".repeat(64) },
    title: "Saved engine.ts",
    attributes: { path: "src/engine.ts", languageId: "typescript", projectName: "continuum" },
    privacy: { classification: "personal", rules: ["workspace-relative-path"] },
    relevance: { decision: "keep", reason: "trusted-workspace" },
    confidence: 1,
    dedupeKey: "vscode-policy-test",
  };
}

test("applies VS Code source, path and sync policy before persistence", () => {
  assert.equal(applyVscodePolicy(event(), enabledPolicy({ sources: { vscode: false } })), undefined);
  assert.equal(applyVscodePolicy(event(), enabledPolicy({ metadata: { personalMetadata: false } })), undefined);
  assert.equal(applyVscodePolicy(event(), enabledPolicy({ ignoredPathPatterns: ["src/**"] })), undefined);
  assert.equal(applyVscodePolicy({
    ...event(),
    occurredAt: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
  }, enabledPolicy()), undefined);

  const filtered = applyVscodePolicy(event(), enabledPolicy({
    revision: 14,
    metadata: { relativeFilePaths: false, personalCloudEligibility: true },
  }));
  assert.ok(filtered);
  assert.equal(filtered.title, "VS Code file activity");
  assert.equal(filtered.attributes.path, undefined);
  assert.equal(filtered.attributes.languageId, "typescript");
  assert.equal(filtered.policyVersion, 14);
  assert.equal(filtered.syncEligibility, "cloud_eligible");
});

test("uses a validated cached policy offline and fails closed without one", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuum-vscode-policy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const cacheFile = path.join(directory, "policy.json");
  await writeFile(cacheFile, JSON.stringify(enabledPolicy({ revision: 21 })));
  const cached = new PrivacyPolicyCache(
    cacheFile,
    () => "http://127.0.0.1:43117",
    async () => undefined,
  );
  assert.equal((await cached.current()).revision, 21);

  const missing = new PrivacyPolicyCache(
    path.join(directory, "missing.json"),
    () => "http://127.0.0.1:43117",
    async () => undefined,
  );
  assert.equal((await missing.current()).sources.vscode, false);
});

test("refreshes and persists the authenticated daemon policy", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuum-vscode-policy-fetch-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const cacheFile = path.join(directory, "policy.json");
  const policy = enabledPolicy({ revision: 30 });
  const fetchImpl: typeof fetch = async () => new Response(
    JSON.stringify({ policy }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  const cache = new PrivacyPolicyCache(
    cacheFile,
    () => "http://127.0.0.1:43117",
    async () => "collector-token",
    fetchImpl,
  );
  assert.equal((await cache.current(true)).revision, 30);
  assert.equal(JSON.parse(await readFile(cacheFile, "utf8")).revision, 30);
});

test("EventTransport never puts a source-disabled event in its durable queue", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuum-vscode-disabled-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const policyFile = path.join(directory, "policy.json");
  await writeFile(policyFile, JSON.stringify(enabledPolicy({ sources: { vscode: false } })));
  const queue = new DurableEventQueue(path.join(directory, "events.json"));
  const policies = new PrivacyPolicyCache(
    policyFile,
    () => "http://127.0.0.1:43117",
    async () => undefined,
  );
  const transport = new EventTransport(
    queue,
    () => "http://127.0.0.1:43117",
    async () => undefined,
    policies,
  );
  await transport.submit(event());
  assert.deepEqual(await queue.peek(), []);
});
