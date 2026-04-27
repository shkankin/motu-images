// MOTU Vault — Service Worker v6.13
// HTML: stale-while-revalidate (fast load, background update)
// figures.json: network-first
// Images: cache-first
//
// v6.00 changelog:
//   • CACHE bumped to v6.00.
//   • Major architecture change: monolithic motu-vault.html (8204
//     lines) split into a slim shell + vault.css + js/ ES modules
//     (app, state, photos, data, render, handlers, ui-sheets, eggs).
//   • SHELL precache list expanded to include vault.css and all 8
//     module files. Single-file install gives way to multi-file
//     install; install handler still tolerates 404s gracefully.
//   • No behavior changes intended. All inline `onclick=` window-
//     callable functions remain mirrored. Schema, storage keys,
//     theme palettes, and rendering model all unchanged from v5.06.
//   • 4 functions that previously relied on classic-script auto-
//     globalization (setStatus, fetchFigs, exportCSV,
//     dismissContextMenu) now have explicit window.* mirrors so they
//     remain reachable from inline-onclick handlers in module mode.
//

// v5.06 changelog:
//   • CACHE bumped to v5.06.
//   • Default theme palette swap: Obsidian base (#09090b/#121217/#1c1c24)
//     with violet accent (#7c3aed) and Power-Sword gold (#facc15). Named
//     themes (skeletor/heman/grayskull/snake) keep their identities.
//   • Radius bumped 14→16px (sm 10→12) for a more premium feel.
//   • Cards: plastic-edge inset highlight + deeper layered shadows. Status
//     variants get tinted inset rings (the rim "catches light").
//   • Status buttons now have per-status icons (check / heart / box / tag)
//     in addition to color, for visual redundancy.
//   • Status-pop spring animation when a status becomes active.
//   • Tap targets: .icon-btn 38→44px, .chip min-height 44px.
//   • t3 lifted #71717a → #8a8d9a for WCAG AA contrast on bg2/bg3.
//   • Inputs gain a 3px focus ring (was 1px border shift, easy to miss).
//   • Buttons get :focus-visible outline for keyboard nav.
//   • Section header weight bumped 700→800, color t3→t2 for legibility.
//
// v5.05 changelog:
//   • CACHE bumped to v5.05.
//   • Back-at-root: no longer closes app on first press. Shows
//     "Press back again to exit" toast; second back within 2.5s exits.
//   • Custom figures: year coerced to Number on load so they merge into
//     the same year-grouped section as AF411 entries (was creating a
//     duplicate "2026" section because string!==number under ===).
//
// v5.04 changelog:
//   • CACHE bumped to v5.04.
//   • Stagger entrance animation restored, gated to navigation only
//     (data-stagger attribute set on #app). Status toggles and in-place
//     patches no longer replay it.
//   • Lines view toggle restyled into a proper section header — line
//     count on left, segmented toggle on right, breathing room above.
//   • Custom figures: app now loads motu-custom-figs from localStorage
//     at sync time, IDs auto-prefixed with 'custom-' to avoid AF411
//     collision when official entries arrive. Use the standalone
//     custom-figs-editor.html to add/edit/delete.
//
// v5.03 changelog:
//   • CACHE bumped to v5.03.
//   • Per-figure accessory availability list. Tap "⚙ Limit list" in the
//     accessory picker to choose which accessories are even offered for
//     that figure (e.g. Battle Armor He-Man → just Sword, Battle Axe,
//     mini comic). Stored under motu-acc-avail (per-figure-id list).
//     Empty/unset = full ACCESSORIES catalog as before. Custom-added
//     accessories on a copy still show even if not in the limited list.
//
// v5.02 changelog:
//   • CACHE bumped to v5.02. v5.01 was amended in place (same CACHE
//     constant) so existing SW didn't re-activate, leaving stale assets
//     cached. Bumping forces a clean install.
//
// v5.01 changelog:
//   • CACHE bumped to v5.01.
//   • Empty Collection state: clearer prompt with CTAs to Lines / All
//     when user lands on Collection tab with nothing tracked yet.
//   • Lines screen now has list/grid view toggle (separate setting from
//     the figures-list view; key: motu-lines-view).
//   • Filter chip flicker fixed: chip taps now patch only the sheet body
//     in place via patchFilter() instead of a full app re-render.
//   • Splash screen markup commented out (per user request).
//   • Bars auto-reappear after 3.5s of scroll idle so you never get
//     stranded without nav after stopping to read.
//
// v5.00 changelog:
//   • CACHE bumped to v5.00.
//   • Bars reappear when scrolled to the bottom of the figures list (was
//     left in whatever state on entry — sometimes hidden, blocking nav).
//   • Pull-to-refresh now opt-in (default OFF). Threshold raised 80→120px.
//     Toggle in Menu → Sync section. Some touchscreens were sensitive
//     enough to fire PTR during normal upward scrolling.
//   • Removed the inline "Add Figure" button on the Kids Core line —
//     adding figures is now via the standalone kids-core-editor.html.
//     Existing entries can still be edited via the per-figure Edit flow.
//   • PWA app-icon shortcuts: long-press the installed icon for quick
//     actions (Share Want List, Stats, Sync, Settings). Requires the
//     updated manifest.json — see /mnt/user-data/outputs/manifest.json.
//
// v4.99 changelog:
//   • CACHE bumped to v4.99.
//   • Settings export/import: theme, sort, view mode, line order, hidden
//     items, recent changes, default photo, onboarding flag, celebrated
//     flags. NOT collection data or photos. Format detection on import
//     auto-routes the JSON to the right handler.
//
// v4.98 changelog:
//   • CACHE bumped to v4.98.
//   • AF411 button: removed source==='af411' gate (many figures are
//     AF411-sourced but just missing that field in figures.json).
//     Tiered fallback: deep link if id matches AF411's <slug>-<NNNNN>
//     pattern; else group's index page; else all-figures index.
//
// v4.97 changelog:
//   • CACHE bumped to v4.97.
//   • AF411 group slugs fixed against real URLs from the all-figures
//     index: 'origins|Exclusives' was 'exclusives' (now 'origins-
//     exclusives'); 'origins|Vehicles & Playsets' was 'vehicles-playsets'
//     (now 'origins-beasts-vehicles-and-playsets'); 'origins|WWE' was
//     'wwe' (now 'masters-of-the-wwe-universe-action-figures'); added
//     entries for Stranger Things, Thundercats, and Transformers crossovers.
//   • AF411 fallback no longer points at the broken WP search endpoint;
//     opens the all-action-figures index instead so Ctrl+F finds the
//     figure even when its source field is missing.
//
// v4.96 changelog:
//   • CACHE bumped to v4.96.
//   • AF411 URL fix: Origins Deluxe slug was 'deluxe', actual path is
//     'origins-deluxe'. Affected all Origins Deluxe figures (Beast Man
//     Deluxe, etc.).
//   • AF411 search fallback now strips "(Deluxe)"/"(Variant)" parens
//     from the figure name and appends the line name so the search
//     query is tighter and less likely to land on a homepage.
//
// v4.95 changelog:
//   • CACHE bumped to v4.95.
//   • AF411 button now shows on detail screen for any non-Kids-Core,
//     non-custom figure (was gated on source==='af411'); falls back to
//     AF411 site search when no group slug. Same in context menu.
//   • Header flash on scroll: 200ms hysteresis lockout + threshold
//     bumped 4→8px so small overshoot/correction motions during fast
//     scrolling no longer flap the bars on/off.
//   • Multi-copy CSV import: rows after the first are now appended as
//     additional copies (was: silently skipped). Round-trip tested.
//   • Grid card stack offsets bumped 5→8px and 10→16px with depth
//     shadow so the back card reads as a separate object instead of
//     a thick border.
//
// v4.94 changelog:
//   • CACHE bumped to v4.94.
//   • Audit fixes: orderedPaid===0 now migrates correctly (was falsy);
//     search input right padding 36→44px (long queries no longer overlap
//     the X clear button); .acc-chip-x tap target expanded via
//     padding+negative margin (visually identical, ~28×28 hit area);
//     deleteKidsCoreAdminFig now also clears overrides + photos.
//   • Stacked grid card visual: layered box-shadows give a clear depth
//     cue (was missing entirely; list-view stack offsets bumped 3→5px
//     and 6→10px with subtle shadows so the slivers read as cards
//     rather than a thick border).
//
// v4.93 changelog:
//   • CACHE bumped to v4.93 — activate() wipes old entries.
//   • Fixes:
//     - "Lines" breadcrumb now correctly returns to the lines grid. Was
//       broken since v4.91: crumbToLines reset activeLine but not S.tab,
//       which goToLine had set to 'all'. So clicking "Lines" dumped users
//       into the flat catalog list instead of the lines grid (giving the
//       "disappears, not functional" symptom).
//     - Kids Core admin: Faction is now a dropdown using the canonical
//       FACTIONS list, not free text. Prevents typos that would split
//       the Faction filter into unmergeable buckets.
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
// v5.06 changelog:
//   • CACHE bumped to v5.06.
//   • Default theme palette swap: Obsidian base (#09090b/#121217/#1c1c24)
//     with violet accent (#7c3aed) and Power-Sword gold (#facc15). Named
//     themes (skeletor/heman/grayskull/snake) keep their identities.
//   • Radius bumped 14→16px (sm 10→12) for a more premium feel.
//   • Cards: plastic-edge inset highlight + deeper layered shadows. Status
//     variants get tinted inset rings (the rim "catches light").
//   • Status buttons now have per-status icons (check / heart / box / tag)
//     in addition to color, for visual redundancy.
//   • Status-pop spring animation when a status becomes active.
//   • Tap targets: .icon-btn 38→44px, .chip min-height 44px.
//   • t3 lifted #71717a → #8a8d9a for WCAG AA contrast on bg2/bg3.
//   • Inputs gain a 3px focus ring (was 1px border shift, easy to miss).
//   • Buttons get :focus-visible outline for keyboard nav.
//   • Section header weight bumped 700→800, color t3→t2 for legibility.
//
// v5.05 changelog:
//   • CACHE bumped to v5.05.
//   • Back-at-root: no longer closes app on first press. Shows
//     "Press back again to exit" toast; second back within 2.5s exits.
//   • Custom figures: year coerced to Number on load so they merge into
//     the same year-grouped section as AF411 entries (was creating a
//     duplicate "2026" section because string!==number under ===).
//
// v5.04 changelog:
//   • CACHE bumped to v5.04.
//   • Stagger entrance animation restored, gated to navigation only
//     (data-stagger attribute set on #app). Status toggles and in-place
//     patches no longer replay it.
//   • Lines view toggle restyled into a proper section header — line
//     count on left, segmented toggle on right, breathing room above.
//   • Custom figures: app now loads motu-custom-figs from localStorage
//     at sync time, IDs auto-prefixed with 'custom-' to avoid AF411
//     collision when official entries arrive. Use the standalone
//     custom-figs-editor.html to add/edit/delete.
//
// v5.03 changelog:
//   • CACHE bumped to v5.03.
//   • Per-figure accessory availability list. Tap "⚙ Limit list" in the
//     accessory picker to choose which accessories are even offered for
//     that figure (e.g. Battle Armor He-Man → just Sword, Battle Axe,
//     mini comic). Stored under motu-acc-avail (per-figure-id list).
//     Empty/unset = full ACCESSORIES catalog as before. Custom-added
//     accessories on a copy still show even if not in the limited list.
//
// v5.02 changelog:
//   • CACHE bumped to v5.02. v5.01 was amended in place (same CACHE
//     constant) so existing SW didn't re-activate, leaving stale assets
//     cached. Bumping forces a clean install.
//
// v5.01 changelog:
//   • CACHE bumped to v5.01.
//   • Empty Collection state: clearer prompt with CTAs to Lines / All
//     when user lands on Collection tab with nothing tracked yet.
//   • Lines screen now has list/grid view toggle (separate setting from
//     the figures-list view; key: motu-lines-view).
//   • Filter chip flicker fixed: chip taps now patch only the sheet body
//     in place via patchFilter() instead of a full app re-render.
//   • Splash screen markup commented out (per user request).
//   • Bars auto-reappear after 3.5s of scroll idle so you never get
//     stranded without nav after stopping to read.
//
// v5.00 changelog:
//   • CACHE bumped to v5.00.
//   • Bars reappear when scrolled to the bottom of the figures list (was
//     left in whatever state on entry — sometimes hidden, blocking nav).
//   • Pull-to-refresh now opt-in (default OFF). Threshold raised 80→120px.
//     Toggle in Menu → Sync section. Some touchscreens were sensitive
//     enough to fire PTR during normal upward scrolling.
//   • Removed the inline "Add Figure" button on the Kids Core line —
//     adding figures is now via the standalone kids-core-editor.html.
//     Existing entries can still be edited via the per-figure Edit flow.
//   • PWA app-icon shortcuts: long-press the installed icon for quick
//     actions (Share Want List, Stats, Sync, Settings). Requires the
//     updated manifest.json — see /mnt/user-data/outputs/manifest.json.
//
// v4.99 changelog:
//   • CACHE bumped to v4.99.
//   • Settings export/import: theme, sort, view mode, line order, hidden
//     items, recent changes, default photo, onboarding flag, celebrated
//     flags. NOT collection data or photos. Format detection on import
//     auto-routes the JSON to the right handler.
//
// v4.98 changelog:
//   • CACHE bumped to v4.98.
//   • AF411 button: removed source==='af411' gate (many figures are
//     AF411-sourced but just missing that field in figures.json).
//     Tiered fallback: deep link if id matches AF411's <slug>-<NNNNN>
//     pattern; else group's index page; else all-figures index.
//
// v4.97 changelog:
//   • CACHE bumped to v4.97.
//   • AF411 group slugs fixed against real URLs from the all-figures
//     index: 'origins|Exclusives' was 'exclusives' (now 'origins-
//     exclusives'); 'origins|Vehicles & Playsets' was 'vehicles-playsets'
//     (now 'origins-beasts-vehicles-and-playsets'); 'origins|WWE' was
//     'wwe' (now 'masters-of-the-wwe-universe-action-figures'); added
//     entries for Stranger Things, Thundercats, and Transformers crossovers.
//   • AF411 fallback no longer points at the broken WP search endpoint;
//     opens the all-action-figures index instead so Ctrl+F finds the
//     figure even when its source field is missing.
//
// v4.96 changelog:
//   • CACHE bumped to v4.96.
//   • AF411 URL fix: Origins Deluxe slug was 'deluxe', actual path is
//     'origins-deluxe'. Affected all Origins Deluxe figures (Beast Man
//     Deluxe, etc.).
//   • AF411 search fallback now strips "(Deluxe)"/"(Variant)" parens
//     from the figure name and appends the line name so the search
//     query is tighter and less likely to land on a homepage.
//
// v4.95 changelog:
//   • CACHE bumped to v4.95.
//   • AF411 button now shows on detail screen for any non-Kids-Core,
//     non-custom figure (was gated on source==='af411'); falls back to
//     AF411 site search when no group slug. Same in context menu.
//   • Header flash on scroll: 200ms hysteresis lockout + threshold
//     bumped 4→8px so small overshoot/correction motions during fast
//     scrolling no longer flap the bars on/off.
//   • Multi-copy CSV import: rows after the first are now appended as
//     additional copies (was: silently skipped). Round-trip tested.
//   • Grid card stack offsets bumped 5→8px and 10→16px with depth
//     shadow so the back card reads as a separate object instead of
//     a thick border.
//
// v4.94 changelog:
//   • CACHE bumped to v4.94.
//   • Audit fixes: orderedPaid===0 now migrates correctly (was falsy);
//     search input right padding 36→44px (long queries no longer overlap
//     the X clear button); .acc-chip-x tap target expanded via
//     padding+negative margin (visually identical, ~28×28 hit area);
//     deleteKidsCoreAdminFig now also clears overrides + photos.
//   • Stacked grid card visual: layered box-shadows give a clear depth
//     cue (was missing entirely; list-view stack offsets bumped 3→5px
//     and 6→10px with subtle shadows so the slivers read as cards
//     rather than a thick border).
//
// v4.93 changelog:
//   • CACHE bumped to v4.93 — activate() wipes old entries.
//   • Fixes:
//     - "Lines" breadcrumb now correctly returns to the lines grid. Was
//       broken since v4.91: crumbToLines reset activeLine but not S.tab,
//       which goToLine had set to 'all'. So clicking "Lines" dumped users
//       into the flat catalog list instead of the lines grid (giving the
//       "disappears, not functional" symptom).
//     - Kids Core admin: Faction is now a dropdown using the canonical
//       FACTIONS list, not free text. Prevents typos that would split
//       the Faction filter into unmergeable buckets.
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

const CACHE = 'motu-vault-v6.13';

const SHELL = [
  'motu-vault.html',
  'manifest.json',
  'masters_logo.png',
  'vault.css',
  'js/app.js',
  'js/state.js',
  'js/photos.js',
  'js/data.js',
  'js/render.js',
  'js/handlers.js',
  'js/ui-sheets.js',
  'js/eggs.js',
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
