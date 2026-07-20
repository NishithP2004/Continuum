import assert from "node:assert/strict";
import test from "node:test";
import {
  hostAllowed,
  normalizeAllowlist,
  sanitizeActiveTabUrl,
} from "../privacy.mjs";
import {
  applyChromePolicy,
  failClosedPrivacyPolicy,
  parsePrivacyPolicy,
} from "../policy.mjs";

function enabledPolicy(overrides = {}) {
  const policy = failClosedPrivacyPolicy();
  return {
    ...policy,
    revision: overrides.revision ?? 9,
    updatedAt: new Date().toISOString(),
    sources: { ...policy.sources, chrome: true, ...(overrides.sources ?? {}) },
    metadata: {
      ...policy.metadata,
      urlHosts: true,
      urlPaths: true,
      personalMetadata: true,
      ...(overrides.metadata ?? {}),
    },
    allowedDomains: overrides.allowedDomains ?? ["docs.example.com"],
    ignoredDomains: overrides.ignoredDomains ?? [],
  };
}

function event() {
  return {
    version: "2",
    id: "d6b51fb7-3c4d-409d-a4b4-f2fb47dc2ed0",
    deviceId: "device-chrome-policy",
    occurredAt: new Date().toISOString(),
    hlc: `${Date.now()}:0:device-chrome-policy`,
    source: "chrome",
    eventType: "tab.activated",
    projectId: "461063c2-a58b-47ca-a53e-65f7ef332f9d",
    title: "Viewing docs.example.com",
    attributes: {
      host: "docs.example.com",
      url: "https://docs.example.com/guides/start",
    },
    privacy: { classification: "personal", rules: ["domain-allowlist"] },
    relevance: { decision: "keep", reason: "allowed-domain" },
    confidence: 1,
    dedupeKey: "chrome-policy-test",
  };
}

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

test("Chrome policy removes disabled host metadata before durable queueing", () => {
  const policy = enabledPolicy({
    revision: 17,
    metadata: { urlHosts: false, urlPaths: true, personalCloudEligibility: true },
  });
  const filtered = applyChromePolicy(event(), policy);
  assert.ok(filtered);
  assert.equal(filtered.title, "Chrome foreground tab activity");
  assert.deepEqual(filtered.attributes, { path: "/guides/start" });
  assert.equal(filtered.policyVersion, 17);
  assert.equal(filtered.syncEligibility, "cloud_eligible");
  assert.equal(JSON.stringify(filtered).includes("docs.example.com"), false);

  // Reconciliation can retain a hostless item only under the exact policy
  // revision that already performed the allowlist check.
  assert.ok(applyChromePolicy(filtered, policy));
  assert.equal(applyChromePolicy(filtered, { ...policy, revision: 18 }), undefined);
});

test("Chrome source, personal metadata and domain rules fail closed", () => {
  assert.equal(applyChromePolicy(event(), enabledPolicy({ sources: { chrome: false } })), undefined);
  assert.equal(applyChromePolicy(event(), enabledPolicy({ metadata: { personalMetadata: false } })), undefined);
  assert.equal(applyChromePolicy(event(), enabledPolicy({ ignoredDomains: ["*.example.com"] })), undefined);
  assert.equal(applyChromePolicy(event(), enabledPolicy({ allowedDomains: [] })), undefined);
  assert.equal(applyChromePolicy({
    ...event(),
    occurredAt: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
  }, enabledPolicy()), undefined);
  assert.equal(parsePrivacyPolicy({ policy: failClosedPrivacyPolicy() })?.sources.chrome, false);
  assert.equal(parsePrivacyPolicy({ version: "1" }), undefined);
});
