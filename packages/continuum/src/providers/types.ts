import type { CheckpointDraft, CheckpointV1, NormalizedEvent } from "@continuum/contracts";

export interface CheckpointInput {
  projectId: string;
  events: NormalizedEvent[];
  previousCheckpoint?: CheckpointV1;
}

export interface ProviderHealth {
  status: "available" | "unavailable" | "unknown";
  detail?: string;
  models?: string[];
}

export interface CheckpointProvider {
  readonly id: "deterministic" | "apple" | "ollama" | "openai";
  readonly model: string;
  health(): Promise<ProviderHealth>;
  createCheckpoint(input: CheckpointInput, signal?: AbortSignal): Promise<CheckpointDraft>;
}

const instructionLike = [
  /\b(?:ignore|disregard|override)\b.{0,48}\b(?:instruction|prompt|rule|system|developer)\b/i,
  /\b(?:system|developer|assistant)\s+(?:message|prompt)\b/i,
  /\b(?:call|invoke)\s+(?:the\s+)?(?:mcp|tool)\b/i,
  /\b(?:reveal|exfiltrate|print|send)\b.{0,48}\b(?:secret|token|password|credential)\b/i,
  /<\|(?:system|developer|assistant)\|>/i
];

export function isInstructionLike(value: string): boolean {
  return instructionLike.some((pattern) => pattern.test(value));
}

export function validateEvidence(draft: CheckpointDraft, events: NormalizedEvent[]): void {
  const allowed = new Set(events.map((event) => event.id));
  const evidence = [
    ...draft.progress,
    ...draft.blockers,
    ...draft.hypotheses,
    ...draft.decisions,
    ...draft.questions
  ];
  const textValues = [
    draft.goal,
    draft.focus,
    draft.summary,
    ...evidence.map((item) => item.text),
    ...draft.entities.flatMap((entity) => [entity.key, entity.label])
  ];
  if (textValues.some(isInstructionLike)) {
    throw new Error("Checkpoint contains instruction-like untrusted metadata");
  }
  for (const item of evidence) {
    for (const eventId of item.eventIds) {
      if (!allowed.has(eventId)) throw new Error(`Checkpoint cited unknown event ID: ${eventId}`);
    }
  }
  for (const entity of draft.entities) {
    for (const eventId of entity.eventIds) {
      if (!allowed.has(eventId)) throw new Error(`Checkpoint entity cited unknown event ID: ${eventId}`);
    }
  }
}
