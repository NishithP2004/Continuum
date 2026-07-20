import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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

function globMatchesPath(value, pattern) {
  const normalizedValue = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedPattern = String(pattern).replaceAll("\\", "/").replace(/^\.\//, "");
  let expression = "^";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    if (character === "*" && normalizedPattern[index + 1] === "*") {
      if (normalizedPattern[index + 2] === "/") { expression += "(?:.*/)?"; index += 2; }
      else { expression += ".*"; index += 1; }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  try { return new RegExp(`${expression}$`, "i").test(normalizedValue); } catch { return false; }
}

export function applyGitPolicy(event, policy) {
  if (!policy.sources.git) return undefined;
  const occurredAt = Date.parse(event.occurredAt);
  if (!Number.isFinite(occurredAt) || occurredAt < Date.now() - policy.retentionHours * 60 * 60 * 1_000) return undefined;
  if (event.privacy?.classification === "personal" && !policy.metadata.personalMetadata) return undefined;
  if (event.privacy?.classification === "confidential" && !policy.metadata.confidentialLocalCollection) return undefined;
  const attributes = { ...(event.attributes ?? {}) };
  if (Array.isArray(attributes.files)) {
    attributes.files = attributes.files.filter((file) =>
      typeof file === "string" &&
      !policy.ignoredPathPatterns.some((pattern) => globMatchesPath(file, pattern))
    );
  }
  if (!policy.metadata.relativeFilePaths) delete attributes.files;
  if (!policy.metadata.personalMetadata) delete attributes.projectName;
  return {
    ...event,
    attributes,
    privacy: {
      ...event.privacy,
      rules: [...new Set([...(event.privacy?.rules ?? []), "collector_policy_v1"])],
    },
    policyVersion: policy.revision,
    syncEligibility: event.privacy?.classification === "public" ||
      (event.privacy?.classification === "personal" && policy.metadata.personalCloudEligibility)
      ? "cloud_eligible"
      : "local_only",
  };
}

export async function currentPrivacyPolicy({ endpoint, token, cacheFile, fetchImpl = fetch }) {
  let cached;
  try { cached = parsePrivacyPolicy(JSON.parse(await readFile(cacheFile, "utf8"))); } catch { /* no cache */ }
  if (token) {
    try {
      const response = await fetchImpl(`${endpoint}/v1/settings/privacy`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(750),
      });
      const policy = response.ok ? parsePrivacyPolicy(await response.json()) : undefined;
      if (policy) {
        await persist(cacheFile, policy);
        return policy;
      }
    } catch {
      // Use only a previously authenticated and validated policy while offline.
    }
  }
  return cached ?? failClosedPrivacyPolicy();
}

async function persist(file, policy) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(policy), { mode: 0o600 });
  await rename(temporary, file);
}
