// Flipbook service worker: a long-lived cache for IIIF page images.
//
// Many image servers send short (or no) cache headers, so without this a
// returning visitor would re-request the same thumbnails. We keep CORS-mode
// images from other sites for 30 days, capped at MAX_ENTRIES. Everything else
// (the app's own files, baked thumbnails, manifests, images from servers
// without CORS) passes straight through.

const CACHE = "flipbook-iiif-images-v1";
const MAX_ENTRIES = 1500;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const STAMP = "x-flipbook-cached-at";
let putsSinceTrim = 0;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    // Drop caches from older versions (including the pre-rename "iiif-images-v1").
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.destination !== "image" || req.mode !== "cors") return;
  if (new URL(req.url).origin === self.location.origin) return;
  event.respondWith(cacheFirst(req, event));
});

async function cacheFirst(req, event) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req.url);
  if (hit && Date.now() - Number(hit.headers.get(STAMP) || 0) < MAX_AGE_MS) return hit;

  let res;
  try {
    res = await fetch(req);
  } catch (err) {
    if (hit) return hit; // stale beats nothing when the server is down
    throw err;
  }
  if (res.ok && res.type === "cors") {
    const headers = new Headers(res.headers);
    headers.set(STAMP, String(Date.now()));
    const copy = new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers });
    event.waitUntil(cache.put(req.url, copy).then(() => maybeTrim(cache)));
  }
  return res;
}

async function maybeTrim(cache) {
  if (++putsSinceTrim < 50) return;
  putsSinceTrim = 0;
  const keys = await cache.keys(); // oldest first
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)).map((k) => cache.delete(k)));
}
