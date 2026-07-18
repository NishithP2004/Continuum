import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

export function normalizeProjectId(value) {
  if (!String(value ?? "").trim()) return undefined;
  const normalized = String(value)
    .normalize("NFKC")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return normalized || undefined;
}

export function canonicalProjectId(root) {
  const resolved = path.resolve(root);
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // Repository roots exist in normal collection; lexical fallback stays stable.
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

export function resolveProjectId(root, ...overrides) {
  for (const override of overrides) {
    const normalized = normalizeProjectId(override);
    if (normalized) return normalized;
  }
  return canonicalProjectId(root);
}
