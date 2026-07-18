import type { ModelSettings } from "@continuum/contracts";
import type { RuntimeConfig } from "../runtime.js";
import type { CheckpointProvider, ProviderHealth } from "./types.js";
import { DeterministicProvider } from "./deterministic.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";

export class ProviderRegistry {
  constructor(private readonly config: RuntimeConfig) {}

  provider(settings: ModelSettings, override?: "deterministic"): CheckpointProvider {
    if (override === "deterministic") return new DeterministicProvider();
    if (settings.activeCheckpointProvider === "openai") {
      if (!this.config.openaiApiKey) throw new Error("OPENAI_API_KEY is not configured");
      return new OpenAIProvider(settings.openaiModel, this.config.openaiApiKey);
    }
    return new OllamaProvider(settings.ollamaModel, this.config.ollamaUrl);
  }

  async health(settings: ModelSettings): Promise<{ ollama: ProviderHealth; openai: ProviderHealth }> {
    const ollama = await new OllamaProvider(settings.ollamaModel, this.config.ollamaUrl).health();
    const openai: ProviderHealth = this.config.openaiApiKey
      ? { status: "available", detail: "API key configured" }
      : { status: "unavailable", detail: "OPENAI_API_KEY is not configured" };
    return { ollama, openai };
  }
}
