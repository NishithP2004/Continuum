import { z } from "zod";

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NEO4J_URI: z.string().min(1).default("bolt://neo4j:7687"),
  NEO4J_USER: z.string().min(1).default("neo4j"),
  NEO4J_PASSWORD: z.string().min(8),
  API_KEY_PEPPER: z.string().min(32),
  AUTH0_ISSUER: z.string().url(),
  AUTH0_AUDIENCE: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url(),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(43118),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PROJECTION_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000)
});

export type CloudConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): CloudConfig {
  const parsed = ConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Invalid cloud configuration: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
