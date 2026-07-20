import Fastify, { type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import type { Authenticator, Principal } from "./auth/authenticator.js";
import { AuthenticationError } from "./auth/authenticator.js";
import { generateApiKey } from "./auth/api-keys.js";
import { boundedGraphSnapshot, GraphQuerySchema, SyncPullQuerySchema, SyncPushSchema } from "./contracts.js";
import type { ContextDataSource } from "./context/data-source.js";
import type { PostgresStore } from "./db/postgres.js";
import { handleMcpRequest } from "./mcp/server.js";
import { assertSafeCloudText } from "./privacy.js";

export interface CloudApplicationOptions {
  store: PostgresStore;
  context: ContextDataSource;
  authenticator: Authenticator;
  apiKeyPepper: string;
  auth0Issuer: string;
  publicBaseUrl: string;
  logger?: boolean | Record<string, unknown>;
}

function bearer(request: FastifyRequest): string | undefined {
  return request.headers.authorization;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function metadata(options: CloudApplicationOptions) {
  const resource = new URL("/mcp", options.publicBaseUrl).toString();
  return {
    resource,
    authorization_servers: [options.auth0Issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["context:read", "sync:read", "sync:write", "devices:write", "keys:write"]
  };
}

const PrivacyPolicySchema = z.object({
  version: z.literal("1"),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }),
  sources: z.object({
    osApps: z.boolean(), osWindows: z.boolean(), approvedFolders: z.boolean(), vscode: z.boolean(),
    terminal: z.boolean(), git: z.boolean(), chrome: z.boolean()
  }).strict(),
  metadata: z.object({
    relativeFilePaths: z.boolean(), urlHosts: z.boolean(), urlPaths: z.boolean(), commandNames: z.boolean(),
    commandFlagNames: z.boolean(), personalMetadata: z.boolean(), confidentialLocalCollection: z.boolean(),
    personalCloudEligibility: z.boolean()
  }).strict(),
  retentionHours: z.number().int().min(1).max(24),
  allowedDomains: z.array(z.string().min(1).max(253)).max(256),
  ignoredDomains: z.array(z.string().min(1).max(253)).max(256),
  ignoredPathPatterns: z.array(z.string().min(1).max(256)).max(256),
  immutableProtections: z.object({
    secretDetection: z.literal(true),
    attributeAllowlist: z.literal(true),
    prohibitedContentExclusion: z.literal(true),
    confidentialCloudBlock: z.literal(true)
  }).strict()
}).strict();

function defaultPrivacyPolicy() {
  return PrivacyPolicySchema.parse({
    version: "1",
    revision: 1,
    updatedAt: new Date().toISOString(),
    sources: { osApps: true, osWindows: false, approvedFolders: true, vscode: true, terminal: true, git: true, chrome: true },
    metadata: {
      relativeFilePaths: true, urlHosts: true, urlPaths: true, commandNames: true, commandFlagNames: true,
      personalMetadata: true, confidentialLocalCollection: true, personalCloudEligibility: false
    },
    retentionHours: 24,
    allowedDomains: [],
    ignoredDomains: [],
    ignoredPathPatterns: ["**/.env*", "**/.git/objects/**", "**/node_modules/**", "**/.build/**", "**/DerivedData/**"],
    immutableProtections: {
      secretDetection: true, attributeAllowlist: true, prohibitedContentExclusion: true, confidentialCloudBlock: true
    }
  });
}

const ModelSettingsSchema = z.object({
  activeCheckpointProvider: z.enum(["apple", "ollama", "openai"]).default("ollama"),
  activeChatProvider: z.enum(["apple", "ollama", "openai"]).default("ollama"),
  appleModel: z.literal("apple-system-default").default("apple-system-default"),
  ollamaModel: z.string().min(1).max(128).default("gemma3n:e2b"),
  openaiModel: z.string().min(1).max(128).default("gpt-5.6-terra")
});

const ApiKeyInputSchema = z.object({
  name: z.string().min(1).max(128),
  scopes: z.array(z.enum(["context:read", "sync:read", "sync:write", "devices:write", "keys:write"])).min(1).max(8),
  expiresAt: z.string().datetime({ offset: true }).optional()
}).strict();

const ChatSessionPayloadSchema = z.object({
  version: z.literal("1"),
  id: z.string().uuid(),
  projectId: z.string().min(1).max(512),
  title: z.string().min(1).max(160),
  classification: z.enum(["public", "personal"]).default("personal"),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  syncEligibility: z.literal("cloud_eligible")
}).strict();

type ChatCitation = {
  kind: "checkpoint" | "file" | "commit" | "blocker" | "decision" | "entity";
  id: string;
  label: string;
  checkpointIds: string[];
};

const contextActionNames = ["search_context", "get_diff", "select_project", "create_checkpoint", "ack_baseline"] as const;
type ContextActionName = typeof contextActionNames[number];
type ContextActionStatus = "proposed" | "confirmed" | "completed" | "rejected" | "failed";
type CloudContextAction = {
  version: "1";
  id: string;
  sessionId: string;
  accountId: string;
  name: ContextActionName;
  arguments: Record<string, unknown>;
  mutating: boolean;
  status: ContextActionStatus;
  result?: unknown;
  messageId?: string;
  runId?: string;
};

type ChatRunState = {
  accountId: string;
  sessionId: string;
  phase: "running" | "cancelled" | "persisting" | "completed";
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function label(value: unknown, fallback: string): string {
  const candidate = stringValue(value).trim();
  return (candidate || fallback).slice(0, 256);
}

function groundedChatAnswer(context: Record<string, unknown>): {
  text: string;
  citations: ChatCitation[];
  hypotheses: string[];
} | null {
  const checkpoints = recordArray(context.checkpoints).map((item) => record(item.checkpoint) ?? item);
  const latest = checkpoints.at(-1);
  if (!latest) return null;
  const checkpointId = stringValue(latest.id);
  if (!checkpointId) return null;
  const sentences: string[] = [];
  const focus = stringValue(latest.focus) || stringValue(context.currentFocus);
  const summary = stringValue(latest.summary);
  const goal = stringValue(latest.goal) || stringValue(context.currentGoal);
  if (focus) sentences.push(`Current focus: ${focus}`);
  else if (goal) sentences.push(`Current goal: ${goal}`);
  if (summary && summary !== focus && summary !== goal) sentences.push(summary);

  const blockers = recordArray(latest.blockers).filter((item) => stringValue(item.status) !== "resolved");
  if (blockers.length > 0) sentences.push(`Open blocker: ${label(blockers[0]?.text, "See the cited checkpoint")}`);
  const questions = recordArray(latest.questions);
  if (questions.length > 0) sentences.push(`Open question: ${label(questions[0]?.text, "See the cited checkpoint")}`);
  const decisions = recordArray(latest.decisions);
  if (decisions.length > 0) sentences.push(`Latest decision: ${label(decisions.at(-1)?.text, "See the cited checkpoint")}`);
  if (sentences.length === 0) sentences.push(`The latest synchronized checkpoint is ${checkpointId}.`);

  const citations: ChatCitation[] = [{
    kind: "checkpoint",
    id: checkpointId,
    label: label(latest.summary ?? latest.focus ?? latest.goal, checkpointId),
    checkpointIds: [checkpointId]
  }];
  for (const entity of recordArray(latest.entities)) {
    if (citations.length >= 12) break;
    const entityKind = stringValue(entity.kind);
    const kind = entityKind === "file" || entityKind === "commit" ? entityKind : "entity";
    const id = stringValue(entity.key);
    if (!id) continue;
    citations.push({ kind, id, label: label(entity.label, id), checkpointIds: [checkpointId] });
  }
  for (const blocker of blockers.slice(0, 3)) citations.push({
    kind: "blocker",
    id: `${checkpointId}:blocker:${citations.length}`,
    label: label(blocker.text, "Open blocker"),
    checkpointIds: [checkpointId]
  });
  for (const decision of decisions.slice(-3)) citations.push({
    kind: "decision",
    id: `${checkpointId}:decision:${citations.length}`,
    label: label(decision.text, "Decision"),
    checkpointIds: [checkpointId]
  });
  const hypotheses = recordArray(latest.hypotheses).map((item) => stringValue(item.text)).filter(Boolean).slice(0, 12);
  if (hypotheses.length > 0) sentences.push("Any hypotheses shown with this answer remain unverified.");
  return { text: sentences.join("\n\n").slice(0, 12_000), citations: citations.slice(0, 24), hypotheses };
}

function proposedMutatingAction(accountId: string, sessionId: string, projectId: string, prompt: string): CloudContextAction | undefined {
  let name: ContextActionName | undefined;
  if (/\b(?:create|make|take)\s+(?:a\s+)?checkpoint\b/i.test(prompt)) name = "create_checkpoint";
  else if (/\b(?:acknowledge|mark).{0,32}(?:baseline|caught\s+up|checkpoint)\b|\bcaught\s+up\b/i.test(prompt)) name = "ack_baseline";
  else if (/\b(?:select|switch)\s+(?:to\s+)?(?:this\s+)?project\b/i.test(prompt)) name = "select_project";
  if (!name) return undefined;
  return {
    version: "1", id: randomUUID(), sessionId, accountId, name,
    arguments: { projectId }, mutating: true, status: "proposed"
  };
}

async function executeReadAction(
  context: ContextDataSource,
  accountId: string,
  sessionId: string,
  projectId: string,
  prompt: string
): Promise<CloudContextAction | undefined> {
  const isDiff = /\b(?:context\s+diff|what\s+changed|changes?\s+since)\b/i.test(prompt);
  const isSearch = /\b(?:search|find|look\s+up).{0,24}\bcontext\b/i.test(prompt);
  if (!isDiff && !isSearch) return undefined;
  const action: CloudContextAction = {
    version: "1", id: randomUUID(), sessionId, accountId,
    name: isDiff ? "get_diff" : "search_context",
    arguments: { projectId, ...(isSearch ? { query: prompt.slice(0, 1_000) } : {}) },
    mutating: false, status: "confirmed"
  };
  try {
    action.result = isDiff
      ? await context.diff(accountId, { projectId, maxChars: 6_000 })
      : await context.search(accountId, { projectId, query: prompt.slice(0, 1_000), limit: 6, maxChars: 6_000 });
    action.status = "completed";
  } catch (error) {
    action.status = "failed";
    action.result = { message: error instanceof Error ? error.message.slice(0, 512) : "Context action failed" };
  }
  return action;
}

function publicAction(action: CloudContextAction): Omit<CloudContextAction, "accountId" | "sessionId" | "messageId" | "runId"> {
  const { accountId: _accountId, sessionId: _sessionId, messageId: _messageId, runId: _runId, ...result } = action;
  return result;
}

function sseEvent(event: Record<string, unknown>): string {
  return `event: ${String(event.type ?? "message")}\ndata: ${JSON.stringify(event)}\n\n`;
}

function nextIoTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function camelRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()), item]));
}

export function createCloudApp(options: CloudApplicationOptions) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_048_576 });
  const chatRuns = new Map<string, ChatRunState>();
  const chatActions = new Map<string, CloudContextAction>();
  const rememberAction = (action: CloudContextAction): void => {
    if (!chatActions.has(action.id) && chatActions.size >= 1_000) {
      const oldest = chatActions.keys().next().value as string | undefined;
      if (oldest) chatActions.delete(oldest);
    }
    chatActions.set(action.id, action);
  };
  const principal = (request: FastifyRequest, scopes: string[] = []): Promise<Principal> =>
    options.authenticator.authenticate(bearer(request), scopes);
  const authorizeSyncDevice = async (actor: Principal, deviceId: string | undefined): Promise<void> => {
    if (!deviceId) {
      const error = new Error("deviceId is required when a device accesses sync") as Error & { statusCode: number };
      error.statusCode = 400;
      throw error;
    }
    if (actor.method === "api_key") {
      await options.store.authorizeApiKeyDevice(actor.accountId, actor.credentialId ?? actor.clientId, deviceId);
      return;
    }
    await options.store.authorizeOAuthDevice(actor.accountId, deviceId);
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthenticationError) {
      reply.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", options.publicBaseUrl)}"`
      );
      return reply.code(error.statusCode).send({ error: error.message });
    }
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", details: error.issues });
    const normalized = error instanceof Error ? error : new Error(String(error));
    const candidate = normalized as Error & { statusCode?: number };
    const statusCode = typeof candidate.statusCode === "number" ? candidate.statusCode : 500;
    requestSafeLog(app, normalized);
    const safeStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    return reply.code(safeStatus).send({ error: safeStatus >= 500 ? "internal_server_error" : normalized.message });
  });

  app.get("/health", async () => {
    await options.store.query("SELECT 1");
    return { status: "ok", service: "continuum-cloud" };
  });
  app.get("/.well-known/oauth-protected-resource", async () => metadata(options));
  app.get("/.well-known/oauth-protected-resource/mcp", async () => metadata(options));

  app.get("/v1/state", async (request) => {
    const actor = await principal(request, ["context:read"]);
    const [current, sync, counts, settings, checkpoints] = await Promise.all([
      options.context.current(actor.accountId, { maxChars: 8_000 }),
      options.store.status(actor.accountId),
      options.store.entityCounts(actor.accountId),
      options.store.entityPayload(actor.accountId, "settings", "models"),
      options.store.entityPayloads(actor.accountId, "checkpoint", 1)
    ]);
    const projectId = typeof current.projectId === "string" && current.projectId ? current.projectId : null;
    const resolvedSettings = ModelSettingsSchema.parse(settings ?? {});
    return {
      revision: Number(sync.cursor ?? 0),
      connected: true,
      capturePaused: false,
      projectId,
      activeProject: projectId ? { id: projectId, name: projectId } : null,
      activeProjectLease: null,
      currentCheckpoint: checkpoints[0] ?? null,
      recentActivity: [],
      pendingEvents: 0,
      eventCount: counts.event ?? 0,
      checkpointCount: counts.checkpoint ?? 0,
      collectorNames: [],
      provider: {
        provider: resolvedSettings.activeChatProvider,
        model: resolvedSettings.activeChatProvider === "apple" ? resolvedSettings.appleModel
          : resolvedSettings.activeChatProvider === "ollama" ? resolvedSettings.ollamaModel : resolvedSettings.openaiModel,
        status: "unknown",
        message: "Provider health is reported by the connected macOS device.",
        cloudActive: resolvedSettings.activeChatProvider === "openai"
      },
      retrieval: {
        mode: "remote_fts_graph",
        degraded: Boolean((sync.projection as Record<string, unknown> | undefined)?.degraded),
        checkpointCount: counts.checkpoint ?? 0,
        graphNodeCount: counts.graph_node ?? 0,
        graphEdgeCount: counts.graph_edge ?? 0
      },
      sync: { status: "available", ...(sync as Record<string, unknown>) }
    };
  });

  app.get("/v1/projects/active", async (request) => {
    const actor = await principal(request, ["context:read"]);
    const current = await options.context.current(actor.accountId, { maxChars: 2_000 });
    return {
      lease: null,
      reason: typeof current.projectId === "string" && current.projectId
        ? `Latest synchronized project is ${current.projectId}; remote reads never renew the authoritative device lease.`
        : "No synchronized live project is available."
    };
  });

  app.get("/v1/checkpoints", async (request) => {
    const actor = await principal(request, ["context:read"]);
    const query = z.object({
      projectId: z.string().optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(20)
    }).parse(request.query);
    const timeline = await options.context.timeline(actor.accountId, query);
    return { ...timeline, cursor: timeline.nextCursor ?? null };
  });

  app.get("/v1/settings/privacy", async (request) => {
    const actor = await principal(request, ["sync:read"]);
    return { policy: await options.store.entityPayload(actor.accountId, "privacy_policy", "current") ?? defaultPrivacyPolicy() };
  });
  app.patch("/v1/settings/privacy", async (request) => {
    const actor = await principal(request, ["sync:write"]);
    const input = z.record(z.string(), z.unknown()).parse(request.body);
    const current = PrivacyPolicySchema.parse(await options.store.entityPayload(actor.accountId, "privacy_policy", "current") ?? defaultPrivacyPolicy());
    const policy = PrivacyPolicySchema.parse({
      ...current,
      ...input,
      version: "1",
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      sources: { ...current.sources, ...(input.sources && typeof input.sources === "object" ? input.sources : {}) },
      metadata: { ...current.metadata, ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {}) },
      immutableProtections: {
        secretDetection: true, attributeAllowlist: true, prohibitedContentExclusion: true, confidentialCloudBlock: true
      }
    });
    await options.store.writeServerEntity(actor.accountId, "privacy_policy", "current", policy);
    return { policy };
  });
  app.get("/v1/privacy/audit", async (request) => {
    await principal(request, ["sync:read"]);
    return {
      audit: [],
      message: "Rejected payloads and local privacy audit details never synchronize; review aggregate counters on the source device."
    };
  });

  app.get("/v1/settings/models", async (request) => {
    const actor = await principal(request, ["sync:read"]);
    const settings = ModelSettingsSchema.parse(await options.store.entityPayload(actor.accountId, "settings", "models") ?? {});
    return {
      settings,
      presets: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      ollamaModels: [],
      providerHealth: { apple: "unknown", ollama: "unknown", openai: "unknown" }
    };
  });
  app.patch("/v1/settings/models", async (request) => {
    const actor = await principal(request, ["sync:write"]);
    const existing = ModelSettingsSchema.parse(await options.store.entityPayload(actor.accountId, "settings", "models") ?? {});
    const settings = ModelSettingsSchema.parse({ ...existing, ...z.record(z.string(), z.unknown()).parse(request.body) });
    await options.store.writeServerEntity(actor.accountId, "settings", "models", settings);
    return { settings };
  });

  app.get("/v1/chat/sessions", async (request) => {
    const actor = await principal(request, ["context:read"]);
    const query = z.object({ projectId: z.string().optional() }).parse(request.query);
    const sessions = await options.store.entityPayloads(actor.accountId, "chat_session", 200);
    return {
      sessions: sessions.filter((session) => !query.projectId || session.projectId === query.projectId)
    };
  });
  app.post("/v1/chat/sessions", async (request, reply) => {
    const actor = await principal(request, ["sync:write"]);
    const body = z.object({ projectId: z.string().optional() }).strict().parse(request.body ?? {});
    const current = body.projectId ? null : await options.context.current(actor.accountId, { maxChars: 2_000 });
    const projectId = body.projectId ?? (typeof current?.projectId === "string" ? current.projectId : "");
    if (!projectId) return reply.code(409).send({ error: "no_active_project", message: "Select a synchronized project before creating a chat." });
    const now = new Date().toISOString();
    const session = {
      version: "1",
      id: randomUUID(),
      projectId,
      title: "New conversation",
      classification: "personal",
      createdAt: now,
      updatedAt: now,
      syncEligibility: "cloud_eligible"
    };
    await options.store.writeServerEntity(actor.accountId, "chat_session", session.id, session);
    return reply.code(201).send({ session });
  });
  app.get("/v1/chat/sessions/:id/messages", async (request) => {
    const actor = await principal(request, ["context:read"]);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const messages = (await options.store.entityPayloads(actor.accountId, "chat_message", 500))
      .filter((message) => message.sessionId === id)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .map((message) => ({
        ...message,
        content: typeof message.text === "string" ? message.text : message.content,
        hypotheses: message.unverifiedHypotheses ?? message.hypotheses
      }));
    return { messages };
  });
  app.post("/v1/chat/sessions/:id/messages", async (request, reply) => {
    const actor = await principal(request, ["context:read", "sync:write"]);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { text, runId: suppliedRunId } = z.object({
      text: z.string().trim().min(1).max(12_000),
      runId: z.string().uuid().optional()
    }).strict().parse(request.body);
    const runId = suppliedRunId ?? randomUUID();
    if (chatRuns.has(runId)) return reply.code(409).send({ error: "chat_run_conflict" });
    try { assertSafeCloudText(text, "chat.message"); } catch {
      return reply.code(400).send({ error: "secret_rejected", message: "This message was rejected locally by Continuum's immutable privacy rules and was not persisted." });
    }
    const rawSession = await options.store.entityPayload(actor.accountId, "chat_session", id);
    if (!rawSession) return reply.code(404).send({ error: "chat_session_not_found" });
    const session = ChatSessionPayloadSchema.parse(rawSession);
    const run: ChatRunState = { accountId: actor.accountId, sessionId: id, phase: "running" };
    chatRuns.set(runId, run);

    const cancelled = (): boolean => run.phase === "cancelled";
    const stream = Readable.from((async function* (): AsyncGenerator<string> {
      const createdActionIds: string[] = [];
      try {
        yield sseEvent({ type: "run_started", runId, sessionId: id });
        await nextIoTurn();
        const context = await options.context.resume(actor.accountId, { projectId: session.projectId, maxChars: 12_000 });
        if (cancelled()) { yield sseEvent({ type: "cancelled", runId }); return; }
        const answer = groundedChatAnswer(context);
        if (!answer) {
          yield sseEvent({
            type: "error", runId, code: "synchronized_context_unavailable",
            message: "No synchronized evidence-backed checkpoint is available for this project. Create a live checkpoint on a connected macOS device, then try again."
          });
          return;
        }
        assertSafeCloudText(answer.text, "chat.assistant");
        const now = new Date().toISOString();
        const userMessage = {
          version: "1", id: randomUUID(), sessionId: id, role: "user", text,
          citations: [], unverifiedHypotheses: [], provider: "continuum", model: "remote-context-composer",
          createdAt: now, syncEligibility: "cloud_eligible"
        };
        const assistantMessage = {
          version: "1", id: randomUUID(), sessionId: id, role: "assistant", text: answer.text,
          citations: answer.citations, unverifiedHypotheses: answer.hypotheses,
          provider: "continuum", model: "remote-context-composer",
          createdAt: new Date().toISOString(), syncEligibility: "cloud_eligible"
        };

        const readAction = await executeReadAction(options.context, actor.accountId, id, session.projectId, text);
        const mutatingAction = proposedMutatingAction(actor.accountId, id, session.projectId, text);
        if (cancelled()) { yield sseEvent({ type: "cancelled", runId }); return; }
        await options.store.writeServerEntity(actor.accountId, "chat_message", userMessage.id, userMessage);
        if (cancelled()) { yield sseEvent({ type: "cancelled", runId }); return; }

        for (let offset = 0; offset < answer.text.length; offset += 160) {
          if (cancelled()) { yield sseEvent({ type: "cancelled", runId }); return; }
          yield sseEvent({ type: "delta", runId, text: answer.text.slice(offset, offset + 160) });
          await nextIoTurn();
        }
        for (const citation of answer.citations) {
          if (cancelled()) { yield sseEvent({ type: "cancelled", runId }); return; }
          yield sseEvent({ type: "citation", runId, citation });
          await nextIoTurn();
        }
        if (readAction) {
          readAction.messageId = assistantMessage.id;
          readAction.runId = runId;
          rememberAction(readAction);
          createdActionIds.push(readAction.id);
          yield sseEvent({ type: "action_result", runId, action: publicAction(readAction) });
          await nextIoTurn();
        }
        if (mutatingAction) {
          mutatingAction.messageId = assistantMessage.id;
          mutatingAction.runId = runId;
          rememberAction(mutatingAction);
          createdActionIds.push(mutatingAction.id);
          yield sseEvent({ type: "action_proposed", runId, action: publicAction(mutatingAction) });
          await nextIoTurn();
        }
        if (cancelled()) { yield sseEvent({ type: "cancelled", runId }); return; }

        // Once persistence begins, cancellation is no longer acknowledged as successful.
        // This makes the cancellation response and durable assistant state atomic from the
        // client's perspective: an accepted cancellation can never leave a completed reply.
        run.phase = "persisting";
        await options.store.writeServerEntity(actor.accountId, "chat_message", assistantMessage.id, assistantMessage);
        run.phase = "completed";
        yield sseEvent({ type: "done", runId, message: assistantMessage });
      } catch (error) {
        if (cancelled()) yield sseEvent({ type: "cancelled", runId });
        else {
          requestSafeLog(app, error instanceof Error ? error : new Error(String(error)));
          yield sseEvent({ type: "error", runId, code: "chat_run_failed", message: "The remote context agent could not complete this response." });
        }
      } finally {
        if (run.phase !== "completed") {
          for (const actionId of createdActionIds) chatActions.delete(actionId);
        }
        chatRuns.delete(runId);
      }
    })());
    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache, no-transform");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-accel-buffering", "no");
    return reply.send(stream);
  });
  app.post("/v1/chat/runs/:id/cancel", async (request, reply) => {
    const actor = await principal(request, ["context:read", "sync:write"]);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const run = chatRuns.get(id);
    if (!run || run.accountId !== actor.accountId) return reply.code(404).send({ error: "chat_run_not_active" });
    if (run.phase !== "running") {
      return reply.code(409).send({ error: "chat_run_completing", message: "The response is already being committed and can no longer be cancelled." });
    }
    run.phase = "cancelled";
    return { cancelled: true, runId: id };
  });
  app.post("/v1/chat/actions/:id/confirm", async (request, reply) => {
    const actor = await principal(request, ["context:read", "sync:write"]);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    const action = chatActions.get(id);
    if (!action || action.accountId !== actor.accountId) return reply.code(404).send({ error: "action_not_found" });
    const sourceRun = action.runId ? chatRuns.get(action.runId) : undefined;
    if (sourceRun && sourceRun.phase !== "completed") {
      return reply.code(409).send({ error: "action_run_active", message: "Wait for the cited response to finish before confirming its action.", action: publicAction(action) });
    }
    if (!action.mutating || action.status !== "proposed") {
      return reply.code(409).send({ error: "action_not_pending", action: publicAction(action) });
    }
    action.status = "confirmed";
    if (action.name === "ack_baseline") {
      const projectId = typeof action.arguments.projectId === "string" ? action.arguments.projectId : "";
      const current = await options.context.current(actor.accountId, { projectId, maxChars: 4_000 });
      const provenance = current.provenance && typeof current.provenance === "object" && !Array.isArray(current.provenance)
        ? current.provenance as Record<string, unknown>
        : {};
      const checkpointIds = Array.isArray(provenance.checkpointIds)
        ? provenance.checkpointIds.filter((item): item is string => typeof item === "string")
        : [];
      const checkpointId = checkpointIds.at(-1);
      if (!projectId || !checkpointId) {
        action.status = "failed";
        action.result = { code: "checkpoint_unavailable", message: "No synchronized checkpoint is available to acknowledge." };
        return reply.code(409).send({ error: "checkpoint_unavailable", action: publicAction(action) });
      }
      await options.store.writeServerEntity(actor.accountId, "baseline", projectId, { projectId, checkpointId });
      action.status = "completed";
      action.result = { projectId, baselineCheckpointId: checkpointId };
      rememberAction(action);
      return { action: publicAction(action) };
    }

    action.status = "failed";
    action.result = {
      code: "paired_mac_required",
      message: `${action.name === "create_checkpoint" ? "Creating a checkpoint" : "Changing the authoritative project"} requires a connected macOS collector. No command was queued or executed.`
    };
    rememberAction(action);
    return reply.code(409).send({ error: "paired_mac_required", message: (action.result as { message: string }).message, action: publicAction(action) });
  });
  app.post("/v1/chat/actions/:id/reject", async (request, reply) => {
    const actor = await principal(request, ["context:read", "sync:write"]);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    const action = chatActions.get(id);
    if (!action || action.accountId !== actor.accountId) return reply.code(404).send({ error: "action_not_found" });
    if (!action.mutating || action.status !== "proposed") return reply.code(409).send({ error: "action_not_pending", action: publicAction(action) });
    action.status = "rejected";
    rememberAction(action);
    return { action: publicAction(action) };
  });

  app.post("/v1/sync/push", async (request) => {
    const actor = await principal(request, ["sync:write"]);
    const input = SyncPushSchema.parse(request.body);
    await authorizeSyncDevice(actor, input.deviceId);
    return options.store.push(actor.accountId, input);
  });
  app.get("/v1/sync/pull", async (request) => {
    const actor = await principal(request, ["sync:read"]);
    const query = SyncPullQuerySchema.parse(request.query);
    await authorizeSyncDevice(actor, query.deviceId);
    return options.store.pull(actor.accountId, query.after, query.limit, query.deviceId);
  });
  app.post("/v1/sync/pull", async (request) => {
    const actor = await principal(request, ["sync:read"]);
    const body = z.object({
      deviceId: z.string().min(8).max(128),
      cursor: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(200)
    }).strict().parse(request.body);
    await authorizeSyncDevice(actor, body.deviceId);
    const page = await options.store.pull(actor.accountId, body.cursor, body.limit, body.deviceId);
    return { operations: page.operations, nextCursor: page.cursor, hasMore: page.hasMore };
  });
  app.get("/v1/sync/status", async (request) => {
    const actor = await principal(request, ["sync:read"]);
    return options.store.status(actor.accountId);
  });
  app.post("/v1/sync/reconnect", async (request) => {
    const actor = await principal(request, ["sync:read"]);
    const body = z.object({
      deviceId: z.string().min(8).max(128).optional(), cursor: z.number().int().nonnegative().default(0)
    }).parse(request.body ?? {});
    if (body.deviceId) await authorizeSyncDevice(actor, body.deviceId);
    const status = await options.store.status(actor.accountId);
    const delta = body.deviceId ? await options.store.pull(actor.accountId, body.cursor, 1, body.deviceId) : null;
    return {
      status,
      sync: { status: "available", ...(status as Record<string, unknown>) },
      cursor: delta?.cursor ?? Number(status.cursor ?? 0),
      changesAvailable: delta ? delta.operations.length > 0 || delta.hasMore : false
    };
  });

  app.get("/v1/devices", async (request) => {
    const actor = await principal(request, ["sync:read"]);
    return { devices: await options.store.listDevices(actor.accountId) };
  });
  app.get("/v1/sync/devices", async (request) => {
    const actor = await principal(request, ["sync:read"]);
    const [devices, status] = await Promise.all([options.store.listDevices(actor.accountId), options.store.status(actor.accountId)]);
    return {
      devices: devices.map((device) => {
        const normalized = camelRecord(device);
        const capabilities = Array.isArray(normalized.capabilities)
          ? normalized.capabilities.filter((value): value is string => typeof value === "string")
          : [];
        return {
          ...normalized,
          lastSyncAt: normalized.lastSeenAt,
          collectors: capabilities.map((name) => ({ name, status: "available" }))
        };
      }),
      sync: { status: "available", ...(status as Record<string, unknown>) }
    };
  });
  app.delete("/v1/devices/:id", async (request, reply) => {
    const actor = await principal(request, ["devices:write"]);
    const { id } = z.object({ id: z.string().min(8).max(128) }).parse(request.params);
    const revoked = await options.store.revokeDevice(actor.accountId, id);
    return revoked ? { revoked: true } : reply.code(404).send({ error: "device_not_found" });
  });
  app.delete("/v1/sync/devices/:id", async (request, reply) => {
    const actor = await principal(request, ["devices:write"]);
    const { id } = z.object({ id: z.string().min(8).max(128) }).parse(request.params);
    return await options.store.revokeDevice(actor.accountId, id)
      ? reply.code(204).send()
      : reply.code(404).send({ error: "device_not_found" });
  });

  app.post("/v1/api-keys", async (request, reply) => {
    const actor = await principal(request, ["keys:write"]);
    const input = ApiKeyInputSchema.parse(request.body);
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) throw httpError(400, "API key expiry must be in the future");
    const generated = generateApiKey(options.apiKeyPepper);
    await options.store.insertApiKey({ accountId: actor.accountId, ...input, id: generated.id, digest: generated.digest });
    return reply.code(201).send({ id: generated.id, token: generated.token, ...input, copyOnce: true });
  });
  app.get("/v1/api-keys", async (request) => {
    const actor = await principal(request, ["keys:write"]);
    return { keys: await options.store.listApiKeys(actor.accountId) };
  });
  app.get("/v1/auth/api-keys", async (request) => {
    const actor = await principal(request, ["keys:write"]);
    const keys = await options.store.listApiKeys(actor.accountId);
    return { keys: keys.map((key) => ({ ...camelRecord(key), prefix: `ctm_${String(key.id)}_` })) };
  });
  app.post("/v1/auth/api-keys", async (request, reply) => {
    const actor = await principal(request, ["keys:write"]);
    const input = ApiKeyInputSchema.parse(request.body);
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) throw httpError(400, "API key expiry must be in the future");
    const generated = generateApiKey(options.apiKeyPepper);
    await options.store.insertApiKey({ accountId: actor.accountId, ...input, id: generated.id, digest: generated.digest });
    return reply.code(201).send({
      key: {
        id: generated.id,
        name: input.name,
        prefix: `ctm_${generated.id}_`,
        secret: generated.token,
        scopes: input.scopes,
        createdAt: new Date().toISOString(),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {})
      }
    });
  });
  app.delete("/v1/api-keys/:id", async (request, reply) => {
    const actor = await principal(request, ["keys:write"]);
    const { id } = z.object({ id: z.string().length(12) }).parse(request.params);
    return await options.store.revokeApiKey(actor.accountId, id)
      ? { revoked: true }
      : reply.code(404).send({ error: "key_not_found" });
  });
  app.delete("/v1/auth/api-keys/:id", async (request, reply) => {
    const actor = await principal(request, ["keys:write"]);
    const { id } = z.object({ id: z.string().length(12) }).parse(request.params);
    return await options.store.revokeApiKey(actor.accountId, id)
      ? reply.code(204).send()
      : reply.code(404).send({ error: "key_not_found" });
  });

  app.get("/v1/context/current", async (request) => {
    const actor = await principal(request, ["context:read"]);
    const query = z.object({ projectId: z.string().optional() }).parse(request.query);
    return options.context.current(actor.accountId, query);
  });
  app.post("/v1/context/search", async (request) => {
    const actor = await principal(request, ["context:read"]);
    const body = z.object({ query: z.string().min(1).max(1_000), projectId: z.string().optional(), limit: z.number().int().min(1).max(12).optional() }).parse(request.body);
    return options.context.search(actor.accountId, body);
  });
  app.post("/v1/graph/query", async (request) => {
    const actor = await principal(request, ["context:read"]);
    return boundedGraphSnapshot(await options.context.graph(actor.accountId, GraphQuerySchema.parse(request.body)));
  });
  app.get("/v1/mcp/status", async (request) => {
    const actor = await principal(request, ["context:read"]);
    return {
      enabled: true,
      transport: "streamable-http",
      url: new URL("/mcp", options.publicBaseUrl).toString(),
      oauthMetadataUrl: new URL("/.well-known/oauth-protected-resource/mcp", options.publicBaseUrl).toString(),
      status: "available",
      accountId: actor.accountId,
      chat: { available: true, provider: "remote-context-composer", groundedOnly: true }
    };
  });

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (request, reply) => {
      const actor = await principal(request, ["context:read"]);
      if (request.method !== "POST") {
        return reply.code(405).send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed in stateless mode" }, id: null });
      }
      reply.hijack();
      await handleMcpRequest(
        request.raw,
        reply.raw,
        request.body,
        actor,
        options.context,
        new URL("/mcp", options.publicBaseUrl)
      );
    }
  });

  const purgeTimer = setInterval(() => void options.store.purgeExpired().catch((error) => app.log.error(error)), 60 * 60 * 1_000);
  purgeTimer.unref();
  app.addHook("onClose", async () => clearInterval(purgeTimer));
  return app;
}

function requestSafeLog(app: ReturnType<typeof Fastify>, error: Error): void {
  app.log.error({ name: error.name, message: error.message }, "request failed");
}
