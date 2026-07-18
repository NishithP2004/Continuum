import {
  normalizeAllowlist,
  sanitizeActiveTabUrl,
  sanitizeProjectId,
} from "./privacy.mjs";
import { retainQueuedEvents } from "./queue-policy.mjs";

const ENDPOINT = "http://127.0.0.1:43117";
const QUEUE_KEY = "continuumSanitizedQueueV1";
const CONFIG_KEY = "continuumCollectorConfigV1";
const TOKEN_KEY = "continuumBearerToken";
let queueOperation = Promise.resolve();

function withQueueLock(work) {
  const current = queueOperation.then(work, work);
  queueOperation = current.then(() => undefined, () => undefined);
  return current;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  const config = stored[CONFIG_KEY] ?? {};
  return {
    enabled: config.enabled === true,
    allowlist: normalizeAllowlist(config.allowlist ?? []),
    projectId: sanitizeProjectId(config.projectId),
  };
}

async function readToken() {
  const stored = await chrome.storage.session.get(TOKEN_KEY);
  return typeof stored[TOKEN_KEY] === "string" ? stored[TOKEN_KEY].trim() : "";
}

async function permissionsGranted() {
  return chrome.permissions.contains({
    permissions: ["tabs"],
    origins: [`${ENDPOINT}/*`],
  });
}

function queuesMatch(left, right) {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

async function readRetainedQueue(limit) {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const original = Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
  const retained = retainQueuedEvents(original);
  if (!queuesMatch(original, retained)) {
    await chrome.storage.local.set({ [QUEUE_KEY]: retained });
  }
  return retained.slice(0, limit);
}

async function queueEvent(event) {
  await withQueueLock(async () => {
    const pending = await readRetainedQueue(Number.POSITIVE_INFINITY);
    const deduped = pending.filter((entry) => entry?.dedupeKey !== event.dedupeKey);
    deduped.push(event);
    await chrome.storage.local.set({
      [QUEUE_KEY]: retainQueuedEvents(deduped),
    });
  });
}

async function flushQueue() {
  const pending = await withQueueLock(() => readRetainedQueue(100));
  if (pending.length === 0) return;
  if (!(await permissionsGranted())) return;
  const token = await readToken();
  if (!token) return;

  const response = await fetch(`${ENDPOINT}/v1/events/batch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ events: pending }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`Continuum rejected events (${response.status})`);
  const sent = new Set(pending.map((event) => event.id));
  await withQueueLock(async () => {
    const latest = await chrome.storage.local.get(QUEUE_KEY);
    const remainder = (Array.isArray(latest[QUEUE_KEY]) ? latest[QUEUE_KEY] : [])
      .filter((event) => !sent.has(event?.id));
    await chrome.storage.local.set({
      [QUEUE_KEY]: retainQueuedEvents(remainder),
    });
  });
}

async function buildTabEvent(tab, config) {
  const sanitized = sanitizeActiveTabUrl(tab.url ?? "", config.allowlist);
  if (!sanitized.keep) return undefined;
  const occurredAt = new Date().toISOString();
  const dedupeKey = await sha256(
    `chrome\0${config.projectId}\0${sanitized.url}\0${occurredAt.slice(0, 16)}`,
  );
  return {
    version: "1",
    id: crypto.randomUUID(),
    occurredAt,
    source: "chrome",
    eventType: "tab.activated",
    projectId: config.projectId,
    title: `Viewing ${sanitized.host}`,
    attributes: {
      host: sanitized.host,
      url: sanitized.url,
    },
    privacy: {
      classification: "personal",
      rules: [
        "foreground-tab-only",
        "domain-allowlist",
        "url-credentials-query-fragment-removed",
        "page-title-not-collected",
      ],
    },
    relevance: {
      decision: "keep",
      reason: sanitized.reason,
    },
    confidence: 1,
    dedupeKey,
  };
}

async function collectForegroundTab() {
  const config = await readConfig();
  if (!config.enabled || !config.projectId || config.allowlist.length === 0) return;
  if (!(await permissionsGranted())) return;
  const window = await chrome.windows.getLastFocused();
  if (!window.focused || window.id === undefined) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
  if (!tab || tab.incognito || !tab.active) return;
  const event = await buildTabEvent(tab, config);
  if (!event) return;
  await queueEvent(event);
  await flushQueue();
}

function bestEffort(work) {
  void work().catch((error) => {
    // Diagnostics contain no event payload, URL, or token.
    console.warn("Continuum collector deferred delivery:", error instanceof Error ? error.message : "unknown error");
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("continuum-retry", { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => bestEffort(flushQueue));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "continuum-retry") bestEffort(flushQueue);
});
chrome.tabs.onActivated.addListener(() => bestEffort(collectForegroundTab));
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.status === "complete" || changeInfo.url)) {
    bestEffort(collectForegroundTab);
  }
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) bestEffort(collectForegroundTab);
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "continuum.capture-now") {
    bestEffort(collectForegroundTab);
    sendResponse({ ok: true });
  } else if (message?.type === "continuum.flush") {
    bestEffort(flushQueue);
    sendResponse({ ok: true });
  }
});
