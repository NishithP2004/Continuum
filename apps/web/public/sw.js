const CACHE = "continuum-shell-v3";
const STATIC_SHELL = ["/manifest.webmanifest", "/continuum-mark.svg", "/continuum-maskable.svg", "/continuum-192.png", "/continuum-512.png", "/continuum-apple-touch.png", "/continuum-maskable-512.png"];
const BUILD_MANIFEST = "/vite-manifest.json";

async function cacheApplicationShell() {
  const cache = await caches.open(CACHE);
  const response = await fetch(new Request("/", { cache: "reload" }));
  if (!response.ok) throw new Error(`Shell request failed with HTTP ${response.status}`);
  await cache.put("/", response.clone());
  const html = await response.text();
  const assets = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)]
    .map((match) => new URL(match[1], self.location.origin))
    .filter((url) => url.origin === self.location.origin)
    .map((url) => url.pathname)
    .filter((path) => path.startsWith("/assets/") || STATIC_SHELL.includes(path));
  try {
    const manifestResponse = await fetch(new Request(BUILD_MANIFEST, { cache: "reload" }));
    if (manifestResponse.ok) {
      await cache.put(BUILD_MANIFEST, manifestResponse.clone());
      const manifest = await manifestResponse.json();
      Object.values(manifest).forEach((entry) => {
        if (entry && typeof entry === "object") {
          if (typeof entry.file === "string") assets.push(`/${entry.file}`);
          if (Array.isArray(entry.css)) entry.css.forEach((path) => assets.push(`/${path}`));
          if (Array.isArray(entry.assets)) entry.assets.forEach((path) => assets.push(`/${path}`));
        }
      });
    }
  } catch {
    // The HTML entry chunks still provide a usable online shell when a host omits Vite's build manifest.
  }
  await Promise.all([...new Set([...STATIC_SHELL, ...assets])].map((path) => cache.add(path)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheApplicationShell());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/v1/") || url.pathname === "/mcp" || url.pathname.startsWith("/.well-known/")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/")).then((response) => response ?? Response.error()));
    return;
  }

  const cacheable = url.pathname.startsWith("/assets/") || url.pathname === BUILD_MANIFEST || STATIC_SHELL.includes(url.pathname);
  if (!cacheable) return;
  // Vite's preview server varies asset responses by Origin. The cached bytes
  // are immutable, content-hashed same-origin assets, so matching them while
  // ignoring Vary is safe and keeps the installed shell available offline.
  event.respondWith(caches.match(event.request, { ignoreVary: true }).then((cached) => cached ?? fetch(event.request).then((response) => {
    if (response.ok) void caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
