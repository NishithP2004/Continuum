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
import type { NormalizedEventV2 } from "../src/types";

const NOW = Date.parse("2026-07-18T12:00:00.000Z");

function event(id: string, occurredAtMs: number): NormalizedEventV2 {
  return {
    version: "2",
    id,
    deviceId: "device-queue-test",
    occurredAt: new Date(occurredAtMs).toISOString(),
    hlc: `${occurredAtMs}:0:device-queue-test`,
    source: "vscode",
    eventType: "workspace.focused",
    projectLocator: { localAlias: "a".repeat(64) },
    title: "Queue test",
    attributes: {},
    privacy: { classification: "personal", rules: ["test"] },
    relevance: { decision: "keep", reason: "test" },
    confidence: 1,
    dedupeKey: `dedupe-${id}`,
    policyVersion: 1,
    syncEligibility: "local_only",
  };
}

async function readQueue(filePath: string): Promise<NormalizedEventV2[]> {
  return JSON.parse(await readFile(filePath, "utf8")) as NormalizedEventV2[];
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

test("tightening policy retention physically removes older queued events", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuum-vscode-retention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "events.json");
  await writeFile(filePath, JSON.stringify([
    event("older-than-one-hour", NOW - 2 * 60 * 60 * 1_000),
    event("recent", NOW - 30 * 60 * 1_000),
  ]));

  const queue = new DurableEventQueue(filePath, () => NOW);
  assert.deepEqual((await queue.peek(100, 1)).map(({ id }) => id), ["recent"]);
  assert.deepEqual((await readQueue(filePath)).map(({ id }) => id), ["recent"]);
});

test("reconciles queued events before transport", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuum-vscode-reconcile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "events.json");
  const queue = new DurableEventQueue(filePath, () => NOW);
  await queue.enqueue(event("keep", NOW));
  await queue.enqueue(event("drop", NOW));
  await queue.reconcile((entry) => entry.id === "drop"
    ? undefined
    : { ...entry, policyVersion: 42 });
  const [retained] = await queue.peek();
  assert.equal(retained?.id, "keep");
  assert.equal(retained?.policyVersion, 42);
});
