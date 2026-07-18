const SECRET_WORDS = /(?:api[-_]?key|access[-_]?token|auth|bearer|password|passwd|secret|credential)/i;
const HIGH_ENTROPY_SEGMENT = /^(?:[A-Za-z0-9_-]{32,}|[0-9a-f]{24,}|[0-9a-f-]{36})$/i;

export function normalizeAllowlist(input) {
  const values = Array.isArray(input) ? input : String(input ?? "").split(/[\n,]/);
  return [...new Set(values.map((value) => String(value).trim().toLowerCase())
    .map((value) => value.replace(/^https?:\/\//, "").split("/")[0])
    .filter((value) => /^(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/.test(value)))]
    .slice(0, 100);
}

export function hostAllowed(host, allowlist) {
  const candidate = String(host).toLowerCase();
  return normalizeAllowlist(allowlist).some((entry) => {
    if (!entry.startsWith("*.")) return candidate === entry;
    const suffix = entry.slice(1);
    return candidate.endsWith(suffix) && candidate.length > suffix.length;
  });
}

function sanitizePathname(pathname) {
  const output = [];
  for (const encoded of pathname.split("/").slice(0, 16)) {
    if (!encoded) continue;
    let segment = encoded;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return { keep: false, reason: "malformed-url-path" };
    }
    if (
      SECRET_WORDS.test(segment) ||
      HIGH_ENTROPY_SEGMENT.test(segment) ||
      segment.includes("@")
    ) {
      output.push(":redacted");
      continue;
    }
    const safe = segment
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._~+@-]/gu, "-")
      .slice(0, 80);
    output.push(safe || ":item");
  }
  return { keep: true, pathname: `/${output.join("/")}` };
}

export function sanitizeActiveTabUrl(rawUrl, allowlist) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { keep: false, reason: "invalid-url" };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { keep: false, reason: "unsupported-scheme" };
  }
  if (!hostAllowed(url.host, allowlist)) {
    return { keep: false, reason: "domain-not-allowlisted" };
  }
  const path = sanitizePathname(url.pathname);
  if (!path.keep) return path;

  // Reconstruct from an allowlist: credentials, query, and fragment are never copied.
  const sanitized = `${url.protocol}//${url.host}${path.pathname}`;
  return {
    keep: true,
    url: sanitized.slice(0, 1_024),
    host: url.host.toLowerCase(),
    reason: "foreground-allowlisted-tab",
  };
}

export function sanitizeProjectId(value) {
  const clean = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return clean;
}
