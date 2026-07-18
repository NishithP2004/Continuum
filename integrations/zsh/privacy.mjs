import path from "node:path";

const SECRET_PATTERN = /(?:\b(?:api[-_]?key|access[-_]?token|token|auth(?:orization)?|bearer|password|passwd|secret|credential)s?\b\s*(?:=|:)|--?(?:api[-_]?key|token|password|secret)(?:=|\s+)|\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{12,}|\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{12,})/i;
const ENV_ASSIGNMENT = /(?:^|\s)(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=/;
const SAFE_TOKEN = /^[A-Za-z0-9_.:+@/-]{1,80}$/;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|secrets?|credentials?|\.ssh)(?:\/|$)/i;

const SUBCOMMAND_DEPTH = new Map([
  ["git", 1],
  ["npm", 2],
  ["pnpm", 2],
  ["yarn", 2],
  ["bun", 2],
  ["cargo", 1],
  ["go", 2],
  ["swift", 1],
  ["xcodebuild", 0],
  ["make", 1],
  ["cmake", 1],
  ["pytest", 0],
  ["python", 0],
  ["python3", 0],
  ["node", 0],
  ["deno", 1],
  ["codex", 1],
  ["ollama", 1],
  ["docker", 2],
]);

function executableName(token) {
  return path.posix.basename(token.replace(/\\/g, "/")).slice(0, 60);
}

export function classifyCommand(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return { keep: false, reason: "empty-command" };
  }
  if (raw.startsWith(" ")) {
    return { keep: false, reason: "leading-space-private-command" };
  }
  if (raw.length > 32_768) {
    return { keep: false, reason: "oversized-command" };
  }
  if (/[\r\n]/.test(raw)) {
    return { keep: false, reason: "multiline-command" };
  }
  if (/<<-?\s*['\"]?\w+/.test(raw)) {
    return { keep: false, reason: "heredoc-command" };
  }
  if (ENV_ASSIGNMENT.test(raw)) {
    return { keep: false, reason: "environment-assignment" };
  }
  if (SECRET_PATTERN.test(raw)) {
    return { keep: false, reason: "secret-pattern" };
  }

  const trimmed = raw.trim();
  const coarseTokens = trimmed.split(/\s+/);
  let offset = 0;
  if (coarseTokens[0] === "command" || coarseTokens[0] === "builtin") offset += 1;
  if (coarseTokens[offset] === "sudo") offset += 1;
  const executable = executableName(coarseTokens[offset] ?? "unknown");
  if (!SAFE_TOKEN.test(executable)) {
    return { keep: false, reason: "unsafe-executable-token" };
  }

  const depth = SUBCOMMAND_DEPTH.get(executable) ?? 0;
  const retained = [executable];
  for (const candidate of coarseTokens.slice(offset + 1)) {
    if (retained.length > depth) break;
    if (candidate.startsWith("-")) continue;
    if (!SAFE_TOKEN.test(candidate) || SECRET_PATTERN.test(candidate)) break;
    retained.push(candidate.slice(0, 80));
  }
  let shape = retained.join(" ");
  if (/[|;&]/.test(trimmed)) shape += " [compound]";
  if (/[<>]/.test(trimmed)) shape += " [redirected]";
  return {
    keep: true,
    reason: SUBCOMMAND_DEPTH.has(executable)
      ? "known-safe-command-shape"
      : "executable-name-only",
    shape,
    confidence: SUBCOMMAND_DEPTH.has(executable) ? 0.95 : 0.75,
  };
}

export function sanitizeCwd(repoRoot, cwd) {
  const root = path.resolve(repoRoot);
  const absolute = path.resolve(cwd);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative === ".") return ".";
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return ":outside-repository";
  }
  if (SECRET_PATH.test(relative.replaceAll(path.sep, "/"))) return ":redacted";
  return relative
    .split(path.sep)
    .map((segment) => segment.replace(/[^A-Za-z0-9._@+-]/g, "-").slice(0, 80) || ":item")
    .join("/")
    .slice(0, 512);
}

export function sanitizeExitCode(input) {
  const value = Number.parseInt(String(input), 10);
  return Number.isInteger(value) && value >= 0 && value <= 255 ? value : 1;
}
