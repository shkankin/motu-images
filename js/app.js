// ════════════════════════════════════════════════════════════════════
// MOTU Vault — app.js (entry point, v6.02)
// ────────────────────────────────────────────────────────────────────
// Imports every module for its side effects (window.* handler
// registration, etc.), then runs init() to boot OPFS, load cached
// figures, and fetch from the network.
// ════════════════════════════════════════════════════════════════════

// Side-effect imports (order matters — state.js is the leaf, others
// build on it; render.js exposes window.render which data.js + photos.js
// call lazily to break circular refs).
import { S, store, CACHE_KEY, LOADOUTS_CACHE_KEY, CACHE_TTL, IMG, SUBLINES } from './state.js';
import { hydrate as idbHydrate, bigGet } from './idb-store.js';
import {
  initOPFS, loadPhotoLabels, loadPhotoCopyMap,
  photoStore, _opfsReady,
} from './photos.js';
import {
  loadOverrides, applyOverrides, fetchFigs, migrateColl,
  rebuildFigIndex, saveColl, loadPersistedNewFigIds, mergeCustomSublines,
  backupDue, getBackupMeta,
} from './data.js';
import {
  render, toast, haptic, showUpdateBanner,
} from './render.js';
import {
  checkShareLink, checkShortcutAction,
} from './share.js';
import {
  SND, preloadSound, preloadImage, getThemeSounds, _syncThemeColor,
} from './eggs.js';
import './handlers.js';
import './ui-sheets.js';
import './tutorial.js';
// v6.28: pricing layer (eBay sold-listing market values via configurable
// backend). The module registers window.refreshPricing on load; the rest is
// pull-only — render.js calls renderMarketValueBlock when drawing the detail.
import * as pricing from './pricing.js';
import { recordValueSnapshot } from './stats.js';
// v6.29: event delegation. Replaces inline onclick="…" with data-action
// attributes resolved through a single document-level dispatcher. See
// delegate.js for rationale.
import { bootDelegation } from './delegate.js';
import './delegate-handlers.js';   // registers actions for delegated events


// ── Window bridge ─────────────────────────────────────────────────
// Inline `onclick=` handlers run in window scope, not module scope.
// Expose every name they reference. Most window-callable handlers are
// already attached via `window.X = ...` in their defining modules; these
// are the additional exposures (state, render, store, and a few funcs).
import * as data from './data.js';
import * as renderMod from './render.js';
import * as handlersMod from './handlers.js';
import * as uiSheets from './ui-sheets.js';
import * as photos from './photos.js';
import * as eggs from './eggs.js';

Object.assign(window, {
  // Core state + helpers (referenced from inline handlers in render templates)
  S, store, render, toast, haptic,
  toastAction: renderMod.toastAction,
  // Functions used in inline handlers but not previously mirrored
  renderSheetBody: data.renderSheetBody,
  initPhotoViewerZoom: photos.initPhotoViewerZoom,
  isMigrated: data.isMigrated,
  // Already-exposed in their modules but listed here for clarity / safety net:
  fetchFigs, saveColl,
  // Render helpers used in inline strings
  renderSelectActionbar: renderMod.renderSelectActionbar,
  // Sound triggers used in title-tap inline handlers
  playTitleSound: eggs.playTitleSound,
  // v6.28: pricing layer
  configurePricingBackend: pricing.configurePricingBackend,
  isPricingConfigured:     pricing.isPricingConfigured,
  getPricingBackend:       pricing.getPricingBackend,
  clearPricingCache:       pricing.clearPricingCache,
  fetchPricing:            pricing.fetchPricing,
  // Help is a thin re-export so tutorial.js can be triggered from Settings.
  // tutorial.js sets window.startTutorial itself; this is a no-op safety net.
});

// § INIT ── init(), OPFS setup, cache load, splash removal ─────────
async function init() {
  // Splash-first: let the browser commit the splash animation's first frames
  // before we kick off heavy work (OPFS init, localStorage parsing, render,
  // figures.json fetch). Two rAFs ≈ 16-33ms — invisible to the user but
  // enough time for the CSS animation to be running on the compositor
  // thread before we start competing for the main thread.
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // v6.30: probe storage at boot so the persistent banner appears
  // immediately if we're in Safari private mode or otherwise can't write.
  // Uses the same store.set() path so the broken-state listeners fire.
  // The probe key is a tiny round-trip; cleaned up after.
  try {
    const ok = store.set('motu-storage-probe', 1);
    if (ok) localStorage.removeItem('motu-storage-probe');
  } catch {}

  // v6.96: hydrate the IndexedDB-backed stores into the in-memory mirror before
  // anything reads them. This single await covers the collection (motu-c2) and
  // the catalog cache (motu-figs-cache + its loadouts companion), performs a
  // one-time migration of any copy still in localStorage, and transparently
  // falls back to localStorage if IndexedDB is unavailable. After it resolves,
  // bigGet()/bigSet() are synchronous, so the rest of boot is unchanged.
  await idbHydrate(['motu-c2', CACHE_KEY, LOADOUTS_CACHE_KEY,
                    // v7.44: pricing cache + history moved to IDB (see
                    // pricing.js _loadCache note — silent localStorage
                    // quota failures were wiping bulk-fetched prices).
                    'motu-pricing-cache', 'motu-pricing-history']);

  // Load collection (from the IndexedDB mirror)
  let c = bigGet('motu-c2');
  // v6.96: journal recovery. flushSaveColl() writes a synchronous localStorage
  // "journal" snapshot of S.coll on tab-hide, because an IndexedDB write started
  // in a pagehide handler isn't guaranteed to finish before the page is killed.
  // The journal is cleared on resume (visibilitychange→visible) during normal
  // use, so a NON-EMPTY journal still present at a cold boot specifically means
  // the app was killed while backgrounded before its IDB write committed — the
  // journal is then the most-recent snapshot. Prefer it, re-persist to IDB, then
  // consume it. The non-empty guard ensures a stray/empty journal can never
  // clobber a good collection.
  try {
    const journal = store.get('motu-c2-journal');
    if (journal && typeof journal === 'object' && Object.keys(journal).length) {
      c = journal;
      bigSet('motu-c2', c);
    }
  } catch {}
  try { localStorage.removeItem('motu-c2-journal'); } catch {}
  if (c) {
    let loaded = Object.fromEntries(Object.entries(c).map(([id, entry]) => {
      if (entry?.variants !== undefined && !/\w/.test(entry.variants)) {
        const { variants, ...rest } = entry;
        return [id, rest];
      }
      return [id, entry];
    }));
    // v4.42 schema migration: flat fields → copies array. Idempotent.
    // v6.27: only persist if migration actually changed something. The previous
    // version called saveColl() unconditionally on every cold start, bumping
    // _collVersion and invalidating the _derived cache before the first render.
    const before = JSON.stringify(loaded);
    loaded = migrateColl(loaded);
    S.coll = loaded;
    if (JSON.stringify(loaded) !== before) saveColl();
  }
  // v6.72 CRITICAL: only after this point is it safe to persist S.coll.
  // The pagehide/beforeunload/visibilitychange flush in data.js previously
  // ran unconditionally — if boot failed before this line (module-version
  // mismatch during a partial deploy, SW serving a stale module, an init
  // exception), the first tab-hide overwrote the stored collection with
  // the empty initial S.coll = {}. That is a real data wipe. The flag
  // also covers legitimate first runs: no stored collection means an empty
  // write is harmless, and it's set here either way.
  S._collLoaded = true;
  // Load persisted recent changes
  const rc = store.get('motu-recent');
  if (rc && Array.isArray(rc)) S._recentChanges = rc;
  const dp = store.get('motu-default-photo');
  if (dp && typeof dp === 'object') S.defaultPhoto = dp;
  // Load any field overrides — applied automatically inside rebuildFigIndex
  loadOverrides();
  // v6.28: restore persisted newFigIds so NEW pills survive a reload.
  // Auto-expires entries older than 14 days inside the loader.
  loadPersistedNewFigIds();
  // Initialize OPFS for photo storage
  await initOPFS();
  // One-time migrations (must run BEFORE loadAll so URL cache is correct)
  if (_opfsReady) {
    const m1 = await photoStore.migrateLegacyLS();     // Old LS single → OPFS
    const m2 = await photoStore.migrateToMulti();      // OPFS single → OPFS multi (photo-{id}.jpg → photo-{id}-0.jpg)
    if (m1 + m2 > 0) console.log(`Photo migrations: ${m1} from localStorage, ${m2} to multi-photo format`);
  }
  // Load all photos into URL cache (OPFS + localStorage fallback)
  await photoStore.loadAll();
  // Load cached figs (already hydrated into the mirror in the unified
  // idbHydrate() call near the top of boot — see v6.96 note above).
  const cached = bigGet(CACHE_KEY);
  if (cached?.rows?.length) {
    // v6.75 BUG FIX: custom figures/variants (CUSTOM_FIGS_KEY) were only
    // merged into S.figs during a full network sync. Adding a variant
    // writes it to CUSTOM_FIGS_KEY + S.figs but does NOT rewrite CACHE_KEY,
    // so on the next cold start the cached rows are stale and the variant
    // vanishes until the next successful sync (its photo survived because
    // photos live in their own store — exactly the symptom reported).
    // Re-merge the custom store over the cached rows here, every boot.
    const cachedRows = cached.rows.map(f => ({...f, image: f.image || (f.slug ? `${IMG}/${f.slug}.jpg` : '')}));
    const cachedIds = new Set(cachedRows.map(f => f.id));
    const localCustom = (store.get('motu-custom-figs') || []).map(f => ({
      ...f,
      source: 'custom-local',
      id: f.id && f.id.startsWith('custom-') ? f.id : 'custom-' + f.id,
      year: f.year ? Number(f.year) : f.year,
      retail: f.retail ? Number(f.retail) : f.retail,
      image: f.slug ? `${IMG}/${f.slug}.jpg` : (f.image || ''),
    })).filter(f => !cachedIds.has(f.id));
    S.figs = [...cachedRows, ...localCustom];
    rebuildFigIndex();
    S.syncTs = cached.ts;
    S.loaded = true;
    // v6.24: restore loadouts so complete badges render correctly before fetch
    // v6.33: cache shape is now {loadouts, customAccessories} but legacy entries
    // are a plain {[figId]: [...]} object — detect and migrate inline.
    const cachedLoadouts = bigGet(LOADOUTS_CACHE_KEY);
    if (cachedLoadouts && typeof cachedLoadouts === 'object') {
      if (cachedLoadouts.loadouts && typeof cachedLoadouts.loadouts === 'object') {
        S._repoLoadouts = cachedLoadouts.loadouts;
        if (Array.isArray(cachedLoadouts.customAccessories)) {
          S._repoCustomAccessories = cachedLoadouts.customAccessories;
        }
        // v6.39: restore and re-inject custom sublines from cache
        if (cachedLoadouts.customSublines && typeof cachedLoadouts.customSublines === 'object') {
          S._repoCustomSublines = cachedLoadouts.customSublines;
          mergeCustomSublines(SUBLINES, cachedLoadouts.customSublines);
        }
        // v6.43: restore subline display order from cache
        if (cachedLoadouts.sublineOrder && typeof cachedLoadouts.sublineOrder === 'object') {
          S._sublineOrder = cachedLoadouts.sublineOrder;
        }
      } else {
        S._repoLoadouts = cachedLoadouts;
      }
    }
  }
  // Apply theme
  document.documentElement.setAttribute('data-theme', S.theme);
  _syncThemeColor(S.theme);   // v6.94: align browser chrome with a saved theme
  // Preload sounds so first play is buffer-ready, not mid-download
  Object.values(SND).forEach(preloadSound);
  const themeSounds = getThemeSounds().filter(Boolean);
  themeSounds.forEach(preloadSound);
  // Preload easter egg images so they fire without load delay
  preloadImage(IMG + '/adam-icon.png');
  preloadImage(IMG + '/eternia2-icon.png');
  // One-time migration: wave default → year default (v3.9)
  if (S.sortBy === 'wave') { S.sortBy = 'year'; store.set('motu-sort', 'year'); }
  // v6.29: install the document-level event dispatcher before first render
  // so newly-rendered data-action elements are immediately responsive.
  bootDelegation();
  // Render the UI behind the splash so it's ready by the time splash fades.
  render();
  // Defer the figures.json network request until the splash is well past its
  // entry phase (~1s in). Cached data already populated the view above, so
  // the user isn't waiting on this. Purely a politeness delay to keep the
  // network off the critical path during splash.
  const hasCache = !!(cached?.rows?.length);
  const needsFetch = !cached?.ts || Date.now() - cached.ts > CACHE_TTL;
  if (needsFetch) {
    setTimeout(() => fetchFigs(false, !hasCache), 1000);
  }
  // v7.20: if a sync attempt failed (weak/no signal — e.g. inside a store),
  // retry automatically the moment connectivity returns, instead of leaving
  // it to the user noticing the sync icon or waiting for the next natural
  // CACHE_TTL-driven check on some future app open. fetchFigs()'s own
  // in-flight guard covers 'online' firing more than once in quick
  // succession (some browsers do this on network changes).
  window.addEventListener('online', () => {
    if (S.syncStatus === 'err') fetchFigs(false, false);
  });
  // Remove splash when the CSS animation finishes. animationend keeps it
  // tight — no hard timer, no drift. Safety timeout covers the 2.8s animation
  // in case the image failed silently.
  const splash = document.getElementById('splash');
  if (splash) {
    let _splashTimer;
    const kill = () => { clearTimeout(_splashTimer); splash.remove(); };
    const img = splash.querySelector('.splash-logo');
    if (img) img.addEventListener('animationend', kill, {once: true});
    _splashTimer = setTimeout(kill, 3000);
    splash.addEventListener('click', kill, {once: true});
  }
  // v6.67: backup nag. Local-only storage is evictable on mobile; if the
  // user has piled up edits with no recent export, surface a gentle nudge.
  // Throttled to once per 3 days so it never becomes wallpaper.
  // v7.38 fix: toastAction lives in render.js and was never bridged to
  // window — only ever usable as a module export. The `typeof window.
  // toastAction === 'function'` guard below was always false, so this
  // whole block silently did nothing no matter how backupDue() evaluated.
  // app.js already imports render.js wholesale as renderMod; using that
  // directly is also more correct than a window bridge would have been,
  // since this file is a normal ES module, not the intentionally
  // import-free delegate-handlers.js.
  setTimeout(() => {
    try {
      if (!backupDue()) return;
      const NAG_TS_KEY = 'motu-backup-nag-ts';
      const last = store.get(NAG_TS_KEY) || 0;
      if (Date.now() - last < 3 * 24 * 60 * 60 * 1000) return;
      store.set(NAG_TS_KEY, Date.now());
      const n = getBackupMeta().changes;
      renderMod.toastAction(`${n} change${n === 1 ? '' : 's'} since your last backup`, 'Back up', () => window.openSheet?.('export'));
    } catch {}
  }, 4000);

  // v6.69: price-watch deal toast. Cache-only check (no network) for
  // wishlist/ordered figures at/below their target. Once per day max.
  // v7.38 fix: same bug as the backup nag above — window.toastAction was
  // never bridged, so this never actually displayed either.
  setTimeout(() => {
    try {
      const DEAL_TS_KEY = 'motu-deal-nag-ts';
      const last = store.get(DEAL_TS_KEY) || 0;
      if (Date.now() - last < 24 * 60 * 60 * 1000) return;
      let deals = 0;
      for (const f of S.figs) {
        const c = S.coll[f.id];
        if (!c || (c.status !== 'wishlist' && c.status !== 'ordered')) continue;
        const t = parseFloat(c.targetPrice);
        if (!Number.isFinite(t)) continue;
        const a = pricing.getCachedAskingPrice(f);
        if (a != null && a <= t) deals++;
      }
      if (!deals) return;
      store.set(DEAL_TS_KEY, Date.now());
      renderMod.toastAction(`${deals} want-list figure${deals === 1 ? '' : 's'} at or below your target price`, 'View', () => window.goToFiltered?.('wishlist'));
    } catch {}
  }, 6000);

  // v7.42: record the daily Vault Worth snapshot (stats.js). Deferred like
  // the nags so it never competes with first paint; recordValueSnapshot is
  // internally throttled to one snapshot per ~20h and try/caught, so this
  // is safe to call unconditionally on every boot.
  setTimeout(() => recordValueSnapshot(), 3000);

  // Check for incoming share link in URL fragment
  checkShareLink();
  // v5.00: PWA shortcut deep-links via ?action=...
  checkShortcutAction();
}


// § BOOT ── SW registration, UPDATE_AVAILABLE handler, online/offline, init() call ──
if ('serviceWorker' in navigator) {
  // updateViaCache:'none' prevents the browser's HTTP cache from serving
  // a stale sw.js (otherwise a long Cache-Control on the SW script can
  // freeze users on an old service worker for up to 24h).
  navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'}).catch(() => {});
  // v7.18: request persistent storage. Without this, Cache Storage (incl.
  // sw.js's IMG_CACHE) is "best-effort" and the browser can silently evict
  // it under storage pressure — separate from, and more likely than, the
  // v6.84 versioned-cache-wipe bug (that fix is a different mechanism,
  // already in place, already verified intact). Matches the reported
  // symptom well: happens occasionally, not tied to any specific deploy,
  // fixed by anything that forces a full re-populate (which clearing site
  // data does). Not a guaranteed fix — the browser can still decline — but
  // it's the standard mitigation, and installed PWAs are usually granted it.
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  // Listen for background update notification from SW
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'UPDATE_AVAILABLE') {
      // Show a persistent update banner so the user can choose when to refresh.
      // Also set up silent reload on next background (tab hidden) as a fallback.
      showUpdateBanner();
      let reloaded = false;
      const reload = () => { if (!reloaded) { reloaded = true; window.location.reload(); } };
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') reload(); }, {once: true});
    }
  });
}
// v6.30: last-ditch global error handlers. The app handles its own errors
// in dozens of places, but for anything that escapes (logic bug, browser
// quirk, third-party tool injection), we want at least one user-visible
// surface so the failure isn't silent. Toasts are throttled — repeated
// errors within 10s are suppressed to avoid spam.
let _lastUncaughtToast = 0;
function _surfaceUncaught(label, detail) {
  console.error('[uncaught]', label, detail);
  const now = Date.now();
  if (now - _lastUncaughtToast < 10000) return;
  _lastUncaughtToast = now;
  try { toast('⚠ Something went wrong — please try again', { duration: 5000 }); } catch {}
}
window.addEventListener('error', e => {
  // Filter out resource load errors (img onerror etc.) — those bubble up
  // here too and aren't worth toasting.
  if (e?.target && e.target !== window && e.target.tagName) return;
  _surfaceUncaught('error', e?.error || e?.message);
});
window.addEventListener('unhandledrejection', e => {
  _surfaceUncaught('unhandledrejection', e?.reason);
});

// Online/offline detection
window.addEventListener('online', () => {
  S.isOffline = false;
  S.imgErrors = {};
  toast('✓ Back online');
  haptic && haptic();
  render();
});
window.addEventListener('offline', () => {
  S.isOffline = true;
  toast('✗ Connection lost');
  haptic && haptic();
  render();
});

init();
