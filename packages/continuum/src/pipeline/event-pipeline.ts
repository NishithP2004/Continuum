import { randomUUID } from "node:crypto";
import {
  CheckpointDraftSchema,
  CheckpointV1Schema,
  type CheckpointV1,
  type EventsBatch,
  type NormalizedEvent,
  type ActiveProjectLeaseV1
} from "@continuum/contracts";
import type { ContinuumDatabase } from "../db/database.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { EmbeddingService } from "../retrieval/embeddings.js";
import { applyPrivacyGate, cloudEligible } from "./privacy.js";
import { extractEvidenceEntities } from "../providers/entities.js";
import { validateEvidence } from "../providers/types.js";
import type { CheckpointProvider } from "../providers/types.js";

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
  identityConflicts: Array<{
    conflictId?: string;
    eventId: string;
    assignedProjectId: string;
    candidateProjectIds: string[];
  }>;
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
    this.database.purgeExpiredEvents(this.database.getPrivacyPolicy().retentionHours);
    this.retentionTimer = setInterval(() => this.database.purgeExpiredEvents(this.database.getPrivacyPolicy().retentionHours), 60 * 60 * 1_000);
    this.retentionTimer.unref();
  }

  async ingest(batch: EventsBatch): Promise<IngestResult> {
    const result: IngestResult = {
      accepted: 0, duplicate: 0, dropped: 0, secret: 0, projectIds: [], identityConflicts: []
    };
    const touched = new Set<string>();
    if (this.database.capturePaused()) return { ...result, dropped: batch.events.length };

    const policy = this.database.getPrivacyPolicy();
    for (const input of batch.events) {
      const privacy = applyPrivacyGate(input, policy);
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
      const sourceProjectId = privacy.event.projectId;
      const projectLabel = typeof privacy.event.attributes.workspace === "string"
        ? privacy.event.attributes.workspace
        : typeof privacy.event.attributes.projectName === "string"
          ? privacy.event.attributes.projectName
          : sourceProjectId;
      const repositoryFingerprint = privacy.event.version === "2" ? privacy.event.projectLocator?.repositoryFingerprint : undefined;
      const localAlias = privacy.event.version === "2" ? privacy.event.projectLocator?.localAlias : undefined;
      const identityCandidate = sourceProjectId ?? localAlias;
      const identityResolution = identityCandidate
        ? this.database.resolveProjectIdentity(
            identityCandidate,
            projectLabel ?? identityCandidate,
            repositoryFingerprint,
            privacy.event.version === "2" ? privacy.event.deviceId : this.database.deviceId()
          )
        : undefined;
      // App/window observations may describe the current development session,
      // but they are not authoritative enough to create or extend a lease.
      // Attribute them to an existing lease only; otherwise keep them unassigned.
      const leasedProjectId = !identityCandidate
        && privacy.event.source === "os"
        && (privacy.event.eventType.startsWith("app_") || privacy.event.eventType.startsWith("window_"))
        ? this.database.activeProjectLease(
            privacy.event.version === "2" ? privacy.event.deviceId : this.database.deviceId()
          )?.projectId
        : undefined;
      const resolvedProjectId = identityResolution?.projectId ?? leasedProjectId;
      if (identityResolution?.status === "ambiguous") {
        result.identityConflicts.push({
          ...(identityResolution.conflictId ? { conflictId: identityResolution.conflictId } : {}),
          eventId: privacy.event.id,
          assignedProjectId: identityResolution.projectId,
          candidateProjectIds: identityResolution.candidateProjectIds
        });
      }
      const resolvedEvent = {
        ...privacy.event,
        ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
        ...(privacy.event.version === "2" && identityResolution?.status === "ambiguous"
          ? { syncEligibility: "local_only" as const }
          : {})
      };
      const event: NormalizedEvent = resolvedEvent.version === "2"
        ? resolvedEvent
        : {
            version: "2",
            id: resolvedEvent.id,
            deviceId: this.database.deviceId(),
            occurredAt: resolvedEvent.occurredAt,
            hlc: `${Date.now()}:0:${this.database.deviceId()}`,
            source: resolvedEvent.source as Exclude<typeof resolvedEvent.source, "demo">,
            eventType: resolvedEvent.eventType,
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
            ...(resolvedEvent.sessionId ? { sessionId: resolvedEvent.sessionId } : {}),
            title: resolvedEvent.title,
            attributes: resolvedEvent.attributes,
            privacy: resolvedEvent.privacy,
            relevance: resolvedEvent.relevance,
            confidence: resolvedEvent.confidence,
            ...(resolvedEvent.dedupeKey ? { dedupeKey: resolvedEvent.dedupeKey } : {}),
            policyVersion: policy.revision,
            syncEligibility: !(resolvedEvent.source === "os" && resolvedEvent.eventType.startsWith("window"))
              && (resolvedEvent.privacy.classification === "public"
              || (resolvedEvent.privacy.classification === "personal" && policy.metadata.personalCloudEligibility)
              ) ? "cloud_eligible" : "local_only"
          };
      if (resolvedProjectId && this.activeProjectId && this.activeProjectId !== resolvedProjectId) {
        await this.flush(this.activeProjectId).catch(() => undefined);
      }
      if (resolvedProjectId) this.activeProjectId = resolvedProjectId;
      if (this.database.insertEvent(event)) {
        result.accepted += 1;
        if (resolvedProjectId) {
          touched.add(resolvedProjectId);
          this.updateActiveProjectLease(event, resolvedProjectId, projectLabel ?? resolvedProjectId);
        }
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

  private updateActiveProjectLease(event: NormalizedEvent, projectId: string, projectName: string): void {
    let source: ActiveProjectLeaseV1["source"] | undefined;
    let confidence = event.confidence;
    let ttlMs = 5 * 60_000;
    if (event.source === "vscode" && (event.eventType.includes("focus") || event.eventType.includes("active"))) source = "vscode";
    if (event.source === "terminal") source = "terminal";
    if (event.source === "git") { source = "git"; confidence = Math.min(confidence, 0.8); ttlMs = 2 * 60_000; }
    if (event.source === "os" && event.eventType.startsWith("folder")) { source = "folder"; confidence = Math.min(confidence, 0.75); }
    if (!source) return;
    const issuedAt = new Date(event.occurredAt);
    const expiresAt = new Date(issuedAt.getTime() + ttlMs);
    if (!Number.isFinite(issuedAt.getTime()) || expiresAt <= new Date()) return;
    this.database.setActiveProjectLease({
      version: "1",
      projectId,
      projectName: projectName.slice(0, 256),
      source,
      confidence,
      deviceId: this.database.deviceId(),
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    });
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

  async flush(projectId?: string, providerOverride?: CheckpointProvider): Promise<CheckpointV1[]> {
    const projects = projectId ? [this.database.resolveProjectId(projectId, projectId)] : this.database.projectsWithPendingEvents();
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

  private async flushWindow(projectId: string, rawEvents: NormalizedEvent[], providerOverride?: CheckpointProvider): Promise<CheckpointV1> {
    const settings = this.database.getModelSettings();
    const provider = providerOverride ?? this.providers.provider(settings);
    const events = provider.id === "openai" ? rawEvents.filter(cloudEligible) : rawEvents;
    if (events.length === 0) throw new Error("This window contains no cloud-eligible events; switch to the local provider");

    const checkpointCloudEligible = rawEvents.every(cloudEligible);
    const windowId = this.database.createWindow(projectId, rawEvents, provider.id, provider.model, checkpointCloudEligible);
    const runId = randomUUID();
    const started = performance.now();
    try {
      // Provider locality and checkpoint sync eligibility are separate concerns:
      // an Ollama or Apple run over public events can still produce a checkpoint
      // that is synchronized. Never seed such a run with a local-only checkpoint.
      // OpenAI remains more conservative and receives no prior checkpoint text.
      const previousCheckpoint = provider.id === "openai"
        ? undefined
        : this.database.listCheckpoints(
            projectId,
            1,
            undefined,
            undefined,
            checkpointCloudEligible ? { cloudEligibleOnly: true } : {}
          )[0];
      const providerDraft = CheckpointDraftSchema.parse(await provider.createCheckpoint({ projectId, events, ...(previousCheckpoint ? { previousCheckpoint } : {}) }));
      const draft = CheckpointDraftSchema.parse({ ...providerDraft, entities: extractEvidenceEntities(events) });
      validateEvidence(draft, events);
      const checkpoint = CheckpointV1Schema.parse({
        ...draft,
        version: "1",
        id: randomUUID(),
        projectId,
        deviceId: this.database.deviceId(),
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
