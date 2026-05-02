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
import { S, store, CACHE_KEY, LOADOUTS_CACHE_KEY, CACHE_TTL, IMG } from './state.js';
import {
  initOPFS, loadPhotoLabels, loadPhotoCopyMap,
  photoStore, _opfsReady,
} from './photos.js';
import {
  loadOverrides, applyOverrides, fetchFigs, migrateColl,
  rebuildFigIndex, saveColl,
} from './data.js';
import {
  render, toast, haptic, showUpdateBanner,
  checkShareLink, checkShortcutAction,
} from './render.js';
import {
  SND, preloadSound, preloadImage, getThemeSounds,
} from './eggs.js';
import './handlers.js';
import './ui-sheets.js';
import './tutorial.js';


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
});

// § INIT ── init(), OPFS setup, cache load, splash removal ─────────
async function init() {
  // Splash-first: let the browser commit the splash animation's first frames
  // before we kick off heavy work (OPFS init, localStorage parsing, render,
  // figures.json fetch). Two rAFs ≈ 16-33ms — invisible to the user but
  // enough time for the CSS animation to be running on the compositor
  // thread before we start competing for the main thread.
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Load collection
  const c = store.get('motu-c2');
  if (c) {
    let loaded = Object.fromEntries(Object.entries(c).map(([id, entry]) => {
      if (entry?.variants !== undefined && !/\w/.test(entry.variants)) {
        const { variants, ...rest } = entry;
        return [id, rest];
      }
      return [id, entry];
    }));
    // v4.42 schema migration: flat fields → copies array. Idempotent.
    loaded = migrateColl(loaded);
    S.coll = loaded;
    saveColl();  // Persist migrated form so future loads skip the work
  }
  // Load persisted recent changes
  const rc = store.get('motu-recent');
  if (rc && Array.isArray(rc)) S._recentChanges = rc;
  const dp = store.get('motu-default-photo');
  if (dp && typeof dp === 'object') S.defaultPhoto = dp;
  // Load any field overrides — applied automatically inside rebuildFigIndex
  loadOverrides();
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
  // Load cached figs
  const cached = store.get(CACHE_KEY);
  if (cached?.rows?.length) {
    S.figs = cached.rows.map(f => ({...f, image: f.image || (f.slug ? `${IMG}/${f.slug}.jpg` : '')}));
    rebuildFigIndex();
    S.syncTs = cached.ts;
    S.loaded = true;
    // v6.24: restore loadouts so complete badges render correctly before fetch
    const cachedLoadouts = store.get(LOADOUTS_CACHE_KEY);
    if (cachedLoadouts && typeof cachedLoadouts === 'object') S._repoLoadouts = cachedLoadouts;
  }
  // Apply theme
  document.documentElement.setAttribute('data-theme', S.theme);
  // Preload sounds so first play is buffer-ready, not mid-download
  Object.values(SND).forEach(preloadSound);
  const themeSounds = getThemeSounds().filter(Boolean);
  themeSounds.forEach(preloadSound);
  // Preload easter egg images so they fire without load delay
  preloadImage(IMG + '/adam-icon.png');
  preloadImage(IMG + '/eternia2-icon.png');
  // One-time migration: wave default → year default (v3.9)
  if (S.sortBy === 'wave') { S.sortBy = 'year'; store.set('motu-sort', 'year'); }
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
