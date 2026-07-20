import { normalizeAllowlist, sanitizeActiveTabUrl } from "./privacy.mjs";
import {
  applyChromePolicy,
  failClosedPrivacyPolicy,
  parsePrivacyPolicy,
} from "./policy.mjs";
import { retainQueuedEvents } from "./queue-policy.mjs";
import {
  clearRejectedCollectorCredential,
  collectorCredentialRejected,
} from "./pairing.mjs";

const ENDPOINT = "http://127.0.0.1:43117";
const QUEUE_KEY = "continuumSanitizedQueueV2";
const CONFIG_KEY = "continuumCollectorConfigV2";
const TOKEN_KEY = "continuumCollectorTokenV1";
const PAIRING_KEY = "continuumCollectorPairingV1";
const CLIENT_KEY = "continuumCollectorClientIdV1";
const POLICY_KEY = "continuumPrivacyPolicyV1";
let queueOperation = Promise.resolve();
let rePairOperation;

function withQueueLock(work) {
  const current = queueOperation.then(work, work);
  queueOperation = current.then(() => undefined, () => undefined);
  return current;
}

function randomChallenge() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function clientId() {
  const stored = await chrome.storage.local.get(CLIENT_KEY);
  if (typeof stored[CLIENT_KEY] === "string") return stored[CLIENT_KEY];
  const id = `chrome-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ [CLIENT_KEY]: id });
  return id;
}

async function readConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return { enabled: stored[CONFIG_KEY]?.enabled !== false };
}

async function readToken() {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  return typeof stored[TOKEN_KEY] === "string" ? stored[TOKEN_KEY].trim() : "";
}

async function authenticated(path, init = {}) {
  const token = await readToken();
  if (!token) throw new Error("not-paired");
  const response = await fetch(`${ENDPOINT}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(2_000),
  });
  if (collectorCredentialRejected(response.status)) await reenterPairing();
  return response;
}

function reenterPairing() {
  if (!rePairOperation) {
    const attempt = (async () => {
      await clearRejectedCollectorCredential(chrome.storage.local, {
        token: TOKEN_KEY,
        policy: POLICY_KEY,
        pairing: PAIRING_KEY,
      });
      await setBadge("…", "Continuum access revoked · approve pairing again");
      return requestPairing();
    })();
    rePairOperation = attempt.finally(() => {
      rePairOperation = undefined;
    });
  }
  return rePairOperation;
}

async function pairingStatus() {
  const stored = await chrome.storage.local.get(PAIRING_KEY);
  const pairing = stored[PAIRING_KEY];
  if (!pairing?.id || !pairing.challenge) return { status: (await readToken()) ? "paired" : "unpaired" };
  const response = await fetch(`${ENDPOINT}/v1/pairing/chrome/${encodeURIComponent(pairing.id)}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: pairing.challenge }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) return { status: "unavailable" };
  const result = await response.json();
  if (typeof result.token === "string") {
    await chrome.storage.local.set({ [TOKEN_KEY]: result.token });
    await chrome.storage.local.remove(PAIRING_KEY);
    await setBadge("", "Continuum connected");
  }
  return result;
}

async function requestPairing() {
  if (await readToken()) return { status: "paired" };
  const existing = await pairingStatus();
  if (["pending", "approved", "paired"].includes(existing.status)) return existing;
  const challenge = randomChallenge();
  const response = await fetch(`${ENDPOINT}/v1/pairing/chrome/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: await clientId(), challenge }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`pairing-request-${response.status}`);
  const body = await response.json();
  await chrome.storage.local.set({ [PAIRING_KEY]: { id: body.pairing.id, challenge, expiresAt: body.pairing.expiresAt } });
  await setBadge("…", "Approve Chrome in Continuum");
  return body.pairing;
}

function queuesMatch(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

async function readRetainedQueue(limit, retentionHours = 24) {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const original = Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
  const retained = retainQueuedEvents(original, Date.now(), retentionHours);
  if (!queuesMatch(original, retained)) await chrome.storage.local.set({ [QUEUE_KEY]: retained });
  return retained.slice(0, limit);
}

async function queueEvent(event, policy) {
  const sanitized = applyChromePolicy(event, policy);
  if (!sanitized) return false;
  await withQueueLock(async () => {
    const pending = await readRetainedQueue(Number.POSITIVE_INFINITY, policy.retentionHours);
    const deduped = pending.filter((entry) => entry?.dedupeKey !== sanitized.dedupeKey);
    deduped.push(sanitized);
    await chrome.storage.local.set({ [QUEUE_KEY]: retainQueuedEvents(deduped, Date.now(), policy.retentionHours) });
  });
  return true;
}

async function readCachedPolicy() {
  const stored = await chrome.storage.local.get(POLICY_KEY);
  return parsePrivacyPolicy(stored[POLICY_KEY]);
}

async function currentPrivacyPolicy() {
  try {
    const response = await authenticated("/v1/settings/privacy");
    const policy = response.ok ? parsePrivacyPolicy(await response.json()) : undefined;
    if (policy) {
      await chrome.storage.local.set({ [POLICY_KEY]: policy });
      return policy;
    }
  } catch {
    // Use only a previously authenticated and validated policy while offline.
  }
  return await readCachedPolicy() ?? failClosedPrivacyPolicy();
}

async function reconcileQueue(policy) {
  const pending = await readRetainedQueue(Number.POSITIVE_INFINITY, policy.retentionHours);
  const reconciled = pending
    .map((event) => applyChromePolicy(event, policy))
    .filter((event) => event !== undefined);
  await chrome.storage.local.set({ [QUEUE_KEY]: retainQueuedEvents(reconciled, Date.now(), policy.retentionHours) });
  return reconciled;
}

async function flushQueue(currentPolicy) {
  const policy = currentPolicy ?? await currentPrivacyPolicy();
  const pending = await withQueueLock(async () => (await reconcileQueue(policy)).slice(0, 100));
  if (pending.length === 0) return;
  const response = await authenticated("/v1/events/batch", { method: "POST", body: JSON.stringify({ events: pending }) });
  if (!response.ok) throw new Error(`Continuum rejected events (${response.status})`);
  const sent = new Set(pending.map((event) => event.id));
  await withQueueLock(async () => {
    const latest = await chrome.storage.local.get(QUEUE_KEY);
    const remainder = (Array.isArray(latest[QUEUE_KEY]) ? latest[QUEUE_KEY] : []).filter((event) => !sent.has(event?.id));
    await chrome.storage.local.set({ [QUEUE_KEY]: retainQueuedEvents(remainder, Date.now(), policy.retentionHours) });
  });
}

async function liveContext() {
  const [projectResponse, policyResponse] = await Promise.all([
    authenticated("/v1/projects/active"),
    authenticated("/v1/settings/privacy"),
  ]);
  if (!projectResponse.ok || !policyResponse.ok) throw new Error("context-unavailable");
  const [{ lease }, policyBody] = await Promise.all([projectResponse.json(), policyResponse.json()]);
  const policy = parsePrivacyPolicy(policyBody);
  if (!policy) throw new Error("invalid-privacy-policy");
  await chrome.storage.local.set({ [POLICY_KEY]: policy });
  return { lease, policy };
}

async function buildTabEvent(tab, lease, policy) {
  const allowlist = normalizeAllowlist(policy.allowedDomains ?? []);
  const sanitized = sanitizeActiveTabUrl(tab.url ?? "", allowlist);
  if (!sanitized.keep) return undefined;
  const occurredAt = new Date().toISOString();
  const dedupeKey = await sha256(`chrome\0${lease.projectId}\0${sanitized.url}\0${occurredAt.slice(0, 16)}`);
  return {
    version: "2",
    id: crypto.randomUUID(),
    deviceId: lease.deviceId,
    occurredAt,
    hlc: `${Date.now()}:0:${lease.deviceId}`,
    source: "chrome",
    eventType: "tab.activated",
    projectId: lease.projectId,
    title: `Viewing ${sanitized.host}`,
    attributes: { host: sanitized.host, ...(policy.metadata?.urlPaths ? { url: sanitized.url } : {}) },
    privacy: {
      classification: "personal",
      rules: ["foreground-tab-only", "domain-allowlist", "url-credentials-query-fragment-removed", "page-title-not-collected"],
    },
    relevance: { decision: "keep", reason: sanitized.reason },
    confidence: 1,
    dedupeKey,
  };
}

async function setBadge(text, title) {
  await chrome.action.setBadgeBackgroundColor({ color: text === "!" ? "#d97706" : "#2563eb" });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title });
}

async function collectForegroundTab() {
  const config = await readConfig();
  if (!config.enabled || !(await readToken())) return;
  const { lease, policy } = await liveContext();
  if (!lease) {
    await flushQueue(policy);
    await setBadge("!", "Open a project in VS Code or a Continuum-enabled terminal");
    return;
  }
  if (!policy.sources?.chrome || !Array.isArray(policy.allowedDomains) || policy.allowedDomains.length === 0) {
    await flushQueue(policy);
    await setBadge("!", "Enable Chrome and allowed domains in Continuum Privacy settings");
    return;
  }
  const window = await chrome.windows.getLastFocused();
  if (!window.focused || window.id === undefined) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
  if (!tab || tab.incognito || !tab.active) return;
  const event = await buildTabEvent(tab, lease, policy);
  if (!event) return;
  if (!(await queueEvent(event, policy))) {
    await flushQueue(policy);
    return;
  }
  await flushQueue(policy);
  await setBadge("", `Continuum · ${lease.projectName}`);
}

function bestEffort(work) {
  void work().catch((error) => {
    console.warn("Continuum collector deferred delivery:", error instanceof Error ? error.message : "unknown error");
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("continuum-retry", { periodInMinutes: 1 });
  bestEffort(requestPairing);
});
chrome.runtime.onStartup.addListener(() => bestEffort(async () => { await pairingStatus(); await flushQueue(); }));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "continuum-retry") bestEffort(async () => { await pairingStatus(); await flushQueue(); });
});
chrome.tabs.onActivated.addListener(() => bestEffort(collectForegroundTab));
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.status === "complete" || changeInfo.url)) bestEffort(collectForegroundTab);
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) bestEffort(collectForegroundTab);
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const respond = (promise) => { promise.then(sendResponse, (error) => sendResponse({ status: "error", message: error instanceof Error ? error.message : "unknown" })); };
  if (message?.type === "continuum.capture-now") respond(collectForegroundTab().then(() => ({ ok: true })));
  else if (message?.type === "continuum.flush") respond(flushQueue().then(() => ({ ok: true })));
  else if (message?.type === "continuum.pair") respond(requestPairing());
  else if (message?.type === "continuum.status") respond((async () => {
    const pairing = await pairingStatus();
    let lease = null;
    let policy = null;
    if (await readToken()) {
      try ({ lease, policy } = await liveContext()); catch { /* engine may be offline */ }
    }
    return { pairing, paired: Boolean(await readToken()), lease, policy, config: await readConfig() };
  })());
  else if (message?.type === "continuum.set-enabled") respond((async () => {
    await chrome.storage.local.set({ [CONFIG_KEY]: { enabled: message.enabled === true } });
    return { ok: true };
  })());
  else return false;
  return true;
});
