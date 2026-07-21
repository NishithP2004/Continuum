import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { ApiProvider } from "../lib/api-context";
import { SessionProvider } from "../lib/auth";

const emptyState = {
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

function renderApp(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<SessionProvider><ApiProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></ApiProvider></SessionProvider>);
}

beforeEach(() => {
  vi.stubEnv("VITE_AUTH0_DOMAIN", "");
  vi.stubEnv("VITE_AUTH0_CLIENT_ID", "");
  vi.stubEnv("VITE_AUTH0_AUDIENCE", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("Continuum PWA", () => {
  it("exits the chat loading state when the authenticated state request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "missing bearer token" }), { status: 401 })));
    renderApp("/chat");

    expect(await screen.findByRole("heading", { name: "Couldn’t load conversations" }, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.queryByText("Loading conversations")).not.toBeInTheDocument();
  });

  it("shows a live empty state without fabricated metrics or checkpoints", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/projects/active")) return new Response(JSON.stringify({ lease: null, reason: "No authoritative activity" }), { status: 200 });
      return new Response(JSON.stringify(emptyState), { status: 200 });
    }));
    renderApp("/now");
    expect(await screen.findByRole("heading", { name: "Waiting for live project activity" })).toBeInTheDocument();
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /privacy/i })[0]).toHaveAttribute("href", "/privacy");
  });

  it("keeps the secret guard immutable while allowing collection switches", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/settings/privacy")) return new Response(JSON.stringify({ policy }), { status: 200 });
      if (url.includes("/v1/privacy/audit")) return new Response(JSON.stringify({ audit: [] }), { status: 200 });
      return new Response(JSON.stringify(emptyState), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/privacy");
    expect(await screen.findByText("Credential and secret detection — Always on")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /secret/i })).not.toBeInTheDocument();
    const titles = screen.getByRole("switch", { name: "Window titles collection" });
    expect(titles).toHaveAttribute("aria-checked", "false");
    await userEvent.click(titles);
    expect(titles).toHaveAttribute("aria-checked", "true");
    const personalCloud = screen.getByRole("switch", { name: "Personal metadata cloud eligibility" });
    await userEvent.click(personalCloud);
    expect(personalCloud).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("switch", { name: "Personal metadata local processing" }));
    expect(personalCloud).toHaveAttribute("aria-checked", "false");
    expect(personalCloud).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save policy" })).toBeEnabled();
  });

  it("exposes reconnect state and every route to keyboard and mobile navigation", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(emptyState), { status: 200 })));
    renderApp("/now");

    expect(await screen.findByLabelText("Connection status: Offline")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main-content");
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    const more = screen.getByRole("dialog", { name: "More" });
    expect(more).toBeInTheDocument();
    expect(within(more).getByRole("link", { name: "Timeline" })).toHaveAttribute("href", "/timeline");
    expect(within(more).getByRole("link", { name: "Devices" })).toHaveAttribute("href", "/devices");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "More" })).not.toBeInTheDocument();
  });

  it("cancels the exact client-generated chat run on the server", async () => {
    const sessionId = "4b2523e8-565f-4af1-968c-7fe2dd42f2e9";
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamedBody: Record<string, unknown> | undefined;
    let cancelledRunId: string | undefined;
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url).pathname;
      if (path === "/v1/state") return new Response(JSON.stringify({ ...emptyState, projectId: "project-live", activeProject: { id: "project-live", name: "Live project" } }), { status: 200 });
      if (path === `/v1/chat/sessions/${sessionId}/messages` && init?.method === "POST") {
        streamedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode(`event: run_started\ndata: ${JSON.stringify({ type: "run_started", runId: streamedBody?.runId, sessionId })}\n\n`));
          }
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      const cancelMatch = path.match(/\/v1\/chat\/runs\/([^/]+)\/cancel$/);
      if (cancelMatch && init?.method === "POST") {
        cancelledRunId = decodeURIComponent(cancelMatch[1]);
        streamController?.enqueue(encoder.encode(`event: cancelled\ndata: ${JSON.stringify({ type: "cancelled", runId: cancelledRunId })}\n\n`));
        streamController?.close();
        return new Response(JSON.stringify({ runId: cancelledRunId, cancelled: true }), { status: 200 });
      }
      if (path === "/v1/chat/sessions") return new Response(JSON.stringify({ sessions: [{ id: sessionId, projectId: "project-live", title: "Private investigation", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), classification: "confidential", syncEligibility: "local_only" }] }), { status: 200 });
      if (path === `/v1/chat/sessions/${sessionId}/messages`) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/chat");

    expect(await screen.findByText("Local only")).toBeInTheDocument();
    const composer = screen.getByLabelText("Message Continuum Agent");
    await userEvent.type(composer, "What changed?");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await userEvent.click(await screen.findByRole("button", { name: "Stop response" }));

    await waitFor(() => expect(cancelledRunId).toBeDefined());
    expect(streamedBody).toEqual({ text: "What changed?", runId: cancelledRunId });
    expect(cancelledRunId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await screen.findByText("Response stopped.")).toBeInTheDocument();
  });

  it("keeps conversation history selectable and starts a fresh session explicitly", async () => {
    const firstId = "4b2523e8-565f-4af1-968c-7fe2dd42f2e9";
    const secondId = "652e99a6-e1f3-4e69-8834-c6876d804850";
    const now = new Date().toISOString();
    const sessions = [{ id: firstId, projectId: "project-live", title: "Monday handoff", createdAt: now, updatedAt: now, classification: "personal", syncEligibility: "cloud_eligible" }];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/state") return new Response(JSON.stringify({ ...emptyState, projectId: "project-live", activeProject: { id: "project-live", name: "Live project" } }), { status: 200 });
      if (path === "/v1/chat/sessions" && init?.method === "POST") {
        const session = { id: secondId, projectId: "project-live", title: "New conversation", createdAt: now, updatedAt: now, classification: "personal", syncEligibility: "cloud_eligible" };
        sessions.unshift(session);
        return new Response(JSON.stringify({ session }), { status: 201 });
      }
      if (path === "/v1/chat/sessions") return new Response(JSON.stringify({ sessions }), { status: 200 });
      if (path.endsWith("/messages")) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/chat");

    const selector = await screen.findByRole("combobox", { name: "Conversation" });
    expect(selector).toHaveValue(firstId);
    await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(selector).toHaveValue(secondId));
    expect(screen.getByRole("option", { name: "New conversation", selected: true })).toBeInTheDocument();
  });

  it("fails closed when a remote chat has no personal-cloud consent", async () => {
    window.localStorage.setItem("continuum.apiUrl", "https://continuum.example");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/state") return new Response(JSON.stringify({ ...emptyState, projectId: "project-live", activeProject: { id: "project-live", name: "Live project" } }), { status: 200 });
      if (path === "/v1/chat/sessions") return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
      if (path === "/v1/settings/privacy") return new Response(JSON.stringify({ policy: { ...policy, metadata: { ...policy.metadata, personalCloudEligibility: false } } }), { status: 200 });
      if (path === "/v1/privacy/audit") return new Response(JSON.stringify({ audit: [] }), { status: 200 });
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/chat");

    expect(await screen.findByText("Chat sync needs your consent")).toBeInTheDocument();
    expect(screen.getByText("Sync disabled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New conversation" })).toBeDisabled();
    expect(screen.getByLabelText("Message Continuum Agent")).toBeDisabled();
    expect(screen.getByRole("link", { name: "Review privacy" })).toHaveAttribute("href", "/privacy");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("confirms only a proposed bounded action through the canonical route and renders a remote execution boundary", async () => {
    const sessionId = "4b2523e8-565f-4af1-968c-7fe2dd42f2e9";
    const actionId = "31b08370-391e-4396-a843-d49379367156";
    let sent = false;
    let confirmedPath: string | undefined;
    let confirmedBody: string | undefined;
    const assistant = {
      version: "1", id: "652e99a6-e1f3-4e69-8834-c6876d804850", sessionId, role: "assistant",
      text: "I can prepare that checkpoint after you confirm.", citations: [], unverifiedHypotheses: [],
      provider: "continuum", model: "remote-context-composer", createdAt: new Date().toISOString(), syncEligibility: "cloud_eligible",
      actions: [
        { version: "1", id: actionId, name: "create_checkpoint", arguments: { projectId: "project-live" }, mutating: true, status: "proposed" },
        { version: "1", id: crypto.randomUUID(), name: "run_shell", arguments: {}, mutating: true, status: "proposed" }
      ]
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/state") return new Response(JSON.stringify({ ...emptyState, projectId: "project-live", activeProject: { id: "project-live", name: "Live project" } }), { status: 200 });
      if (path === "/v1/chat/sessions") return new Response(JSON.stringify({ sessions: [{ id: sessionId, projectId: "project-live", title: "Live actions", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), classification: "personal", syncEligibility: "cloud_eligible" }] }), { status: 200 });
      if (path === `/v1/chat/sessions/${sessionId}/messages` && init?.method === "POST") {
        sent = true;
        const request = JSON.parse(String(init.body)) as { runId: string };
        const frames = [
          { type: "run_started", runId: request.runId, sessionId },
          { type: "delta", runId: request.runId, text: assistant.text },
          { type: "action_proposed", runId: request.runId, action: assistant.actions[0] },
          { type: "done", runId: request.runId, message: assistant }
        ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
        return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (path === `/v1/chat/sessions/${sessionId}/messages`) {
        return new Response(JSON.stringify({ messages: sent ? [{ ...assistant, actions: undefined }] : [] }), { status: 200 });
      }
      if (path === `/v1/chat/actions/${actionId}/confirm` && init?.method === "POST") {
        confirmedPath = path;
        confirmedBody = String(init.body);
        return new Response(JSON.stringify({
          error: "paired_mac_required",
          message: "Creating a checkpoint requires a connected macOS collector. No command was queued or executed.",
          action: {
            ...assistant.actions[0], status: "failed",
            result: { code: "paired_mac_required", message: "Creating a checkpoint requires a connected macOS collector. No command was queued or executed." }
          }
        }), { status: 409 });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/chat");

    await userEvent.type(await screen.findByLabelText("Message Continuum Agent"), "Create a checkpoint");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    const confirm = await screen.findByRole("button", { name: "Confirm" });
    expect(screen.getByText("create checkpoint")).toBeInTheDocument();
    expect(screen.queryByText("run shell")).not.toBeInTheDocument();
    await userEvent.click(confirm);
    await waitFor(() => expect(confirmedPath).toBe(`/v1/chat/actions/${actionId}/confirm`));
    expect(confirmedBody).toBe("{}");
    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("No command was queued or executed");
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
  });

  it("creates API keys with only scopes accepted by the cloud service", async () => {
    let submittedScopes: string[] | undefined;
    let submittedExpiry: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/state")) return new Response(JSON.stringify(emptyState), { status: 200 });
      if (url.endsWith("/v1/sync/devices")) return new Response(JSON.stringify({ devices: [], sync: { status: "available" } }), { status: 200 });
      if (url.endsWith("/v1/auth/api-keys") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name: string; scopes: string[] };
        submittedScopes = body.scopes;
        submittedExpiry = (body as { expiresAt?: string }).expiresAt;
        return new Response(JSON.stringify({ key: { id: "123456789012", name: body.name, prefix: "ctm_123456789012_", secret: "ctm_123456789012_secret", scopes: body.scopes, createdAt: new Date().toISOString() } }), { status: 201 });
      }
      if (url.endsWith("/v1/auth/api-keys")) return new Response(JSON.stringify({ keys: [] }), { status: 200 });
      if (url.endsWith("/v1/mcp/status")) return new Response(JSON.stringify({ status: "ready", url: "https://continuum.example/mcp" }), { status: 200 });
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/devices");

    await userEvent.click(await screen.findByRole("button", { name: "New key" }));
    expect(screen.getByRole("dialog", { name: "Create API key" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Create API key" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New key" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "Codex client");
    await userEvent.click(screen.getByRole("button", { name: "Create key" }));
    await waitFor(() => expect(submittedScopes).toEqual(["context:read"]));
    expect(submittedScopes).not.toContain("graph:read");
    expect(submittedScopes).not.toContain("mcp:connect");
    expect(new Date(submittedExpiry!).getTime()).toBeGreaterThan(Date.now() + 80 * 86_400_000);
  });
});
