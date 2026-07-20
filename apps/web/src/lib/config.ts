const API_URL_KEY = "continuum.apiUrl";

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const ipv4 = normalized.split(".");
  const isIpv4Loopback = ipv4.length === 4
    && ipv4[0] === "127"
    && ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "[::1]"
    || isIpv4Loopback;
}

export function isLocalServiceUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function validateApiUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a Continuum service URL.");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Enter a valid absolute Continuum service URL.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Service URLs cannot contain credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Service URLs cannot contain a query or fragment.");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new Error("Remote Continuum services require HTTPS. HTTP is allowed only for localhost or loopback addresses.");
  }

  return parsed.toString().replace(/\/+$/, "");
}

export function configuredApiUrl(): string {
  const stored = window.localStorage.getItem(API_URL_KEY);
  if (stored) {
    try {
      return validateApiUrl(stored);
    } catch {
      window.localStorage.removeItem(API_URL_KEY);
    }
  }
  return validateApiUrl(import.meta.env.VITE_CONTINUUM_API_URL || window.location.origin);
}

export function saveApiUrl(value: string): void {
  window.localStorage.setItem(API_URL_KEY, validateApiUrl(value));
  window.dispatchEvent(new Event("continuum:configuration"));
}

export function auth0Configuration(): { domain: string; clientId: string; audience?: string } | null {
  const domain = import.meta.env.VITE_AUTH0_DOMAIN?.trim();
  const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID?.trim();
  if (!domain || !clientId) return null;
  const audience = import.meta.env.VITE_AUTH0_AUDIENCE?.trim();
  return { domain, clientId, ...(audience ? { audience } : {}) };
}
