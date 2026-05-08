// ════════════════════════════════════════════════════════════════════
// MOTU Vault — delegate-handlers.js (v6.29)
// ────────────────────────────────────────────────────────────────────
// Registry of `data-action` names → handler functions. Imported once
// from app.js for its side effects (the registerAll calls below).
//
// To add a new action:
//   1. Add a line here mapping the action name to its handler.
//   2. In the render template, replace
//        `<button onclick="myFn('${esc(id)}')">…</button>`
//      with
//        `<button data-action="my-action" data-fig-id="${esc(id)}">…</button>`
//
// Handlers receive (event, triggerElement, data). data === trigger.dataset
// — strings indexed by the camelCase form of data-* attribute names.
//
// During the migration, inline onclick handlers continue to work
// alongside delegated ones. Both attach independently. Once all surfaces
// have been migrated, the inline pattern can be removed and CSP can drop
// 'unsafe-inline' from script-src.
// ════════════════════════════════════════════════════════════════════

import { registerAll } from './delegate.js';

// All the existing functions are already on `window` because of the
// inline-onclick pattern. We can call them directly without re-importing
// — and keeping it that way means the migration is one-directional: any
// surface still using the inline pattern continues to work without
// requiring its handlers to also be in this file.

// ── Click actions ───────────────────────────────────────────────────

registerAll({
  // Figure rows / cards / items — the main list-view interaction surface.
  // Each row carries data-fig-id; the row is the click target unless a
  // child element (e.g. status button) intercepts.
  'open-fig': (e, el, d) => window.openFig?.(d.figId),

  'cycle-status': (e, el, d) => {
    e.stopPropagation();
    window.cycleStatus?.(e, d.figId);
  },

  'set-status-owned': (e, el, d) => {
    e.stopPropagation();
    window.setStatus?.(d.figId, 'owned');
  },

  'select-toggle': (e, el, d) => {
    // toggleSelect needs to receive the original event so it can
    // stopPropagation and check shift/meta if multi-select is used.
    window.toggleSelect?.(e, d.figId);
  },

  // Detail screen status grid — set-status with an explicit value.
  // Replaces inline `setStatus('${id}','owned');patchDetailStatus()` etc.
  'set-status': (e, el, d) => {
    if (!d.figId || !d.status) return;
    window.setStatus?.(d.figId, d.status);
    window.patchDetailStatus?.();
  },

  // Detail screen — open photo viewer / edit sheet / accessory picker
  'open-photo-viewer': (e, el, d) => {
    e.stopPropagation();
    const n = d.photoN != null ? parseInt(d.photoN, 10) : -1;
    window.openPhotoViewer?.(d.figId, isNaN(n) ? -1 : n);
  },

  'close-photo-viewer': () => window.closePhotoViewer?.(),

  'photo-viewer-nav': (e, el, d) => {
    e.stopPropagation();
    const dir = parseInt(d.dir, 10);
    if (Number.isFinite(dir)) window.photoViewerNav?.(dir);
  },

  'set-default-photo': (e, el, d) => {
    e.stopPropagation();
    const n = parseInt(d.photoN, 10);
    if (!d.figId || !Number.isFinite(n)) return;
    window.setDefaultPhoto?.(d.figId, n);
    window.toast?.('★ Set as default');
  },

  // Navigation
  'nav-to': (e, el, d) => {
    if (!d.target) return;
    window.navTo?.(d.target);
  },

  'go-to-line': (e, el, d) => {
    if (!d.lineId) return;
    window.goToLine?.(d.lineId);
  },

  // Breadcrumb navigation
  'crumb-to-lines': () => window.crumbToLines?.(),
  'crumb-to-line':  () => window.crumbToLine?.(),

  'select-subline': (e, el, d) => {
    window.selectSubline?.(d.subline || '__all__');
  },

  // Subline hide/show toggle. The card itself has data-action="select-subline";
  // because the dispatcher uses closest() to find the nearest data-action
  // ancestor, clicking the hide-btn naturally wins over the card without
  // any stopPropagation acrobatics.
  'toggle-subline-hidden': (e, el, d) => {
    if (!d.lineId || !d.subline) return;
    window.toggleHidden?.(d.lineId + ':' + d.subline);
  },

  // Search clear / filter clear (used by empty-state CTAs and search bar)
  'clear-search': () => window.onSearch?.(''),
  'clear-filters': () => window.patchFilter?.('clear'),
  'clear-search-and-filters': () => {
    window.onSearch?.('');
    window.patchFilter?.('clear');
  },

  // Sheet open/close
  'open-sheet': (e, el, d) => {
    if (!d.sheet) return;
    window.openSheet?.(d.sheet);
  },
  'close-sheet': () => window.closeSheet?.(),

  // v6.30: dismiss the storage-broken banner for this session. Banner
  // reappears next session if storage is still unavailable, intentionally —
  // we can't persist the dismissal in the same storage we're warning about.
  'dismiss-storage-banner': () => {
    window.S.storageDismissed = true;
    window.render?.();
  },

  // First-load fetch failure retry.
  'retry-fetch': () => window.fetchFigs?.(true, true),

  // v6.33: about-screen mute toggle (was wired by data-action but never
  // registered, so the button silently did nothing on Android).
  'toggle-about-mute': () => window.toggleAboutMute?.(),

  // v6.31: wishlist history actions
  'reopen-wishlist': (e, el, d) => {
    const idx = parseInt(d.idx, 10);
    if (!Number.isFinite(idx)) return;
    const arr = window.getWishlistHistory?.() || [];
    const entry = arr[idx];
    if (!entry || !entry.nums) return;
    // Build the share URL and load it via the share-link path so
    // recordWishlistView() bumps the timestamp on the existing entry.
    const payload = btoa(entry.nums.join(','))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    // Set hash WITHOUT page reload — checkShareLink reads location.hash
    // directly, so just update it and call.
    window.S.sheet = null;   // close the menu/history sheet first
    history.replaceState({}, '', location.pathname + location.search + '#wl=' + payload);
    window.checkShareLink?.();
  },
  'delete-wishlist-entry': (e, el, d) => {
    const idx = parseInt(d.idx, 10);
    if (!Number.isFinite(idx)) return;
    window.deleteWishlistHistoryEntry?.(idx);
    // Re-render just the sheet body
    const body = document.querySelector('.sheet-body');
    if (body && window.S.sheet === 'wishlistHistory') {
      // Defer the import-cycle-free way: call the registered renderer via
      // openSheet, which already re-renders. Or just call render() — this
      // is a settings-level action, performance is not the concern.
      window.render?.();
    }
  },
  'clear-wishlist-history': async (e) => {
    if (!await window.appConfirm?.('Clear all viewed-wishlist history?', { danger: true, ok: 'Clear' })) return;
    window.clearWishlistHistory?.();
    window.toast?.('✓ History cleared');
    window.render?.();
  },
});

// ── Error actions (capture phase — events don't bubble) ───────────
// Image load failures still need a per-row hook so the broken-image
// fallback fires. Use data-error-action="img-error" on the <img>.

registerAll({
  'img-error': (e, el, d) => window.imgErr?.(d.figId),
}, 'error');

// ── Change/input/blur actions ───────────────────────────────────────
// Used for inputs in the detail/edit views. Less common but still need
// the same data-action style.

registerAll({
  // Photo label inputs on the detail screen save on blur. Previously:
  //   onblur="setPhotoLabel(${jId},${p.n},this.value)"
  'save-photo-label': (e, el, d) => {
    const n = parseInt(d.photoN, 10);
    if (!d.figId || !Number.isFinite(n)) return;
    window.setPhotoLabel?.(d.figId, n, el.value);
  },
}, 'blur');
