import { z } from "zod";

export const EventSourceSchema = z.enum(["vscode", "terminal", "git", "chrome", "os", "demo"]);
export const LiveEventSourceSchema = z.enum(["vscode", "terminal", "git", "chrome", "os"]);
export const PrivacyClassificationSchema = z.enum(["public", "personal", "confidential", "secret"]);
export const RelevanceDecisionSchema = z.enum(["keep", "drop", "uncertain"]);
export const SyncEligibilitySchema = z.enum(["local_only", "cloud_eligible"]);

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

export const NormalizedEventV2Schema = z.object({
  version: z.literal("2"),
  id: z.string().uuid(),
  deviceId: z.string().min(8).max(128),
  occurredAt: z.string().datetime({ offset: true }),
  hlc: z.string().regex(/^\d{10,20}:[0-9]{1,10}:[A-Za-z0-9._:-]{1,128}$/),
  source: LiveEventSourceSchema,
  eventType: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/),
  projectId: z.string().uuid().optional(),
  projectLocator: z.object({
    localAlias: z.string().max(256).optional(),
    repositoryFingerprint: z.string().regex(/^[a-f0-9]{16,128}$/).optional()
  }).strict().optional(),
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
  dedupeKey: z.string().max(512).optional(),
  policyVersion: z.number().int().positive(),
  syncEligibility: SyncEligibilitySchema
}).strict();

export const NormalizedEventSchema = z.union([NormalizedEventV2Schema, NormalizedEventV1Schema]);

export const EventsBatchSchema = z.object({
  events: z.array(NormalizedEventSchema).min(1).max(100)
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
  // Optional only for decoding pre-live-platform checkpoints during migration.
  // Every newly generated checkpoint includes its originating device UUID.
  deviceId: z.string().uuid().optional(),
  windowId: z.string().min(8),
  eventIds: z.array(z.string().min(8)).min(1),
  provider: z.enum(["deterministic", "apple", "ollama", "openai"]),
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
    deviceIds: z.array(z.string().uuid()).default([]),
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
  deviceIds: z.array(z.string().uuid()).default([]),
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
  activeCheckpointProvider: z.enum(["apple", "ollama", "openai"]).default("ollama"),
  activeChatProvider: z.enum(["apple", "ollama", "openai"]).default("ollama"),
  appleModel: z.literal("apple-system-default").default("apple-system-default"),
  ollamaModel: z.string().min(1).default("gemma3n:e2b"),
  openaiModel: z.string().min(1).default("gpt-5.6-terra")
});

export const ActiveProjectLeaseV1Schema = z.object({
  version: z.literal("1"),
  projectId: z.string().uuid(),
  projectName: z.string().min(1).max(256),
  source: z.enum(["vscode", "terminal", "git", "folder", "manual"]),
  confidence: z.number().min(0).max(1),
  deviceId: z.string().min(8).max(128),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true })
}).strict();

export const PrivacyPolicyV1Schema = z.object({
  version: z.literal("1"),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime({ offset: true }),
  sources: z.object({
    osApps: z.boolean(),
    osWindows: z.boolean(),
    approvedFolders: z.boolean(),
    vscode: z.boolean(),
    terminal: z.boolean(),
    git: z.boolean(),
    chrome: z.boolean()
  }).strict(),
  metadata: z.object({
    relativeFilePaths: z.boolean(),
    urlHosts: z.boolean(),
    urlPaths: z.boolean(),
    commandNames: z.boolean(),
    commandFlagNames: z.boolean(),
    personalMetadata: z.boolean(),
    confidentialLocalCollection: z.boolean(),
    personalCloudEligibility: z.boolean()
  }).strict(),
  retentionHours: z.number().int().min(1).max(24),
  allowedDomains: z.array(z.string().min(1).max(253)).max(256),
  ignoredDomains: z.array(z.string().min(1).max(253)).max(256),
  ignoredPathPatterns: z.array(z.string().min(1).max(256)).max(256),
  immutableProtections: z.object({
    secretDetection: z.literal(true),
    attributeAllowlist: z.literal(true),
    prohibitedContentExclusion: z.literal(true),
    confidentialCloudBlock: z.literal(true)
  }).strict()
}).strict();

export const GraphNodeKindSchema = z.enum([
  "project", "task", "checkpoint", "file", "commit", "url", "error", "blocker", "decision", "concept"
]);

export const GraphNodeV1Schema = z.object({
  id: z.string().min(3).max(768),
  kind: GraphNodeKindSchema,
  label: z.string().min(1).max(256),
  projectId: z.string().max(512).optional(),
  subtitle: z.string().max(512).optional(),
  status: z.string().max(64).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  checkpointIds: z.array(z.string()).max(64),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({})
}).strict();

export const GraphEdgeV1Schema = z.object({
  id: z.string().min(3).max(768),
  source: z.string().min(3).max(768),
  target: z.string().min(3).max(768),
  kind: z.string().min(1).max(96),
  checkpointIds: z.array(z.string()).max(64)
}).strict();

export const GraphSnapshotV1Schema = z.object({
  version: z.literal("1"),
  projectId: z.string(),
  generatedAt: z.string().datetime({ offset: true }),
  nodes: z.array(GraphNodeV1Schema).max(500),
  edges: z.array(GraphEdgeV1Schema).max(1000),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
  degraded: z.boolean().default(false)
}).strict();

export const GraphQueryV1Schema = z.object({
  projectId: z.string().optional(),
  query: z.string().max(256).optional(),
  kinds: z.array(GraphNodeKindSchema).max(16).optional(),
  edgeKinds: z.array(z.string().max(96)).max(32).optional(),
  aroundNodeId: z.string().max(768).optional(),
  hops: z.number().int().min(0).max(2).default(1),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.number().int().min(1).max(500).default(250)
}).strict();

/**
 * Exact response envelopes shared by the local stdio and remote HTTP MCP
 * transports.  Transport adapters validate and bound data with these helpers
 * before handing it to the MCP SDK, so a data source cannot accidentally leak
 * an ad-hoc projection or an unbounded row.
 */
export const McpContextPackV1Schema = ContextPackV1Schema.strict();

export const McpTimelinePageV1Schema = z.object({
  version: z.literal("1"),
  projectId: z.string(),
  checkpoints: z.array(CheckpointV1Schema).max(50),
  nextCursor: z.string().nullable(),
  truncated: z.boolean()
}).strict();

export const McpContextDiffV1Schema = ContextDiffV1Schema.extend({
  truncated: z.boolean().optional()
}).strict();

export const ContinuumMcpToolNameSchema = z.enum(["current", "timeline", "search", "resume", "diff", "graph"]);

export const McpCurrentInputSchema = z.object({
  projectId: z.string().max(512).optional()
}).strict();

export const McpTimelineInputSchema = z.object({
  projectId: z.string().max(512).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(50).default(20)
}).strict();

export const McpSearchInputSchema = z.object({
  query: z.string().min(1).max(1_000),
  projectId: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(12).default(8)
}).strict();

export const McpResumeInputSchema = z.object({
  projectId: z.string().max(512).optional(),
  maxChars: z.number().int().min(1_000).max(12_000).default(12_000)
}).strict();

export const McpDiffInputSchema = z.object({
  projectId: z.string().max(512).optional(),
  sinceCheckpointId: z.string().max(512).optional(),
  maxChars: z.number().int().min(1_000).max(12_000).default(12_000)
}).strict();

function serializedCharacters(value: unknown): number {
  return JSON.stringify(value).length;
}

function updatePackSize(pack: z.infer<typeof McpContextPackV1Schema>): void {
  // Updating the decimal character count can itself change the serialized
  // length.  A handful of iterations reaches the stable value.
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const length = serializedCharacters(pack);
    if (pack.approximateCharacters === length) return;
    pack.approximateCharacters = length;
  }
}

function compactCheckpointForPack(checkpoint: z.infer<typeof CheckpointV1Schema>): z.infer<typeof CheckpointV1Schema> {
  const compactEvidence = <T extends { text: string; eventIds: string[] }>(items: T[], limit: number): T[] =>
    items.slice(-limit).map((item) => ({ ...item, text: item.text.slice(0, 160), eventIds: item.eventIds.slice(0, 2) }));
  return CheckpointV1Schema.parse({
    ...checkpoint,
    eventIds: checkpoint.eventIds.slice(0, 4),
    goal: checkpoint.goal.slice(0, 180),
    focus: checkpoint.focus.slice(0, 180),
    summary: checkpoint.summary.slice(0, 360),
    progress: compactEvidence(checkpoint.progress, 2),
    blockers: compactEvidence(checkpoint.blockers, 3),
    hypotheses: compactEvidence(checkpoint.hypotheses, 3),
    decisions: compactEvidence(checkpoint.decisions, 2),
    questions: compactEvidence(checkpoint.questions, 2),
    entities: checkpoint.entities.slice(0, 8).map((entity) => ({
      ...entity,
      key: entity.key.slice(0, 200),
      label: entity.label.slice(0, 140),
      eventIds: entity.eventIds.slice(0, 2)
    }))
  });
}

export function boundedContextPackV1(
  value: unknown,
  maxCharacters = 12_000
): z.infer<typeof McpContextPackV1Schema> {
  const limit = Math.max(1_000, Math.min(12_000, Math.floor(maxCharacters)));
  const pack = structuredClone(McpContextPackV1Schema.parse(value));
  pack.provenance.maxCharacters = limit;

  const synchronizeProvenance = () => {
    pack.provenance.checkpointIds = pack.checkpoints.map(({ checkpoint }) => checkpoint.id);
    pack.provenance.deviceIds = [...new Set(pack.checkpoints.flatMap(({ checkpoint }) => checkpoint.deviceId ? [checkpoint.deviceId] : []))];
    updatePackSize(pack);
  };
  synchronizeProvenance();

  const secondaryArrays: Array<Array<unknown>> = [
    pack.entities,
    pack.files,
    pack.commits,
    pack.questions,
    pack.decisions,
    pack.hypotheses,
    pack.blockers
  ];
  if (pack.checkpoints.length === 0) {
    // Aggregate facts have no direct checkpoint IDs of their own. Never emit
    // them without at least one returned checkpoint that can ground them.
    for (const items of secondaryArrays) items.splice(0);
  }
  let compactedLastCheckpoint = false;
  while (serializedCharacters(pack) > limit) {
    // These arrays duplicate facts present in the ranked checkpoints. Trim
    // them before touching the directly cited checkpoint records.
    const largest = secondaryArrays
      .filter((items) => items.length > 0)
      .sort((left, right) => serializedCharacters(right) - serializedCharacters(left))[0];
    if (largest) {
      largest.pop();
      updatePackSize(pack);
      continue;
    }
    if (pack.checkpoints.length > 1) {
      // Context packs are chronological; discard the oldest selected
      // checkpoint first and preserve the latest state as long as possible.
      pack.checkpoints.shift();
      synchronizeProvenance();
      continue;
    }
    if (pack.checkpoints.length === 1 && !compactedLastCheckpoint) {
      const ranked = pack.checkpoints[0]!;
      ranked.checkpoint = compactCheckpointForPack(ranked.checkpoint);
      ranked.reasons = [...new Set([...ranked.reasons, "bounded"])];
      compactedLastCheckpoint = true;
      synchronizeProvenance();
      continue;
    }
    if (pack.currentGoal.length > 0 || pack.currentFocus.length > 0) {
      pack.currentGoal = pack.currentGoal.slice(0, Math.floor(pack.currentGoal.length / 2));
      pack.currentFocus = pack.currentFocus.slice(0, Math.floor(pack.currentFocus.length / 2));
      updatePackSize(pack);
      continue;
    }
    if (pack.checkpoints.length === 1) {
      pack.checkpoints = [];
      synchronizeProvenance();
      continue;
    }
    break;
  }
  synchronizeProvenance();
  if (pack.checkpoints.length === 0) {
    for (const items of secondaryArrays) items.splice(0);
    updatePackSize(pack);
  }
  const hasAggregateFacts = secondaryArrays.some((items) => items.length > 0);
  if (hasAggregateFacts && (pack.checkpoints.length === 0 || pack.provenance.checkpointIds.length === 0)) {
    throw new Error("ContextPackV1 aggregate facts require returned checkpoint provenance");
  }
  if (serializedCharacters(pack) > limit) {
    throw new Error("ContextPackV1 cannot fit within the requested character limit");
  }
  return McpContextPackV1Schema.parse(pack);
}

export function boundedTimelinePageV1(
  value: unknown,
  maxCharacters = 12_000
): z.infer<typeof McpTimelinePageV1Schema> {
  const limit = Math.max(1_000, Math.min(12_000, Math.floor(maxCharacters)));
  const page = structuredClone(McpTimelinePageV1Schema.parse(value));
  const terminalCursor = page.checkpoints.at(-1)?.id ?? page.nextCursor;
  while (serializedCharacters(page) > limit && page.checkpoints.length > 0) {
    page.checkpoints.pop();
    page.nextCursor = page.checkpoints.at(-1)?.id ?? terminalCursor;
    page.truncated = true;
  }
  if (serializedCharacters(page) > limit) {
    throw new Error("Checkpoint timeline cannot fit within the requested character limit");
  }
  return McpTimelinePageV1Schema.parse(page);
}

export function boundedContextDiffV1(
  value: unknown,
  maxCharacters = 12_000
): z.infer<typeof McpContextDiffV1Schema> {
  const limit = Math.max(1_000, Math.min(12_000, Math.floor(maxCharacters)));
  const diff = structuredClone(McpContextDiffV1Schema.parse(value));
  const supports = (types: z.infer<typeof ContextChangeSchema>["type"][], label: string) =>
    diff.changes.some((change) => types.includes(change.type) && (
      change.text === label || change.text.endsWith(`: ${label}`)
    ));
  const retainCited = <T>(items: T[], supported: (item: T) => boolean): T[] => items.filter(supported);
  const beforeCitationFilter = serializedCharacters(diff);
  diff.addedBlockers = retainCited(diff.addedBlockers, (item) => supports(["blocker_added"], item.text));
  diff.resolvedBlockers = retainCited(diff.resolvedBlockers, (item) => supports(["blocker_resolved"], item.text));
  diff.changedHypotheses = retainCited(diff.changedHypotheses, (item) => supports(["hypothesis_changed"], item.text));
  diff.newDecisions = retainCited(diff.newDecisions, (item) => supports(["decision_added"], item.text));
  diff.newFiles = retainCited(diff.newFiles, (item) => supports(["file_changed"], item.label) || supports(["file_changed"], item.key));
  diff.newCommits = retainCited(diff.newCommits, (item) => supports(["commit_added"], item.label) || supports(["commit_added"], item.key));
  diff.newEntities = retainCited(diff.newEntities, (item) => {
    const types = item.kind === "file" ? ["file_changed"] as const
      : item.kind === "commit" ? ["commit_added"] as const
        : ["entity_added"] as const;
    return supports([...types], item.label) || supports([...types], item.key);
  });
  if (serializedCharacters(diff) !== beforeCitationFilter) diff.truncated = true;
  if (serializedCharacters(diff) > limit && diff.briefing) {
    delete diff.briefing;
    diff.truncated = true;
  }
  const aggregateArrays: Array<Array<unknown>> = [
    diff.newEntities,
    diff.newFiles,
    diff.newCommits,
    diff.newDecisions,
    diff.changedHypotheses,
    diff.addedBlockers,
    diff.resolvedBlockers
  ];
  while (serializedCharacters(diff) > limit) {
    // Aggregate facts carry event IDs, while `changes` carry the direct
    // checkpoint citations. Remove aggregates before their citations.
    const largest = aggregateArrays
      .filter((items) => items.length > 0)
      .sort((left, right) => serializedCharacters(right) - serializedCharacters(left))[0];
    if (largest) {
      largest.pop();
      diff.truncated = true;
      continue;
    }
    if (diff.deviceIds.length > 0) {
      diff.deviceIds.pop();
      diff.truncated = true;
      continue;
    }
    if (diff.changes.length > 0) {
      diff.changes.pop();
      diff.truncated = true;
      continue;
    }
    break;
  }
  if (serializedCharacters(diff) > limit) {
    throw new Error("ContextDiffV1 cannot fit within the requested character limit");
  }
  return McpContextDiffV1Schema.parse(diff);
}

function graphRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("graph snapshot failed response validation");
  }
  return value as Record<string, unknown>;
}

/** Strip transport/projection-only fields before strict shared validation. */
export function normalizeGraphSnapshotV1(value: unknown): z.infer<typeof GraphSnapshotV1Schema> {
  const raw = graphRecord(value);
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  const capped = rawNodes.length > 500 || rawEdges.length > 1_000;
  const nodes = rawNodes.slice(0, 500).map((item) => {
    const node = graphRecord(item);
    return {
      id: node.id,
      kind: node.kind,
      label: node.label,
      ...(node.projectId !== undefined ? { projectId: node.projectId } : {}),
      ...(node.subtitle !== undefined ? { subtitle: node.subtitle } : {}),
      ...(node.status !== undefined ? { status: node.status } : {}),
      ...(node.importance !== undefined ? { importance: node.importance } : {}),
      ...(node.confidence !== undefined ? { confidence: node.confidence } : {}),
      checkpointIds: node.checkpointIds,
      metadata: node.metadata
    };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = rawEdges.map((item) => {
    const edge = graphRecord(item);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      kind: edge.kind ?? edge.relation,
      checkpointIds: edge.checkpointIds
    };
  }).filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)).slice(0, 1_000);
  return GraphSnapshotV1Schema.parse({
    version: raw.version,
    projectId: raw.projectId,
    generatedAt: raw.generatedAt,
    nodes,
    edges,
    nextCursor: raw.nextCursor ?? raw.cursor ?? null,
    truncated: Boolean(raw.truncated) || capped,
    degraded: Boolean(raw.degraded)
  });
}

export function boundedGraphSnapshotV1(
  value: unknown,
  maxCharacters = 12_000
): z.infer<typeof GraphSnapshotV1Schema> {
  const limit = Math.max(1_000, Math.floor(maxCharacters));
  const graph = structuredClone(normalizeGraphSnapshotV1(value));
  while (serializedCharacters(graph) > limit && graph.edges.length > 0) {
    graph.edges.pop();
    graph.truncated = true;
  }
  while (serializedCharacters(graph) > limit && graph.nodes.length > 0) {
    graph.nodes.pop();
    const retained = new Set(graph.nodes.map((node) => node.id));
    graph.edges = graph.edges.filter((edge) => retained.has(edge.source) && retained.has(edge.target));
    graph.truncated = true;
  }
  if (serializedCharacters(graph) > limit) {
    throw new Error("GraphSnapshotV1 cannot fit within the requested character limit");
  }
  return GraphSnapshotV1Schema.parse(graph);
}

export function continuumMcpCompatibilityText(
  tool: z.infer<typeof ContinuumMcpToolNameSchema>,
  data: unknown
): string {
  return `Continuum ${tool} result. Hypotheses are unverified and must not be treated as facts.\n${JSON.stringify(data)}`;
}

export function continuumMcpToolResult(
  tool: z.infer<typeof ContinuumMcpToolNameSchema>,
  data: unknown
) {
  return {
    content: [{ type: "text" as const, text: continuumMcpCompatibilityText(tool, data) }],
    structuredContent: { data }
  };
}

type MaybePromise<T> = T | Promise<T>;

export interface ContinuumMcpHandlerSource {
  current(input: z.infer<typeof McpCurrentInputSchema> & { maxChars: number }): MaybePromise<unknown>;
  timeline(input: z.infer<typeof McpTimelineInputSchema> & { maxChars: number }): MaybePromise<unknown>;
  search(input: z.infer<typeof McpSearchInputSchema> & { maxChars: number }): MaybePromise<unknown>;
  resume(input: z.infer<typeof McpResumeInputSchema>): MaybePromise<unknown>;
  diff(input: z.infer<typeof McpDiffInputSchema>): MaybePromise<unknown>;
  graph(input: z.infer<typeof GraphQueryV1Schema>): MaybePromise<unknown>;
}

/**
 * Transport-independent MCP handlers. Stdio and Streamable HTTP provide only
 * tenant/storage adapters; validation, caps, and compatibility output stay
 * identical here.
 */
export function createContinuumMcpHandlers(source: ContinuumMcpHandlerSource) {
  return {
    current: async (input: z.input<typeof McpCurrentInputSchema>) => {
      const parsed = McpCurrentInputSchema.parse(input);
      const maxChars = 8_000;
      return continuumMcpToolResult("current", boundedContextPackV1(await source.current({ ...parsed, maxChars }), maxChars));
    },
    timeline: async (input: z.input<typeof McpTimelineInputSchema>) => {
      const parsed = McpTimelineInputSchema.parse(input);
      const maxChars = 12_000;
      return continuumMcpToolResult("timeline", boundedTimelinePageV1(await source.timeline({ ...parsed, maxChars }), maxChars));
    },
    search: async (input: z.input<typeof McpSearchInputSchema>) => {
      const parsed = McpSearchInputSchema.parse(input);
      const maxChars = Math.min(12_000, Math.max(3_000, parsed.limit * 1_000));
      return continuumMcpToolResult("search", boundedContextPackV1(await source.search({ ...parsed, maxChars }), maxChars));
    },
    resume: async (input: z.input<typeof McpResumeInputSchema>) => {
      const parsed = McpResumeInputSchema.parse(input);
      return continuumMcpToolResult("resume", boundedContextPackV1(await source.resume(parsed), parsed.maxChars));
    },
    diff: async (input: z.input<typeof McpDiffInputSchema>) => {
      const parsed = McpDiffInputSchema.parse(input);
      return continuumMcpToolResult("diff", boundedContextDiffV1(await source.diff(parsed), parsed.maxChars));
    },
    graph: async (input: z.input<typeof GraphQueryV1Schema>) => {
      const parsed = GraphQueryV1Schema.parse(input);
      return continuumMcpToolResult("graph", boundedGraphSnapshotV1(await source.graph(parsed), 12_000));
    }
  };
}

export const ChatRoleSchema = z.enum(["user", "assistant", "system"]);
export const ChatCitationV1Schema = z.object({
  kind: z.enum(["checkpoint", "file", "commit", "blocker", "decision", "entity"]),
  id: z.string().min(1),
  label: z.string().min(1).max(256),
  checkpointIds: z.array(z.string()).min(1).max(12)
}).strict();

export const ChatSessionV1Schema = z.object({
  version: z.literal("1"),
  id: z.string().uuid(),
  projectId: z.string(),
  title: z.string().min(1).max(160),
  classification: PrivacyClassificationSchema.exclude(["secret"]).default("personal"),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  syncEligibility: SyncEligibilitySchema
}).strict();

export const ChatMessageV1Schema = z.object({
  version: z.literal("1"),
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  role: ChatRoleSchema,
  text: z.string().min(1).max(12_000),
  citations: z.array(ChatCitationV1Schema).max(24).default([]),
  unverifiedHypotheses: z.array(z.string().max(400)).max(12).default([]),
  provider: z.enum(["apple", "ollama", "openai", "continuum"]),
  model: z.string().min(1).max(128),
  createdAt: z.string().datetime({ offset: true }),
  syncEligibility: SyncEligibilitySchema
}).strict();

export const ContextActionV1Schema = z.object({
  version: z.literal("1"),
  id: z.string().uuid(),
  name: z.enum(["search_context", "get_diff", "select_project", "create_checkpoint", "ack_baseline"]),
  arguments: z.record(z.string(), z.unknown()),
  mutating: z.boolean(),
  status: z.enum(["proposed", "confirmed", "completed", "rejected", "failed"]),
  result: z.unknown().optional()
}).strict();

export const ProjectSyncPayloadV1Schema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).max(256),
  normalizedName: z.string().min(1).max(256).optional(),
  repositoryFingerprint: z.string().regex(/^[a-f0-9]{16,128}$/).optional(),
  redirectFrom: z.string().uuid().optional(),
  redirectTo: z.string().uuid().optional()
}).strict().superRefine((project, context) => {
  const hasFrom = project.redirectFrom !== undefined;
  const hasTo = project.redirectTo !== undefined;
  if (hasFrom !== hasTo) {
    context.addIssue({ code: "custom", path: [hasFrom ? "redirectTo" : "redirectFrom"], message: "project redirects require both endpoints" });
    return;
  }
  if (!hasFrom || !hasTo) return;
  if (project.id !== project.redirectFrom) {
    context.addIssue({ code: "custom", path: ["id"], message: "redirecting project ID must match redirectFrom" });
  }
  if (project.redirectFrom === project.redirectTo) {
    context.addIssue({ code: "custom", path: ["redirectTo"], message: "project redirect cannot target itself" });
  }
});

export const ChatRunEventV1Schema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run_started"), runId: z.string().uuid(), sessionId: z.string().uuid() }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("citation"), citation: ChatCitationV1Schema }),
  z.object({ type: z.literal("action_proposed"), action: ContextActionV1Schema }),
  z.object({ type: z.literal("action_result"), action: ContextActionV1Schema }),
  z.object({ type: z.literal("done"), message: ChatMessageV1Schema }),
  z.object({ type: z.literal("cancelled"), runId: z.string().uuid() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() })
]);

export const SyncOperationV1Schema = z.object({
  version: z.literal("1"),
  id: z.string().uuid(),
  deviceId: z.string().min(8).max(128),
  sequence: z.number().int().nonnegative(),
  hlc: z.string().regex(/^\d{10,20}:[0-9]{1,10}:[A-Za-z0-9._:-]{1,128}$/),
  entityType: z.enum(["project", "event", "checkpoint", "graph_node", "graph_edge", "baseline", "privacy_policy", "settings", "device", "chat_session", "chat_message"]),
  entityId: z.string().min(1).max(768),
  payload: z.unknown().optional(),
  tombstone: z.boolean().default(false),
  occurredAt: z.string().datetime({ offset: true })
}).strict();

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
    apple: z.enum(["available", "unavailable", "unknown"]),
    ollama: z.enum(["available", "unavailable", "unknown"]),
    openai: z.enum(["available", "unavailable", "unknown"])
  })
});

export type NormalizedEventV1 = z.infer<typeof NormalizedEventV1Schema>;
export type NormalizedEventV2 = z.infer<typeof NormalizedEventV2Schema>;
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;
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
export type ActiveProjectLeaseV1 = z.infer<typeof ActiveProjectLeaseV1Schema>;
export type PrivacyPolicyV1 = z.infer<typeof PrivacyPolicyV1Schema>;
export type GraphNodeV1 = z.infer<typeof GraphNodeV1Schema>;
export type GraphEdgeV1 = z.infer<typeof GraphEdgeV1Schema>;
export type GraphSnapshotV1 = z.infer<typeof GraphSnapshotV1Schema>;
export type GraphQueryV1 = z.infer<typeof GraphQueryV1Schema>;
export type McpTimelinePageV1 = z.infer<typeof McpTimelinePageV1Schema>;
export type McpContextDiffV1 = z.infer<typeof McpContextDiffV1Schema>;
export type McpCurrentInput = z.infer<typeof McpCurrentInputSchema>;
export type McpTimelineInput = z.infer<typeof McpTimelineInputSchema>;
export type McpSearchInput = z.infer<typeof McpSearchInputSchema>;
export type McpResumeInput = z.infer<typeof McpResumeInputSchema>;
export type McpDiffInput = z.infer<typeof McpDiffInputSchema>;
export type ChatCitationV1 = z.infer<typeof ChatCitationV1Schema>;
export type ChatSessionV1 = z.infer<typeof ChatSessionV1Schema>;
export type ChatMessageV1 = z.infer<typeof ChatMessageV1Schema>;
export type ContextActionV1 = z.infer<typeof ContextActionV1Schema>;
export type ChatRunEventV1 = z.infer<typeof ChatRunEventV1Schema>;
export type SyncOperationV1 = z.infer<typeof SyncOperationV1Schema>;
export type ProjectSyncPayloadV1 = z.infer<typeof ProjectSyncPayloadV1Schema>;
