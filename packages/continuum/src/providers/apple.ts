import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { CheckpointDraftSchema, type CheckpointDraft } from "@continuum/contracts";
import type { CheckpointInput, CheckpointProvider, ProviderHealth } from "./types.js";
import { validateEvidence } from "./types.js";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  deltas: string[];
  onDelta?: (delta: string) => void;
}

class AppleBridgeClient {
  private process?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly executable: string) {}

  private terminateProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.process === child) this.process = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let finished = false;
      let forceTimer: NodeJS.Timeout | undefined;
      let giveUpTimer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (giveUpTimer) clearTimeout(giveUpTimer);
        child.removeListener("exit", finish);
        resolve();
      };
      child.once("exit", finish);
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 250);
      forceTimer.unref();
      giveUpTimer = setTimeout(finish, 1_250);
      giveUpTimer.unref();
      try {
        if (!child.kill("SIGTERM")) finish();
      } catch {
        finish();
      }
    });
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process && !this.process.killed) return this.process;
    if (!existsSync(this.executable)) throw new Error(`Apple Foundation Models bridge not found at ${this.executable}`);
    const child = spawn(this.executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (chunk) => process.stderr.write(`[apple-foundation] ${String(chunk)}`));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { id?: string; type?: string; payload?: unknown; text?: string; code?: string; message?: string };
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        if (message.type === "delta" && typeof message.text === "string") {
          pending.deltas.push(message.text);
          pending.onDelta?.(message.text);
        }
        if (message.type === "result" || message.type === "done") {
          this.pending.delete(message.id);
          const streamedText = pending.deltas.join("");
          pending.resolve(streamedText
            ? { ...(message.payload && typeof message.payload === "object" ? message.payload : {}), text: streamedText }
            : message.payload);
        }
        if (message.type === "error") {
          this.pending.delete(message.id);
          pending.reject(new Error(`${message.code ?? "apple_model_error"}: ${message.message ?? "Apple model request failed"}`));
        }
      } catch {
        // Protocol diagnostics never enter API output or durable storage.
      }
    });
    child.once("exit", () => {
      for (const request of this.pending.values()) request.reject(new Error("Apple Foundation Models bridge exited"));
      this.pending.clear();
      if (this.process === child) this.process = undefined;
    });
    this.process = child;
    return child;
  }

  request(
    op: "health" | "checkpoint" | "chat",
    payload: unknown,
    signal?: AbortSignal,
    onDelta?: (delta: string) => void
  ): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      signal?.throwIfAborted();
      const id = randomUUID();
      const child = this.ensureProcess();
      return await new Promise<unknown>((resolve, reject) => {
        const onAbort = (): void => {
          if (!this.pending.delete(id)) return;
          signal?.removeEventListener("abort", onAbort);
          void this.terminateProcess(child).then(
            () => reject(new DOMException("The operation was aborted", "AbortError")),
            () => reject(new DOMException("The operation was aborted", "AbortError"))
          );
        };
        this.pending.set(id, {
          deltas: [],
          ...(onDelta ? { onDelta } : {}),
          resolve: (value) => { signal?.removeEventListener("abort", onAbort); resolve(value); },
          reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); }
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        child.stdin.write(`${JSON.stringify({ id, op, payload })}\n`, (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        });
      });
    };
    const queued = this.queue.then(run, run);
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child) return;
    const error = new Error("Apple Foundation Models bridge closed");
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    await this.terminateProcess(child);
  }
}

const clients = new Map<string, AppleBridgeClient>();
function clientFor(path: string): AppleBridgeClient {
  const existing = clients.get(path);
  if (existing) return existing;
  const client = new AppleBridgeClient(path);
  clients.set(path, client);
  return client;
}

export class AppleFoundationProvider implements CheckpointProvider {
  readonly id = "apple" as const;
  readonly model = "apple-system-default";
  private readonly client: AppleBridgeClient;

  constructor(readonly bridgePath: string) {
    this.client = clientFor(bridgePath);
  }

  async health(): Promise<ProviderHealth> {
    if (!existsSync(this.bridgePath)) return { status: "unavailable", detail: "Foundation Models helper is not installed" };
    try {
      const response = await this.client.request("health", {}, AbortSignal.timeout(2_500)) as { available?: boolean; detail?: string; message?: string };
      return response.available
        ? { status: "available", detail: response.detail ?? "Apple Intelligence model is ready" }
        : { status: "unavailable", detail: response.detail ?? response.message ?? "Apple Foundation Models is unavailable" };
    } catch (error) {
      return { status: "unavailable", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async createCheckpoint(input: CheckpointInput, signal?: AbortSignal): Promise<CheckpointDraft> {
    const bounded = {
      projectId: input.projectId,
      events: input.events.slice(0, 15).map((event) => ({
        id: event.id,
        occurredAt: event.occurredAt,
        source: event.source,
        eventType: event.eventType,
        title: event.title,
        attributes: event.attributes
      })),
      previousCheckpoint: input.previousCheckpoint ? {
        goal: input.previousCheckpoint.goal,
        focus: input.previousCheckpoint.focus,
        summary: input.previousCheckpoint.summary
      } : undefined
    };
    const response = await this.client.request("checkpoint", {
      prompt: JSON.stringify(bounded).slice(0, 14_000),
      validEventIds: input.events.map((event) => event.id),
      maxResponseTokens: 900
    }, signal) as { checkpoint?: unknown } | unknown;
    const raw = response && typeof response === "object" && "checkpoint" in response
      ? (response as { checkpoint: unknown }).checkpoint
      : response;
    const object = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const evidence = (value: unknown): unknown[] => Array.isArray(value) ? value.map((item) => {
      const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return { text: entry.text, eventIds: entry.eventIds ?? entry.evidenceEventIds };
    }) : [];
    const linkedEntity = (kind: string, key: unknown, label: unknown): unknown | undefined => {
      if (typeof key !== "string" || typeof label !== "string") return undefined;
      const needle = key.toLocaleLowerCase();
      const eventIds = input.events.filter((event) => JSON.stringify(event).toLocaleLowerCase().includes(needle)).map((event) => event.id).slice(0, 8);
      return eventIds.length > 0 ? { kind, key, label, eventIds } : undefined;
    };
    const generatedEntities = Array.isArray(object.entities) ? object.entities.map((item) => {
      const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return linkedEntity(String(entry.kind ?? entry.type ?? "concept"), entry.key, entry.label ?? entry.name ?? entry.key);
    }).filter(Boolean) : [];
    const fileEntities = Array.isArray(object.files) ? object.files.map((file) => linkedEntity("file", file, file)).filter(Boolean) : [];
    const commitEntities = Array.isArray(object.commits) ? object.commits.map((commit) => linkedEntity("commit", commit, `Commit ${String(commit).slice(0, 12)}`)).filter(Boolean) : [];
    const draft = CheckpointDraftSchema.parse({
      goal: object.goal,
      focus: object.focus,
      summary: object.summary,
      progress: evidence(object.progress),
      blockers: evidence(object.blockers).map((item, index) => {
        const source = Array.isArray(object.blockers) ? object.blockers[index] : undefined;
        const entry = source && typeof source === "object" ? source as Record<string, unknown> : {};
        return { ...(item as object), status: entry.status === "resolved" ? "resolved" : "open" };
      }),
      hypotheses: evidence(object.hypotheses).map((item, index) => {
        const source = Array.isArray(object.hypotheses) ? object.hypotheses[index] : undefined;
        const entry = source && typeof source === "object" ? source as Record<string, unknown> : {};
        const status = entry.status ?? entry.state;
        return { ...(item as object), status: status === "supported" || status === "disproven" ? status : "active" };
      }),
      decisions: evidence(object.decisions),
      questions: evidence(object.questions),
      entities: [...generatedEntities, ...fileEntities, ...commitEntities],
      importance: object.importance,
      confidence: object.confidence
    });
    validateEvidence(draft, input.events);
    return draft;
  }
}

export function appleBridgeClient(path: string): {
  request(
    op: "health" | "checkpoint" | "chat",
    payload: unknown,
    signal?: AbortSignal,
    onDelta?: (delta: string) => void
  ): Promise<unknown>;
  close(): Promise<void>;
} {
  return clientFor(path);
}
