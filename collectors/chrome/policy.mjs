import { hostAllowed, normalizeAllowlist } from "./privacy.mjs";

const SOURCE_KEYS = ["osApps", "osWindows", "approvedFolders", "vscode", "terminal", "git", "chrome"];
const METADATA_KEYS = ["relativeFilePaths", "urlHosts", "urlPaths", "commandNames", "commandFlagNames", "personalMetadata", "confidentialLocalCollection", "personalCloudEligibility"];

export function failClosedPrivacyPolicy() {
  return {
    version: "1",
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    sources: Object.fromEntries(SOURCE_KEYS.map((key) => [key, false])),
    metadata: Object.fromEntries(METADATA_KEYS.map((key) => [key, false])),
    retentionHours: 1,
    allowedDomains: [],
    ignoredDomains: [],
    ignoredPathPatterns: [],
    immutableProtections: {
      secretDetection: true,
      attributeAllowlist: true,
      prohibitedContentExclusion: true,
      confidentialCloudBlock: true,
    },
  };
}

export function parsePrivacyPolicy(input) {
  const value = input?.policy ?? input;
  if (!value || typeof value !== "object") return undefined;
  if (
    value.version !== "1" ||
    !Number.isInteger(value.revision) || value.revision < 1 ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
    !value.sources || SOURCE_KEYS.some((key) => typeof value.sources[key] !== "boolean") ||
    !value.metadata || METADATA_KEYS.some((key) => typeof value.metadata[key] !== "boolean") ||
    !Number.isInteger(value.retentionHours) || value.retentionHours < 1 || value.retentionHours > 24 ||
    !Array.isArray(value.allowedDomains) || !value.allowedDomains.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.ignoredDomains) || !value.ignoredDomains.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.ignoredPathPatterns) || !value.ignoredPathPatterns.every((entry) => typeof entry === "string") ||
    value.immutableProtections?.secretDetection !== true ||
    value.immutableProtections?.attributeAllowlist !== true ||
    value.immutableProtections?.prohibitedContentExclusion !== true ||
    value.immutableProtections?.confidentialCloudBlock !== true
  ) return undefined;
  return value;
}

function eventHost(event) {
  if (typeof event.attributes?.host === "string") return event.attributes.host.toLowerCase();
  if (typeof event.attributes?.url === "string") {
    try { return new URL(event.attributes.url).hostname.toLowerCase(); } catch { return ""; }
  }
  return "";
}

function domainIgnored(host, rules) {
  return normalizeAllowlist(rules).some((rule) => {
    const normalized = rule.replace(/^\*\./, "");
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

export function applyChromePolicy(event, policy) {
  if (!policy.sources.chrome) return undefined;
  const occurredAt = Date.parse(event.occurredAt);
  if (!Number.isFinite(occurredAt) || occurredAt < Date.now() - policy.retentionHours * 60 * 60 * 1_000) return undefined;
  if (event.privacy?.classification === "personal" && !policy.metadata.personalMetadata) return undefined;
  if (event.privacy?.classification === "confidential") return undefined;

  const host = eventHost(event);
  const allowed = normalizeAllowlist(policy.allowedDomains ?? []);
  const ignored = normalizeAllowlist(policy.ignoredDomains ?? []);
  const verifiedHostlessEvent = !host &&
    !policy.metadata.urlHosts &&
    event.policyVersion === policy.revision &&
    event.privacy?.rules?.includes("domain-allowlist");
  // Chrome is intentionally allowlist-only. A host must be verified before it
  // can be removed from the durable representation by urlHosts=false.
  if (!verifiedHostlessEvent && (
    !host || allowed.length === 0 || !hostAllowed(host, allowed) || domainIgnored(host, ignored)
  )) {
    return undefined;
  }

  const attributes = { ...(event.attributes ?? {}) };
  let pathOnly;
  if (typeof attributes.url === "string") {
    try { pathOnly = new URL(attributes.url).pathname.slice(0, 512); } catch { /* invalid URLs are omitted */ }
  }
  if (!policy.metadata.urlPaths) {
    delete attributes.url;
    delete attributes.path;
  } else if (!policy.metadata.urlHosts) {
    delete attributes.url;
    if (pathOnly) attributes.path = pathOnly;
  }
  if (!policy.metadata.urlHosts) {
    delete attributes.host;
    delete attributes.hostname;
    delete attributes.origin;
  }

  return {
    ...event,
    title: policy.metadata.urlHosts ? event.title : "Chrome foreground tab activity",
    attributes,
    privacy: {
      ...event.privacy,
      rules: [...new Set([...(event.privacy?.rules ?? []), "collector_policy_v1"])],
    },
    policyVersion: policy.revision,
    syncEligibility: policy.metadata.personalCloudEligibility ? "cloud_eligible" : "local_only",
  };
}
