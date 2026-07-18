import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import type { ContextDiffV1 } from "@continuum/contracts";

const BriefingSchema = z.object({
  headline: z.string().max(160),
  summary: z.string().max(1600),
  nextActions: z.array(z.string().max(300)).max(5)
});

export class BriefingProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string, readonly model: string) {
    this.client = new OpenAI({ apiKey });
  }

  async generate(diff: ContextDiffV1): Promise<z.infer<typeof BriefingSchema>> {
    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      input: [
        {
          role: "system",
          content: "Turn this evidence-backed context diff into a concise developer catch-up. Do not add facts. Distinguish hypotheses from verified changes and recommend concrete next actions."
        },
        { role: "user", content: JSON.stringify({ ...diff, briefing: undefined }) }
      ],
      text: { format: zodTextFormat(BriefingSchema, "continuum_briefing") }
    });
    if (!response.output_parsed) throw new Error("OpenAI returned no structured briefing");
    return response.output_parsed;
  }
}
