import { z } from "zod";
import { CheckpointDraftSchema, type CheckpointDraft } from "@continuum/contracts";
import type { CheckpointInput, CheckpointProvider, ProviderHealth } from "./types.js";
import { validateEvidence } from "./types.js";
import { checkpointSystemPrompt, checkpointUserPrompt } from "./prompts.js";
import { scheduleOllamaGeneration } from "./ollama-scheduler.js";

const ollamaResponseSchema = z.object({
  message: z.object({ content: z.string() })
});

class OllamaCheckpointValidationError extends Error {
  readonly kind: "response" | "evidence";

  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : "";
    const kind = /instruction-like|unknown event id/i.test(message) ? "evidence" : "response";
    super(`Ollama checkpoint ${kind} validation failed`, { cause });
    this.name = "OllamaCheckpointValidationError";
    this.kind = kind;
  }
}

function publicValidationError(error: OllamaCheckpointValidationError): Error {
  if (error.kind === "evidence") {
    return new Error("Ollama checkpoint evidence validation failed");
  }
  return new SyntaxError("Ollama checkpoint response validation failed");
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === "AbortError")
    || (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError");
}

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
    const responseText = await response.text();
    signal?.throwIfAborted();
    try {
      const parsedResponse = ollamaResponseSchema.parse(JSON.parse(responseText));
      const draft = CheckpointDraftSchema.parse(JSON.parse(parsedResponse.message.content));
      validateEvidence(draft, input.events);
      signal?.throwIfAborted();
      return draft;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      throw new OllamaCheckpointValidationError(error);
    }
  }

  async createCheckpoint(input: CheckpointInput, signal?: AbortSignal): Promise<CheckpointDraft> {
    return scheduleOllamaGeneration(this.baseUrl, this.model, signal, async () => {
      signal?.throwIfAborted();
      try {
        return await this.request(input, undefined, signal);
      } catch (firstError) {
        if (!(firstError instanceof OllamaCheckpointValidationError)) throw firstError;
        signal?.throwIfAborted();
        try {
          return await this.request(input, "The previous response failed schema, safety, or evidence validation. Return corrected JSON with only supplied event IDs.", signal);
        } catch (repairError) {
          if (!(repairError instanceof OllamaCheckpointValidationError)) throw repairError;
          throw publicValidationError(repairError);
        }
      }
    });
  }
}
