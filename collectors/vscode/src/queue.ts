import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NormalizedEventV1 } from "./types";

export const MAX_QUEUE_EVENTS = 1_000;
export const QUEUE_RETENTION_MS = 24 * 60 * 60 * 1_000;

function isQueueEvent(value: unknown): value is NormalizedEventV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NormalizedEventV1>;
  return (
    candidate.version === "1" &&
    candidate.source === "vscode" &&
    typeof candidate.id === "string" &&
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

  enqueue(event: NormalizedEventV1): Promise<void> {
    return this.serialize(async () => {
      const events = await this.readRetainedUnsafe();
      if (!events.some((entry) => entry.dedupeKey === event.dedupeKey)) {
        events.push(event);
      }
      await this.writeUnsafe(events);
    });
  }

  peek(limit = 100): Promise<NormalizedEventV1[]> {
    return this.serialize(async () =>
      (await this.readRetainedUnsafe()).slice(0, limit),
    );
  }

  remove(ids: ReadonlySet<string>): Promise<void> {
    return this.serialize(async () => {
      const events = await this.readRetainedUnsafe();
      await this.writeUnsafe(events.filter((event) => !ids.has(event.id)));
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

  private async readUnsafe(): Promise<NormalizedEventV1[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return Array.isArray(parsed) ? parsed.filter(isQueueEvent) : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  private async readRetainedUnsafe(): Promise<NormalizedEventV1[]> {
    const events = await this.readUnsafe();
    const retained = this.retain(events);
    if (retained.length !== events.length) {
      await this.writeUnsafe(retained);
    }
    return retained;
  }

  private retain(events: NormalizedEventV1[]): NormalizedEventV1[] {
    const cutoff = this.now() - QUEUE_RETENTION_MS;
    return events
      .filter((event) => Date.parse(event.occurredAt) >= cutoff)
      .slice(-MAX_QUEUE_EVENTS);
  }

  private async writeUnsafe(events: NormalizedEventV1[]): Promise<void> {
    const retained = this.retain(events);
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(retained), { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
