import type {
  ActiveProjectLease,
  ApiKeyRecord,
  ChatMessage,
  ChatRunEvent,
  ChatSession,
  CreatedApiKey,
  Device,
  EngineState,
  GraphQuery,
  GraphSnapshot,
  ModelSettings,
  ModelSettingsResponse,
  PrivacyAuditResponse,
  PrivacyPolicy,
  RemoteMcpStatus,
  SyncStatus,
  TimelineResponse
} from "./types";

function normalizeCitation(value: Record<string, unknown>) {
  const checkpointIds = Array.isArray(value.checkpointIds) ? value.checkpointIds.map(String) : [];
  return {
    id: String(value.id ?? crypto.randomUUID()),
    kind: String(value.kind ?? "entity"),
    label: String(value.label ?? value.id ?? "Evidence"),
    ...(checkpointIds.length ? { detail: checkpointIds.join(" · ") } : {})
  };
}

const contextActionNames = new Set(["search_context", "get_diff", "select_project", "create_checkpoint", "ack_baseline"]);

function normalizeAction(value: Record<string, unknown>): import("./types").ContextAction | undefined {
  const rawName = String(value.name ?? value.type ?? "");
  if (!contextActionNames.has(rawName)) return undefined;
  const name = rawName as import("./types").ContextAction["type"];
  const rawStatus = String(value.status ?? "proposed");
  const normalizedStatus = rawStatus === "rejected" ? "cancelled" : rawStatus;
  const actionStates = new Set(["proposed", "confirmed", "running", "completed", "failed", "cancelled"]);
  const state = (actionStates.has(normalizedStatus) ? normalizedStatus : "failed") as import("./types").ContextAction["state"];
  const result = value.result;
  const resultRecord = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
  return {
    id: String(value.id ?? crypto.randomUUID()),
    type: name,
    label: typeof value.label === "string" ? value.label : name.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()),
    state,
    requiresConfirmation: Boolean(value.mutating),
    input: value.arguments && typeof value.arguments === "object" ? value.arguments as Record<string, unknown> : undefined,
    ...(result !== undefined ? { result } : {}),
    ...(state === "failed" && typeof resultRecord?.message === "string" ? { error: resultRecord.message } : {})
  };
}

function normalizeMessage(value: Record<string, unknown>): ChatMessage {
  return {
    id: String(value.id),
    sessionId: String(value.sessionId),
    role: String(value.role) as ChatMessage["role"],
    content: String(value.text ?? value.content ?? ""),
    createdAt: String(value.createdAt),
    citations: Array.isArray(value.citations) ? value.citations.map((citation) => normalizeCitation(citation as Record<string, unknown>)) : [],
    hypotheses: Array.isArray(value.unverifiedHypotheses) ? value.unverifiedHypotheses.map(String) : Array.isArray(value.hypotheses) ? value.hypotheses.map(String) : [],
    actions: Array.isArray(value.actions)
      ? value.actions.map((action) => normalizeAction(action as Record<string, unknown>)).filter((action): action is import("./types").ContextAction => Boolean(action))
      : []
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function contextActionFromApiError(error: unknown): import("./types").ContextAction | undefined {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object" || Array.isArray(error.details)) return undefined;
  const action = (error.details as Record<string, unknown>).action;
  return action && typeof action === "object" && !Array.isArray(action)
    ? normalizeAction(action as Record<string, unknown>)
    : undefined;
}

type TokenProvider = () => Promise<string | undefined>;

export class ContinuumApi {
  constructor(readonly baseUrl: string, private readonly getToken: TokenProvider) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getToken();
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers
      }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
      throw new ApiError(body?.message || `Request failed with HTTP ${response.status}`, response.status, body?.error, body);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  state(): Promise<EngineState> {
    return this.request("/v1/state");
  }

  activeProject(): Promise<{ lease: ActiveProjectLease | null; reason?: string }> {
    return this.request("/v1/projects/active");
  }

  timeline(projectId?: string, cursor?: string): Promise<TimelineResponse> {
    const params = new URLSearchParams({ limit: "50" });
    if (projectId) params.set("projectId", projectId);
    if (cursor) params.set("cursor", cursor);
    return this.request(`/v1/checkpoints?${params}`);
  }

  graph(query: GraphQuery): Promise<GraphSnapshot> {
    return this.request<Record<string, unknown>>("/v1/graph/query", {
      method: "POST",
      body: JSON.stringify({
        projectId: query.projectId,
        query: query.query,
        kinds: query.nodeKinds,
        edgeKinds: query.relations,
        aroundNodeId: query.aroundNodeId,
        hops: query.hops,
        cursor: query.cursor,
        limit: query.limit
      })
    }).then((raw) => ({
      version: "1",
      generatedAt: String(raw.generatedAt),
      projectId: raw.projectId ? String(raw.projectId) : undefined,
      nodes: Array.isArray(raw.nodes) ? raw.nodes as GraphSnapshot["nodes"] : [],
      edges: Array.isArray(raw.edges) ? raw.edges.map((edge) => {
        const item = edge as Record<string, unknown>;
        return { id: String(item.id), source: String(item.source), target: String(item.target), relation: String(item.relation ?? item.kind), checkpointIds: Array.isArray(item.checkpointIds) ? item.checkpointIds.map(String) : [], directed: item.directed === undefined ? true : Boolean(item.directed) };
      }) : [],
      truncated: Boolean(raw.truncated),
      cursor: raw.cursor === null || raw.nextCursor === null ? null : raw.cursor ? String(raw.cursor) : raw.nextCursor ? String(raw.nextCursor) : undefined,
      projection: raw.projection as GraphSnapshot["projection"] ?? (raw.degraded ? { status: "degraded", message: "Graph projection is operating in degraded mode." } : undefined)
    }));
  }

  privacyPolicy(): Promise<{ policy: PrivacyPolicy }> {
    return this.request("/v1/settings/privacy");
  }

  updatePrivacyPolicy(policy: PrivacyPolicy): Promise<{ policy: PrivacyPolicy }> {
    return this.request("/v1/settings/privacy", { method: "PATCH", body: JSON.stringify(policy) });
  }

  privacyAudit(): Promise<PrivacyAuditResponse> {
    return this.request<{ audit?: Array<Record<string, unknown>> } & Record<string, unknown>>("/v1/privacy/audit").then((response) => ({
      audit: (response.audit ?? []).map((entry, index) => ({
        id: String(entry.id ?? `${entry.occurredAt}:${entry.source}:${entry.rule}:${index}`),
        occurredAt: String(entry.occurredAt),
        source: String(entry.source),
        rule: String(entry.rule),
        decision: entry.decision ? String(entry.decision) as import("./types").PrivacyAuditEntry["decision"] : entry.action === "drop" ? "rejected" : entry.action === "redact" ? "stripped" : "accepted",
        count: Number(entry.count ?? 1),
        ...(entry.label ? { label: String(entry.label) } : {})
      }))
    }));
  }

  chatSessions(projectId?: string): Promise<{ sessions: ChatSession[] }> {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    return this.request(`/v1/chat/sessions${params.size ? `?${params}` : ""}`);
  }

  createChatSession(projectId?: string): Promise<{ session: ChatSession }> {
    return this.request("/v1/chat/sessions", { method: "POST", body: JSON.stringify({ projectId }) });
  }

  chatMessages(sessionId: string): Promise<{ messages: ChatMessage[] }> {
    return this.request<{ messages: Array<Record<string, unknown>> }>(`/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages`).then(({ messages }) => ({ messages: messages.map(normalizeMessage) }));
  }

  async streamChat(
    sessionId: string,
    content: string,
    runId: string,
    signal: AbortSignal,
    onEvent: (event: ChatRunEvent) => void
  ): Promise<void> {
    const token = await this.getToken();
    const response = await fetch(`${this.baseUrl}/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      signal,
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ text: content, runId })
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
      throw new ApiError(body?.message || `Chat request failed with HTTP ${response.status}`, response.status, body?.error, body);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!data) continue;
        const parsed = JSON.parse(data) as Record<string, unknown>;
        const eventRunId = typeof parsed.runId === "string" ? parsed.runId : runId;
        if (parsed.type === "run_started") onEvent({ type: "start", runId: eventRunId, sessionId: String(parsed.sessionId ?? sessionId) });
        else if (parsed.type === "action_proposed" || parsed.type === "action_result") {
          const action = normalizeAction(parsed.action as Record<string, unknown>);
          if (action) onEvent({ type: "action", runId: eventRunId, action });
        }
        else if (parsed.type === "done") onEvent({ type: "complete", runId: eventRunId, message: normalizeMessage(parsed.message as Record<string, unknown>) });
        else if (parsed.type === "citation") onEvent({ type: "citation", runId: eventRunId, citation: normalizeCitation(parsed.citation as Record<string, unknown>) });
        else if (parsed.type === "cancelled") onEvent({ type: "cancelled", runId: eventRunId });
        else onEvent({ ...parsed, runId: eventRunId } as ChatRunEvent);
      }
    }
  }

  cancelChatRun(runId: string): Promise<{ runId: string; cancelled: boolean }> {
    return this.request(`/v1/chat/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
  }

  confirmAction(actionId: string): Promise<{ action: import("./types").ContextAction }> {
    return this.request<{ action: Record<string, unknown> }>(`/v1/chat/actions/${encodeURIComponent(actionId)}/confirm`, { method: "POST", body: "{}" })
      .then(({ action }) => {
        const normalized = normalizeAction(action);
        if (!normalized) throw new ApiError("The service returned an unsupported context action.", 502, "unsupported_context_action", action);
        return { action: normalized };
      });
  }

  rejectAction(actionId: string): Promise<{ action: import("./types").ContextAction }> {
    return this.request<{ action: Record<string, unknown> }>(`/v1/chat/actions/${encodeURIComponent(actionId)}/reject`, { method: "POST", body: "{}" })
      .then(({ action }) => {
        const normalized = normalizeAction(action);
        if (!normalized) throw new ApiError("The service returned an unsupported context action.", 502, "unsupported_context_action", action);
        return { action: normalized };
      });
  }

  devices(): Promise<{ devices: Device[]; sync: SyncStatus }> {
    return this.request("/v1/sync/devices");
  }

  revokeDevice(id: string): Promise<void> {
    return this.request(`/v1/sync/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  reconnectSync(): Promise<{ sync: SyncStatus }> {
    return this.request("/v1/sync/reconnect", { method: "POST", body: "{}" });
  }

  apiKeys(): Promise<{ keys: ApiKeyRecord[] }> {
    return this.request("/v1/auth/api-keys");
  }

  createApiKey(input: { name: string; scopes: string[]; expiresAt?: string }): Promise<{ key: CreatedApiKey }> {
    return this.request("/v1/auth/api-keys", { method: "POST", body: JSON.stringify(input) });
  }

  revokeApiKey(id: string): Promise<void> {
    return this.request(`/v1/auth/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  remoteMcp(): Promise<RemoteMcpStatus> {
    return this.request("/v1/mcp/status");
  }

  modelSettings(): Promise<ModelSettingsResponse> {
    return this.request("/v1/settings/models");
  }

  updateModelSettings(settings: Partial<ModelSettings>): Promise<{ settings: ModelSettings }> {
    return this.request("/v1/settings/models", { method: "PATCH", body: JSON.stringify(settings) });
  }
}
