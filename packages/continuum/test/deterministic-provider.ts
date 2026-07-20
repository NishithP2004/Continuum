import type { CheckpointDraft, EvidenceItem, NormalizedEvent } from "@continuum/contracts";
import type { CheckpointInput, CheckpointProvider, ProviderHealth } from "../src/providers/types.js";
import { extractEvidenceEntities } from "../src/providers/entities.js";

function evidence(event: NormalizedEvent, text = event.title): EvidenceItem {
  return { text: text.slice(0, 400), eventIds: [event.id] };
}

function statusOf(event: NormalizedEvent): string | undefined {
  if (typeof event.attributes.status === "string") return event.attributes.status;
  if (/\b(?:resolved|fixed|closed)\b/i.test(event.title)) return "resolved";
  if (/\bdisproven\b|\bnot the cause\b/i.test(event.title)) return "disproven";
  if (/\bsupported\b/i.test(event.title)) return "supported";
  return undefined;
}

/** Test-only provider. It is excluded from the production TypeScript build. */
export class DeterministicTestProvider implements CheckpointProvider {
  readonly id = "deterministic" as const;
  readonly model = "test-fixture-rules-v1";

  async health(): Promise<ProviderHealth> {
    return { status: "available" };
  }

  async createCheckpoint(input: CheckpointInput): Promise<CheckpointDraft> {
    const progress: EvidenceItem[] = [];
    const blockers: CheckpointDraft["blockers"] = [];
    const hypotheses: CheckpointDraft["hypotheses"] = [];
    const decisions: EvidenceItem[] = [];
    const questions: EvidenceItem[] = [];
    let goal = input.previousCheckpoint?.goal ?? `Resume ${input.projectId}`;

    for (const event of input.events) {
      const type = event.eventType.toLowerCase();
      const status = statusOf(event);
      if (type.includes("goal")) goal = event.title;
      if (type.includes("blocker") || (/\b(?:401|failed|failure|error)\b/i.test(event.title) && status !== "resolved")) {
        blockers.push({ ...evidence(event), status: status === "resolved" ? "resolved" : "open" });
      } else if (status === "resolved" && /blocker/i.test(String(event.attributes.kind ?? ""))) {
        blockers.push({ ...evidence(event), status: "resolved" });
      }
      if (type.includes("hypothesis")) {
        const hypothesisStatus = status === "supported" || status === "disproven" ? status : "active";
        hypotheses.push({ ...evidence(event), status: hypothesisStatus });
      }
      if (type.includes("decision")) decisions.push(evidence(event));
      if (type.includes("question")) questions.push(evidence(event));
      if (type.includes("progress") || type.includes("commit") || (type.includes("command") && Number(event.attributes.exitCode) === 0)) {
        progress.push(evidence(event));
      }
    }

    if (progress.length === 0 && input.events[0]) progress.push(evidence(input.events[0]));
    const last = input.events.at(-1);
    return {
      goal,
      focus: last?.title ?? input.previousCheckpoint?.focus ?? goal,
      summary: input.events.slice(-3).map((event) => event.title).join(" • ").slice(0, 1200),
      progress: progress.slice(0, 12),
      blockers: blockers.slice(0, 12),
      hypotheses: hypotheses.slice(0, 12),
      decisions: decisions.slice(0, 12),
      questions: questions.slice(0, 12),
      entities: extractEvidenceEntities(input.events),
      importance: Math.min(1, 0.45 + blockers.length * 0.12 + decisions.length * 0.08),
      confidence: 0.98
    };
  }
}
