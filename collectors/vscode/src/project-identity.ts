import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

export function normalizeProjectId(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return normalized || undefined;
}

export function canonicalProjectId(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // VS Code only calls this for an existing workspace; lexical fallback is deterministic.
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

export function resolveProjectId(workspaceRoot: string, override?: string): string {
  return normalizeProjectId(override) ?? canonicalProjectId(workspaceRoot);
}
