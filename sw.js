// MOTU Vault — Service Worker v4.79
// HTML: stale-while-revalidate (fast load, background update)
// figures.json: network-first
// Images: cache-first
//
// v4.79 changelog:
//   • SHELL_CACHE bumped to motu-vault-shell-v4.79. ASSET_CACHE unchanged —
//     figure images and sounds survive the version bump as designed.
//   • No SW logic changes; all v4.79 work is in the app shell.
//
// v4.78 changelog:
//   • Cache split: SHELL_CACHE is versioned (cycles on every release),
//     ASSET_CACHE is stable (figure images / sounds persist across versions).
//     Previously every version bump nuked the entire cache and forced
//     re-downloading ~500 figure images on first launch.
//   • SW HTML compare uses Content-Length header when present, falls back
//     to byte-length of the response only if needed. Old code loaded both
//     the cached and fresh HTML as full text strings (~500KB heap on every
//     navigation) just to detect changes.
//   • activate() preserves ASSET_CACHE; only old shell caches are wiped.
//
// v4.70 changelog:
//   • Cache name bumped — activate() wipes old v4.69 entries so users stuck
//     on the broken build get a clean slate.
//   • Install uses fetch({cache:'reload'}) so the shell isn't seeded from
//     the browser's HTTP cache.
//   • figures.json is now cached under its pathname (query stripped) so the
//     offline fallback actually matches and the cache stops growing one
//     entry per `?t=<timestamp>` fetch.
//   • Stale-while-revalidate HTML path now clones the response TWICE up
//     front. Previously the code called `clone.clone()` after
//     `cache.put(clone)` had already consumed the body — which threw
//     "Response body is already used" and silently killed the
//     UPDATE_AVAILABLE postMessage. Fixing it is what lets deployed
//     updates actually propagate to users.

const SHELL_CACHE = 'motu-vault-shell-v4.79';
const ASSET_CACHE = 'motu-vault-assets';   // unversioned — survives releases

const SHELL = [
  'motu-vault.html',
  'manifest.json',
  'masters_logo.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(c =>
      // {cache:'reload'} bypasses the HTTP cache so we always seed the
      // shell from the network on a fresh install.
      Promise.all(SHELL.map(url =>
        fetch(url, {cache: 'reload'})
          .then(res => res.ok ? c.put(url, res) : null)
          .catch(() => null)
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        // Keep the current shell cache and the asset cache; delete every
        // older shell cache (any leftover that doesn't match either).
        .filter(k => k !== SHELL_CACHE && k !== ASSET_CACHE)
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Compare two Response objects without holding both bodies as strings.
// Prefers Content-Length (free); falls back to text length comparison.
function responsesDiffer(a, b) {
  const aLen = a.headers.get('content-length');
  const bLen = b.headers.get('content-length');
  if (aLen != null && bLen != null) return Promise.resolve(aLen !== bLen);
  // Fallback: compare lengths first, only diff full text if lengths match
  // (very rare and only happens when the server omits Content-Length).
  return Promise.all([a.text(), b.text()])
    .then(([x, y]) => x.length !== y.length || x !== y);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // figures.json — network first, fall back to cache.
  // The app cache-busts this URL with ?t=<timestamp>. Matching the raw
  // request means every new fetch writes a new cache entry (slow bloat)
  // and `caches.match` never finds a previous entry when offline (broken
  // fallback). Normalize to the bare URL so there's one entry, and
  // `match` actually works when the network is down.
  if (url.pathname.endsWith('figures.json')) {
    const cacheKey = url.origin + url.pathname;
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then(c => c.put(cacheKey, clone));
          }
          return res;
        })
        .catch(() => caches.match(cacheKey))
    );
    return;
  }

  // Figure images & sounds — cache first, network fallback.
  // Stored in the unversioned ASSET_CACHE so they survive shell version bumps.
  if (url.hostname === 'raw.githubusercontent.com' && (url.pathname.endsWith('.jpg') || url.pathname.endsWith('.png') || url.pathname.endsWith('.mp3'))) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          const clone = res.clone();
          caches.open(ASSET_CACHE).then(c => c.put(e.request, clone));
          return res;
        });
      })
    );
    return;
  }

  // HTML & app shell — stale-while-revalidate
  // Serve cached version immediately, fetch fresh in background.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fetchPromise = fetch(e.request).then(res => {
          if (res.ok) {
            // IMPORTANT: clone TWICE up-front. cache.put() consumes the
            // response body it's given. If we only cloned once and then
            // tried `clone.clone().text()` below, the body would already
            // be locked/disturbed and .clone() would throw — which is
            // exactly what was happening in v4.69 and why the page was
            // never being told an update was available.
            const cacheClone = res.clone();
            caches.open(SHELL_CACHE).then(c => c.put(e.request, cacheClone));

            if (cached) {
              const compareClone = res.clone();
              responsesDiffer(cached.clone(), compareClone)
                .then(differs => {
                  if (differs) {
                    self.clients.matchAll().then(clients => {
                      clients.forEach(c => c.postMessage({type: 'UPDATE_AVAILABLE'}));
                    });
                  }
                })
                .catch(() => { /* if compare fails, skip notify */ });
            }
          }
          return res;
        }).catch(() => cached);

        return cached || fetchPromise;
      })
    );
    return;
  }

  // Everything else — cache first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
