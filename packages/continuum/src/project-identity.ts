import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

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

export function repositoryRoot(input = process.cwd()): string {
  const candidate = canonicalPath(input);
  return canonicalPath(git(candidate, ["rev-parse", "--show-toplevel"]) || candidate);
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

export interface RepositoryIdentity {
  localAlias: string;
  normalizedName: string;
  repositoryFingerprint?: string;
}

export function repositoryIdentity(input = process.cwd()): RepositoryIdentity {
  const root = repositoryRoot(input);
  const normalizedName = normalizeProjectName(path.basename(root));
  const rootCommits = git(root, ["rev-list", "--max-parents=0", "HEAD"])
    .split(/\s+/)
    .filter((value) => /^[a-f0-9]{40,64}$/i.test(value))
    .map((value) => value.toLowerCase())
    .sort();
  const repositoryFingerprint = rootCommits.length > 0
    ? createHash("sha256")
        .update(`continuum-repository-v1\0${normalizedName}\0${rootCommits.join("\0")}`)
        .digest("hex")
    : undefined;
  return {
    localAlias: createHash("sha256").update(root).digest("hex"),
    normalizedName,
    ...(repositoryFingerprint ? { repositoryFingerprint } : {}),
  };
}
