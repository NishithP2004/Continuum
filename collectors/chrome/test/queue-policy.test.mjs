import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_QUEUE_EVENTS,
  QUEUE_RETENTION_MS,
  retainQueuedEvents,
} from "../queue-policy.mjs";

const NOW = Date.parse("2026-07-18T12:00:00.000Z");

function event(id, occurredAtMs = NOW) {
  return { id, occurredAt: new Date(occurredAtMs).toISOString() };
}

test("retains the 24-hour boundary and evicts older events", () => {
  const retained = retainQueuedEvents(
    [
      event("expired", NOW - QUEUE_RETENTION_MS - 1),
      event("boundary", NOW - QUEUE_RETENTION_MS),
      event("fresh", NOW - 1),
    ],
    NOW,
  );

  assert.deepEqual(retained.map(({ id }) => id), ["boundary", "fresh"]);
});

test("retains only the newest 500 events", () => {
  const events = Array.from(
    { length: MAX_QUEUE_EVENTS + 2 },
    (_, index) => event(`event-${index}`),
  );

  const retained = retainQueuedEvents(events, NOW);
  assert.equal(retained.length, MAX_QUEUE_EVENTS);
  assert.equal(retained[0]?.id, "event-2");
  assert.equal(retained.at(-1)?.id, `event-${MAX_QUEUE_EVENTS + 1}`);
});

test("uses the current policy retention instead of always keeping 24 hours", () => {
  const retained = retainQueuedEvents(
    [event("older-than-one-hour", NOW - 2 * 60 * 60 * 1_000), event("recent", NOW - 1)],
    NOW,
    1,
  );
  assert.deepEqual(retained.map(({ id }) => id), ["recent"]);
});
