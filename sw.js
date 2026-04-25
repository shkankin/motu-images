// MOTU Vault — Service Worker v4.92
// HTML: stale-while-revalidate (fast load, background update)
// figures.json: network-first
// Images: cache-first
//
// v4.92 changelog:
//   • Stacked-thumbnail visual on list rows for figures with multiple
//     copies. Pure CSS via ::before/::after — no extra DOM, no extra
//     image fetches. ::before peeks at copies≥2; ::after revealed at
//     copies≥3. patchFigRow preserves the .has-stack/.has-stack-3plus
//     classes when re-applying status on quick-tap.
//
// v4.91 changelog:
//   • Multiple bug fixes (cycle-dot ordered→owned migration, accessory
//     picker tap-off, location datalist refresh, breadcrumb crumb nav,
//     scroll-position carryover between tabs).
//   • Cycle-from-ordered now jumps directly to owned (matches "received
//     my order" intent and preserves the orderedFrom→notes migration).
//   • New "N NEW" badge on Lines and Sublines screens — see at a glance
//     which sections have recently-added figures.
//   • CSS-only addition for the new badge; the cache bump is otherwise
//     a soft formality.
//
// v4.92 changelog:
//   • Stacked-thumbnail visual on list rows for figures with multiple
//     copies. Pure CSS via ::before/::after — no extra DOM, no extra
//     image fetches. ::before peeks at copies≥2; ::after revealed at
//     copies≥3. patchFigRow preserves the .has-stack/.has-stack-3plus
//     classes when re-applying status on quick-tap.
//
// v4.91 changelog:
//   • CACHE bumped to v4.91 — activate() wipes old entries. Required because
//     HTML adds .new-count-badge / .has-new CSS rules and crumb-link nav.
//   • Bug fixes:
//     - cycle-status dot from 'ordered' now jumps directly to 'owned' so the
//       ordered→owned migration of orderedFrom/orderedPaid actually fires
//       (previous cycle path went ordered→for-sale, never owned)
//     - accessory picker: tap to remove now refreshes the picker sheet
//       immediately (previously only the underlying detail was refreshed)
//     - location datalist now refreshes when locations change (so a value
//       typed in copy #1 appears as a suggestion in copy #2)
//     - breadcrumb "Lines" and the line-name crumb now use explicit nav
//       handlers instead of history.back(), and the line crumb is now
//       clickable even when no subline is active
//     - tab nav (Lines/Collection/All) no longer carries scroll position
//       from the previous tab onto the new tab
//   • Feature: NEW figure count badges on Lines and Sublines screens so
//     you can see at a glance which sections have figures added since the
//     last sync.
//
// v4.90 changelog:
//   • setStatus now auto-populates copies[0] for owned/for-sale, matching
//     the behavior of batchSetStatus and batchAddCopy. Previously the
//     detail-screen renderer was defensively creating copy #1 for display
//     only — operations that touched cp.copies[0] directly (accessory
//     picker, location input) would silently no-op on newly-owned figures
//     until the user had typed into Condition/Paid/Notes/Variant.
//   • No new CSS or UI — data-layer only. Cache bump is a soft
//     formality since there's no HTML API change, but keeps clients
//     on matching versions.
//
// v4.89 changelog:
//   • CACHE bumped to v4.89 — activate() wipes old entries. Required for
//     the responsive tablet/desktop layout: new CSS media queries at 768px,
//     1024px, and 1440px that widen the figure grid to 3/4/5 columns and
//     cap content width. Pure CSS change; no JS behavior changes.
//
// v4.88 changelog:
//   • CACHE bumped to v4.88 — activate() wipes old entries so users get a
//     clean slate. Required because HTML ships the inline copy-count pill
//     and its accompanying CSS.
//
// v4.87 changelog:
//   • CACHE bumped to v4.87 — activate() wipes the old v4.74 bucket so users
//     stuck on the previous SW get a clean slate. This also forces re-fetch
//     of motu-vault.html, which is required since the HTML ships the new
//     accessories/location UI and bug fixes (ordered→owned migration on
//     the quick-tap dot, duplicate pinning in the list).
//   • No behavior changes to the fetch/install/activate logic itself.
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

const CACHE = 'motu-vault-v4.92';

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
