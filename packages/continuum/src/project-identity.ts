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

export function canonicalProjectId(root: string): string {
  return createHash("sha256").update(canonicalPath(root)).digest("hex").slice(0, 24);
}

export function repositoryRoot(input = process.cwd()): string {
  const candidate = canonicalPath(input);
  const result = spawnSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
  return canonicalPath(result.status === 0 ? result.stdout.trim() : candidate);
}

export function projectIdForPath(input = process.cwd()): string {
  return canonicalProjectId(repositoryRoot(input));
}
