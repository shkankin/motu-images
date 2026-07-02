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

  // v7.22: the pinned-open swipe action bar's three buttons. 'detail'
  // reuses open-fig's own function rather than touching status at all —
  // full swipe was deliberately designed to never force a status choice.
  'swipe-commit': (e, el, d) => {
    e.stopPropagation();
    window._closeSwipeRow?.(d.figId, false);
    if (d.swipeDo === 'detail') { window.openFig?.(d.figId); return; }
    if (d.swipeDo === 'owned' || d.swipeDo === 'wishlist') {
      window.setStatus?.(d.figId, d.swipeDo);
      window.patchFigRow?.(d.figId);
    }
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

// ── Context-menu actions (long-press popup) ──────────────────────
// v7.09: these were inline onclick="…" in handlers.js showContextMenu and
// were silently dead under the v7.00 strict CSP (script-src 'self'). The
// whole long-press menu — set status, add copy, AF411, open, edit, variant,
// select — did nothing on tap. Now routed through delegation like the rest.
registerAll({
  'ctx-set-status':  (e, el, d) => window.ctxSetStatus?.(d.figId, d.status),
  'ctx-add-copy':    (e, el, d) => { window.dismissContextMenu?.(); window.addCopy?.(d.figId); window.toast?.('✓ Copy added'); },
  'ctx-af411':       (e, el, d) => { window.dismissContextMenu?.(); window.openAF411?.(d.figId); },
  'ctx-open':        (e, el, d) => { window.dismissContextMenu?.(); window.openFig?.(d.figId); },
  'ctx-edit-info':   (e, el, d) => { window.dismissContextMenu?.(); window.openFigureEditor?.(d.figId); },
  'ctx-add-variant': (e, el, d) => { window.dismissContextMenu?.(); window.addVariant?.(d.figId); },
  'ctx-select':      (e, el, d) => { window.dismissContextMenu?.(); window.enterSelectModeWith?.(d.figId); },
});

// ── Error actions (capture phase — events don't bubble) ───────────
// Image load failures still need a per-row hook so the broken-image
// fallback fires. Use data-error-action="img-error" on the <img>.
//
// v7.09: img-hide / img-fallback replace inline onerror="…" attributes the
// v7.00 strict CSP blocked, so broken images showed the browser's broken
// glyph instead of hiding. img-hide removes the element; img-fallback swaps
// to data-fallback-src once and hides if that also fails.

registerAll({
  'img-error': (e, el, d) => window.imgErr?.(d.figId),
  'img-hide':  (e, el) => { el.style.display = 'none'; },
  // v7.19: img-fallback previously only tried a different filename (.jpg ->
  // .png), which assumes the failure is "wrong extension." It never
  // considered that the SW's cached response for this exact URL could
  // itself be stale/bad — in which case swapping to another filename just
  // hits the same working-fine SW cache logic with a different key, while
  // the real broken entry sits there forever. Stage 0 now deletes that
  // specific cache entry directly (Cache Storage is available page-side,
  // not just inside the SW) and forces a real reload of the SAME url —
  // 'motu-vault-images' must match IMG_CACHE in sw.js; they can't share an
  // import since one runs in the SW scope, so keep them in sync by hand.
  // A cache miss re-fetches from network and re-populates under the same
  // key, so this also fixes it for every future load, not just this one.
  // Stage 1 (still broken after that) falls through to the old filename-
  // swap behavior. Stage 2 (both failed) hides the element as before.
  'img-fallback': (e, el, d) => {
    const stage = el.dataset.retryStage || '0';
    if (stage === '0') {
      el.dataset.retryStage = '1';
      const src = el.src;
      caches.open('motu-vault-images').then(c => c.delete(src)).catch(() => {}).then(() => {
        el.src = '';
        el.src = src;
      });
      return;
    }
    if (stage === '1' && d.fallbackSrc) {
      el.dataset.retryStage = '2';
      el.src = d.fallbackSrc;
      return;
    }
    el.style.display = 'none';
  },
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

// ── v6.103: Full migration — all new actions registered below ───────

// ── Additional click actions ────────────────────────────────────────

registerAll({

  // Header / navigation
  'home-icon':        () => window.homeIconClick?.(),
  'sync-now':         () => window.fetchFigs?.(true),
  'sync-bg':          () => window.fetchFigs?.(),
  'recover-to-main':  () => { window.S.screen = 'main'; window.S.sheet = null; window.render?.(); },
  'start-tutorial':   () => window.startTutorial?.(),
  'dismiss-onboard':  () => { window.S.onboarded = true; window.store?.set('motu-onboarded', 1); window.render?.(); },
  'toggle-reorder':   () => window.toggleReorder?.(),
  'open-barcode-scanner': () => window.openBarcodeScanner?.(),

  // Lines grid — reorder (drag handled separately in handlers.js; this is
  // just the per-row Hide toggle, still a plain click action)
  'toggle-line-hidden': (e, el, d) => {
    e.stopPropagation();
    window.toggleHidden?.(d.lineId);
  },

  // Lines view toggle
  'set-lines-view': (e, el, d) => {
    window.store?.set('motu-lines-view', d.view);
    window.render?.();
  },

  // Figure list controls
  'enter-select': () => window.enterSelectMode?.(),
  'exit-select':  () => window.exitSelectMode?.(),
  'set-view': (e, el, d) => window.setViewMode?.(d.view),

  // Select actionbar
  'cancel-confirm-clear': () => {
    window.S.confirmClear = false;
    const bar = document.querySelector('.select-actionbar');
    if (bar) bar.outerHTML = window.renderSelectActionbar?.() ?? bar.outerHTML;
  },
  'confirm-batch-clear': () => {
    window.S.confirmClear = false;
    window.batchSetStatus?.('');
  },
  'begin-confirm-clear': (e, el) => {
    window.S.confirmClear = true;
    const bar = document.querySelector('.select-actionbar');
    if (bar) bar.outerHTML = window.renderSelectActionbar?.() ?? bar.outerHTML;
  },
  'batch-set-status': (e, el, d) => window.batchSetStatus?.(d.status),
  'select-all-visible': () => window.selectAllVisible?.(),
  'open-batch-editor':  () => window.openBatchEditor?.(),
  'batch-delete-photos': () => window.batchDeletePhotos?.(),

  // Kids Core admin
  'save-kc-fig':    () => window.saveKidsCoreAdminFig?.(),
  'delete-kc-fig':  (e, el, d) => window.deleteKidsCoreAdminFig?.(d.figId),
  'kc-edit-fig':    (e, el, d) => {
    window.S._kcEditId = d.figId;
    window.S._kcForm = null;
    window.render?.();
  },
  'kc-set-group':   (e, el, d) => {
    window.S._kcForm = window.S._kcForm || {};
    window.S._kcForm.group = d.group;
    window.render?.();
  },

  // Copy card actions
  'delete-custom-fig': (e, el, d) => window.deleteCustomFig?.(d.figId),
  'remove-copy':       (e, el, d) => window.removeCopy?.(d.figId, d.copyId),
  'remove-accessory':  (e, el, d) => window.removeAccessory?.(d.figId, d.copyId, parseInt(d.accIdx, 10)),
  'open-accessory-picker': (e, el, d) => window.openAccessoryPicker?.(d.figId, d.copyId),
  'add-accessory':     (e, el, d) => window.addAccessory?.(d.figId, d.copyId, d.accName),
  'mark-copy-sold':    (e, el, d) => window.markCopySold?.(d.figId, d.copyId),
  'open-copy-photo':   (e, el, d) => {
    const n = parseInt(d.photoN, 10);
    window.openCopyPhoto?.(d.figId, isNaN(n) ? 0 : n);
  },
  'unlink-copy-photo': (e, el, d) => {
    e.stopPropagation();
    const n = parseInt(d.photoN, 10);
    window.unlinkCopyPhoto?.(d.figId, isNaN(n) ? 0 : n);
  },

  // Detail screen
  'close-detail':   () => window.closeDetail?.(),
  'trigger-camera': () => document.getElementById('photoCamera')?.click(),
  'trigger-gallery': () => document.getElementById('photoGallery')?.click(),
  'remove-photo':   (e, el, d) => {
    e.stopPropagation();
    const n = parseInt(d.photoN, 10);
    window.removePhoto?.(d.figId, isNaN(n) ? 0 : n);
  },
  'open-slide-viewer': (e, el, d) => {
    const idx = parseInt(d.slideIdx, 10);
    window.openSlideViewer?.(d.figId, isNaN(idx) ? 0 : idx);
  },
  'add-variant':    (e, el, d) => window.addVariant?.(d.figId),
  'add-copy':       (e, el, d) => window.addCopy?.(d.figId),
  'open-af411':     (e, el, d) => { e.preventDefault(); window.openAF411?.(d.figId); },
  'open-figure-editor': (e, el, d) => window.openFigureEditor?.(d.figId),

  // Photo viewer
  'close-photo-viewer-bg': (e, el) => {
    if (e.target === el) window.closePhotoViewer?.();
  },
  'close-photo-viewer': () => window.closePhotoViewer?.(),
  'photo-viewer-nav':   (e, el, d) => {
    e.stopPropagation();
    const dir = parseInt(d.dir, 10);
    if (Number.isFinite(dir)) window.photoViewerNav?.(dir);
  },
  'photo-viewer-noop': (e) => e.stopPropagation(),

  // Sheet overlay — close when clicking backdrop
  'close-sheet-bg': (e, el) => {
    if (e.target === el || e.target.classList.contains('sheet-backdrop')) window.closeSheet?.();
  },

  // Location sheet
  'loc-sheet-back': () => window.patchLocSheet?.(null),
  'loc-open-fig':   (e, el, d) => { window.closeSheet?.(); window.openFig?.(d.figId); },
  'loc-drill':      (e, el, d) => window.patchLocSheet?.(d.loc),

  // Menu sheet actions
  'menu-manage-collections': () => {
    window.closeSheet?.();
    window.S.editingOrder = true;
    window.S.tab = 'lines';
    window.S.activeLine = null;
    window.S.activeSubline = null;
    window.render?.();
  },
  'menu-reorder-sublines': () => {
    window.closeSheet?.();
    window.S.editingOrder = true;
    window.render?.();
  },
  'menu-open-locations': () => {
    window.S._locView = null;
    window.openSheet?.('locations');
  },
  'menu-start-tutorial': () => {
    window.closeSheet?.();
    window.startTutorial?.();
  },
  'toggle-ptr': () => {
    const on = !!window.store?.get('motu-ptr-enabled');
    window.store?.set('motu-ptr-enabled', on ? 'false' : 'true');
    window.render?.();
  },

  // Pricing sheet
  'save-pricing-backend':       () => window.savePricingBackend?.(),
  'disconnect-pricing-backend': () => window.disconnectPricingBackend?.(),
  'clear-pricing-cache':        () => {
    window.clearPricingCache?.();
    window.toast?.('✓ Pricing cache cleared');
  },

  // Import sheet
  'toggle-overwrite': (e, el) => el.querySelector('.checkbox')?.classList.toggle('checked'),
  'trigger-file-import': () => document.getElementById('csvInput')?.click(),

  // Batch edit sheet
  'batch-set-mode': (e, el, d) => {
    if (window.S.batchEdit) window.S.batchEdit.mode = d.mode;
    window.refreshBatchSheet?.();
  },
  'apply-batch-edit': () => window.applyBatchEdit?.(),

  // Sort sheet
  'set-sort': (e, el, d) => {
    window.S.sortBy = d.sort;
    window.store?.set('motu-sort', d.sort);
    window.closeSheet?.();
  },

  // Edit figure sheet (overrides)
  'reset-fig-overrides': (e, el, d) => window.resetFigureOverrides?.(d.figId),
  'edit-set-group':      (e, el, d) => {
    window.setOverrideField?.(d.figId, 'group', d.group);
    window.refreshEditSheet?.();
  },

  // Theme sheet
  'set-theme': (e, el, d) => window.setTheme?.(d.theme),

  // Title tap (dynamic — action name set at render time to theme-specific value)
  // The title uses data-action="${titleClick}" where titleClick is e.g. 'title-tap-eternia'.
  // The eggs.js module registers its own specific actions; we register a safe no-op
  // fallback so delegate doesn't warn on unknown actions for unconfigured themes.
  'title-tap-eternia':  (e, el) => window.titleTapEternia?.(e, el),
  'title-tap-skeletor': (e, el) => window.titleTapSkeletor?.(e, el),
  'title-tap-heman':    (e, el) => window.titleTapHeman?.(e, el),
  'title-tap-grayskull':(e, el) => window.titleTapGrayskull?.(e, el),
  'title-tap-light':    (e, el) => window.titleTapLight?.(e, el),

  // Sync button — action name is dynamic ('sync-now' or 'sync-bg') set at render time
  // Both are registered above; this comment is for reference only.

  // Filter sheet (delegated via 'filter' action with data-filter-op)
  'filter': (e, el, d) => {
    if (!d.filterOp) return;
    if (d.filterVal !== undefined) {
      window.patchFilter?.(d.filterOp, d.filterVal === 'true' ? true : d.filterVal === 'false' ? false : d.filterVal);
    } else {
      window.patchFilter?.(d.filterOp);
    }
  },

});

// ── Additional blur actions ─────────────────────────────────────────

registerAll({

  'update-copy-notes': (e, el, d) => window.updateCopy?.(d.figId, d.copyId, 'notes', el.value),

}, 'blur');

// ── Input actions ───────────────────────────────────────────────────

registerAll({

  'on-search':    (e, el) => window.onSearch?.(el.value),
  'format-acquired': (e, el) => window.formatAcquired?.(el),

  // Copy card inputs — update on each keystroke via the debounced path,
  // then commit on change (handled in the 'change' section below).
  'update-copy-notes-debounced': (e, el, d) =>
    window.updateCopyDebounced?.(d.figId, d.copyId, 'notes', el.value),

  // Kids core text field
  'kc-set-field': (e, el, d) => {
    window.S._kcForm = window.S._kcForm || {};
    window.S._kcForm[d.field] = el.value;
  },

  // Batch edit inputs
  'batch-set-variant':  (e, el) => { if (window.S.batchEdit) window.S.batchEdit.variant  = el.value; },
  'batch-set-paid':     (e, el) => { if (window.S.batchEdit) window.S.batchEdit.paid      = el.value; },
  'batch-set-notes':    (e, el) => { if (window.S.batchEdit) window.S.batchEdit.notes     = el.value; },
  'batch-set-location': (e, el) => { if (window.S.batchEdit) window.S.batchEdit.location  = el.value; },
  'batch-format-acquired': (e, el) => {
    window.formatAcquired?.(el);
    if (window.S.batchEdit) window.S.batchEdit.acquired = el.value;
  },

}, 'input');

// ── Change actions ──────────────────────────────────────────────────

registerAll({

  // Copy card field changes — commit to store
  'update-copy-field': (e, el, d) => window.updateCopy?.(d.figId, d.copyId, d.field, el.value),

  // Ordered figure fields
  'update-ordered-field': (e, el, d) => window.updateOrderedField?.(d.figId, d.field, el.value),

  // Kids Core faction select
  'kc-set-faction': (e, el) => {
    window.S._kcForm = window.S._kcForm || {};
    window.S._kcForm.faction = el.value;
  },

  // Photo file inputs
  'handle-photo':      (e, el, d) => window.handlePhoto?.(el, d.figId),
  'handle-copy-photo': (e, el, d) => window.handleCopyPhoto?.(el, d.figId, d.copyId),
  'handle-import-file': (e, el) => window.handleImportFile?.(el),

  // Batch edit selects
  'batch-set-status-field': (e, el) => { if (window.S.batchEdit) window.S.batchEdit.status    = el.value; },
  'batch-set-condition':    (e, el) => { if (window.S.batchEdit) window.S.batchEdit.condition  = el.value; },

  // Edit figure sheet field changes
  'edit-set-line':    (e, el, d) => { window.setOverrideField?.(d.figId, 'line',    el.value);                                   window.refreshEditSheet?.(); },
  'edit-set-faction': (e, el, d) => { window.setOverrideField?.(d.figId, 'faction', el.value);                                   window.refreshEditSheet?.(); },
  'edit-set-group-text': (e, el, d) => { window.setOverrideField?.(d.figId, 'group', el.value);                                  window.refreshEditSheet?.(); },
  'edit-set-wave':    (e, el, d) => { window.setOverrideField?.(d.figId, 'wave',    el.value);                                   window.refreshEditSheet?.(); },
  'edit-set-year':    (e, el, d) => { window.setOverrideField?.(d.figId, 'year',    el.value ? Number(el.value) : '');           window.refreshEditSheet?.(); },
  'edit-set-retail':  (e, el, d) => { window.setOverrideField?.(d.figId, 'retail',  el.value ? Number(el.value) : '');          window.refreshEditSheet?.(); },
  'edit-set-name':    (e, el, d) => { window.setOverrideField?.(d.figId, 'name',    el.value);                                   window.refreshEditSheet?.(); },

}, 'change');

// ── Keydown actions ─────────────────────────────────────────────────

registerAll({

  // Search input — blur on Enter to dismiss keyboard (mobile)
  'search-blur-on-enter': (e, el) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
  },

}, 'keydown');

// ── Focus actions ───────────────────────────────────────────────────

registerAll({

  // Price Paid field — select-all on focus so the prepopulated retail
  // price is easy to overwrite without clearing first.
  'select-all': (e, el) => el.select(),

}, 'focus');

// ── Dynamic title/sync actions ──────────────────────────────────────

registerAll({

  // Sync button — two named variants set at render time
  'sync-offline': () => window.toast?.('✗ No connection'),
  'sync-now':     () => window.fetchFigs?.(true),   // already registered above; harmless re-reg

  // Title tap — theme-specific eggs (registered by name so the delegate
  // framework can dispatch without evaluating any inline JS).
  'title-cycle': () => {
    const titles = window.getThemeTitles?.() || [];
    if (!titles.length) return;
    window.S.titleIdx = ((window.S.titleIdx || 0) + 1) % titles.length;
    window.playTitleSound?.(window.S.titleIdx);
    window.render?.();
  },
  'title-tap-eternia':   () => window.triggerEterniaEgg?.(),
  'title-tap-heman':     () => window.triggerHeManEgg?.(),
  'title-tap-grayskull': () => window.triggerGrayskullEgg?.(),
  'title-tap-skeletor':  () => window.triggerSkeletorEgg?.(),
  'title-tap-light':     () => window.render?.(),   // light theme has no egg currently
  'go-home':             () => window.goHome?.(),

});

// ── v7.02: Export/backup, stats, share, and accessory picker ────────

registerAll({

  // Export sheet
  'export-csv':       (e, el, d) => { window.exportCSV?.(d.filter); window.closeSheet?.(); },
  'export-json':      () => { window.exportJSON?.(); window.closeSheet?.(); },
  'export-insurance': () => window.buildInsuranceReport?.(),
  'export-photos-zip':() => { window.exportPhotosZip?.(); window.closeSheet?.(); },
  'export-settings':  () => { window.exportSettings?.(); window.closeSheet?.(); },

  // Stats sheet
  'go-to-filtered':    (e, el, d) => window.goToFiltered?.(d.status),
  'fetch-all-pricing': () => window.fetchAllOwnedPricing?.(),
  'export-gaps':       () => window.exportGaps?.(),
  'toggle-wave-expand':(e, el, d) => window.toggleWaveExpand?.(d.waveId),
  'go-to-wave':        (e, el, d) => window.goToWave?.(d.line, d.wave),

  // Share sheet
  'copy-share-url':  () => window.copyShareURL?.(),
  'native-share':    () => window.nativeShare?.(),
  'share-trade-list':() => window.shareTradeList?.(),

  // Accessory picker
  'acc-picker-back':        () => { window.S._accPickAdmin = false; window.renderSheetBody?.(); },
  'acc-picker-edit-loadout':() => { window.S._accPickAdmin = true;  window.renderSheetBody?.(); },
  'acc-picker-done':        () => { window.S._accPickAdmin = false; window.closeSheet?.(); },
  'acc-reset-avail':        (e, el, d) => window.resetAccAvail?.(d.figId),
  'acc-toggle-avail':       (e, el, d) => window.toggleAccAvail?.(d.accName),
  'acc-toggle-in-picker':   (e, el, d) => window.toggleAccessoryInPicker?.(d.accName),
  'acc-picker-add-custom':  () => window.addCustomAccessory?.(),

});

// Keydown — accessory picker custom input: add on Enter
registerAll({
  'acc-picker-add-on-enter': (e, el) => {
    if (e.key === 'Enter') { e.preventDefault(); window.addCustomAccessory?.(); }
  },
}, 'keydown');

