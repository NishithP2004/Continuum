import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  clearRejectedCollectorCredential,
  collectorCredentialRejected,
} from "../pairing.mjs";

test("collector resolves an expiring project lease and never accepts a manual project ID", async () => {
  const [worker, popup] = await Promise.all([
    readFile(new URL("../service-worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../popup.html", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /\/v1\/projects\/active/);
  assert.match(worker, /if \(!lease\)/);
  assert.doesNotMatch(worker, /config\.projectId/);
  assert.doesNotMatch(popup, /id="project"[^>]*input/);
  assert.doesNotMatch(popup, /bearer token/i);
});

test("collector uses approved pairing and V2 policy metadata", async () => {
  const [worker, policy] = await Promise.all([
    readFile(new URL("../service-worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../policy.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(worker, /\/v1\/pairing\/chrome\/request/);
  assert.match(worker, /version: "2"/);
  assert.match(worker, /applyChromePolicy\(event, policy\)/);
  assert.match(policy, /policyVersion: policy\.revision/);
  assert.match(worker, /url-credentials-query-fragment-removed/);
});

test("revoked collector credentials are cleared before a fresh pairing request", async () => {
  assert.equal(collectorCredentialRejected(401), true);
  assert.equal(collectorCredentialRejected(403), true);
  assert.equal(collectorCredentialRejected(500), false);
  let removed;
  await clearRejectedCollectorCredential({
    async remove(keys) { removed = keys; },
  }, {
    token: "token-key",
    policy: "policy-key",
    pairing: "pairing-key",
  });
  assert.deepEqual(removed, ["token-key", "policy-key", "pairing-key"]);

  const worker = await readFile(new URL("../service-worker.mjs", import.meta.url), "utf8");
  assert.match(worker, /collectorCredentialRejected\(response\.status\)/);
  assert.match(worker, /clearRejectedCollectorCredential\(chrome\.storage\.local/);
  assert.match(worker, /return requestPairing\(\)/);
});
