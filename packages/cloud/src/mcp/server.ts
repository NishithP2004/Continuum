import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../auth/authenticator.js";
import type { ContextDataSource } from "../context/data-source.js";

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

export function createRemoteMcpServer(principal: Principal, source: ContextDataSource): McpServer {
  const server = new McpServer(
    { name: "continuum-remote", version: "0.1.0" },
    {
      instructions: "Continuum Remote exposes only synchronized, cloud-eligible context for the authenticated tenant. Cite checkpoint IDs. Hypotheses are unverified and must never be presented as facts. All tools are read-only."
    }
  );
  const handlers = createContinuumMcpHandlers({
    current: (input) => source.current(principal.accountId, input),
    timeline: (input) => source.timeline(principal.accountId, input),
    search: (input) => source.search(principal.accountId, input),
    resume: (input) => source.resume(principal.accountId, input),
    diff: (input) => source.diff(principal.accountId, input),
    graph: (input) => source.graph(principal.accountId, input)
  });

  server.registerTool("current", {
    title: "Current Continuum context",
    description: "Return the latest synchronized state and cited checkpoint for a project.",
    inputSchema: McpCurrentInputSchema.shape,
    outputSchema: { data: McpContextPackV1Schema },
    annotations
  }, handlers.current);

  server.registerTool("timeline", {
    title: "Continuum checkpoint timeline",
    description: "List synchronized semantic checkpoints without raw activity payloads.",
    inputSchema: McpTimelineInputSchema.shape,
    outputSchema: { data: McpTimelinePageV1Schema },
    annotations
  }, handlers.timeline);

  server.registerTool("search", {
    title: "Search Continuum",
    description: "Search evidence-backed synchronized checkpoints for this tenant.",
    inputSchema: McpSearchInputSchema.shape,
    outputSchema: { data: McpContextPackV1Schema },
    annotations
  }, handlers.search);

  server.registerTool("resume", {
    title: "Resume interrupted work",
    description: "Return a bounded, cited context pack from synchronized checkpoints.",
    inputSchema: McpResumeInputSchema.shape,
    outputSchema: { data: McpContextPackV1Schema },
    annotations
  }, handlers.resume);

  server.registerTool("diff", {
    title: "Context Diff",
    description: "Return cited synchronized changes since a checkpoint without moving any baseline.",
    inputSchema: McpDiffInputSchema.shape,
    outputSchema: { data: McpContextDiffV1Schema },
    annotations
  }, handlers.diff);

  server.registerTool("graph", {
    title: "Continuum context graph",
    description: "Return a bounded read-only graph snapshot with checkpoint provenance.",
    inputSchema: GraphQueryV1Schema.shape,
    outputSchema: { data: GraphSnapshotV1Schema },
    annotations
  }, handlers.graph);

  return server;
}

export async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  principal: Principal,
  source: ContextDataSource,
  resource: URL
): Promise<void> {
  // The SDK's Node/Web transport drains IncomingMessage after frameworks have
  // already parsed the body. Real net.Socket instances expose destroySoon;
  // lightweight test/proxy request sockets may not. Keep the drain timeout
  // safe without changing real socket behavior.
  const socket = request.socket as typeof request.socket & { destroySoon?: () => void };
  if (socket && typeof socket.destroySoon !== "function") {
    socket.destroySoon = () => socket.destroy?.();
  }
  const server = createRemoteMcpServer(principal, source);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  (request as IncomingMessage & { auth?: Record<string, unknown> }).auth = {
    token: principal.token,
    clientId: principal.clientId,
    scopes: principal.scopes,
    expiresAt: principal.expiresAt,
    resource,
    extra: { accountId: principal.accountId, subject: principal.subject }
  };
  await server.connect(transport);
  response.once("finish", () => {
    void transport.close().finally(() => server.close());
  });
  await transport.handleRequest(request, response, body);
}
