import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SAFE_DEVICE_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const GLOBAL_PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let lastPhysicalTime = 0;
let logicalCounter = 0;

function canonicalPath(input: string): string {
  const resolved = path.resolve(input);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
    maxBuffer: 128 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function normalizeProjectName(value: string): string {
  const source = value.normalize("NFKC");
  if (/\bsk-[A-Za-z0-9_-]{16,}\b/i.test(source)
    || /\b(?:api[_-]?key|access[_-]?token|token|password|passwd|secret)\s*[:=]\s*\S{6,}/i.test(source)
    || /^\.env(?:\.|$)/i.test(source)) return "private-project";
  return source
    .replace(/\.git$/i, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/[-_.]{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 80) || "project";
}

export function normalizeProjectId(value: string | undefined): string | undefined {
  const candidate = value?.normalize("NFKC").trim();
  return candidate && GLOBAL_PROJECT_ID.test(candidate) ? candidate.toLowerCase() : undefined;
}

export function repositoryRoot(input: string): string {
  const candidate = canonicalPath(input);
  const root = git(candidate, ["rev-parse", "--show-toplevel"]);
  return canonicalPath(root || candidate);
}

export interface ProjectIdentity {
  projectId?: string;
  localAlias: string;
  normalizedName: string;
  repositoryFingerprint?: string;
}

export function resolveProjectIdentity(workspaceRoot: string, override?: string): ProjectIdentity {
  const root = repositoryRoot(workspaceRoot);
  const normalizedName = normalizeProjectName(path.basename(root));
  const roots = git(root, ["rev-list", "--max-parents=0", "HEAD"])
    .split(/\s+/)
    .filter((value) => /^[a-f0-9]{40,64}$/i.test(value))
    .map((value) => value.toLowerCase())
    .sort();
  const repositoryFingerprint = roots.length > 0
    ? createHash("sha256")
        .update(`continuum-repository-v1\0${normalizedName}\0${roots.join("\0")}`)
        .digest("hex")
    : undefined;
  return {
    ...(normalizeProjectId(override) ? { projectId: normalizeProjectId(override) } : {}),
    localAlias: createHash("sha256").update(root).digest("hex"),
    normalizedName,
    ...(repositoryFingerprint ? { repositoryFingerprint } : {}),
  };
}

export function resolveDeviceId(
  override = process.env.CONTINUUM_DEVICE_ID,
  identityFile = process.env.CONTINUUM_DEVICE_ID_FILE
    ? path.resolve(process.env.CONTINUUM_DEVICE_ID_FILE)
    : path.join(os.homedir(), ".continuum", "device-id"),
): string {
  if (override?.trim() && SAFE_DEVICE_ID.test(override.trim())) return override.trim();
  try {
    const existing = readFileSync(identityFile, "utf8").trim();
    if (SAFE_DEVICE_ID.test(existing)) return existing;
  } catch {
    // The first live collector creates the shared, device-local identifier.
  }
  mkdirSync(path.dirname(identityFile), { recursive: true, mode: 0o700 });
  const generated = randomUUID();
  try {
    const descriptor = openSync(identityFile, "wx", 0o600);
    writeFileSync(descriptor, `${generated}\n`, "utf8");
    closeSync(descriptor);
    return generated;
  } catch (error) {
    const existing = readFileSync(identityFile, "utf8").trim();
    if (SAFE_DEVICE_ID.test(existing)) return existing;
    throw error;
  }
}

export function hybridLogicalClock(deviceId: string, now = Date.now()): string {
  if (now > lastPhysicalTime) {
    lastPhysicalTime = now;
    logicalCounter = 0;
  } else {
    logicalCounter += 1;
  }
  return `${lastPhysicalTime}:${logicalCounter}:${deviceId}`;
}
