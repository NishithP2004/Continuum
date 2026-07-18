import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DurableEventQueue,
  MAX_QUEUE_EVENTS,
  QUEUE_RETENTION_MS,
} from "../src/queue";
import type { NormalizedEventV1 } from "../src/types";

const NOW = Date.parse("2026-07-18T12:00:00.000Z");

function event(id: string, occurredAtMs: number): NormalizedEventV1 {
  return {
    version: "1",
    id,
    occurredAt: new Date(occurredAtMs).toISOString(),
    source: "vscode",
    eventType: "workspace.focused",
    projectId: "queue-test",
    title: "Queue test",
    attributes: {},
    privacy: { classification: "personal", rules: ["test"] },
    relevance: { decision: "keep", reason: "test" },
    confidence: 1,
    dedupeKey: `dedupe-${id}`,
  };
}

async function readQueue(filePath: string): Promise<NormalizedEventV1[]> {
  return JSON.parse(await readFile(filePath, "utf8")) as NormalizedEventV1[];
}

test("physically evicts events older than 24 hours before retry", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "continuum-vscode-queue-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "events.json");
  const expired = event("expired", NOW - QUEUE_RETENTION_MS - 1);
  const boundary = event("boundary", NOW - QUEUE_RETENTION_MS);
  const fresh = event("fresh", NOW - 1);
  await writeFile(filePath, JSON.stringify([expired, boundary, fresh]));

  const queue = new DurableEventQueue(filePath, () => NOW);
  assert.deepEqual(
    (await queue.peek()).map(({ id }) => id),
    ["boundary", "fresh"],
  );
  assert.deepEqual(
    (await readQueue(filePath)).map(({ id }) => id),
    ["boundary", "fresh"],
  );

  await queue.enqueue(event("expired-on-write", NOW - QUEUE_RETENTION_MS - 1));
  assert.deepEqual(
    (await readQueue(filePath)).map(({ id }) => id),
    ["boundary", "fresh"],
  );
});

test("persists only the newest 1,000 events", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "continuum-vscode-queue-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "events.json");
  const initial = Array.from({ length: MAX_QUEUE_EVENTS }, (_, index) =>
    event(`event-${index}`, NOW),
  );
  await writeFile(filePath, JSON.stringify(initial));

  const queue = new DurableEventQueue(filePath, () => NOW);
  await queue.enqueue(event("newest", NOW));

  const persisted = await readQueue(filePath);
  assert.equal(persisted.length, MAX_QUEUE_EVENTS);
  assert.equal(persisted[0]?.id, "event-1");
  assert.equal(persisted.at(-1)?.id, "newest");
});
