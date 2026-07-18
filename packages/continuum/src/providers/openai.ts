import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { CheckpointDraftSchema, type CheckpointDraft } from "@continuum/contracts";
import type { CheckpointInput, CheckpointProvider, ProviderHealth } from "./types.js";
import { validateEvidence } from "./types.js";
import { checkpointSystemPrompt, checkpointUserPrompt } from "./prompts.js";

export class OpenAIProvider implements CheckpointProvider {
  readonly id = "openai" as const;
  private readonly client: OpenAI;

  constructor(readonly model: string, apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async health(): Promise<ProviderHealth> {
    return { status: "available", detail: "API key configured" };
  }

  async createCheckpoint(input: CheckpointInput, signal?: AbortSignal): Promise<CheckpointDraft> {
    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      input: [
        { role: "system", content: checkpointSystemPrompt },
        { role: "user", content: checkpointUserPrompt(input) }
      ],
      text: { format: zodTextFormat(CheckpointDraftSchema, "checkpoint") }
    }, { signal });
    const draft = response.output_parsed;
    if (!draft) throw new Error("OpenAI returned no structured checkpoint");
    validateEvidence(draft, input.events);
    return draft;
  }
}
