import {
  boundedContextDiffV1,
  boundedContextPackV1,
  boundedTimelinePageV1,
  CheckpointV1Schema,
  ContextDiffV1Schema,
  ContextPackV1Schema,
  GraphSnapshotV1Schema,
  type CheckpointV1,
  type ContextChange,
  type ContextPackV1,
  type Entity,
  type GraphEdgeV1,
  type GraphNodeV1,
  type GraphSnapshotV1,
  type McpContextDiffV1,
  type McpTimelinePageV1,
  type RankedCheckpoint
} from "@continuum/contracts";
import type { GraphQuery } from "../contracts.js";
import type { SqlExecutor } from "../db/postgres.js";
import type { ContextDataSource, ContextQuery, DiffQuery, SearchQuery, TimelineQuery } from "./data-source.js";

interface EntityRow {
  entity_id: string;
  payload: Record<string, unknown>;
  updated_at: Date;
  canonical_project_id?: string | null;
}

const projectRedirectCte = `
  WITH RECURSIVE live_project_redirects AS (
    SELECT payload->>'redirectFrom' AS source_id, payload->>'redirectTo' AS target_id
    FROM sync_entities
    WHERE account_id = $1 AND entity_type = 'project' AND NOT tombstone
      AND (expires_at IS NULL OR expires_at > now())
      AND payload ? 'redirectFrom' AND payload ? 'redirectTo'
  ), redirect_walk(source_id, canonical_id, visited, depth) AS (
    SELECT source_id, target_id, ARRAY[source_id, target_id]::text[], 1
    FROM live_project_redirects
    UNION ALL
    SELECT walk.source_id, redirect.target_id, walk.visited || redirect.target_id, walk.depth + 1
    FROM redirect_walk AS walk
    JOIN live_project_redirects AS redirect ON redirect.source_id = walk.canonical_id
    WHERE walk.depth < 32 AND NOT redirect.target_id = ANY(walk.visited)
  ), canonical_redirects AS (
    SELECT DISTINCT ON (source_id) source_id, canonical_id
    FROM redirect_walk ORDER BY source_id, depth DESC
  )
`;

function canonicalProject(expression: string): string {
  return `COALESCE((SELECT canonical_id FROM canonical_redirects WHERE source_id = ${expression}), ${expression})`;
}

function checkpointProject(): string {
  return canonicalProject("payload->>'projectId'");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function checkpoint(row: EntityRow): CheckpointV1 {
  return CheckpointV1Schema.parse({
    ...row.payload,
    ...(row.canonical_project_id ? { projectId: row.canonical_project_id } : {}),
    id: text(row.payload.id) || row.entity_id
  });
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function contextPack(
  projectId: string,
  ranked: RankedCheckpoint[],
  maxCharacters: number,
  rankingVersion: string
): ContextPackV1 {
  const checkpoints = [...ranked]
    .sort((left, right) => left.checkpoint.createdAt.localeCompare(right.checkpoint.createdAt));
  const selected = checkpoints.map(({ checkpoint: item }) => item);
  const latest = selected.at(-1);
  const entities = uniqueBy(selected.flatMap((item) => item.entities), (entity) => `${entity.kind}:${entity.key}`);
  const pack = ContextPackV1Schema.parse({
    version: "1",
    projectId,
    generatedAt: new Date().toISOString(),
    currentGoal: latest?.goal ?? "No checkpoint yet",
    currentFocus: latest?.focus ?? "Waiting for live activity",
    checkpoints,
    blockers: uniqueBy(selected.flatMap((item) => item.blockers), (item) => `${item.status}:${item.text}`),
    hypotheses: uniqueBy(selected.flatMap((item) => item.hypotheses), (item) => `${item.status}:${item.text}`),
    decisions: uniqueBy(selected.flatMap((item) => item.decisions), (item) => item.text),
    questions: uniqueBy(selected.flatMap((item) => item.questions), (item) => item.text),
    files: entities.filter((entity) => entity.kind === "file"),
    commits: entities.filter((entity) => entity.kind === "commit"),
    entities,
    provenance: {
      checkpointIds: selected.map((item) => item.id),
      deviceIds: [...new Set(selected.flatMap((item) => item.deviceId ? [item.deviceId] : []))],
      rankingVersion,
      degraded: true,
      maxCharacters
    },
    approximateCharacters: 0
  });
  return boundedContextPackV1(pack, maxCharacters);
}

function entityKey(entity: Entity): string {
  return `${entity.kind}:${entity.key}`;
}

function projectClause(projectId: string | undefined, parameter = 2): string {
  return projectId ? `AND ${checkpointProject()} = ${canonicalProject(`$${parameter}::text`)}` : "";
}

export class PostgresContextDataSource implements ContextDataSource {
  constructor(private readonly sql: SqlExecutor) {}

  private async latestCheckpoint(accountId: string, projectId?: string): Promise<CheckpointV1 | null> {
    const result = await this.sql.query<EntityRow>(`
      ${projectRedirectCte}
      SELECT entity_id, payload, updated_at, ${checkpointProject()} AS canonical_project_id FROM sync_entities
      WHERE account_id = $1 AND entity_type = 'checkpoint' AND NOT tombstone
        AND (expires_at IS NULL OR expires_at > now()) ${projectClause(projectId)}
      ORDER BY updated_at DESC, entity_id DESC LIMIT 1
    `, projectId ? [accountId, projectId] : [accountId]);
    return result.rows[0] ? checkpoint(result.rows[0]) : null;
  }

  private async checkpointById(accountId: string, checkpointId: string, projectId?: string): Promise<CheckpointV1 | null> {
    const values: unknown[] = [accountId, checkpointId];
    const project = projectId ? ` AND ${checkpointProject()} = ${canonicalProject("$3::text")}` : "";
    if (projectId) values.push(projectId);
    const result = await this.sql.query<EntityRow>(`
      ${projectRedirectCte}
      SELECT entity_id, payload, updated_at, ${checkpointProject()} AS canonical_project_id FROM sync_entities
      WHERE account_id = $1 AND entity_type = 'checkpoint' AND entity_id = $2
        AND NOT tombstone AND (expires_at IS NULL OR expires_at > now()) ${project}
      LIMIT 1
    `, values);
    return result.rows[0] ? checkpoint(result.rows[0]) : null;
  }

  private async synchronizedBaselineId(accountId: string, projectId: string): Promise<string | undefined> {
    const result = await this.sql.query<{ payload: Record<string, unknown> }>(`
      ${projectRedirectCte}
      SELECT payload FROM sync_entities
      WHERE account_id = $1 AND entity_type = 'baseline'
        AND ${canonicalProject("COALESCE(payload->>'projectId', entity_id)")} = ${canonicalProject("$2::text")}
        AND NOT tombstone AND (expires_at IS NULL OR expires_at > now())
      ORDER BY updated_at DESC LIMIT 1
    `, [accountId, projectId]);
    const payload = result.rows[0]?.payload;
    return payload ? text(payload.checkpointId) || undefined : undefined;
  }

  private async oldestCheckpoint(accountId: string, projectId: string): Promise<CheckpointV1 | null> {
    const result = await this.sql.query<EntityRow>(`
      ${projectRedirectCte}
      SELECT entity_id, payload, updated_at, ${checkpointProject()} AS canonical_project_id FROM sync_entities
      WHERE account_id = $1 AND entity_type = 'checkpoint' AND NOT tombstone
        AND ${checkpointProject()} = ${canonicalProject("$2::text")} AND (expires_at IS NULL OR expires_at > now())
      ORDER BY updated_at ASC, entity_id ASC LIMIT 1
    `, [accountId, projectId]);
    return result.rows[0] ? checkpoint(result.rows[0]) : null;
  }

  async current(accountId: string, query: ContextQuery): Promise<ContextPackV1> {
    const latest = await this.latestCheckpoint(accountId, query.projectId);
    const projectId = latest?.projectId ?? query.projectId ?? "";
    const ranked = latest ? [{ checkpoint: latest, score: 1, reasons: ["latest synchronized checkpoint"] }] : [];
    return contextPack(projectId, ranked, query.maxChars ?? 8_000, "remote-current-v1");
  }

  async timeline(accountId: string, query: TimelineQuery): Promise<McpTimelinePageV1> {
    const limit = Math.min(50, query.limit ?? 20);
    const cursorResult = query.cursor
      ? await this.sql.query<{ updated_at: Date }>(`
          SELECT updated_at FROM sync_entities
          WHERE account_id = $1 AND entity_type = 'checkpoint' AND entity_id = $2
        `, [accountId, query.cursor])
      : null;
    const before = cursorResult?.rows[0]?.updated_at;
    const values: unknown[] = [accountId];
    let clause = "";
    if (query.projectId) {
      values.push(query.projectId);
      clause += ` AND ${checkpointProject()} = ${canonicalProject(`$${values.length}::text`)}`;
    }
    if (before) { values.push(before); clause += ` AND updated_at < $${values.length}`; }
    values.push(limit + 1);
    const result = await this.sql.query<EntityRow>(`
      ${projectRedirectCte}
      SELECT entity_id, payload, updated_at, ${checkpointProject()} AS canonical_project_id FROM sync_entities
      WHERE account_id = $1 AND entity_type = 'checkpoint' AND NOT tombstone
        AND (expires_at IS NULL OR expires_at > now()) ${clause}
      ORDER BY updated_at DESC, entity_id DESC LIMIT $${values.length}
    `, values);
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const checkpoints = rows.map(checkpoint);
    return boundedTimelinePageV1({
      version: "1",
      projectId: checkpoints[0]?.projectId ?? query.projectId ?? "",
      checkpoints,
      nextCursor: hasMore ? checkpoints.at(-1)?.id ?? null : null,
      truncated: false
    }, query.maxChars ?? 12_000);
  }

  async search(accountId: string, query: SearchQuery): Promise<ContextPackV1> {
    const limit = Math.min(12, query.limit ?? 8);
    const values: unknown[] = [accountId, query.query];
    let project = "";
    if (query.projectId) {
      values.push(query.projectId);
      project = ` AND ${checkpointProject()} = ${canonicalProject(`$${values.length}::text`)}`;
    }
    values.push(limit);
    const result = await this.sql.query<EntityRow & { rank: number }>(`
      ${projectRedirectCte}
      SELECT entity_id, payload, updated_at, ${checkpointProject()} AS canonical_project_id,
        ts_rank(to_tsvector('simple', search_text), websearch_to_tsquery('simple', $2)) AS rank
      FROM sync_entities
      WHERE account_id = $1 AND entity_type = 'checkpoint' AND NOT tombstone
        AND (expires_at IS NULL OR expires_at > now()) ${project}
        AND to_tsvector('simple', search_text) @@ websearch_to_tsquery('simple', $2)
      ORDER BY rank DESC, updated_at DESC LIMIT $${values.length}
    `, values);
    const checkpoints: RankedCheckpoint[] = result.rows.map((row) => ({
      checkpoint: checkpoint(row),
      score: Number.isFinite(Number(row.rank)) ? Number(row.rank) : 0,
      reasons: ["remote lexical match"]
    }));
    return contextPack(
      checkpoints[0]?.checkpoint.projectId ?? query.projectId ?? "",
      checkpoints,
      query.maxChars ?? 12_000,
      "remote-fts-v1"
    );
  }

  async resume(accountId: string, query: ContextQuery): Promise<ContextPackV1> {
    const maxCharacters = query.maxChars ?? 12_000;
    const values: unknown[] = [accountId];
    let project = "";
    if (query.projectId) {
      values.push(query.projectId);
      project = ` AND ${checkpointProject()} = ${canonicalProject(`$${values.length}::text`)}`;
    }
    values.push(12);
    const result = await this.sql.query<EntityRow>(`
      ${projectRedirectCte}
      SELECT entity_id, payload, updated_at, ${checkpointProject()} AS canonical_project_id FROM sync_entities
      WHERE account_id = $1 AND entity_type = 'checkpoint' AND NOT tombstone
        AND (expires_at IS NULL OR expires_at > now()) ${project}
      ORDER BY updated_at DESC, entity_id DESC LIMIT $${values.length}
    `, values);
    const checkpoints = result.rows.map(checkpoint);
    const ranked: RankedCheckpoint[] = checkpoints.map((item, index) => ({
      checkpoint: item,
      score: 1 / (index + 1),
      reasons: ["remote recency"]
    }));
    return contextPack(
      checkpoints[0]?.projectId ?? query.projectId ?? "",
      ranked,
      maxCharacters,
      "remote-recency-v1"
    );
  }

  async diff(accountId: string, query: DiffQuery): Promise<McpContextDiffV1> {
    const current = await this.latestCheckpoint(accountId, query.projectId);
    const projectId = current?.projectId ?? query.projectId ?? "";
    const synchronizedBaselineId = !query.sinceCheckpointId && projectId
      ? await this.synchronizedBaselineId(accountId, projectId)
      : undefined;
    const baselineId = query.sinceCheckpointId ?? synchronizedBaselineId;
    const baseline = baselineId
      ? await this.checkpointById(accountId, baselineId, projectId || undefined)
      : projectId ? await this.oldestCheckpoint(accountId, projectId) : null;
    if (!current || !baseline) {
      return boundedContextDiffV1(ContextDiffV1Schema.parse({
        version: "1",
        projectId,
        deviceIds: [...new Set([current, baseline].flatMap((item) => item?.deviceId ? [item.deviceId] : []))],
        baselineCheckpointId: baseline?.id ?? null,
        currentCheckpointId: current?.id ?? null,
        generatedAt: new Date().toISOString(),
        changes: [],
        addedBlockers: [],
        resolvedBlockers: [],
        changedHypotheses: [],
        newDecisions: [],
        newFiles: [],
        newCommits: [],
        newEntities: []
      }), query.maxChars ?? 12_000);
    }
    const baselineBlockers = new Map(baseline.blockers.map((item) => [item.text, item]));
    const addedBlockers = current.blockers.filter((item) => item.status === "open" && baselineBlockers.get(item.text)?.status !== "open");
    const resolvedBlockers = current.blockers.filter((item) => item.status === "resolved" && baselineBlockers.get(item.text)?.status === "open");
    const baselineHypotheses = new Map(baseline.hypotheses.map((item) => [item.text, item]));
    const changedHypotheses = current.hypotheses.filter((item) => {
      const previous = baselineHypotheses.get(item.text);
      return previous ? previous.status !== item.status : item.status !== "active";
    });
    const baselineDecisions = new Set(baseline.decisions.map((item) => item.text));
    const newDecisions = current.decisions.filter((item) => !baselineDecisions.has(item.text));
    const baselineEntities = new Set(baseline.entities.map(entityKey));
    const newEntities = uniqueBy(current.entities.filter((entity) => !baselineEntities.has(entityKey(entity))), entityKey);
    const newFiles = newEntities.filter((entity) => entity.kind === "file");
    const newCommits = newEntities.filter((entity) => entity.kind === "commit");
    const changes: ContextChange[] = [];
    for (const item of addedBlockers) changes.push({ type: "blocker_added", text: item.text, checkpointIds: [current.id] });
    for (const item of resolvedBlockers) changes.push({ type: "blocker_resolved", text: item.text, checkpointIds: [current.id] });
    for (const item of changedHypotheses) changes.push({ type: "hypothesis_changed", text: `${item.status}: ${item.text}`, checkpointIds: [current.id] });
    for (const item of newDecisions) changes.push({ type: "decision_added", text: item.text, checkpointIds: [current.id] });
    for (const item of newFiles) changes.push({ type: "file_changed", text: item.label, checkpointIds: [current.id] });
    for (const item of newCommits) changes.push({ type: "commit_added", text: item.label, checkpointIds: [current.id] });
    for (const item of newEntities.filter((entity) => entity.kind !== "file" && entity.kind !== "commit")) {
      changes.push({ type: "entity_added", text: item.label, checkpointIds: [current.id] });
    }
    return boundedContextDiffV1(ContextDiffV1Schema.parse({
      version: "1",
      projectId,
      deviceIds: [...new Set([baseline, current].flatMap((item) => item.deviceId ? [item.deviceId] : []))],
      baselineCheckpointId: baseline.id,
      currentCheckpointId: current.id,
      generatedAt: new Date().toISOString(),
      changes,
      addedBlockers,
      resolvedBlockers,
      changedHypotheses,
      newDecisions,
      newFiles,
      newCommits,
      newEntities
    }), query.maxChars ?? 12_000);
  }

  async graph(accountId: string, query: GraphQuery): Promise<GraphSnapshotV1> {
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    const nodeLimit = Math.min(500, query.limit);
    const edgeKinds = query.edgeKinds ?? query.relations ?? [];
    let reachableIds: string[] | undefined;
    let traversalTruncated = false;
    if (query.aroundNodeId) {
      const reachable = new Set([query.aroundNodeId]);
      let frontier = new Set([query.aroundNodeId]);
      for (let hop = 0; hop < query.hops && frontier.size > 0; hop += 1) {
        const traversalValues: unknown[] = [accountId, [...frontier]];
        let traversalFilter = "";
        if (edgeKinds.length > 0) {
          traversalValues.push(edgeKinds);
          traversalFilter = ` AND COALESCE(payload->>'kind', payload->>'relation') = ANY($${traversalValues.length}::text[])`;
        }
        traversalValues.push(10_001);
        const incident = await this.sql.query<EntityRow>(`
          SELECT entity_id, payload, updated_at FROM sync_entities
          WHERE account_id = $1 AND entity_type = 'graph_edge' AND NOT tombstone
            AND (expires_at IS NULL OR expires_at > now())
            AND (payload->>'source' = ANY($2::text[]) OR payload->>'target' = ANY($2::text[]))
            ${traversalFilter}
          ORDER BY entity_id LIMIT $${traversalValues.length}
        `, traversalValues);
        if (incident.rows.length > 10_000) traversalTruncated = true;
        const next = new Set<string>();
        for (const row of incident.rows.slice(0, 10_000)) {
          for (const id of [text(row.payload.source), text(row.payload.target)]) {
            if (!id || reachable.has(id)) continue;
            if (reachable.size >= 5_000) { traversalTruncated = true; continue; }
            reachable.add(id);
            next.add(id);
          }
        }
        frontier = next;
      }
      reachableIds = [...reachable];
    }
    const nodeValues: unknown[] = [accountId];
    let filter = "";
    const graphProject = "COALESCE(payload->>'projectId', payload->'metadata'->>'projectId')";
    const canonicalGraphProject = canonicalProject(graphProject);
    if (query.projectId) {
      nodeValues.push(query.projectId);
      filter += ` AND ${canonicalGraphProject} = ${canonicalProject(`$${nodeValues.length}::text`)}`;
    }
    if (reachableIds) {
      nodeValues.push(reachableIds);
      filter += ` AND entity_id = ANY($${nodeValues.length}::text[])`;
    }
    if (query.query) { nodeValues.push(`%${query.query}%`); filter += ` AND payload::text ILIKE $${nodeValues.length}`; }
    const nodeKinds = query.kinds ?? query.nodeKinds;
    if (nodeKinds?.length) { nodeValues.push(nodeKinds); filter += ` AND payload->>'kind' = ANY($${nodeValues.length}::text[])`; }
    nodeValues.push(nodeLimit + 1, offset);
    const nodesResult = await this.sql.query<EntityRow>(`
      ${projectRedirectCte}
      SELECT entity_id, payload, updated_at, ${canonicalGraphProject} AS canonical_project_id FROM sync_entities
      WHERE account_id = $1 AND entity_type = 'graph_node' AND NOT tombstone
        AND (expires_at IS NULL OR expires_at > now()) ${filter}
      ORDER BY entity_id LIMIT $${nodeValues.length - 1} OFFSET $${nodeValues.length}
    `, nodeValues);
    const hasMore = nodesResult.rows.length > nodeLimit;
    const nodes: GraphNodeV1[] = nodesResult.rows.slice(0, nodeLimit).map((row) => ({
      id: row.entity_id,
      kind: (text(row.payload.kind) || "concept") as GraphNodeV1["kind"],
      label: text(row.payload.label) || row.entity_id,
      ...((() => {
        const metadata = row.payload.metadata && typeof row.payload.metadata === "object"
          ? row.payload.metadata as Record<string, unknown>
          : {};
        const projectId = text(row.canonical_project_id) || text(row.payload.projectId) || text(metadata.projectId);
        return projectId ? { projectId } : {};
      })()),
      ...(text(row.payload.subtitle) ? { subtitle: text(row.payload.subtitle) } : {}),
      ...(text(row.payload.status) ? { status: text(row.payload.status) } : {}),
      ...(typeof row.payload.importance === "number" ? { importance: row.payload.importance } : {}),
      ...(typeof row.payload.confidence === "number" ? { confidence: row.payload.confidence } : {}),
      checkpointIds: strings(row.payload.checkpointIds),
      metadata: row.payload.metadata && typeof row.payload.metadata === "object"
        ? row.payload.metadata as Record<string, string | number | boolean | null>
        : {}
    }));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edgeValues: unknown[] = [accountId, [...nodeIds]];
    let edgeFilter = "";
    if (edgeKinds.length) { edgeValues.push(edgeKinds); edgeFilter = ` AND COALESCE(payload->>'kind', payload->>'relation') = ANY($3::text[])`; }
    edgeValues.push(1_001);
    const edgesResult = nodeIds.size > 0 ? await this.sql.query<EntityRow>(`
      SELECT entity_id, payload, updated_at FROM sync_entities
      WHERE account_id = $1 AND entity_type = 'graph_edge' AND NOT tombstone
        AND (expires_at IS NULL OR expires_at > now())
        AND payload->>'source' = ANY($2::text[]) AND payload->>'target' = ANY($2::text[]) ${edgeFilter}
      ORDER BY entity_id LIMIT $${edgeValues.length}
    `, edgeValues) : { rows: [] as EntityRow[] };
    const edges: GraphEdgeV1[] = edgesResult.rows.map((row) => ({
      id: row.entity_id,
      source: text(row.payload.source),
      target: text(row.payload.target),
      kind: text(row.payload.kind) || text(row.payload.relation) || "related",
      checkpointIds: strings(row.payload.checkpointIds)
    })).filter((edge) => edge.source && edge.target);

    return GraphSnapshotV1Schema.parse({
      version: "1",
      projectId: nodes[0]?.projectId ?? query.projectId ?? "",
      generatedAt: new Date().toISOString(),
      nodes,
      edges: edges.slice(0, 1_000),
      nextCursor: hasMore ? String(offset + nodeLimit) : null,
      truncated: traversalTruncated || hasMore || edges.length > 1_000,
      degraded: true
    });
  }
}
