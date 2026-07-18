import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { inspectWorkspacePath, sanitizeLabel } from "../src/privacy";
import { validateLoopbackEndpoint } from "../src/transport";
import {
  canonicalProjectId,
  normalizeProjectId,
  resolveProjectId,
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
});

test("uses a canonical fallback and a consistent explicit project override", () => {
  const root = path.resolve("/tmp/continuum-project");
  assert.match(canonicalProjectId(root), /^[0-9a-f]{24}$/);
  assert.equal(resolveProjectId(root), canonicalProjectId(root));
  assert.equal(normalizeProjectId("  Build Week / Demo  "), "Build-Week-Demo");
  assert.equal(resolveProjectId(root, "Build Week / Demo"), "Build-Week-Demo");
});
