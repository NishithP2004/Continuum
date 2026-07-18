import type { NormalizedEventV1 } from "@continuum/contracts";
import { NormalizedEventV1Schema } from "@continuum/contracts";

export type PrivacyOutcome =
  | { accepted: true; event: NormalizedEventV1 }
  | { accepted: false; source: NormalizedEventV1["source"] | "unknown"; rule: string; secret: boolean; eventId?: string };

const secretPatterns: Array<{ name: string; pattern: RegExp }> = [
  { name: "openai_api_key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/i },
  { name: "generic_secret_assignment", pattern: /\b(?:api[_-]?key|access[_-]?token|token|password|passwd|secret)\s*[:=]\s*[^\s,;]{6,}/i },
  { name: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { name: "authorization_header", pattern: /\bauthorization\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/i },
  { name: "env_file", pattern: /(?:^|[/\\\s"'`:,{\[])\.env(?:\.[A-Za-z0-9_-]+)?(?=$|[/\\\s"'`,;}\]])/i },
  { name: "demo_secret", pattern: /CONTINUUM_DEMO_SECRET_SHOULD_NEVER_APPEAR/i }
];

const allowedAttributes: Record<NormalizedEventV1["source"], Set<string>> = {
  vscode: new Set(["file", "path", "relativePath", "languageId", "workspace", "windowFocused", "action", "windowId"]),
  terminal: new Set(["executable", "subcommand", "commandShape", "flags", "argCount", "cwd", "projectName", "durationMs", "exitCode", "termProgram", "windowId"]),
  git: new Set(["sha", "branch", "subject", "files", "operation", "windowId"]),
  chrome: new Set(["url", "origin", "path", "host", "hostname", "pageTitle", "windowFocused", "windowId"]),
  demo: new Set(["kind", "status", "entityKind", "entityKey", "entityLabel", "files", "sha", "branch", "windowId", "expected", "command", "exitCode"])
};
const commonAllowedAttributes = new Set(["rule", "count"]);

function secretRule(value: string): string | undefined {
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

export function applyPrivacyGate(input: unknown): PrivacyOutcome {
  const parsed = NormalizedEventV1Schema.safeParse(input);
  if (!parsed.success) return { accepted: false, source: "unknown", rule: "invalid_schema", secret: false };
  const event = parsed.data;

  if (event.privacy.classification === "secret") {
    return { accepted: false, source: event.source, rule: "collector_secret", secret: true, eventId: event.id };
  }

  // The daemon is a second, independent boundary. Inspect every field that can
  // be persisted, logged as route data, sent to a provider, or returned later.
  const rawForInspection = JSON.stringify(event);
  const detectedRule = secretRule(rawForInspection);
  if (detectedRule) return { accepted: false, source: event.source, rule: detectedRule, secret: true, eventId: event.id };

  if (event.relevance.decision === "drop") {
    return { accepted: false, source: event.source, rule: `irrelevant:${event.relevance.reason}`, secret: false, eventId: event.id };
  }

  const allowlist = allowedAttributes[event.source] ?? new Set<string>();
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.attributes)) {
    if (!allowlist.has(key) && !commonAllowedAttributes.has(key)) continue;
    const sanitized = sanitizeValue(key, value);
    if (sanitized !== undefined) attributes[key] = sanitized;
  }

  const title = sanitizeString(event.title).slice(0, 256);
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
  const sanitizedEvent: NormalizedEventV1 = {
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
    ...(event.dedupeKey ? { dedupeKey: sanitizeString(event.dedupeKey).slice(0, 512) } : {})
  };
  const sanitizedForInspection = JSON.stringify(sanitizedEvent);
  const postRule = secretRule(sanitizedForInspection);
  if (postRule) return { accepted: false, source: event.source, rule: postRule, secret: true, eventId: event.id };

  return {
    accepted: true,
    event: sanitizedEvent
  };
}

export function cloudEligible(event: NormalizedEventV1): boolean {
  return event.privacy.classification === "public" || event.privacy.classification === "personal";
}
