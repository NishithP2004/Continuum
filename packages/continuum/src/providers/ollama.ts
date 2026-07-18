import { z } from "zod";
import { CheckpointDraftSchema, type CheckpointDraft } from "@continuum/contracts";
import type { CheckpointInput, CheckpointProvider, ProviderHealth } from "./types.js";
import { validateEvidence } from "./types.js";
import { checkpointSystemPrompt, checkpointUserPrompt } from "./prompts.js";

const ollamaResponseSchema = z.object({
  message: z.object({ content: z.string() })
});

let ollamaQueue: Promise<void> = Promise.resolve();

export function normalizeLocalOllamaUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("OLLAMA_URL must be a loopback HTTP URL");
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
  if (url.protocol !== "http:" || !loopback || url.username || url.password || url.search || url.hash) {
    throw new Error("OLLAMA_URL must be a loopback HTTP URL without credentials, query, or fragment");
  }
  return url.origin;
}

export class OllamaProvider implements CheckpointProvider {
  readonly id = "ollama" as const;
  private readonly baseUrl: string;

  constructor(readonly model: string, baseUrl: string) {
    this.baseUrl = normalizeLocalOllamaUrl(baseUrl);
  }

  async health(): Promise<ProviderHealth> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { redirect: "error", signal: AbortSignal.timeout(1500) });
      if (!response.ok) return { status: "unavailable", detail: `HTTP ${response.status}` };
      const body = await response.json() as { models?: Array<{ name?: string }> };
      return { status: "available", models: (body.models ?? []).flatMap((model) => model.name ? [model.name] : []) };
    } catch (error) {
      return { status: "unavailable", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async request(input: CheckpointInput, repair: string | undefined, signal?: AbortSignal): Promise<CheckpointDraft> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: z.toJSONSchema(CheckpointDraftSchema),
        keep_alive: "60s",
        options: { temperature: 0, num_ctx: 4096 },
        messages: [
          { role: "system", content: checkpointSystemPrompt },
          { role: "user", content: checkpointUserPrompt(input, repair) }
        ]
      }),
      redirect: "error",
      signal
    });
    if (!response.ok) throw new Error(`Ollama request failed: HTTP ${response.status}`);
    const parsedResponse = ollamaResponseSchema.parse(await response.json());
    const draft = CheckpointDraftSchema.parse(JSON.parse(parsedResponse.message.content));
    validateEvidence(draft, input.events);
    return draft;
  }

  async createCheckpoint(input: CheckpointInput, signal?: AbortSignal): Promise<CheckpointDraft> {
    const run = async (): Promise<CheckpointDraft> => {
      signal?.throwIfAborted();
      try {
        return await this.request(input, undefined, signal);
      } catch (firstError) {
        return this.request(input, "The previous response failed schema, safety, or evidence validation. Return corrected JSON with only supplied event IDs.", signal);
      }
    };
    const queued = ollamaQueue.then(run, run);
    ollamaQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }
}
