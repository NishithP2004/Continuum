const SECRET_TEXT = /(?:\b(?:api[-_]?key|access[-_]?token|token|auth(?:orization)?|bearer|password|passwd|secret|credential)s?\b\s*(?:=|:)|\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{12,}|\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{12,})/i;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|secrets?|credentials?|\.ssh)(?:\/|$)/i;

export function sanitizeRef(input, fallback = "detached") {
  const raw = String(input ?? "");
  if (SECRET_TEXT.test(raw)) return fallback;
  const value = raw
    .normalize("NFKC")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[^A-Za-z0-9._/@+-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 160);
  return value || fallback;
}

export function sanitizeSubject(input) {
  const raw = String(input ?? "").normalize("NFKC");
  if (!raw || SECRET_TEXT.test(raw)) {
    return { keep: false, reason: raw ? "secret-subject" : "empty-subject" };
  }
  const value = raw
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return value
    ? { keep: true, value, reason: "sanitized-commit-subject" }
    : { keep: false, reason: "empty-subject" };
}

export function sanitizeChangedPath(input) {
  const raw = String(input ?? "").replaceAll("\\", "/");
  if (!raw || raw.startsWith("/") || raw === ".." || raw.startsWith("../")) {
    return { keep: false, reason: "non-relative-path" };
  }
  if (SECRET_PATH.test(raw)) {
    return { keep: false, reason: "secret-path" };
  }
  const segments = raw.split("/");
  if (segments.includes(".git")) return { keep: false, reason: "git-internal-path" };
  const value = segments
    .map((segment) => segment
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._@+ -]/gu, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || ":item")
    .join("/")
    .slice(0, 512);
  return { keep: true, value, reason: "repository-relative-path" };
}

export function isCommitId(value) {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(String(value ?? ""));
}
