// ── Lazy shims for window-only handlers (resolve at call time) ──
const closeSheet = (...a) => window.closeSheet?.(...a);
const goHome = (...a) => window.goHome?.(...a);
const onSearch = (...a) => window.onSearch?.(...a);

// ════════════════════════════════════════════════════════════════════
// MOTU Vault — handlers.js
// ────────────────────────────────────────────────────────────────────
// Long-press context menu, navigation (pushNav/restoreNav/popstate),
// batch-select mode, and Kids-Core admin save/delete.
// ────────────────────────────────────────────────────────────────────
// All inline-onclick-callable functions in this module are mirrored
// to window so rendered HTML can reach them.
// ════════════════════════════════════════════════════════════════════

import {
  S, store, ICO, icon, IMG, LINES, FACTIONS, KIDS_CORE_KEY,
  STATUSES, STATUS_LABEL, STATUS_COLOR, STATUS_HEX, SUBLINES,
  ln, normalize, esc, jsArg, _clone, isSelecting,
} from './state.js';
import {
  MAX_PHOTOS, photoStore, photoCopyOf,
} from './photos.js';
import {
  figById, figIsHidden, setStatus, saveColl, flushAllPending,
  totalCopyCount, entryCopyCount, getPrimaryCopy, copyVariant,
  rebuildFigIndex, applyOverrides, fetchFigs,
  clearOverrides, _derived, getSortedFigs,
  isMigrated, migrateEntry, migrateOrderedToOwned,
} from './data.js';
import { render, toast, haptic, appConfirm, patchFigRow, toastUndo, triggerPulse, renderContent, renderSelectActionbar } from './render.js';
import { checkCompletion } from './eggs.js';


// ── Route announcer (a11y SC 4.1.3): emit polite status when tabs change ──
function _announceRoute(text) {
  const el = document.getElementById('routeAnnouncer');
  if (!el) return;
  el.textContent = '';
  // Microtask delay ensures screen readers re-read on identical text
  setTimeout(() => { el.textContent = text; }, 50);
}

// § CONTEXT-MENU ── initLongPress, showContextMenu, dismissContextMenu, ctxSetStatus ──
let _lpTimer = null;
let _lpFigId = null;
let _lpMoved = false;
let _lpFired = false;
let _lpStartX = 0;
let _lpStartY = 0;

function initLongPress(el, figId) {
  // Passive touchstart — do NOT preventDefault here or it kills scrolling.
  // We suppress the Android copy/paste callout via contextmenu instead.
  el.addEventListener('touchstart', e => {
    if (isSelecting()) return;
    _lpMoved = false;
    _lpFired = false;
    _lpFigId = figId;
    // v6.10: snapshot coordinates synchronously. Some browsers null out
    // TouchEvent.touches after the handler returns, so reading e.touches[0]
    // inside the setTimeout was sometimes returning undefined and breaking
    // the menu. Capturing primitives here makes the closure stable.
    const lx = e.touches[0].clientX;
    const ly = e.touches[0].clientY;
    _lpStartX = lx;
    _lpStartY = ly;
    _lpTimer = setTimeout(() => {
      if (!_lpMoved) {
        _lpFired = true;
        haptic(25);
        showContextMenu(figId, lx, ly);
      }
    }, 500);
  }, {passive: true});
  el.addEventListener('touchmove', e => {
    // v6.11: require ≥10px movement before cancelling. Without a threshold,
    // natural finger jitter while holding still registers as touchmove and
    // kills the timer before it can fire — long-press appeared broken on
    // every device. 10px matches typical platform tap-slop.
    if (!e.touches[0]) return;
    const dx = e.touches[0].clientX - _lpStartX;
    const dy = e.touches[0].clientY - _lpStartY;
    if (dx * dx + dy * dy < 100) return;
    _lpMoved = true;
    if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
  }, {passive: true});
  el.addEventListener('touchend', () => {
    if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
  }, {passive: true});
  el.addEventListener('touchcancel', () => {
    if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
  }, {passive: true});
  // Block the system context menu (Android copy/paste/select callout) and
  // — v6.26 — also use the contextmenu event to surface the in-app menu on
  // desktop. Previously desktop users had no equivalent of mobile long-press
  // because the touch handlers above never fire; now right-click does it.
  // contextmenu fires once per gesture (not on every touch), so it doesn't
  // interfere with scrolling or tap-to-open.
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (isSelecting()) return;
    haptic(15);
    showContextMenu(figId, e.clientX, e.clientY);
  });
  // Prevent tap from firing after long-press
  el.addEventListener('click', e => {
    if (_lpFired) { e.stopPropagation(); e.preventDefault(); _lpFired = false; }
  }, {capture: true});
}

function showContextMenu(figId, x, y) {
  // Prevent the regular tap from firing
  const fig = figById(figId);
  if (!fig) return;
  const c = S.coll[figId] || {};
  dismissContextMenu();
  // v4.86: escape figId for innerHTML onclick interpolation. AF411 slugs are
  // alphanumeric+hyphens in practice, but the pattern is unsafe — any future
  // ID source (import, manual edit) could carry a quote and break out.
  const eFigId = esc(figId);
  const jFigId = jsArg(figId);
  const overlay = document.createElement('div');
  overlay.className = 'ctx-menu-overlay';
  overlay.id = 'ctxOverlay';
  overlay.onclick = e => { if (e.target === overlay) dismissContextMenu(); };

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';

  let items = `<div class="ctx-menu-header">${esc(fig.name)}`;
  // Show copy count alongside the name when there are multiple copies, so the
  // user gets quick visibility into multi-copy state without opening details.
  const copyN = entryCopyCount(c);
  if (copyN > 1) {
    items += ` <span class="ctx-copy-count">×${copyN}</span>`;
  }
  items += `</div>`;
  STATUSES.forEach(s => {
    const active = c.status === s;
    const dotColor = STATUS_HEX[s];
    items += `<button class="ctx-menu-item ${active ? 'active' : ''}" onclick="ctxSetStatus(${jFigId},'${s}')">
      <span class="ctx-dot" style="background:${dotColor}"></span>
      ${active ? '✓ ' : ''}${STATUS_LABEL[s]}
    </button>`;
  });
  if (c.status) {
    items += `<button class="ctx-menu-item" onclick="ctxSetStatus(${jFigId},'clear')" style="color:var(--t3)">
      <span class="ctx-dot" style="background:var(--bd)"></span>Clear status
    </button>`;
  }
  items += '<div class="ctx-menu-sep"></div>';
  // Quick "Add copy" shortcut for figures that already have at least one copy.
  // Skips opening the detail screen for power users adding multiples in bulk.
  if (c.status === 'owned' || c.status === 'for-sale') {
    items += `<button class="ctx-menu-item" onclick="dismissContextMenu();addCopy(${jFigId});toast('✓ Copy added')">
      ${icon(ICO.import, 16)} Add another copy
    </button>`;
  }
  if (fig.line !== 'kids-core' && fig.line !== 'custom') {
    items += `<button class="ctx-menu-item" onclick="dismissContextMenu();openAF411(${jFigId})">
      ${icon(ICO.export, 16)} View on AF411
    </button>`;
  }
  items += `<button class="ctx-menu-item" onclick="dismissContextMenu();openFig(${jFigId})">
    ${icon(ICO.edit, 16)} ${copyN > 1 ? 'Manage copies' : 'Open details'}
  </button>`;
  // Local edit (override) — for fixing missing/wrong AF411 metadata
  items += `<button class="ctx-menu-item" onclick="dismissContextMenu();openFigureEditor(${jFigId})">
    ${icon(ICO.menu, 16)} Edit info…${fig._overridden ? ' <span style="font-size:9px;color:var(--gold);background:color-mix(in srgb,var(--gold) 18%,transparent);padding:1px 5px;border-radius:5px;margin-left:auto">EDITED</span>' : ''}
  </button>`;
  items += `<button class="ctx-menu-item" onclick="dismissContextMenu();enterSelectModeWith(${jFigId})">
    ${icon(ICO.check, 16)} Select
  </button>`;
  menu.innerHTML = items;
  // Provisional position — will be corrected after measurement below.
  menu.style.left = '0';
  menu.style.top = '0';
  overlay.appendChild(menu);
  document.body.appendChild(overlay);

  // Measure the menu's actual rendered size. The previous hard-coded 280px
  // height estimate was smaller than reality for figures with AF411 +
  // cleared-status rows, causing the bottom of the menu to get cut off.
  // offsetWidth/Height ignore the slide-in transform, which is what we want.
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const margin = 12;
  const bn = document.getElementById('bottomNav');
  const bnHidden = !bn || bn.classList.contains('hidden') || bn.classList.contains('immersive-hide');
  const bottomReserve = bnHidden ? 0 : bn.offsetHeight + 8;
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const availBottom = vpH - margin - bottomReserve;

  // Default anchor: slightly up-and-left of the touch point so the finger
  // doesn't cover the top of the menu.
  let left = x - 20;
  let top = y - 20;

  // If the menu doesn't fit below the touch, flip it above.
  if (top + mh > availBottom) top = y - mh + 20;

  // Final clamp to viewport, reserving space for the bottom nav.
  left = Math.max(margin, Math.min(left, vpW - mw - margin));
  top = Math.max(margin, Math.min(top, availBottom - mh));

  // Pathological case: menu taller than the entire viewport (shouldn't
  // happen with current items, but future-proof it). Cap with scroll.
  if (mh > availBottom - margin) {
    menu.style.maxHeight = (availBottom - margin) + 'px';
    menu.style.overflowY = 'auto';
    top = margin;
  }

  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function dismissContextMenu() {
  const el = document.getElementById('ctxOverlay');
  if (el) el.remove();
  // v6.26: clear the long-press fired flag. Without this, if the user opened
  // the context menu via long-press and then dismissed it by tapping the
  // backdrop (rather than choosing an item), the next legitimate tap on
  // any figure row would be swallowed by the click-suppression handler in
  // initLongPress, which only resets _lpFired after it fires.
  _lpFired = false;
}

window.ctxSetStatus = (id, status) => {
  dismissContextMenu();
  if (status === 'clear') {
    const prevColl = _clone(S.coll[id] || {});
    if (S.coll[id]) { delete S.coll[id].status; if (!Object.keys(S.coll[id]).length) delete S.coll[id]; }
    saveColl(); haptic();
    S._recentChanges = [id, ...S._recentChanges.filter(x => x !== id)].slice(0, 10);
    store.set('motu-recent', S._recentChanges);
    const fig = figById(id);
    toastUndo(`✗ ${fig ? fig.name : id} cleared`, id, prevColl);
    if (!patchFigRow(id)) render();
  } else {
    setStatus(id, status);
  }
};

// § NAVIGATION ── pushNav, popstate, navTo, goToLine, goHome, openFig, openSheet, closeSheet ──
// Each navigation action pushes a state so Android/browser back button
// walks backward through the app instead of closing it.
let _skipPush = false; // flag to avoid pushing during popstate handling

function navState() {
  // Snapshot of the navigable state (not the full S — just what back needs)
  return {
    screen: S.screen,
    tab: S.tab,
    activeLine: S.activeLine,
    activeSubline: S.activeSubline,
    activeFigId: S.activeFig?.id || null,
    sheet: S.sheet,
    search: S.search,
  };
}

function pushNav() {
  if (_skipPush) return;
  history.pushState(navState(), '');
}

function restoreNav(state) {
  if (!state) return;
  S.screen = state.screen || 'main';
  S.tab = state.tab || 'lines';
  S.activeLine = state.activeLine || null;
  S.activeSubline = state.activeSubline || null;
  S.activeFig = state.activeFigId ? figById(state.activeFigId) || null : null;
  S.sheet = state.sheet || null;
  S.search = state.search || '';
}

// v6.07: tiny ring buffer of nav events for debugging when users report
// "back button doesn't work". Logs to localStorage so it survives crashes
// and can be inspected via the console: `JSON.parse(localStorage.navlog)`.
function _navlog(label) {
  try {
    const arr = JSON.parse(localStorage.getItem('navlog') || '[]');
    arr.push({
      t: Date.now(),
      label,
      screen: S.screen,
      tab: S.tab,
      activeLine: S.activeLine,
      activeSubline: S.activeSubline,
      sheet: S.sheet,
      photoViewer: !!S.photoViewer,
      selectMode: !!S.selectMode,
      search: !!S.search,
      historyLen: history.length,
    });
    while (arr.length > 30) arr.shift();
    localStorage.setItem('navlog', JSON.stringify(arr));
  } catch {}
}

// Listen for back button (Android hardware back, browser back, swipe back)
// v6.07: full handler wrapped in try/finally so a thrown render() can NEVER
// leave _skipPush stuck true. A stuck _skipPush would silently break every
// future navigation push — symptoms exactly match the user's "back button
// does nothing then exits app" report.
window.addEventListener('popstate', e => {
  _navlog('popstate-in');
  _skipPush = true;
  try {
    // Always restore bars on back navigation
    S.barsHidden = false;
    S.searchBarHidden = false;

    // If photo viewer is open, close it first
    if (S.photoViewer) {
      S.photoViewer = null;
      render();
      return;
    }

    // If a sheet is open, close it — preserve select mode and selection
    if (S.sheet) {
      S.sheet = null;
      S._accPickAdmin = false;
      render();
      return;
    }

    // Sheet is gone — now exit select mode if active
    if (isSelecting()) {
      S.selectMode = false;
      S.selected = new Set();
      render();
      return;
    }

    // If on figure detail, go back to list
    if (S.screen === 'figure') {
      S.screen = 'main';
      S.activeFig = null;
      render();
      return;
    }

    // If viewing a subline, go back to line
    if (S.activeSubline) {
      S.activeSubline = null;
      render();
      return;
    }

    // If viewing a line, go back to lines grid
    if (S.activeLine) {
      S.activeLine = null;
      S.activeSubline = null;
      S.tab = 'lines';
      render();
      return;
    }

    // If searching, clear search
    if (S.search) {
      S.search = '';
      render();
      return;
    }

    // At root — show "tap again to exit" toast on the FIRST root-level back.
    // v6.07: The previous implementation called history.pushState() to absorb
    // the back, which was growing the history stack on every root-level back
    // press. After several taps, the stack had multiple absorber entries that
    // all needed popping before reaching real prior states. Symptom: rapid
    // backs would suddenly close the app once the absorber stack ran out.
    //
    // New approach: on the FIRST back at root, just toast and re-push ONE
    // absorber. On the SECOND back within 2.5s, let the browser actually
    // navigate away (default popstate behavior — we don't intercept).
    const now = Date.now();
    if (S._lastBackAtRoot && now - S._lastBackAtRoot < 2500) {
      // Don't intercept — browser will navigate away from the page,
      // closing the PWA. Clear the flag so we don't loop.
      S._lastBackAtRoot = 0;
      return;
    }
    S._lastBackAtRoot = now;
    // Push exactly one absorber so the next back press fires popstate again.
    history.pushState(navState(), '');
    // v6.18: a back press at root strongly signals "I want to navigate" —
    // restore the immersive-hidden bars so the user actually has something
    // to tap. Force a full render too, since previous attempts at just
    // toggling classes left the UI in an inconsistent state for some users
    // (likely a render-on-resume race that re-applied the hide class).
    if (S.barsHidden) {
      S.barsHidden = false;
      S.searchBarHidden = false;
      render();
    }
    toast('Press back again to exit', { large: true, duration: 2500 });
  } finally {
    _skipPush = false;
    _navlog('popstate-out');
  }
});

// Seed the initial history entry so we always have something to pop
history.replaceState(navState(), '');



// ─── Event Handlers ───────────────────────────────────────────────
let _searchTimer = null;
window.onSearch = val => {
  S.search = val;
  // Keep line scope when searching within a line; go global when at top level.
  if (val && !S.activeLine) S.tab = 'all';
  // Clearing search — do full render to restore UI (clear button, breadcrumbs, tab state)
  if (!val) { pushNav(); render(); return; }
  // Debounced content update — 120ms debounce preserves input focus
  if (_searchTimer) clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => {
    const ca = document.getElementById('contentArea');
    if (ca) {
      ca.innerHTML = '<div id="topSpacer"></div>' + renderContent();
      const tb = document.getElementById('topBar');
      const ts = document.getElementById('topSpacer');
      if (ts && tb) ts.style.height = tb.offsetHeight + 'px';
      // Bind long-press to search results
      ca.querySelectorAll('[data-fig-id]').forEach(el => {
        if (!el._lpBound) { el._lpBound = true; initLongPress(el, el.dataset.figId); }
      });
    }
    // Show clear button if it's not already there
    const wrap = document.querySelector('.search-wrap');
    const inp = document.getElementById('searchInput');
    if (wrap && inp && !wrap.querySelector('.search-clear')) {
      const btn = document.createElement('button');
      btn.className = 'search-clear';
      btn.innerHTML = icon(ICO.x, 14);
      btn.onclick = () => onSearch('');
      wrap.appendChild(btn);
    }
    _searchTimer = null;
  }, 120);
};
window.navTo = key => {
  const labels = { lines: 'Lines', all: 'All Figures', collection: 'My Collection' };
  if (labels[key]) _announceRoute(labels[key]);
  S.tab = key;
  S.searchBarHidden = false;
  S.barsHidden = false;
  // Always reset to the tab's global view, regardless of current line/subline.
  // Previously 'all' preserved activeLine, making the tap appear to do nothing
  // when already viewing a line.
  S.activeLine = null;
  S.activeSubline = null;
  S.savedScroll = 0;
  // v4.91: mark as just-navigated so the scroll-preservation fallback in
  // render() doesn't restore the previous tab's scroll position onto this one.
  // Without this, scrolling halfway down the All tab and tapping Lines would
  // load Lines already scrolled halfway down (since _preservedScroll was
  // captured from the old tab's scroll container).
  S._justNavigated = true;
  pushNav();
  render();
};
window.goToLine = id => { S.activeLine = id; S.activeSubline = null; S.tab = 'all'; S.savedScroll = 0; S.searchBarHidden = false; S.barsHidden = false; S._justNavigated = true; pushNav(); render(); };
window.goBack = () => { history.back(); };
window.goHome = () => { S.tab = 'lines'; S.activeLine = null; S.activeSubline = null; S.search = ''; S.savedScroll = 0; S.searchBarHidden = false; S.barsHidden = false; S._justNavigated = true; pushNav(); render(); };
// Home/theme icon tap — always navigates home. Easter eggs are title-tap only.
window.homeIconClick = () => { goHome(); };

// § BATCH-SELECT ── enterSelectMode, toggleSelect, batchSetStatus, batchAddCopy, cycleStatus ──
window.enterSelectMode = () => {
  S.selectMode = true;
  S.selected = new Set();
  pushNav();
  haptic && haptic();
  render();
};
window.enterSelectModeWith = id => {
  S.selectMode = true;
  S.selected = new Set([id]);
  pushNav();
  haptic && haptic();
  render();
  // Clear the long-press fired flag so the next tap isn't eaten by the
  // click suppressor — the long-press touch that triggered this is done.
  _lpFired = false;
};
window.exitSelectMode = () => {
  S.confirmClear = false;
  if (isSelecting()) history.back();
  else { S.selectMode = false; S.selected = new Set(); render(); }
};
window.toggleSelect = (e, id) => {
  if (e) e.stopPropagation();
  if (S.selected.has(id)) S.selected.delete(id);
  else S.selected.add(id);
  haptic && haptic(8);
  // Surgical DOM patch for row/card
  const isSelected = S.selected.has(id);
  const el = document.querySelector(`.fig-row[data-fig-id="${id}"], .fig-card[data-fig-id="${id}"]`);
  if (el) {
    el.classList.toggle('selected', isSelected);
    const cb = el.querySelector('.select-checkbox');
    if (cb) cb.classList.toggle('checked', isSelected);
  }
  // Re-render actionbar (buttons enable/disable based on count)
  const bar = document.querySelector('.select-actionbar');
  if (bar) bar.outerHTML = renderSelectActionbar();
};
window.selectAllVisible = () => {
  const figs = getSortedFigs();
  if (S.selected.size === figs.length) {
    S.selected = new Set();
  } else {
    S.selected = new Set(figs.map(f => f.id));
  }
  haptic && haptic();
  render();
};
window.batchSetStatus = status => {
  const ids = Array.from(S.selected);
  if (!ids.length) return;
  let changed = 0;
  ids.forEach(id => {
    const cur = S.coll[id];
    const wasStatus = cur?.status;
    let next = cur ? (isMigrated(cur) ? {...cur, copies: [...cur.copies]} : migrateEntry(cur)) : { copies: [] };
    if (status === '') {
      delete next.status;
      // Drop the entry entirely only if no remaining ownership signal
      if (!next.status && (!next.copies || next.copies.length === 0)) {
        delete S.coll[id];
      } else {
        S.coll[id] = next;
      }
    } else {
      next.status = status;
      // Owned/for-sale always need at least one copy slot
      if ((status === 'owned' || status === 'for-sale') && (!next.copies || next.copies.length === 0)) {
        next.copies = [{ id: 1 }];
      }
      S.coll[id] = next;
      // v4.87: same ordered→owned migration setStatus/cycleStatus do.
      if (wasStatus === 'ordered' && status === 'owned') migrateOrderedToOwned(id);
    }
    changed++;
    S._recentChanges = [id, ...S._recentChanges.filter(x => x !== id)].slice(0, 10);
  });
  saveColl();
  store.set('motu-recent', S._recentChanges);
  haptic && haptic(25);
  const label = status ? STATUS_LABEL[status] : 'Cleared';
  toast(`✓ ${changed} figures → ${label}`);
  render();
};

// Batch add a copy to each selected figure. Optional `extras` object lets
// the batch editor pass variant/paid/notes/status alongside the condition preset.
window.batchAddCopy = (presetCondition = '', extras = {}) => {
  const ids = Array.from(S.selected);
  if (!ids.length) return;
  const targetStatus = extras.status || 'owned';
  let added = 0, promoted = 0;
  ids.forEach(id => {
    let cur = S.coll[id];
    const wasStatus = cur?.status;
    if (!cur || (cur.status !== 'owned' && cur.status !== 'for-sale')) {
      cur = cur ? (isMigrated(cur) ? {...cur, copies: [...cur.copies]} : migrateEntry(cur)) : { copies: [] };
      cur.status = targetStatus;
      promoted++;
    } else {
      cur = isMigrated(cur) ? {...cur, copies: [...cur.copies]} : migrateEntry(cur);
      // Update status to match what was chosen in the sheet
      cur.status = targetStatus;
    }
    if (!cur.copies) cur.copies = [];
    const newId = cur.copies.reduce((m, cp) => Math.max(m, cp.id || 0), 0) + 1;
    const copy = { id: newId };
    if (presetCondition) copy.condition = presetCondition;
    if (extras.variant) copy.variant = extras.variant;
    if (extras.paid) copy.paid = extras.paid;
    if (extras.notes) copy.notes = extras.notes;
    cur.copies.push(copy);
    S.coll[id] = cur;
    // v4.87: same ordered→owned migration setStatus/cycleStatus/batchSetStatus do.
    // Must run after S.coll[id] = cur so migrateOrderedToOwned sees the updated entry.
    if (wasStatus === 'ordered' && targetStatus === 'owned') migrateOrderedToOwned(id);
    added++;
    S._recentChanges = [id, ...S._recentChanges.filter(x => x !== id)].slice(0, 10);
  });
  saveColl();
  store.set('motu-recent', S._recentChanges);
  haptic && haptic(25);
  const condNote = presetCondition ? ` (${presetCondition})` : '';
  toast(`✓ ${added} copies added${condNote} → ${STATUS_LABEL[targetStatus]}`);
  render();
};

// Long-press status cycle: owned → wishlist → ordered → for-sale → clear
// SPECIAL CASE: from 'ordered', next is 'owned' (not 'for-sale'). Rationale:
// the dominant user intent when cycling a dot off 'ordered' is "I received
// my order" — the full roundabout (ordered→for-sale→clear→owned) loses the
// orderedFrom/orderedPaid migration data along the way. Jumping directly
// to 'owned' both matches intent and preserves the data.
const STATUS_CYCLE = ['owned','wishlist','ordered','for-sale', ''];
window.cycleStatus = (e, id) => {
  e.stopPropagation();
  const prevColl = _clone(S.coll[id] || {});
  const cur = S.coll[id]?.status || '';
  let next;
  // v6.01: removed ordered→owned shortcut so all 4 statuses cycle (owned
  // → wishlist → ordered → for-sale → cleared). User report: 'cycle only
  // hits wishlist+ordered'. The migration of orderedFrom→ownedPaid still runs
  // on the detail-screen Owned button (setStatus path).
  const idx = STATUS_CYCLE.indexOf(cur);
  next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
  if (next) {
    if (!S.coll[id]) S.coll[id] = {};
    S.coll[id].status = next;
    // v4.87: same ordered→owned migration setStatus() does. Previously the
    // quick-tap dot silently dropped orderedFrom/orderedPaid on transition.
    if (cur === 'ordered' && next === 'owned') migrateOrderedToOwned(id);
    // v4.90 parity: auto-create copies[0] for owned/for-sale (matches setStatus).
    if ((next === 'owned' || next === 'for-sale') &&
        (!S.coll[id].copies || S.coll[id].copies.length === 0)) {
      S.coll[id].copies = [{ id: 1 }];
    }
  } else {
    if (S.coll[id]) { delete S.coll[id].status; if (!Object.keys(S.coll[id]).length) delete S.coll[id]; }
  }
  saveColl(); haptic();
  S._recentChanges = [id, ...S._recentChanges.filter(x => x !== id)].slice(0, 10);
  store.set('motu-recent', S._recentChanges);
  const fig = figById(id);
  const name = fig ? fig.name : id;
  const newStatus = S.coll[id]?.status;
  if (newStatus) toastUndo(`✓ ${name} → ${STATUS_LABEL[newStatus]}`, id, prevColl);
  else toastUndo(`✗ ${name} cleared`, id, prevColl);
  triggerPulse(id, newStatus);
  if (!patchFigRow(id)) render();
  // Check completion when marking as owned
  if (newStatus === 'owned' && fig) checkCompletion(fig);
};

// § KIDS-CORE-ADMIN ── saveKidsCoreAdminFig, deleteKidsCoreAdminFig ──────────
// Local Kids Core figures stored in localStorage under KIDS_CORE_KEY.
// Merged into S.figs on every load/sync. Survive AF411 syncs.

window.saveKidsCoreAdminFig = () => {
  const form = S._kcForm || {};
  const existing = S._kcEditId ? (store.get(KIDS_CORE_KEY)||[]).find(f => f.id === S._kcEditId) : null;
  const name = (form.name ?? existing?.name ?? '').trim();
  const group = form.group ?? existing?.group ?? '';
  if (!name) { toast('✗ Name is required'); return; }
  if (!group) { toast('✗ Select a group'); return; }

  const local = store.get(KIDS_CORE_KEY) || [];
  if (S._kcEditId) {
    const idx = local.findIndex(f => f.id === S._kcEditId);
    if (idx >= 0) local[idx] = { ...local[idx], ...form, name, group, line: 'kids-core', source: 'kids-core-local' };
  } else {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') + '-kc-' + Date.now().toString(36);
    local.push({
      id: slug, name, group, line: 'kids-core', source: 'kids-core-local',
      year:   form.year   ? Number(form.year)   : undefined,
      wave:   form.wave   || undefined,
      retail: form.retail ? Number(form.retail) : undefined,
      faction:form.faction|| undefined,
    });
  }
  store.set(KIDS_CORE_KEY, local);
  // Re-merge into S.figs immediately without a full network sync
  const remoteIds = new Set(S.figs.filter(f => f.source !== 'kids-core-local').map(f => f.id));
  const merged = local.map(f => ({...f, image: ''})).filter(f => !remoteIds.has(f.id));
  S.figs = [...S.figs.filter(f => f.source !== 'kids-core-local'), ...merged];
  rebuildFigIndex();
  _derived.invalidate();
  const msg = S._kcEditId ? '✓ Figure updated' : '✓ Figure added to Kids Core';
  S._kcEditId = null; S._kcForm = null;
  toast(msg);
  closeSheet();
  render();
};

window.deleteKidsCoreAdminFig = async id => {
  if (!await appConfirm('Delete this figure from Kids Core?', {danger:true, ok:'Delete'})) return;
  const local = (store.get(KIDS_CORE_KEY)||[]).filter(f => f.id !== id);
  store.set(KIDS_CORE_KEY, local);
  S.figs = S.figs.filter(f => f.id !== id);
  delete S.coll[id];
  // v4.94: also clear overrides + photos (orphaned otherwise)
  try { clearOverrides(id); } catch {}
  try { photoStore.delAll && photoStore.delAll(id); } catch {}
  rebuildFigIndex();
  _derived.invalidate();
  S._kcEditId = null; S._kcForm = null;
  saveColl();
  toast('✓ Deleted');
  render();
};

// ── window.* mirrors for inline-onclick handlers ──
window.pushNav = pushNav;
window.dismissContextMenu = dismissContextMenu;

// v6.27: keyboard shortcuts. "/" focuses search from anywhere (unless an input
// already has focus); Escape clears search if active. Doesn't conflict with
// the tutorial's keydown handler — that runs in capture phase only while the
// tutorial overlay is open.
document.addEventListener('keydown', e => {
  // Ignore when a sheet, photo viewer, or tutorial is open — those have
  // their own dismissal flows and we don't want to fight them.
  if (S.sheet || S.photoViewer) return;
  const tag = (e.target && e.target.tagName) || '';
  const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
                  (e.target && e.target.isContentEditable);
  if (e.key === '/' && !inField) {
    const inp = document.getElementById('searchInput');
    if (inp) { e.preventDefault(); inp.focus(); inp.select?.(); }
  } else if (e.key === 'Escape' && S.search && !inField) {
    onSearch('');
  }
});

// ── Exports ─────────────────────────────────────────────────
export {
  initLongPress, showContextMenu, dismissContextMenu, navState, pushNav, restoreNav
};
