import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  EventsBatchSchema,
  GraphQueryV1Schema,
  ModelSettingsSchema,
  SyncOperationV1Schema,
  type ChatCitationV1,
  type ContextActionV1,
  type EngineState
} from "@continuum/contracts";
import { BriefingProvider } from "../providers/briefing.js";
import { detectSecretRule } from "../pipeline/privacy.js";
import { nextPrivacyPolicy } from "../privacy-policy.js";
import type { Engine } from "./engine.js";

class PublicOperationError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) {
    super(message);
    this.name = "PublicOperationError";
  }
}

function bearer(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function pathOnly(url: string): string {
  return url.split("?", 1)[0] ?? url;
}

function chatCitations(pack: Awaited<ReturnType<Engine["contexts"]["pack"]>>): ChatCitationV1[] {
  const citations: ChatCitationV1[] = [];
  for (const ranked of pack.checkpoints.slice(-3)) citations.push({
    kind: "checkpoint",
    id: ranked.checkpoint.id,
    label: ranked.checkpoint.summary.slice(0, 256),
    checkpointIds: [ranked.checkpoint.id]
  });
  const checkpointIds = pack.provenance.checkpointIds.slice(-12);
  for (const entity of [...pack.files.slice(0, 2), ...pack.commits.slice(0, 2)]) citations.push({
    kind: entity.kind === "commit" ? "commit" : "file",
    id: entity.key,
    label: entity.label,
    checkpointIds
  });
  return citations.slice(0, 8);
}

function proposedAction(engine: Engine, sessionId: string, projectId: string, text: string): ContextActionV1 | undefined {
  if (/\b(?:create|make|take)\s+(?:a\s+)?checkpoint\b/i.test(text)) {
    return engine.database.createContextAction(sessionId, { name: "create_checkpoint", arguments: { projectId }, mutating: true });
  }
  if (/\b(?:acknowledge|mark).{0,32}(?:baseline|caught\s+up|checkpoint)\b|\bcaught\s+up\b/i.test(text)) {
    return engine.database.createContextAction(sessionId, { name: "ack_baseline", arguments: { projectId }, mutating: true });
  }
  if (/\b(?:select|switch)\s+(?:to\s+)?(?:this\s+)?project\b/i.test(text)) {
    return engine.database.createContextAction(sessionId, { name: "select_project", arguments: { projectId }, mutating: true });
  }
  return undefined;
}

async function executeReadAction(engine: Engine, sessionId: string, projectId: string, text: string, cloudEligibleOnly: boolean): Promise<ContextActionV1 | undefined> {
  const isDiff = /\b(?:context\s+diff|what\s+changed|changes?\s+since)\b/i.test(text);
  const isSearch = /\b(?:search|find|look\s+up).{0,24}\bcontext\b/i.test(text);
  if (!isDiff && !isSearch) return undefined;
  const action = engine.database.createContextAction(sessionId, {
    name: isDiff ? "get_diff" : "search_context",
    arguments: { projectId, ...(isSearch ? { query: text.slice(0, 1_000) } : {}) },
    mutating: false
  });
  engine.database.updateContextAction(action.id, "confirmed");
  try {
    const result = isDiff
      ? (cloudEligibleOnly ? engine.cloudContexts : engine.contexts).diff({ projectId })
      : await (cloudEligibleOnly ? engine.cloudContexts : engine.contexts).pack({ projectId, query: text, maxCharacters: 6_000, limit: 6 });
    return engine.database.updateContextAction(action.id, "completed", result);
  } catch (error) {
    return engine.database.updateContextAction(action.id, "failed", { message: error instanceof Error ? error.message : "Context action failed" });
  }
}

interface InspectorState {
  activeProject: { id: string; name: string } | null;
  currentCheckpoint: ReturnType<Engine["database"]["listCheckpoints"]>[number] | null;
  recentActivity: ReturnType<Engine["database"]["recentEvents"]>;
  privacy: ReturnType<typeof privacySummary>;
  pendingEvents: number;
  collectorNames: string[];
  provider: {
    provider: string;
    model: string;
    status: string;
    message?: string;
    cloudActive: boolean;
  };
  retrieval: {
    mode: string;
    degraded: boolean;
    message?: string;
    checkpointCount: number;
    graphNodeCount: number;
    graphEdgeCount: number;
  };
}

function privacySummary(engine: Engine) {
  const counts = engine.database.counts();
  return {
    accepted: counts.eventCount,
    droppedSecrets: counts.droppedSecretCount,
    keptLocal: engine.database.confidentialEventCount(),
    expired: engine.database.expiredEventCount(),
    rules: engine.database.privacyRuleCounts()
  };
}

async function state(engine: Engine): Promise<EngineState & InspectorState> {
  const settings = engine.database.getModelSettings();
  const counts = engine.database.counts();
  const health = await engine.providers.health(settings);
  const projectId = engine.database.activeProjectLease()?.projectId ?? engine.database.latestProjectId() ?? null;
  const selectedHealth = settings.activeCheckpointProvider === "openai"
    ? health.openai
    : settings.activeCheckpointProvider === "apple"
      ? health.apple
      : health.ollama;
  const vectorReady = engine.database.vectorAvailable && engine.embeddings.peekStatus().available;
  const graphCounts = engine.database.graphCounts();
  return {
    revision: engine.database.revision(),
    connected: true,
    capturePaused: engine.database.capturePaused(),
    projectId,
    ...counts,
    retrievalMode: engine.database.vectorAvailable && engine.embeddings.peekStatus().available ? "hybrid" : "fts_graph",
    settings,
    providerHealth: { apple: health.apple.status, ollama: health.ollama.status, openai: health.openai.status },
    activeProject: projectId ? { id: projectId, name: engine.database.projectLabel(projectId) } : null,
    currentCheckpoint: engine.database.listCheckpoints(projectId ?? undefined, 1)[0] ?? null,
    recentActivity: engine.database.recentEvents(projectId ?? undefined, 50),
    privacy: privacySummary(engine),
    pendingEvents: engine.database.pendingEventCount(projectId ?? undefined),
    collectorNames: engine.database.collectorNames(),
    provider: {
      provider: settings.activeCheckpointProvider,
      model: settings.activeCheckpointProvider === "openai"
        ? settings.openaiModel
        : settings.activeCheckpointProvider === "apple"
          ? settings.appleModel
          : settings.ollamaModel,
      status: selectedHealth.status === "available" ? "ready" : selectedHealth.status,
      ...(selectedHealth.detail ? { message: selectedHealth.detail } : {}),
      cloudActive: settings.activeCheckpointProvider === "openai" || settings.activeChatProvider === "openai"
    },
    retrieval: {
      mode: vectorReady ? "Hybrid" : "FTS + graph",
      degraded: !vectorReady,
      ...(!vectorReady ? { message: engine.embeddings.peekStatus().detail ?? "Vector search unavailable; using FTS plus graph retrieval." } : {}),
      checkpointCount: counts.checkpointCount,
      ...graphCounts
    }
  };
}

export async function buildApp(engine: Engine): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 3_500_000 });
  const chatRuns = new Map<string, { sessionId: string; controller: AbortController; phase: "running" | "committing" }>();
  app.addHook("onClose", async () => {
    for (const run of chatRuns.values()) run.controller.abort();
    chatRuns.clear();
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    reply.header("access-control-allow-origin", typeof origin === "string" && origin.startsWith("chrome-extension://") ? origin : "http://127.0.0.1");
    reply.header("access-control-allow-headers", "authorization,content-type");
    reply.header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
    if (request.method === "OPTIONS") return reply.status(204).send();
    const path = pathOnly(request.url);
    if (path === "/health" || path === "/v1/pairing/chrome/request" || /^\/v1\/pairing\/chrome\/[^/]+\/status$/.test(path)) return;
    const supplied = bearer(request.headers.authorization);
    const collectorRoute = path === "/v1/events/batch" || path === "/v1/projects/active" || (path === "/v1/settings/privacy" && request.method === "GET");
    if (supplied !== engine.config.token && !(collectorRoute && supplied && engine.database.verifyCollectorToken(supplied))) {
      return reply.status(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ status: "ok", protocolVersion: 1 }));
  app.get("/v1/state", async () => state(engine));
  app.patch("/v1/state", async (request) => {
    const body = request.body as { capturePaused?: unknown };
    if (typeof body?.capturePaused !== "boolean") throw new Error("capturePaused must be boolean");
    engine.database.setCapturePaused(body.capturePaused);
    return state(engine);
  });

  app.post("/v1/events/batch", async (request, reply) => {
    const batch = EventsBatchSchema.parse(request.body);
    const supplied = bearer(request.headers.authorization);
    if (supplied !== engine.config.token && batch.events.some((event) => event.source !== "chrome")) {
      throw new PublicOperationError("collector_scope_violation", "The paired Chrome credential can submit only Chrome events.", 403);
    }
    const result = await engine.pipeline.ingest(batch);
    return reply.status(202).send(result);
  });

  app.get("/v1/projects/active", async () => ({ lease: engine.database.activeProjectLease() ?? null }));
  app.get("/v1/projects/identity/conflicts", async (request) => {
    const query = request.query as { status?: string };
    const status = query.status === "all" || query.status === "confirmed" ? query.status : "pending";
    return { conflicts: engine.database.listProjectIdentityConflicts(status) };
  });
  app.post("/v1/projects/identity/conflicts/:id/confirm", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { targetProjectId?: string };
    if (!body.targetProjectId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.targetProjectId)) {
      throw new PublicOperationError("invalid_project_identity_target", "Select one of the candidate global projects.", 400);
    }
    const confirmation = engine.database.confirmProjectIdentityConflict(params.id, body.targetProjectId);
    if (confirmation.status === "not_found") {
      throw new PublicOperationError("project_identity_conflict_not_found", "The project identity conflict does not exist.", 404);
    }
    if (confirmation.status === "invalid_target") {
      throw new PublicOperationError("invalid_project_identity_target", "The selected project is not a candidate for this conflict.", 400);
    }
    if (confirmation.status === "stale_alias") {
      throw new PublicOperationError("stale_project_identity_conflict", "The local project alias changed before confirmation. Capture new activity and review the updated match.", 409);
    }
    return { conflict: confirmation.conflict };
  });

  app.post("/v1/windows/flush", async (request) => {
    const body = (request.body ?? {}) as { projectId?: string };
    const checkpoints = await engine.pipeline.flush(body.projectId);
    return { checkpoints };
  });

  app.get("/v1/checkpoints", async (request) => {
    const query = request.query as { projectId?: string; limit?: string };
    return { checkpoints: engine.database.listCheckpoints(query.projectId, Math.min(100, Number(query.limit ?? 50))) };
  });

  app.post("/v1/search", async (request) => {
    const body = request.body as { query?: string; projectId?: string; maxCharacters?: number };
    if (!body?.query?.trim()) throw new Error("query is required");
    return engine.contexts.pack({ projectId: body.projectId, query: body.query, maxCharacters: body.maxCharacters });
  });

  app.get("/v1/diff", async (request) => {
    const query = request.query as { projectId?: string; sinceCheckpointId?: string };
    return engine.contexts.diff(query);
  });

  app.post("/v1/diff/briefing", async (request) => {
    const settings = engine.database.getModelSettings();
    if (settings.activeCheckpointProvider !== "openai") {
      throw new PublicOperationError("cloud_provider_not_selected", "Select OpenAI as the active provider before generating a GPT briefing.");
    }
    if (!engine.config.openaiApiKey) throw new PublicOperationError("openai_not_configured", "OPENAI_API_KEY is not configured");
    const body = (request.body ?? {}) as { projectId?: string; sinceCheckpointId?: string };
    const diff = engine.contexts.diff(body);
    const baseline = diff.baselineCheckpointId ? engine.database.getCheckpoint(diff.baselineCheckpointId) : undefined;
    const checkpointIds = engine.database
      .listCheckpoints(diff.projectId, 100, baseline?.createdAt)
      .map((checkpoint) => checkpoint.id);
    if (!engine.database.checkpointsCloudEligible(checkpointIds)) {
      throw new PublicOperationError("local_only_evidence", "This Context Diff contains local-only evidence and cannot be sent to OpenAI");
    }
    const provider = new BriefingProvider(engine.config.openaiApiKey, settings.openaiModel);
    return { ...diff, briefing: await provider.generate(diff) };
  });

  app.post("/v1/projects/:id/ack", async (request) => {
    const params = request.params as { id: string };
    const body = request.body as { checkpointId?: string };
    const checkpointId = body?.checkpointId ?? engine.database.listCheckpoints(params.id, 1)[0]?.id;
    if (!checkpointId) throw new Error("No checkpoint is available to acknowledge");
    engine.database.acknowledge(params.id, checkpointId);
    return { projectId: params.id, baselineCheckpointId: checkpointId };
  });

  app.get("/v1/settings/models", async () => {
    const settings = engine.database.getModelSettings();
    const health = await engine.providers.health(settings);
    return {
      settings,
      presets: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      ollamaModels: health.ollama.models ?? [],
      providerHealth: { apple: health.apple.status, ollama: health.ollama.status, openai: health.openai.status }
    };
  });

  app.patch("/v1/settings/models", async (request) => {
    const settings = ModelSettingsSchema.parse({ ...engine.database.getModelSettings(), ...(request.body as object) });
    return { settings: engine.database.setModelSettings(settings) };
  });

  app.get("/v1/settings/privacy", async () => ({ policy: engine.database.getPrivacyPolicy() }));
  app.patch("/v1/settings/privacy", async (request) => {
    const policy = nextPrivacyPolicy(engine.database.getPrivacyPolicy(), request.body);
    return { policy: engine.database.setPrivacyPolicy(policy) };
  });
  app.get("/v1/privacy/audit", async (request) => {
    const query = request.query as { limit?: string };
    return { audit: engine.database.privacyAudit(Math.min(500, Math.max(1, Number(query.limit ?? 100)))) };
  });

  app.post("/v1/graph/query", async (request) => engine.database.graphSnapshot(GraphQueryV1Schema.parse(request.body ?? {})));

  app.post("/v1/chat/sessions", async (request) => {
    const body = (request.body ?? {}) as { projectId?: string; title?: string; syncEligibility?: string; classification?: string };
    const projectId = body.projectId ?? engine.database.activeProjectLease()?.projectId ?? engine.database.latestProjectId();
    if (!projectId) throw new PublicOperationError("no_active_project", "Capture project activity before starting a conversation.", 409);
    const classification = body.classification === "public" || body.classification === "confidential" ? body.classification : "personal";
    const policy = engine.database.getPrivacyPolicy();
    const cloudAllowed = classification === "public"
      || (classification === "personal" && policy.metadata.personalCloudEligibility);
    const syncEligibility = body.syncEligibility === "cloud_eligible" && cloudAllowed ? "cloud_eligible" : "local_only";
    return {
      session: engine.database.createChatSession(
        projectId,
        body.title?.trim().slice(0, 160) || "New conversation",
        syncEligibility,
        classification
      )
    };
  });
  app.get("/v1/chat/sessions", async (request) => {
    const query = request.query as { projectId?: string; limit?: string };
    return { sessions: engine.database.listChatSessions(query.projectId, Math.min(100, Number(query.limit ?? 50))) };
  });
  app.get("/v1/chat/sessions/:id/messages", async (request) => {
    const params = request.params as { id: string };
    return { messages: engine.database.chatMessages(params.id) };
  });
  app.post("/v1/chat/sessions/:id/messages", async (request, reply) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { text?: string; runId?: string };
    const text = body.text?.trim();
    if (!text || text.length > 12_000) throw new PublicOperationError("invalid_chat_message", "Chat text must contain 1 to 12,000 characters.", 400);
    if (body.runId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.runId)) {
      throw new PublicOperationError("invalid_chat_run_id", "The optional chat run ID must be a UUID.", 400);
    }
    const secret = detectSecretRule(text);
    if (secret) {
      engine.database.auditPrivacy("chat", `chat:${secret}`, "drop");
      throw new PublicOperationError("secret_rejected", "The message was rejected because it appears to contain a credential or secret.", 400);
    }
    const session = engine.database.listChatSessions(undefined, 500).find((candidate) => candidate.id === params.id);
    if (!session) throw new PublicOperationError("unknown_chat_session", "The chat session does not exist.", 404);
    const settings = engine.database.getModelSettings();
    if ((session.classification === "confidential" || session.syncEligibility === "local_only") && settings.activeChatProvider === "openai") {
      throw new PublicOperationError("local_chat_cloud_blocked", "This conversation is not eligible for the OpenAI provider. Change its privacy eligibility first.", 409);
    }
    const runId = body.runId ?? randomUUID();
    if (chatRuns.has(runId)) throw new PublicOperationError("chat_run_conflict", "That chat run ID is already active.", 409);
    const controller = new AbortController();
    chatRuns.set(runId, { sessionId: session.id, controller, phase: "running" });
    const wantsStream = request.headers.accept?.includes("text/event-stream") === true;
    const writeEvent = (event: string, payload: unknown): void => {
      if (wantsStream && !reply.raw.writableEnded) {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    };
    if (wantsStream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-continuum-chat-run-id": runId
      });
      writeEvent("run_started", { type: "run_started", runId, sessionId: session.id });
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) controller.abort();
      });
    }
    let userMessage: ReturnType<Engine["database"]["addChatMessage"]> | undefined;
    try {
      controller.signal.throwIfAborted();
      userMessage = engine.database.addChatMessage({
        version: "1", id: randomUUID(), sessionId: session.id, role: "user", text, citations: [], unverifiedHypotheses: [],
        provider: "continuum", model: "context-actions-v1", createdAt: new Date().toISOString(), syncEligibility: session.syncEligibility
      });
      const eligibleContext = session.syncEligibility === "cloud_eligible";
      const context = await (eligibleContext ? engine.cloudContexts : engine.contexts).pack({
        projectId: session.projectId,
        query: text,
        maxCharacters: 10_000
      });
      controller.signal.throwIfAborted();
      const readAction = await executeReadAction(engine, session.id, session.projectId, text, eligibleContext);
      controller.signal.throwIfAborted();

      let streamedText = "";
      let emittedCharacters = 0;
      let streamedSecret: string | undefined;
      const onDelta = (delta: string): void => {
        if (controller.signal.aborted || !delta) return;
        streamedText += delta;
        streamedSecret = detectSecretRule(streamedText);
        if (streamedSecret) {
          controller.abort();
          return;
        }
        if (!wantsStream) return;
        let boundary = -1;
        for (let index = streamedText.length - 1; index >= emittedCharacters; index -= 1) {
          if (/\s/.test(streamedText[index]!)) { boundary = index + 1; break; }
        }
        if (boundary > emittedCharacters) {
          writeEvent("delta", { type: "delta", text: streamedText.slice(emittedCharacters, boundary) });
          emittedCharacters = boundary;
        }
      };
      const result = await engine.chatProviders.provider(settings).chat({
        projectId: session.projectId,
        prompt: text,
        context,
        history: engine.database.chatMessages(session.id, 30).slice(0, -1)
      }, controller.signal, onDelta);
      if (streamedSecret) {
        engine.database.auditPrivacy("chat", `chat:${streamedSecret}`, "drop");
        throw new PublicOperationError("secret_rejected", "The provider response was rejected by Continuum's secret filter.", 502);
      }
      controller.signal.throwIfAborted();
      const assistantSecret = detectSecretRule(result.text);
      if (assistantSecret) {
        engine.database.auditPrivacy("chat", `chat:${assistantSecret}`, "drop");
        throw new PublicOperationError("secret_rejected", "The provider response was rejected by Continuum's secret filter.", 502);
      }
      if (wantsStream) {
        if (streamedText) {
          if (emittedCharacters < streamedText.length) {
            writeEvent("delta", { type: "delta", text: streamedText.slice(emittedCharacters) });
          }
        } else {
          for (const chunk of result.text.match(/.{1,96}(?:\s|$)/g) ?? [result.text]) {
            writeEvent("delta", { type: "delta", text: chunk });
          }
        }
      }
      controller.signal.throwIfAborted();
      const activeRun = chatRuns.get(runId);
      if (!activeRun || activeRun.phase !== "running") throw new DOMException("The operation was aborted", "AbortError");
      activeRun.phase = "committing";
      const assistantMessage = engine.database.addChatMessage({
        version: "1", id: randomUUID(), sessionId: session.id, role: "assistant", text: result.text,
        citations: chatCitations(context),
        unverifiedHypotheses: context.hypotheses.filter((item) => item.status === "active").map((item) => item.text).slice(0, 12),
        provider: result.provider, model: result.model, createdAt: new Date().toISOString(),
        syncEligibility: session.syncEligibility
      });
      const action = proposedAction(engine, session.id, session.projectId, text);
      if (wantsStream) {
        for (const citation of assistantMessage.citations) writeEvent("citation", { type: "citation", citation });
        if (readAction) writeEvent("action_result", { type: "action_result", action: readAction });
        if (action) writeEvent("action_proposed", { type: "action_proposed", action });
        writeEvent("done", { type: "done", message: assistantMessage });
        reply.raw.end();
        return reply;
      }
      return { runId, userMessage, message: assistantMessage, actions: [readAction, action].filter(Boolean) };
    } catch (error) {
      if (wantsStream) {
        if (controller.signal.aborted && !(error instanceof PublicOperationError)) {
          writeEvent("cancelled", { type: "cancelled", runId });
        } else {
          writeEvent("error", {
            type: "error",
            code: error instanceof PublicOperationError ? error.code : "provider_failed",
            message: error instanceof PublicOperationError
              ? error.message
              : "The selected provider could not complete the response."
          });
        }
        reply.raw.end();
        return reply;
      }
      throw error;
    } finally {
      chatRuns.delete(runId);
    }
  });

  app.post("/v1/chat/runs/:id/cancel", async (request) => {
    const params = request.params as { id: string };
    const run = chatRuns.get(params.id);
    if (!run) throw new PublicOperationError("chat_run_not_active", "The chat run is no longer active.", 404);
    if (run.phase === "committing") {
      throw new PublicOperationError("chat_cancel_refused", "The chat response is already being committed.", 409);
    }
    run.controller.abort();
    return { runId: params.id, cancelled: true };
  });

  app.post("/v1/chat/actions/:id/confirm", async (request) => {
    const params = request.params as { id: string };
    const action = engine.database.contextAction(params.id);
    if (!action || action.status !== "proposed") throw new PublicOperationError("action_not_pending", "The context action is missing or no longer pending.", 409);
    const projectId = typeof action.arguments.projectId === "string" ? action.arguments.projectId : undefined;
    if (!projectId) throw new PublicOperationError("invalid_action", "The action has no project.", 400);
    engine.database.updateContextAction(action.id, "confirmed");
    try {
      let result: unknown;
      if (action.name === "create_checkpoint") result = { checkpoints: await engine.pipeline.flush(projectId) };
      else if (action.name === "ack_baseline") {
        const checkpoint = engine.database.listCheckpoints(projectId, 1)[0];
        if (!checkpoint) throw new Error("No checkpoint is available to acknowledge");
        engine.database.acknowledge(projectId, checkpoint.id);
        result = { projectId, baselineCheckpointId: checkpoint.id };
      } else if (action.name === "select_project") {
        const now = new Date();
        const name = engine.database.listChatSessions(undefined, 500).find((session) => session.projectId === projectId)?.title ?? projectId;
        result = engine.database.setActiveProjectLease({
          version: "1", projectId, projectName: name, source: "manual", confidence: 1, deviceId: engine.database.deviceId(),
          issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString()
        });
      } else throw new Error("Only state-changing context actions require confirmation");
      return { action: engine.database.updateContextAction(action.id, "completed", result) };
    } catch (error) {
      engine.database.updateContextAction(action.id, "failed", { message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
  app.post("/v1/chat/actions/:id/reject", async (request) => {
    const params = request.params as { id: string };
    const action = engine.database.contextAction(params.id);
    if (!action || action.status !== "proposed") throw new PublicOperationError("action_not_pending", "The context action is missing or no longer pending.", 409);
    return { action: engine.database.updateContextAction(action.id, "rejected") };
  });

  app.post("/v1/pairing/chrome/request", async (request) => {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !origin.startsWith("chrome-extension://")) {
      throw new PublicOperationError("invalid_extension_origin", "Chrome pairing must originate from the Continuum extension.", 403);
    }
    const body = request.body as { clientId?: string; challenge?: string };
    if (!body?.clientId || !body.challenge) throw new PublicOperationError("invalid_pairing_request", "clientId and challenge are required.", 400);
    return { pairing: engine.database.requestCollectorPairing("chrome", body.clientId, body.challenge) };
  });
  app.get("/v1/pairing/chrome", async () => ({ pairings: engine.database.collectorPairings("chrome") }));
  app.post("/v1/pairing/chrome/:id/approve", async (request) => {
    const params = request.params as { id: string };
    engine.database.approveCollectorPairing(params.id);
    return { approved: true };
  });
  app.post("/v1/pairing/chrome/:id/status", async (request) => {
    const params = request.params as { id: string };
    const body = request.body as { challenge?: string };
    if (!body?.challenge) throw new PublicOperationError("invalid_pairing_status", "challenge is required.", 400);
    return engine.database.completeCollectorPairing(params.id, body.challenge);
  });
  app.delete("/v1/pairing/chrome/:id", async (request) => {
    const params = request.params as { id: string };
    engine.database.revokeCollectorPairing(params.id);
    return { revoked: true };
  });

  app.get("/v1/sync/status", async () => ({ deviceId: engine.database.deviceId(), ...engine.sync.status() }));
  app.get("/v1/settings/sync", async () => ({
    sync: { deviceId: engine.database.deviceId(), ...engine.sync.status() }
  }));
  app.patch("/v1/settings/sync", async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const allowed = new Set(["endpoint", "accessToken", "disconnect"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      throw new PublicOperationError("invalid_sync_settings", "The synchronization settings contain an unsupported field.", 400);
    }
    if (body.endpoint !== undefined && (typeof body.endpoint !== "string" || body.endpoint.length > 2_048)) {
      throw new PublicOperationError("invalid_sync_endpoint", "The synchronization endpoint is invalid.", 400);
    }
    if (body.accessToken !== undefined && typeof body.accessToken !== "string") {
      throw new PublicOperationError("invalid_sync_credential", "The synchronization credential is invalid.", 400);
    }
    if (body.disconnect !== undefined && typeof body.disconnect !== "boolean") {
      throw new PublicOperationError("invalid_sync_settings", "disconnect must be a boolean.", 400);
    }
    try {
      const status = engine.sync.configure({
        ...(typeof body.endpoint === "string" ? { endpoint: body.endpoint } : {}),
        ...(typeof body.accessToken === "string" ? { accessToken: body.accessToken } : {}),
        ...(body.disconnect === true ? { clearCredential: true } : {})
      });
      return { sync: { deviceId: engine.database.deviceId(), ...status } };
    } catch {
      throw new PublicOperationError("invalid_sync_settings", "The synchronization endpoint or credential is invalid.", 400);
    }
  });
  app.get("/v1/sync/devices", async () => engine.sync.devices());
  app.delete("/v1/sync/devices/:id", async (request, reply) => {
    const params = request.params as { id: string };
    await engine.sync.revokeDevice(params.id);
    return reply.status(204).send();
  });
  app.post("/v1/sync/push", async (request) => {
    const body = (request.body ?? {}) as { acknowledgedIds?: string[]; limit?: number };
    const acknowledged = body.acknowledgedIds ? engine.database.acknowledgeSyncOperations(body.acknowledgedIds) : 0;
    return { acknowledged, operations: engine.database.pendingSyncOperations(body.limit ?? 200) };
  });
  app.post("/v1/sync/pull", async (request) => {
    const body = (request.body ?? {}) as { operations?: unknown[] };
    const operations = (body.operations ?? []).map((operation) => SyncOperationV1Schema.parse(operation));
    return engine.database.applySyncOperations(operations);
  });
  app.post("/v1/sync/reconnect", async () => ({ reconnectRequested: true, ...(await engine.sync.reconnect()) }));

  app.get("/v1/privacy", async () => ({ ...privacySummary(engine), audit: engine.database.privacyAudit() }));
  app.get("/v1/resume", async (request) => {
    const query = request.query as { projectId?: string; maxCharacters?: string };
    return engine.contexts.pack({ projectId: query.projectId, maxCharacters: query.maxCharacters ? Number(query.maxCharacters) : undefined });
  });

  app.get("/v1/stream", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*"
    });
    let lastRevision = -1;
    const send = (): void => {
      const revision = engine.database.revision();
      if (revision === lastRevision) {
        reply.raw.write(": keep-alive\n\n");
        return;
      }
      lastRevision = revision;
      reply.raw.write(`event: revision\ndata: ${JSON.stringify({ revision })}\n\n`);
    };
    send();
    const interval = setInterval(send, 1000);
    request.raw.on("close", () => clearInterval(interval));
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof PublicOperationError) {
      void reply.status(error.statusCode).send({ error: error.code, message: error.message });
      return;
    }
    const name = error instanceof Error ? error.name : "Error";
    const status = name === "ZodError" ? 400 : 500;
    void reply.status(status).send({
      error: status === 400 ? "invalid_request" : "operation_failed",
      message: status === 400 ? "The request payload is invalid." : "The operation could not be completed."
    });
  });

  return app;
}
