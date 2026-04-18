// MOTU Vault — Service Worker v4.57
// HTML: stale-while-revalidate (fast load, background update)
// figures.json: network-first
// Images: cache-first

const CACHE = 'motu-vault-v4.57';

const SHELL = [
  'motu-vault.html',
  'manifest.json',
  'masters_logo.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
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

  // figures.json — network first, fall back to cache
  if (url.pathname.endsWith('figures.json')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
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
  // Serve cached version immediately, fetch fresh in background
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fetchPromise = fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
            // Notify page that a new version is available
            if (cached) {
              cached.clone().text().then(oldText => {
                clone.clone().text().then(newText => {
                  if (oldText !== newText) {
                    self.clients.matchAll().then(clients => {
                      clients.forEach(c => c.postMessage({type: 'UPDATE_AVAILABLE'}));
                    });
                  }
                });
              });
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
