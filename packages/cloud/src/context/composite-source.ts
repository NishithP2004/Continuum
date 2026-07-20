import type { GraphQuery, GraphSnapshot } from "../contracts.js";
import type { GraphReader } from "../graph/neo4j.js";
import type { ContextDataSource, ContextQuery, DiffQuery, SearchQuery, TimelineQuery } from "./data-source.js";

export class CompositeContextDataSource implements ContextDataSource {
  constructor(private readonly primary: ContextDataSource, private readonly graphReader?: GraphReader) {}

  current(accountId: string, query: ContextQuery) { return this.primary.current(accountId, query); }
  timeline(accountId: string, query: TimelineQuery) { return this.primary.timeline(accountId, query); }
  search(accountId: string, query: SearchQuery) { return this.primary.search(accountId, query); }
  resume(accountId: string, query: ContextQuery) { return this.primary.resume(accountId, query); }
  diff(accountId: string, query: DiffQuery) { return this.primary.diff(accountId, query); }

  async graph(accountId: string, query: GraphQuery): Promise<GraphSnapshot> {
    if (!this.graphReader) return this.primary.graph(accountId, query);
    try {
      return await this.graphReader.graph(accountId, query);
    } catch {
      const fallback = await this.primary.graph(accountId, query);
      return { ...fallback, degraded: true };
    }
  }
}
