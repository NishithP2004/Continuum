import {
  ContextDiffV1Schema,
  ContextPackV1Schema,
  EntitySchema,
  type CheckpointV1,
  type ContextChange,
  type ContextDiffV1,
  type ContextPackV1,
  type Entity,
  type RankedCheckpoint
} from "@continuum/contracts";
import type { ContinuumDatabase } from "../db/database.js";
import type { EmbeddingService } from "./embeddings.js";

export interface ContextServiceOptions {
  cloudEligibleOnly?: boolean;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function entityFromRow(row: Entity): Entity | undefined {
  const parsed = EntitySchema.safeParse(row);
  return parsed.success ? parsed.data : undefined;
}

function compactCheckpoint(checkpoint: CheckpointV1): CheckpointV1 {
  const compactEvidence = <T extends { text: string; eventIds: string[] }>(items: T[], limit: number): T[] =>
    items.slice(-limit).map((item) => ({ ...item, text: item.text.slice(0, 180) }));
  return {
    ...checkpoint,
    goal: checkpoint.goal.slice(0, 220),
    focus: checkpoint.focus.slice(0, 220),
    summary: checkpoint.summary.slice(0, 420),
    progress: compactEvidence(checkpoint.progress, 3),
    blockers: compactEvidence(checkpoint.blockers, 4),
    hypotheses: compactEvidence(checkpoint.hypotheses, 3),
    decisions: compactEvidence(checkpoint.decisions, 3),
    questions: compactEvidence(checkpoint.questions, 2),
    entities: checkpoint.entities.slice(0, 8).map((entity) => ({
      ...entity,
      key: entity.key.slice(0, 240),
      label: entity.label.slice(0, 160)
    }))
  };
}

function normalizedTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);
}

function stateKey(
  checkpoint: CheckpointV1,
  item: { text: string; eventIds: string[] },
  entityKind: "blocker" | "concept"
): string {
  const candidates = checkpoint.entities.filter((entity) => entity.kind === entityKind);
  const cited = candidates.find((entity) => entity.eventIds.some((eventId) => item.eventIds.includes(eventId)));
  if (cited) return `${entityKind}:${cited.key.toLowerCase()}`;
  const itemTokens = new Set(normalizedTokens(item.text));
  const ranked = candidates.map((entity) => {
    const tokens = [...new Set([...normalizedTokens(entity.key), ...normalizedTokens(entity.label)])];
    const overlap = tokens.filter((token) => itemTokens.has(token)).length;
    return { entity, overlap, tokenCount: tokens.length };
  }).sort((left, right) => right.overlap - left.overlap || left.tokenCount - right.tokenCount);
  if (ranked[0] && ranked[0].overlap > 0 && ranked[0].overlap >= Math.ceil(ranked[0].tokenCount / 2)) {
    return `${entityKind}:${ranked[0].entity.key.toLowerCase()}`;
  }
  return `text:${normalizedTokens(item.text).join("-")}`;
}

export class ContextService {
  private readonly queryOptions: { cloudEligibleOnly?: boolean };

  constructor(
    private readonly database: ContinuumDatabase,
    private readonly embeddings: EmbeddingService,
    options: ContextServiceOptions = {}
  ) {
    this.queryOptions = options.cloudEligibleOnly ? { cloudEligibleOnly: true } : {};
  }

  async pack(input: { projectId?: string; query?: string; maxCharacters?: number; limit?: number } = {}): Promise<ContextPackV1> {
    const projectId = input.projectId ?? this.database.latestProjectId(this.queryOptions) ?? "demo";
    const maxCharacters = Math.min(12_000, Math.max(1_000, input.maxCharacters ?? 12_000));
    const maxCheckpoints = Math.min(12, Math.max(1, input.limit ?? 12));
    const recent = this.database.listCheckpoints(projectId, 100, undefined, undefined, this.queryOptions);
    const scores = new Map<string, { score: number; reasons: string[] }>();

    const addScore = (id: string, score: number, reason: string): void => {
      const current = scores.get(id) ?? { score: 0, reasons: [] };
      current.score += score;
      current.reasons.push(reason);
      scores.set(id, current);
    };

    let degraded = !this.database.vectorAvailable || !this.embeddings.peekStatus().available;
    if (input.query?.trim()) {
      const embedding = await this.embeddings.embed(input.query);
      if (embedding && this.database.vectorAvailable) {
        degraded = false;
        this.database.vectorSearch(projectId, embedding, 30, this.queryOptions).forEach((match, index) => addScore(match.checkpointId, 0.5 / (index + 1), "vector"));
      } else {
        degraded = true;
      }
      const lexical = this.database.lexicalSearch(projectId, input.query, 30, this.queryOptions);
      lexical.forEach((match, index) => addScore(match.checkpointId, 0.25 / (index + 1), "lexical"));
      const related = this.database.graphRelated(projectId, lexical.map((match) => match.checkpointId), 30, this.queryOptions);
      related.forEach((id, index) => addScore(id, 0.15 / (index + 1), "graph"));
    }

    recent.forEach((checkpoint, index) => {
      addScore(checkpoint.id, checkpoint.importance * 0.05, "importance");
      addScore(checkpoint.id, 0.05 / (index + 1), "recency");
    });

    const byId = new Map(recent.map((checkpoint) => [checkpoint.id, checkpoint]));
    for (const id of scores.keys()) {
      if (!byId.has(id)) {
        const checkpoint = this.database.getCheckpoint(id, this.queryOptions);
        if (checkpoint) byId.set(id, checkpoint);
      }
    }
    let ranked: RankedCheckpoint[] = [...scores.entries()]
      .flatMap(([id, ranking]) => {
        const checkpoint = byId.get(id);
        return checkpoint ? [{ checkpoint, score: ranking.score, reasons: [...new Set(ranking.reasons)] }] : [];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxCheckpoints)
      .sort((a, b) => a.checkpoint.createdAt.localeCompare(b.checkpoint.createdAt));

    if (ranked.length === 0) {
      ranked = recent.slice(0, maxCheckpoints).reverse().map((checkpoint, index) => ({ checkpoint, score: 1 / (index + 1), reasons: ["recency"] }));
    }

    const currentReference = ranked.at(-1)?.checkpoint ?? recent[0];
    const makePack = (selected: RankedCheckpoint[], compact = false): ContextPackV1 => {
      const checkpoints = selected.map((entry) => entry.checkpoint);
      const last = checkpoints.at(-1);
      const graphEntities = this.database.graphEntities(projectId, checkpoints.map((checkpoint) => checkpoint.id), this.queryOptions)
        .flatMap((row) => entityFromRow(row) ?? [])
        .slice(0, compact ? 8 : 64);
      const entities = uniqueBy([...checkpoints.flatMap((checkpoint) => checkpoint.entities), ...graphEntities], (entity) => `${entity.kind}:${entity.key}`);
      const pack = {
        version: "1" as const,
        projectId,
        generatedAt: new Date().toISOString(),
        currentGoal: last?.goal ?? currentReference?.goal.slice(0, 160) ?? "No checkpoint yet",
        currentFocus: last?.focus ?? currentReference?.focus.slice(0, 160) ?? "Waiting for activity",
        checkpoints: selected,
        blockers: uniqueBy(checkpoints.flatMap((checkpoint) => checkpoint.blockers), (item) => `${item.status}:${item.text}`),
        hypotheses: uniqueBy(checkpoints.flatMap((checkpoint) => checkpoint.hypotheses), (item) => `${item.status}:${item.text}`),
        decisions: uniqueBy(checkpoints.flatMap((checkpoint) => checkpoint.decisions), (item) => item.text),
        questions: uniqueBy(checkpoints.flatMap((checkpoint) => checkpoint.questions), (item) => item.text),
        files: entities.filter((entity) => entity.kind === "file"),
        commits: entities.filter((entity) => entity.kind === "commit"),
        entities,
        provenance: {
          checkpointIds: checkpoints.map((checkpoint) => checkpoint.id),
          rankingVersion: "hybrid-rrf-v1",
          degraded,
          maxCharacters
        },
        approximateCharacters: 0
      };
      for (let index = 0; index < 3; index += 1) {
        pack.approximateCharacters = JSON.stringify(pack).length;
      }
      return ContextPackV1Schema.parse(pack);
    };

    let pack = makePack(ranked);
    while (JSON.stringify(pack).length > maxCharacters && ranked.length > 1) {
      ranked = ranked.slice(1);
      pack = makePack(ranked);
    }
    if (JSON.stringify(pack).length > maxCharacters && ranked.length === 1) {
      ranked = ranked.map((entry) => ({ ...entry, checkpoint: compactCheckpoint(entry.checkpoint), reasons: [...entry.reasons, "bounded"] }));
      pack = makePack(ranked, true);
    }
    if (JSON.stringify(pack).length > maxCharacters) {
      ranked = [];
      pack = makePack([], true);
    }
    if (JSON.stringify(pack).length > maxCharacters) {
      pack = ContextPackV1Schema.parse({
        ...pack,
        currentGoal: pack.currentGoal.slice(0, 80),
        currentFocus: pack.currentFocus.slice(0, 80),
        approximateCharacters: 0
      });
      for (let index = 0; index < 3; index += 1) {
        pack.approximateCharacters = JSON.stringify(pack).length;
      }
    }
    return pack;
  }

  diff(input: { projectId?: string; sinceCheckpointId?: string } = {}): ContextDiffV1 {
    const projectId = input.projectId ?? this.database.latestProjectId(this.queryOptions) ?? "demo";
    const baselineId = input.sinceCheckpointId ?? this.database.baseline(projectId);
    const baseline = baselineId
      ? this.database.requireCheckpointForProject(projectId, baselineId, this.queryOptions)
      : undefined;
    const checkpoints = this.database.listCheckpoints(projectId, 100, baseline?.createdAt, undefined, this.queryOptions).reverse();
    const current = checkpoints.at(-1) ?? baseline ?? this.database.listCheckpoints(projectId, 1, undefined, undefined, this.queryOptions)[0];

    type Blocker = CheckpointV1["blockers"][number];
    type Hypothesis = CheckpointV1["hypotheses"][number];
    type State<T> = { item: T; checkpoint: CheckpointV1 };
    const baselineBlockers = new Map<string, State<Blocker>>();
    const currentBlockers = new Map<string, State<Blocker>>();
    const baselineHypotheses = new Map<string, State<Hypothesis>>();
    const currentHypotheses = new Map<string, State<Hypothesis>>();

    if (baseline) {
      for (const item of baseline.blockers) {
        const key = stateKey(baseline, item, "blocker");
        const state = { item, checkpoint: baseline };
        baselineBlockers.set(key, state);
        currentBlockers.set(key, state);
      }
      for (const item of baseline.hypotheses) {
        const key = stateKey(baseline, item, "concept");
        const state = { item, checkpoint: baseline };
        baselineHypotheses.set(key, state);
        currentHypotheses.set(key, state);
      }
    }
    for (const checkpoint of checkpoints) {
      for (const item of checkpoint.blockers) currentBlockers.set(stateKey(checkpoint, item, "blocker"), { item, checkpoint });
      for (const item of checkpoint.hypotheses) currentHypotheses.set(stateKey(checkpoint, item, "concept"), { item, checkpoint });
    }

    const addedBlockerStates = [...currentBlockers.entries()].flatMap(([key, state]) =>
      state.item.status === "open" && baselineBlockers.get(key)?.item.status !== "open" ? [state] : []
    );
    const resolvedBlockerStates = [...currentBlockers.entries()].flatMap(([key, state]) =>
      state.item.status === "resolved" && baselineBlockers.get(key)?.item.status === "open" ? [state] : []
    );
    const changedHypothesisStates = [...currentHypotheses.entries()].flatMap(([key, state]) => {
      const prior = baselineHypotheses.get(key)?.item;
      return (prior && prior.status !== state.item.status) || (!prior && state.item.status !== "active") ? [state] : [];
    });
    const addedBlockers = addedBlockerStates.map((state) => state.item);
    const resolvedBlockers = resolvedBlockerStates.map((state) => state.item);
    const changedHypotheses = changedHypothesisStates.map((state) => state.item);
    const newDecisions = uniqueBy(checkpoints.flatMap((checkpoint) => checkpoint.decisions), (item) => item.text);
    const allEntities = uniqueBy(checkpoints.flatMap((checkpoint) => checkpoint.entities), (entity) => `${entity.kind}:${entity.key}`);
    const newFiles = allEntities.filter((entity) => entity.kind === "file");
    const newCommits = allEntities.filter((entity) => entity.kind === "commit");
    const changes: ContextChange[] = [];

    for (const state of addedBlockerStates) changes.push({ type: "blocker_added", text: state.item.text, checkpointIds: [state.checkpoint.id] });
    for (const state of resolvedBlockerStates) changes.push({ type: "blocker_resolved", text: state.item.text, checkpointIds: [state.checkpoint.id] });
    for (const state of changedHypothesisStates) changes.push({ type: "hypothesis_changed", text: `${state.item.status}: ${state.item.text}`, checkpointIds: [state.checkpoint.id] });
    for (const decision of newDecisions) changes.push({ type: "decision_added", text: decision.text, checkpointIds: this.checkpointIdsFor(checkpoints, decision.eventIds) });
    for (const file of newFiles) changes.push({ type: "file_changed", text: file.label, checkpointIds: checkpoints.filter((checkpoint) => checkpoint.entities.some((entity) => entity.kind === "file" && entity.key === file.key)).map((checkpoint) => checkpoint.id) });
    for (const commit of newCommits) changes.push({ type: "commit_added", text: commit.label, checkpointIds: checkpoints.filter((checkpoint) => checkpoint.entities.some((entity) => entity.kind === "commit" && entity.key === commit.key)).map((checkpoint) => checkpoint.id) });

    return ContextDiffV1Schema.parse({
      version: "1",
      projectId,
      baselineCheckpointId: baseline?.id ?? null,
      currentCheckpointId: current?.id ?? null,
      generatedAt: new Date().toISOString(),
      changes,
      addedBlockers,
      resolvedBlockers,
      changedHypotheses,
      newDecisions,
      newFiles,
      newCommits,
      newEntities: allEntities
    });
  }

  private checkpointIdsFor(checkpoints: CheckpointV1[], eventIds: string[]): string[] {
    const ids = checkpoints.filter((checkpoint) => checkpoint.eventIds.some((eventId) => eventIds.includes(eventId))).map((checkpoint) => checkpoint.id);
    return ids.length > 0 ? ids : checkpoints.at(-1) ? [checkpoints.at(-1)!.id] : ["unknown"];
  }
}
