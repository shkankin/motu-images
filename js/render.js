// ── Lazy shims for window-only handlers (resolve at call time) ──
const cycleStatus = (...a) => window.cycleStatus?.(...a);
const enterSelectMode = (...a) => window.enterSelectMode?.(...a);
const exitSelectMode = (...a) => window.exitSelectMode?.(...a);
const goToFiltered = (...a) => window.goToFiltered?.(...a);
const nativeShare = (...a) => window.nativeShare?.(...a);
const onSearch = (...a) => window.onSearch?.(...a);
const openAF411 = (...a) => window.openAF411?.(...a);
const openSheet = (...a) => window.openSheet?.(...a);
const openSlideViewer = (...a) => window.openSlideViewer?.(...a);
const photoViewerNav = (...a) => window.photoViewerNav?.(...a);
const removePhoto = (...a) => window.removePhoto?.(...a);
const setDefaultPhoto = (...a) => window.setDefaultPhoto?.(...a);
const setPhotoLabel = (...a) => window.setPhotoLabel?.(...a);
const undoStatus = (...a) => window.undoStatus?.(...a);

// ════════════════════════════════════════════════════════════════════
// MOTU Vault — render.js
// ────────────────────────────────────────────────────────────────────
// Toast / haptic / pulse, the main render() pipeline (Loading→Main→
// Content), list + grid + detail screen renderers, photo viewer, and
// patchFigRow/patchDetailStatus surgical DOM updates that bypass the
// full re-render path on status toggles.
// ════════════════════════════════════════════════════════════════════

import {
  S, store, ICO, icon, IMG, THEMES, LINES, FACTIONS, ACCESSORIES,
  STATUSES, STATUS_LABEL, STATUS_COLOR, STATUS_HEX, SUBLINES, CONDITIONS,
  SERIES_MAP, COND_MAP, GROUP_MAP, DEFAULT_TITLE,
  ln, normalize, esc, isSelecting, _clone, getThemeTitles,
} from './state.js';
import {
  MAX_PHOTOS, photoStore, photoURLs, photoCopyOf,
  initPhotoViewerZoom,
} from './photos.js';
import {
  figById, figIsHidden, getPrimaryCopy, copyVariant, copyCondition,
  copyPaid, copyNotes, entryCopyCount, totalCopyCount,
  getStats, getSortedFigs, getLineStats, hasFilters, progressRing,
  isLineFullyHidden, isSublineHidden, getAllLocations,
  PER_COPY_FIELDS, getOverrideField, getAccAvail,
  getLoadout, getCopyCompleteness,
  buildFigIndexes, LINE_ID_MAP, SETTINGS_KEYS,
  isMigrated,
} from './data.js';
import {
  playSound, preloadSound, getThemeIcon, getThemeSounds,
} from './eggs.js';
import { initLongPress, pushNav } from './handlers.js';
import { renderSheet } from './ui-sheets.js';

// § TOAST-HAPTIC ── toast, toastUndo, undoStatus, haptic, showUpdateBanner, triggerPulse ──
function getToastContainer() {
  let c = document.getElementById('toastContainer');
  if (!c) { c = document.createElement('div'); c.id = 'toastContainer'; c.className = 'toast-container'; document.body.appendChild(c); }
  return c;
}
function toast(msg) {
  const container = getToastContainer();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 4000);
}

function haptic(ms = 15) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

// In-app confirmation dialog — replaces blocking confirm()/alert() calls.
// Returns a Promise<boolean> so callers can await it.
// danger:true styles the confirm button red for destructive actions.
function appConfirm(message, {danger = false, ok = 'Confirm', cancel = 'Cancel'} = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:600;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;padding-bottom:calc(16px + var(--safe-bottom,0px))';
    overlay.innerHTML = `
      <div style="width:100%;max-width:480px;background:var(--bg2);border-radius:20px 20px 16px 16px;padding:22px 20px 12px;box-shadow:0 -4px 32px rgba(0,0,0,.4)">
        <div style="font-size:15px;color:var(--t1);line-height:1.5;margin-bottom:18px;text-align:center">${esc(message)}</div>
        <div style="display:flex;gap:10px">
          <button id="appConfirmCancel" style="flex:1;padding:14px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);color:var(--t2);font-size:15px;font-weight:600">${esc(cancel)}</button>
          <button id="appConfirmOk" style="flex:1;padding:14px;border-radius:12px;border:none;background:${danger?'var(--rd)':'var(--acc)'};color:#fff;font-size:15px;font-weight:700">${esc(ok)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    // Disable buttons after one tap to prevent double-fire on rapid taps
    const finish = result => {
      overlay.querySelector('#appConfirmOk').disabled = true;
      overlay.querySelector('#appConfirmCancel').disabled = true;
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector('#appConfirmOk').addEventListener('click', () => finish(true));
    overlay.querySelector('#appConfirmCancel').addEventListener('click', () => finish(false));
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(false); });
  });
}

// ─── Status Pulse Animation ──────────────────────────────────────
function triggerPulse(id, status) {
  requestAnimationFrame(() => {
    const badge = document.querySelector(`.fig-card[data-fig-id="${id}"] .status-badge`) ||
                  document.querySelector(`.fig-row[data-fig-id="${id}"] .quick-own`);
    if (!badge) return;
    const color = status ? STATUS_HEX[status] : 'rgba(255,255,255,.3)';
    badge.style.setProperty('--pulse-color', color + '66');
    badge.classList.remove('pulsing');
    void badge.offsetWidth; // force reflow
    badge.classList.add('pulsing');
    badge.addEventListener('animationend', () => badge.classList.remove('pulsing'), {once: true});
  });
}

// ─── Undo Toast ──────────────────────────────────────────────────
function toastUndo(msg, figId, prevColl) {
  const container = getToastContainer();
  const el = document.createElement('div');
  el.className = 'toast has-undo';
  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-msg';
  msgSpan.textContent = msg;
  const btn = document.createElement('button');
  btn.className = 'toast-undo';
  btn.textContent = 'Undo';
  btn.onclick = () => undoStatus(figId);
  el.appendChild(msgSpan);
  el.appendChild(btn);
  el._undoPrev = prevColl;
  el.dataset.figId = figId;
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 5500);
}

window.undoStatus = id => {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  // Multiple toasts may exist for the same figure (rapid cycling).
  // We want the most recent one — querySelectorAll + last element.
  const allToasts = container.querySelectorAll(`[data-fig-id="${id}"]`);
  const toastEl = allToasts[allToasts.length - 1];
  if (!toastEl || !toastEl._undoPrev) return;
  const prev = toastEl._undoPrev;
  if (prev.status) S.coll[id] = prev;
  else { delete S.coll[id]; }
  saveColl();
  // Remove all toasts for this figure so stale undos can't fire
  allToasts.forEach(el => el.remove());
  toast('↩ Undone');
  if (!patchFigRow(id)) render();
};

// v6.03: General-purpose action toast — like toastUndo but the button label
// and handler are caller-supplied. Used for the loadout completeness
// "Mark Loose Complete?" / "Mark Loose Incomplete?" suggestion. Auto-dismisses
// after 5.5s. Tapping the action button runs the handler and removes the toast.
function toastAction(msg, btnLabel, handler) {
  const container = getToastContainer();
  const el = document.createElement('div');
  el.className = 'toast has-undo';
  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-msg';
  msgSpan.textContent = msg;
  const btn = document.createElement('button');
  btn.className = 'toast-undo';
  btn.textContent = btnLabel;
  btn.onclick = () => {
    try { handler(); } catch {}
    if (el.parentNode) el.remove();
  };
  el.appendChild(msgSpan);
  el.appendChild(btn);
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 5500);
}

// ─── Update Available Banner ─────────────────────────────────────
// Shown when SW fires UPDATE_AVAILABLE. Persists until tapped or app restarts.
function showUpdateBanner() {
  if (document.getElementById('updateBanner')) return; // already showing
  const el = document.createElement('div');
  el.id = 'updateBanner';
  el.style.cssText = `
    position:fixed;bottom:calc(56px + var(--safe-bottom, 0px));left:12px;right:12px;
    z-index:290;
    background:var(--acc);color:var(--btn-t);
    border-radius:14px;
    padding:12px 16px;
    display:flex;align-items:center;gap:10px;
    box-shadow:0 4px 24px rgba(0,0,0,.45);
    font-size:14px;font-weight:600;
    animation:toastIn 0.3s ease-out;
    cursor:pointer;
  `;
  el.innerHTML = `
    <span style="flex:1">✦ Update available — tap to refresh</span>
    <button id="updateBannerDismiss" style="background:rgba(0,0,0,.18);border:none;border-radius:8px;color:inherit;font-size:12px;font-weight:700;padding:5px 10px;cursor:pointer;flex-shrink:0">Later</button>
  `;
  el.addEventListener('click', e => {
    if (e.target.id === 'updateBannerDismiss') { el.remove(); return; }
    window.location.reload();
  });
  document.body.appendChild(el);
}


function patchFigRow(id) {
  const c = S.coll[id] || {};
  const statusCls = c.status || '';
  const copyN = entryCopyCount(c);
  const eId = esc(id);
  // Shared bit: rebuild the name's inline ×N pill inside a parent element.
  // The name HTML is `escapedName` + optional count span. Since patchFigRow
  // can be called for either view, factor the "update the name" step out.
  const updateNameInline = (nameEl) => {
    if (!nameEl) return;
    const fig = figById(id);
    const name = fig ? fig.name : id;
    nameEl.innerHTML = esc(name) + (copyN > 1 ? ` <span class="copy-count-inline" title="${copyN} copies">×${copyN}</span>` : '');
  };

  // Try list view row
  const row = document.querySelector(`.fig-row[data-fig-id="${id}"]`);
  if (row) {
    const thumb = row.querySelector('.fig-thumb');
    if (thumb) {
      // v4.92: preserve the stacked-thumbnail classes when re-applying status.
      let cls = 'fig-thumb ' + statusCls;
      if (copyN > 1) cls += ' has-stack';
      if (copyN > 2) cls += ' has-stack-3plus';
      thumb.className = cls.trim();
    }
    updateNameInline(row.querySelector('.fig-name'));
    const actions = row.querySelector('.fig-actions');
    if (actions) {
      const hasVar = /\w/.test(copyVariant(c) || '');
      const isNew = S.newFigIds.has(id);
      actions.innerHTML =
        (isNew ? '<div style="font-size:9px;font-weight:700;color:var(--acc);letter-spacing:0.5px">NEW</div>' : '') +
        (hasVar ? '<div class="fig-var-badge">VAR</div>' : '') +
        (c.status
          ? `<button class="quick-own" onclick="cycleStatus(event,'${eId}')" title="Cycle status" style="border-color:${STATUS_COLOR[c.status]}"><div class="fig-status-dot ${statusCls}"></div></button>`
          : `<button class="quick-own" onclick="event.stopPropagation();setStatus('${eId}','owned')" title="Mark owned">${icon(ICO.check,16)}</button>`);
    }
    updateNavBadge();
    return true;
  }

  // Try grid view card
  const card = document.querySelector(`.fig-card[data-fig-id="${id}"]`);
  if (card) {
    let cardCls = 'fig-card ' + statusCls;
    if (copyN > 1) cardCls += ' has-stack';
    if (copyN > 2) cardCls += ' has-stack-3plus';
    card.className = cardCls.trim();
    updateNameInline(card.querySelector('.card-fig-name'));
    const badge = card.querySelector('.status-badge');
    if (badge) {
      badge.className = 'status-badge ' + statusCls;
      const badgeAction = c.status
        ? `cycleStatus(event,'${eId}')`
        : `event.stopPropagation();setStatus('${eId}','owned')`;
      badge.setAttribute('onclick', badgeAction);
      badge.innerHTML = c.status
        ? `<div class="fig-status-dot ${statusCls}"></div>`
        : `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
    }
    updateNavBadge();
    return true;
  }

  return false;
}

function updateNavBadge() {
  const badge = document.querySelector('.bottom-nav .badge');
  if (badge) {
    const owned = S.figs.filter(f => !figIsHidden(f) && S.coll[f.id]?.status === 'owned').length;
    badge.textContent = owned;
  }
}
// § RENDER-CORE ── render(), renderLoading(), renderMain(), renderContent() ──
const $ = id => document.getElementById(id);
const app = () => document.getElementById('app');

function render() {
  try {
    // v5.04: stagger animation gate. Only fires when render is preceded by
    // navigation (tab change, line change, search clear, etc.) — NOT when
    // a status toggle or in-place patch triggers a render. Without this,
    // every status tap re-plays the entrance animation, which is annoying.
    if (S._justNavigated) {
      app().setAttribute('data-stagger', '1');
      // Clear the attribute after the longest stagger delay (~250ms) so
      // subsequent in-place updates don't animate.
      setTimeout(() => { try { app().removeAttribute('data-stagger'); } catch {} }, 600);
    }
    if (!S.loaded) { renderLoading(); return; }
    if (S.screen === 'figure' && S.activeFig) { renderDetail(); return; }
    renderMain();
  } catch(e) {
    console.error('Render error:', e);
    app().innerHTML = `<div style="padding:40px 20px;text-align:center">
      <div style="font-size:48px;margin-bottom:12px">⚠️</div>
      <div style="color:var(--rd);font-size:16px;font-weight:600;margin-bottom:8px">Something went wrong</div>
      <div class="text-dim text-sm" style="margin-bottom:16px;line-height:1.6">${esc(e.message)}</div>
      <button class="retry-btn" onclick="S.screen='main';S.sheet=null;render()">Recover</button>
    </div>`;
  }
}

function renderLoading() {
  const skeletonCards = Array(6).fill('').map((_, i) =>
    `<div class="skeleton-card" style="animation-delay:${i * 0.1}s"></div>`
  ).join('');
  app().innerHTML = `
    <div style="height:100%;display:flex;flex-direction:column;background:var(--bg)">
      <div class="skeleton-header">
        <div class="skeleton-circle"></div>
        <div class="skeleton-text">
          <div class="skeleton-text-line" style="width:55%"></div>
          <div class="skeleton-text-line" style="width:80%"></div>
        </div>
      </div>
      <div class="skeleton-bar" style="width:70%;margin-bottom:4px"></div>
      <div class="skeleton-bar" style="width:40%;margin-bottom:12px;height:8px"></div>
      ${S.fetchError ? `
        <div style="text-align:center;padding:40px 20px">
          <div style="font-size:48px;margin-bottom:12px">⚡</div>
          <div style="color:var(--rd);font-size:14px;font-weight:600;margin-bottom:8px">Could not load figures</div>
          <div class="text-dim text-sm" style="margin-bottom:24px;line-height:1.6">Check your connection and try again.</div>
          <button class="retry-btn" onclick="fetchFigs(true,true)">Retry</button>
        </div>
      ` : `
        <div class="skeleton-grid">${skeletonCards}</div>
        <div style="text-align:center;padding:8px 0">
          <div class="loading-text" style="font-size:11px;color:var(--t3);letter-spacing:1px">Loading catalog…</div>
        </div>
      `}
    </div>`;
}

function renderMain() {
  // Capture scroll before wiping DOM — but NOT while a sheet is open
  // (content behind sheet may have changed due to filter, causing stale scroll)
  const _prevCa = document.getElementById('contentArea');
  const _preservedScroll = (!S.sheet && _prevCa) ? _prevCa.scrollTop : 0;

  const stats = getStats();
  const sortLabel = S.sortBy.includes('year') ? 'Year' : S.sortBy === 'wave' ? 'Wave' : S.sortBy.includes('name') ? 'Name' : 'Price';
  const hf = hasFilters();
  const syncCls = S.isOffline ? 'offline' : (S.syncStatus === 'syncing' ? 'syncing' : S.syncStatus === 'ok' ? 'sync-ok' : S.syncStatus === 'err' ? 'sync-err' : '');
  const syncClick = S.isOffline ? `toast('✗ No connection')` : `fetchFigs(true)`;
  const syncTitle = S.isOffline ? 'Offline' : 'Sync';

  const themeTitles = getThemeTitles();
  const themeIcon = getThemeIcon();
  const hasTitleCycle = themeTitles.length > 1;
  const titleClick = hasTitleCycle
    ? `S.titleIdx=(S.titleIdx+1)%${themeTitles.length};playTitleSound(S.titleIdx);render()`
    : (S.theme === 'eternia'   ? 'triggerEterniaEgg()'   :
       S.theme === 'heman'     ? 'triggerHeManEgg()'     :
       S.theme === 'grayskull' ? 'triggerGrayskullEgg()' : 'goHome()');

  let html = `
  <div class="offline-banner${S.isOffline ? ' visible' : ''}" id="offlineBanner">
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0119 12.55M5 12.55a10.94 10.94 0 015.17-2.39M10.71 5.05A16 16 0 0122.58 9M1.42 9a15.91 15.91 0 014.7-2.88M8.53 16.11a6 6 0 016.95 0M12 20h.01"/></svg>
    Offline — showing cached data
  </div>
  <div class="top-bar" id="topBar">
    <div class="header-row">
      <div class="logo-group">
        <img src="${themeIcon}" alt="" class="logo-icon" onclick="homeIconClick()" style="cursor:pointer">
        <div>
          <div class="logo-title font-display text-gold" onclick="${titleClick}" style="cursor:pointer;user-select:none">${themeTitles[S.titleIdx % themeTitles.length]}</div>
          <div class="logo-subtitle text-dim text-upper">${stats.total} Figures · ${stats.owned} Owned · <span class="text-gold">v6.03.1</span>${S.syncTs ? ' · '+new Date(S.syncTs).toLocaleDateString() : ''}</div>
        </div>
      </div>
      <div class="header-actions">
        <button class="icon-btn ${syncCls}" title="${syncTitle}" onclick="${syncClick}">${icon(ICO.sync,16)}</button>
        <button class="icon-btn" title="Menu" onclick="openSheet('menu')">${icon(ICO.menu,20)}</button>
      </div>
    </div>
    <div class="search-bar-wrap${S.searchBarHidden?' hidden':''}" id="searchBar">
    <div class="search-row">
      <div class="search-wrap">
        <span class="search-icon">${icon(ICO.search,16)}</span>
        <input id="searchInput" value="${esc(S.search)}" placeholder="${S.activeLine ? 'Search '+ln(S.activeLine)+'…' : 'Search figures…'}" oninput="onSearch(this.value)">
        ${S.search ? `<button class="search-clear" onclick="onSearch('')">${icon(ICO.x,14)}</button>` : ''}
      </div>
      <button class="filter-btn ${hf?'active':''}" onclick="openSheet('filter')">
        ${icon(ICO.filter,18)}${hf ? '<span class="filter-dot"></span>' : ''}
      </button>
      <button class="sort-btn" onclick="openSheet('sort')">
        ${icon(ICO.sort,18)}<span class="sort-label">${sortLabel}</span>
      </button>
    </div>
    </div>
    ${S.activeLine ? renderBreadcrumb() : ''}
  </div>

  <!-- Content -->
  <div class="content-area" id="contentArea">
    <div id="topSpacer"></div>
    ${renderContent()}
  </div>

  <div class="bottom-nav${S.selectMode ? ' hidden' : ''}" id="bottomNav">
    ${renderNavBtn('lines', ICO.lines, 'Lines')}
    ${renderNavBtn('all', ICO.list, 'All', `<span class="badge">${stats.total}</span>`)}
    ${renderNavBtn('collection', ICO.heart, 'Collection', `<span class="badge">${stats.owned}</span>`)}
  </div>`;

  if (isSelecting()) html += renderSelectActionbar();
  if (S.sheet) html += renderSheet();
  app().innerHTML = html;

  // Re-apply visible class to sheet overlay (innerHTML wipes it)
  if (S.sheet) {
    const el = document.getElementById('sheetOverlay');
    if (el) requestAnimationFrame(() => el.classList.add('visible'));
  }

  // Set top spacer height to match fixed top bar, so content starts below it.
  // Fixed elements can return stale offsetHeight synchronously after innerHTML
  // on Android — run three passes: immediate + two rAFs to guarantee accuracy.
  const tb = document.getElementById('topBar');
  const bn = document.getElementById('bottomNav');
  const ca = document.getElementById('contentArea');
  const ts = document.getElementById('topSpacer');
  const applySpacerHeight = () => {
    if (!ts || !tb) return;
    const h = tb.offsetHeight;
    if (h > 0) ts.style.height = h + 'px';
  };
  applySpacerHeight();
  requestAnimationFrame(() => { applySpacerHeight(); requestAnimationFrame(applySpacerHeight); });

  // ResizeObserver keeps the spacer in sync whenever topBar changes height
  // (e.g. search bar slide-in/out, title wrap on small screens). Fennec and
  // older Android WebViews are unreliable with RO inside rAF so we keep the
  // triple-rAF above as the guaranteed initial-frame path and let RO handle
  // subsequent dynamic changes only.
  if ('ResizeObserver' in window) {
    if (window._topBarRO) window._topBarRO.disconnect();
    window._topBarRO = new ResizeObserver(() => {
      const t = document.getElementById('topBar');
      const s = document.getElementById('topSpacer');
      if (t && s) { const h = t.offsetHeight; if (h > 0) s.style.height = h + 'px'; }
    });
    if (tb) window._topBarRO.observe(tb);
  }

  // Re-apply immersive state after innerHTML rebuild
  if (S.barsHidden && !S.sheet) {
    if (tb) tb.classList.add('immersive-hide');
    if (bn) bn.classList.add('immersive-hide');
  }

  // Restore scroll — savedScroll from fig nav takes priority; else preserve across renders
  if (ca) {
    const maxScroll = Math.max(0, ca.scrollHeight - ca.clientHeight);
    if (S.savedScroll && S.screen === 'main') {
      ca.scrollTop = Math.min(S.savedScroll, maxScroll);
      S.savedScroll = 0;
    } else if (_preservedScroll > 0 && !S.sheet && !S._justNavigated) {
      ca.scrollTop = Math.min(_preservedScroll, maxScroll);
    }
    S._justNavigated = false;
  }

  // Immersive scroll: hide/show bars via transform only — no layout changes
  if (ca) {
    let lastScrollTop = ca.scrollTop;
    let _suppressed = true; // suppress initial scroll events from restore
    let _lastToggleTs = 0;  // v4.95: hysteresis timer to prevent header flashing
    requestAnimationFrame(() => { _suppressed = false; lastScrollTop = ca.scrollTop; });
    ca._scrollHandler && ca.removeEventListener('scroll', ca._scrollHandler);
    ca._scrollHandler = () => {
      if (_suppressed || S.editingOrder) return;
      const tb = document.getElementById('topBar');
      const bn = document.getElementById('bottomNav');
      const sb = document.getElementById('searchBar');
      if (!tb || !bn) return;
      const st = ca.scrollTop;
      const delta = st - lastScrollTop;
      lastScrollTop = st;
      const nearBottom = ca.scrollHeight - st - ca.clientHeight < 30;
      // v5.00: at the bottom of the list, force bars back so the user can
      // tap nav/search without scrolling up first. Was previously a hard
      // return that left bars in whatever state they were on entry.
      if (nearBottom) {
        if (S.barsHidden) {
          tb.classList.remove('immersive-hide');
          bn.classList.remove('immersive-hide');
          if (sb) { sb.classList.remove('hidden'); S.searchBarHidden = false; }
          S.barsHidden = false;
          _lastToggleTs = Date.now();
        }
        return;
      }
      // v4.95: lock out reverse-direction toggles for 200ms after the last
      // toggle, plus require a larger delta (8px instead of 4px) to start
      // hiding. Without this, fast/jittery scrolls would flap the bars on
      // and off as small overshoot/correction motions crossed the ±4 line.
      const now = Date.now();
      if (now - _lastToggleTs < 200) {
        _scheduleIdleShow();
        return;
      }
      if (delta > 8 && st > 40 && !S.barsHidden) {
        tb.classList.add('immersive-hide');
        bn.classList.add('immersive-hide');
        if (sb) { sb.classList.add('hidden'); S.searchBarHidden = true; }
        S.barsHidden = true;
        _lastToggleTs = now;
      } else if ((delta < -8 || st < 20) && S.barsHidden) {
        tb.classList.remove('immersive-hide');
        bn.classList.remove('immersive-hide');
        if (sb) { sb.classList.remove('hidden'); S.searchBarHidden = false; }
        S.barsHidden = false;
        _lastToggleTs = now;
      }
      _scheduleIdleShow();
    };
    // v5.01: when scrolling pauses for 3.5s, fade the bars back in. Avoids
    // leaving the user stranded with no nav after they stop reading.
    let _idleTimer = null;
    function _scheduleIdleShow() {
      if (_idleTimer) clearTimeout(_idleTimer);
      _idleTimer = setTimeout(() => {
        if (!S.barsHidden) return;
        const tb2 = document.getElementById('topBar');
        const bn2 = document.getElementById('bottomNav');
        const sb2 = document.getElementById('searchBar');
        if (!tb2 || !bn2) return;
        tb2.classList.remove('immersive-hide');
        bn2.classList.remove('immersive-hide');
        if (sb2) { sb2.classList.remove('hidden'); S.searchBarHidden = false; }
        S.barsHidden = false;
        _lastToggleTs = Date.now();
      }, 3500);
    }
    ca.addEventListener('scroll', ca._scrollHandler, {passive: true});

    // Pull-to-refresh
    let _ptrStart = 0, _ptrActive = false;
    // v5.00: pull-to-refresh is now opt-in. On some devices (sensitive
    // touchscreens) it fires during normal upward scrolling, causing
    // unwanted constant resyncs. fetchFigs already runs on page load and
    // every visibilitychange, so PTR is redundant for most users.
    if (store.get('motu-ptr-enabled')) {
      ca._ptrTouchStart && ca.removeEventListener('touchstart', ca._ptrTouchStart);
      ca._ptrTouchEnd && ca.removeEventListener('touchend', ca._ptrTouchEnd);
      ca._ptrTouchStart = e => { if (ca.scrollTop <= 0) _ptrStart = e.touches[0].clientY; else _ptrStart = 0; };
      ca._ptrTouchEnd = e => {
        // v5.00: threshold raised 80→120px to reduce false fires on sensitive
        // touch hardware where small upward gestures crossed the old threshold.
        if (_ptrStart && e.changedTouches[0].clientY - _ptrStart > 120 && ca.scrollTop <= 0 && !_ptrActive) {
          _ptrActive = true;
          haptic(20);
          toast('↻ Syncing…');
          fetchFigs(true).then(() => { _ptrActive = false; });
        }
        _ptrStart = 0;
      };
      ca.addEventListener('touchstart', ca._ptrTouchStart, {passive: true});
      ca.addEventListener('touchend', ca._ptrTouchEnd, {passive: true});
    }

    // Long-press context menu on figure rows and cards
    requestAnimationFrame(() => {
      document.querySelectorAll('.fig-row[data-fig-id], .fig-card[data-fig-id]').forEach(el => {
        if (el._lpBound) return;
        el._lpBound = true;
        initLongPress(el, el.dataset.figId);
      });
    });
  }
}

function renderSelectActionbar() {
  const n = S.selected.size;
  const totalVisible = getSortedFigs().length;
  const allSelected = n > 0 && n === totalVisible;
  const dis = n ? '' : 'disabled';
  // Confirmation state — replace entire actionbar content
  if (S.confirmClear) {
    return `<div class="select-actionbar visible">
      <div class="sa-row" style="flex:1">
        <span style="flex:1;font-size:13px;font-weight:600;color:var(--t1)">Remove status from ${n} figure${n===1?'':'s'}?</span>
        <button onclick="S.confirmClear=false;document.querySelector('.select-actionbar').outerHTML=renderSelectActionbar()"
          style="padding:10px 16px;border-radius:10px;border:1px solid var(--bd);background:var(--bg3);color:var(--t2);font-size:13px;font-weight:600">
          Cancel
        </button>
        <button onclick="S.confirmClear=false;batchSetStatus('')"
          style="padding:10px 18px;border-radius:10px;border:2px solid var(--rd);background:color-mix(in srgb,var(--rd) 18%,var(--bg3));color:var(--rd);font-size:13px;font-weight:800">
          Clear
        </button>
      </div>
    </div>`;
  }

  const statusRow = STATUSES.map(s =>
    `<button class="sa-status-btn" ${dis} style="--st-c:${STATUS_HEX[s]}"
      onclick="batchSetStatus('${s}')">${STATUS_LABEL[s]}</button>`
  ).join('');
  return `<div class="select-actionbar visible">
    <div class="sa-row">
      <span class="count">${n}</span>
      <button onclick="selectAllVisible()" title="${allSelected ? 'Deselect all' : 'Select all'}">
        ${allSelected ? 'None' : 'All'}
      </button>
      <button class="primary" ${dis} onclick="openBatchEditor()" style="flex:1">
        ${icon(ICO.edit, 14)} Add Copy…
      </button>
      <button ${dis} onclick="S.confirmClear=true;document.querySelector('.select-actionbar').outerHTML=renderSelectActionbar()"
        style="padding:9px 14px;border-radius:10px;border:2px solid color-mix(in srgb,var(--rd) 50%,var(--bd));background:color-mix(in srgb,var(--rd) 10%,var(--bg3));color:var(--rd);font-size:13px;font-weight:800;flex-shrink:0">
        Clear
      </button>
      <button onclick="exitSelectMode()"
        style="padding:9px 14px;border-radius:10px;border:1px solid color-mix(in srgb,var(--gn) 40%,var(--bd));background:color-mix(in srgb,var(--gn) 12%,var(--bg3));color:var(--gn);font-size:13px;font-weight:800;flex-shrink:0">
        Done
      </button>
    </div>
    <div class="sa-status-row">${statusRow}</div>
  </div>`;
}

function renderNavBtn(key, ico, label, extra='') {
  const active = (S.tab === key && !S.activeLine) || (key === 'lines' && S.activeLine && S.tab === 'all');
  const showIcon = key !== 'collection';
  return `<button class="${active?'active':''}" onclick="navTo('${key}')">${showIcon ? icon(ico,14,active?2.5:1.5) : ''}${label}${extra}</button>`;
}

function renderBreadcrumb() {
  let html = '<div class="breadcrumb">';
  // v4.91: "Lines" and the line-name crumb now use explicit state-setting
  // handlers instead of relying on history.back(). When there's no subline
  // active, the line name is also made tappable (goes to the same place as
  // "Lines" — the main lines grid — matching user expectation from the
  // feedback: "clicking lines should take you back to the main lines").
  html += `<button class="crumb-link" onclick="crumbToLines()">${icon(ICO.back,14)} Lines</button><span class="sep">›</span>`;
  if (S.activeSubline) {
    html += `<button class="crumb-link" onclick="crumbToLine()">${esc(ln(S.activeLine))}</button><span class="sep">›</span>`;
    const slLabel = S.activeSubline === '__all__' ? 'All Figures' : (SUBLINES[S.activeLine]||[]).find(s=>s.key===S.activeSubline)?.label || '';
    html += `<span class="current">${esc(slLabel)}</span>`;
  } else {
    html += `<span class="current">${esc(ln(S.activeLine))}</span>`;
  }
  // v5.00: Removed inline Kids Core "Add Figure" button. Adding figures is
  // now done via the standalone kids-core-editor.html that round-trips
  // through localStorage / repo JSON. Editing existing figures from the
  // detail screen still works (Edit button → openSheet kidsCoreAdmin).
  html += '</div>';
  return html;
}

function renderKidsCoreAdminSheet() {
  const editing = S._kcEditId || null;
  const existing = editing ? (store.get(KIDS_CORE_KEY)||[]).find(f => f.id === editing) : null;
  const v = S._kcForm || {};

  const field = (label, key, type='text', placeholder='', extra='') =>
    `<div style="margin-bottom:12px">
      <div class="field-label text-dim text-sm">${label}</div>
      <input type="${type}" value="${esc(v[key]||existing?.[key]||'')}" placeholder="${placeholder}"
        oninput="S._kcForm=S._kcForm||{};S._kcForm['${key}']=this.value" ${extra}>
    </div>`;

  // Group pills for kids-core
  const groups = ['Action Figures','Movie (2026)'];
  const curGroup = v.group || existing?.group || '';

  let h = '';
  if (editing) {
    h += `<div style="margin-bottom:14px;padding:10px 14px;border-radius:10px;background:color-mix(in srgb,var(--acc) 10%,transparent);border:1px solid var(--acc)">
      <div class="text-sm" style="color:var(--acc);font-weight:600">Editing: ${esc(existing?.name||editing)}</div>
    </div>`;
  }

  h += field('Name *', 'name', 'text', 'e.g. He-Man');
  h += field('Year', 'year', 'number', '2026');
  h += field('Wave', 'wave', 'text', 'e.g. 1');
  h += field('Retail Price', 'retail', 'number', '0.00');
  // v4.93: faction is a dropdown (FACTIONS list) instead of free text — keeps
  // values consistent with the rest of the catalog and prevents typos that
  // would split the Faction filter into separate buckets.
  const curFaction = v.faction != null ? v.faction : (existing?.faction || '');
  h += `<div style="margin-bottom:12px">
    <div class="field-label text-dim text-sm">Faction</div>
    <select onchange="S._kcForm=S._kcForm||{};S._kcForm.faction=this.value">
      <option value="">— Select —</option>
      ${FACTIONS.map(f => `<option value="${esc(f)}" ${curFaction===f?'selected':''}>${esc(f)}</option>`).join('')}
    </select>
  </div>`;

  // Group pills
  h += `<div style="margin-bottom:12px">
    <div class="field-label text-dim text-sm">Group *</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${groups.map(g => `<button type="button" onclick="S._kcForm=S._kcForm||{};S._kcForm.group='${g}';render()" style="padding:6px 14px;border-radius:20px;border:1px solid ${curGroup===g?'var(--acc)':'var(--bd)'};background:${curGroup===g?'color-mix(in srgb,var(--acc) 18%,transparent)':'var(--bg2)'};color:${curGroup===g?'var(--acc)':'var(--t2)'};font-size:13px;font-weight:500">${g}</button>`).join('')}
    </div>
  </div>`;

  h += `<button onclick="saveKidsCoreAdminFig()" style="width:100%;padding:14px;border-radius:12px;background:var(--acc);color:var(--btn-t);font-size:15px;font-weight:700;margin-bottom:10px">
    ${editing ? 'Save Changes' : 'Add Figure'}
  </button>`;

  if (editing) {
    h += `<button onclick="deleteKidsCoreAdminFig('${esc(editing)}')" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--rd);background:color-mix(in srgb,var(--rd) 10%,transparent);color:var(--rd);font-size:14px;font-weight:600">
      Delete Figure
    </button>`;
  }

  // List of existing local kids-core figures
  const localFigs = (store.get(KIDS_CORE_KEY)||[]);
  if (localFigs.length) {
    h += `<div style="margin-top:20px;border-top:1px solid var(--bd);padding-top:16px">
      <div class="label text-upper text-dim text-xs" style="margin-bottom:10px">Local Kids Core Figures (${localFigs.length})</div>`;
    localFigs.forEach(f => {
      h += `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--bd)">
        <div>
          <div class="text-sm" style="color:var(--t1);font-weight:600">${esc(f.name)}</div>
          <div class="text-sm text-dim">${esc(f.group||'')}${f.year?' · '+f.year:''}</div>
        </div>
        <button onclick="S._kcEditId='${esc(f.id)}';S._kcForm=null;render()" style="padding:5px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--bg3);color:var(--t2);font-size:12px">Edit</button>
      </div>`;
    });
    h += '</div>';
  }

  return h;
}

function renderContent() {
  if (S.tab === 'lines' && !S.activeLine) return renderLinesGrid();
  if (!S.search && S.activeLine && !S.activeSubline && SUBLINES[S.activeLine]) return renderSublines();
  return renderFigList();
}

function renderStatsSheet() {
  const stats = getStats();
  const unowned = stats.total - stats.owned - stats.wish - stats.ord - stats.sale;
  const pct = n => stats.total ? (n / stats.total * 100).toFixed(1) : 0;
  // Spent totals — sum paid across all copies of each owned figure.
  let totalSpent = 0, paidCount = 0;
  S.figs.filter(f => !figIsHidden(f) && S.coll[f.id]?.status === 'owned').forEach(f => {
    const c = S.coll[f.id];
    if (isMigrated(c)) {
      for (const cp of c.copies) {
        const v = parseFloat(cp.paid) || 0;
        if (v > 0) { totalSpent += v; paidCount++; }
      }
    } else {
      const v = parseFloat(c.paid) || 0;
      if (v > 0) { totalSpent += v; paidCount++; }
    }
  });
  const avgStr = paidCount > 0 ? `$${(totalSpent / paidCount).toFixed(2)} avg` : '';

  let html = `<div class="stats-bar" style="padding:0 0 16px">
    <div class="stats-segments">
      ${stats.owned ? `<div class="seg owned" style="width:${pct(stats.owned)}%"></div>` : ''}
      ${stats.wish ? `<div class="seg wishlist" style="width:${pct(stats.wish)}%"></div>` : ''}
      ${stats.ord ? `<div class="seg ordered" style="width:${pct(stats.ord)}%"></div>` : ''}
      ${stats.sale ? `<div class="seg for-sale" style="width:${pct(stats.sale)}%"></div>` : ''}
    </div>
    <div class="stats-legend">
      <button class="stat-item" onclick="goToFiltered('owned')"><div class="stat-dot owned"></div><span class="stat-val">${stats.owned}</span> owned</button>
      <button class="stat-item" onclick="goToFiltered('wishlist')"><div class="stat-dot wishlist"></div><span class="stat-val">${stats.wish}</span> wish</button>
      <button class="stat-item" onclick="goToFiltered('ordered')"><div class="stat-dot ordered"></div><span class="stat-val">${stats.ord}</span> ord</button>
      ${stats.sale ? `<button class="stat-item" onclick="goToFiltered('for-sale')"><div class="stat-dot for-sale"></div><span class="stat-val">${stats.sale}</span> sale</button>` : ''}
      <button class="stat-item" onclick="goToFiltered('unowned')"><div class="stat-dot unowned"></div><span class="stat-val">${unowned}</span> unowned</button>
    </div>
    ${totalSpent > 0 ? `<div style="margin-top:10px;font-size:13px;color:var(--gold);font-weight:600">$${totalSpent.toFixed(2)} spent${avgStr ? ` · ${avgStr}` : ''}</div>` : ''}
  </div>`;

  // Per-line breakdown
  html += '<div class="label text-upper text-dim text-xs" style="margin-bottom:10px">By Line</div>';
  const lineStats = getLineStats();
  const ordered = [...S.lineOrder].map(id => lineStats.find(l => l.id === id)).filter(Boolean)
    .concat(lineStats.filter(l => !S.lineOrder.includes(l.id)));
  ordered.filter(l => !isLineFullyHidden(l.id) && l.total > 0).forEach(l => {
    html += `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid color-mix(in srgb, var(--bd) 30%, transparent)">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--t1);margin-bottom:4px">${esc(l.name)}</div>
        <div style="height:4px;background:var(--bd);border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${l.pct}%;background:${l.pct===100?'var(--gn)':'var(--acc)'};border-radius:2px;transition:width 0.3s"></div>
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:13px;font-weight:700;color:${l.pct===100?'var(--gn)':'var(--gold)'}">${l.pct}%</div>
        <div style="font-size:10px;color:var(--t3)">${l.owned}/${l.total}</div>
      </div>
    </div>`;
  });

  return html;
}

// ─── Want-List Share Link (v4.58) ─────────────────────────────────
// Encodes wishlist figure IDs into a compact URL fragment.
// Format: <base_url>#wl=<base64url(numeric_ids joined by comma)>
// We store only the trailing numeric AF411 ID from each slug
// (e.g. "he-man-40th-anniversary-4220" → 4220) to keep the payload small.
// The receiver reconstructs figure info from their own figures.json cache.

function buildShareURL() {
  const ids = Object.entries(S.coll)
    .filter(([, c]) => c.status === 'wishlist' || c.status === 'ordered')
    .map(([id]) => id.match(/(\d+)$/)?.[1])
    .filter(Boolean);
  if (!ids.length) return null;
  const payload = btoa(ids.join(','))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const base = location.href.split('#')[0];
  return `${base}#wl=${payload}`;
}

function decodeShareURL(hash) {
  const m = hash.match(/[#&]wl=([A-Za-z0-9\-_]+)/);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    return atob(b64).split(',').map(n => n.trim()).filter(Boolean);
  } catch { return null; }
}

// Minimal QR Code encoder — byte mode, error correction level M.
// Produces a matrix (2D boolean array) from a UTF-8 string ≤ ~800 chars.
// Based on the ISO 18004 spec; covers all URL characters.
(function() {
  // Reed-Solomon GF(256) arithmetic
  const GF = (() => {
    const exp = new Uint8Array(512), log = new Uint8Array(256);
    let x = 1;
    for (let i = 0; i < 255; i++) {
      exp[i] = x; log[x] = i;
      x = x << 1; if (x > 255) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
    return {
      mul: (a, b) => a && b ? exp[log[a] + log[b]] : 0,
      poly: (ec) => {
        let g = [1];
        for (let i = 0; i < ec; i++) {
          const n = []; const root = exp[i];
          for (let j = 0; j < g.length + 1; j++)
            n[j] = (g[j] ? GF.mul(g[j], root) : 0) ^ (g[j-1] || 0);
          g = n;
        }
        return g;
      },
      rem: (data, poly) => {
        const d = [...data];
        for (let i = 0; i < poly.length - 1; i++) d.push(0);
        for (let i = 0; i < data.length; i++) {
          const c = d[i];
          if (!c) continue;
          for (let j = 1; j < poly.length; j++)
            d[i + j] ^= GF.mul(poly[j], c);
        }
        return d.slice(data.length);
      },
    };
  })();

  // Version/capacity tables (versions 1-10, EC level M)
  const VER = [
    null,
    {cap:16,  ec:10, blocks:[[1,19,16]]},
    {cap:28,  ec:16, blocks:[[1,34,28]]},
    {cap:44,  ec:26, blocks:[[1,55,44]]},
    {cap:64,  ec:18, blocks:[[2,25,16]]},
    {cap:86,  ec:24, blocks:[[2,33,24]]},
    {cap:108, ec:16, blocks:[[4,27,19]]},
    {cap:124, ec:18, blocks:[[4,29,22],[1,31,22]]},
    {cap:154, ec:22, blocks:[[2,42,33],[2,43,33]]},
    {cap:182, ec:22, blocks:[[3,39,30],[2,40,30]]},
    {cap:216, ec:26, blocks:[[4,40,24],[1,41,24]]},
  ];

  function encode(str) {
    // UTF-8 bytes
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) { bytes.push(0xC0|(c>>6)); bytes.push(0x80|(c&0x3f)); }
      else { bytes.push(0xE0|(c>>12)); bytes.push(0x80|((c>>6)&0x3f)); bytes.push(0x80|(c&0x3f)); }
    }
    // Find version
    let ver = 1;
    while (ver <= 10 && VER[ver].cap < bytes.length) ver++;
    if (ver > 10) return null; // too long
    const v = VER[ver];

    // Build data codewords
    const bits = [];
    const push = (val, len) => { for (let i = len-1; i >= 0; i--) bits.push((val>>i)&1); };
    push(0b0100, 4); push(bytes.length, 8);
    bytes.forEach(b => push(b, 8));
    push(0, 4); // terminator
    while (bits.length % 8) bits.push(0);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0; for (let j = 0; j < 8; j++) b = (b<<1)|(bits[i+j]||0); cw.push(b);
    }
    const pads = [0xEC, 0x11];
    while (cw.length < v.blocks.reduce((s,[n,,k])=>s+n*k,0)) cw.push(pads[(cw.length)%2===0?0:1]);

    // Split into blocks + compute EC
    const allBlocks = []; let idx = 0;
    v.blocks.forEach(([n, total, kk]) => {
      for (let i = 0; i < n; i++) {
        const d = cw.slice(idx, idx+kk); idx += kk;
        allBlocks.push({d, e: GF.rem(d, GF.poly(total-kk))});
      }
    });
    // Interleave
    const out = [];
    const maxD = Math.max(...allBlocks.map(b=>b.d.length));
    const maxE = allBlocks[0].e.length;
    for (let i=0;i<maxD;i++) allBlocks.forEach(b=>{if(i<b.d.length)out.push(b.d[i]);});
    for (let i=0;i<maxE;i++) allBlocks.forEach(b=>out.push(b.e[i]));

    // Place in matrix
    const size = ver*4+17;
    const mat = Array.from({length:size}, ()=>new Int8Array(size).fill(-1));
    const res = Array.from({length:size}, ()=>new Uint8Array(size));
    function setM(r,c,v,fn=false){mat[r][c]=v;if(fn||v>=0)res[r][c]=1;}

    // Finder patterns
    [[0,0],[0,size-7],[size-7,0]].forEach(([r,c])=>{
      for(let i=0;i<7;i++)for(let j=0;j<7;j++){
        setM(r+i,c+j,(i===0||i===6||j===0||j===6)?1:(i>=2&&i<=4&&j>=2&&j<=4)?1:0,true);
      }
      // Separator
      for(let i=0;i<8;i++){
        if(r+7<size&&c+i<size)setM(r+7,c+i,0,true);
        if(r+i<size&&c+7<size)setM(r+i,c+7,0,true);
        if(r>0&&r-1>=0&&c+i<size)setM(r-1,c+i,0,true);
        if(c>0&&c-1>=0&&r+i<size)setM(r+i,c-1,0,true);
      }
    });

    // Timing
    for(let i=8;i<size-8;i++){setM(6,i,i%2===0?1:0,true);setM(i,6,i%2===0?1:0,true);}

    // Alignment (ver >= 2)
    if(ver>=2){
      const ap=[6,ver<=6?18:ver<=13?22:26];
      for(let ar=0;ar<ap.length;ar++)for(let ac=0;ac<ap.length;ac++){
        const r=ap[ar],c=ap[ac];
        if(res[r][c])continue;
        for(let i=-2;i<=2;i++)for(let j=-2;j<=2;j++)
          setM(r+i,c+j,(Math.abs(i)===2||Math.abs(j)===2)?1:(i===0&&j===0)?1:0,true);
      }
    }

    // Dark module
    setM(size-8,8,1,true);

    // Format info placeholder
    for(let i=0;i<6;i++){res[8][i]=1;res[i][8]=1;}
    res[8][7]=1;res[7][8]=1;res[8][8]=1;
    for(let i=0;i<8;i++){res[8][size-1-i]=1;res[size-1-i][8]=1;}

    // Data placement
    let bitIdx=0; let up=true;
    for(let col=size-1;col>0;col-=2){
      if(col===6)col=5;
      for(let row=up?size-1:0; up?row>=0:row<size; up?row--:row++){
        for(let dc=0;dc<2;dc++){
          const c=col-dc;
          if(res[row][c])continue;
          const bit=bitIdx<out.length*8?(out[bitIdx>>3]>>(7-(bitIdx&7)))&1:0;
          mat[row][c]=bit; bitIdx++;
        }
      }
      up=!up;
    }

    // Mask pattern 0: (row+col)%2===0
    for(let r=0;r<size;r++)for(let c=0;c<size;c++)
      if(!res[r][c]&&(r+c)%2===0)mat[r][c]^=1;

    // Format string (EC=M=01, mask=0=000 → 101010000010010, XOR 101010000010010)
    const fmtBits=[1,0,1,0,1,0,0,0,0,0,1,0,0,1,0];
    for(let i=0;i<6;i++){mat[8][i]=fmtBits[i];mat[i][8]=fmtBits[i];}
    mat[8][7]=fmtBits[6];mat[7][8]=fmtBits[6];mat[8][8]=fmtBits[7];
    for(let i=0;i<8;i++){mat[8][size-1-i]=fmtBits[14-i];mat[size-1-i][8]=fmtBits[14-i];}

    return {mat,size};
  }

  window.qrEncode = encode;
})();

function renderQR(str, px=4) {
  const result = qrEncode(str);
  if (!result) return '<div class="text-sm text-dim">URL too long for QR</div>';
  const {mat, size} = result;
  const quiet = 2; // quiet zone modules
  const total = (size + quiet*2) * px;
  let svg = `<svg viewBox="0 0 ${total} ${total}" width="${total}" height="${total}" xmlns="http://www.w3.org/2000/svg" style="display:block;border-radius:8px;background:#fff;padding:${quiet*px}px">`;
  for (let r=0;r<size;r++) for(let c=0;c<size;c++)
    if (mat[r][c]===1) svg += `<rect x="${c*px}" y="${r*px}" width="${px}" height="${px}" fill="#000"/>`;
  svg += '</svg>';
  return svg;
}

function renderShareSheet() {
  const wishFigs = S.figs.filter(f => {
    const c = S.coll[f.id];
    return c && (c.status === 'wishlist' || c.status === 'ordered');
  });
  if (!wishFigs.length) {
    return `<div style="text-align:center;padding:32px 16px">
      <div style="font-size:32px;margin-bottom:12px">📋</div>
      <div style="font-size:15px;font-weight:600;color:var(--t1);margin-bottom:6px">No want list yet</div>
      <div style="font-size:13px;color:var(--t3)">Mark figures as Wishlist or Ordered to share them.</div>
    </div>`;
  }

  const url = buildShareURL();
  const qrSvg = renderQR(url, 4);
  const canShare = !!navigator.share;

  return `
    <div style="text-align:center;margin-bottom:16px">
      <div style="font-size:13px;color:var(--t2);margin-bottom:12px">${wishFigs.length} figure${wishFigs.length===1?'':'s'} on your want list</div>
      <div style="display:inline-block;padding:10px;background:#fff;border-radius:12px;margin-bottom:14px">${qrSvg}</div>
      <div style="font-size:11px;color:var(--t3);margin-bottom:14px">Scan to view want list</div>
    </div>
    <div style="background:var(--bg3);border:1px solid var(--bd);border-radius:10px;padding:10px 12px;margin-bottom:12px;display:flex;align-items:center;gap:8px">
      <div style="flex:1;font-size:11px;color:var(--t3);word-break:break-all;font-family:monospace;line-height:1.4">${esc(url)}</div>
      <button onclick="copyShareURL()" style="flex-shrink:0;padding:8px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--bg2);color:var(--acc);font-size:12px;font-weight:600">Copy</button>
    </div>
    ${canShare ? `<button onclick="nativeShare()" style="width:100%;padding:14px;border-radius:12px;border:1px solid var(--acc);background:var(--acc);color:var(--btn-t);font-size:15px;font-weight:700;margin-bottom:10px">
      ${icon(ICO.share,16)} Share…
    </button>` : ''}
    <div style="margin-top:14px">
      <div class="label text-upper text-dim text-xs" style="margin-bottom:8px">On your list</div>
      ${wishFigs.slice(0,8).map(f => {
        const c = S.coll[f.id];
        const color = STATUS_HEX[c.status];
        return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid color-mix(in srgb,var(--bd) 40%,transparent)">
          <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div>
          <div style="font-size:13px;color:var(--t1);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</div>
          <div style="font-size:11px;color:var(--t3)">${STATUS_LABEL[c.status]}</div>
        </div>`;
      }).join('')}
      ${wishFigs.length > 8 ? `<div style="font-size:12px;color:var(--t3);padding:8px 0">+${wishFigs.length-8} more</div>` : ''}
    </div>`;
}

window.copyShareURL = () => {
  const url = buildShareURL();
  if (!url) return;
  navigator.clipboard.writeText(url).then(
    () => toast('✓ Link copied'),
    () => {
      // Fallback for older Android WebView
      const ta = document.createElement('textarea');
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('✓ Link copied'); } catch { toast('✗ Copy failed'); }
      ta.remove();
    }
  );
};

window.nativeShare = () => {
  const url = buildShareURL();
  if (!url || !navigator.share) return;
  navigator.share({ title: 'MOTU Vault — Want List', url })
    .catch(() => {});
};

// ─── Want-List View (incoming share link) ─────────────────────────
// Reads #wl= fragment on load and shows a read-only list.
// v5.00: PWA app-icon shortcuts. The manifest.json declares shortcuts that
// long-pressing the installed PWA icon exposes as quick actions; each links
// back to the app with ?action=<key>. We dispatch on that key here once
// figures are loaded. Action runs once then the URL is cleaned so a refresh
// doesn't re-trigger.
const SHORTCUT_ACTIONS = {
  'share-wantlist': () => openSheet('share'),
  'stats':          () => openSheet('stats'),
  'sync':           () => fetchFigs(true),
  'menu':           () => openSheet('menu'),
};
function checkShortcutAction() {
  const params = new URLSearchParams(location.search);
  const action = params.get('action');
  if (!action || !SHORTCUT_ACTIONS[action]) return;
  // Wait for figures to land for actions that need them.
  let _retries = 0;
  function run() {
    if (!S.figs.length && action !== 'sync') {
      if (++_retries > 100) return;
      setTimeout(run, 150);
      return;
    }
    try { SHORTCUT_ACTIONS[action](); } catch {}
    // Clean the URL so reload doesn't re-fire the action.
    if (history.replaceState) {
      params.delete('action');
      const q = params.toString();
      history.replaceState({}, '', location.pathname + (q ? '?' + q : '') + location.hash);
    }
  }
  run();
}

function checkShareLink() {
  const nums = decodeShareURL(location.hash);
  if (!nums || !nums.length) return;
  // Wait for figs to be loaded (may be called before/after figures.json)
  let _retries = 0;
  function show() {
    if (!S.figs.length) {
      if (++_retries > 150) { toast('✗ Could not load want list'); return; }
      setTimeout(show, 200); return;
    }
    // Build a numeric suffix → figId map
    const byNum = new Map();
    S.figs.forEach(f => { const m = f.id.match(/(\d+)$/); if(m) byNum.set(m[1], f); });
    const figs = nums.map(n => byNum.get(n)).filter(Boolean);
    if (!figs.length) return;
    S.sheet = 'wantListView';
    S._sharedWantList = figs;
    pushNav();
    render();
  }
  show();
}

function renderWantListViewSheet() {
  const figs = S._sharedWantList || [];
  if (!figs.length) return '<div class="text-sm text-dim">Empty want list.</div>';
  const scrollHint = figs.length > 4 ? '<div style="font-size:11px;color:var(--t3);text-align:center;margin-bottom:8px">↕ Scroll to see all</div>' : '';
  let h = `<div style="font-size:13px;color:var(--t2);margin-bottom:6px">${figs.length} figure${figs.length===1?'':'s'} wanted</div>${scrollHint}`;
  figs.forEach(f => {
    const entry = S.coll[f.id];
    const owned = entry?.status === 'owned' || entry?.status === 'for-sale';
    h += `<div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg3);border:1px solid ${owned?'var(--gn)':'var(--bd)'};border-radius:10px;margin-bottom:8px">
      <img src="${f.image}" onerror="this.style.display='none'" style="width:40px;height:40px;object-fit:cover;border-radius:6px;flex-shrink:0;background:var(--bd)">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</div>
        <div style="font-size:11px;color:var(--t3)">${esc([f.line, f.wave].filter(Boolean).join(' · '))}</div>
      </div>
      ${owned ? `<div style="font-size:11px;font-weight:700;color:var(--gn)">✓ You own it</div>` : ''}
    </div>`;
  });
  return h;
}

// § RENDER-LISTS ── renderLinesGrid, renderSublines, renderFigRow, renderFigCard, renderFigList ──
// v4.86: restored missing `function renderLinesGrid() {` declaration (orphan
// body, same pattern as getLineStats / exportCSV).
function renderLinesGrid() {
  const lineStats = getLineStats();
  const ordered = [...S.lineOrder].map(id => lineStats.find(l => l.id === id)).filter(Boolean)
    .concat(lineStats.filter(l => !S.lineOrder.includes(l.id)));

  let html = '';
  if (!S.onboarded) {
    html += `<div class="onboard-banner">
      <div style="flex:1">👋 <strong style="color:var(--t1)">Getting started:</strong> Tap a line below to browse its figures. Tap any figure to mark it Owned, Wishlist, or For Sale — it'll appear in your Collection tab.</div>
      <button class="onboard-dismiss" onclick="S.onboarded=true;store.set('motu-onboarded',1);render()" title="Dismiss">×</button>
    </div>`;
  }
  if (S.editingOrder) {
    html += `<div class="reorder-toggle"><button class="active" onclick="toggleReorder()">✓ Done</button></div>`;
  }

  if (S.editingOrder) {
    html += '<div class="reorder-list">';
    ordered.forEach((l, i) => {
      const hidden = isLineFullyHidden(l.id);
      html += `<div class="reorder-item" style="${hidden?'opacity:0.4':''}">
        <div class="reorder-arrows">
          <button ${i===0?'disabled':''} onclick="moveLine('${l.id}',-1)">↑</button>
          <button ${i===ordered.length-1?'disabled':''} onclick="moveLine('${l.id}',1)">↓</button>
        </div>
        <div style="flex:1;min-width:0">
          <div class="font-display" style="font-size:14px;color:var(--t1)">${esc(l.name)}</div>
          <div class="text-sm text-dim" style="margin-top:2px">${l.yr} · ${l.total} figures · ${l.owned} owned</div>
        </div>
        <button onclick="event.stopPropagation();toggleHidden('${l.id}')" style="padding:4px 10px;border-radius:8px;border:1px solid ${hidden?'var(--rd)':'var(--bd)'};background:${hidden?'color-mix(in srgb, var(--rd) 10%, transparent)':'var(--bg3)'};color:${hidden?'var(--rd)':'var(--t3)'};font-size:10px;flex-shrink:0">
          ${hidden?'Hidden':'Hide'}
        </button>
        <div style="font-size:12px;font-weight:600;color:${l.pct===100?'var(--gn)':'var(--gold)'};flex-shrink:0">${l.pct}%</div>
      </div>`;
    });
    html += '</div>';
  } else {
    // v5.01: lines screen now supports list view too. State key 'motu-lines-view'
    // is separate from 'motu-view' (which controls figures-list view) so users
    // can pick independently for each screen.
    const linesView = store.get('motu-lines-view') || 'grid';
    const visibleOrdered = ordered.filter(l => !isLineFullyHidden(l.id));
    // v5.04: section header with line count on the left, view toggle on the
    // right. Matches the visual rhythm of other section headers in the app
    // (proper margin from the search bar above, consistent padding).
    html += `<div class="lines-header">
      <div class="lines-header-count">${visibleOrdered.length} ${visibleOrdered.length === 1 ? 'Line' : 'Lines'}</div>
      <div class="lines-view-toggle" role="group" aria-label="View mode">
        <button class="${linesView==='grid'?'active':''}" onclick="store.set('motu-lines-view','grid');render()" title="Grid view" aria-label="Grid view">${icon(ICO.lines,15)}</button>
        <button class="${linesView==='list'?'active':''}" onclick="store.set('motu-lines-view','list');render()" title="List view" aria-label="List view">${icon(ICO.list,15)}</button>
      </div>
    </div>`;
    if (linesView === 'list') {
      // List rows: thumb + name/year on left, progress + count + NEW badge on right
      html += '<div class="lines-list">';
      visibleOrdered.forEach(l => {
        const completeCls = l.pct === 100 ? 'complete' : '';
        let newCount = 0;
        if (S.newFigIds.size > 0) {
          for (const f of S.figs) {
            if (f.line === l.id && S.newFigIds.has(f.id)) newCount++;
          }
        }
        const newPill = newCount > 0
          ? `<span class="new-count-badge new-count-badge-subline" title="${newCount} new">${newCount} NEW</span>`
          : '';
        html += `<button class="line-row${newCount>0?' has-new':''}" onclick="goToLine('${l.id}')">
          <div class="line-row-thumb">
            <img src="${IMG}/${l.id}.jpg" alt="" onerror="this.src='${IMG}/${l.id}.png';this.onerror=function(){this.style.display='none'}" loading="lazy">
          </div>
          <div class="line-row-info">
            <div class="line-row-name font-display">${esc(l.name)}</div>
            <div class="line-row-meta">${l.yr}${l.total > 0 ? ` · ${l.owned}/${l.total} · ${l.pct}%` : ''}</div>
            ${l.total > 0 ? `<div class="line-row-progress"><div class="line-row-progress-fill ${completeCls}" style="width:${l.pct}%"></div></div>` : ''}
          </div>
          ${newPill}
          <div class="line-row-arrow">${icon(ICO.chevR,16)}</div>
        </button>`;
      });
      html += '</div>';
    } else {
      html += '<div class="lines-grid">';
      visibleOrdered.forEach(l => {
        const completeCls = l.pct === 100 ? 'complete' : '';
        // v4.91: count new figures in this line so the user can see at a glance
        // which lines have recently added figures.
        let newCount = 0;
        if (S.newFigIds.size > 0) {
          for (const f of S.figs) {
            if (f.line === l.id && S.newFigIds.has(f.id)) newCount++;
          }
        }
        const newBadge = newCount > 0
          ? `<div class="new-count-badge" title="${newCount} new figure${newCount===1?'':'s'} in this line">${newCount} NEW</div>`
          : '';
        html += `<div class="line-card${newCount > 0 ? ' has-new' : ''}" onclick="goToLine('${l.id}')">
          <img src="${IMG}/${l.id}.jpg" alt="${esc(l.name)}" onerror="this.src='${IMG}/${l.id}.png';this.onerror=function(){this.style.display='none'}" loading="lazy">
          <div class="overlay"></div>
          ${newBadge}
          <div class="card-info">
            <div class="card-name font-display">${esc(l.name)}</div>
            <div class="card-year">${l.yr}</div>
            ${l.total > 0 ? `
              <div class="progress-bar"><div class="progress-fill ${completeCls}" style="width:${l.pct}%"></div></div>
              <div class="card-stats ${completeCls}">${l.owned}/${l.total} · ${l.pct}%</div>
            ` : ''}
          </div>
        </div>`;
      });
      html += '</div>';
    }
  }
  return html;
}

function renderSublines() {
  const subs = SUBLINES[S.activeLine] || [];
  const allFigs = S.figs.filter(f => f.line === S.activeLine && !figIsHidden(f));
  const allOwned = allFigs.filter(f => S.coll[f.id]?.status === 'owned').length;
  const allPct = allFigs.length ? Math.round(allOwned/allFigs.length*100) : 0;
  // v4.91: count total new figures in this line for the "All Figures" card
  const newInLine = S.newFigIds.size
    ? allFigs.filter(f => S.newFigIds.has(f.id)).length
    : 0;

  let html = '<div class="subline-list">';
  html += `<button class="subline-card all-card${newInLine > 0 ? ' has-new' : ''}" onclick="selectSubline('__all__')">
    <div class="subline-ring">${progressRing(allPct, 48, 'var(--gold)')}</div>
    <div class="subline-info">
      <div class="subline-name">${esc(ln(S.activeLine))} — All Figures</div>
      <div class="subline-stats">${allOwned} owned of ${allFigs.length}</div>
      <div class="subline-progress"><div class="subline-progress-fill ${allPct===100?'complete':''}" style="width:${allPct}%"></div></div>
    </div>
    ${newInLine > 0 ? `<div class="new-count-badge new-count-badge-subline">${newInLine} NEW</div>` : ''}
    <div class="subline-arrow">${icon(ICO.chevR,18)}</div>
  </button>`;
  html += '<div style="height:1px;background:var(--bd);margin:0 4px"></div>';
  subs.forEach(sl => {
    const slFigs = S.figs.filter(f => f.line === S.activeLine && sl.groups.includes(f.group));
    if (!slFigs.length) return;
    const hidden = isSublineHidden(S.activeLine, sl.key);
    const visibleFigs = hidden ? [] : slFigs;
    const owned = visibleFigs.filter(f => S.coll[f.id]?.status === 'owned').length;
    const pct = visibleFigs.length ? Math.round(owned/visibleFigs.length*100) : 0;
    // v4.91: count new figures in this specific subline
    const newInSub = (!hidden && S.newFigIds.size)
      ? slFigs.filter(f => S.newFigIds.has(f.id)).length
      : 0;
    html += `<div class="subline-card${newInSub > 0 ? ' has-new' : ''}" style="${hidden?'opacity:0.4':''}" onclick="if(!event.target.closest('.hide-btn'))selectSubline('${sl.key}')">
      <div class="subline-ring">${progressRing(pct)}</div>
      <div class="subline-info">
        <div class="subline-name">${esc(sl.label)}</div>
        <div class="subline-stats">${hidden ? slFigs.length + ' figures (hidden)' : owned + ' owned of ' + slFigs.length}</div>
        ${!hidden ? `<div class="subline-progress"><div class="subline-progress-fill ${pct===100?'complete':''}" style="width:${pct}%"></div></div>` : ''}
      </div>
      ${newInSub > 0 ? `<div class="new-count-badge new-count-badge-subline">${newInSub} NEW</div>` : ''}
      <button class="hide-btn" onclick="event.stopPropagation();toggleHidden('${S.activeLine}:${sl.key}')" style="padding:4px 10px;border-radius:8px;border:1px solid ${hidden?'var(--rd)':'var(--bd)'};background:${hidden?'color-mix(in srgb, var(--rd) 10%, transparent)':'var(--bg3)'};color:${hidden?'var(--rd)':'var(--t3)'};font-size:10px;flex-shrink:0">
        ${hidden?'Show':'Hide'}
      </button>
    </div>`;
  });
  html += '</div>';
  return html;
}

const BATCH_SIZE = 80;

function renderFigRow(f) {
  const c = S.coll[f.id] || {};
  const statusCls = c.status || '';
  const hasVar = /\w/.test(copyVariant(c) || '');
  const copyN = entryCopyCount(c);
  const isNew = S.newFigIds.has(f.id);
  const hasCustom = S.customPhotos[f.id];
  const imgErr = S.imgErrors[f.id];
  const showImg = (hasCustom || f.image) && !imgErr;
  const imgSrc = (hasCustom && photoStore.get(f.id)) || f.image;
  const isSelected = S.selectMode && S.selected.has(f.id);
  const eId = esc(f.id);
  const rowClick = S.selectMode ? `toggleSelect(event,'${eId}')` : `openFig('${eId}')`;
  const checkSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
  // v6.03: subtle list-view loadout-complete tick. Shown only when:
  // status owned, loadout exists for the figure, and every copy is fully
  // complete against it. No partial signal in the row — that lives on detail.
  const loadoutTick = (() => {
    if (c.status !== 'owned' || !isMigrated(c) || !c.copies || !c.copies.length) return '';
    if (!getLoadout(f.id)) return '';
    const allComplete = c.copies.every(cp => {
      const comp = getCopyCompleteness(f.id, cp);
      return comp && comp.complete;
    });
    return allComplete ? '<span class="fig-loadout-tick" title="Loadout complete">✓</span>' : '';
  })();

  return `<div class="fig-row${isSelected ? ' selected' : ''}" data-fig-id="${eId}" onclick="${rowClick}">
    ${S.selectMode ? `<div class="select-checkbox ${isSelected ? 'checked' : ''}">${checkSvg}</div>` : ''}
    <div class="fig-thumb ${statusCls}${copyN > 1 ? ' has-stack' : ''}${copyN > 2 ? ' has-stack-3plus' : ''}">
      ${showImg && imgSrc ? `<img src="${esc(imgSrc)}" alt="" loading="lazy" onerror="imgErr('${eId}')">` :
        `<span class="initial">${esc(f.name[0])}</span>`}
    </div>
    <div class="fig-text">
      <div class="fig-name">${esc(f.name)}${copyN > 1 ? ` <span class="copy-count-inline" title="${copyN} copies">×${copyN}</span>` : ''}${loadoutTick}</div>
      <div class="fig-meta">
        ${S.search ? `<span class="line-name">${esc(ln(f.line))}</span>` : ''}
        ${f.group ? `<span>${S.search?'· ':''}${esc(f.group)}</span>` : ''}
        ${f.wave ? `<span>· W${esc(f.wave)}</span>` : ''}
        ${f.year ? `<span>· ${f.year}</span>` : ''}
      </div>
    </div>
    ${S.selectMode ? '' : `<div class="fig-actions">
      ${isNew ? '<div style="font-size:9px;font-weight:700;color:var(--acc);letter-spacing:0.5px">NEW</div>' : ''}
      ${hasVar ? '<div class="fig-var-badge">VAR</div>' : ''}
      ${c.status ? `<button class="quick-own" onclick="cycleStatus(event,'${eId}')" title="Cycle status" style="border-color:${STATUS_COLOR[c.status]}"><div class="fig-status-dot ${statusCls}"></div></button>` :
        `<button class="quick-own" onclick="event.stopPropagation();setStatus('${eId}','owned')" title="Mark owned">${icon(ICO.check,16)}</button>`}
    </div>`}
  </div>`;
}

function renderFigCard(f) {
  const c = S.coll[f.id] || {};
  const statusCls = c.status || '';
  const copyN = entryCopyCount(c);
  const isNew = S.newFigIds.has(f.id);
  const hasCustom = S.customPhotos[f.id];
  const imgErr = S.imgErrors[f.id];
  const showImg = (hasCustom || f.image) && !imgErr;
  const imgSrc = (hasCustom && photoStore.get(f.id)) || f.image;
  const eId = esc(f.id);
  const statusIcon = c.status
    ? `<div class="fig-status-dot ${statusCls}"></div>`
    : `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
  const badgeAction = c.status
    ? `cycleStatus(event,'${eId}')`
    : `event.stopPropagation();setStatus('${eId}','owned')`;

  const isSelected = S.selectMode && S.selected.has(f.id);
  const cardClick = S.selectMode ? `toggleSelect(event,'${eId}')` : `openFig('${eId}')`;
  const checkSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;

  return `<div class="fig-card ${statusCls}${isSelected ? ' selected' : ''}${copyN > 1 ? ' has-stack' : ''}${copyN > 2 ? ' has-stack-3plus' : ''}" data-fig-id="${eId}" onclick="${cardClick}">
    ${showImg && imgSrc ? `<img src="${esc(imgSrc)}" alt="" loading="lazy" onerror="imgErr('${eId}')">` :
      `<div class="card-initial">${esc(f.name[0])}</div>`}
    <div class="card-overlay"></div>
    ${S.selectMode ? `<div class="select-checkbox select-checkbox-corner ${isSelected ? 'checked' : ''}">${checkSvg}</div>` : ''}
    ${!S.selectMode && isNew ? '<div class="new-badge">NEW</div>' : ''}
    ${S.selectMode ? '' : `<button class="status-badge ${statusCls}" onclick="${badgeAction}">${statusIcon}</button>`}
    <div class="card-info">
      <div class="card-fig-name">${esc(f.name)}${copyN > 1 ? ` <span class="copy-count-inline" title="${copyN} copies">×${copyN}</span>` : ''}</div>
      <div class="card-fig-meta">${S.search ? esc(ln(f.line)) + ' · ' : ''}${f.group ? esc(f.group) : ''}${f.year ? ' · ' + f.year : ''}</div>
    </div>
  </div>`;
}

function renderFigItem(f) {
  return S.viewMode === 'grid' ? renderFigCard(f) : renderFigRow(f);
}

function yearHeader(year) {
  return `<div style="padding:12px 4px 6px;font-family:'Cinzel',serif;font-size:13px;font-weight:700;color:var(--gold);letter-spacing:1px;border-bottom:1px solid var(--bd);margin-bottom:4px">${year || 'Unknown'}</div>`;
}

function renderFigsWithHeaders(figs, renderFn) {
  const showHeaders = !S.search && (S.sortBy === 'year' || S.sortBy === 'year-desc') && S.viewMode === 'list';
  let html = '';
  let lastYear = null;
  figs.forEach(f => {
    if (showHeaders && f.year !== lastYear) {
      lastYear = f.year;
      html += yearHeader(f.year);
    }
    html += renderFn(f);
  });
  return html;
}

function renderFigList() {
  const figs = getSortedFigs();
  const hf = hasFilters();
  const isGrid = S.viewMode === 'grid';
  let html = '<div class="fig-list">';
  // Compute spent for collection tab
  let spentInfo = '';
  if (S.tab === 'collection') {
    let spent = 0, paidCount = 0;
    figs.forEach(f => {
      const c = S.coll[f.id];
      if (!c) return;
      if (isMigrated(c)) {
        for (const cp of c.copies) {
          const p = parseFloat(cp.paid);
          if (p > 0) { spent += p; paidCount++; }
        }
      } else {
        const p = parseFloat(c.paid);
        if (p > 0) { spent += p; paidCount++; }
      }
    });
    if (spent > 0) {
      const avg = (spent / paidCount).toFixed(2);
      spentInfo = ` · <span style="color:var(--gold)">$${spent.toFixed(2)} spent</span> · <span style="color:var(--t2)">$${avg} avg</span>`;
    }
  }
  // View toggle + count row
  const listActive = !isGrid ? 'active' : '';
  const gridActive = isGrid ? 'active' : '';
  html += `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-left:4px;gap:8px">
    <div class="fig-count" style="margin-bottom:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${figs.length} figure${figs.length!==1?'s':''}${S.search?' across all lines':hf?' (filtered)':''}${spentInfo}</div>
    <button class="select-btn${S.selectMode ? ' active' : ''}" onclick="${S.selectMode ? 'exitSelectMode()' : 'enterSelectMode()'}" title="Select mode">
      ${S.selectMode ? 'Done' : 'Select'}
    </button>
    <div class="view-toggle">
      <button class="${listActive}" onclick="setViewMode('list')" title="List view">${icon(ICO.list,14)}</button>
      <button class="${gridActive}" onclick="setViewMode('grid')" title="Grid view">${icon(ICO.lines,14)}</button>
    </div>
  </div>`;
  if (!figs.length) {
    // v5.01: clearer empty state on Collection tab when nothing has been
    // collected yet. Distinguish "you have nothing yet" from "your filters
    // returned nothing".
    if (S.tab === 'collection' && !S.search && !hf) {
      html += `<div class="empty-state">
        <div class="emoji">📦</div>
        <div class="title">Your collection is empty</div>
        <div class="text-sm" style="margin-bottom:16px">Start tracking figures by browsing <strong>Lines</strong> or <strong>All</strong> and tapping a status (Owned, Wishlist, Ordered, For Sale).</div>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          <button onclick="navTo('lines')" style="padding:10px 18px;border-radius:10px;border:1px solid var(--acc);background:color-mix(in srgb,var(--acc) 14%,transparent);color:var(--acc);font-size:13px;font-weight:600">Browse Lines</button>
          <button onclick="navTo('all')" style="padding:10px 18px;border-radius:10px;border:1px solid var(--bd);background:var(--bg3);color:var(--t1);font-size:13px;font-weight:600">View All Figures</button>
        </div>
      </div>`;
    } else {
      html += `<div class="empty-state"><div class="emoji">🔍</div><div class="title">No figures found</div><div class="text-sm">Try adjusting your search or filters</div></div>`;
    }
  } else {
    // v4.87: collect pinned IDs so we can exclude them from the main list.
    // Previously the "New to Catalog" and "Recently changed" sections pinned
    // the top 5, but the main list still included them, so each pinned figure
    // rendered twice.
    const pinnedIds = new Set();
    // NEW figures section — pinned at top of All tab (not collection, not search, not filtered)
    if (S.tab === 'all' && !S.search && !hf && S.newFigIds.size > 0) {
      const newFigs = figs.filter(f => S.newFigIds.has(f.id)).slice(0, 5);
      if (newFigs.length) {
        newFigs.forEach(f => pinnedIds.add(f.id));
        html += `<div style="padding:4px 4px 2px;font-size:10px;color:var(--acc);text-transform:uppercase;letter-spacing:1.5px;display:flex;align-items:center;gap:6px">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--acc);flex-shrink:0"></span>New to Catalog
        </div>`;
        if (isGrid) {
          html += '<div class="fig-grid">';
          newFigs.forEach(f => { html += renderFigCard(f); });
          html += '</div>';
        } else {
          newFigs.forEach(f => { html += renderFigRow(f); });
        }
        html += `<div style="height:1px;background:var(--bd);margin:12px 0"></div>`;
      }
    }
    // Recently changed section for collection tab
    if (S.tab === 'collection' && !S.search && !hf && S._recentChanges?.length) {
      const recent = S._recentChanges.slice(0, 5).map(id => figById(id)).filter(Boolean);
      if (recent.length) {
        recent.forEach(f => pinnedIds.add(f.id));
        html += `<div style="padding:4px 4px 2px;font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:1.5px">Recently changed</div>`;
        recent.forEach(f => { html += isGrid ? renderFigCard(f) : renderFigRow(f); });
        html += `<div style="height:1px;background:var(--bd);margin:12px 0"></div>`;
      }
    }
    // Main list — skip anything we just pinned above.
    const mainList = pinnedIds.size ? figs.filter(f => !pinnedIds.has(f.id)) : figs;
    const first = mainList.slice(0, BATCH_SIZE);
    const rest = mainList.slice(BATCH_SIZE);
    if (isGrid) {
      html += '<div class="fig-grid">';
      first.forEach(f => { html += renderFigCard(f); });
      if (rest.length) html += `<div id="figListRest" style="display:contents"></div>`;
      html += '</div>';
    } else {
      html += renderFigsWithHeaders(first, renderFigRow);
      if (rest.length) html += `<div id="figListRest"></div>`;
    }
    if (rest.length) {
      requestAnimationFrame(() => {
        const container = document.getElementById('figListRest');
        if (!container) return;
        if (isGrid) {
          container.innerHTML = rest.map(f => renderFigCard(f)).join('');
        } else {
          container.innerHTML = renderFigsWithHeaders(rest, renderFigRow);
        }
        // Bind long-press to newly rendered items
        container.querySelectorAll('[data-fig-id]').forEach(el => {
          if (!el._lpBound) { el._lpBound = true; initLongPress(el, el.dataset.figId); }
        });
      });
    }
  }
  html += '<div class="bottom-spacer"></div></div>';
  return html;
}

// § RENDER-DETAIL ── renderDetail, renderDetailStatusBlock, renderCopyCard, patchDetailStatus, renderPhotoViewer ──

// The status buttons + collection-details block. Factored out so we can swap
// just this chunk on status change without re-rendering the whole detail
// screen (which would otherwise reset scroll to the top).
function renderDetailStatusBlock(f, c) {
  const eId = esc(f.id);
  let h = `<div class="status-grid">
    <div class="label text-upper text-dim text-xs">Status</div>
    <div class="grid">`;
  STATUSES.forEach(s => {
    const active = c.status === s;
    // v5.06: per-status icon (audit recommended visual redundancy beyond
    // color). Inactive buttons show a subtle outline icon, active shows
    // the filled checkmark variant for the user's chosen status.
    const statIcon = {
      owned: ICO.check,
      wishlist: ICO.heart,
      ordered: ICO.box || ICO.cart || ICO.check,
      'for-sale': ICO.tag || ICO.dollar || ICO.check,
    }[s] || ICO.check;
    h += `<button class="status-btn ${active?'active':''}" style="--status-color:${STATUS_HEX[s]}" onclick="setStatus('${eId}','${s}');patchDetailStatus()">${icon(statIcon, 16)} ${STATUS_LABEL[s]}</button>`;
  });
  h += `</div></div>`;
  if (c.status) {
    // Owned / for-sale / wishlist / ordered all reach this branch.
    // Copies UI only renders for owned/for-sale (where you actually have
    // physical items). Ordered shows order detail fields. Wishlist is status only.
    const showsCopies = c.status === 'owned' || c.status === 'for-sale';
    if (showsCopies) {
      // Ensure we always have at least one copy slot to edit.
      const copies = (isMigrated(c) && c.copies.length) ? c.copies : [{ id: 1 }];
      const isMulti = copies.length > 1;
      h += `<div class="copies-section">
        <div class="copies-header">
          <div class="label text-upper text-dim text-xs">Collection Details${isMulti ? ` <span class="copies-count">${copies.length} copies</span>` : ''}</div>
        </div>`;
      copies.forEach((cp, i) => {
        h += renderCopyCard(f, cp, i, isMulti);
      });
      h += `<button class="add-copy-btn" onclick="addCopy('${eId}')">
        <span class="add-copy-plus">+</span> ${isMulti ? 'Add another copy' : 'Add a second copy'}
      </button>
      </div>`;
    }
    if (c.status === 'ordered') {
      h += `<div class="copies-section">
        <div class="copies-header">
          <div class="label text-upper text-dim text-xs">Order Details</div>
        </div>
        <div class="detail-fields copy-fields">
          <div>
            <div class="field-label text-dim text-sm">Ordered From</div>
            <input type="text" value="${esc(c.orderedFrom||'')}" placeholder="e.g. Walmart, Amazon, BBTS…" onchange="updateOrderedField('${eId}','orderedFrom',this.value)">
          </div>
          <div>
            <div class="field-label text-dim text-sm">Expected Date</div>
            <input type="month" value="${esc(c.orderedDate||'')}" onchange="updateOrderedField('${eId}','orderedDate',this.value)">
          </div>
          <div>
            <div class="field-label text-dim text-sm">Price Paid</div>
            <input type="number" step="0.01" value="${esc(c.orderedPaid||'')}" placeholder="$0.00" onchange="updateOrderedField('${eId}','orderedPaid',this.value)">
          </div>
        </div>
      </div>`;
    }
  }
  return h;
}

// Renders a single copy's edit card. `i` is the visual index (0-based),
// `isMulti` tells us whether to show the copy number header + delete button.
function renderCopyCard(f, cp, i, isMulti) {
  const cond = cp.condition || '';
  const paid = cp.paid || '';
  const variant = cp.variant || '';
  const notes = cp.notes || '';
  const accessories = Array.isArray(cp.accessories) ? cp.accessories : [];
  const location = cp.location || '';
  const eId = esc(f.id);
  // copyId is the stable internal id used by addCopy/removeCopy/updateCopy
  const cid = cp.id;
  let h = `<div class="copy-card" data-copy-id="${cid}">`;
  if (isMulti) {
    h += `<div class="copy-card-head">
      <div class="copy-num">Copy ${i + 1}</div>
      <button class="copy-del-btn" title="Remove this copy" onclick="removeCopy('${eId}',${cid})">${icon(ICO.trash, 14)}</button>
    </div>`;
  }
  h += `<div class="detail-fields copy-fields">
    <div>
      <div class="field-label text-dim text-sm">Condition</div>
      <select onchange="updateCopy('${eId}',${cid},'condition',this.value)">
        <option value="">Select...</option>
        ${CONDITIONS.map(x => `<option value="${esc(x)}" ${cond===x?'selected':''}>${esc(x)}</option>`).join('')}
      </select>
    </div>
    <div>
      <div class="field-label text-dim text-sm">Price Paid</div>
      <input type="number" step="0.01" value="${esc(paid)}" placeholder="$0.00" onchange="updateCopy('${eId}',${cid},'paid',this.value)">
    </div>
    <div>
      <div class="field-label text-dim text-sm">Variant</div>
      <input type="text" value="${esc(variant)}" placeholder="e.g. Dark Face, Painted Back…" onchange="updateCopy('${eId}',${cid},'variant',this.value)">
    </div>
    <div>
      <div class="field-label text-dim text-sm" style="display:flex;align-items:center;gap:8px">
        <span>Accessories</span>
        ${(() => {
          // v6.03: Loadout completeness badge. Silent when no loadout exists.
          const comp = getCopyCompleteness(f.id, cp);
          if (!comp) return '';
          if (comp.complete) return `<span class="acc-badge complete" title="All loadout items present">✓ Complete</span>`;
          return `<span class="acc-badge partial" title="${comp.have}/${comp.total} loadout items present">Missing ${comp.missing.length}</span>`;
        })()}
      </div>
      <div class="acc-chips">`;
  accessories.forEach((a, idx) => {
    h += `<span class="acc-chip"><span class="acc-chip-label">${esc(a)}</span><button class="acc-chip-x" title="Remove" onclick="removeAccessory('${eId}',${cid},${idx})">×</button></span>`;
  });
  h += `<button class="acc-add" onclick="openAccessoryPicker('${eId}',${cid})">+ Add</button>
      </div>
      ${(() => {
        // v6.03: Missing-from-loadout row. Tap a missing item to add it.
        // Hidden when complete (would be empty) or no loadout exists.
        const comp = getCopyCompleteness(f.id, cp);
        if (!comp || comp.complete || !comp.missing.length) return '';
        const items = comp.missing.map(name =>
          `<button class="acc-missing-pill" onclick="addAccessory('${eId}',${cid},${esc(JSON.stringify(name))})" title="Mark as present">+ ${esc(name)}</button>`
        ).join('');
        return `<div class="acc-missing-row">
          <span class="acc-missing-label text-dim">Missing:</span>
          ${items}
        </div>`;
      })()}
    </div>
    <div>
      <div class="field-label text-dim text-sm">Location</div>
      <input type="text" value="${esc(location)}" placeholder="e.g. Display shelf, Storage bin A, On loan…" list="locationSuggestions" onchange="updateCopy('${eId}',${cid},'location',this.value)">
    </div>
    <div>
      <div class="field-label text-dim text-sm">Notes</div>
      <textarea rows="3" placeholder="Notes…" oninput="updateCopyDebounced('${eId}',${cid},'notes',this.value)" onblur="updateCopy('${eId}',${cid},'notes',this.value)">${esc(notes)}</textarea>
    </div>`;
  // Per-copy photos (multi-copy only — single-copy uses the main carousel)
  if (isMulti) {
    const copyPhotos = photoStore.getForCopy(f.id, cid, false);  // exclude shared
    h += `<div class="copy-photos-row">
      <div class="field-label text-dim text-sm">Photos for this copy</div>
      <div class="copy-photos-strip">`;
    copyPhotos.forEach(p => {
      h += `<div class="copy-photo-thumb" onclick="openCopyPhoto('${eId}',${p.n})">
        <img src="${esc(p.url)}" alt="${esc(p.label || '')}" loading="lazy">
        <button class="copy-photo-unlink" title="Make shared" onclick="event.stopPropagation();unlinkCopyPhoto('${eId}',${p.n})">⌫</button>
      </div>`;
    });
    h += `<label class="copy-photo-add" title="Add photo to this copy">
      ${icon(ICO.img, 18)}
      <input type="file" accept="image/*" style="display:none" onchange="handleCopyPhoto(this,'${eId}',${cid})">
    </label>
    </div></div>`;
  }
  h += `</div></div>`;
  return h;
}

function patchDetailStatus() {
  if (S.screen !== 'figure' || !S.activeFig) return;
  const el = document.getElementById('detailStatusBlock');
  if (!el) return;
  const c = S.coll[S.activeFig.id] || {};
  el.innerHTML = renderDetailStatusBlock(S.activeFig, c);
  // v4.91: also refresh the location datalist. Before this fix, the datalist
  // was built once in renderDetail() and never refreshed — so a location
  // typed into copy #1 wouldn't show up as a suggestion when typing into
  // copy #2's location field until a full re-render happened.
  const dl = document.getElementById('locationSuggestions');
  if (dl) {
    dl.innerHTML = getAllLocations().map(l => `<option value="${esc(l)}"></option>`).join('');
  }
}
window.patchDetailStatus = patchDetailStatus;

function renderDetail() {
  const _ds = document.querySelector('.detail-scroll');
  const _dsScroll = _ds ? _ds.scrollTop : 0;
  const f = S.activeFig;
  const eId = esc(f.id);
  const c = S.coll[f.id] || {};
  const userPhotos = photoStore.getAll(f.id);    // [{n, url, label}, ...]
  const hasCustom = userPhotos.length > 0;
  const stockImg = (f.image && !S.imgErrors[f.id]) ? f.image : null;
  const pills = [ln(f.line), f.group, f.wave?'Wave '+f.wave:'', f.year, f.faction].filter(Boolean);
  const canAddMore = userPhotos.length < MAX_PHOTOS;
  const defaultN = S.defaultPhoto?.[f.id] ?? (hasCustom ? userPhotos[0].n : -1);

  // Build slides: user photos + stock image at end (if exists)
  const slides = [];
  userPhotos.forEach(p => slides.push({...p, stock: false}));
  if (stockImg) slides.push({n: -1, url: stockImg, label: 'Default', stock: true});

  const carouselHtml = slides.length === 0
    ? `<div class="photo-container"><span class="initial-large">${esc(f.name[0])}</span></div>`
    : `<div class="photo-carousel" id="photoCarousel">
        ${slides.map((s, si) => {
          const isDef = s.n === defaultN;
          return `
          <div class="photo-slide" onclick="openSlideViewer('${eId}',${si})">
            <img src="${esc(s.url)}" alt="${esc(s.label || f.name)}" ${s.stock ? `onerror="imgErr('${eId}')"` : ''}>
            ${s.label ? `<div class="photo-slide-label">${esc(s.label)}</div>` : ''}
            ${!s.stock ? `<button class="photo-slide-remove" onclick="event.stopPropagation();removePhoto('${eId}',${s.n})">${icon(ICO.x,14)}</button>` : ''}
            <button class="photo-slide-default${isDef ? ' active' : ''}" onclick="event.stopPropagation();setDefaultPhoto('${eId}',${s.n})" title="${isDef ? 'Primary photo' : 'Set as primary'}">★</button>
          </div>`;
        }).join('')}
      </div>
      ${slides.length > 1 ? `<div class="photo-dots">${slides.map((_,i) => `<div class="photo-dot" data-idx="${i}"></div>`).join('')}</div>` : ''}`;

  let html = `
  <div class="detail-header">
    <button class="detail-back" onclick="closeDetail()">${icon(ICO.back,22)}</button>
    <div class="detail-title">${esc(f.name)}</div>
  </div>
  <div class="detail-scroll">
    <div class="photo-section">
      ${carouselHtml}
      <div class="photo-controls">
        ${canAddMore ? `<button class="photo-btn" onclick="document.getElementById('photoInput').click()">
          ${icon(ICO.plus,14)} Add photo${userPhotos.length > 0 ? ` (${userPhotos.length}/${MAX_PHOTOS})` : ''}
        </button>` : `<div class="photo-btn" style="opacity:0.5;cursor:default">Max ${MAX_PHOTOS} photos</div>`}
      </div>
      <input type="file" id="photoInput" accept="image/*" capture="environment" style="display:none" onchange="handlePhoto(this,'${eId}')">
    </div>
    ${userPhotos.length > 0 ? `<div class="photo-labels">
      ${userPhotos.map(p => `
        <div class="photo-label-row">
          <span class="photo-label-num">#${userPhotos.indexOf(p)+1}</span>
          <input type="text" placeholder="Label (optional) — e.g. UPC, Back, Loose" value="${esc(p.label)}"
                 onblur="setPhotoLabel('${eId}',${p.n},this.value)" maxlength="20">
        </div>
      `).join('')}
    </div>` : ''}
    <div class="detail-pills">${pills.map(p => `<span class="pill">${esc(p)}</span>`).join('')}</div>
    ${f.retail ? `<div class="detail-retail">Retail: <span class="price">$${f.retail.toFixed(2)}</span></div>` : ''}
    <div style="padding:0 16px 12px;display:flex;gap:8px;flex-wrap:wrap">
      ${(f.line !== 'kids-core' && f.line !== 'custom') ? `<a href="#" onclick="event.preventDefault();openAF411('${eId}')" style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:12px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);color:var(--t2);font-size:13px;font-weight:500;text-decoration:none">
        ${icon(ICO.export,14)} View on AF411
      </a>` : ''}
      <button onclick="searchCharacter('${esc(f.name)}')" style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:12px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);color:var(--t2);font-size:13px;font-weight:500">
        ${icon(ICO.search,14)} All versions
      </button>
      <button onclick="openFigureEditor('${eId}')" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:12px 16px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);color:var(--t2);font-size:13px;font-weight:500">
        ${icon(ICO.edit,14)} Edit
      </button>
    </div>
    <div id="detailStatusBlock">${renderDetailStatusBlock(f, c)}</div>
    <datalist id="locationSuggestions">
      ${getAllLocations().map(l => `<option value="${esc(l)}"></option>`).join('')}
    </datalist>
    <div class="detail-spacer"></div>
  </div>`;
  if (S.photoViewer) html += renderPhotoViewer();
  if (S.sheet) html += renderSheet();
  app().innerHTML = html;

  // Re-apply visible class to sheet overlay (innerHTML wipes it)
  if (S.sheet) {
    const el = document.getElementById('sheetOverlay');
    if (el) requestAnimationFrame(() => el.classList.add('visible'));
  }

  // Restore detail scroll position (lost when innerHTML rebuilds on edit sheet open/close)
  if (_dsScroll > 0) {
    const newDs = document.querySelector('.detail-scroll');
    if (newDs) newDs.scrollTop = _dsScroll;
  }

  // Init pinch-to-zoom on photo viewer if open
  initPhotoViewerZoom();

  // Wire up carousel dot indicator
  const carousel = document.getElementById('photoCarousel');
  if (carousel) {
    const dots = document.querySelectorAll('.photo-dot');
    if (dots.length) {
      const updateDots = () => {
        const idx = Math.round(carousel.scrollLeft / carousel.clientWidth);
        dots.forEach((d, i) => d.classList.toggle('active', i === idx));
      };
      updateDots();
      carousel.addEventListener('scroll', updateDots, {passive: true});
    }
  }
}

function renderPhotoViewer() {
  const v = S.photoViewer;
  if (!v || !v.photos.length) return '';
  const p = v.photos[v.idx];
  const multi = v.photos.length > 1;
  return `<div class="photo-viewer" onclick="if(event.target===this)closePhotoViewer()">
    <button class="photo-viewer-close" onclick="closePhotoViewer()">${icon(ICO.x,28)}</button>
    ${multi ? `<button class="photo-viewer-nav prev" onclick="event.stopPropagation();photoViewerNav(-1)">${icon(ICO.back,28)}</button>` : ''}
    <div class="photo-viewer-img-wrap" onclick="event.stopPropagation()">
      <img src="${esc(p.url)}" alt="${esc(p.label || '')}">
      ${p.label ? `<div class="photo-viewer-label">${esc(p.label)}</div>` : ''}
      ${multi ? `<div class="photo-viewer-counter">${v.idx + 1} / ${v.photos.length}</div>` : ''}
    </div>
    ${multi ? `<button class="photo-viewer-nav next" onclick="event.stopPropagation();photoViewerNav(1)">${icon(ICO.chevR,28)}</button>` : ''}
  </div>`;
}

// ── Exports ─────────────────────────────────────────────────
export {
  toast, haptic, appConfirm, triggerPulse, toastUndo, toastAction, showUpdateBanner, patchFigRow, updateNavBadge, render, renderLoading, renderMain, renderSelectActionbar, renderNavBtn, renderBreadcrumb, renderKidsCoreAdminSheet, renderContent, renderStatsSheet, buildShareURL, decodeShareURL, renderQR, renderShareSheet, SHORTCUT_ACTIONS, checkShortcutAction, checkShareLink, renderWantListViewSheet, renderLinesGrid, renderSublines, renderFigRow, renderFigCard, renderFigItem, yearHeader, renderFigsWithHeaders, renderFigList, renderDetailStatusBlock, renderCopyCard, patchDetailStatus, renderDetail, renderPhotoViewer
};
