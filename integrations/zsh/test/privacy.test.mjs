import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyCommand, sanitizeCwd, sanitizeExitCode } from "../privacy.mjs";
import {
  normalizeProjectId,
  normalizeProjectName,
  resolveProjectIdentity,
} from "../project-identity.mjs";

test("retains a safe command shape without arguments", () => {
  assert.deepEqual(classifyCommand("npm run test -- --watch"), {
    keep: true,
    reason: "known-safe-command-shape",
    shape: "npm run test",
    confidence: 0.95,
  });
  assert.equal(classifyCommand("git commit -m 'private subject'").shape, "git commit");
  assert.equal(classifyCommand("unknown-tool private-file.txt").shape, "unknown-tool");
});

test("rejects private, secret, multiline, heredoc, and assignment commands", () => {
  const rejected = [
    " npm test",
    "OPENAI_API_KEY=value npm test",
    "tool --token abcdefghijklmnop",
    "curl -H 'Authorization: Bearer abcdefghijklmnop' example.com",
    "echo one\necho two",
    "cat <<EOF",
  ];
  for (const command of rejected) {
    assert.equal(classifyCommand(command).keep, false, command);
  }
});

test("cwd and exit code sanitizers do not expose absolute or secret paths", () => {
  assert.equal(sanitizeCwd("/repo", "/repo/packages/engine"), "packages/engine");
  assert.equal(sanitizeCwd("/repo", "/repo/.env/private"), ":redacted");
  assert.equal(sanitizeCwd("/repo", "/other"), ":outside-repository");
  assert.equal(sanitizeExitCode("0"), 0);
  assert.equal(sanitizeExitCode("999"), 1);
});

test("project identity uses a local alias and accepts only UUID overrides", () => {
  assert.equal(normalizeProjectId("  Build Week / Demo  "), undefined);
  const globalId = "56aba348-80e4-403d-a8d2-09884064cff5";
  assert.equal(resolveProjectIdentity("/tmp/continuum-repo", globalId).projectId, globalId);
  assert.match(resolveProjectIdentity("/tmp/continuum-repo").localAlias, /^[0-9a-f]{64}$/);
  assert.equal(resolveProjectIdentity("/tmp/continuum-repo").projectId, undefined);
  assert.equal(normalizeProjectName("token=neverpersist123456"), "private-project");
});

test("clone locations share a root-commit and normalized-name fingerprint", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuum-zsh-clones-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const seed = path.join(directory, "seed", "shared-project");
  const cloneA = path.join(directory, "one", "shared-project");
  const cloneB = path.join(directory, "two", "shared-project");
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
  const one = resolveProjectIdentity(cloneA, "");
  const two = resolveProjectIdentity(cloneB, "");
  assert.equal(one.repositoryFingerprint, two.repositoryFingerprint);
  assert.notEqual(one.localAlias, two.localAlias);
  assert.equal(one.normalizedName, "shared-project");
});
