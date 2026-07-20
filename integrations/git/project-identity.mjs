import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const SAFE_DEVICE_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const GLOBAL_PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let lastPhysicalTime = 0;
let logicalCounter = 0;

function canonicalPath(input) {
  const resolved = path.resolve(input);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
    maxBuffer: 128 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function normalizeProjectName(value) {
  const source = String(value ?? "").normalize("NFKC");
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

export function normalizeProjectId(value) {
  const candidate = String(value ?? "").normalize("NFKC").trim();
  return candidate && GLOBAL_PROJECT_ID.test(candidate) ? candidate.toLowerCase() : undefined;
}

export function repositoryRoot(input) {
  const candidate = canonicalPath(input);
  return canonicalPath(git(candidate, ["rev-parse", "--show-toplevel"]) || candidate);
}

export function resolveProjectIdentity(root, ...overrides) {
  const repository = repositoryRoot(root);
  const normalizedName = normalizeProjectName(path.basename(repository));
  const roots = git(repository, ["rev-list", "--max-parents=0", "HEAD"])
    .split(/\s+/)
    .filter((value) => /^[a-f0-9]{40,64}$/i.test(value))
    .map((value) => value.toLowerCase())
    .sort();
  const repositoryFingerprint = roots.length > 0
    ? createHash("sha256")
        .update(`continuum-repository-v1\0${normalizedName}\0${roots.join("\0")}`)
        .digest("hex")
    : undefined;
  const projectId = overrides.map(normalizeProjectId).find(Boolean);
  return {
    ...(projectId ? { projectId } : {}),
    localAlias: createHash("sha256").update(repository).digest("hex"),
    normalizedName,
    ...(repositoryFingerprint ? { repositoryFingerprint } : {}),
  };
}

export function resolveDeviceId(
  override = process.env.CONTINUUM_DEVICE_ID,
  identityFile = process.env.CONTINUUM_DEVICE_ID_FILE
    ? path.resolve(process.env.CONTINUUM_DEVICE_ID_FILE)
    : path.join(os.homedir(), ".continuum", "device-id"),
) {
  if (String(override ?? "").trim() && SAFE_DEVICE_ID.test(String(override).trim())) return String(override).trim();
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

export function hybridLogicalClock(deviceId, now = Date.now()) {
  if (now > lastPhysicalTime) {
    lastPhysicalTime = now;
    logicalCounter = 0;
  } else {
    logicalCounter += 1;
  }
  return `${lastPhysicalTime}:${logicalCounter}:${deviceId}`;
}
