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
  deviceIdentityPath: string;
  ollamaUrl: string;
  appleBridgePath?: string;
  openaiApiKey?: string;
  syncUrl?: string;
  syncToken?: string;
}

function defaultDataDirectory(): string {
  return join(homedir(), "Library", "Application Support", "Continuum");
}

export function resolveDatabasePath(
  environment: NodeJS.ProcessEnv = process.env,
  dataDirectory?: string
): string {
  const explicit = environment.CONTINUUM_DB?.trim();
  if (explicit) return resolve(explicit);
  const dataDir = resolve(dataDirectory ?? environment.CONTINUUM_DATA_DIR ?? defaultDataDirectory());
  return join(dataDir, "continuum.sqlite");
}

export function normalizeLoopbackHost(input: string): string {
  const host = input.trim().toLowerCase();
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return host;
  throw new Error("CONTINUUM_HOST must be a loopback address (127.0.0.1, localhost, or ::1)");
}

export function normalizeSyncUrl(input?: string): string | undefined {
  if (!input?.trim()) return undefined;
  const url = new URL(input.trim());
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("CONTINUUM_SYNC_URL cannot contain credentials, a query, or a fragment");
  }
  const ipv4 = url.hostname.split(".");
  const ipv4Loopback = ipv4.length === 4
    && ipv4[0] === "127"
    && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  const loopback = ipv4Loopback || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("CONTINUUM_SYNC_URL must use HTTPS (HTTP is allowed only for loopback development)");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function validRuntimeToken(value: string): boolean {
  return value.length >= 32
    && value.length <= 4_096
    && !/[\s\u0000-\u001f\u007f]/.test(value);
}

export async function resolveToken(tokenPath: string, override?: string): Promise<string> {
  if (override !== undefined) {
    const token = override.trim();
    if (!validRuntimeToken(token)) {
      throw new Error("CONTINUUM_TOKEN must contain 32 to 4,096 non-whitespace characters");
    }
    return token;
  }
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  let storedToken: string | undefined;
  try {
    storedToken = (await readFile(tokenPath, "utf8")).trim();
  } catch {
    // A missing or unreadable credential is replaced below. Only the generated
    // bearer token is persisted; the invalid prior contents are never logged.
  }
  if (storedToken && validRuntimeToken(storedToken)) {
    await chmod(tokenPath, 0o600);
    return storedToken;
  }
  const token = randomBytes(32).toString("hex");
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  return token;
}

export async function loadRuntimeConfig(
  overrides: Partial<RuntimeConfig> = {},
  environment: NodeJS.ProcessEnv = process.env
): Promise<RuntimeConfig> {
  const dataDir = resolve(overrides.dataDir ?? environment.CONTINUUM_DATA_DIR ?? defaultDataDirectory());
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700).catch(() => undefined);

  const tokenPath = resolve(overrides.tokenPath ?? environment.CONTINUUM_TOKEN_FILE ?? join(dataDir, "auth.token"));
  const token = await resolveToken(
    tokenPath,
    overrides.token ?? environment.CONTINUUM_AUTH_TOKEN ?? environment.CONTINUUM_TOKEN
  );
  const repositoryRoot = resolve(import.meta.dirname, "../../..");

  const host = normalizeLoopbackHost(overrides.host ?? environment.CONTINUUM_HOST ?? "127.0.0.1");
  const port = overrides.port ?? Number(environment.CONTINUUM_PORT ?? 43117);
  if (port !== 43_117) {
    throw new Error("Continuum's local daemon uses the fixed port 43117 so the native app and Chrome extension share one origin");
  }

  return {
    host,
    port,
    dataDir,
    databasePath: overrides.databasePath ?? resolveDatabasePath(environment, dataDir),
    tokenPath,
    token,
    deviceIdentityPath: resolve(overrides.deviceIdentityPath ?? environment.CONTINUUM_DEVICE_ID_FILE ?? join(homedir(), ".continuum", "device-id")),
    ollamaUrl: overrides.ollamaUrl ?? environment.OLLAMA_URL ?? "http://127.0.0.1:11434",
    appleBridgePath: overrides.appleBridgePath
      ?? environment.CONTINUUM_APPLE_BRIDGE
      ?? join(repositoryRoot, "dist", "Continuum.app", "Contents", "MacOS", "ContinuumFoundationModelBridge"),
    openaiApiKey: overrides.openaiApiKey ?? environment.OPENAI_API_KEY,
    syncUrl: normalizeSyncUrl(overrides.syncUrl ?? environment.CONTINUUM_SYNC_URL),
    syncToken: overrides.syncToken ?? environment.CONTINUUM_SYNC_TOKEN
  };
}
