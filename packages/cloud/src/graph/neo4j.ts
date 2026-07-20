import neo4j, { type Driver } from "neo4j-driver";
import { ProjectSyncPayloadV1Schema } from "@continuum/contracts";
import type { GraphEdge, GraphNode, GraphQuery, GraphSnapshot } from "../contracts.js";
import type { ProjectionJob } from "../db/postgres.js";

function scalar(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

function stringArray(value: unknown, maxItems = 64, maxLength = 512): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => (
    typeof item === "string" && item.length > 0 && item.length <= maxLength
  )))].slice(0, maxItems);
}

type GraphMetadata = Record<string, string | number | boolean | null>;

function graphMetadata(value: unknown): GraphMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: GraphMetadata = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(result).length >= 64) break;
    if (key.length === 0 || key.length > 64) continue;
    if (item === null || typeof item === "number" && Number.isFinite(item) || typeof item === "boolean") {
      result[key] = item as number | boolean | null;
    } else if (typeof item === "string" && item.length <= 512) {
      result[key] = item;
    }
  }
  return result;
}

function metadataJson(value: unknown): string | null {
  const metadata = graphMetadata(value);
  return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
}

function readMetadata(value: unknown): GraphMetadata {
  if (typeof value !== "string") return graphMetadata(value);
  try {
    return graphMetadata(JSON.parse(value));
  } catch {
    return {};
  }
}

function stringProperty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function projectIdFromPayload(payload: Record<string, unknown>): string | null {
  const direct = stringProperty(payload.projectId);
  if (direct) return direct;
  const metadata = graphMetadata(payload.metadata);
  return stringProperty(metadata.projectId);
}

export function createNeo4jDriver(uri: string, user: string, password: string): Driver {
  return neo4j.driver(uri, neo4j.auth.basic(user, password), {
    maxConnectionPoolSize: 20,
    connectionAcquisitionTimeout: 5_000
  });
}

export class Neo4jProjector {
  constructor(private readonly driver: Driver) {}

  verifyConnectivity(): Promise<unknown> {
    return this.driver.verifyConnectivity();
  }

  async clearProjection(): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run("MATCH (n:ContinuumEntity) DETACH DELETE n");
    } finally {
      await session.close();
    }
  }

  async project(job: ProjectionJob): Promise<void> {
    const session = this.driver.session();
    try {
      if (!["graph_node", "graph_edge", "checkpoint", "project", "baseline"].includes(job.entityType)) return;
      if (job.entityType === "graph_edge") {
        await this.projectEdge(session, job);
        return;
      }
      if (job.tombstone) {
        await session.run(`
          MATCH (n:ContinuumEntity {accountId: $accountId, entityType: $entityType, entityId: $entityId})
          DETACH DELETE n
        `, job);
        return;
      }
      const payload = job.payload ?? {};
      if (job.entityType === "project") {
        const project = ProjectSyncPayloadV1Schema.parse(payload);
        if (project.redirectFrom && project.redirectTo) {
          await this.projectRedirect(session, job, project.redirectFrom, project.redirectTo, project.label);
          return;
        }
      }
      const checkpointIds = job.entityType === "checkpoint"
        ? stringArray([...stringArray(payload.checkpointIds), job.entityId])
        : stringArray(payload.checkpointIds);
      await session.run(`
        OPTIONAL MATCH (redirect:ContinuumEntity {accountId: $accountId, entityType: 'project'})
        WHERE $projectId IS NOT NULL AND redirect.entityId = $projectId
        WITH coalesce(redirect.redirectTo, $projectId) AS canonicalProjectId
        MERGE (n:ContinuumEntity {accountId: $accountId, entityType: $entityType, entityId: $entityId})
        SET n.label = $label, n.kind = $kind, n.projectId = coalesce(canonicalProjectId, n.projectId),
            n.status = $status, n.summary = $summary,
            n.checkpointIds = (reduce(collected = [], checkpointId IN coalesce(n.checkpointIds, []) + $checkpointIds |
              CASE WHEN checkpointId IN collected THEN collected ELSE collected + checkpointId END))[-64..],
            n.metadataJson = CASE WHEN $metadataJson IS NULL THEN n.metadataJson ELSE $metadataJson END,
            n.updatedAt = datetime()
      `, {
        ...job,
        label: scalar(payload.label) ?? scalar(payload.goal) ?? job.entityId,
        kind: scalar(payload.kind) ?? job.entityType,
        projectId: projectIdFromPayload(payload),
        status: scalar(payload.status),
        summary: scalar(payload.summary),
        checkpointIds,
        metadataJson: metadataJson(payload.metadata)
      });
      if (job.entityType === "checkpoint") await this.projectCheckpointMentions(session, job);
    } finally {
      await session.close();
    }
  }

  private async projectRedirect(
    session: ReturnType<Driver["session"]>,
    job: ProjectionJob,
    redirectFrom: string,
    redirectTo: string,
    label: string
  ): Promise<void> {
    await session.run(`
      MERGE (source:ContinuumEntity {accountId: $accountId, entityType: 'project', entityId: $redirectFrom})
      MERGE (target:ContinuumEntity {accountId: $accountId, entityType: 'project', entityId: $redirectTo})
      SET source.label = $label, source.kind = 'project', source.redirectFrom = $redirectFrom,
          source.redirectTo = coalesce(target.redirectTo, $redirectTo),
          source.projectId = coalesce(target.redirectTo, $redirectTo), source.updatedAt = datetime()
    `, { ...job, redirectFrom, redirectTo, label });
    await session.run(`
      MATCH (source:ContinuumEntity {accountId: $accountId, entityType: 'project', entityId: $redirectFrom})
      WITH source.redirectTo AS canonicalProjectId
      OPTIONAL MATCH (entity:ContinuumEntity {accountId: $accountId})
      WHERE entity.projectId = $redirectFrom
      WITH canonicalProjectId, collect(entity) AS entities
      FOREACH (item IN entities | SET item.projectId = canonicalProjectId, item.updatedAt = datetime())
      WITH canonicalProjectId
      OPTIONAL MATCH (upstream:ContinuumEntity {accountId: $accountId, entityType: 'project'})
      WHERE upstream.redirectTo = $redirectFrom
      WITH canonicalProjectId, collect(upstream) AS upstreamRedirects
      FOREACH (item IN upstreamRedirects | SET item.redirectTo = canonicalProjectId, item.projectId = canonicalProjectId, item.updatedAt = datetime())
    `, { ...job, redirectFrom });
  }

  private async projectEdge(session: ReturnType<Driver["session"]>, job: ProjectionJob): Promise<void> {
    if (job.tombstone) {
      await session.run("MATCH ()-[r:RELATES {accountId: $accountId, edgeId: $entityId}]->() DELETE r", job);
      return;
    }
    const payload = job.payload ?? {};
    const source = scalar(payload.source);
    const target = scalar(payload.target);
    if (typeof source !== "string" || typeof target !== "string") throw new Error("graph edge requires source and target IDs");
    await session.run(`
      MERGE (a:ContinuumEntity {accountId: $accountId, entityType: 'graph_node', entityId: $source})
      MERGE (b:ContinuumEntity {accountId: $accountId, entityType: 'graph_node', entityId: $target})
      MERGE (a)-[r:RELATES {accountId: $accountId, edgeId: $entityId}]->(b)
      SET r.relation = $relation,
          r.checkpointIds = (reduce(collected = [], checkpointId IN coalesce(r.checkpointIds, []) + $checkpointIds |
            CASE WHEN checkpointId IN collected THEN collected ELSE collected + checkpointId END))[-64..],
          r.updatedAt = datetime()
    `, {
      ...job,
      source,
      target,
      relation: scalar(payload.relation) ?? scalar(payload.kind) ?? "related",
      checkpointIds: stringArray(payload.checkpointIds)
    });
  }

  private async projectCheckpointMentions(session: ReturnType<Driver["session"]>, job: ProjectionJob): Promise<void> {
    const entities = Array.isArray(job.payload?.entities) ? job.payload.entities : [];
    const mentions = entities.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const item = candidate as Record<string, unknown>;
      const kind = scalar(item.kind);
      const key = scalar(item.key);
      if (typeof kind !== "string" || typeof key !== "string") return [];
      const graphKind = kind === "person" ? "concept" : kind;
      if (!graphNodeKinds.has(graphKind)) return [];
      return [{
        id: `${graphKind}:${key}`,
        kind: graphKind,
        label: scalar(item.label) ?? key,
        metadataJson: JSON.stringify({ key, provenance: "checkpoint_mention" })
      }];
    }).slice(0, 64);
    if (mentions.length === 0) return;
    await session.run(`
      OPTIONAL MATCH (redirect:ContinuumEntity {accountId: $accountId, entityType: 'project'})
      WHERE $projectId IS NOT NULL AND redirect.entityId = $projectId
      WITH coalesce(redirect.redirectTo, $projectId) AS canonicalProjectId
      MATCH (checkpoint:ContinuumEntity {accountId: $accountId, entityType: 'checkpoint', entityId: $entityId})
      UNWIND $mentions AS mention
      MERGE (entity:ContinuumEntity {accountId: $accountId, entityType: 'graph_node', entityId: mention.id})
      SET entity.kind = mention.kind, entity.label = mention.label,
          entity.projectId = coalesce(canonicalProjectId, entity.projectId),
          entity.checkpointIds = (reduce(collected = [], checkpointId IN coalesce(entity.checkpointIds, []) + [$entityId] |
            CASE WHEN checkpointId IN collected THEN collected ELSE collected + checkpointId END))[-64..],
          entity.metadataJson = coalesce(entity.metadataJson, mention.metadataJson),
          entity.updatedAt = datetime()
      MERGE (checkpoint)-[r:RELATES {accountId: $accountId, edgeId: $entityId + '|mentions|' + mention.id}]->(entity)
      SET r.relation = 'mentions', r.checkpointIds = [$entityId], r.updatedAt = datetime()
    `, { ...job, mentions, projectId: projectIdFromPayload(job.payload ?? {}) });
  }
}

export interface GraphReader {
  graph(accountId: string, query: GraphQuery): Promise<GraphSnapshot>;
}

const graphNodeKinds = new Set([
  "project", "task", "checkpoint", "file", "commit", "url", "error", "blocker", "decision", "concept"
]);

function boundedQueryString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${field} exceeds its graph query cap`);
  return value;
}

function boundedQueryArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength: number,
  allowed?: Set<string>
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} exceeds its graph query cap`);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > maxLength || allowed && !allowed.has(item)) {
      throw new Error(`${field} contains an invalid graph query value`);
    }
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

export class Neo4jGraphReader implements GraphReader {
  constructor(private readonly driver: Driver) {}

  async graph(accountId: string, query: GraphQuery): Promise<GraphSnapshot> {
    if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > 128) {
      throw new Error("accountId exceeds its graph tenant cap");
    }
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500) {
      throw new Error("limit exceeds its graph query cap");
    }
    if (!Number.isInteger(query.hops) || query.hops < 0 || query.hops > 2) {
      throw new Error("hops exceeds its graph query cap");
    }
    if (query.cursor !== undefined && !/^\d+$/.test(query.cursor)) {
      throw new Error("cursor contains an invalid graph query value");
    }
    const limit = query.limit;
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    const projectId = boundedQueryString(query.projectId, "projectId", 512);
    const textQuery = boundedQueryString(query.query, "query", 256);
    const aroundNodeId = boundedQueryString(query.aroundNodeId, "aroundNodeId", 768);
    const nodeKinds = boundedQueryArray(query.kinds ?? query.nodeKinds, "nodeKinds", 16, 32, graphNodeKinds);
    const relations = boundedQueryArray(query.edgeKinds ?? query.relations, "relations", 32, 96);
    const canonicalProjectPrefix = `
      OPTIONAL MATCH (redirect:ContinuumEntity {accountId: $accountId, entityType: 'project'})
      WHERE $projectId IS NOT NULL AND redirect.entityId = $projectId
      WITH coalesce(redirect.redirectTo, $projectId) AS canonicalProjectId
    `;
    const nodeQuery = aroundNodeId === null ? `
      ${canonicalProjectPrefix}
      MATCH (n:ContinuumEntity {accountId: $accountId, entityType: 'graph_node'})
      WHERE (canonicalProjectId IS NULL OR n.projectId = canonicalProjectId)
        AND ($query IS NULL OR toLower(coalesce(n.label, '')) CONTAINS toLower($query))
        AND (size($nodeKinds) = 0 OR n.kind IN $nodeKinds)
      RETURN n, canonicalProjectId ORDER BY n.entityId SKIP $offset LIMIT $limit
    ` : query.hops === 0 ? `
      ${canonicalProjectPrefix}
      MATCH (n:ContinuumEntity {
        accountId: $accountId, entityType: 'graph_node', entityId: $aroundNodeId
      })
      WHERE (canonicalProjectId IS NULL OR n.projectId = canonicalProjectId)
        AND ($query IS NULL OR toLower(coalesce(n.label, '')) CONTAINS toLower($query))
        AND (size($nodeKinds) = 0 OR n.kind IN $nodeKinds)
      RETURN n, canonicalProjectId ORDER BY n.entityId SKIP $offset LIMIT $limit
    ` : `
      ${canonicalProjectPrefix}
      MATCH (seed:ContinuumEntity {
        accountId: $accountId, entityType: 'graph_node', entityId: $aroundNodeId
      })
      WHERE (canonicalProjectId IS NULL OR seed.projectId = canonicalProjectId)
      MATCH path = (seed)-[:RELATES*0..${query.hops}]-(n:ContinuumEntity)
      WHERE n.accountId = $accountId AND n.entityType = 'graph_node'
        AND (canonicalProjectId IS NULL OR n.projectId = canonicalProjectId)
        AND ($query IS NULL OR toLower(coalesce(n.label, '')) CONTAINS toLower($query))
        AND (size($nodeKinds) = 0 OR n.kind IN $nodeKinds)
        AND all(pathNode IN nodes(path) WHERE
          pathNode.accountId = $accountId AND pathNode.entityType = 'graph_node'
          AND (canonicalProjectId IS NULL OR pathNode.projectId = canonicalProjectId))
        AND all(relation IN relationships(path) WHERE
          relation.accountId = $accountId
          AND (size($relations) = 0 OR relation.relation IN $relations))
      WITH DISTINCT n, canonicalProjectId
      RETURN n, canonicalProjectId ORDER BY n.entityId SKIP $offset LIMIT $limit
    `;
    const session = this.driver.session();
    try {
      const result = await session.run(nodeQuery, {
        accountId,
        projectId,
        query: textQuery,
        aroundNodeId,
        nodeKinds,
        relations,
        offset: neo4j.int(offset),
        limit: neo4j.int(limit + 1)
      });
      const projectedProjectId = stringProperty(result.records[0]?.get("canonicalProjectId")) ?? projectId;
      const hasMore = result.records.length > limit;
      const nodes: GraphNode[] = result.records.slice(0, limit).map((record) => {
        const properties = record.get("n").properties as Record<string, unknown>;
        return {
          id: String(properties.entityId),
          kind: String(properties.kind ?? "concept"),
          label: String(properties.label ?? properties.entityId),
          ...(properties.projectId ? { projectId: String(properties.projectId) } : {}),
          ...(properties.status ? { status: String(properties.status) } : {}),
          checkpointIds: stringArray(properties.checkpointIds),
          metadata: readMetadata(properties.metadataJson ?? properties.metadata)
        };
      });
      const nodeIds = nodes.map((node) => node.id);
      const edgeResult = nodeIds.length > 0 ? await session.run(`
        MATCH (a:ContinuumEntity {accountId: $accountId, entityType: 'graph_node'})
          -[r:RELATES {accountId: $accountId}]->
          (b:ContinuumEntity {accountId: $accountId, entityType: 'graph_node'})
        WHERE a.entityId IN $nodeIds AND b.entityId IN $nodeIds
          AND ($projectId IS NULL OR a.projectId = $projectId)
          AND ($projectId IS NULL OR b.projectId = $projectId)
          AND (size($relations) = 0 OR r.relation IN $relations)
        RETURN a.entityId AS source, b.entityId AS target, r
        ORDER BY r.edgeId LIMIT 1001
      `, { accountId, projectId: projectedProjectId, nodeIds, relations }) : { records: [] };
      const edges: GraphEdge[] = edgeResult.records.map((record) => {
        const properties = record.get("r").properties as Record<string, unknown>;
        return {
          id: String(properties.edgeId),
          source: String(record.get("source")),
          target: String(record.get("target")),
          kind: String(properties.relation ?? "related"),
          relation: String(properties.relation ?? "related"),
          checkpointIds: stringArray(properties.checkpointIds)
        };
      });
      return {
        version: "1",
        projectId: projectedProjectId ?? "",
        generatedAt: new Date().toISOString(),
        nodes,
        edges: edges.slice(0, 1_000),
        nextCursor: hasMore ? String(offset + limit) : null,
        cursor: hasMore ? String(offset + limit) : null,
        truncated: hasMore || edges.length > 1_000,
        degraded: false,
        projection: { status: "ready" }
      };
    } finally {
      await session.close();
    }
  }
}
