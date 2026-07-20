import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { SyncOperationSchema, type SyncOperation, type SyncPush, type StoredOperation } from "../contracts.js";
import { PrivacyPolicyV1Schema, type PrivacyPolicyV1 } from "@continuum/contracts";
import {
  assertCloudEligibleOperation,
  assertOperationCompliesWithPrivacyPolicy,
  defaultCloudPrivacyPolicy
} from "../privacy.js";
import { compareHlc, nextHlc, parseHlc } from "../sync/hlc.js";
import { runMigrations } from "./migrations.js";

export interface ApiKeyRecord {
  accountId: string;
  id: string;
  deviceId: string | null;
  digest: Buffer;
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface ProjectionJob {
  outboxId: number;
  accountId: string;
  operationId: string;
  entityType: string;
  entityId: string;
  tombstone: boolean;
  payload: Record<string, unknown> | null;
}

export class SyncInputError extends Error { readonly statusCode = 400; }
export class SyncConflictError extends Error { readonly statusCode = 409; }
export class DeviceRevokedError extends Error { readonly statusCode = 403; }
export class DeviceCredentialError extends Error { readonly statusCode = 403; }

export interface SqlExecutor {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

function asIso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function storedOperation(row: Record<string, unknown>): StoredOperation {
  return {
    version: "1",
    id: String(row.id),
    deviceId: String(row.device_id),
    sequence: Number(row.device_sequence),
    hlc: String(row.hlc),
    entityType: row.entity_type as StoredOperation["entityType"],
    entityId: String(row.entity_id),
    tombstone: Boolean(row.tombstone),
    ...(row.payload === null || row.payload === undefined ? {} : { payload: row.payload }),
    occurredAt: asIso(row.occurred_at as Date)!,
    serverSequence: Number(row.server_sequence),
    receivedAt: asIso(row.received_at as Date)!
  };
}

const immutableEntityTypes = new Set<SyncOperation["entityType"]>(["event", "checkpoint", "chat_message"]);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function assertImmutableEntityValue(
  entityType: SyncOperation["entityType"],
  entityId: string,
  existing: { payload: Record<string, unknown> | null; tombstone: boolean } | undefined,
  incoming: { payload?: unknown; tombstone: boolean }
): void {
  if (!immutableEntityTypes.has(entityType) || !existing || incoming.tombstone) return;
  if (existing.tombstone || canonicalJson(existing.payload) !== canonicalJson(incoming.payload)) {
    throw new SyncConflictError(`${entityType} ${entityId} is immutable and already has different data`);
  }
}

export class PostgresStore implements SqlExecutor {
  readonly pool: Pool;

  constructor(connectionString: string | Pool) {
    this.pool = typeof connectionString === "string"
      ? new Pool({ connectionString, max: 20, application_name: "continuum-cloud" })
      : connectionString;
  }

  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, values);
  }

  migrate(): Promise<void> {
    return runMigrations(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ensureAccount(subject: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(`
      INSERT INTO accounts(auth_subject) VALUES ($1)
      ON CONFLICT (auth_subject) DO UPDATE SET auth_subject = EXCLUDED.auth_subject
      RETURNING id
    `, [subject]);
    return result.rows[0]!.id;
  }

  async findApiKey(id: string): Promise<ApiKeyRecord | null> {
    const result = await this.pool.query<{
      account_id: string; id: string; device_id: string | null; digest: Buffer; scopes: string[];
      expires_at: Date | null; revoked_at: Date | null;
    }>("SELECT account_id, id, device_id, digest, scopes, expires_at, revoked_at FROM api_keys WHERE id = $1", [id]);
    const row = result.rows[0];
    return row ? {
      accountId: row.account_id,
      id: row.id,
      deviceId: row.device_id,
      digest: row.digest,
      scopes: row.scopes,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at
    } : null;
  }

  async touchApiKey(accountId: string, id: string): Promise<void> {
    await this.pool.query("UPDATE api_keys SET last_used_at = now() WHERE account_id = $1 AND id = $2", [accountId, id]);
  }

  async insertApiKey(input: { accountId: string; id: string; name: string; digest: Buffer; scopes: string[]; expiresAt?: string }): Promise<void> {
    await this.pool.query(`
      INSERT INTO api_keys(account_id, id, name, digest, scopes, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [input.accountId, input.id, input.name, input.digest, input.scopes, input.expiresAt ?? null]);
  }

  async listApiKeys(accountId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT id, name, device_id, scopes, created_at, expires_at, last_used_at, revoked_at
      FROM api_keys WHERE account_id = $1 ORDER BY created_at DESC
    `, [accountId]);
    return result.rows;
  }

  async revokeApiKey(accountId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE account_id = $1 AND id = $2",
      [accountId, id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async authorizeApiKeyDevice(accountId: string, keyId: string, deviceId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO devices(account_id, id, name, platform, capabilities)
        VALUES ($1, $2, $3, 'macos', '[]'::jsonb)
        ON CONFLICT (account_id, id) DO NOTHING
      `, [accountId, deviceId, `Continuum ${deviceId.slice(0, 8)}`]);
      const device = await client.query<{ revoked_at: Date | null }>(`
        SELECT revoked_at FROM devices
        WHERE account_id = $1 AND id = $2
        FOR UPDATE
      `, [accountId, deviceId]);
      if (!device.rows[0] || device.rows[0].revoked_at) {
        throw new DeviceRevokedError("device is revoked");
      }
      const credential = await client.query<{ device_id: string }>(`
        UPDATE api_keys SET device_id = COALESCE(device_id, $3)
        WHERE account_id = $1 AND id = $2
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        RETURNING device_id
      `, [accountId, keyId, deviceId]);
      const boundDeviceId = credential.rows[0]?.device_id;
      if (!boundDeviceId) throw new DeviceCredentialError("API key is expired, revoked, or unknown");
      if (boundDeviceId !== deviceId) {
        throw new DeviceCredentialError("API key is bound to a different device");
      }
      await client.query(`
        UPDATE devices SET last_seen_at = now()
        WHERE account_id = $1 AND id = $2 AND revoked_at IS NULL
      `, [accountId, deviceId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async authorizeOAuthDevice(accountId: string, deviceId: string): Promise<void> {
    const result = await this.pool.query<{ revoked_at: Date | null }>(`
      INSERT INTO devices(account_id, id, name, platform, capabilities)
      VALUES ($1, $2, $3, 'macos', '["sync"]'::jsonb)
      ON CONFLICT (account_id, id) DO UPDATE SET
        last_seen_at = CASE WHEN devices.revoked_at IS NULL THEN now() ELSE devices.last_seen_at END
      RETURNING revoked_at
    `, [accountId, deviceId, `Continuum ${deviceId.slice(0, 8)}`]);
    if (!result.rows[0] || result.rows[0].revoked_at) {
      throw new DeviceRevokedError("device is revoked");
    }
  }

  async push(accountId: string, input: SyncPush): Promise<{ acceptedIds: string[]; duplicateIds: string[]; cursor: number }> {
    const operations = [...input.operations].sort((a, b) => a.sequence - b.sequence);
    for (const operation of operations) {
      if (operation.deviceId !== input.deviceId) throw new SyncInputError("operation device does not match the push device");
      try {
        if (parseHlc(operation.hlc).node !== operation.deviceId) throw new Error("HLC node does not match the operation device");
        assertCloudEligibleOperation(operation);
      } catch (error) {
        throw new SyncInputError(error instanceof Error ? error.message : String(error));
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [accountId]);
      await client.query(`
        INSERT INTO devices(account_id, id, name, platform, capabilities)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (account_id, id) DO UPDATE SET
          name = EXCLUDED.name,
          platform = EXCLUDED.platform,
          capabilities = EXCLUDED.capabilities,
          last_seen_at = now()
      `, [
        accountId,
        input.deviceId,
        input.device?.name ?? `Continuum ${input.deviceId.slice(0, 8)}`,
        input.device?.platform ?? "macos",
        JSON.stringify(input.device?.capabilities ?? [])
      ]);
      const deviceResult = await client.query<{ last_sequence: string; last_hlc: string | null; revoked_at: Date | null }>(`
        SELECT last_sequence, last_hlc, revoked_at FROM devices
        WHERE account_id = $1 AND id = $2 FOR UPDATE
      `, [accountId, input.deviceId]);
      const device = deviceResult.rows[0]!;
      if (device.revoked_at) throw new DeviceRevokedError("device is revoked");
      let expected = Number(device.last_sequence) + 1;
      const acceptedIds: string[] = [];
      const duplicateIds: string[] = [];
      let lastAcceptedHlc: string | undefined;
      let previousHlc = device.last_hlc ?? undefined;

      for (const operation of operations) {
        const existing = await client.query<{
          id: string; device_id: string; device_sequence: string; hlc: string; entity_type: string;
          entity_id: string; tombstone: boolean; payload: Record<string, unknown> | null; occurred_at: Date;
        }>(`
          SELECT id, device_id, device_sequence, hlc, entity_type, entity_id, tombstone, payload, occurred_at
          FROM sync_operations
          WHERE account_id = $1 AND (id = $2 OR (device_id = $3 AND device_sequence = $4))
        `, [accountId, operation.id, operation.deviceId, operation.sequence]);
        if (existing.rows.length > 0) {
          const row = existing.rows[0]!;
          if (row.id !== operation.id || row.device_id !== operation.deviceId || Number(row.device_sequence) !== operation.sequence) {
            throw new SyncConflictError(`idempotency conflict at device sequence ${operation.sequence}`);
          }
          const privacyRedactionRetry = operation.tombstone
            && !row.tombstone
            && row.hlc === operation.hlc
            && row.entity_type === operation.entityType
            && row.entity_id === operation.entityId
            && new Date(row.occurred_at).getTime() === Date.parse(operation.occurredAt);
          if (privacyRedactionRetry) {
            // A device may have sent the live operation, lost the response, and
            // then tightened its policy before retrying. Preserve the original
            // append-only row, but create a new server-authored tombstone so
            // every cursor observes the erasure and the original retry can be
            // acknowledged without retransmitting its stale payload.
            await this.insertServerPrivacyTombstone(client, accountId, operation.entityType, operation.entityId);
            duplicateIds.push(operation.id);
            continue;
          }
          const retentionRedactedRetry = !operation.tombstone
            && row.tombstone
            && row.payload === null
            && row.hlc === operation.hlc
            && row.entity_type === operation.entityType
            && row.entity_id === operation.entityId
            && new Date(row.occurred_at).getTime() === Date.parse(operation.occurredAt);
          if (retentionRedactedRetry) {
            // Tightening retention replaces the durable payload with a
            // payload-free tombstone in place. A lost-response retry of the
            // original append is still idempotently acknowledged.
            duplicateIds.push(operation.id);
            continue;
          }
          const identical = row.hlc === operation.hlc
            && row.entity_type === operation.entityType
            && row.entity_id === operation.entityId
            && row.tombstone === operation.tombstone
            && canonicalJson(row.payload ?? undefined) === canonicalJson(operation.payload)
            && new Date(row.occurred_at).getTime() === Date.parse(operation.occurredAt);
          if (!identical) throw new SyncConflictError(`operation ${operation.id} was already used with different data`);
          duplicateIds.push(operation.id);
          continue;
        }
        if (operation.sequence !== expected) {
          throw new SyncConflictError(`device sequence gap: expected ${expected}, received ${operation.sequence}`);
        }
        if (previousHlc && compareHlc(operation.hlc, previousHlc) <= 0) {
          throw new SyncConflictError("device HLC must increase with its sequence");
        }
        const currentPolicy = operation.entityType === "privacy_policy"
          ? undefined
          : await this.accountPrivacyPolicy(client, accountId);
        if (currentPolicy) {
          try {
            assertOperationCompliesWithPrivacyPolicy(operation, currentPolicy);
          } catch (error) {
            throw new SyncInputError(error instanceof Error ? error.message : String(error));
          }
        }
        await this.assertOperationReferences(client, accountId, operation, currentPolicy);
        await this.insertOperation(client, accountId, operation, currentPolicy);
        if (operation.entityType === "privacy_policy") {
          // The HLC winner is authoritative. Re-read it after the upsert instead
          // of assuming that an arriving policy operation won the LWW race.
          await this.applyEventRetentionPolicy(client, accountId, await this.accountPrivacyPolicy(client, accountId));
        }
        expected += 1;
        acceptedIds.push(operation.id);
        lastAcceptedHlc = operation.hlc;
        previousHlc = operation.hlc;
      }

      if (acceptedIds.length > 0 && lastAcceptedHlc) {
        await client.query(`
          UPDATE devices SET last_sequence = $3, last_hlc = $4, last_seen_at = now()
          WHERE account_id = $1 AND id = $2
        `, [accountId, input.deviceId, expected - 1, lastAcceptedHlc]);
      }
      const cursorResult = await client.query<{ cursor: string }>(
        "SELECT COALESCE(max(server_sequence), 0)::text AS cursor FROM sync_operations WHERE account_id = $1",
        [accountId]
      );
      await client.query("COMMIT");
      return { acceptedIds, duplicateIds, cursor: Number(cursorResult.rows[0]!.cursor) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async accountPrivacyPolicy(client: PoolClient, accountId: string): Promise<PrivacyPolicyV1> {
    const result = await client.query<{ payload: Record<string, unknown> | null }>(`
      SELECT payload FROM sync_entities
      WHERE account_id = $1 AND entity_type = 'privacy_policy' AND entity_id = 'current'
        AND NOT tombstone AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `, [accountId]);
    const payload = result.rows[0]?.payload;
    return payload ? PrivacyPolicyV1Schema.parse(payload) : defaultCloudPrivacyPolicy();
  }

  private async liveEntityPayloads(
    client: PoolClient,
    accountId: string,
    entityType: SyncOperation["entityType"],
    entityIds: string[]
  ): Promise<Map<string, Record<string, unknown>>> {
    const ids = [...new Set(entityIds)];
    if (ids.length === 0) return new Map();
    const result = await client.query<{ entity_id: string; payload: Record<string, unknown> | null }>(`
      SELECT entity_id, payload FROM sync_entities
      WHERE account_id = $1 AND entity_type = $2 AND entity_id = ANY($3::text[])
        AND NOT tombstone AND (expires_at IS NULL OR expires_at > now())
    `, [accountId, entityType, ids]);
    return new Map(result.rows.flatMap((row) => row.payload ? [[row.entity_id, row.payload] as const] : []));
  }

  private async assertOperationReferences(
    client: PoolClient,
    accountId: string,
    operation: SyncOperation,
    privacyPolicy?: PrivacyPolicyV1
  ): Promise<void> {
    if (operation.tombstone || !operation.payload || typeof operation.payload !== "object" || Array.isArray(operation.payload)) return;
    const payload = operation.payload as Record<string, unknown>;
    if (operation.entityType === "checkpoint") {
      const projectId = String(payload.projectId ?? "");
      const eventIds = Array.isArray(payload.eventIds) ? payload.eventIds.filter((id): id is string => typeof id === "string") : [];
      const citedIds = ["progress", "blockers", "hypotheses", "decisions", "questions", "entities"].flatMap((field) => {
        const items = Array.isArray(payload[field]) ? payload[field] : [];
        return items.flatMap((item) => item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).eventIds)
          ? ((item as Record<string, unknown>).eventIds as unknown[]).filter((id): id is string => typeof id === "string")
          : []);
      });
      if (eventIds.length === 0 || citedIds.some((id) => !eventIds.includes(id))) {
        throw new SyncInputError("checkpoint evidence must cite its declared input events");
      }
      const events = await this.liveEntityPayloads(client, accountId, "event", eventIds);
      if (events.size !== new Set(eventIds).size) throw new SyncInputError("checkpoint evidence event is unavailable");
      for (const eventId of eventIds) {
        if (String(events.get(eventId)?.projectId ?? "") !== projectId) {
          throw new SyncInputError("checkpoint evidence belongs to a different project");
        }
      }
      return;
    }
    if (operation.entityType === "baseline") {
      const checkpointId = String(payload.checkpointId ?? "");
      const projectId = String(payload.projectId ?? "");
      const checkpoints = await this.liveEntityPayloads(client, accountId, "checkpoint", [checkpointId]);
      if (String(checkpoints.get(checkpointId)?.projectId ?? "") !== projectId) {
        throw new SyncInputError("baseline checkpoint is unavailable for this project");
      }
      return;
    }
    if (operation.entityType === "chat_message") {
      const sessionId = String(payload.sessionId ?? "");
      const sessions = await this.liveEntityPayloads(client, accountId, "chat_session", [sessionId]);
      const session = sessions.get(sessionId);
      if (!session) throw new SyncInputError("chat message session is unavailable");
      if (session.classification === "personal" && privacyPolicy && !privacyPolicy.metadata.personalCloudEligibility) {
        throw new SyncInputError("current privacy policy keeps personal chat local");
      }
      return;
    }
    if (operation.entityType !== "graph_node" && operation.entityType !== "graph_edge") return;

    const checkpointIds = Array.isArray(payload.checkpointIds)
      ? payload.checkpointIds.filter((id): id is string => typeof id === "string")
      : [];
    if (checkpointIds.length === 0) throw new SyncInputError("graph provenance requires a checkpoint");
    const checkpoints = await this.liveEntityPayloads(client, accountId, "checkpoint", checkpointIds);
    if (checkpoints.size !== new Set(checkpointIds).size) throw new SyncInputError("graph checkpoint provenance is unavailable");
    if (operation.entityType === "graph_node") {
      const metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
        ? payload.metadata as Record<string, unknown>
        : {};
      const projectId = String(payload.projectId ?? metadata.projectId ?? "");
      if (!projectId || checkpointIds.some((id) => String(checkpoints.get(id)?.projectId ?? "") !== projectId)) {
        throw new SyncInputError("graph node provenance belongs to a different project");
      }
      return;
    }
    const source = String(payload.source ?? "");
    const target = String(payload.target ?? "");
    const nodes = await this.liveEntityPayloads(client, accountId, "graph_node", [source, target]);
    if (nodes.size !== new Set([source, target]).size) throw new SyncInputError("graph edge endpoint is unavailable");
    const nodeProject = (node: Record<string, unknown> | undefined): string => {
      const metadata = node?.metadata && typeof node.metadata === "object" && !Array.isArray(node.metadata)
        ? node.metadata as Record<string, unknown>
        : {};
      return String(node?.projectId ?? metadata.projectId ?? "");
    };
    const projectId = nodeProject(nodes.get(source));
    if (!projectId || projectId !== nodeProject(nodes.get(target))
      || checkpointIds.some((id) => String(checkpoints.get(id)?.projectId ?? "") !== projectId)) {
      throw new SyncInputError("graph edge references cross-project entities");
    }
  }

  private async insertOperation(
    client: PoolClient,
    accountId: string,
    operation: SyncOperation,
    privacyPolicy?: PrivacyPolicyV1
  ): Promise<void> {
    await this.assertImmutableEntityCollision(client, accountId, operation);
    const tombstoneExpiry = operation.tombstone ? new Date(Date.now() + 30 * 86_400_000).toISOString() : null;
    const eventOccurredAt = operation.entityType === "event" && !operation.tombstone
      && operation.payload && typeof operation.payload === "object"
      && typeof (operation.payload as Record<string, unknown>).occurredAt === "string"
      ? String((operation.payload as Record<string, unknown>).occurredAt)
      : operation.occurredAt;
    const retentionMs = Math.min(24, privacyPolicy?.retentionHours ?? 24) * 3_600_000;
    const eventExpiryMs = operation.entityType === "event"
      ? Math.min(Date.parse(eventOccurredAt) + retentionMs, Date.now() + 86_400_000)
      : null;
    if (eventExpiryMs !== null && !operation.tombstone && eventExpiryMs <= Date.now()) {
      throw new SyncInputError("event is older than the current account retention policy");
    }
    const eventExpiry = eventExpiryMs === null
      ? null
      : new Date(eventExpiryMs).toISOString();
    const expiry = tombstoneExpiry ?? eventExpiry;
    await client.query(`
      INSERT INTO sync_operations(
        account_id, id, device_id, device_sequence, hlc, entity_type, entity_id,
        tombstone, payload, sync_eligible, occurred_at, expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11)
    `, [
      accountId, operation.id, operation.deviceId, operation.sequence, operation.hlc,
      operation.entityType, operation.entityId, operation.tombstone,
      operation.payload === undefined ? null : JSON.stringify(operation.payload), operation.occurredAt, expiry
    ]);
    await client.query(`
      INSERT INTO sync_entities(
        account_id, entity_type, entity_id, hlc, device_id, payload, search_text,
        tombstone, sync_eligible, expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)
      ON CONFLICT (account_id, entity_type, entity_id) DO UPDATE SET
        hlc = EXCLUDED.hlc,
        device_id = EXCLUDED.device_id,
        payload = EXCLUDED.payload,
        search_text = EXCLUDED.search_text,
        tombstone = EXCLUDED.tombstone,
        sync_eligible = true,
        updated_at = now(),
        expires_at = EXCLUDED.expires_at
      WHERE split_part(EXCLUDED.hlc, ':', 1)::numeric > split_part(sync_entities.hlc, ':', 1)::numeric
         OR (
           split_part(EXCLUDED.hlc, ':', 1)::numeric = split_part(sync_entities.hlc, ':', 1)::numeric
           AND split_part(EXCLUDED.hlc, ':', 2)::numeric > split_part(sync_entities.hlc, ':', 2)::numeric
         )
         OR (
           split_part(EXCLUDED.hlc, ':', 1)::numeric = split_part(sync_entities.hlc, ':', 1)::numeric
           AND split_part(EXCLUDED.hlc, ':', 2)::numeric = split_part(sync_entities.hlc, ':', 2)::numeric
           AND EXCLUDED.device_id > sync_entities.device_id
         )
    `, [
      accountId, operation.entityType, operation.entityId, operation.hlc, operation.deviceId,
      operation.payload === undefined ? null : JSON.stringify(operation.payload),
      operation.payload === undefined ? "" : JSON.stringify(operation.payload),
      operation.tombstone, expiry
    ]);
    await client.query(`
      INSERT INTO projection_outbox(account_id, operation_id) VALUES ($1, $2)
      ON CONFLICT (account_id, operation_id) DO NOTHING
    `, [accountId, operation.id]);
  }

  private async insertServerPrivacyTombstone(
    client: PoolClient,
    accountId: string,
    entityType: SyncOperation["entityType"],
    entityId: string
  ): Promise<void> {
    const deviceId = `continuum-cloud-${accountId}`;
    await client.query(`
      INSERT INTO devices(account_id, id, name, platform, capabilities)
      VALUES ($1, $2, 'Continuum Cloud', 'server', '["sync"]'::jsonb)
      ON CONFLICT (account_id, id) DO NOTHING
    `, [accountId, deviceId]);
    const state = await client.query<{ last_sequence: string; last_hlc: string | null }>(`
      SELECT last_sequence, last_hlc FROM devices
      WHERE account_id = $1 AND id = $2 FOR UPDATE
    `, [accountId, deviceId]);
    const entity = await client.query<{ tombstone: boolean; hlc: string }>(`
      SELECT tombstone, hlc FROM sync_entities
      WHERE account_id = $1 AND entity_type = $2 AND entity_id = $3
      FOR UPDATE
    `, [accountId, entityType, entityId]);
    if (entity.rows[0]?.tombstone) return;
    const sequence = Number(state.rows[0]!.last_sequence) + 1;
    const deviceHlc = state.rows[0]?.last_hlc ?? undefined;
    const entityHlc = entity.rows[0]?.hlc;
    const priorHlc = deviceHlc && entityHlc
      ? (compareHlc(deviceHlc, entityHlc) >= 0 ? deviceHlc : entityHlc)
      : deviceHlc ?? entityHlc;
    const operation = SyncOperationSchema.parse({
      version: "1",
      id: randomUUID(),
      deviceId,
      sequence,
      hlc: nextHlc(deviceId, priorHlc),
      entityType,
      entityId,
      tombstone: true,
      occurredAt: new Date().toISOString()
    });
    assertCloudEligibleOperation(operation);
    await this.insertOperation(client, accountId, operation);
    await client.query(`
      UPDATE devices SET last_sequence = $3, last_hlc = $4, last_seen_at = now()
      WHERE account_id = $1 AND id = $2
    `, [accountId, deviceId, sequence, operation.hlc]);
  }

  private async applyEventRetentionPolicy(
    client: PoolClient,
    accountId: string,
    policy: PrivacyPolicyV1
  ): Promise<void> {
    const retentionHours = Math.min(24, Math.max(1, policy.retentionHours));

    // Lock and redact expired live events in bounded batches. Each entity gets
    // a payload-free, cursor-visible tombstone before its historical operation
    // is redacted in place, so devices that already observed the event converge
    // while a newly syncing device can never download data outside the policy.
    for (;;) {
      const stale = await client.query<{ entity_id: string }>(`
        SELECT entity_id FROM sync_entities
        WHERE account_id = $1 AND entity_type = 'event' AND NOT tombstone
          AND COALESCE(NULLIF(payload->>'occurredAt', '')::timestamptz, updated_at)
              + make_interval(hours => $2) <= now()
        ORDER BY entity_id
        FOR UPDATE SKIP LOCKED
        LIMIT 500
      `, [accountId, retentionHours]);
      if (stale.rows.length === 0) break;
      const batchIds = stale.rows.map((row) => row.entity_id);
      for (const entityId of batchIds) {
        await this.insertServerPrivacyTombstone(client, accountId, "event", entityId);
      }
    }

    // Also redact old payload operations whose entity was already tombstoned.
    // They need no second convergence marker, but the stricter policy must
    // still remove their source metadata immediately.
    await client.query(`
      UPDATE sync_operations SET
        tombstone = true,
        payload = NULL,
        expires_at = now() + interval '30 days'
      WHERE account_id = $1 AND entity_type = 'event' AND NOT tombstone
        AND COALESCE(NULLIF(payload->>'occurredAt', '')::timestamptz, occurred_at)
            + make_interval(hours => $2) <= now()
    `, [accountId, retentionHours]);

    // Tightening also shortens the remaining rows immediately. LEAST preserves
    // an already-stricter expiry and the explicit 24-hour term is a hard ceiling.
    await client.query(`
      UPDATE sync_operations AS operation SET expires_at = LEAST(
        operation.expires_at,
        COALESCE(NULLIF(operation.payload->>'occurredAt', '')::timestamptz, operation.occurred_at)
          + make_interval(hours => $2),
        operation.occurred_at + interval '24 hours'
      )
      WHERE operation.account_id = $1 AND operation.entity_type = 'event' AND NOT operation.tombstone
    `, [accountId, retentionHours]);
    await client.query(`
      UPDATE sync_entities AS entity SET expires_at = LEAST(
        entity.expires_at,
        COALESCE(NULLIF(entity.payload->>'occurredAt', '')::timestamptz, entity.updated_at)
          + make_interval(hours => $2),
        entity.updated_at + interval '24 hours'
      )
      WHERE entity.account_id = $1 AND entity.entity_type = 'event' AND NOT entity.tombstone
    `, [accountId, retentionHours]);
  }

  private async assertImmutableEntityCollision(client: PoolClient, accountId: string, operation: SyncOperation): Promise<void> {
    if (!immutableEntityTypes.has(operation.entityType)) return;
    const existing = await client.query<{ payload: Record<string, unknown> | null; tombstone: boolean }>(`
      SELECT payload, tombstone FROM sync_entities
      WHERE account_id = $1 AND entity_type = $2 AND entity_id = $3
      FOR UPDATE
    `, [accountId, operation.entityType, operation.entityId]);
    const row = existing.rows[0];
    assertImmutableEntityValue(operation.entityType, operation.entityId, row, operation);
  }

  async pull(accountId: string, after: number, limit: number, excludeDeviceId?: string): Promise<{ operations: StoredOperation[]; cursor: number; hasMore: boolean }> {
    const result = await this.pool.query(`
      SELECT * FROM sync_operations
      WHERE account_id = $1 AND server_sequence > $2
        AND (expires_at IS NULL OR expires_at > now())
        AND ($4::text IS NULL OR device_id <> $4)
      ORDER BY server_sequence ASC LIMIT $3
    `, [accountId, after, limit + 1, excludeDeviceId ?? null]);
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    let cursor = rows.at(-1) ? Number(rows.at(-1)!.server_sequence) : after;
    if (!hasMore) {
      const tail = await this.pool.query<{ cursor: string }>(`
        SELECT COALESCE(max(server_sequence), $2)::text AS cursor
        FROM sync_operations WHERE account_id = $1 AND server_sequence > $2
      `, [accountId, after]);
      cursor = Math.max(cursor, Number(tail.rows[0]?.cursor ?? after));
    }
    return { operations: rows.map((row) => storedOperation(row)), cursor, hasMore };
  }

  async listDevices(accountId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(`
      SELECT id, name, platform, capabilities, last_sequence, last_hlc, last_seen_at, revoked_at
      FROM devices WHERE account_id = $1 ORDER BY last_seen_at DESC
    `, [accountId]);
    return result.rows;
  }

  async entityPayloads(accountId: string, entityType: string, limit = 200): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query<{ payload: Record<string, unknown> }>(`
      SELECT payload FROM sync_entities
      WHERE account_id = $1 AND entity_type = $2 AND NOT tombstone
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY updated_at DESC LIMIT $3
    `, [accountId, entityType, Math.min(500, Math.max(1, limit))]);
    return result.rows.map((row) => row.payload);
  }

  async entityPayload(accountId: string, entityType: string, entityId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<{ payload: Record<string, unknown> }>(`
      SELECT payload FROM sync_entities
      WHERE account_id = $1 AND entity_type = $2 AND entity_id = $3 AND NOT tombstone
        AND (expires_at IS NULL OR expires_at > now())
    `, [accountId, entityType, entityId]);
    return result.rows[0]?.payload ?? null;
  }

  async entityCounts(accountId: string): Promise<Record<string, number>> {
    const result = await this.pool.query<{ entity_type: string; count: string }>(`
      SELECT entity_type, count(*)::text AS count FROM sync_entities
      WHERE account_id = $1 AND NOT tombstone AND (expires_at IS NULL OR expires_at > now())
      GROUP BY entity_type
    `, [accountId]);
    return Object.fromEntries(result.rows.map((row) => [row.entity_type, Number(row.count)]));
  }

  async writeServerEntity(
    accountId: string,
    entityType: SyncOperation["entityType"],
    entityId: string,
    payload: Record<string, unknown>,
    tombstone = false
  ): Promise<SyncOperation> {
    const deviceId = `continuum-cloud-${accountId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [accountId]);
      await client.query(`
        INSERT INTO devices(account_id, id, name, platform, capabilities)
        VALUES ($1, $2, 'Continuum Cloud', 'server', '["sync"]'::jsonb)
        ON CONFLICT (account_id, id) DO NOTHING
      `, [accountId, deviceId]);
      const state = await client.query<{ last_sequence: string; last_hlc: string | null }>(`
        SELECT last_sequence, last_hlc FROM devices WHERE account_id = $1 AND id = $2 FOR UPDATE
      `, [accountId, deviceId]);
      const entityClock = await client.query<{ hlc: string }>(`
        SELECT hlc FROM sync_entities
        WHERE account_id = $1 AND entity_type = $2 AND entity_id = $3
        FOR UPDATE
      `, [accountId, entityType, entityId]);
      const sequence = Number(state.rows[0]!.last_sequence) + 1;
      const occurredAt = new Date().toISOString();
      const deviceHlc = state.rows[0]?.last_hlc ?? undefined;
      const entityHlc = entityClock.rows[0]?.hlc;
      const priorHlc = deviceHlc && entityHlc
        ? (compareHlc(deviceHlc, entityHlc) >= 0 ? deviceHlc : entityHlc)
        : deviceHlc ?? entityHlc;
      const operation: SyncOperation = {
        version: "1",
        id: randomUUID(),
        deviceId,
        sequence,
        hlc: nextHlc(deviceId, priorHlc),
        entityType,
        entityId,
        payload,
        tombstone,
        occurredAt
      };
      assertCloudEligibleOperation(operation);
      const currentPolicy = operation.entityType === "privacy_policy"
        ? undefined
        : await this.accountPrivacyPolicy(client, accountId);
      if (currentPolicy) {
        try {
          assertOperationCompliesWithPrivacyPolicy(operation, currentPolicy);
        } catch (error) {
          throw new SyncInputError(error instanceof Error ? error.message : String(error));
        }
      }
      await this.assertOperationReferences(client, accountId, operation, currentPolicy);
      await this.insertOperation(client, accountId, operation, currentPolicy);
      await client.query(`
        UPDATE devices SET last_sequence = $3, last_hlc = $4, last_seen_at = now()
        WHERE account_id = $1 AND id = $2
      `, [accountId, deviceId, sequence, operation.hlc]);
      if (operation.entityType === "privacy_policy") {
        await this.applyEventRetentionPolicy(client, accountId, await this.accountPrivacyPolicy(client, accountId));
      }
      await client.query("COMMIT");
      return operation;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeDevice(accountId: string, deviceId: string): Promise<boolean> {
    const result = await this.pool.query<{ revoked: boolean }>(`
      WITH revoked_device AS (
        UPDATE devices SET revoked_at = COALESCE(revoked_at, now())
        WHERE account_id = $1 AND id = $2
        RETURNING account_id, id
      ), revoked_credentials AS (
        UPDATE api_keys AS key SET revoked_at = COALESCE(key.revoked_at, now())
        FROM revoked_device AS device
        WHERE key.account_id = device.account_id AND key.device_id = device.id
        RETURNING key.id
      )
      SELECT EXISTS(SELECT 1 FROM revoked_device) AS revoked
    `, [accountId, deviceId]);
    return result.rows[0]?.revoked ?? false;
  }

  async purgeExpired(): Promise<{ operations: number; entities: number }> {
    // Event rows are never projected and must disappear at the 24-hour boundary.
    // For projected tombstones, retain both the materialized row and its source
    // operation until Neo4j has acknowledged the outbox job. Deleting an
    // operation first would cascade-delete that job and could resurrect stale
    // graph state indefinitely after an outage.
    const entities = await this.pool.query(`
      DELETE FROM sync_entities AS entity
      WHERE entity.expires_at <= now()
        AND (
          entity.entity_type = 'event'
          OR NOT EXISTS (
            SELECT 1
            FROM sync_operations AS operation
            JOIN projection_outbox AS outbox
              ON outbox.account_id = operation.account_id
             AND outbox.operation_id = operation.id
            WHERE operation.account_id = entity.account_id
              AND operation.entity_type = entity.entity_type
              AND operation.entity_id = entity.entity_id
              AND outbox.processed_at IS NULL
          )
        )
    `);
    const operations = await this.pool.query(`
      DELETE FROM sync_operations AS operation
      WHERE operation.expires_at <= now()
        AND (
          operation.entity_type = 'event'
          OR NOT EXISTS (
            SELECT 1 FROM projection_outbox AS outbox
            WHERE outbox.account_id = operation.account_id
              AND outbox.operation_id = operation.id
              AND outbox.processed_at IS NULL
          )
        )
    `);
    return { operations: operations.rowCount ?? 0, entities: entities.rowCount ?? 0 };
  }

  async status(accountId: string): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{
      cursor: string; devices: string; pending: string; degraded: boolean | null; last_error: string | null; last_projected_at: Date | null;
    }>(`
      SELECT
        (SELECT COALESCE(max(server_sequence), 0)::text FROM sync_operations WHERE account_id = $1) AS cursor,
        (SELECT count(*)::text FROM devices WHERE account_id = $1 AND revoked_at IS NULL) AS devices,
        (SELECT count(*)::text FROM projection_outbox WHERE account_id = $1 AND processed_at IS NULL) AS pending,
        ps.degraded, ps.last_error, ps.last_projected_at
      FROM (SELECT 1) seed LEFT JOIN projection_state ps ON ps.account_id = $1
    `, [accountId]);
    const row = result.rows[0]!;
    const pending = Number(row.pending);
    return {
      cursor: Number(row.cursor),
      activeDevices: Number(row.devices),
      projection: {
        degraded: Boolean(row.degraded) || pending > 0,
        pending,
        lastError: row.last_error,
        lastProjectedAt: asIso(row.last_projected_at)
      }
    };
  }

  async leaseProjectionJobs(limit = 50): Promise<ProjectionJob[]> {
    const result = await this.pool.query<{
      outbox_id: string; account_id: string; operation_id: string; entity_type: string;
      entity_id: string; tombstone: boolean; payload: Record<string, unknown> | null;
    }>(`
      WITH jobs AS (
        SELECT id FROM projection_outbox
        WHERE processed_at IS NULL AND next_attempt_at <= now()
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1
      )
      UPDATE projection_outbox o SET
        attempts = attempts + 1,
        next_attempt_at = now() + interval '30 seconds'
      FROM jobs, sync_operations s, sync_entities e
      WHERE o.id = jobs.id AND s.account_id = o.account_id AND s.id = o.operation_id
        AND e.account_id = s.account_id AND e.entity_type = s.entity_type AND e.entity_id = s.entity_id
      RETURNING o.id::text AS outbox_id, o.account_id, o.operation_id,
        e.entity_type, e.entity_id, e.tombstone, e.payload
    `, [limit]);
    return result.rows.map((row) => ({
      outboxId: Number(row.outbox_id), accountId: row.account_id, operationId: row.operation_id,
      entityType: row.entity_type, entityId: row.entity_id, tombstone: row.tombstone, payload: row.payload
    }));
  }

  async projectionSucceeded(job: ProjectionJob): Promise<void> {
    await this.pool.query(`
      WITH completed AS (
        UPDATE projection_outbox SET processed_at = now(), last_error = NULL
        WHERE id = $2 AND account_id = $1
        RETURNING id
      ), outstanding AS (
        SELECT
          count(*)::integer AS pending,
          (
            SELECT last_error FROM projection_outbox
            WHERE account_id = $1 AND processed_at IS NULL AND id <> $2 AND last_error IS NOT NULL
            ORDER BY id DESC LIMIT 1
          ) AS last_error
        FROM projection_outbox
        WHERE account_id = $1 AND processed_at IS NULL AND id <> $2
      )
      INSERT INTO projection_state(account_id, last_projected_at, last_error, degraded)
      SELECT $1, now(), outstanding.last_error, outstanding.pending > 0 FROM outstanding
      ON CONFLICT (account_id) DO UPDATE SET
        last_projected_at = now(),
        last_error = CASE
          WHEN EXCLUDED.degraded THEN COALESCE(EXCLUDED.last_error, projection_state.last_error)
          ELSE NULL
        END,
        degraded = EXCLUDED.degraded,
        updated_at = now()
    `, [job.accountId, job.outboxId]);
  }

  async projectionFailed(job: ProjectionJob, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.pool.query("UPDATE projection_outbox SET last_error = $2 WHERE id = $1", [job.outboxId, message.slice(0, 2_000)]);
    await this.pool.query(`
      INSERT INTO projection_state(account_id, last_error, degraded)
      VALUES ($1, $2, true)
      ON CONFLICT (account_id) DO UPDATE SET last_error = EXCLUDED.last_error, degraded = true, updated_at = now()
    `, [job.accountId, message.slice(0, 2_000)]);
  }

  async reconcileProjectionState(accountIds: string[]): Promise<void> {
    const uniqueAccountIds = [...new Set(accountIds)];
    if (uniqueAccountIds.length === 0) return;
    await this.pool.query(`
      WITH requested(account_id) AS (
        SELECT unnest($1::uuid[])
      ), outstanding AS (
        SELECT requested.account_id,
          count(outbox.id) FILTER (WHERE outbox.processed_at IS NULL)::integer AS pending,
          (
            SELECT candidate.last_error FROM projection_outbox AS candidate
            WHERE candidate.account_id = requested.account_id
              AND candidate.processed_at IS NULL AND candidate.last_error IS NOT NULL
            ORDER BY candidate.id DESC LIMIT 1
          ) AS last_error
        FROM requested
        LEFT JOIN projection_outbox AS outbox ON outbox.account_id = requested.account_id
        GROUP BY requested.account_id
      )
      INSERT INTO projection_state(account_id, last_error, degraded)
      SELECT account_id, last_error, pending > 0 FROM outstanding
      ON CONFLICT (account_id) DO UPDATE SET
        last_error = CASE
          WHEN EXCLUDED.degraded THEN COALESCE(EXCLUDED.last_error, projection_state.last_error)
          ELSE NULL
        END,
        degraded = EXCLUDED.degraded,
        updated_at = now()
    `, [uniqueAccountIds]);
  }

  async resetProjectionOutbox(): Promise<void> {
    await this.pool.query(`
      UPDATE projection_outbox SET processed_at = NULL, next_attempt_at = now(), last_error = NULL
    `);
    await this.pool.query(`
      UPDATE projection_state SET degraded = true, last_error = 'projection rebuild requested', updated_at = now()
    `);
  }
}
