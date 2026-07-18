import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_QUEUE_EVENTS, QUEUE_TTL_MS, pruneQueue } from "../queue-policy.mjs";

async function put(queueDir, occurredAt) {
  const name = `${randomUUID()}.json`;
  await writeFile(path.join(queueDir, name), JSON.stringify({ occurredAt }));
  return name;
}

test("physically evicts expired and invalid terminal queue entries", async (context) => {
  const queueDir = await mkdtemp(path.join(os.tmpdir(), "continuum-zsh-queue-"));
  context.after(() => rm(queueDir, { recursive: true, force: true }));
  const nowMs = Date.parse("2026-07-18T12:00:00.000Z");
  const expired = await put(queueDir, new Date(nowMs - QUEUE_TTL_MS - 1).toISOString());
  const boundary = await put(queueDir, new Date(nowMs - QUEUE_TTL_MS).toISOString());
  const fresh = await put(queueDir, new Date(nowMs - 1_000).toISOString());
  const invalid = `${randomUUID()}.json`;
  await writeFile(path.join(queueDir, invalid), "not-json");

  await pruneQueue(queueDir, { nowMs, maxEntries: 10 });
  const remaining = new Set(await readdir(queueDir));
  assert.equal(remaining.has(expired), false);
  assert.equal(remaining.has(invalid), false);
  assert.equal(remaining.has(boundary), true);
  assert.equal(remaining.has(fresh), true);
  assert.equal((await readFile(path.join(queueDir, fresh), "utf8")).includes("occurredAt"), true);
});

test("retains only the newest events at the documented terminal cap", async (context) => {
  const queueDir = await mkdtemp(path.join(os.tmpdir(), "continuum-zsh-cap-"));
  context.after(() => rm(queueDir, { recursive: true, force: true }));
  const nowMs = Date.parse("2026-07-18T12:00:00.000Z");
  const names = await Promise.all(
    Array.from({ length: MAX_QUEUE_EVENTS + 2 }, (_, index) =>
      put(queueDir, new Date(nowMs - (MAX_QUEUE_EVENTS + 2 - index) * 10).toISOString())),
  );
  const retained = await pruneQueue(queueDir, { nowMs });
  const remaining = new Set(await readdir(queueDir));
  assert.equal(retained.length, MAX_QUEUE_EVENTS);
  assert.equal(remaining.size, MAX_QUEUE_EVENTS);
  assert.equal(remaining.has(names[0]), false);
  assert.equal(remaining.has(names[1]), false);
  assert.equal(remaining.has(names.at(-1)), true);
  assert.equal(MAX_QUEUE_EVENTS, 1_000);
});
