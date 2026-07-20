import { NormalizedEventV2Schema } from "@continuum/contracts";
import { AppleFoundationProvider, appleBridgeClient } from "../src/providers/apple.js";
import { OllamaProvider } from "../src/providers/ollama.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { loadRuntimeConfig } from "../src/runtime.js";

const kind = process.argv[2] ?? "";
const modelOverride = process.argv[3];
const config = await loadRuntimeConfig();
const deviceId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const occurredAt = new Date().toISOString();
const source = NormalizedEventV2Schema.parse({
  version: "2",
  id: crypto.randomUUID(),
  deviceId,
  occurredAt,
  hlc: `${Date.now()}:0:${deviceId}`,
  source: "vscode",
  eventType: "vscode.progress",
  projectId,
  projectLocator: { localAlias: "provider-smoke-local-alias" },
  title: "Provider contract smoke checkpoint",
  attributes: { kind: "progress" },
  privacy: { classification: "public", rules: ["provider-smoke"] },
  relevance: { decision: "keep", reason: "explicit provider contract test" },
  confidence: 1,
  dedupeKey: "provider-smoke-event-0001",
  policyVersion: 1,
  syncEligibility: "local_only"
});

const provider = kind === "apple"
  ? new AppleFoundationProvider(config.appleBridgePath ?? "")
  : kind === "ollama"
    ? new OllamaProvider(modelOverride ?? "gemma3n:e2b", config.ollamaUrl)
    : kind === "openai"
      ? new OpenAIProvider(
          modelOverride ?? "gpt-5.6-terra",
          config.openaiApiKey ?? (() => { throw new Error("OPENAI_API_KEY is not configured"); })()
        )
      : undefined;

if (!provider) throw new Error("Usage: provider-smoke <apple|ollama|openai> [model]");
try {
  const draft = await provider.createCheckpoint({ projectId, events: [source] });
  process.stdout.write(`${JSON.stringify({ provider: provider.id, model: provider.model, valid: true, summary: draft.summary }, null, 2)}\n`);
} finally {
  if (kind === "apple" && config.appleBridgePath) {
    await appleBridgeClient(config.appleBridgePath).close();
  }
}
