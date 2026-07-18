import Fastify, { type FastifyInstance } from "fastify";
import {
  EventsBatchSchema,
  ModelSettingsSchema,
  type EngineState
} from "@continuum/contracts";
import { BriefingProvider } from "../providers/briefing.js";
import { replayFixture } from "../fixtures/replay.js";
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
  const projectId = engine.database.latestProjectId() ?? null;
  const selectedHealth = settings.activeCheckpointProvider === "openai" ? health.openai : health.ollama;
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
    providerHealth: { ollama: health.ollama.status, openai: health.openai.status },
    activeProject: projectId ? { id: projectId, name: projectId } : null,
    currentCheckpoint: engine.database.listCheckpoints(projectId ?? undefined, 1)[0] ?? null,
    recentActivity: engine.database.recentEvents(projectId ?? undefined, 50),
    privacy: privacySummary(engine),
    pendingEvents: engine.database.pendingEventCount(projectId ?? undefined),
    collectorNames: engine.database.collectorNames(),
    provider: {
      provider: settings.activeCheckpointProvider,
      model: settings.activeCheckpointProvider === "openai" ? settings.openaiModel : settings.ollamaModel,
      status: selectedHealth.status === "available" ? "ready" : selectedHealth.status,
      ...(selectedHealth.detail ? { message: selectedHealth.detail } : {}),
      cloudActive: settings.activeCheckpointProvider === "openai"
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

  app.addHook("onRequest", async (request, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-headers", "authorization,content-type");
    reply.header("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
    if (request.method === "OPTIONS") return reply.status(204).send();
    if (request.url === "/health") return;
    if (bearer(request.headers.authorization) !== engine.config.token) {
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
    const result = await engine.pipeline.ingest(batch);
    return reply.status(202).send(result);
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
      providerHealth: { ollama: health.ollama.status, openai: health.openai.status }
    };
  });

  app.patch("/v1/settings/models", async (request) => {
    const settings = ModelSettingsSchema.parse({ ...engine.database.getModelSettings(), ...(request.body as object) });
    return { settings: engine.database.setModelSettings(settings) };
  });

  app.get("/v1/privacy", async () => ({ ...privacySummary(engine), audit: engine.database.privacyAudit() }));
  app.get("/v1/resume", async (request) => {
    const query = request.query as { projectId?: string; maxCharacters?: string };
    return engine.contexts.pack({ projectId: query.projectId, maxCharacters: query.maxCharacters ? Number(query.maxCharacters) : undefined });
  });

  app.post("/v1/demo/replay", async (request) => {
    const body = (request.body ?? {}) as { phase?: unknown };
    const phase = body.phase === undefined || body.phase === "all" || body.phase === "friday" || body.phase === "monday"
      ? (body.phase ?? "all") as "all" | "friday" | "monday"
      : (() => { throw new PublicOperationError("invalid_demo_phase", "phase must be all, friday, or monday", 400); })();
    const result = await replayFixture(engine, engine.config.fixturePath, {
      phase,
      autoAcknowledgeBaseline: phase === "all"
    });
    return { label: "Synthetic deterministic replay", phase, ...result, events: result.events.length, diff: engine.contexts.diff({ projectId: result.projectId }) };
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
