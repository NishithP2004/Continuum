export const MAX_QUEUE_EVENTS = 500;
export const QUEUE_RETENTION_MS = 24 * 60 * 60 * 1_000;

export function retainQueuedEvents(value, nowMs = Date.now(), retentionHours = 24) {
  if (!Number.isInteger(retentionHours) || retentionHours < 1 || retentionHours > 24) {
    throw new Error("queue retention must be between 1 and 24 hours");
  }
  const cutoff = nowMs - retentionHours * 60 * 60 * 1_000;
  const events = Array.isArray(value) ? value : [];
  return events
    .filter((event) => {
      if (!event || typeof event.occurredAt !== "string") return false;
      const occurredAt = Date.parse(event.occurredAt);
      return Number.isFinite(occurredAt) && occurredAt >= cutoff;
    })
    .slice(-MAX_QUEUE_EVENTS);
}
