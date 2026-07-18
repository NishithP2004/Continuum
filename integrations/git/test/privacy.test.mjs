import assert from "node:assert/strict";
import test from "node:test";
import {
  isCommitId,
  sanitizeChangedPath,
  sanitizeRef,
  sanitizeSubject,
} from "../privacy.mjs";
import {
  canonicalProjectId,
  normalizeProjectId,
  resolveProjectId,
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

test("project identity has a canonical fallback and ordered explicit overrides", () => {
  assert.match(canonicalProjectId("/tmp/continuum-repo"), /^[0-9a-f]{24}$/);
  assert.equal(resolveProjectId("/tmp/continuum-repo"), canonicalProjectId("/tmp/continuum-repo"));
  assert.equal(normalizeProjectId("  Build Week / Demo  "), "Build-Week-Demo");
  assert.equal(
    resolveProjectId("/tmp/continuum-repo", "", "repo config / demo"),
    "repo-config-demo",
  );
  assert.equal(
    resolveProjectId("/tmp/continuum-repo", "environment / demo", "repo config / demo"),
    "environment-demo",
  );
});
