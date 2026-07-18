import { describe, expect, it } from "vitest";
import { applyPrivacyGate, cloudEligible } from "../src/pipeline/privacy.js";
import { normalizeLoopbackHost } from "../src/runtime.js";
import { event } from "./helpers.js";

describe("privacy gate", () => {
  it("drops explicit and inferred secrets before persistence", () => {
    const explicit = applyPrivacyGate(event({ privacy: { classification: "secret", rules: [] } }));
    const inferred = applyPrivacyGate(event({ title: "CONTINUUM_DEMO_SECRET_SHOULD_NEVER_APPEAR" }));
    expect(explicit.accepted).toBe(false);
    expect(inferred.accepted).toBe(false);
    if (!inferred.accepted) expect(inferred.secret).toBe(true);
  });

  it("strips URL query data and unknown fields", () => {
    const outcome = applyPrivacyGate(event({
      source: "chrome",
      eventType: "chrome.page_context",
      title: "Documentation",
      attributes: { url: "https://docs.example.test/path?session=private#fragment", host: "docs.example.test", body: "must not persist" }
    }));
    expect(outcome.accepted).toBe(true);
    if (outcome.accepted) {
      expect(outcome.event.attributes.url).toBe("https://docs.example.test/path");
      expect(outcome.event.attributes).not.toHaveProperty("body");
    }
  });

  it("keeps confidential data local", () => {
    expect(cloudEligible(event({ privacy: { classification: "confidential", rules: [] } }))).toBe(false);
    expect(cloudEligible(event())).toBe(true);
  });

  it("scans the complete persisted envelope and ordinary .env paths", () => {
    const cases = [
      event({ projectId: "sk-abcdefghijklmnop" }),
      event({ sessionId: "sk-abcdefghijklmnop" }),
      event({ dedupeKey: "api_key=abcdefghijklmnop" }),
      event({ privacy: { classification: "public", rules: ["token=abcdefghijklmnop"] } }),
      event({ relevance: { decision: "keep", reason: "password=abcdefghijklmnop" } }),
      event({ source: "vscode", attributes: { path: "src/.env" } })
    ];
    for (const candidate of cases) {
      const outcome = applyPrivacyGate(candidate);
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) expect(outcome.secret).toBe(true);
    }
  });

  it("rejects non-UUID event identifiers and clamps future timestamps", () => {
    expect(applyPrivacyGate({ ...event(), id: "not-a-uuid" }).accepted).toBe(false);
    const future = applyPrivacyGate(event({ occurredAt: "2099-01-01T00:00:00.000Z" }));
    expect(future.accepted).toBe(true);
    if (future.accepted) {
      expect(Date.parse(future.event.occurredAt)).toBeLessThan(Date.now() + 60_000);
      expect(future.event.privacy.rules).toContain("daemon_future_timestamp_clamped");
    }
  });

  it("enforces loopback-only daemon binding", () => {
    expect(normalizeLoopbackHost("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeLoopbackHost("localhost")).toBe("localhost");
    expect(normalizeLoopbackHost("::1")).toBe("::1");
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "remote.example"]) {
      expect(() => normalizeLoopbackHost(host)).toThrow(/loopback/);
    }
  });
});
