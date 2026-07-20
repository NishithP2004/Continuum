import { z } from "zod";
import {
  ChatMessageV1Schema,
  ChatSessionV1Schema,
  CheckpointV1Schema,
  GraphEdgeV1Schema,
  GraphNodeV1Schema,
  ModelSettingsSchema,
  PrivacyPolicyV1Schema,
  ProjectSyncPayloadV1Schema,
  type PrivacyPolicyV1
} from "@continuum/contracts";
import type { SyncOperation } from "./contracts.js";

const forbiddenKeys = /^(?:body|bodies|content|contents|document|documentBody|documentText|pageContent|transcript|terminalOutput|output|stdout|stderr|clipboard|cookie|cookies|userinfo|query|fragment|environment|environmentValue|env|patch|blob|remote|credentials?|authorization|rawCommand|fileContents?)$/i;
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\bctm_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{32,64}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*[^\s,;]{6,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
];

const attributeAllowlist = {
  vscode: new Set(["file", "path", "relativePath", "languageId", "workspace", "windowFocused", "action", "windowId"]),
  terminal: new Set(["executable", "subcommand", "commandShape", "flags", "argCount", "cwd", "projectName", "durationMs", "exitCode", "termProgram", "windowId"]),
  git: new Set(["sha", "branch", "subject", "files", "operation", "windowId"]),
  chrome: new Set(["url", "origin", "path", "host", "hostname", "windowFocused", "windowId"]),
  os: new Set(["bundleId", "appName", "action", "windowTitle", "relativePath", "changeKind", "approvedRootId", "windowId"])
} as const;

const commonAttributes = new Set(["rule", "count"]);
const booleanAttributes = new Set(["windowFocused"]);
const numericAttributes = new Set(["argCount", "durationMs", "exitCode", "count"]);
const stringArrayAttributes = new Set(["flags", "files"]);
const scalarAttribute = z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()]);
const attributeValue = z.union([scalarAttribute, z.array(scalarAttribute).max(32)]);
const EventPayloadSchema = z.object({
  version: z.literal("2"),
  id: z.string().uuid(),
  deviceId: z.string().min(8).max(128),
  occurredAt: z.string().datetime({ offset: true }),
  hlc: z.string().regex(/^\d{10,20}:[0-9]{1,10}:[A-Za-z0-9._:-]{1,128}$/),
  source: z.enum(["vscode", "terminal", "git", "chrome", "os"]),
  eventType: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/),
  projectId: z.string().uuid().optional(),
  projectLocator: z.object({
    localAlias: z.string().max(256).optional(),
    repositoryFingerprint: z.string().regex(/^[a-f0-9]{16,128}$/).optional()
  }).strict().optional(),
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/).optional(),
  title: z.string().max(256),
  attributes: z.record(z.string().min(1).max(64), attributeValue),
  privacy: z.object({
    classification: z.enum(["public", "personal", "confidential", "secret"]),
    rules: z.array(z.string().max(96)).max(32)
  }).strict(),
  relevance: z.object({
    decision: z.enum(["keep", "uncertain"]),
    reason: z.string().max(256)
  }).strict(),
  confidence: z.number().min(0).max(1),
  dedupeKey: z.string().max(512).optional(),
  policyVersion: z.number().int().positive(),
  syncEligibility: z.literal("cloud_eligible")
}).strict();

const BaselinePayloadSchema = z.object({
  projectId: z.string().uuid(),
  checkpointId: z.string().min(8).max(768)
}).strict();

const DevicePayloadSchema = z.object({
  displayName: z.string().min(1).max(128).optional(),
  lastSeenAt: z.string().datetime({ offset: true }).optional(),
  revokedAt: z.string().datetime({ offset: true }).nullable().optional(),
  platform: z.string().min(1).max(64).optional(),
  capabilities: z.array(z.string().min(1).max(64)).max(32).optional()
}).strict();

function assertTypedEntityPayload(operation: SyncOperation): void {
  if (operation.tombstone) return;
  const schema = operation.entityType === "checkpoint" ? CheckpointV1Schema
    : operation.entityType === "baseline" ? BaselinePayloadSchema
      : operation.entityType === "privacy_policy" ? PrivacyPolicyV1Schema
        : operation.entityType === "settings" ? ModelSettingsSchema
          : operation.entityType === "chat_session" ? ChatSessionV1Schema
            : operation.entityType === "chat_message" ? ChatMessageV1Schema
              : operation.entityType === "graph_node" ? GraphNodeV1Schema
                : operation.entityType === "graph_edge" ? GraphEdgeV1Schema
                  : operation.entityType === "project" ? ProjectSyncPayloadV1Schema
                    : operation.entityType === "device" ? DevicePayloadSchema
                      : undefined;
  if (schema) schema.parse(operation.payload);
}

function findUnsafeUrl(value: string): string | undefined {
  const candidates = value.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const candidate of candidates) {
    const trimmed = candidate.replace(/[),.;!?]+$/, "");
    try {
      const parsed = new URL(trimmed);
      if (parsed.username || parsed.password) return "userinfo";
      if (parsed.search) return "query";
      if (parsed.hash) return "fragment";
    } catch {
      return "invalid_url";
    }
  }
  return undefined;
}

export function assertSafeCloudText(value: string, label = "text"): void {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`cloud payload rejected control characters at ${label}`);
  }
  if (secretPatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`cloud payload rejected by immutable secret rule at ${label}`);
  }
  if (/(?:^|\s)\/(?:Users|home|private|etc|var|tmp|opt|Applications|System|Library|Volumes)\/[^\s]+/.test(value)
    || /(?:^|\s)[A-Za-z]:\\[^\s]+/.test(value)) {
    throw new Error(`cloud payload rejected absolute path at ${label}`);
  }
  const unsafeUrl = findUnsafeUrl(value);
  if (unsafeUrl) throw new Error(`cloud payload rejected URL ${unsafeUrl} at ${label}`);
}

function inspect(value: unknown, path: string[] = []): void {
  if (typeof value === "string") {
    assertSafeCloudText(value, path.join(".") || "payload");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const safeKey = /^[A-Za-z][A-Za-z0-9_.:-]{0,64}$/.test(key) && !secretPatterns.some((pattern) => pattern.test(key))
      ? key
      : "field";
    assertSafeCloudText(key, `${path.join(".") || "payload"}.field_name`);
    if (forbiddenKeys.test(key)) throw new Error(`cloud payload contains prohibited field: ${safeKey}`);
    inspect(nested, [...path, safeKey]);
  }
}

function assertRelativePath(value: string, label: string): void {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.startsWith("~/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`cloud event contains a non-relative path at ${label}`);
  }
  if (normalized.split("/").includes("..")) throw new Error(`cloud event contains path traversal at ${label}`);
  if (/(?:^|\/)\.env(?:\.|$)/i.test(normalized)) throw new Error(`cloud event contains a prohibited environment path at ${label}`);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function assertUrlMetadata(key: string, values: string[]): void {
  for (const value of values) {
    if (key === "url" || key === "origin") {
      let parsed: URL;
      try { parsed = new URL(value); } catch { throw new Error(`cloud event contains an invalid URL at attributes.${key}`); }
      if (!/^https?:$/.test(parsed.protocol)) throw new Error(`cloud event contains a prohibited URL scheme at attributes.${key}`);
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error(`cloud event URL must not contain userinfo, query, or fragment at attributes.${key}`);
      }
      if (key === "origin" && (parsed.pathname !== "/" || parsed.search || parsed.hash)) {
        throw new Error("cloud event origin must not contain a path, query, or fragment");
      }
    } else if (key === "path") {
      if (!value.startsWith("/") || value.includes("?") || value.includes("#") || value.includes("://")) {
        throw new Error("cloud event URL path must be an absolute path without query or fragment");
      }
    } else if (/[@/?#]/.test(value)) {
      throw new Error(`cloud event host must not contain userinfo, path, query, or fragment at attributes.${key}`);
    }
  }
}

function assertEventPayload(operation: SyncOperation): void {
  const payload = EventPayloadSchema.parse(operation.payload);
  if (payload.id !== operation.entityId) throw new Error("event entity ID does not match its payload ID");
  if (payload.deviceId !== operation.deviceId) throw new Error("event payload device does not match the operation device");

  const allowed = attributeAllowlist[payload.source];
  for (const [key, value] of Object.entries(payload.attributes)) {
    if (!allowed.has(key as never) && !commonAttributes.has(key)) {
      throw new Error("cloud event contains a non-allowlisted attribute");
    }
    if (booleanAttributes.has(key) && typeof value !== "boolean") throw new Error(`cloud event attribute ${key} must be boolean`);
    if (numericAttributes.has(key) && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`cloud event attribute ${key} must be numeric`);
    }
    if (stringArrayAttributes.has(key) && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
      throw new Error(`cloud event attribute ${key} must be a string array`);
    }
    if (!booleanAttributes.has(key) && !numericAttributes.has(key) && !stringArrayAttributes.has(key) && typeof value !== "string") {
      throw new Error(`cloud event attribute ${key} must be a string`);
    }
    if (key === "durationMs" && (value as number) < 0) throw new Error("cloud terminal duration cannot be negative");
    if (key === "exitCode" && ((value as number) < 0 || (value as number) > 255 || !Number.isInteger(value))) {
      throw new Error("cloud terminal exit code is invalid");
    }
    if (key === "argCount" && ((value as number) < 0 || (value as number) > 10_000 || !Number.isInteger(value))) {
      throw new Error("cloud terminal argument count is invalid");
    }
    if (key === "count" && ((value as number) < 1 || !Number.isInteger(value))) throw new Error("cloud aggregate count is invalid");
    if (payload.source === "git" && key === "sha" && !/^[a-f0-9]{7,64}$/i.test(String(value))) {
      throw new Error("cloud Git SHA is invalid");
    }
    const values = strings(value);
    if (["file", "path", "relativePath", "files", "cwd"].includes(key) && !(payload.source === "chrome" && key === "path")) {
      values.forEach((item) => assertRelativePath(item, `attributes.${key}`));
    }
    if (payload.source === "chrome" && ["url", "origin", "path", "host", "hostname"].includes(key)) {
      assertUrlMetadata(key, values);
    }
    if (payload.source === "terminal" && key === "flags") {
      for (const flag of values) if (!/^--?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(flag)) {
        throw new Error("cloud terminal flags must contain names only");
      }
    }
    if (payload.source === "terminal" && ["commandShape", "executable", "subcommand"].includes(key)) {
      for (const item of values) if (/(?:^|\s)[A-Za-z_][A-Za-z0-9_]*\s*=|<<|[\r\n]/.test(item)) {
        throw new Error("cloud terminal metadata contains an environment assignment, heredoc, or multiline command");
      }
    }
  }
}

export function defaultCloudPrivacyPolicy(now = new Date()): PrivacyPolicyV1 {
  return PrivacyPolicyV1Schema.parse({
    version: "1",
    revision: 1,
    updatedAt: now.toISOString(),
    sources: { osApps: true, osWindows: false, approvedFolders: true, vscode: true, terminal: true, git: true, chrome: true },
    metadata: {
      relativeFilePaths: true,
      urlHosts: true,
      urlPaths: true,
      commandNames: true,
      commandFlagNames: true,
      personalMetadata: true,
      confidentialLocalCollection: true,
      personalCloudEligibility: false
    },
    retentionHours: 24,
    allowedDomains: [],
    ignoredDomains: [],
    ignoredPathPatterns: ["**/.env*", "**/.git/objects/**", "**/node_modules/**", "**/.build/**", "**/DerivedData/**"],
    immutableProtections: {
      secretDetection: true,
      attributeAllowlist: true,
      prohibitedContentExclusion: true,
      confidentialCloudBlock: true
    }
  });
}

function normalizedDomain(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function domainMatches(host: string, rule: string): boolean {
  const normalized = normalizedDomain(rule.replace(/^\*\./, ""));
  return Boolean(normalized && (host === normalized || host.endsWith(`.${normalized}`)));
}

function globMatchesPath(value: string, pattern: string): boolean {
  const normalizedValue = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  let expression = "^";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index]!;
    if (character === "*" && normalizedPattern[index + 1] === "*") {
      if (normalizedPattern[index + 2] === "/") { expression += "(?:.*/)?"; index += 2; }
      else { expression += ".*"; index += 1; }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  try { return new RegExp(`${expression}$`, "i").test(normalizedValue); } catch { return false; }
}

function eventSourceEnabled(policy: PrivacyPolicyV1, source: string, eventType: string): boolean {
  if (source === "vscode") return policy.sources.vscode;
  if (source === "terminal") return policy.sources.terminal;
  if (source === "git") return policy.sources.git;
  if (source === "chrome") return policy.sources.chrome;
  if (source !== "os") return false;
  if (eventType.startsWith("app")) return policy.sources.osApps;
  if (eventType.startsWith("window")) return policy.sources.osWindows;
  if (eventType.startsWith("folder")) return policy.sources.approvedFolders;
  return false;
}

export function assertOperationCompliesWithPrivacyPolicy(operation: SyncOperation, input: PrivacyPolicyV1): void {
  if (operation.tombstone || operation.entityType === "privacy_policy") return;
  const policy = PrivacyPolicyV1Schema.parse(input);
  if (operation.entityType === "chat_session") {
    const session = ChatSessionV1Schema.parse(operation.payload);
    if (session.classification === "personal" && !policy.metadata.personalCloudEligibility) {
      throw new Error("current privacy policy keeps personal chat local");
    }
    return;
  }
  if (operation.entityType === "chat_message") return;
  if (operation.entityType !== "event") return;

  const event = EventPayloadSchema.parse(operation.payload);
  if (!eventSourceEnabled(policy, event.source, event.eventType)) {
    throw new Error("current privacy policy disables this collection source");
  }
  if (event.privacy.classification === "personal"
    && (!policy.metadata.personalMetadata || !policy.metadata.personalCloudEligibility)) {
    throw new Error("current privacy policy keeps personal metadata local");
  }
  const keys = new Set(Object.keys(event.attributes));
  const fileKeys = ["file", "relativePath", "files", "cwd", ...(event.source === "chrome" ? [] : ["path"] )];
  if (!policy.metadata.relativeFilePaths && fileKeys.some((key) => keys.has(key))) {
    throw new Error("current privacy policy disables relative path metadata");
  }
  if (!policy.metadata.relativeFilePaths && event.source === "vscode" && event.title !== "VS Code file activity") {
    throw new Error("current privacy policy requires a generic VS Code title");
  }
  if (!policy.metadata.relativeFilePaths && event.source === "os" && event.eventType.startsWith("folder")
    && event.title !== "Approved folder activity") {
    throw new Error("current privacy policy requires a generic folder title");
  }
  if (!policy.metadata.commandNames && ["executable", "subcommand", "commandShape"].some((key) => keys.has(key))) {
    throw new Error("current privacy policy disables command names");
  }
  if (!policy.metadata.commandNames && event.source === "terminal" && event.title !== "Terminal command activity") {
    throw new Error("current privacy policy requires a generic terminal title");
  }
  if (!policy.metadata.commandFlagNames && keys.has("flags")) {
    throw new Error("current privacy policy disables command flag names");
  }
  if (event.source === "chrome") {
    const host = normalizedDomain(event.attributes.host ?? event.attributes.hostname);
    if (!policy.metadata.urlHosts && ["host", "hostname", "origin", "url"].some((key) => keys.has(key))) {
      throw new Error("current privacy policy disables URL host metadata");
    }
    if (!policy.metadata.urlPaths && ["url", "path"].some((key) => keys.has(key))) {
      throw new Error("current privacy policy disables URL path metadata");
    }
    if (!policy.metadata.urlHosts && event.title !== "Browser activity") {
      throw new Error("current privacy policy requires a generic browser title");
    }
    if (host && policy.ignoredDomains.some((rule) => domainMatches(host, rule))) {
      throw new Error("current privacy policy ignores this domain");
    }
    if (policy.allowedDomains.length > 0 && (!host || !policy.allowedDomains.some((rule) => domainMatches(host, rule)))) {
      throw new Error("current privacy policy does not allow this domain");
    }
  }
  const pathValues = ["file", "path", "relativePath", "files", "cwd"].flatMap((key) => strings(event.attributes[key]));
  if (pathValues.some((value) => policy.ignoredPathPatterns.some((pattern) => globMatchesPath(value, pattern)))) {
    throw new Error("current privacy policy ignores this path");
  }
}

export function assertCloudEligibleOperation(operation: SyncOperation, now = Date.now()): void {
  if (operation.tombstone && operation.payload !== undefined) {
    throw new Error("sync tombstones must not contain payload data");
  }
  if (operation.payload !== undefined) {
    if (!operation.payload || typeof operation.payload !== "object" || Array.isArray(operation.payload)) {
      throw new Error("cloud payload must be an object");
    }
    const payload = operation.payload as Record<string, unknown>;
    const classification = payload.privacy && typeof payload.privacy === "object"
      ? (payload.privacy as Record<string, unknown>).classification
      : payload.privacyClassification;
    if (classification === "confidential" || classification === "secret") {
      throw new Error(`${classification} payloads cannot leave the device`);
    }
    inspect(payload);
  }

  if (operation.entityType === "event") {
    const eligibility = (operation.payload as Record<string, unknown> | undefined)?.syncEligibility;
    if (!operation.tombstone && eligibility !== "cloud_eligible") throw new Error("event is not cloud eligible");
    const occurredAt = operation.tombstone
      ? Date.parse(operation.occurredAt)
      : Date.parse(EventPayloadSchema.parse(operation.payload).occurredAt);
    if (!Number.isFinite(occurredAt)) throw new Error("invalid event timestamp");
    if (occurredAt > now + 5 * 60_000) throw new Error("event timestamp is too far in the future");
    // Expired event tombstones contain no source data and must remain usable to
    // propagate deletion. Live event payloads are never accepted after 24 hours.
    if (!operation.tombstone && occurredAt + 86_400_000 <= now) throw new Error("expired events are not accepted");
    if (!operation.tombstone) {
      assertEventPayload(operation);
    }
  }

  if ((operation.entityType === "chat_session" || operation.entityType === "chat_message")
    && !operation.tombstone
    && (operation.payload as Record<string, unknown> | undefined)?.syncEligibility !== "cloud_eligible") {
    throw new Error("chat record is not cloud eligible");
  }
  assertTypedEntityPayload(operation);
}
