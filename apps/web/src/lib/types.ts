export type HealthStatus = "ready" | "available" | "degraded" | "unavailable" | "unknown" | "disconnected";

export interface ProjectSummary {
  id: string;
  name: string;
  path?: string;
}

export interface ActiveProjectLease {
  version: "1";
  projectId: string;
  projectName: string;
  source: "vscode" | "terminal" | "git" | "folder" | "manual";
  confidence: number;
  issuedAt: string;
  expiresAt: string;
  deviceId: string;
}

export interface EvidenceItem {
  text: string;
  eventIds: string[];
}

export interface BlockerItem extends EvidenceItem {
  status: "open" | "resolved";
}

export interface HypothesisItem extends EvidenceItem {
  status: "active" | "supported" | "disproven";
}

export interface Entity {
  kind: string;
  key: string;
  label: string;
  eventIds: string[];
}

export interface Checkpoint {
  id: string;
  projectId: string;
  goal: string;
  focus: string;
  summary: string;
  progress: EvidenceItem[];
  blockers: BlockerItem[];
  hypotheses: HypothesisItem[];
  decisions: EvidenceItem[];
  questions: EvidenceItem[];
  entities: Entity[];
  importance: number;
  confidence: number;
  provider: string;
  model: string;
  createdAt: string;
}

export interface ActivityItem {
  id: string;
  timestamp?: string;
  occurredAt?: string;
  source: string;
  eventType: string;
  title: string;
  relevance?: string | { decision?: string; reason?: string };
}

export interface EngineState {
  revision: number;
  connected: boolean;
  capturePaused: boolean;
  projectId: string | null;
  activeProject: ProjectSummary | null;
  activeProjectLease?: ActiveProjectLease | null;
  currentCheckpoint: Checkpoint | null;
  recentActivity: ActivityItem[];
  pendingEvents: number;
  eventCount: number;
  checkpointCount: number;
  collectorNames: string[];
  provider: {
    provider: string;
    model: string;
    status: HealthStatus;
    message?: string;
    cloudActive: boolean;
  };
  retrieval: {
    mode: string;
    degraded: boolean;
    message?: string;
    checkpointCount: number;
    graphNodeCount: number;
    graphEdgeCount: number;
  };
  sync?: SyncStatus;
}

export type PrivacySource = "osApps" | "osWindows" | "approvedFolders" | "vscode" | "terminal" | "git" | "chrome";
export type PrivacyMetadata = "relativeFilePaths" | "urlHosts" | "urlPaths" | "commandNames" | "commandFlagNames" | "personalMetadata" | "confidentialLocalCollection" | "personalCloudEligibility";

export interface PrivacyPolicy {
  version: "1";
  revision: number;
  updatedAt: string;
  sources: Record<PrivacySource, boolean>;
  metadata: Record<PrivacyMetadata, boolean>;
  retentionHours: number;
  allowedDomains: string[];
  ignoredDomains: string[];
  ignoredPathPatterns: string[];
  immutableProtections: {
    secretDetection: true;
    attributeAllowlist: true;
    prohibitedContentExclusion: true;
    confidentialCloudBlock: true;
  };
}

export interface PrivacyAuditEntry {
  id: string;
  occurredAt: string;
  source: string;
  rule: string;
  decision: "accepted" | "rejected" | "local_only" | "stripped";
  count: number;
  label?: string;
}

export interface PrivacyAuditResponse {
  audit: PrivacyAuditEntry[];
  accepted?: number;
  droppedSecrets?: number;
  keptLocal?: number;
  expired?: number;
}

export interface GraphNode {
  id: string;
  kind: "project" | "task" | "checkpoint" | "file" | "commit" | "url" | "error" | "blocker" | "decision" | "concept" | string;
  label: string;
  status?: string;
  subtitle?: string;
  projectId?: string;
  checkpointIds: string[];
  importance?: number;
  createdAt?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  checkpointIds: string[];
  directed?: boolean;
}

export interface GraphSnapshot {
  version: "1";
  generatedAt: string;
  projectId?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  cursor?: string | null;
  projection?: { status: HealthStatus; lag?: number; message?: string };
}

export interface GraphQuery {
  projectId?: string;
  query?: string;
  nodeKinds?: string[];
  relations?: string[];
  aroundNodeId?: string;
  hops?: 0 | 1 | 2;
  cursor?: string;
  limit?: number;
}

export interface Citation {
  id: string;
  kind: "checkpoint" | "file" | "commit" | "blocker" | "decision" | "entity" | string;
  label: string;
  detail?: string;
}

export interface ContextAction {
  id: string;
  type: "search_context" | "get_diff" | "select_project" | "create_checkpoint" | "ack_baseline";
  label: string;
  state: "proposed" | "confirmed" | "running" | "completed" | "failed" | "cancelled";
  requiresConfirmation: boolean;
  input?: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  citations: Citation[];
  hypotheses?: string[];
  actions?: ContextAction[];
}

export interface ChatSession {
  id: string;
  projectId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  classification?: "public" | "personal" | "confidential";
  syncEligibility?: "cloud_eligible" | "local_only";
  messages?: ChatMessage[];
}

export type ChatRunEvent =
  | { type: "start"; runId: string; sessionId: string }
  | { type: "delta"; runId: string; text: string }
  | { type: "citation"; runId: string; citation: Citation }
  | { type: "hypothesis"; runId: string; text: string }
  | { type: "action"; runId: string; action: ContextAction }
  | { type: "complete"; runId: string; message: ChatMessage }
  | { type: "cancelled"; runId: string }
  | { type: "error"; runId?: string; code: string; message: string };

export interface TimelineResponse {
  checkpoints: Checkpoint[];
  cursor?: string | null;
}

export interface Device {
  id: string;
  name: string;
  platform: string;
  lastSeenAt?: string;
  lastSyncAt?: string;
  revokedAt?: string;
  collectors?: Array<{ name: string; status: HealthStatus; message?: string }>;
}

export interface SyncStatus {
  status: HealthStatus | "offline" | "syncing";
  lastSyncAt?: string;
  pendingOperations?: number;
  message?: string;
  projection?: { status: HealthStatus; lag?: number; message?: string };
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface CreatedApiKey extends ApiKeyRecord {
  secret: string;
}

export interface RemoteMcpStatus {
  url?: string;
  oauthMetadataUrl?: string;
  status: HealthStatus | "unconfigured";
  message?: string;
}

export interface ModelSettings {
  activeCheckpointProvider: "apple" | "ollama" | "openai";
  activeChatProvider?: "apple" | "ollama" | "openai";
  ollamaModel: string;
  openaiModel: string;
  appleModel?: string;
}

export interface ModelSettingsResponse {
  settings: ModelSettings;
  presets: string[];
  ollamaModels: string[];
  providerHealth: Record<string, HealthStatus | { status: HealthStatus; detail?: string }>;
}
