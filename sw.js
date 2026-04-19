// MOTU Vault — Service Worker v4.73
// HTML: stale-while-revalidate (fast load, background update)
// figures.json: network-first
// Images: cache-first
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

const CACHE = 'motu-vault-v4.73';

const SHELL = [
  'motu-vault.html',
  'manifest.json',
  'masters_logo.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // {cache:'reload'} bypasses the HTTP cache so we always seed the
      // shell from the network on a fresh install. cache.addAll() uses the
      // default fetch, which may pull a stale HTML copy if the server
      // sends a long Cache-Control.
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
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

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
            caches.open(CACHE).then(c => c.put(cacheKey, clone));
          }
          return res;
        })
        .catch(() => caches.match(cacheKey))
    );
    return;
  }

  // Figure images & sounds — cache first, network fallback
  if (url.hostname === 'raw.githubusercontent.com' && (url.pathname.endsWith('.jpg') || url.pathname.endsWith('.png') || url.pathname.endsWith('.mp3'))) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
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
            caches.open(CACHE).then(c => c.put(e.request, cacheClone));

            if (cached) {
              const compareClone = res.clone();
              Promise.all([
                cached.clone().text(),
                compareClone.text(),
              ]).then(([oldText, newText]) => {
                if (oldText !== newText) {
                  self.clients.matchAll().then(clients => {
                    clients.forEach(c => c.postMessage({type: 'UPDATE_AVAILABLE'}));
                  });
                }
              }).catch(() => { /* if we can't read either body, skip notify */ });
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
