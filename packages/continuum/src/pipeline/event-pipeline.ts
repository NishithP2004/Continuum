import { randomUUID } from "node:crypto";
import {
  CheckpointDraftSchema,
  CheckpointV1Schema,
  type CheckpointV1,
  type EventsBatch,
  type NormalizedEventV1
} from "@continuum/contracts";
import type { ContinuumDatabase } from "../db/database.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { EmbeddingService } from "../retrieval/embeddings.js";
import { applyPrivacyGate, cloudEligible } from "./privacy.js";
import { extractEvidenceEntities } from "../providers/entities.js";
import { validateEvidence } from "../providers/types.js";

function providerFailureCode(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "provider_aborted";
  const name = error instanceof Error ? error.name : "";
  if (name === "SyntaxError" || name === "ZodError") return "provider_invalid_response";
  const message = error instanceof Error ? error.message : "";
  if (/evidence|instruction-like|unknown event id/i.test(message)) return "provider_invalid_evidence";
  if (/HTTP\s+\d{3}/i.test(message)) return "provider_http_error";
  return "provider_failed";
}

export interface IngestResult {
  accepted: number;
  duplicate: number;
  dropped: number;
  secret: number;
  projectIds: string[];
}

export class EventPipeline {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly retentionTimer: NodeJS.Timeout;
  private activeProjectId?: string;

  constructor(
    private readonly database: ContinuumDatabase,
    private readonly providers: ProviderRegistry,
    private readonly embeddings: EmbeddingService
  ) {
    this.database.purgeExpiredEvents();
    this.retentionTimer = setInterval(() => this.database.purgeExpiredEvents(), 60 * 60 * 1_000);
    this.retentionTimer.unref();
  }

  async ingest(batch: EventsBatch): Promise<IngestResult> {
    const result: IngestResult = { accepted: 0, duplicate: 0, dropped: 0, secret: 0, projectIds: [] };
    const touched = new Set<string>();
    if (this.database.capturePaused()) return { ...result, dropped: batch.events.length };

    for (const input of batch.events) {
      const privacy = applyPrivacyGate(input);
      if (!privacy.accepted) {
        if (this.database.auditPrivacy(privacy.source, privacy.rule, "drop", 1, privacy.eventId)) {
          result.dropped += 1;
          if (privacy.secret) result.secret += 1;
        } else {
          result.duplicate += 1;
        }
        continue;
      }
      if (privacy.event.eventType === "privacy.drop.aggregate") {
        const rule = typeof privacy.event.attributes.rule === "string" ? privacy.event.attributes.rule : "collector_secret";
        const count = typeof privacy.event.attributes.count === "number" ? privacy.event.attributes.count : 1;
        if (this.database.auditPrivacy(privacy.event.source, rule, "drop", count, privacy.event.id)) {
          const boundedCount = Math.min(10_000, Math.max(1, Math.trunc(count)));
          result.dropped += boundedCount;
          result.secret += boundedCount;
        } else {
          result.duplicate += 1;
        }
        continue;
      }
      if (this.activeProjectId && this.activeProjectId !== privacy.event.projectId) {
        await this.flush(this.activeProjectId).catch(() => undefined);
      }
      this.activeProjectId = privacy.event.projectId;
      if (this.database.insertEvent(privacy.event)) {
        result.accepted += 1;
        touched.add(privacy.event.projectId);
      } else {
        result.duplicate += 1;
      }
    }

    result.projectIds = [...touched];
    for (const projectId of touched) {
      if (this.database.pendingEvents(projectId, 15).length >= 15) {
        await this.flush(projectId).catch(() => undefined);
      } else {
        this.scheduleFlush(projectId);
      }
    }
    return result;
  }

  close(): void {
    clearInterval(this.retentionTimer);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private scheduleFlush(projectId: string): void {
    const prior = this.timers.get(projectId);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      this.timers.delete(projectId);
      void this.flush(projectId).catch(() => undefined);
    }, 30_000);
    timer.unref();
    this.timers.set(projectId, timer);
  }

  async flush(projectId?: string, providerOverride?: "deterministic"): Promise<CheckpointV1[]> {
    const projects = projectId ? [projectId] : this.database.projectsWithPendingEvents();
    const results: CheckpointV1[] = [];
    for (const currentProject of projects) {
      while (true) {
        const pending = this.database.pendingEvents(currentProject, 15);
        if (pending.length === 0) break;
        results.push(await this.flushWindow(currentProject, pending, providerOverride));
        if (pending.length < 15) break;
      }
    }
    return results;
  }

  private async flushWindow(projectId: string, rawEvents: NormalizedEventV1[], providerOverride?: "deterministic"): Promise<CheckpointV1> {
    const settings = this.database.getModelSettings();
    const provider = this.providers.provider(settings, providerOverride);
    const events = provider.id === "openai" ? rawEvents.filter(cloudEligible) : rawEvents;
    if (events.length === 0) throw new Error("This window contains no cloud-eligible events; switch to the local provider");

    const windowId = this.database.createWindow(projectId, rawEvents, provider.id, provider.model, rawEvents.every(cloudEligible));
    const runId = randomUUID();
    const started = performance.now();
    try {
      // Local checkpoints may contain confidential evidence. Cloud generation
      // deliberately starts without prior checkpoint text so switching providers
      // cannot carry local-only state across the boundary.
      const previousCheckpoint = provider.id === "openai" ? undefined : this.database.listCheckpoints(projectId, 1)[0];
      const providerDraft = CheckpointDraftSchema.parse(await provider.createCheckpoint({ projectId, events, ...(previousCheckpoint ? { previousCheckpoint } : {}) }));
      const draft = CheckpointDraftSchema.parse({ ...providerDraft, entities: extractEvidenceEntities(events) });
      validateEvidence(draft, events);
      const checkpoint = CheckpointV1Schema.parse({
        ...draft,
        version: "1",
        id: randomUUID(),
        projectId,
        windowId,
        eventIds: rawEvents.map((event) => event.id),
        provider: provider.id,
        model: provider.model,
        createdAt: rawEvents.at(-1)?.occurredAt ?? new Date().toISOString()
      });
      const embedding = await this.embeddings.embed([
        checkpoint.goal,
        checkpoint.focus,
        checkpoint.summary,
        ...checkpoint.blockers.map((item) => item.text),
        ...checkpoint.hypotheses.map((item) => item.text),
        ...checkpoint.decisions.map((item) => item.text)
      ].join(" "));
      this.database.insertCheckpoint(checkpoint, embedding);
      this.database.recordProviderRun({
        id: runId,
        windowId,
        provider: provider.id,
        model: provider.model,
        status: "success",
        latencyMs: Math.round(performance.now() - started),
        eventIds: events.map((event) => event.id)
      });
      return checkpoint;
    } catch (error) {
      const errorCode = providerFailureCode(error);
      this.database.markWindowFailed(windowId, errorCode);
      this.database.recordProviderRun({
        id: runId,
        windowId,
        provider: provider.id,
        model: provider.model,
        status: "failed",
        latencyMs: Math.round(performance.now() - started),
        eventIds: events.map((event) => event.id),
        error: errorCode
      });
      throw new Error(errorCode);
    }
  }
}
