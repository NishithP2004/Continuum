import path from "node:path";

const SECRET_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
]);

const IGNORED_SEGMENTS = new Set([
  ".git",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
]);

const SAFE_TEXT = /[^\p{L}\p{N}._/@+\- ]/gu;

export interface PathDecision {
  keep: boolean;
  relativePath?: string;
  reason: string;
  classification: "public" | "personal" | "confidential";
}

export function sanitizeLabel(input: string, fallback = "workspace"): string {
  const clean = input
    .normalize("NFKC")
    .replace(/[\r\n\t]/g, " ")
    .replace(SAFE_TEXT, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return clean || fallback;
}

export function inspectWorkspacePath(
  workspaceRoot: string,
  absolutePath: string,
): PathDecision {
  const relative = path.relative(workspaceRoot, absolutePath);
  if (!relative || relative === ".") {
    return {
      keep: false,
      reason: "workspace-root",
      classification: "personal",
    };
  }

  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return {
      keep: false,
      reason: "outside-workspace",
      classification: "confidential",
    };
  }

  const segments = relative.split(path.sep).filter(Boolean);
  const lower = segments.map((segment) => segment.toLowerCase());
  const fileName = lower.at(-1) ?? "";
  if (
    SECRET_FILE_NAMES.has(fileName) ||
    fileName.startsWith(".env.") ||
    fileName.endsWith(".pem") ||
    fileName.endsWith(".key") ||
    lower.includes("secrets") ||
    lower.includes("credentials")
  ) {
    return {
      keep: false,
      reason: "secret-path",
      classification: "confidential",
    };
  }

  if (lower.some((segment) => IGNORED_SEGMENTS.has(segment))) {
    return {
      keep: false,
      reason: "ignored-generated-path",
      classification: "public",
    };
  }

  const sanitized = segments
    .map((segment) => sanitizeLabel(segment, "item"))
    .join("/")
    .slice(0, 512);
  return {
    keep: true,
    relativePath: sanitized,
    reason: "workspace-relative-path",
    classification: "personal",
  };
}
