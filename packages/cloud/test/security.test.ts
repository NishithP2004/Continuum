import { describe, expect, it } from "vitest";
import { apiKeyId, generateApiKey, verifyApiKeyDigest } from "../src/auth/api-keys.js";
import { SyncOperationSchema } from "../src/contracts.js";
import {
  assertCloudEligibleOperation,
  assertOperationCompliesWithPrivacyPolicy,
  defaultCloudPrivacyPolicy
} from "../src/privacy.js";

const pepper = "continuum-test-pepper-that-is-longer-than-32-characters";

function event(payload: Record<string, unknown>) {
  const deviceId = "5fb3b1d0-f2ad-45ac-a5c2-a8ad4161d6a7";
  const id = "67df844d-dcff-4c20-af54-34a952727d3f";
  const occurredAt = "2026-07-20T10:00:00.000Z";
  const hlc = `1760000000000:0:${deviceId}`;
  return SyncOperationSchema.parse({
    version: "1",
    id: "9d86a8de-4604-4c45-b27b-8c2fc1126594",
    deviceId,
    sequence: 1,
    hlc,
    entityType: "event",
    entityId: id,
    tombstone: false,
    payload: {
      version: "2",
      id,
      deviceId,
      occurredAt,
      hlc,
      source: "vscode",
      eventType: "file.saved",
      projectId: "b78a3b30-0f9c-45ec-86ab-e0ca2c6fdddc",
      title: "Saved src/auth.ts",
      attributes: { relativePath: "src/auth.ts" },
      privacy: { classification: "personal", rules: ["adapter_allowlist_v1"] },
      relevance: { decision: "keep", reason: "trusted workspace save" },
      confidence: 0.98,
      policyVersion: 3,
      syncEligibility: "cloud_eligible",
      ...payload
    },
    occurredAt
  });
}

describe("API keys", () => {
  it("creates copy-once tokens and verifies only their digest", () => {
    const generated = generateApiKey(pepper);
    expect(generated.token).toMatch(/^ctm_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{32,64}$/);
    expect(apiKeyId(generated.token)).toBe(generated.id);
    expect(verifyApiKeyDigest(generated.token, generated.digest, pepper)).toBe(true);
    expect(verifyApiKeyDigest(`${generated.token}x`, generated.digest, pepper)).toBe(false);
    expect(generated.digest.toString("utf8")).not.toContain(generated.token);
  });
});

describe("cloud privacy boundary", () => {
  it("accepts only complete, strict project redirect payloads", () => {
    const redirectFrom = "11111111-1111-4111-8111-111111111111";
    const redirectTo = "22222222-2222-4222-8222-222222222222";
    const operation = SyncOperationSchema.parse({
      version: "1",
      id: "33333333-3333-4333-8333-333333333333",
      deviceId: "5fb3b1d0-f2ad-45ac-a5c2-a8ad4161d6a7",
      sequence: 1,
      hlc: "1760000000000:0:5fb3b1d0-f2ad-45ac-a5c2-a8ad4161d6a7",
      entityType: "project",
      entityId: redirectFrom,
      tombstone: false,
      payload: { id: redirectFrom, label: "Continuum", redirectFrom, redirectTo },
      occurredAt: "2026-07-20T10:00:00.000Z"
    });
    expect(() => assertCloudEligibleOperation(operation)).not.toThrow();
    expect(() => assertCloudEligibleOperation({
      ...operation,
      payload: { ...operation.payload as object, redirectTo: undefined }
    })).toThrow("both endpoints");
    expect(() => assertCloudEligibleOperation({
      ...operation,
      payload: { ...operation.payload as object, unexpected: "field" }
    })).toThrow();
  });

  it("accepts allowlisted sanitized metadata", () => {
    expect(() => assertCloudEligibleOperation(event({
      title: "Saved src/auth.ts",
      attributes: { relativePath: "src/auth.ts" }
    }), Date.parse("2026-07-20T10:01:00.000Z"))).not.toThrow();
  });

  it.each([
    [{ privacy: { classification: "confidential", rules: [] }, syncEligibility: "cloud_eligible", title: "private" }, "confidential"],
    [{ body: "document text" }, "prohibited field"],
    [{ title: "api_key=super-secret-value" }, "secret rule"],
    [{ attributes: { transcript: "npm test passed" } }, "prohibited field"],
    [{ attributes: { relativePath: "/Users/alice/private.ts" } }, "absolute path"],
    [{ attributes: { relativePath: 42 } }, "must be a string"]
  ])("rejects ineligible payload %#", (payload, reason) => {
    expect(() => assertCloudEligibleOperation(event(payload), Date.parse("2026-07-20T10:01:00.000Z"))).toThrow(reason);
  });

  it("rejects old events and non-cloud eligibility", () => {
    const operation = event({ syncEligibility: "local_only" });
    expect(() => assertCloudEligibleOperation(operation, Date.parse("2026-07-20T10:01:00.000Z"))).toThrow("not cloud eligible");
    expect(() => assertCloudEligibleOperation(event({}), Date.parse("2026-07-22T10:01:00.000Z")))
      .toThrow("expired");
  });

  it.each([
    ["https://docs.example.com/guide?token=hidden", "query"],
    ["https://alice:password@docs.example.com/guide", "userinfo"],
    ["https://docs.example.com/guide#private", "fragment"]
  ])("rejects URL %s metadata", (url, reason) => {
    expect(() => assertCloudEligibleOperation(event({
      source: "chrome",
      eventType: "tab.focused",
      title: "Developer documentation",
      attributes: { url, host: "docs.example.com", path: "/guide" }
    }), Date.parse("2026-07-20T10:01:00.000Z"))).toThrow(reason);
  });

  it("accepts payload-free event tombstones even after the raw-event expiry window", () => {
    const live = event({});
    const tombstone = SyncOperationSchema.parse({
      ...live,
      id: "85bf5d38-6940-44d1-a7b1-c865862c6a26",
      tombstone: true,
      payload: undefined
    });
    expect(() => assertCloudEligibleOperation(tombstone, Date.parse("2026-08-20T10:01:00.000Z"))).not.toThrow();
    expect(() => assertCloudEligibleOperation({ ...tombstone, payload: { hidden: "value" } }, Date.parse("2026-08-20T10:01:00.000Z")))
      .toThrow("must not contain payload");
  });

  it("re-evaluates stale-device events against the stricter current account policy", () => {
    const base = defaultCloudPrivacyPolicy(new Date("2026-07-20T10:00:00.000Z"));
    const strict = {
      ...base,
      revision: 9,
      metadata: {
        ...base.metadata,
        relativeFilePaths: false,
        personalCloudEligibility: true
      }
    };
    const stale = event({
      title: "Saved src/auth.ts",
      attributes: { relativePath: "src/auth.ts" },
      policyVersion: 3
    });
    expect(() => assertOperationCompliesWithPrivacyPolicy(stale, strict)).toThrow("relative path metadata");
    expect(() => assertOperationCompliesWithPrivacyPolicy(event({
      title: "VS Code file activity",
      attributes: {},
      policyVersion: 3
    }), strict)).not.toThrow();
  });

  it("requires host-free Chrome records when URL host metadata is disabled", () => {
    const base = defaultCloudPrivacyPolicy(new Date("2026-07-20T10:00:00.000Z"));
    const strict = {
      ...base,
      metadata: { ...base.metadata, urlHosts: false, urlPaths: true, personalCloudEligibility: true }
    };
    expect(() => assertOperationCompliesWithPrivacyPolicy(event({
      source: "chrome",
      eventType: "tab.activated",
      title: "Viewing docs.example.com",
      attributes: { host: "docs.example.com", path: "/guide" }
    }), strict)).toThrow("URL host metadata");
    expect(() => assertOperationCompliesWithPrivacyPolicy(event({
      source: "chrome",
      eventType: "tab.activated",
      title: "Browser activity",
      attributes: { path: "/guide" }
    }), strict)).not.toThrow();
  });
});
