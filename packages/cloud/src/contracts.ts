import { z } from "zod";

export const HlcSchema = z.string().regex(/^\d{10,20}:[0-9]{1,10}:[A-Za-z0-9._:-]{1,128}$/);
export const EntityTypeSchema = z.enum([
  "event",
  "checkpoint",
  "baseline",
  "privacy_policy",
  "settings",
  "chat_session",
  "chat_message",
  "graph_node",
  "graph_edge",
  "project",
  "device"
]);

export const SyncOperationSchema = z.object({
  version: z.literal("1"),
  id: z.string().uuid(),
  deviceId: z.string().min(8).max(128),
  sequence: z.number().int().nonnegative(),
  hlc: HlcSchema,
  entityType: EntityTypeSchema,
  entityId: z.string().min(1).max(768),
  tombstone: z.boolean().default(false),
  payload: z.unknown().optional(),
  occurredAt: z.string().datetime({ offset: true })
}).strict().superRefine((operation, context) => {
  if (!operation.tombstone && operation.payload === undefined) {
    context.addIssue({ code: "custom", path: ["payload"], message: "payload is required unless this is a tombstone" });
  }
});

export const SyncPushSchema = z.object({
  deviceId: z.string().min(8).max(128),
  device: z.object({
    name: z.string().min(1).max(128),
    platform: z.string().min(1).max(64),
    capabilities: z.array(z.string().max(64)).max(32).default([])
  }).strict().optional(),
  operations: z.array(SyncOperationSchema).min(1).max(500)
}).strict();

export const SyncPullQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  deviceId: z.string().min(8).max(128)
});

export const GraphNodeKindSchema = z.enum([
  "project", "task", "checkpoint", "file", "commit", "url", "error", "blocker", "decision", "concept"
]);

export const GraphQuerySchema = z.object({
  projectId: z.string().max(512).optional(),
  query: z.string().max(256).optional(),
  kinds: z.array(GraphNodeKindSchema).max(16).optional(),
  edgeKinds: z.array(z.string().min(1).max(96)).max(32).optional(),
  nodeKinds: z.array(GraphNodeKindSchema).max(16).optional(),
  relations: z.array(z.string().min(1).max(96)).max(32).optional(),
  aroundNodeId: z.string().max(768).optional(),
  hops: z.number().int().min(0).max(2).default(1),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.number().int().min(1).max(500).default(250)
}).strict();

const GraphMetadataSchema = z.record(
  z.string().min(1).max(64),
  z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()])
).superRefine((metadata, context) => {
  if (Object.keys(metadata).length > 64) context.addIssue({ code: "custom", message: "graph metadata is limited to 64 entries" });
});

export const GraphNodeSchema = z.object({
  id: z.string().min(1).max(768),
  kind: GraphNodeKindSchema,
  label: z.string().min(1).max(256),
  projectId: z.string().max(512).optional(),
  status: z.string().max(64).optional(),
  checkpointIds: z.array(z.string().min(1).max(512)).max(64),
  metadata: GraphMetadataSchema
}).strict();

export const GraphEdgeSchema = z.object({
  id: z.string().min(1).max(768),
  source: z.string().min(1).max(768),
  target: z.string().min(1).max(768),
  kind: z.string().min(1).max(96),
  relation: z.string().min(1).max(96).optional(),
  checkpointIds: z.array(z.string().min(1).max(512)).max(64)
}).strict();

export const GraphSnapshotSchema = z.object({
  version: z.literal("1"),
  projectId: z.string().max(512),
  generatedAt: z.string().datetime({ offset: true }),
  nodes: z.array(GraphNodeSchema).max(500),
  edges: z.array(GraphEdgeSchema).max(1_000),
  nextCursor: z.string().regex(/^\d+$/).nullable(),
  cursor: z.string().regex(/^\d+$/).nullable().optional(),
  truncated: z.boolean(),
  degraded: z.boolean(),
  projection: z.object({
    status: z.enum(["ready", "degraded"]),
    message: z.string().max(512).optional()
  }).strict().optional()
}).strict();

export const GRAPH_MAX_SERIALIZED_CHARACTERS = 240_000;

export function boundedGraphSnapshot(value: unknown, maxChars = GRAPH_MAX_SERIALIZED_CHARACTERS): GraphSnapshot {
  const result = GraphSnapshotSchema.safeParse(value);
  if (!result.success) throw new Error("graph snapshot failed response validation");
  const snapshot = result.data;
  const copy = structuredClone(snapshot);
  const length = () => JSON.stringify(copy).length;
  while (copy.edges.length > 0 && length() > maxChars) {
    copy.edges.splice(Math.max(0, Math.floor(copy.edges.length * 0.75)));
    copy.truncated = true;
  }
  while (copy.nodes.length > 0 && length() > maxChars) {
    copy.nodes.splice(Math.max(0, Math.floor(copy.nodes.length * 0.75)));
    const ids = new Set(copy.nodes.map((node) => node.id));
    copy.edges = copy.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    copy.truncated = true;
  }
  if (length() > maxChars) {
    return GraphSnapshotSchema.parse({
      version: "1",
      projectId: copy.projectId,
      generatedAt: copy.generatedAt,
      nodes: [],
      edges: [],
      nextCursor: copy.nextCursor,
      ...(copy.cursor !== undefined ? { cursor: copy.cursor } : {}),
      truncated: true,
      degraded: true,
      projection: { status: "degraded", message: "Graph result exceeded the serialized response limit; narrow the query." }
    });
  }
  return copy;
}

export type EntityType = z.infer<typeof EntityTypeSchema>;
export type SyncOperation = z.infer<typeof SyncOperationSchema>;
export type SyncPush = z.infer<typeof SyncPushSchema>;
export type GraphQuery = z.infer<typeof GraphQuerySchema>;

export interface StoredOperation extends SyncOperation {
  serverSequence: number;
  receivedAt: string;
}

export interface GraphNode {
  id: string;
  kind: string;
  relation?: string;
  label: string;
  projectId?: string;
  status?: string;
  checkpointIds: string[];
  metadata: Record<string, string | number | boolean | null>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  checkpointIds: string[];
}

export interface GraphSnapshot {
  version: "1";
  projectId: string;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  nextCursor: string | null;
  cursor?: string | null;
  truncated: boolean;
  degraded: boolean;
  projection?: { status: "ready" | "degraded"; message?: string };
}
