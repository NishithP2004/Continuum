import type { NormalizedEvent, PrivacyPolicyV1 } from "@continuum/contracts";
import { NormalizedEventSchema } from "@continuum/contracts";
import { defaultPrivacyPolicy, sourceEnabled } from "../privacy-policy.js";

export type PrivacyOutcome =
  | { accepted: true; event: NormalizedEvent }
  | { accepted: false; source: NormalizedEvent["source"] | "unknown"; rule: string; secret: boolean; eventId?: string };

const secretPatterns: Array<{ name: string; pattern: RegExp }> = [
  { name: "openai_api_key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/i },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i },
  { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i },
  { name: "continuum_api_key", pattern: /\bctm_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{32,64}\b/ },
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: "generic_secret_assignment", pattern: /\b(?:api[_-]?key|access[_-]?token|token|password|passwd|secret)\s*[:=]\s*[^\s,;]{6,}/i },
  { name: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { name: "authorization_header", pattern: /\bauthorization\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/i },
  { name: "env_file", pattern: /(?:^|[/\\\s"'`:,{\[])\.env(?:\.[A-Za-z0-9_-]+)?(?=$|[/\\\s"'`,;}\]])/i },
  { name: "demo_secret", pattern: /CONTINUUM_DEMO_SECRET_SHOULD_NEVER_APPEAR/i }
];

const allowedAttributes: Record<NormalizedEvent["source"], Set<string>> = {
  vscode: new Set(["file", "path", "relativePath", "languageId", "workspace", "projectName", "windowFocused", "action", "windowId"]),
  terminal: new Set(["executable", "subcommand", "commandShape", "flags", "argCount", "cwd", "projectName", "durationMs", "exitCode", "termProgram", "windowId"]),
  git: new Set(["sha", "branch", "subject", "files", "operation", "projectName", "windowId"]),
  chrome: new Set(["url", "origin", "path", "host", "hostname", "windowFocused", "windowId"]),
  os: new Set(["bundleId", "appName", "action", "windowTitle", "relativePath", "changeKind", "approvedRootId", "windowId"]),
  demo: new Set(["kind", "status", "entityKind", "entityKey", "entityLabel", "files", "sha", "branch", "windowId", "expected", "command", "exitCode"])
};
const commonAllowedAttributes = new Set(["rule", "count"]);

export function detectSecretRule(value: string): string | undefined {
  return secretPatterns.find(({ pattern }) => pattern.test(value))?.name;
}

function stripUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return "<blocked-url>";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function sanitizeString(value: string): string {
  const home = process.env.HOME;
  let result = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (home) result = result.split(home).join("~");
  if (/^https?:\/\//i.test(result)) result = stripUrl(result);
  return result.slice(0, 512);
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeString(value).slice(0, 512);
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => sanitizeValue(key, item)).filter((item) => item !== undefined);
  }
  return undefined;
}

function normalizedDomain(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function domainMatches(host: string, rule: string): boolean {
  const normalized = normalizedDomain(rule?.replace(/^\*\./, ""));
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

function pathValues(event: NormalizedEvent): string[] {
  const values: string[] = [];
  for (const key of ["file", "path", "relativePath", "files", "cwd"]) {
    const value = event.attributes[key];
    if (typeof value === "string") values.push(value);
    if (Array.isArray(value)) for (const item of value) if (typeof item === "string") values.push(item);
  }
  return values;
}

function policyTitle(event: NormalizedEvent, policy: PrivacyPolicyV1): string {
  if (!policy.metadata.relativeFilePaths && event.source === "vscode") return "VS Code file activity";
  if (!policy.metadata.relativeFilePaths && event.source === "os" && event.eventType.startsWith("folder")) return "Approved folder activity";
  if (!policy.metadata.commandNames && event.source === "terminal") return "Terminal command activity";
  if (event.source === "chrome") {
    if (!policy.metadata.urlHosts) return "Browser activity";
    const host = normalizedDomain(event.attributes.host ?? event.attributes.hostname);
    return host ? `Viewing ${host}`.slice(0, 256) : "Browser activity";
  }
  return sanitizeString(event.title).slice(0, 256);
}

function policyFilteredAttributes(event: NormalizedEvent, policy: PrivacyPolicyV1): Record<string, unknown> {
  const allowlist = allowedAttributes[event.source] ?? new Set<string>();
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.attributes)) {
    if (!allowlist.has(key) && !commonAllowedAttributes.has(key)) continue;
    if (!policy.metadata.relativeFilePaths && ["file", "path", "relativePath", "files", "cwd"].includes(key)) continue;
    if (!policy.metadata.urlHosts && ["host", "hostname", "origin"].includes(key)) continue;
    if (!policy.metadata.urlPaths && ["url", "path"].includes(key) && event.source === "chrome") continue;
    if (event.source === "chrome" && key === "url" && !policy.metadata.urlHosts) {
      if (policy.metadata.urlPaths && typeof value === "string") {
        try {
          const url = new URL(value);
          if (/^https?:$/.test(url.protocol)) attributes.path = sanitizeString(url.pathname || "/");
        } catch {
          // An invalid URL is omitted instead of crossing the persistence boundary.
        }
      }
      continue;
    }
    if (!policy.metadata.commandNames && ["executable", "subcommand", "commandShape"].includes(key)) continue;
    if (!policy.metadata.commandFlagNames && key === "flags") continue;
    if (!policy.sources.osWindows && key === "windowTitle") continue;
    const sanitized = sanitizeValue(key, value);
    if (sanitized !== undefined) attributes[key] = sanitized;
  }
  return attributes;
}

export function applyPrivacyGate(input: unknown, policy: PrivacyPolicyV1 = defaultPrivacyPolicy()): PrivacyOutcome {
  const parsed = NormalizedEventSchema.safeParse(input);
  if (!parsed.success) return { accepted: false, source: "unknown", rule: "invalid_schema", secret: false };
  const event = parsed.data;

  if (event.source === "demo") {
    return { accepted: false, source: event.source, rule: "runtime_demo_source_disabled", secret: false, eventId: event.id };
  }

  if (!sourceEnabled(policy, event.source, event.eventType)) {
    return { accepted: false, source: event.source, rule: "source_disabled_by_policy", secret: false, eventId: event.id };
  }

  if (event.privacy.classification === "secret") {
    return { accepted: false, source: event.source, rule: "collector_secret", secret: true, eventId: event.id };
  }

  // The daemon is a second, independent boundary. Inspect every field that can
  // be persisted, logged as route data, sent to a provider, or returned later.
  const rawForInspection = JSON.stringify(event);
  const detectedRule = detectSecretRule(rawForInspection);
  if (detectedRule) return { accepted: false, source: event.source, rule: detectedRule, secret: true, eventId: event.id };

  if (event.relevance.decision === "drop") {
    return { accepted: false, source: event.source, rule: "irrelevant_event", secret: false, eventId: event.id };
  }

  if (event.privacy.classification === "personal" && !policy.metadata.personalMetadata) {
    return { accepted: false, source: event.source, rule: "personal_metadata_disabled", secret: false, eventId: event.id };
  }
  if (event.privacy.classification === "confidential" && !policy.metadata.confidentialLocalCollection) {
    return { accepted: false, source: event.source, rule: "confidential_collection_disabled", secret: false, eventId: event.id };
  }

  if (event.source === "chrome") {
    const host = normalizedDomain(event.attributes.host ?? event.attributes.hostname);
    if (host && policy.ignoredDomains.some((rule) => domainMatches(host, rule))) {
      return { accepted: false, source: event.source, rule: "ignored_domain", secret: false, eventId: event.id };
    }
    if (policy.allowedDomains.length > 0 && (!host || !policy.allowedDomains.some((rule) => domainMatches(host, rule)))) {
      return { accepted: false, source: event.source, rule: "domain_not_allowed", secret: false, eventId: event.id };
    }
  }

  if (pathValues(event).some((path) => policy.ignoredPathPatterns.some((pattern) => globMatchesPath(path, pattern)))) {
    return { accepted: false, source: event.source, rule: "ignored_path", secret: false, eventId: event.id };
  }

  const attributes = policyFilteredAttributes(event, policy);

  const title = policyTitle(event, policy);
  const permanentlyLocal = event.source === "os" && event.eventType.startsWith("window");
  const now = Date.now();
  const occurredAtMs = Date.parse(event.occurredAt);
  const timestampClamped = occurredAtMs > now + 5 * 60_000;
  const occurredAt = timestampClamped ? new Date(now).toISOString() : event.occurredAt;
  const privacyRules = [...new Set([
    ...event.privacy.rules.map((rule) => sanitizeString(rule).slice(0, 96)),
    "daemon_allowlist_v1",
    "daemon_secret_scan_v2",
    ...(timestampClamped ? ["daemon_future_timestamp_clamped"] : [])
  ])];
  const sanitizedEvent: NormalizedEvent = {
    ...event,
    occurredAt,
    title,
    attributes,
    privacy: {
      classification: event.privacy.classification,
      rules: privacyRules
    },
    relevance: {
      decision: event.relevance.decision,
      reason: sanitizeString(event.relevance.reason).slice(0, 256)
    },
    ...(event.dedupeKey ? { dedupeKey: sanitizeString(event.dedupeKey).slice(0, 512) } : {}),
    ...(event.version === "2" ? {
      policyVersion: policy.revision,
      syncEligibility: !permanentlyLocal && (event.privacy.classification === "public"
        || (event.privacy.classification === "personal" && policy.metadata.personalCloudEligibility)
      ) ? "cloud_eligible" as const : "local_only" as const
    } : {})
  };
  const sanitizedForInspection = JSON.stringify(sanitizedEvent);
  const postRule = detectSecretRule(sanitizedForInspection);
  if (postRule) return { accepted: false, source: event.source, rule: postRule, secret: true, eventId: event.id };

  return {
    accepted: true,
    event: sanitizedEvent
  };
}

export function cloudEligible(event: NormalizedEvent): boolean {
  if (event.privacy.classification === "confidential" || event.privacy.classification === "secret") return false;
  return event.version === "2"
    ? event.syncEligibility === "cloud_eligible"
    : event.privacy.classification === "public";
}
