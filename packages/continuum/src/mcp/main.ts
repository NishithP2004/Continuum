#!/usr/bin/env node
import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createContinuumMcpHandlers,
  GraphQueryV1Schema,
  GraphSnapshotV1Schema,
  McpContextDiffV1Schema,
  McpContextPackV1Schema,
  McpCurrentInputSchema,
  McpDiffInputSchema,
  McpResumeInputSchema,
  McpSearchInputSchema,
  McpTimelineInputSchema,
  McpTimelinePageV1Schema
} from "@continuum/contracts";
import { ContinuumDatabase } from "../db/database.js";
import { EmbeddingService } from "../retrieval/embeddings.js";
import { ContextService } from "../retrieval/context-service.js";
import { resolveDatabasePath } from "../runtime.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const databasePath = argument("--db") ?? resolveDatabasePath();
if (!existsSync(databasePath)) {
  console.error(`Continuum database not found: ${databasePath}. Launch Continuum or run ./script/bootstrap.sh first.`);
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

const handlers = createContinuumMcpHandlers({
  current: ({ projectId, maxChars }) => contexts.pack({ projectId, maxCharacters: maxChars }),
  timeline: ({ projectId, cursor, limit }) => {
    let effectiveProjectId = projectId;
    if (!effectiveProjectId && cursor) {
      const checkpoint = database.getCheckpoint(cursor);
      if (!checkpoint) throw new Error(`Unknown checkpoint: ${cursor}`);
      effectiveProjectId = checkpoint.projectId;
    }
    effectiveProjectId ??= database.latestProjectId({ cloudEligibleOnly: true }) ?? "";
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
    return {
      version: "1" as const,
      projectId: effectiveProjectId,
      checkpoints: page,
      nextCursor: hasMore && page.length > 0 ? page.at(-1)!.id : null,
      truncated: false
    };
  },
  search: ({ query, projectId, limit, maxChars }) => contexts.pack({ projectId, query, limit, maxCharacters: maxChars }),
  resume: ({ projectId, maxChars }) => contexts.pack({ projectId, maxCharacters: maxChars }),
  diff: ({ projectId, sinceCheckpointId }) => contexts.diff({ projectId, sinceCheckpointId }),
  graph: (input) => database.graphSnapshot(input, { cloudEligibleOnly: true })
});

server.registerTool("current", {
  title: "Current Continuum context",
  description: "Return the latest goal, focus, blockers, hypotheses, files, and checkpoint provenance for a project.",
  inputSchema: McpCurrentInputSchema.shape,
  outputSchema: { data: McpContextPackV1Schema },
  annotations
}, handlers.current);

server.registerTool("timeline", {
  title: "Continuum checkpoint timeline",
  description: "List recent semantic checkpoints without raw developer events.",
  inputSchema: McpTimelineInputSchema.shape,
  outputSchema: { data: McpTimelinePageV1Schema },
  annotations
}, handlers.timeline);

server.registerTool("search", {
  title: "Search Continuum",
  description: "Search evidence-backed checkpoints using lexical, graph, recency, importance, and optional local-vector ranking.",
  inputSchema: McpSearchInputSchema.shape,
  outputSchema: { data: McpContextPackV1Schema },
  annotations
}, handlers.search);

server.registerTool("resume", {
  title: "Resume interrupted work",
  description: "Return a bounded Context Pack for resuming a project without pasted chat history.",
  inputSchema: McpResumeInputSchema.shape,
  outputSchema: { data: McpContextPackV1Schema },
  annotations
}, handlers.resume);

server.registerTool("diff", {
  title: "Context Diff",
  description: "Return deterministic, cited changes since an explicit or user-acknowledged checkpoint. This call never changes the baseline.",
  inputSchema: McpDiffInputSchema.shape,
  outputSchema: { data: McpContextDiffV1Schema },
  annotations
}, handlers.diff);

server.registerTool("graph", {
  title: "Continuum context graph",
  description: "Return a bounded, read-only graph snapshot with stable node IDs and checkpoint provenance.",
  inputSchema: GraphQueryV1Schema.shape,
  outputSchema: { data: GraphSnapshotV1Schema },
  annotations
}, handlers.graph);

const transport = new StdioServerTransport();
await server.connect(transport);

const close = async (): Promise<void> => {
  database.close();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
