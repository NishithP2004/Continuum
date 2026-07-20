import { expect, test, type Page } from "@playwright/test";

const browserErrors = new WeakMap<Page, string[]>();

const state = {
  revision: 0, connected: true, capturePaused: false, projectId: null, activeProject: null, currentCheckpoint: null,
  recentActivity: [], pendingEvents: 0, eventCount: 0, checkpointCount: 0, collectorNames: [],
  provider: { provider: "apple", model: "apple-system-default", status: "unknown", cloudActive: false },
  retrieval: { mode: "FTS + graph", degraded: false, checkpointCount: 0, graphNodeCount: 0, graphEdgeCount: 0 }
};

const policy = {
  version: "1", revision: 1, updatedAt: new Date().toISOString(),
  sources: { osApps: true, osWindows: false, approvedFolders: true, vscode: true, terminal: true, git: true, chrome: true },
  metadata: { relativeFilePaths: true, urlHosts: true, urlPaths: true, commandNames: true, commandFlagNames: true, personalMetadata: true, confidentialLocalCollection: true, personalCloudEligibility: false },
  retentionHours: 24, allowedDomains: [], ignoredDomains: [], ignoredPathPatterns: [],
  immutableProtections: { secretDetection: true, attributeAllowlist: true, prohibitedContentExclusion: true, confidentialCloudBlock: true }
};

async function emptyLiveApi(page: Page) {
  let currentPolicy = structuredClone(policy);
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/state") return route.fulfill({ json: state });
    if (path === "/v1/projects/active") return route.fulfill({ json: { lease: null, reason: "No authoritative activity" } });
    if (path === "/v1/graph/query") return route.fulfill({ json: { version: "1", generatedAt: new Date().toISOString(), nodes: [], edges: [], truncated: false } });
    if (path === "/v1/settings/privacy") {
      if (route.request().method() === "PATCH") currentPolicy = route.request().postDataJSON();
      return route.fulfill({ json: { policy: currentPolicy } });
    }
    if (path === "/v1/privacy/audit") return route.fulfill({ json: { audit: [] } });
    if (path === "/v1/checkpoints") return route.fulfill({ json: { checkpoints: [], cursor: null } });
    if (path === "/v1/sync/devices") return route.fulfill({ json: { devices: [], sync: { status: "ready" } } });
    if (path === "/v1/sync/reconnect") return route.fulfill({ json: { sync: { status: "ready", lastSyncAt: new Date().toISOString() } } });
    if (path === "/v1/auth/api-keys") return route.fulfill({ json: { keys: [] } });
    if (path === "/v1/mcp/status") return route.fulfill({ json: { status: "ready", url: "https://continuum.example/mcp" } });
    if (path === "/v1/settings/models") return route.fulfill({ json: { settings: { activeCheckpointProvider: "apple", activeChatProvider: "apple", ollamaModel: "gemma3n:e2b", openaiModel: "gpt-5.6-terra" }, presets: ["gpt-5.6-terra"], ollamaModels: [], providerHealth: { apple: "unavailable", ollama: "unknown", openai: "unknown" } } });
    if (path === "/v1/chat/sessions") return route.fulfill({ json: { sessions: [] } });
    return route.fulfill({ status: 404, json: { error: "not_available" } });
  });
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await emptyLiveApi(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "browser console and page errors").toEqual([]);
});

test("renders an honest empty live state", async ({ page }) => {
  await page.goto("/now");
  await expect(page.getByRole("heading", { name: "Waiting for live project activity" })).toBeVisible();
  await expect(page.getByText(/demo/i)).toHaveCount(0);
});

test("reports browser disconnects even when the last engine response was healthy", async ({ page, context }) => {
  await page.goto("/now");
  await expect(page.getByLabel(/Connection status: Connected/)).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByLabel("Connection status: Offline")).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByLabel(/Connection status: Connected/)).toBeVisible();
});

test("graph has a responsive empty state and accessible navigation", async ({ page, isMobile }) => {
  await page.goto("/graph");
  await expect(page.getByRole("heading", { name: "Your live graph is empty" })).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(navigation.first()).toBeVisible();
  if (isMobile) await expect(page.getByRole("link", { name: "Graph" }).first()).toBeVisible();
});

test("privacy screen presents an immutable secret guard", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByText("Credential and secret detection — Always on")).toBeVisible();
  await expect(page.getByRole("switch", { name: /secret/i })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Window titles collection" })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("switch", { name: "Window titles collection" }).click();
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
});

test("exposes installable PWA metadata and keeps private APIs out of the offline cache", async ({ page, request }) => {
  await page.goto("/settings");
  await expect(page.getByText("Auth0 is not configured")).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/continuum-apple-touch.png");
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ sizes: "192x192", type: "image/png" }),
    expect.objectContaining({ sizes: "512x512", type: "image/png" }),
    expect.objectContaining({ purpose: "maskable" })
  ]));
  const worker = await (await request.get("/sw.js")).text();
  expect(worker).toContain('url.pathname.startsWith("/v1/")');
});

test("serves the installed application shell after the network goes offline", async ({ browser, isMobile }) => {
  test.skip(Boolean(isMobile), "One Chromium installability pass is sufficient");
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:43118", viewport: { width: 1280, height: 800 }, serviceWorkers: "allow" });
  const page = await context.newPage();
  await emptyLiveApi(page);
  await page.goto("/now");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  // Stop the online fixture from answering after the network is disabled so
  // the test proves private API responses were not persisted by the worker.
  await page.unroute("**/v1/**");
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("Now — Continuum");
  await expect(page.getByLabel("Connection status: Offline")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Continuum couldn’t load this view" })).toBeVisible();
  await context.close();
});

test("selects an evidence-backed graph node in responsive layouts", async ({ page, isMobile }) => {
  await page.unroute("**/v1/**");
  const nodes = [
    ["task-main", "task", "Remote MCP authentication"], ["project", "project", "Continuum"], ["blocker", "blocker", "No active-project lease"],
    ["decision", "decision", "Keep secrets blocked"], ["file", "file", "EngineClient.swift"], ["commit", "commit", "8f2c1e7"],
    ["checkpoint", "checkpoint", "Active-project lease design"], ["concept", "concept", "MCP"], ["url", "url", "Model Context Protocol"]
  ].map(([id, kind, label]) => ({ id, kind, label, checkpointIds: ["checkpoint-live"], status: kind === "blocker" ? "open" : undefined }));
  const edges = nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, source: "task-main", target: node.id, relation: index === 1 ? "blocked by" : "relates to", checkpointIds: ["checkpoint-live"], directed: true }));
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/state") return route.fulfill({ json: { ...state, projectId: "project-live", activeProject: { id: "project-live", name: "Continuum" } } });
    if (path === "/v1/graph/query") return route.fulfill({ json: { version: "1", generatedAt: new Date().toISOString(), projectId: "project-live", nodes, edges, truncated: false } });
    if (path === "/v1/chat/sessions") return route.fulfill({ json: { sessions: [] } });
    return route.fulfill({ status: 404, json: { error: "not_available" } });
  });
  await page.goto("/graph");
  await page.getByRole("button", { name: /task Remote MCP authentication/i }).click();
  await expect(page.getByRole("region", { name: "Remote MCP authentication details" })).toBeVisible();
  if (isMobile) await expect(page.getByText(/Showing 7 of 9 nodes/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("mobile More navigation reaches Timeline and Devices without a hidden route", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Mobile navigation behavior");
  await page.goto("/now");
  await page.getByRole("button", { name: "More" }).click();
  const dialog = page.getByRole("dialog", { name: "More" });
  await expect(dialog.getByRole("link", { name: "Timeline" })).toBeVisible();
  await dialog.getByRole("link", { name: "Timeline" }).click();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Devices" }).click();
  await expect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
});

test("administers a scoped, expiring API key without exposing it twice", async ({ page }) => {
  await page.unroute("**/v1/**");
  let submitted: { name: string; scopes: string[]; expiresAt?: string } | undefined;
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/state") return route.fulfill({ json: state });
    if (path === "/v1/sync/devices") return route.fulfill({ json: { devices: [], sync: { status: "ready" } } });
    if (path === "/v1/auth/api-keys" && route.request().method() === "POST") {
      submitted = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { key: { id: "123456789012", name: submitted!.name, prefix: "ctm_123456789012_", secret: "ctm_123456789012_copy_once", scopes: submitted!.scopes, createdAt: new Date().toISOString(), expiresAt: submitted!.expiresAt } } });
    }
    if (path === "/v1/auth/api-keys") return route.fulfill({ json: { keys: [] } });
    if (path === "/v1/mcp/status") return route.fulfill({ json: { status: "ready", url: "https://continuum.example/mcp" } });
    return route.fulfill({ status: 404, json: { error: "not_available" } });
  });
  await page.goto("/devices");
  await page.getByRole("button", { name: "New key" }).click();
  const dialog = page.getByRole("dialog", { name: "Create API key" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Codex remote MCP");
  await dialog.getByRole("checkbox", { name: /Read synchronized records/ }).check();
  await dialog.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("dialog", { name: "Copy this key now" })).toContainText("ctm_123456789012_copy_once");
  expect(submitted?.scopes).toEqual(["context:read", "sync:read"]);
  expect(new Date(submitted!.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  await page.getByRole("button", { name: "I’ve saved the key" }).click();
  await expect(page.getByText("ctm_123456789012_copy_once")).toHaveCount(0);
});

test("requires explicit privacy consent before remote personal chat", async ({ page }) => {
  let chatPosts = 0;
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/v1/chat/")) chatPosts += 1; });
  await page.addInitScript(() => localStorage.setItem("continuum.apiUrl", "https://continuum.example"));
  await page.route("**/v1/state", (route) => route.fulfill({ json: { ...state, projectId: "project-live", activeProject: { id: "project-live", name: "Continuum" } } }));
  await page.goto("/chat");
  await expect(page.getByText("Chat sync needs your consent")).toBeVisible();
  await expect(page.getByText("Sync disabled")).toBeVisible();
  await expect(page.getByRole("button", { name: "New conversation" })).toBeDisabled();
  await expect(page.getByLabel("Message Continuum Agent")).toBeDisabled();
  expect(chatPosts).toBe(0);
  await page.getByRole("link", { name: "Review privacy" }).click();
  await expect(page.getByRole("heading", { name: "Privacy controls" })).toBeVisible();
});

test("stop cancels the exact server chat run and labels confidential sessions", async ({ page }) => {
  await page.unroute("**/v1/**");
  const sessionId = "4b2523e8-565f-4af1-968c-7fe2dd42f2e9";
  let streamedBody: { text: string; runId: string } | undefined;
  let cancelledRunId: string | undefined;
  let releaseStream: (() => void) | undefined;
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/state") return route.fulfill({ json: { ...state, projectId: "project-live", activeProject: { id: "project-live", name: "Live project" } } });
    if (path === "/v1/chat/sessions" && route.request().method() === "GET") return route.fulfill({ json: { sessions: [{ id: sessionId, projectId: "project-live", title: "Private investigation", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), classification: "confidential", syncEligibility: "local_only" }] } });
    if (path === `/v1/chat/sessions/${sessionId}/messages` && route.request().method() === "GET") return route.fulfill({ json: { messages: [] } });
    if (path === `/v1/chat/sessions/${sessionId}/messages` && route.request().method() === "POST") {
      streamedBody = route.request().postDataJSON() as { text: string; runId: string };
      await new Promise<void>((resolve) => { releaseStream = resolve; });
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: cancelled\ndata: ${JSON.stringify({ type: "cancelled", runId: streamedBody.runId })}\n\n` });
    }
    const cancel = path.match(/^\/v1\/chat\/runs\/([^/]+)\/cancel$/);
    if (cancel && route.request().method() === "POST") {
      cancelledRunId = decodeURIComponent(cancel[1]);
      releaseStream?.();
      return route.fulfill({ json: { runId: cancelledRunId, cancelled: true } });
    }
    return route.fulfill({ status: 404, json: { error: "not_available" } });
  });

  await page.goto("/chat");
  await expect(page.getByText("Local only")).toBeVisible();
  await page.getByLabel("Message Continuum Agent").fill("What changed?");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: "Stop response" }).click();
  await expect(page.getByText("Response stopped.")).toBeVisible();
  expect(streamedBody).toEqual({ text: "What changed?", runId: cancelledRunId });
});

test("settings rejects remote cleartext HTTP before reconnecting", async ({ page }) => {
  await page.goto("/settings");
  const serviceUrl = page.getByRole("textbox", { name: "Service URL" });
  await serviceUrl.fill("http://continuum.example");
  await page.getByRole("button", { name: "Save and reconnect" }).click();
  await expect(page.locator("#service-url-error")).toContainText("Remote Continuum services require HTTPS");
  expect(await page.evaluate(() => localStorage.getItem("continuum.apiUrl"))).toBeNull();

  await serviceUrl.fill("http://127.0.0.1:43117");
  await page.getByRole("button", { name: "Save and reconnect" }).click();
  await expect(page.locator("#service-url-error")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("continuum.apiUrl"))).toBe("http://127.0.0.1:43117");
});
