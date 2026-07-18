import { z } from "zod";

export const EventSourceSchema = z.enum(["vscode", "terminal", "git", "chrome", "demo"]);
export const PrivacyClassificationSchema = z.enum(["public", "personal", "confidential", "secret"]);
export const RelevanceDecisionSchema = z.enum(["keep", "drop", "uncertain"]);

export const NormalizedEventV1Schema = z.object({
  version: z.literal("1"),
  id: z.string().uuid(),
  occurredAt: z.string().datetime({ offset: true }),
  source: EventSourceSchema,
  eventType: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/),
  projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/).optional(),
  title: z.string().max(256),
  attributes: z.record(z.string(), z.unknown()).default({}),
  privacy: z.object({
    classification: PrivacyClassificationSchema,
    rules: z.array(z.string().max(96)).max(32).default([])
  }),
  relevance: z.object({
    decision: RelevanceDecisionSchema,
    reason: z.string().max(256)
  }),
  confidence: z.number().min(0).max(1),
  dedupeKey: z.string().max(512).optional()
}).strict();

export const EventsBatchSchema = z.object({
  events: z.array(NormalizedEventV1Schema).min(1).max(100)
});

export const EvidenceItemSchema = z.object({
  text: z.string().min(1).max(400),
  eventIds: z.array(z.string().min(8)).min(1).max(8)
});

export const BlockerItemSchema = EvidenceItemSchema.extend({
  status: z.enum(["open", "resolved"])
});

export const HypothesisItemSchema = EvidenceItemSchema.extend({
  status: z.enum(["active", "supported", "disproven"])
});

export const EntitySchema = z.object({
  kind: z.enum(["project", "task", "file", "commit", "url", "error", "person", "concept", "decision", "blocker"]),
  key: z.string().min(1).max(512),
  label: z.string().min(1).max(256),
  eventIds: z.array(z.string().uuid()).min(1).max(8)
});

export const CheckpointDraftSchema = z.object({
  goal: z.string().min(1).max(400),
  focus: z.string().min(1).max(400),
  summary: z.string().min(1).max(1200),
  progress: z.array(EvidenceItemSchema).max(12),
  blockers: z.array(BlockerItemSchema).max(12),
  hypotheses: z.array(HypothesisItemSchema).max(12),
  decisions: z.array(EvidenceItemSchema).max(12),
  questions: z.array(EvidenceItemSchema).max(12),
  entities: z.array(EntitySchema).max(32),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1)
}).strict();

export const CheckpointV1Schema = CheckpointDraftSchema.extend({
  version: z.literal("1"),
  id: z.string().min(8),
  projectId: z.string().min(1),
  windowId: z.string().min(8),
  eventIds: z.array(z.string().min(8)).min(1),
  provider: z.enum(["deterministic", "ollama", "openai"]),
  model: z.string().min(1),
  createdAt: z.string().datetime({ offset: true })
});

export const RankedCheckpointSchema = z.object({
  checkpoint: CheckpointV1Schema,
  score: z.number(),
  reasons: z.array(z.string())
});

export const ContextPackV1Schema = z.object({
  version: z.literal("1"),
  projectId: z.string(),
  generatedAt: z.string().datetime({ offset: true }),
  currentGoal: z.string(),
  currentFocus: z.string(),
  checkpoints: z.array(RankedCheckpointSchema).max(12),
  blockers: z.array(BlockerItemSchema),
  hypotheses: z.array(HypothesisItemSchema),
  decisions: z.array(EvidenceItemSchema),
  questions: z.array(EvidenceItemSchema),
  files: z.array(EntitySchema),
  commits: z.array(EntitySchema),
  entities: z.array(EntitySchema),
  provenance: z.object({
    checkpointIds: z.array(z.string()),
    rankingVersion: z.string(),
    degraded: z.boolean(),
    maxCharacters: z.number().int().positive()
  }),
  approximateCharacters: z.number().int().nonnegative()
});

export const ContextChangeSchema = z.object({
  type: z.enum(["blocker_added", "blocker_resolved", "hypothesis_changed", "decision_added", "file_changed", "commit_added", "entity_added"]),
  text: z.string(),
  checkpointIds: z.array(z.string()).min(1)
});

export const ContextDiffV1Schema = z.object({
  version: z.literal("1"),
  projectId: z.string(),
  baselineCheckpointId: z.string().nullable(),
  currentCheckpointId: z.string().nullable(),
  generatedAt: z.string().datetime({ offset: true }),
  changes: z.array(ContextChangeSchema),
  addedBlockers: z.array(BlockerItemSchema),
  resolvedBlockers: z.array(BlockerItemSchema),
  changedHypotheses: z.array(HypothesisItemSchema),
  newDecisions: z.array(EvidenceItemSchema),
  newFiles: z.array(EntitySchema),
  newCommits: z.array(EntitySchema),
  newEntities: z.array(EntitySchema),
  briefing: z.object({
    headline: z.string(),
    summary: z.string(),
    nextActions: z.array(z.string())
  }).optional()
});

export const ModelSettingsSchema = z.object({
  activeCheckpointProvider: z.enum(["ollama", "openai"]).default("ollama"),
  ollamaModel: z.string().min(1).default("gemma3n:e2b"),
  openaiModel: z.string().min(1).default("gpt-5.6-terra")
});

export const EngineStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  connected: z.boolean(),
  capturePaused: z.boolean(),
  projectId: z.string().nullable(),
  eventCount: z.number().int().nonnegative(),
  checkpointCount: z.number().int().nonnegative(),
  droppedSecretCount: z.number().int().nonnegative(),
  retrievalMode: z.enum(["hybrid", "fts_graph"]),
  settings: ModelSettingsSchema,
  providerHealth: z.object({
    ollama: z.enum(["available", "unavailable", "unknown"]),
    openai: z.enum(["available", "unavailable", "unknown"])
  })
});

export type NormalizedEventV1 = z.infer<typeof NormalizedEventV1Schema>;
export type EventsBatch = z.infer<typeof EventsBatchSchema>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type BlockerItem = z.infer<typeof BlockerItemSchema>;
export type HypothesisItem = z.infer<typeof HypothesisItemSchema>;
export type Entity = z.infer<typeof EntitySchema>;
export type CheckpointDraft = z.infer<typeof CheckpointDraftSchema>;
export type CheckpointV1 = z.infer<typeof CheckpointV1Schema>;
export type RankedCheckpoint = z.infer<typeof RankedCheckpointSchema>;
export type ContextPackV1 = z.infer<typeof ContextPackV1Schema>;
export type ContextDiffV1 = z.infer<typeof ContextDiffV1Schema>;
export type ContextChange = z.infer<typeof ContextChangeSchema>;
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;
export type EngineState = z.infer<typeof EngineStateSchema>;
