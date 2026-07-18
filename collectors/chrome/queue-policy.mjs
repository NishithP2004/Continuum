export const MAX_QUEUE_EVENTS = 500;
export const QUEUE_RETENTION_MS = 24 * 60 * 60 * 1_000;

export function retainQueuedEvents(value, nowMs = Date.now()) {
  const cutoff = nowMs - QUEUE_RETENTION_MS;
  const events = Array.isArray(value) ? value : [];
  return events
    .filter((event) => {
      if (!event || typeof event.occurredAt !== "string") return false;
      const occurredAt = Date.parse(event.occurredAt);
      return Number.isFinite(occurredAt) && occurredAt >= cutoff;
    })
    .slice(-MAX_QUEUE_EVENTS);
}
