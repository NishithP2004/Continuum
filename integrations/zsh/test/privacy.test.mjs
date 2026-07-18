import assert from "node:assert/strict";
import test from "node:test";
import { classifyCommand, sanitizeCwd, sanitizeExitCode } from "../privacy.mjs";
import {
  canonicalProjectId,
  normalizeProjectId,
  resolveProjectId,
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

test("project identity has a canonical fallback and sanitized explicit override", () => {
  assert.match(canonicalProjectId("/tmp/continuum-repo"), /^[0-9a-f]{24}$/);
  assert.equal(resolveProjectId("/tmp/continuum-repo"), canonicalProjectId("/tmp/continuum-repo"));
  assert.equal(normalizeProjectId("  Build Week / Demo  "), "Build-Week-Demo");
  assert.equal(resolveProjectId("/tmp/continuum-repo", "Build Week / Demo"), "Build-Week-Demo");
});
