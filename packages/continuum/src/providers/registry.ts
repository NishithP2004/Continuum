import type { ModelSettings } from "@continuum/contracts";
import type { RuntimeConfig } from "../runtime.js";
import type { CheckpointProvider, ProviderHealth } from "./types.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";
import { AppleFoundationProvider } from "./apple.js";

export class ProviderRegistry {
  constructor(private readonly config: RuntimeConfig) {}

  provider(settings: ModelSettings): CheckpointProvider {
    if (settings.activeCheckpointProvider === "apple") {
      return new AppleFoundationProvider(this.config.appleBridgePath ?? "");
    }
    if (settings.activeCheckpointProvider === "openai") {
      if (!this.config.openaiApiKey) throw new Error("OPENAI_API_KEY is not configured");
      return new OpenAIProvider(settings.openaiModel, this.config.openaiApiKey);
    }
    return new OllamaProvider(settings.ollamaModel, this.config.ollamaUrl);
  }

  appleHealth(): Promise<ProviderHealth> {
    return new AppleFoundationProvider(this.config.appleBridgePath ?? "").health();
  }

  async health(settings: ModelSettings): Promise<{ apple: ProviderHealth; ollama: ProviderHealth; openai: ProviderHealth }> {
    const apple = await this.appleHealth();
    const ollama = await new OllamaProvider(settings.ollamaModel, this.config.ollamaUrl).health();
    const openai: ProviderHealth = this.config.openaiApiKey
      ? { status: "available", detail: "API key configured" }
      : { status: "unavailable", detail: "OPENAI_API_KEY is not configured" };
    return { apple, ollama, openai };
  }
}
