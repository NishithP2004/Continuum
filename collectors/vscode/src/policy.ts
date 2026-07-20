import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  NormalizedEventV2,
  NormalizedEventV2Draft,
  PrivacyPolicyV1,
} from "./types";

const REQUIRED_SOURCES = [
  "osApps",
  "osWindows",
  "approvedFolders",
  "vscode",
  "terminal",
  "git",
  "chrome",
] as const;
const REQUIRED_METADATA = [
  "relativeFilePaths",
  "urlHosts",
  "urlPaths",
  "commandNames",
  "commandFlagNames",
  "personalMetadata",
  "confidentialLocalCollection",
  "personalCloudEligibility",
] as const;

export function failClosedPrivacyPolicy(): PrivacyPolicyV1 {
  return {
    version: "1",
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    sources: {
      osApps: false,
      osWindows: false,
      approvedFolders: false,
      vscode: false,
      terminal: false,
      git: false,
      chrome: false,
    },
    metadata: {
      relativeFilePaths: false,
      urlHosts: false,
      urlPaths: false,
      commandNames: false,
      commandFlagNames: false,
      personalMetadata: false,
      confidentialLocalCollection: false,
      personalCloudEligibility: false,
    },
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

export function parsePrivacyPolicy(input: unknown): PrivacyPolicyV1 | undefined {
  const value = (input as { policy?: unknown } | undefined)?.policy ?? input;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const sources = candidate.sources as Record<string, unknown> | undefined;
  const metadata = candidate.metadata as Record<string, unknown> | undefined;
  const immutable = candidate.immutableProtections as Record<string, unknown> | undefined;
  if (
    candidate.version !== "1" ||
    !Number.isInteger(candidate.revision) ||
    Number(candidate.revision) < 1 ||
    typeof candidate.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.updatedAt)) ||
    !sources ||
    !metadata ||
    REQUIRED_SOURCES.some((key) => typeof sources[key] !== "boolean") ||
    REQUIRED_METADATA.some((key) => typeof metadata[key] !== "boolean") ||
    !Number.isInteger(candidate.retentionHours) ||
    Number(candidate.retentionHours) < 1 ||
    Number(candidate.retentionHours) > 24 ||
    !Array.isArray(candidate.allowedDomains) ||
    !candidate.allowedDomains.every((entry) => typeof entry === "string") ||
    !Array.isArray(candidate.ignoredDomains) ||
    !candidate.ignoredDomains.every((entry) => typeof entry === "string") ||
    !Array.isArray(candidate.ignoredPathPatterns) ||
    !candidate.ignoredPathPatterns.every((entry) => typeof entry === "string") ||
    !immutable ||
    immutable.secretDetection !== true ||
    immutable.attributeAllowlist !== true ||
    immutable.prohibitedContentExclusion !== true ||
    immutable.confidentialCloudBlock !== true
  ) {
    return undefined;
  }
  return value as PrivacyPolicyV1;
}

function globMatchesPath(value: string, pattern: string): boolean {
  const normalizedValue = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  let expression = "^";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index]!;
    if (character === "*" && normalizedPattern[index + 1] === "*") {
      if (normalizedPattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`${expression}$`, "i").test(normalizedValue);
  } catch {
    return false;
  }
}

export function applyVscodePolicy(
  event: NormalizedEventV2 | NormalizedEventV2Draft,
  policy: PrivacyPolicyV1,
): NormalizedEventV2 | undefined {
  if (!policy.sources.vscode) return undefined;
  const occurredAt = Date.parse(event.occurredAt);
  if (
    !Number.isFinite(occurredAt) ||
    occurredAt < Date.now() - policy.retentionHours * 60 * 60 * 1_000
  ) return undefined;
  if (
    event.privacy.classification === "personal" &&
    !policy.metadata.personalMetadata
  ) {
    return undefined;
  }
  if (
    event.privacy.classification === "confidential" &&
    !policy.metadata.confidentialLocalCollection
  ) {
    return undefined;
  }
  const pathValue = ["path", "file", "relativePath"]
    .map((key) => event.attributes[key])
    .find((value): value is string => typeof value === "string");
  if (
    pathValue &&
    policy.ignoredPathPatterns.some((pattern) => globMatchesPath(pathValue, pattern))
  ) {
    return undefined;
  }

  const attributes = { ...event.attributes };
  if (!policy.metadata.personalMetadata) {
    delete attributes.projectName;
    delete attributes.workspace;
  }
  if (!policy.metadata.relativeFilePaths) {
    delete attributes.path;
    delete attributes.file;
    delete attributes.relativePath;
    delete attributes.files;
  }
  const rules = [...new Set([...event.privacy.rules, "collector_policy_v1"])] as string[];
  return {
    ...event,
    title:
      !policy.metadata.relativeFilePaths && event.eventType.startsWith("file.")
        ? "VS Code file activity"
        : event.title,
    attributes,
    privacy: { ...event.privacy, rules },
    policyVersion: policy.revision,
    syncEligibility:
      event.privacy.classification === "public" ||
      (event.privacy.classification === "personal" &&
        policy.metadata.personalCloudEligibility)
        ? "cloud_eligible"
        : "local_only",
  };
}

export class PrivacyPolicyCache {
  private cached?: PrivacyPolicyV1;
  private loaded = false;
  private lastFetchAt = 0;

  constructor(
    private readonly filePath: string,
    private readonly getEndpoint: () => string,
    private readonly getToken: () => Promise<string | undefined>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async current(forceRefresh = false): Promise<PrivacyPolicyV1> {
    await this.loadOnce();
    if (!forceRefresh && this.now() - this.lastFetchAt < 5_000) {
      return this.cached ?? failClosedPrivacyPolicy();
    }
    this.lastFetchAt = this.now();
    const token = (await this.getToken())?.trim();
    if (!token) return this.cached ?? failClosedPrivacyPolicy();
    try {
      const endpoint = validatePolicyEndpoint(this.getEndpoint());
      const response = await this.fetchImpl(`${endpoint}/v1/settings/privacy`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return this.cached ?? failClosedPrivacyPolicy();
      const policy = parsePrivacyPolicy(await response.json());
      if (!policy) return this.cached ?? failClosedPrivacyPolicy();
      this.cached = policy;
      await this.persist(policy);
    } catch {
      // An authenticated, validated last-known policy is the offline boundary.
    }
    return this.cached ?? failClosedPrivacyPolicy();
  }

  private async loadOnce(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.cached = parsePrivacyPolicy(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch {
      this.cached = undefined;
    }
  }

  private async persist(policy: PrivacyPolicyV1): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(policy), { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

function validatePolicyEndpoint(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error("Continuum policy endpoint must be loopback HTTP");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
