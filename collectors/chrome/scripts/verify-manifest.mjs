import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.incognito, "not_allowed");
assert.ok(!manifest.permissions.includes("history"));
assert.ok(!manifest.content_scripts);
assert.ok(manifest.optional_permissions.includes("tabs"));
assert.ok(
  manifest.optional_host_permissions.includes("http://127.0.0.1:43117/*"),
);
console.log("Chrome manifest privacy invariants verified.");
