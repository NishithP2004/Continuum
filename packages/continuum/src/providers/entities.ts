import type { Entity, NormalizedEvent } from "@continuum/contracts";
import { isInstructionLike } from "./types.js";

const allowedKinds = new Set<Entity["kind"]>([
  "project", "task", "file", "commit", "url", "error", "person", "concept", "decision", "blocker"
]);

function safeLabel(kind: Entity["kind"], key: string, label: string): string {
  return isInstructionLike(label) ? `${kind}: ${key}`.slice(0, 256) : label.slice(0, 256);
}

const semanticStopWords = new Set(["a", "an", "the", "is", "was", "may", "might", "still", "after", "before", "using", "use", "returns", "returned", "resolved", "fixed", "failed", "failure", "error", "not", "cause"]);

function semanticTokens(value: string): string[] {
  return value.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1 && !semanticStopWords.has(token));
}

export function extractEvidenceEntities(events: NormalizedEvent[]): Entity[] {
  const entities: Entity[] = [];
  const add = (event: NormalizedEvent, kind: Entity["kind"], key: string, label: string): void => {
    const normalizedKey = key.slice(0, 512);
    const existing = entities.find((entity) => entity.kind === kind && entity.key === normalizedKey);
    if (existing) {
      if (!existing.eventIds.includes(event.id) && existing.eventIds.length < 8) existing.eventIds.push(event.id);
      return;
    }
    entities.push({ kind, key: normalizedKey, label: safeLabel(kind, normalizedKey, label), eventIds: [event.id] });
  };

  for (const event of events) {
    const entityKind = event.attributes.entityKind;
    const entityKey = event.attributes.entityKey;
    const entityLabel = event.attributes.entityLabel;
    if (typeof entityKind === "string" && allowedKinds.has(entityKind as Entity["kind"]) && typeof entityKey === "string" && typeof entityLabel === "string") {
      add(event, entityKind as Entity["kind"], entityKey, entityLabel);
    }
    if (Array.isArray(event.attributes.files)) {
      for (const file of event.attributes.files) if (typeof file === "string") add(event, "file", file, file);
    }
    const file = event.attributes.file ?? event.attributes.path ?? event.attributes.relativePath;
    if (typeof file === "string") add(event, "file", file, file);
    if (typeof event.attributes.sha === "string") {
      const sha = event.attributes.sha;
      add(event, "commit", sha, `Commit ${sha.slice(0, 12)}`);
    }
    if (event.source === "chrome" && typeof event.attributes.url === "string") {
      add(event, "url", event.attributes.url, event.attributes.url);
    }
    const eventType = event.eventType.toLocaleLowerCase();
    const tokens = semanticTokens(event.title);
    if (eventType.includes("blocker") || /\b(?:4\d\d|5\d\d)\b/.test(event.title)) {
      const code = event.title.match(/\b(?:4\d\d|5\d\d)\b/)?.[0];
      const subject = tokens.find((token) => token !== code) ?? "blocker";
      add(event, "blocker", code ? `${subject}-${code}` : tokens.slice(0, 4).join("-") || "blocker", event.title);
    }
    if (eventType.includes("hypothesis")) {
      add(event, "concept", tokens.slice(0, 2).join("-") || "hypothesis", event.title);
    }
    if (eventType.includes("decision")) {
      add(event, "decision", tokens.slice(0, 6).join("-") || "decision", event.title);
    }
  }
  return entities.slice(0, 32);
}
