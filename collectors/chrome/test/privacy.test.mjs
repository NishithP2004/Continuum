import assert from "node:assert/strict";
import test from "node:test";
import {
  hostAllowed,
  normalizeAllowlist,
  sanitizeActiveTabUrl,
  sanitizeProjectId,
} from "../privacy.mjs";

test("allowlist is exact unless an explicit wildcard is present", () => {
  assert.equal(hostAllowed("docs.example.com", ["docs.example.com"]), true);
  assert.equal(hostAllowed("evil-docs.example.com", ["docs.example.com"]), false);
  assert.equal(hostAllowed("docs.example.com", ["*.example.com"]), true);
  assert.deepEqual(
    normalizeAllowlist("https://Docs.Example.com/path\n*.openai.com"),
    ["docs.example.com", "*.openai.com"],
  );
});

test("URL sanitizer drops credentials, queries, fragments and sensitive IDs", () => {
  const result = sanitizeActiveTabUrl(
    "https://user:pass@docs.example.com/guides/0123456789abcdef0123456789abcdef?token=secret#private",
    ["docs.example.com"],
  );
  assert.equal(result.keep, true);
  assert.equal(result.url, "https://docs.example.com/guides/:redacted");
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes("user"));
  assert.ok(!JSON.stringify(result).includes("pass"));
});

test("non-allowlisted and browser-internal pages are ignored", () => {
  assert.equal(
    sanitizeActiveTabUrl("https://example.org/private", ["example.com"]).keep,
    false,
  );
  assert.equal(
    sanitizeActiveTabUrl("chrome://settings", ["settings"]).keep,
    false,
  );
});

test("requires an explicit Chrome project ID and preserves canonical IDs", () => {
  assert.equal(sanitizeProjectId(""), "");
  assert.equal(sanitizeProjectId("84c82a2c6768a59f746bf60c"), "84c82a2c6768a59f746bf60c");
  assert.equal(sanitizeProjectId("  Build Week / Demo  "), "Build-Week-Demo");
});
