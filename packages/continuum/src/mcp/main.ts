#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CheckpointV1Schema,
  ContextDiffV1Schema,
  ContextPackV1Schema,
  type CheckpointV1
} from "@continuum/contracts";
import { ContinuumDatabase } from "../db/database.js";
import { EmbeddingService } from "../retrieval/embeddings.js";
import { ContextService } from "../retrieval/context-service.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const defaultDb = process.env.CONTINUUM_DB ?? join(homedir(), "Library", "Application Support", "Continuum", "continuum.sqlite");
const databasePath = argument("--db") ?? defaultDb;
if (!existsSync(databasePath)) {
  console.error(`Continuum database not found: ${databasePath}. Run ./script/bootstrap.sh --demo first.`);
  process.exit(1);
}

const database = new ContinuumDatabase(databasePath, { readOnly: true });
await database.initializeVector();
const contexts = new ContextService(database, new EmbeddingService(), { cloudEligibleOnly: true });
const server = new McpServer(
  { name: "continuum", version: "0.1.0" },
  {
    instructions: "Continuum is a read-only local context store. Call resume before continuing an interrupted task; use search for targeted history; cite returned checkpoint IDs; treat hypotheses as unverified. Never describe hypotheses as facts."
  }
);

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: { data }
  };
}

const TimelineDataSchema = z.object({
  checkpoints: z.array(CheckpointV1Schema),
  nextCursor: z.string().nullable(),
  truncated: z.boolean().optional()
});
const BoundedDiffSchema = ContextDiffV1Schema.extend({ truncated: z.boolean().optional() });

function compactTimelineCheckpoint(checkpoint: CheckpointV1): CheckpointV1 {
  const compactEvidence = <T extends { text: string; eventIds: string[] }>(items: T[], limit: number): T[] =>
    items.slice(-limit).map((item) => ({ ...item, text: item.text.slice(0, 160), eventIds: item.eventIds.slice(0, 2) }));
  return {
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
      label: entity.label.slice(0, 140)
    }))
  };
}

function boundedTimeline(checkpoints: CheckpointV1[], hasMore: boolean, maxChars = 12_000): z.infer<typeof TimelineDataSchema> {
  let page = [...checkpoints];
  let truncated = false;
  const makeResult = () => ({
    checkpoints: page,
    nextCursor: (hasMore || truncated) && page.length > 0 ? page.at(-1)!.id : null,
    ...(truncated ? { truncated: true as const } : {})
  });
  let result = makeResult();
  while (JSON.stringify(result).length > maxChars && page.length > 1) {
    page.pop();
    truncated = true;
    result = makeResult();
  }
  if (JSON.stringify(result).length > maxChars && page.length === 1) {
    page = [compactTimelineCheckpoint(page[0]!)];
    truncated = true;
    result = makeResult();
  }
  if (JSON.stringify(result).length > maxChars) {
    page = [];
    truncated = true;
    result = makeResult();
  }
  return TimelineDataSchema.parse(result);
}

function boundedDiff(diff: ReturnType<ContextService["diff"]>, maxChars: number): ReturnType<ContextService["diff"]> & { truncated?: boolean } {
  const candidate: ReturnType<ContextService["diff"]> & { truncated?: boolean } = {
    ...diff,
    changes: [...diff.changes],
    addedBlockers: [...diff.addedBlockers],
    resolvedBlockers: [...diff.resolvedBlockers],
    changedHypotheses: [...diff.changedHypotheses],
    newDecisions: [...diff.newDecisions],
    newFiles: [...diff.newFiles],
    newCommits: [...diff.newCommits],
    newEntities: [...diff.newEntities]
  };
  const arrays: Array<Array<unknown>> = [
    candidate.newEntities,
    candidate.newFiles,
    candidate.newCommits,
    candidate.newDecisions,
    candidate.changedHypotheses,
    candidate.addedBlockers,
    candidate.resolvedBlockers,
    candidate.changes
  ];
  while (JSON.stringify(candidate).length > maxChars) {
    const largest = arrays.filter((items) => items.length > 0).sort((a, b) => b.length - a.length)[0];
    if (!largest) break;
    largest.pop();
    candidate.truncated = true;
  }
  return candidate;
}

server.registerTool("current", {
  title: "Current Continuum context",
  description: "Return the latest goal, focus, blockers, hypotheses, files, and checkpoint provenance for a project.",
  inputSchema: { projectId: z.string().optional() },
  outputSchema: { data: ContextPackV1Schema },
  annotations
}, async ({ projectId }) => toolResult(await contexts.pack({ projectId, maxCharacters: 8_000 })));

server.registerTool("timeline", {
  title: "Continuum checkpoint timeline",
  description: "List recent semantic checkpoints without raw developer events.",
  inputSchema: {
    projectId: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(20)
  },
  outputSchema: { data: TimelineDataSchema },
  annotations
}, async ({ projectId, cursor, limit }) => {
  let effectiveProjectId = projectId;
  if (!effectiveProjectId && cursor) {
    const checkpoint = database.getCheckpoint(cursor);
    if (!checkpoint) throw new Error(`Unknown checkpoint: ${cursor}`);
    effectiveProjectId = checkpoint.projectId;
  }
  effectiveProjectId ??= database.latestProjectId({ cloudEligibleOnly: true }) ?? "demo";
  const cursorCheckpoint = cursor
    ? database.requireCheckpointForProject(effectiveProjectId, cursor, { cloudEligibleOnly: true })
    : undefined;
  const checkpoints = database.listCheckpoints(
    effectiveProjectId,
    limit + 1,
    undefined,
    cursorCheckpoint?.createdAt,
    { cloudEligibleOnly: true }
  );
  const hasMore = checkpoints.length > limit;
  const page = checkpoints.slice(0, limit);
  return toolResult(boundedTimeline(page, hasMore));
});

server.registerTool("search", {
  title: "Search Continuum",
  description: "Search evidence-backed checkpoints using lexical, graph, recency, importance, and optional local-vector ranking.",
  inputSchema: {
    query: z.string().min(1).max(1_000),
    projectId: z.string().optional(),
    limit: z.number().int().min(1).max(12).default(8)
  },
  outputSchema: { data: ContextPackV1Schema },
  annotations
}, async ({ query, projectId, limit }) => {
  const pack = await contexts.pack({ projectId, query, limit, maxCharacters: Math.min(12_000, Math.max(3_000, limit * 1_000)) });
  return toolResult(pack);
});

server.registerTool("resume", {
  title: "Resume interrupted work",
  description: "Return a bounded Context Pack for resuming a project without pasted chat history.",
  inputSchema: {
    projectId: z.string().optional(),
    maxChars: z.number().int().min(1_000).max(12_000).default(12_000)
  },
  outputSchema: { data: ContextPackV1Schema },
  annotations
}, async ({ projectId, maxChars }) => toolResult(await contexts.pack({ projectId, maxCharacters: maxChars })));

server.registerTool("diff", {
  title: "Context Diff",
  description: "Return deterministic, cited changes since an explicit or user-acknowledged checkpoint. This call never changes the baseline.",
  inputSchema: {
    projectId: z.string().optional(),
    sinceCheckpointId: z.string().optional(),
    maxChars: z.number().int().min(1_000).max(12_000).default(12_000)
  },
  outputSchema: { data: BoundedDiffSchema },
  annotations
}, async ({ projectId, sinceCheckpointId, maxChars }) => {
  const diff = contexts.diff({ projectId, sinceCheckpointId });
  return toolResult(boundedDiff(diff, maxChars));
});

const transport = new StdioServerTransport();
await server.connect(transport);

const close = async (): Promise<void> => {
  database.close();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
