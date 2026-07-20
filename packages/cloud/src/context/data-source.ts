import type { GraphQuery, GraphSnapshot } from "../contracts.js";

export interface ContextQuery {
  projectId?: string;
  maxChars?: number;
}

export interface TimelineQuery extends ContextQuery {
  cursor?: string;
  limit?: number;
}

export interface SearchQuery extends ContextQuery {
  query: string;
  limit?: number;
}

export interface DiffQuery extends ContextQuery {
  sinceCheckpointId?: string;
}

export interface ContextDataSource {
  current(accountId: string, query: ContextQuery): Promise<Record<string, unknown>>;
  timeline(accountId: string, query: TimelineQuery): Promise<Record<string, unknown>>;
  search(accountId: string, query: SearchQuery): Promise<Record<string, unknown>>;
  resume(accountId: string, query: ContextQuery): Promise<Record<string, unknown>>;
  diff(accountId: string, query: DiffQuery): Promise<Record<string, unknown>>;
  graph(accountId: string, query: GraphQuery): Promise<GraphSnapshot>;
}
