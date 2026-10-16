const CACHE_PREFIX = "cut-master-pro-shell-";

const stableHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const createOfflineServiceWorkerSource = (urls: readonly string[]) => {
  const precacheUrls = [...new Set(urls)]
    .filter((url) => url.startsWith("/") && url !== "/sw.js" && !url.endsWith(".map"))
    .sort();
  const cacheName = `${CACHE_PREFIX}${stableHash(JSON.stringify(precacheUrls))}`;

  return `const CACHE_PREFIX = ${JSON.stringify(CACHE_PREFIX)};
const CACHE_NAME = ${JSON.stringify(cacheName)};
const PRECACHE_URLS = ${JSON.stringify(precacheUrls)};
const PRECACHE_PATHS = new Set(PRECACHE_URLS.map((url) => new URL(url, self.location.origin).pathname));
const STATIC_DESTINATIONS = new Set(["script", "style", "font", "image", "worker"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: "reload" }))),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok && response.type === "basic") {
            const cache = await caches.open(CACHE_NAME);
            await cache.put("/", response.clone());
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match("/")) || Response.error()),
    );
    return;
  }

  if (!PRECACHE_PATHS.has(url.pathname) && !STATIC_DESTINATIONS.has(request.destination)) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(async (cached) => {
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    }),
  );
});
`;
};
