import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export interface RuntimeConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  tokenPath: string;
  token: string;
  ollamaUrl: string;
  openaiApiKey?: string;
  fixturePath: string;
}

function defaultDataDirectory(): string {
  return join(homedir(), "Library", "Application Support", "Continuum");
}

export function normalizeLoopbackHost(input: string): string {
  const host = input.trim().toLowerCase();
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return host;
  throw new Error("CONTINUUM_HOST must be a loopback address (127.0.0.1, localhost, or ::1)");
}

export async function resolveToken(tokenPath: string, override?: string): Promise<string> {
  if (override) return override;
  try {
    return (await readFile(tokenPath, "utf8")).trim();
  } catch {
    const token = randomBytes(32).toString("hex");
    await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    await chmod(tokenPath, 0o600);
    return token;
  }
}

export async function loadRuntimeConfig(overrides: Partial<RuntimeConfig> = {}): Promise<RuntimeConfig> {
  const dataDir = resolve(overrides.dataDir ?? process.env.CONTINUUM_DATA_DIR ?? defaultDataDirectory());
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700).catch(() => undefined);

  const tokenPath = overrides.tokenPath ?? join(dataDir, "auth.token");
  const token = await resolveToken(tokenPath, overrides.token ?? process.env.CONTINUUM_TOKEN);
  const repositoryRoot = resolve(import.meta.dirname, "../../..");

  const host = normalizeLoopbackHost(overrides.host ?? process.env.CONTINUUM_HOST ?? "127.0.0.1");
  const port = overrides.port ?? Number(process.env.CONTINUUM_PORT ?? 43117);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("CONTINUUM_PORT must be an integer from 1 to 65535");

  return {
    host,
    port,
    dataDir,
    databasePath: overrides.databasePath ?? process.env.CONTINUUM_DB ?? join(dataDir, "continuum.sqlite"),
    tokenPath,
    token,
    ollamaUrl: overrides.ollamaUrl ?? process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
    openaiApiKey: overrides.openaiApiKey ?? process.env.OPENAI_API_KEY,
    fixturePath: overrides.fixturePath ?? process.env.CONTINUUM_FIXTURE ?? join(repositoryRoot, "fixtures", "jwt-friday-monday.jsonl")
  };
}
