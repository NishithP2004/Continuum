import { PrivacyPolicyV1Schema, type PrivacyPolicyV1 } from "@continuum/contracts";

export function defaultPrivacyPolicy(now = new Date()): PrivacyPolicyV1 {
  return PrivacyPolicyV1Schema.parse({
    version: "1",
    revision: 1,
    updatedAt: now.toISOString(),
    sources: {
      osApps: true,
      osWindows: false,
      approvedFolders: true,
      vscode: true,
      terminal: true,
      git: true,
      chrome: true
    },
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
    ignoredPathPatterns: [
      "**/.env*",
      "**/.git/objects/**",
      "**/node_modules/**",
      "**/.build/**",
      "**/DerivedData/**"
    ],
    immutableProtections: {
      secretDetection: true,
      attributeAllowlist: true,
      prohibitedContentExclusion: true,
      confidentialCloudBlock: true
    }
  });
}

export function nextPrivacyPolicy(current: PrivacyPolicyV1, patch: unknown): PrivacyPolicyV1 {
  const input = (patch ?? {}) as Partial<PrivacyPolicyV1>;
  return PrivacyPolicyV1Schema.parse({
    ...current,
    ...input,
    version: "1",
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
    sources: { ...current.sources, ...(input.sources ?? {}) },
    metadata: { ...current.metadata, ...(input.metadata ?? {}) },
    immutableProtections: {
      secretDetection: true,
      attributeAllowlist: true,
      prohibitedContentExclusion: true,
      confidentialCloudBlock: true
    }
  });
}

export function sourceEnabled(policy: PrivacyPolicyV1, source: string, eventType: string): boolean {
  if (source === "vscode") return policy.sources.vscode;
  if (source === "terminal") return policy.sources.terminal;
  if (source === "git") return policy.sources.git;
  if (source === "chrome") return policy.sources.chrome;
  if (source !== "os") return false;
  if (eventType.startsWith("window")) return policy.sources.osWindows;
  if (eventType.startsWith("folder")) return policy.sources.approvedFolders;
  return policy.sources.osApps;
}
