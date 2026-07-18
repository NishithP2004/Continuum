import { readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

export const QUEUE_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_QUEUE_EVENTS = 1_000;

const EVENT_FILE = /^[0-9a-f-]+\.json$/i;

export async function pruneQueue(
  queueDir,
  { nowMs = Date.now(), maxEntries = MAX_QUEUE_EVENTS } = {},
) {
  if (!Number.isFinite(nowMs)) throw new Error("queue clock must be finite");
  if (!Number.isInteger(maxEntries) || maxEntries < 0 || maxEntries > MAX_QUEUE_EVENTS) {
    throw new Error(`queue maximum must be between 0 and ${MAX_QUEUE_EVENTS}`);
  }
  let names;
  try {
    names = (await readdir(queueDir)).filter((name) => EVENT_FILE.test(name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const fresh = [];
  const remove = new Set();
  for (const name of names) {
    try {
      const event = JSON.parse(await readFile(path.join(queueDir, name), "utf8"));
      const occurredAtMs = Date.parse(event?.occurredAt);
      if (!Number.isFinite(occurredAtMs) || occurredAtMs < nowMs - QUEUE_TTL_MS) {
        remove.add(name);
      } else {
        fresh.push({ name, occurredAtMs });
      }
    } catch {
      // Invalid queue entries are never retained or transmitted.
      remove.add(name);
    }
  }

  fresh.sort((left, right) =>
    right.occurredAtMs - left.occurredAtMs || right.name.localeCompare(left.name),
  );
  for (const entry of fresh.slice(maxEntries)) remove.add(entry.name);
  await Promise.all(
    [...remove].map((name) => unlink(path.join(queueDir, name)).catch(() => undefined)),
  );
  return fresh.slice(0, maxEntries).map(({ name }) => name);
}
