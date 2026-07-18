export type PrivacyClassification = "public" | "personal" | "confidential";
export type RelevanceDecision = "keep" | "drop" | "uncertain";

export interface NormalizedEventV1 {
  version: "1";
  id: string;
  occurredAt: string;
  source: "vscode";
  eventType:
    | "workspace.focused"
    | "file.activated"
    | "file.saved"
    | "privacy.drop.aggregate";
  projectId: string;
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
}

export interface EventBatchV1 {
  events: NormalizedEventV1[];
}
