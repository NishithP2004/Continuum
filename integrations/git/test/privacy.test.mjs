import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isCommitId,
  sanitizeChangedPath,
  sanitizeRef,
  sanitizeSubject,
} from "../privacy.mjs";
import {
  normalizeProjectId,
  normalizeProjectName,
  resolveProjectIdentity,
} from "../project-identity.mjs";

test("keeps safe repository-relative paths and drops secret paths", () => {
  assert.deepEqual(sanitizeChangedPath("src/engine.ts"), {
    keep: true,
    value: "src/engine.ts",
    reason: "repository-relative-path",
  });
  assert.equal(sanitizeChangedPath(".env.production").keep, false);
  assert.equal(sanitizeChangedPath("config/secrets/key.json").keep, false);
  assert.equal(sanitizeChangedPath("../outside").keep, false);
});

test("subjects and refs are sanitized without passing secret-shaped data", () => {
  assert.deepEqual(sanitizeSubject("Add context diff\n"), {
    keep: true,
    value: "Add context diff",
    reason: "sanitized-commit-subject",
  });
  assert.equal(sanitizeSubject("token=abcdefghijklmnop").keep, false);
  assert.equal(sanitizeRef("feature/context diff"), "feature/context-diff");
  assert.equal(sanitizeRef("feature/token=abcdefghijklmnop"), "detached");
});

test("accepts SHA-1 and SHA-256 object ids only", () => {
  assert.equal(isCommitId("a".repeat(40)), true);
  assert.equal(isCommitId("b".repeat(64)), true);
  assert.equal(isCommitId("../HEAD"), false);
});

test("project identity uses a local alias and accepts ordered UUID overrides", () => {
  assert.equal(normalizeProjectId("  Build Week / Demo  "), undefined);
  const environmentId = "48120b21-97f6-4d7b-9034-a29c96d570c1";
  const repositoryId = "6d61eefc-c194-4998-bb2e-98c979ed8821";
  assert.equal(
    resolveProjectIdentity("/tmp/continuum-repo", "", repositoryId).projectId,
    repositoryId,
  );
  assert.equal(
    resolveProjectIdentity("/tmp/continuum-repo", environmentId, repositoryId).projectId,
    environmentId,
  );
  assert.match(resolveProjectIdentity("/tmp/continuum-repo").localAlias, /^[0-9a-f]{64}$/);
  assert.equal(resolveProjectIdentity("/tmp/continuum-repo").projectId, undefined);
  assert.equal(normalizeProjectName(".env.production"), "private-project");
});

test("repository fingerprint is stable across clone paths", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuum-git-clones-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seed = path.join(directory, "seed", "context-engine");
  const cloneA = path.join(directory, "a", "context-engine");
  const cloneB = path.join(directory, "b", "context-engine");
  await mkdir(seed, { recursive: true });
  execFileSync("git", ["init", "-q", seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "continuum@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "Continuum Test"]);
  await writeFile(path.join(seed, "README.md"), "identity\n");
  execFileSync("git", ["-C", seed, "add", "README.md"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "Initial"]);
  await mkdir(path.dirname(cloneA), { recursive: true });
  await mkdir(path.dirname(cloneB), { recursive: true });
  execFileSync("git", ["clone", "-q", seed, cloneA]);
  execFileSync("git", ["clone", "-q", seed, cloneB]);
  const left = resolveProjectIdentity(cloneA);
  const right = resolveProjectIdentity(cloneB);
  assert.equal(left.repositoryFingerprint, right.repositoryFingerprint);
  assert.notEqual(left.localAlias, right.localAlias);
  assert.equal(left.normalizedName, "context-engine");
});
