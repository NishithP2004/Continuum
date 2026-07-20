import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NormalizedEventV2 } from "./types";

export const MAX_QUEUE_EVENTS = 1_000;
export const QUEUE_RETENTION_MS = 24 * 60 * 60 * 1_000;

function retentionMilliseconds(retentionHours: number): number {
  if (!Number.isInteger(retentionHours) || retentionHours < 1 || retentionHours > 24) {
    throw new Error("queue retention must be between 1 and 24 hours");
  }
  return retentionHours * 60 * 60 * 1_000;
}

function isQueueEvent(value: unknown): value is NormalizedEventV2 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NormalizedEventV2>;
  return (
    candidate.version === "2" &&
    candidate.source === "vscode" &&
    typeof candidate.id === "string" &&
    typeof candidate.deviceId === "string" &&
    typeof candidate.hlc === "string" &&
    typeof candidate.occurredAt === "string" &&
    Number.isFinite(Date.parse(candidate.occurredAt)) &&
    typeof candidate.dedupeKey === "string" &&
    !!candidate.attributes &&
    typeof candidate.attributes === "object"
  );
}

export class DurableEventQueue {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  enqueue(event: NormalizedEventV2, retentionHours = 24): Promise<void> {
    return this.serialize(async () => {
      const events = await this.readRetainedUnsafe(retentionHours);
      if (!events.some((entry) => entry.dedupeKey === event.dedupeKey)) {
        events.push(event);
      }
      await this.writeUnsafe(events, retentionHours);
    });
  }

  peek(limit = 100, retentionHours = 24): Promise<NormalizedEventV2[]> {
    return this.serialize(async () =>
      (await this.readRetainedUnsafe(retentionHours)).slice(0, limit),
    );
  }

  remove(ids: ReadonlySet<string>, retentionHours = 24): Promise<void> {
    return this.serialize(async () => {
      const events = await this.readRetainedUnsafe(retentionHours);
      await this.writeUnsafe(events.filter((event) => !ids.has(event.id)), retentionHours);
    });
  }

  reconcile(
    transform: (event: NormalizedEventV2) => NormalizedEventV2 | undefined,
    retentionHours = 24,
  ): Promise<NormalizedEventV2[]> {
    return this.serialize(async () => {
      const events = await this.readRetainedUnsafe(retentionHours);
      const reconciled = events
        .map(transform)
        .filter((event): event is NormalizedEventV2 => event !== undefined);
      await this.writeUnsafe(reconciled, retentionHours);
      return reconciled;
    });
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const current = this.operation.then(work, work);
    this.operation = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private async readUnsafe(): Promise<NormalizedEventV2[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return Array.isArray(parsed) ? parsed.filter(isQueueEvent) : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  private async readRetainedUnsafe(retentionHours: number): Promise<NormalizedEventV2[]> {
    const events = await this.readUnsafe();
    const retained = this.retain(events, retentionHours);
    if (retained.length !== events.length) {
      await this.writeUnsafe(retained, retentionHours);
    }
    return retained;
  }

  private retain(events: NormalizedEventV2[], retentionHours: number): NormalizedEventV2[] {
    const cutoff = this.now() - retentionMilliseconds(retentionHours);
    return events
      .filter((event) => Date.parse(event.occurredAt) >= cutoff)
      .slice(-MAX_QUEUE_EVENTS);
  }

  private async writeUnsafe(events: NormalizedEventV2[], retentionHours: number): Promise<void> {
    const retained = this.retain(events, retentionHours);
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(retained), { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
