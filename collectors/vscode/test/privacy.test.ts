import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectWorkspacePath, sanitizeLabel } from "../src/privacy";
import { validateLoopbackEndpoint } from "../src/transport";
import {
  normalizeProjectId,
  normalizeProjectName,
  resolveProjectIdentity,
} from "../src/project-identity";

test("keeps only workspace-relative non-sensitive paths", () => {
  const root = path.resolve("/tmp/continuum-project");
  assert.deepEqual(
    inspectWorkspacePath(root, path.join(root, "src", "engine.ts")),
    {
      keep: true,
      relativePath: "src/engine.ts",
      reason: "workspace-relative-path",
      classification: "personal",
    },
  );
  assert.equal(inspectWorkspacePath(root, path.join(root, ".env")).keep, false);
  assert.equal(
    inspectWorkspacePath(root, path.resolve(root, "..", "other.txt")).keep,
    false,
  );
  assert.equal(
    inspectWorkspacePath(root, path.join(root, "node_modules", "x.js")).keep,
    false,
  );
});

test("sanitizes labels and refuses remote transports", () => {
  assert.equal(sanitizeLabel("ok\n<script>"), "ok script");
  assert.equal(
    validateLoopbackEndpoint("http://127.0.0.1:43117/"),
    "http://127.0.0.1:43117",
  );
  assert.throws(() => validateLoopbackEndpoint("https://example.com"));
  assert.throws(() => validateLoopbackEndpoint("http://127.0.0.1:43118"));
});

test("uses a hashed local alias and accepts only a global UUID override", () => {
  const root = path.resolve("/tmp/continuum-project");
  assert.equal(normalizeProjectId("  Build Week / Demo  "), undefined);
  const globalId = "c183a5ea-d5e4-4f41-af60-e4de88c87672";
  assert.equal(normalizeProjectId(globalId.toUpperCase()), globalId);
  assert.equal(resolveProjectIdentity(root, globalId).projectId, globalId);
  assert.match(resolveProjectIdentity(root).localAlias, /^[0-9a-f]{64}$/);
  assert.equal(resolveProjectIdentity(root).projectId, undefined);
  assert.equal(normalizeProjectName("sk-proj-neverpersist123456789"), "private-project");
});

test("derives the same repository fingerprint for clones at different paths", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuum-vscode-clones-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seed = path.join(directory, "seed", "continuum-project");
  const cloneA = path.join(directory, "device-a", "continuum-project");
  const cloneB = path.join(directory, "device-b", "continuum-project");
  await mkdir(seed, { recursive: true });
  execFileSync("git", ["init", "-q", seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "continuum@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "Continuum Test"]);
  await writeFile(path.join(seed, "README.md"), "live identity\n");
  execFileSync("git", ["-C", seed, "add", "README.md"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "Initial identity"]);
  await mkdir(path.dirname(cloneA), { recursive: true });
  await mkdir(path.dirname(cloneB), { recursive: true });
  execFileSync("git", ["clone", "-q", seed, cloneA]);
  execFileSync("git", ["clone", "-q", seed, cloneB]);

  const left = resolveProjectIdentity(cloneA);
  const right = resolveProjectIdentity(cloneB);
  assert.equal(left.normalizedName, "continuum-project");
  assert.equal(right.normalizedName, left.normalizedName);
  assert.equal(right.repositoryFingerprint, left.repositoryFingerprint);
  assert.notEqual(right.localAlias, left.localAlias);
  assert.match(left.repositoryFingerprint ?? "", /^[0-9a-f]{64}$/);
});
