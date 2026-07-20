import {
  ChatMessageV1Schema,
  ChatSessionV1Schema,
  CheckpointV1Schema,
  GraphEdgeV1Schema,
  GraphNodeV1Schema,
  SyncOperationV1Schema,
  type SyncOperationV1
} from "@continuum/contracts";
import { normalizeSyncUrl, type RuntimeConfig } from "../runtime.js";
import type { ContinuumDatabase } from "../db/database.js";
import { applyPrivacyGate, cloudEligible } from "../pipeline/privacy.js";

export interface SyncStatus {
  configured: boolean;
  authenticated: boolean;
  connected: boolean;
  syncing: boolean;
  pendingOperations: number;
  cursor: string | null;
  lastPushAt?: string;
  lastPullAt?: string;
  lastError?: string;
  endpoint?: string;
}

interface PushResponse {
  acceptedIds?: unknown;
  duplicateIds?: unknown;
  cursor?: unknown;
}

interface PullResponse {
  operations?: unknown;
  nextCursor?: unknown;
  hasMore?: unknown;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export class SyncClient {
  private timer?: NodeJS.Timeout;
  private running?: Promise<SyncStatus>;
  private connected = false;
  private lastPushAt?: string;
  private lastPullAt?: string;
  private lastError?: string;
  private syncUrl?: string;
  private syncToken?: string;

  constructor(
    private readonly database: ContinuumDatabase,
    config: Pick<RuntimeConfig, "syncUrl" | "syncToken">
  ) {
    this.syncUrl = normalizeSyncUrl(config.syncUrl ?? database.syncEndpoint());
    this.syncToken = config.syncToken?.trim() || undefined;
    if (this.syncUrl && this.syncUrl !== database.syncEndpoint()) database.setSyncEndpoint(this.syncUrl);
  }

  configure(input: { endpoint?: string; accessToken?: string; clearCredential?: boolean }): SyncStatus {
    let nextSyncUrl = this.syncUrl;
    let nextSyncToken = this.syncToken;
    if (input.endpoint !== undefined) {
      nextSyncUrl = normalizeSyncUrl(input.endpoint);
    }
    if (input.clearCredential) nextSyncToken = undefined;
    if (input.accessToken !== undefined) {
      const accessToken = input.accessToken.trim();
      if (accessToken.length < 12 || accessToken.length > 16_384 || /[\r\n]/.test(accessToken)) {
        throw new Error("Invalid synchronization access token");
      }
      nextSyncToken = accessToken;
    }
    if (!nextSyncUrl && input.accessToken !== undefined) throw new Error("Synchronization endpoint is required");
    if (!nextSyncUrl) nextSyncToken = undefined;
    this.syncUrl = nextSyncUrl;
    this.syncToken = nextSyncToken;
    if (input.endpoint !== undefined) this.database.setSyncEndpoint(this.syncUrl);
    this.connected = false;
    this.lastError = undefined;
    if (this.syncUrl && this.syncToken) this.start(10_000, false);
    else this.close();
    return this.status();
  }

  start(intervalMs = 10_000, reconnectImmediately = true): void {
    if (!this.syncUrl || !this.syncToken || this.timer) return;
    if (reconnectImmediately) void this.reconnect();
    this.timer = setInterval(() => void this.reconnect(), Math.max(2_000, intervalMs));
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): SyncStatus {
    const cursor = this.database.syncCursor();
    return {
      configured: Boolean(this.syncUrl),
      authenticated: Boolean(this.syncToken),
      connected: this.connected,
      syncing: Boolean(this.running),
      pendingOperations: this.database.pendingSyncOperations(500).length,
      cursor,
      ...(this.lastPushAt ? { lastPushAt: this.lastPushAt } : {}),
      ...(this.lastPullAt ? { lastPullAt: this.lastPullAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.syncUrl ? { endpoint: this.syncUrl } : {})
    };
  }

  reconnect(): Promise<SyncStatus> {
    if (!this.syncUrl || !this.syncToken) return Promise.resolve(this.status());
    if (this.running) return this.running;
    this.running = this.synchronize().finally(() => { this.running = undefined; });
    return this.running;
  }

  async devices(): Promise<unknown> {
    if (!this.syncUrl || !this.syncToken) return { devices: [], sync: this.status() };
    return this.request("/v1/sync/devices", "GET");
  }

  async revokeDevice(id: string): Promise<void> {
    if (!this.syncUrl || !this.syncToken) throw new Error("Remote synchronization is not configured");
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(id)) throw new Error("Invalid device ID");
    await this.request(`/v1/sync/devices/${encodeURIComponent(id)}`, "DELETE");
  }

  private async request(path: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${this.syncUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.syncToken}`,
          "content-type": "application/json"
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`remote returned HTTP ${response.status}`);
      if (response.status === 204) return undefined;
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private tombstone(operation: SyncOperationV1): SyncOperationV1 {
    return SyncOperationV1Schema.parse({
      version: "1",
      id: operation.id,
      deviceId: operation.deviceId,
      sequence: operation.sequence,
      hlc: operation.hlc,
      entityType: operation.entityType,
      entityId: operation.entityId,
      tombstone: true,
      occurredAt: operation.occurredAt
    });
  }

  private revalidatePendingOperation(operation: SyncOperationV1): SyncOperationV1 {
    if (operation.tombstone) return operation;
    const policy = this.database.getPrivacyPolicy();
    if (operation.entityType === "event") {
      const outcome = applyPrivacyGate(operation.payload, policy);
      if (!outcome.accepted || !cloudEligible(outcome.event)) return this.tombstone(operation);
      return SyncOperationV1Schema.parse({ ...operation, payload: outcome.event });
    }
    if (operation.entityType === "chat_session") {
      const session = ChatSessionV1Schema.parse(operation.payload);
      const eligible = session.classification === "public"
        || (session.classification === "personal" && policy.metadata.personalCloudEligibility);
      if (!eligible || session.syncEligibility !== "cloud_eligible") return this.tombstone(operation);
    }
    if (operation.entityType === "chat_message") {
      const message = ChatMessageV1Schema.parse(operation.payload);
      const session = this.database.chatSession(message.sessionId);
      const eligible = session?.classification === "public"
        || (session?.classification === "personal" && policy.metadata.personalCloudEligibility);
      if (!eligible || message.syncEligibility !== "cloud_eligible") return this.tombstone(operation);
    }
    if (operation.entityType === "checkpoint") {
      const checkpoint = CheckpointV1Schema.parse(operation.payload);
      if (!this.database.checkpointsCloudEligible([checkpoint.id])) return this.tombstone(operation);
    }
    if (operation.entityType === "graph_node") {
      const node = GraphNodeV1Schema.parse(operation.payload);
      if (!this.database.checkpointsCloudEligible(node.checkpointIds)) return this.tombstone(operation);
    }
    if (operation.entityType === "graph_edge") {
      const edge = GraphEdgeV1Schema.parse(operation.payload);
      if (!this.database.checkpointsCloudEligible(edge.checkpointIds)) return this.tombstone(operation);
    }
    if (operation.entityType === "baseline") {
      const payload = operation.payload as { checkpointId?: unknown };
      if (typeof payload?.checkpointId !== "string" || !this.database.checkpointsCloudEligible([payload.checkpointId])) return this.tombstone(operation);
    }
    return operation;
  }

  private async synchronize(): Promise<SyncStatus> {
    try {
      const deviceId = this.database.deviceId();
      // Materialize the default policy before taking the first outbox page so
      // its initial synchronization operation cannot be stranded behind it.
      this.database.getPrivacyPolicy();
      for (let page = 0; page < 10; page += 1) {
        const operations = this.database.pendingSyncOperations(200).map((operation) => {
          const revalidated = this.revalidatePendingOperation(operation);
          if (JSON.stringify(revalidated) !== JSON.stringify(operation)) this.database.updatePendingSyncOperation(revalidated);
          return revalidated;
        });
        if (operations.length === 0) break;
        const response = await this.request("/v1/sync/push", "POST", {
          deviceId,
          device: {
            name: `Continuum Mac ${deviceId.slice(0, 8)}`,
            platform: "macos",
            capabilities: this.database.collectorNames().slice(0, 32)
          },
          operations
        }) as PushResponse;
        const acknowledged = [...stringArray(response.acceptedIds), ...stringArray(response.duplicateIds)];
        if (acknowledged.length === 0) throw new Error("remote did not acknowledge the sync batch");
        this.database.acknowledgeSyncOperations(acknowledged);
        this.lastPushAt = new Date().toISOString();
        if (operations.length < 200) break;
      }

      let cursor = Number(this.database.syncCursor() ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
      for (let page = 0; page < 10; page += 1) {
        const response = await this.request("/v1/sync/pull", "POST", { deviceId, cursor, limit: 500 }) as PullResponse;
        const rawOperations = Array.isArray(response.operations) ? response.operations : [];
        const operations: SyncOperationV1[] = rawOperations.map((operation) => {
          const record = operation && typeof operation === "object" ? operation as Record<string, unknown> : {};
          return SyncOperationV1Schema.parse({
            version: record.version,
            id: record.id,
            deviceId: record.deviceId,
            sequence: record.sequence,
            hlc: record.hlc,
            entityType: record.entityType,
            entityId: record.entityId,
            ...(record.payload === undefined ? {} : { payload: record.payload }),
            tombstone: record.tombstone,
            occurredAt: record.occurredAt
          });
        });
        this.database.applySyncOperations(operations);
        const nextCursor = typeof response.nextCursor === "number" && Number.isSafeInteger(response.nextCursor) && response.nextCursor >= 0
          ? response.nextCursor
          : cursor;
        if (nextCursor !== cursor) this.database.setSyncCursor(String(nextCursor));
        cursor = nextCursor;
        this.lastPullAt = new Date().toISOString();
        if (response.hasMore !== true) break;
      }
      this.connected = true;
      this.lastError = undefined;
    } catch (error) {
      this.connected = false;
      const message = error instanceof Error ? error.message : "synchronization failed";
      this.lastError = message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 240);
    }
    return this.status();
  }
}
