export type PrivacyClassification = "public" | "personal" | "confidential";
export type RelevanceDecision = "keep" | "drop" | "uncertain";

export interface NormalizedEventV2 {
  version: "2";
  id: string;
  deviceId: string;
  occurredAt: string;
  hlc: string;
  source: "vscode";
  eventType:
    | "workspace.focused"
    | "file.activated"
    | "file.saved"
    | "privacy.drop.aggregate";
  projectId?: string;
  projectLocator: {
    localAlias: string;
    repositoryFingerprint?: string;
  };
  sessionId?: string;
  title: string;
  attributes: Record<string, string | number | boolean>;
  privacy: {
    classification: PrivacyClassification;
    rules: string[];
  };
  relevance: {
    decision: RelevanceDecision;
    reason: string;
  };
  confidence: number;
  dedupeKey: string;
  policyVersion: number;
  syncEligibility: "local_only" | "cloud_eligible";
}

export interface EventBatchV2 {
  events: NormalizedEventV2[];
}

export type NormalizedEventV2Draft = Omit<
  NormalizedEventV2,
  "policyVersion" | "syncEligibility"
>;

export interface PrivacyPolicyV1 {
  version: "1";
  revision: number;
  updatedAt: string;
  sources: {
    osApps: boolean;
    osWindows: boolean;
    approvedFolders: boolean;
    vscode: boolean;
    terminal: boolean;
    git: boolean;
    chrome: boolean;
  };
  metadata: {
    relativeFilePaths: boolean;
    urlHosts: boolean;
    urlPaths: boolean;
    commandNames: boolean;
    commandFlagNames: boolean;
    personalMetadata: boolean;
    confidentialLocalCollection: boolean;
    personalCloudEligibility: boolean;
  };
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
