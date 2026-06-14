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
  ln, normalize, esc, jsArg, isSelecting, _clone, getThemeTitles,
} from './state.js';
import {
  MAX_PHOTOS, photoStore, photoURLs, photoCopyOf,
  initPhotoViewerZoom,
} from './photos.js';
import {
  figById, figVariants, figIsHidden, getPrimaryCopy, copyVariant, copyCondition,
  copyPaid, copyNotes, entryCopyCount, totalCopyCount,
  getStats, getSortedFigs, getLineStats, hasFilters, progressRing,
  isLineFullyHidden, isSublineHidden, getOrderedSublines, getAllLocations,
  PER_COPY_FIELDS, getOverrideField, getAccAvail,
  getLoadout, getCopyCompleteness,
  buildFigIndexes, LINE_ID_MAP, SETTINGS_KEYS,
  isMigrated, saveColl, fetchFigs,
  getSoldLog, backupDue,
} from './data.js';
import {
  playSound, preloadSound, getThemeIcon, getThemeSounds,
} from './eggs.js';
import { initLongPress, pushNav } from './handlers.js';
import { renderSheet } from './ui-sheets.js';
import { renderMarketValueBlock, getCachedAskingPrice, isPricingConfigured, fetchPricing, renderSparkline } from './pricing.js';

// § TOAST-HAPTIC ── toast, toastUndo, undoStatus, haptic, showUpdateBanner, triggerPulse ──
// v6.04: container caps live toasts at 3. Any new toast trims the oldest
// (FIFO) so a rapid sequence of status changes doesn't flood the screen.
const MAX_TOASTS = 3;
function getToastContainer() {
  let c = document.getElementById('toastContainer');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toastContainer';
    c.className = 'toast-container';
    // v6.27: a11y — toasts are status messages, announce politely to screen
    // readers without stealing focus.
    c.setAttribute('role', 'status');
    c.setAttribute('aria-live', 'polite');
    c.setAttribute('aria-atomic', 'false');
    document.body.appendChild(c);
  }
  // Trim oldest until we're below the cap (caller is about to append one more).
  while (c.children.length >= MAX_TOASTS) {
    c.removeChild(c.firstChild);
  }
  return c;
}
// v6.04: opts.large bumps font/padding for high-priority messages like
// "Press back again to exit". opts.persist disables the auto-fade animation
// so action toasts (Undo) don't visually disappear before the timeout ends.
function toast(msg, opts = {}) {
  const container = getToastContainer();
  const el = document.createElement('div');
  el.className = 'toast' + (opts.large ? ' large' : '') + (opts.persist ? ' persist' : '');
  el.textContent = msg;
  // v6.27: tap to dismiss. Plain toasts had no early-out — three rapid status
  // changes left toasts on screen for 4s each even after the user moved on.
  el.addEventListener('click', () => { if (el.parentNode) el.remove(); });
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, opts.duration || 4000);
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
    // v6.70: top-anchored (was bottom sheet) — the on-screen keyboard was
    // covering the input on Android, hiding what the user typed.
    overlay.style.cssText = 'position:fixed;inset:0;z-index:600;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;padding-top:max(48px, 10vh)';
    overlay.innerHTML = `
      <div style="width:100%;max-width:480px;background:var(--bg2);border-radius:16px;margin:0 16px;padding:22px 20px 16px;box-shadow:0 8px 32px rgba(0,0,0,.5)">
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

// v6.66: text-input sibling of appConfirm. Resolves with the entered string,
// or null on cancel. Used by Add Variant; generic enough for future prompts.
function appPromptText(message, {placeholder = '', ok = 'OK', cancel = 'Cancel', value = ''} = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:600;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;padding-bottom:calc(16px + var(--safe-bottom,0px))';
    overlay.innerHTML = `
      <div style="width:100%;max-width:480px;background:var(--bg2);border-radius:20px 20px 16px 16px;padding:22px 20px 12px;box-shadow:0 -4px 32px rgba(0,0,0,.4)">
        <div style="font-size:15px;color:var(--t1);line-height:1.5;margin-bottom:14px;text-align:center">${esc(message)}</div>
        <input id="appPromptInput" type="text" placeholder="${esc(placeholder)}" value="${esc(value)}" maxlength="40"
               style="width:100%;box-sizing:border-box;padding:12px 14px;margin-bottom:16px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);color:var(--t1);font-size:15px">
        <div style="display:flex;gap:10px">
          <button id="appPromptCancel" style="flex:1;padding:14px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);color:var(--t2);font-size:15px;font-weight:600">${esc(cancel)}</button>
          <button id="appPromptOk" style="flex:1;padding:14px;border-radius:12px;border:none;background:var(--acc);color:#fff;font-size:15px;font-weight:700">${esc(ok)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#appPromptInput');
    const finish = result => {
      overlay.querySelector('#appPromptOk').disabled = true;
      overlay.querySelector('#appPromptCancel').disabled = true;
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector('#appPromptOk').addEventListener('click', () => finish(input.value));
    overlay.querySelector('#appPromptCancel').addEventListener('click', () => finish(null));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(input.value); });
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
    setTimeout(() => input.focus(), 60);
  });
}

// ─── Status Pulse Animation ──────────────────────────────────────
function triggerPulse(id, status) {
  requestAnimationFrame(() => {
    const badge = document.querySelector(`.fig-card[data-fig-id="${id}"] .card-status-btn`) ||
                  document.querySelector(`.fig-card[data-fig-id="${id}"] .status-badge`) ||
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
  // v6.04: 'persist' suppresses the 2s fade-out animation. Action toasts
  // run for 5.5s; without persist they were visually gone at 2s but still
  // technically clickable — confusing for users who reach for "Undo" or
  // the suggested action and find nothing there.
  el.className = 'toast has-undo persist';
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
// and handler are caller-supplied. v6.04: now uses 'persist' class so the
// toast stays visible the full 5.5s instead of fading at 2s. Currently
// retained for any caller that wants confirm-before-action UX; the loadout
// completeness path now auto-applies and uses a plain toast() instead.
function toastAction(msg, btnLabel, handler) {
  const container = getToastContainer();
  const el = document.createElement('div');
  el.className = 'toast has-undo persist';
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
  window.cancelLongPress?.();  // v6.73: see render() — same mid-touch rebuild hazard
  const c = S.coll[id] || {};
  const statusCls = c.status || '';
  const copyN = entryCopyCount(c);
  const eId = esc(id);
  const jId = jsArg(id);
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
      thumb.className = cls.trim();
    }
    updateNameInline(row.querySelector('.fig-name'));
    const actions = row.querySelector('.fig-actions');
    if (actions) {
      const isNew = S.newFigIds.has(id);
      // v6.70: VAR badge retired — variant info now lives in the nested
      // row/strip presentation, not a per-copy free-text flag.
      actions.innerHTML =
        (isNew ? '<div style="font-size:9px;font-weight:700;color:var(--acc);letter-spacing:0.5px">NEW</div>' : '') +
        (c.status
          ? `<button class="quick-own" onclick="cycleStatus(event,${jId})" title="Cycle status" style="border-color:${STATUS_COLOR[c.status]}"><div class="fig-status-dot ${statusCls}"></div></button>`
          : `<button class="quick-own" onclick="event.stopPropagation();setStatus(${jId},'owned')" title="Mark owned">${icon(ICO.check,16)}</button>`);
    }
    updateNavBadge();
    return true;
  }

  // Try grid view card
  const card = document.querySelector(`.fig-card[data-fig-id="${id}"]`);
  if (card) {
    let cardCls = 'fig-card ' + statusCls;
    if (copyN > 1) cardCls += ' has-stack';
    // No has-stack-3plus on cards — all multi-copy uses standard 2-layer stack
    card.className = cardCls.trim();
    updateNameInline(card.querySelector('.card-fig-name'));
    const badge = card.querySelector('.card-status-btn') || card.querySelector('.status-badge');
    if (badge) {
      badge.className = (badge.classList.contains('card-status-btn') ? 'card-status-btn' : 'status-badge') + ' ' + statusCls;
      const badgeAction = c.status
        ? `cycleStatus(event,${jId})`
        : `event.stopPropagation();setStatus(${jId},'owned')`;
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
  // v6.73: a rebuild mid-touch orphans the long-press cancel path — see
  // cancelLongPress in handlers.js. Clearing here is always safe: any
  // legitimate long-press has no render between touchstart and fire.
  window.cancelLongPress?.();
  try {
    // v5.04: stagger animation gate. Only fires when render is preceded by
    // navigation (tab change, line change, search clear, etc.) — NOT when
    // a status toggle or in-place patch triggers a render. Without this,
    // every status tap re-plays the entrance animation, which is annoying.
    if (S._justNavigated) {
      app().setAttribute('data-stagger', '1');
      // v6.24: reverse stagger — bottom items animate first.
      // v6.25: cap at STAGGER_CAP so long lists (All/Collection tabs) don't
      // make top items wait seconds. Items beyond the cap share the max delay
      // so the wave still reads as bottom-up without growing unboundedly.
      requestAnimationFrame(() => {
        const STAGGER_CAP = 11;
        const nodes = [...(app().querySelectorAll('.fig-row,.fig-card,.line-card,.line-row,.subline-card'))];
        const last = nodes.length - 1;
        nodes.forEach((el, i) => {
          const idx = Math.min(last - i, STAGGER_CAP);
          el.style.setProperty('--stagger-i', idx);
        });
      });
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
          <button class="retry-btn" data-action="retry-fetch">Retry</button>
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
  // and NOT when returning from detail screen (its scrollTop is the figure
  // detail's scroll position, not the list's — savedScroll handles that case).
  const _prevCa = document.getElementById('contentArea');
  const _returningFromDetail = !!S._returningFromDetail;
  if (_returningFromDetail) S._returningFromDetail = false;
  // v6.57: scope-aware scroll preservation. The old logic preserved scrollTop
  // across ANY re-render that wasn't sheet-open or detail-return. But when the
  // list scope changes (lines → subline → all → collection, or activeLine
  // switches), the contentArea is showing different items even though the DOM
  // element is the same — restoring the previous scrollTop dumps the user
  // somewhere unrelated. We only preserve scroll when the scope key matches.
  const _listKey = S.screen + '|' + (S.tab || '') + '|' + (S.activeLine || '') + '|' + (S.activeSubline || '');
  const _prevListKey = S._lastListKey || '';
  const _scopeMatches = _listKey === _prevListKey;
  S._lastListKey = _listKey;
  const _preservedScroll = (!S.sheet && _prevCa && !_returningFromDetail && _scopeMatches) ? _prevCa.scrollTop : 0;

  const stats = getStats();
  const sortLabel = S.sortBy === 'added-desc' ? 'Added' : S.sortBy.includes('year') ? 'Year' : S.sortBy === 'wave' ? 'Wave' : S.sortBy.includes('name') ? 'Name' : 'Price';
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
  ${store.isBroken && store.isBroken() && !S.storageDismissed ? `
  <div class="storage-banner" role="alert">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
    <span style="flex:1">Storage unavailable — your changes won't persist after closing the app. Common in private/incognito browsing.</span>
    <button data-action="dismiss-storage-banner" aria-label="Dismiss">×</button>
  </div>` : ''}
  <div class="top-bar" id="topBar">
    <div class="header-row">
      <div class="logo-group">
        <img src="${themeIcon}" alt="" class="logo-icon" onclick="homeIconClick()" style="cursor:pointer">
        <div>
          <div class="logo-title font-display text-gold" onclick="${titleClick}" style="cursor:pointer;user-select:none">${themeTitles[S.titleIdx % themeTitles.length]}</div>
          <div class="logo-subtitle text-dim text-upper">${stats.total} Figures · ${stats.owned} Owned · <span class="text-gold" style="text-transform:none">v6.84</span></div>
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
        <input id="searchInput" value="${esc(S.search)}" placeholder="${S.activeLine ? 'Search '+ln(S.activeLine)+'…' : 'Search figures…'}" oninput="onSearch(this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        ${S.search ? `<button class="search-clear" data-action="clear-search">${icon(ICO.x,14)}</button>` : ''}
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
  } else {
    // Explicitly clear — covers the back-button case where S.barsHidden was
    // reset to false in popstate but the CSS class persisted across the render.
    if (tb) tb.classList.remove('immersive-hide');
    if (bn) bn.classList.remove('immersive-hide');
    const sb2 = document.getElementById('searchBar');
    if (sb2 && !S.searchBarHidden) sb2.classList.remove('hidden');
  }

  // Restore scroll — savedScroll from fig nav takes priority; else preserve across renders
  if (ca) {
    const maxScroll = Math.max(0, ca.scrollHeight - ca.clientHeight);
    if (S.savedScroll && S.screen === 'main') {
      ca.scrollTop = Math.min(S.savedScroll, maxScroll);
      S.savedScroll = 0;
      // v6.40: after swiping through figures, scroll the list to the last
      // viewed figure and briefly highlight it so the user knows where they are.
      if (S._lastDetailFigId) {
        const figId = S._lastDetailFigId;
        S._lastDetailFigId = null;
        requestAnimationFrame(() => {
          const figEl = ca.querySelector(`[data-fig-id="${CSS.escape(figId)}"]`);
          if (!figEl) return;
          figEl.scrollIntoView({ block: 'nearest' });
          figEl.classList.add('fig-return-highlight');
          setTimeout(() => figEl.classList.remove('fig-return-highlight'), 1600);
        });
      }
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
      const now = Date.now();
      // v6.33: lock raised from 200ms to 380ms to match the topBar's CSS
      // transition duration. Previously the unlock fired before the
      // transform finished, and any tiny upward inertia bounce
      // (delta < -8) re-showed the bar mid-hide. Result was a visible
      // oscillation when the user started scrolling on All / Collection.
      // The down-threshold is also raised from 1px to 6px so the hide
      // requires a deliberate downward gesture, not finger-jitter.
      if (now - _lastToggleTs < 380) {
        _scheduleIdleShow();
        return;
      }
      // Scroll down: hide on a committed downward movement (>=6px) and
      // only after the user has scrolled past the topBar height. Below
      // that, the bar staying visible is the right answer anyway.
      if (delta > 6 && st > 60 && !S.barsHidden) {
        tb.classList.add('immersive-hide');
        bn.classList.add('immersive-hide');
        if (sb) { sb.classList.add('hidden'); S.searchBarHidden = true; }
        S.barsHidden = true;
        _lastToggleTs = now;
      // Scroll up: require 12px to filter held-finger micro-jitter and
      // the natural inertia bounce-back that happens right after hide.
      } else if ((delta < -12 || st < 20) && S.barsHidden) {
        tb.classList.remove('immersive-hide');
        bn.classList.remove('immersive-hide');
        if (sb) { sb.classList.remove('hidden'); S.searchBarHidden = false; }
        S.barsHidden = false;
        _lastToggleTs = now;
      }
      _scheduleIdleShow();
    };
    // Idle show: bars reappear 2.5s after scrolling stops or any screen activity.
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
      }, 2500);
    }
    ca._bumpIdleTimer = _scheduleIdleShow;
    ca.addEventListener('scroll', ca._scrollHandler, {passive: true});

    // v6.22: bump the idle-show timer on user interactions other than scroll.
    // Without this, tapping a status or invoking the long-press menu while
    // bars are hidden would still fire the 3.5s timer mid-action, popping
    // the bars back in unexpectedly. click covers taps; contextmenu is what
    // the long-press handler dispatches.
    ca._bumpHandler && ca.removeEventListener('click', ca._bumpHandler);
    ca._bumpHandler && ca.removeEventListener('contextmenu', ca._bumpHandler);
    ca._bumpHandler = () => { if (ca._bumpIdleTimer) ca._bumpIdleTimer(); };
    ca.addEventListener('click', ca._bumpHandler, {passive: true, capture: true});
    ca.addEventListener('contextmenu', ca._bumpHandler, {passive: true, capture: true});

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
  // v6.28: show "Photos" delete affordance only if at least one selected
  // figure actually has user photos. Avoids cluttering the bar otherwise.
  let anySelectedHasPhotos = false;
  for (const id of S.selected) {
    if ((S.customPhotos[id] || []).length) { anySelectedHasPhotos = true; break; }
  }
  return `<div class="select-actionbar visible">
    <div class="sa-row">
      <span class="count">${n}</span>
      <button onclick="selectAllVisible()" title="${allSelected ? 'Deselect all' : 'Select all'}">
        ${allSelected ? 'None' : 'All'}
      </button>
      <button class="primary" ${dis} onclick="openBatchEditor()" style="flex:1">
        ${icon(ICO.edit, 14)} Add Copy…
      </button>
      ${anySelectedHasPhotos ? `<button onclick="batchDeletePhotos()" title="Remove user photos from selected"
        style="padding:9px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--rd) 35%,var(--bd));background:color-mix(in srgb,var(--rd) 6%,var(--bg3));color:var(--rd);font-size:12px;font-weight:600;flex-shrink:0">
        ${icon(ICO.trash,12)} Photos
      </button>` : ''}
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
  return `<button class="${active?'active':''}" data-action="nav-to" data-target="${esc(key)}">${showIcon ? icon(ico,14,active?2.5:1.5) : ''}${label}${extra}</button>`;
}

function renderBreadcrumb() {
  let html = '<div class="breadcrumb">';
  // v4.91: "Lines" and the line-name crumb now use explicit state-setting
  // handlers instead of relying on history.back(). When there's no subline
  // active, the line name is also made tappable (goes to the same place as
  // "Lines" — the main lines grid — matching user expectation from the
  // feedback: "clicking lines should take you back to the main lines").
  html += `<button class="crumb-link" data-action="crumb-to-lines">${icon(ICO.back,14)} Lines</button><span class="sep">›</span>`;
  if (S.activeSubline) {
    html += `<button class="crumb-link" data-action="crumb-to-line">${esc(ln(S.activeLine))}</button><span class="sep">›</span>`;
    const slLabel = S.activeSubline === '__all__' ? 'All Figures' : getOrderedSublines(S.activeLine).find(s=>s.key===S.activeSubline)?.label || '';
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
    h += `<button onclick="deleteKidsCoreAdminFig(${jsArg(editing)})" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--rd);background:color-mix(in srgb,var(--rd) 10%,transparent);color:var(--rd);font-size:14px;font-weight:600">
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
        <button onclick="S._kcEditId=${jsArg(f.id)};S._kcForm=null;render()" style="padding:5px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--bg3);color:var(--t2);font-size:12px">Edit</button>
      </div>`;
    });
    h += '</div>';
  }

  return h;
}

function renderContent() {
  if (S.tab === 'lines' && !S.activeLine) return renderLinesGrid();
  if (!S.search && S.activeLine && !S.activeSubline && getOrderedSublines(S.activeLine).length) return renderSublines();
  return renderFigList();
}

// (Collection Stats sheet extracted to stats.js — v6.80)

// (Want-List share / QR / trade-list layer extracted to share.js — v6.81)

// § RENDER-LISTS ── renderLinesGrid, renderSublines, renderFigRow, renderFigCard, renderFigList ──
// v4.86: restored missing `function renderLinesGrid() {` declaration (orphan
// body, same pattern as getLineStats / exportCSV).
function renderLinesGrid() {
  const lineStats = getLineStats();
  const ordered = [...S.lineOrder].map(id => lineStats.find(l => l.id === id)).filter(Boolean)
    .concat(lineStats.filter(l => !S.lineOrder.includes(l.id)));

  let html = '';
  if (!S.onboarded) {
    // v7.00: show the tour button on every render so users who skipped
    // or completed can replay. Label switches between Take / Replay
    // based on tour state read via window.tutorialState() (exposed
    // from tutorial.js).
    const tState = (typeof window.tutorialState === 'function') ? window.tutorialState() : { seen: false };
    const tourLabel = tState.seen ? '🎓 Replay tour' : '🎓 Take a 1-minute tour';
    html += `<div class="onboard-banner">
      <div style="flex:1;position:relative;z-index:1">👋 <strong style="color:var(--t1)">Getting started:</strong> Tap a line below to browse its figures. Tap any figure to mark it Owned, Wishlist, or For Sale — it'll appear in your Collection tab.<br><button onclick="startTutorial()" style="margin-top:10px;background:var(--acc);color:var(--bg);border:none;padding:7px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer">${tourLabel}</button></div>
      <img class="onboard-mascot" src="${IMG}/he-man-icon.png" alt="" aria-hidden="true" onerror="this.style.display='none'">
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
        <button class="${linesView==='list'?'active':''}" onclick="store.set('motu-lines-view','list');render()" title="List view" aria-label="List view">${icon(ICO.list,15)}</button>
        <button class="${linesView==='grid'?'active':''}" onclick="store.set('motu-lines-view','grid');render()" title="Grid view" aria-label="Grid view">${icon(ICO.lines,15)}</button>
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
        html += `<button class="line-row${newCount>0?' has-new':''}" data-action="go-to-line" data-line-id="${esc(l.id)}">
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
        html += `<div class="line-card${newCount > 0 ? ' has-new' : ''}" data-action="go-to-line" data-line-id="${esc(l.id)}">
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
  const subs = getOrderedSublines(S.activeLine);
  const allFigs = S.figs.filter(f => f.line === S.activeLine && !figIsHidden(f));
  const allOwned = allFigs.filter(f => S.coll[f.id]?.status === 'owned').length;
  const allPct = allFigs.length ? Math.round(allOwned/allFigs.length*100) : 0;
  // v4.91: count total new figures in this line for the "All Figures" card
  const newInLine = S.newFigIds.size
    ? allFigs.filter(f => S.newFigIds.has(f.id)).length
    : 0;

  let html = '<div class="subline-list">';
  html += `<button class="subline-card all-card${newInLine > 0 ? ' has-new' : ''}" data-action="select-subline" data-subline="__all__">
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
    // v6.29: Hide button uses its own data-action with stopPropagation in
    // the handler. Previously the outer card had an inline closest('.hide-btn')
    // guard; the delegation pattern handles this naturally because the inner
    // button matches its own data-action selector first via closest().
    html += `<div class="subline-card${newInSub > 0 ? ' has-new' : ''}" style="${hidden?'opacity:0.4':''}" data-action="select-subline" data-subline="${esc(sl.key)}">
      <div class="subline-ring">${progressRing(pct)}</div>
      <div class="subline-info">
        <div class="subline-name">${esc(sl.label)}</div>
        <div class="subline-stats">${hidden ? slFigs.length + ' figures (hidden)' : owned + ' owned of ' + slFigs.length}</div>
        ${!hidden ? `<div class="subline-progress"><div class="subline-progress-fill ${pct===100?'complete':''}" style="width:${pct}%"></div></div>` : ''}
      </div>
      ${newInSub > 0 ? `<div class="new-count-badge new-count-badge-subline">${newInSub} NEW</div>` : ''}
      <button class="hide-btn" data-action="toggle-subline-hidden" data-line-id="${esc(S.activeLine)}" data-subline="${esc(sl.key)}" style="padding:4px 10px;border-radius:8px;border:1px solid ${hidden?'var(--rd)':'var(--bd)'};background:${hidden?'color-mix(in srgb, var(--rd) 10%, transparent)':'var(--bg3)'};color:${hidden?'var(--rd)':'var(--t3)'};font-size:10px;flex-shrink:0">
        ${hidden?'Show':'Hide'}
      </button>
    </div>`;
  });
  html += '</div>';
  return html;
}

const BATCH_SIZE = 80;

function renderFigRow(f, standalone = false) {
  const c = S.coll[f.id] || {};
  const statusCls = c.status || '';
  const copyN = entryCopyCount(c);
  const isNew = S.newFigIds.has(f.id);
  const hasCustom = S.customPhotos[f.id];
  const imgErr = S.imgErrors[f.id];
  const showImg = (hasCustom || f.image) && !imgErr;
  const imgSrc = (hasCustom && photoStore.get(f.id)) || f.image;
  const isSelected = S.selectMode && S.selected.has(f.id);
  const eId = esc(f.id);
  // v6.29: row click goes through delegation now. The dispatcher decides
  // open-fig vs select-toggle based on S.selectMode at click time, so we
  // no longer need to compute the action string at render time and risk
  // the row being stuck on whichever action mode existed at last render.
  const rowAction = S.selectMode ? 'select-toggle' : 'open-fig';
  const checkSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
  // v6.03: subtle list-view loadout-complete tick.
  // v6.37: extended to a 3-state indicator (was binary). Owned + has-loadout:
  //   complete   → green ✓
  //   incomplete → gold "N!" badge with the worst copy's missing-required count
  //   (not owned / no loadout) → no indicator (current behavior)
  // For multi-copy figures we report the WORST copy's deficit so collectors
  // looking to complete a loose still see the indicator even when their MIB
  // satisfies the loadout. Per user instruction.
  const loadoutTick = (() => {
    if (c.status !== 'owned' || !isMigrated(c) || !c.copies || !c.copies.length) return '';
    if (!getLoadout(f.id)) return '';
    let worst = 0;
    let allComplete = true;
    for (const cp of c.copies) {
      const comp = getCopyCompleteness(f.id, cp);
      if (!comp) continue;
      if (!comp.complete) allComplete = false;
      const miss = (comp.missingRequired || []).length;
      if (miss > worst) worst = miss;
    }
    if (allComplete) {
      return '<span class="fig-loadout-tick" title="Loadout complete">✓</span>';
    }
    if (worst > 0) {
      const label = worst > 9 ? '9+' : String(worst);
      return `<span class="fig-loadout-tick incomplete" title="${worst} missing accessor${worst===1?'y':'ies'}">${label}!</span>`;
    }
    return '';
  })();

  return `<div class="fig-row${isSelected ? ' selected' : ''}${f.variantOf && !standalone ? ' variant-nested' : ''}" data-fig-id="${eId}" data-action="${rowAction}">
    ${S.selectMode ? `<div class="select-checkbox ${isSelected ? 'checked' : ''}">${checkSvg}</div>` : ''}
    <div class="fig-thumb ${statusCls}${copyN > 1 ? ' has-stack' : ''}">
      ${showImg && imgSrc ? `<img src="${esc(imgSrc)}" alt="" loading="lazy" data-error-action="img-error" data-fig-id="${eId}">` :
        `<span class="initial">${esc(f.name[0])}</span>`}
    </div>
    <div class="fig-text">
      <div class="fig-name">${esc(f.name)}${copyN > 1 ? ` <span class="copy-count-inline" title="${copyN} copies">×${copyN}</span>` : ''}${(() => {
        // v6.70: variant rows carry no extra chip — the connector + name
        // (which already includes the variant) say it all. Parents keep ⧉N.
        if (f.variantOf) return '';
        const n = figVariants(f.id).length;
        return n ? ` <span class="variant-count-inline" title="${n} variant${n===1?'':'s'}">⧉${n}</span>` : '';
      })()}${loadoutTick}</div>
      <div class="fig-meta">
        ${S.search ? `<span class="line-name">${esc(ln(f.line))}</span>` : ''}
        ${f.group ? `<span>${S.search?'· ':''}${esc(f.group)}</span>` : ''}
        ${f.wave ? `<span>· W${esc(f.wave)}</span>` : ''}
        ${f.year ? `<span>· ${f.year}</span>` : ''}
      </div>
      ${(() => {
        // v6.77: variant chips list ONLY the variants — the "Standard" pill
        // was redundant with the parent row itself and its right-side dot.
        // The parent keeps its normal circular status toggle (restored
        // below); chips are pure secondary tags for the sub-variants.
        if (f.variantOf) return '';  // variants don't render as their own rows
        const vars = figVariants(f.id);
        if (!vars.length) return '';
        const chip = (m) => {
          const st = S.coll[m.id]?.status;
          const cls = st === 'owned' ? ' owned' : st === 'for-sale' ? ' for-sale' : '';
          return `<button class="variant-chip-pill${cls}" data-action="open-fig" data-fig-id="${esc(m.id)}" title="${esc(m.name)}">${esc(m.variantName || m.name)}</button>`;
        };
        return `<div class="variant-chip-row">${vars.map(chip).join('')}</div>`;
      })()}
    </div>
    ${S.selectMode ? '' : `<div class="fig-actions">
      ${isNew ? '<div style="font-size:9px;font-weight:700;color:var(--acc);letter-spacing:0.5px">NEW</div>' : ''}
      ${isWishDeal(f) ? '<div class="fig-deal-badge" title="At or below your target price">DEAL</div>' : ''}
      ${c.status ? `<button class="quick-own" data-action="cycle-status" data-fig-id="${eId}" title="Cycle status" style="border-color:${STATUS_COLOR[c.status]}"><div class="fig-status-dot ${statusCls}"></div></button>` :
        `<button class="quick-own" data-action="set-status-owned" data-fig-id="${eId}" title="Mark owned">${icon(ICO.check,16)}</button>`}
    </div>`}
  </div>`;
}

// v6.69: price-watch deal check (cache-only, no network). True when a
// wishlist/ordered figure's cached asking is at or below its target price.
function isWishDeal(f) {
  const c = S.coll[f.id];
  if (!c || (c.status !== 'wishlist' && c.status !== 'ordered')) return false;
  const t = parseFloat(c.targetPrice);
  if (!Number.isFinite(t)) return false;
  const a = getCachedAskingPrice(f);
  return a != null && a <= t;
}

function renderFigCard(f, standalone = false) {
  const c = S.coll[f.id] || {};
  const statusCls = c.status || '';
  const copyN = entryCopyCount(c);
  const isNew = S.newFigIds.has(f.id);
  const hasCustom = S.customPhotos[f.id];
  const imgErr = S.imgErrors[f.id];
  const showImg = (hasCustom || f.image) && !imgErr;
  const imgSrc = (hasCustom && photoStore.get(f.id)) || f.image;
  const eId = esc(f.id);
  const badgeAction = c.status ? 'cycle-status' : 'set-status-owned';
  const isSelected = S.selectMode && S.selected.has(f.id);
  const cardAction = S.selectMode ? 'select-toggle' : 'open-fig';
  const checkSvg = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;

  // Missing accessories indicator — orange to distinguish from gold copy-count
  const missingAcc = (() => {
    if (c.status !== 'owned' || !isMigrated(c) || !c.copies?.length) return '';
    if (!getLoadout(f.id)) return '';
    let worst = 0, allComplete = true;
    for (const cp of c.copies) {
      const comp = getCopyCompleteness(f.id, cp);
      if (!comp) continue;
      if (!comp.complete) allComplete = false;
      const miss = (comp.missingRequired || []).length;
      if (miss > worst) worst = miss;
    }
    if (allComplete || worst === 0) return '';
    return `<span class="card-missing-acc" title="${worst} missing accessor${worst===1?'y':'ies'}">-${worst > 9 ? '9+' : worst}</span>`;
  })();

  const statusDot = c.status
    ? `<div class="fig-status-dot ${statusCls}"></div>`
    : `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;

  // All multi-copy: standard 2-layer stack only (no 3plus variant on cards)
  const stackCls = copyN > 1 ? ' has-stack' : '';

  // v6.65: variant nesting. A variant card gets a gold connector tag with its
  // variantName; a parent with variants gets a small count chip.
  const isVarFig = !!f.variantOf;
  const varKids = figVariants(f.id);
  const varCount = varKids.length
    ? ` <span class="variant-count-inline" title="${varKids.length} variant${varKids.length===1?'':'s'}">⧉${varKids.length}</span>` : '';

  return `<div class="fig-card ${statusCls}${isSelected ? ' selected' : ''}${stackCls}${isVarFig && !standalone ? ' variant-nested' : ''}" data-fig-id="${eId}" data-action="${cardAction}">
    <div class="card-image-wrap">
      ${showImg && imgSrc ? `<img src="${esc(imgSrc)}" alt="" loading="lazy" data-error-action="img-error" data-fig-id="${eId}">` :
        `<div class="card-initial">${esc(f.name[0])}</div>`}
      ${S.selectMode ? `<div class="select-checkbox select-checkbox-corner ${isSelected ? 'checked' : ''}">${checkSvg}</div>` : ''}
      ${!S.selectMode && isNew ? '<div class="new-badge">NEW</div>' : ''}
      ${!S.selectMode && isWishDeal(f) ? '<div class="deal-badge" title="At or below your target price">DEAL</div>' : ''}
    </div>
    <div class="card-strip">
      <div class="card-strip-info">
        <div class="card-fig-name">${esc(f.name)}${copyN > 1 ? ` <span class="copy-count-inline" title="${copyN} copies">×${copyN}</span>` : ''}${varCount}${missingAcc}</div>
        <div class="card-fig-meta">${S.search ? esc(ln(f.line)) + ' · ' : ''}${f.group ? esc(f.group) : ''}${f.year ? ' · ' + f.year : ''}</div>
      </div>
      ${S.selectMode ? '' : `<button class="card-status-btn ${statusCls}" data-action="${badgeAction}" data-fig-id="${eId}" title="Cycle status">${statusDot}</button>`}
    </div>
  </div>`;
}

function renderFigItem(f, standalone = false) {
  return S.viewMode === 'grid' ? renderFigCard(f, standalone) : renderFigRow(f, standalone);
}

function yearHeader(year) {
  return `<div style="padding:12px 4px 6px;font-family:'Cinzel',serif;font-size:13px;font-weight:700;color:var(--gold);letter-spacing:1px;border-bottom:1px solid var(--bd);margin-bottom:4px">${year || 'Unknown'}</div>`;
}

function renderFigsWithHeaders(figs, renderFn) {
  const showHeaders = !S.search && (S.sortBy === 'year' || S.sortBy === 'year-desc') && S.viewMode === 'list';
  let html = '';
  let lastYear = null;
  // v6.82: normalize year for header grouping. Catalog years are ints, but
  // overrides/custom figures created via some paths can persist a STRING
  // year (e.g. "2026"). Strict !== then treated "2026" and 2026 as different
  // buckets, emitting a duplicate "2026" header that split otherwise-adjacent
  // figures. Compare (and display) a normalized key so same-year figures
  // group together regardless of how the value was stored.
  const yearKey = (y) => (y === '' || y == null) ? '' : String(y).trim();
  figs.forEach(f => {
    const yk = yearKey(f.year);
    if (showHeaders && yk !== lastYear) {
      lastYear = yk;
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
          <button data-action="nav-to" data-target="lines" style="padding:10px 18px;border-radius:10px;border:1px solid var(--acc);background:color-mix(in srgb,var(--acc) 14%,transparent);color:var(--acc);font-size:13px;font-weight:600">Browse Lines</button>
          <button data-action="nav-to" data-target="all" style="padding:10px 18px;border-radius:10px;border:1px solid var(--bd);background:var(--bg3);color:var(--t1);font-size:13px;font-weight:600">View All Figures</button>
        </div>
      </div>`;
    } else {
      // v6.27: when filters return no figures, give the user a one-tap escape.
      // Previously the empty state was a dead-end ("Try adjusting…" with no
      // affordance). Now offers Clear filters / Clear search inline.
      const showClearFilters = hf && !S.search;
      const showClearSearch = !!S.search;
      const showClearAll = hf && S.search;
      html += `<div class="empty-state">
        <div class="emoji">🔍</div>
        <div class="title">No figures match</div>
        <div class="text-sm" style="margin-bottom:16px">Try adjusting your search or filters.</div>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          ${showClearAll ? `<button data-action="clear-search-and-filters" style="padding:10px 18px;border-radius:10px;border:1px solid var(--acc);background:color-mix(in srgb,var(--acc) 14%,transparent);color:var(--acc);font-size:13px;font-weight:600">Clear all</button>` : ''}
          ${showClearFilters ? `<button data-action="clear-filters" style="padding:10px 18px;border-radius:10px;border:1px solid var(--acc);background:color-mix(in srgb,var(--acc) 14%,transparent);color:var(--acc);font-size:13px;font-weight:600">Clear filters</button>` : ''}
          ${showClearSearch ? `<button data-action="clear-search" style="padding:10px 18px;border-radius:10px;border:1px solid var(--bd);background:var(--bg3);color:var(--t1);font-size:13px;font-weight:600">Clear search</button>` : ''}
        </div>
      </div>`;
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
          newFigs.forEach(f => { html += renderFigCard(f, true); });
          html += '</div>';
        } else {
          newFigs.forEach(f => { html += renderFigItem(f, true); });
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
        recent.forEach(f => { html += isGrid ? renderFigCard(f, true) : renderFigItem(f, true); });
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
      html += renderFigsWithHeaders(first, renderFigItem);
      if (rest.length) html += `<div id="figListRest"></div>`;
    }
    if (rest.length) {
      requestAnimationFrame(() => {
        const container = document.getElementById('figListRest');
        if (!container) return;
        if (isGrid) {
          container.innerHTML = rest.map(f => renderFigCard(f)).join('');
        } else {
          container.innerHTML = renderFigsWithHeaders(rest, renderFigItem);
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
  const jId = jsArg(f.id);
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
    h += `<button class="status-btn ${active?'active':''}" style="--status-color:${STATUS_HEX[s]}" data-action="set-status" data-fig-id="${eId}" data-status="${esc(s)}">${icon(statIcon, 16)} ${STATUS_LABEL[s]}</button>`;
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
      h += `<button class="add-copy-btn" onclick="addCopy(${jId})">
        <span class="add-copy-plus">+</span> ${isMulti ? 'Add another copy' : 'Add a second copy'}
      </button>
      </div>`;
    }
    // v6.69: Price Watch — wishlist/ordered figures can carry a target
    // price. When the cached asking drops to or below it, the figure gets
    // a DEAL badge in lists and a green callout here. Entry-level field
    // (not per-copy) since you don't own a copy yet.
    if (c.status === 'wishlist' || c.status === 'ordered') {
      const target = parseFloat(c.targetPrice);
      const askingNow = getCachedAskingPrice(f);
      const isDeal = Number.isFinite(target) && askingNow != null && askingNow <= target;
      h += `<div class="copies-section">
        <div class="copies-header">
          <div class="label text-upper text-dim text-xs">Price Watch</div>
        </div>
        <div class="detail-fields copy-fields">
          <div>
            <div class="field-label text-dim text-sm">Target Price</div>
            <input type="number" step="0.01" value="${esc(c.targetPrice || '')}" placeholder="Alert at or below…" onchange="updateOrderedField(${jId},'targetPrice',this.value)">
          </div>
          ${Number.isFinite(target) ? `<div style="font-size:12px;color:${isDeal ? 'var(--gn)' : 'var(--t3)'};align-self:end;padding-bottom:8px">
            ${askingNow != null
              ? (isDeal ? `✓ Deal! Asking $${askingNow.toFixed(2)} ≤ your $${target.toFixed(2)} target` : `Asking $${askingNow.toFixed(2)} — above your $${target.toFixed(2)} target`)
              : 'No asking price cached yet'}
          </div>` : ''}
        </div>
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
            <input type="text" value="${esc(c.orderedFrom||'')}" placeholder="e.g. Walmart, Amazon, BBTS…" onchange="updateOrderedField(${jId},'orderedFrom',this.value)">
          </div>
          <div>
            <div class="field-label text-dim text-sm">Expected Date</div>
            <input type="month" value="${esc(c.orderedDate||'')}" onchange="updateOrderedField(${jId},'orderedDate',this.value)">
          </div>
          <div>
            <div class="field-label text-dim text-sm">Price Paid</div>
            <input type="number" step="0.01" value="${esc(c.orderedPaid||'')}" placeholder="$0.00" onchange="updateOrderedField(${jId},'orderedPaid',this.value)">
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
  const jId = jsArg(f.id);
  // copyId is the stable internal id used by addCopy/removeCopy/updateCopy
  const cid = cp.id;
  let h = `<div class="copy-card" data-copy-id="${cid}">`;
  if (isMulti) {
    h += `<div class="copy-card-head">
      <div class="copy-num">Copy ${i + 1}</div>
      <button class="copy-del-btn" title="Remove this copy" onclick="removeCopy(${jId},${cid})">${icon(ICO.trash, 14)}</button>
    </div>`;
  }
  h += `<div class="detail-fields copy-fields">
    <div>
      <div class="field-label text-dim text-sm">Condition</div>
      <select onchange="updateCopy(${jId},${cid},'condition',this.value)">
        <option value="">Select...</option>
        ${CONDITIONS.map(x => `<option value="${esc(x)}" ${cond===x?'selected':''}>${esc(x)}</option>`).join('')}
      </select>
    </div>
    <div>
      <div class="field-label text-dim text-sm">Price Paid</div>
      <input type="number" step="0.01" value="${esc(paid)}" placeholder="$0.00" onchange="updateCopy(${jId},${cid},'paid',this.value)">
    </div>
    ${S.coll[f.id]?.status === 'for-sale' ? `<div>
      <div class="field-label text-dim text-sm">Asking Price</div>
      <input type="number" step="0.01" value="${esc(cp.asking || '')}" placeholder="$0.00" onchange="updateCopy(${jId},${cid},'asking',this.value)">
    </div>` : ''}
    <div>
      <div class="field-label text-dim text-sm">Acquired</div>
      <input type="text" inputmode="numeric" maxlength="7" value="${esc(cp.acquired || '')}"
        placeholder="MM/YYYY" pattern="\\d{1,2}/\\d{4}"
        oninput="formatAcquired(this)"
        onchange="updateCopy(${jId},${cid},'acquired',this.value)">
    </div>
    ${variant ? `<div>
      <!-- v6.70: per-copy Variant free-text removed — superseded by the
           structured variantOf model. Field only renders when a legacy
           value exists so it stays editable/clearable; clearing it hides
           the field for good. -->
      <div class="field-label text-dim text-sm">Variant (legacy)</div>
      <input type="text" value="${esc(variant)}" onchange="updateCopy(${jId},${cid},'variant',this.value)">
    </div>` : ''}
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
    h += `<span class="acc-chip"><span class="acc-chip-label">${esc(a)}</span><button class="acc-chip-x" title="Remove" onclick="removeAccessory(${jId},${cid},${idx})">×</button></span>`;
  });
  h += `<button class="acc-add" onclick="openAccessoryPicker(${jId},${cid})">+ Add</button>
      </div>
      ${(() => {
        // v6.03: Missing-from-loadout row. Tap a missing item to add it.
        // Hidden when complete (would be empty) or no loadout exists.
        const comp = getCopyCompleteness(f.id, cp);
        if (!comp || comp.complete || !comp.missing.length) return '';
        const items = comp.missing.map(name =>
          `<button class="acc-missing-pill" onclick="addAccessory(${jId},${cid},${esc(JSON.stringify(name))})" title="Mark as present">+ ${esc(name)}</button>`
        ).join('');
        return `<div class="acc-missing-row">
          <span class="acc-missing-label text-dim">Missing:</span>
          ${items}
        </div>`;
      })()}
    </div>
    <div>
      <div class="field-label text-dim text-sm">Location</div>
      <input type="text" value="${esc(location)}" placeholder="e.g. Display shelf, Storage bin A, On loan…" list="locationSuggestions" onchange="updateCopy(${jId},${cid},'location',this.value)">
    </div>
    <div>
      <div class="field-label text-dim text-sm">Notes</div>
      <textarea rows="3" placeholder="Notes…" oninput="updateCopyDebounced(${jId},${cid},'notes',this.value)" onblur="updateCopy(${jId},${cid},'notes',this.value)">${esc(notes)}</textarea>
    </div>
    ${S.coll[f.id]?.status === 'for-sale' ? `<div>
      <button class="mark-sold-btn" onclick="markCopySold(${jId},${cid})" title="Record the sale and remove this copy">
        ${icon(ICO.tag || ICO.check, 14)} Mark Sold…
      </button>
    </div>` : ''}`;
  // Per-copy photos (multi-copy only — single-copy uses the main carousel)
  if (isMulti) {
    const copyPhotos = photoStore.getForCopy(f.id, cid, false);  // exclude shared
    h += `<div class="copy-photos-row">
      <div class="field-label text-dim text-sm">Photos for this copy</div>
      <div class="copy-photos-strip">`;
    copyPhotos.forEach(p => {
      h += `<div class="copy-photo-thumb" onclick="openCopyPhoto(${jId},${p.n})">
        <img src="${esc(p.url)}" alt="${esc(p.label || '')}" loading="lazy">
        <button class="copy-photo-unlink" title="Make shared" onclick="event.stopPropagation();unlinkCopyPhoto(${jId},${p.n})">⌫</button>
      </div>`;
    });
    h += `<label class="copy-photo-add" title="Add photo to this copy">
      ${icon(ICO.img, 18)}
      <input type="file" accept="image/*" style="display:none" onchange="handleCopyPhoto(this,${jId},${cid})">
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

// v6.57: re-render only the market-value block in place. Called by pricing.js
// when a deferred fetch completes, so the loading placeholder updates live
// instead of lingering until the user navigates away and back.
// v6.64: the container now holds "Original Retail · Asking" inline rather
// than a standalone block, so we rebuild that whole line.
function rerenderMVBlock(figId) {
  if (!figId) return;
  const el = document.getElementById('mvBlock_' + figId);
  if (!el) return;
  let paidArr = [];
  try { paidArr = JSON.parse(el.dataset.paid || '[]'); } catch {}
  const condition = el.dataset.condition || undefined;
  if (S.activeFig && S.activeFig.id === figId) {
    renderMarketValueBlock._meta = { line: S.activeFig.line, wave: S.activeFig.wave, year: S.activeFig.year };
  }
  const f = S.activeFig;
  const retailPart = (f && f.retail) ? `Original Retail: <span class="price">$${f.retail.toFixed(2)}</span>` : '';
  const asking = renderMarketValueBlock(figId, paidArr, condition);
  const sep = (retailPart && asking) ? ' <span class="text-dim" style="margin:0 4px">·</span> ' : '';
  el.innerHTML = retailPart + sep + asking;
}
window.rerenderMVBlock = rerenderMVBlock;

function renderDetail() {
  const _ds = document.querySelector('.detail-scroll');
  const _dsScroll = _ds ? _ds.scrollTop : 0;
  const f = S.activeFig;
  const eId = esc(f.id);
  const jId = jsArg(f.id);
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
          <div class="photo-slide" onclick="openSlideViewer(${jId},${si})">
            <img src="${esc(s.url)}" alt="${esc(s.label || f.name)}" ${s.stock ? `onerror="imgErr(${jId})"` : ''}>
            ${s.label ? `<div class="photo-slide-label">${esc(s.label)}</div>` : ''}
            ${!s.stock ? `<button class="photo-slide-remove" onclick="event.stopPropagation();removePhoto(${jId},${s.n})">${icon(ICO.x,14)}</button>` : ''}
            <button class="photo-slide-default${isDef ? ' active' : ''}" onclick="event.stopPropagation();setDefaultPhoto(${jId},${s.n})" title="${isDef ? 'Primary photo' : 'Set as primary'}">★</button>
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
        ${canAddMore ? `<button class="photo-btn" onclick="document.getElementById('photoCamera').click()">
          ${icon(ICO.plus,14)} Camera
        </button>
        <button class="photo-btn" onclick="document.getElementById('photoGallery').click()">
          ${icon(ICO.plus,14)} Gallery${userPhotos.length > 0 ? ` (${userPhotos.length}/${MAX_PHOTOS})` : ''}
        </button>` : `<div class="photo-btn" style="opacity:0.5;cursor:default">Max ${MAX_PHOTOS} photos</div>`}
      </div>
      <!-- v6.83: split capture. The camera input keeps capture="environment"
           to open the rear camera directly; the gallery input omits capture so
           the OS shows the photo library / files picker. Both feed handlePhoto. -->
      <input type="file" id="photoCamera" accept="image/*" capture="environment" style="display:none" onchange="handlePhoto(this,${jId})">
      <input type="file" id="photoGallery" accept="image/*" style="display:none" onchange="handlePhoto(this,${jId})">
    </div>
    ${userPhotos.length > 0 ? `<div class="photo-labels">
      ${userPhotos.map(p => `
        <div class="photo-label-row">
          <span class="photo-label-num">#${userPhotos.indexOf(p)+1}</span>
          <input type="text" placeholder="Label (optional) — e.g. UPC, Back, Loose" value="${esc(p.label)}"
                 onblur="setPhotoLabel(${jId},${p.n},this.value)" maxlength="20">
        </div>
      `).join('')}
    </div>` : ''}
    <div class="detail-pills">${pills.map(p => `<span class="pill">${esc(p)}</span>`).join('')}</div>
    ${(() => {
      // v6.65: variant tour. If this figure is part of a variant family
      // (it has variants, or it IS a variant), render a horizontal strip of
      // the whole family — parent first, then each variant — with thumbs.
      // Tapping a member opens its own detail screen; the current member is
      // highlighted. Variants additionally get a "Variant of …" link line.
      const parent = f.variantOf ? figById(f.variantOf) : null;
      const root = parent || f;
      const fam = [root, ...figVariants(root.id)];
      if (fam.length < 2) return '';
      const chip = (m) => {
        const cur = m.id === f.id;
        const mImg = (S.customPhotos[m.id] && photoStore.get(m.id)) || (!S.imgErrors[m.id] && m.image) || '';
        const label = m.id === root.id ? 'Original' : (m.variantName || m.name);
        const owned = S.coll[m.id]?.status === 'owned';
        return `<div class="variant-chip${cur ? ' current' : ''}" ${cur ? '' : `data-action="open-fig" data-fig-id="${esc(m.id)}"`}>
          <div class="variant-chip-thumb">${mImg ? `<img src="${esc(mImg)}" alt="" loading="lazy">` : `<span>${esc(m.name[0])}</span>`}${owned ? '<div class="variant-chip-dot"></div>' : ''}</div>
          <div class="variant-chip-label">${esc(label)}</div>
        </div>`;
      };
      return `<div class="variant-section">
        ${parent ? `<div class="variant-of-line" data-action="open-fig" data-fig-id="${esc(parent.id)}">↳ Variant of <span>${esc(parent.name)}</span></div>` : ''}
        <div class="variant-strip">${fam.map(chip).join('')}<div class="variant-chip variant-chip-add" onclick="addVariant(${jsArg(root.id)})" title="Add a variant">
          <div class="variant-chip-thumb"><span style="font-size:28px;color:var(--gold)">+</span></div>
          <div class="variant-chip-label">Add</div>
        </div></div>
      </div>`;
    })()}
    ${(() => {
      // v6.64: inline retail + asking price. Replaces the previous big
      // Market Value block. "Original Retail" is the launch price; "Asking"
      // is the current eBay BIN median (single number, no min/max, no
      // condition split). Sealed bucket for modern lines, loose for vintage
      // (decided inside renderMarketValueBlock by line id). Both sit on one
      // line; either may be missing.
      const paidArr = [];
      if (c && Array.isArray(c.copies)) for (const cp of c.copies) if (cp.paid) paidArr.push(cp.paid);
      const primaryCp = c && Array.isArray(c.copies) ? c.copies[0] : null;
      const condition = primaryCp?.condition || undefined;
      renderMarketValueBlock._meta = { line: f.line, wave: f.wave, year: f.year };
      const asking = renderMarketValueBlock(f.id, paidArr, condition);
      if (!f.retail && !asking) return '';
      const retailPart = f.retail ? `Original Retail: <span class="price">$${f.retail.toFixed(2)}</span>` : '';
      const sep = (f.retail && asking) ? ' <span class="text-dim" style="margin:0 4px">·</span> ' : '';
      // Wrap in mvBlock_<id> so rerenderMVBlock() can swap the asking part in place.
      return `<div class="detail-retail" id="mvBlock_${esc(f.id)}" data-mv-figid="${esc(f.id)}" data-paid="${esc(JSON.stringify(paidArr))}" data-condition="${esc(condition || '')}">${retailPart}${sep}${asking}${asking ? renderSparkline(f.id) : ''}</div>`;
    })()}
    ${(() => {
      // v6.70: action bar rebuilt — uniform equal-width buttons in a grid,
      // single-line labels ("AF411" not "View on AF411"), "All versions"
      // removed (user request). Delete (custom figs) joins the same grid.
      const btn = (onclick, label, ic, color) => `<button onclick="${onclick}" class="detail-action-btn${color ? ' ' + color : ''}">${icon(ic, 15)}<span>${label}</span></button>`;
      const btns = [];
      if (f.line !== 'kids-core' && f.line !== 'custom')
        btns.push(btn(`event.preventDefault();openAF411(${jId})`, 'AF411', ICO.export));
      btns.push(btn(`openFigureEditor(${jId})`, 'Edit', ICO.edit));
      btns.push(btn(`addVariant(${jId})`, 'Add Variant', ICO.plus, 'gold'));
      if (f.source === 'custom-local')
        btns.push(btn(`deleteCustomFig(${jId})`, 'Delete', ICO.x, 'red'));
      return `<div class="detail-action-bar" style="grid-template-columns:repeat(${btns.length},1fr)">${btns.join('')}</div>`;
    })()}
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
  // v6.28: "Set as default" button shown when this photo isn't already the
  // default thumbnail. Stock photos (n=-1) and stub-less viewers skip it.
  const isStock = !!p.stock || p.n === -1;
  const figId = v.figId;
  const curDefault = (figId && S.defaultPhoto) ? S.defaultPhoto[figId] : undefined;
  const isAlreadyDefault = !isStock && curDefault === p.n;
  const showSetDefault = !isStock && figId && !isAlreadyDefault;
  return `<div class="photo-viewer" onclick="if(event.target===this)closePhotoViewer()">
    <button class="photo-viewer-close" onclick="closePhotoViewer()">${icon(ICO.x,28)}</button>
    ${multi ? `<button class="photo-viewer-nav prev" onclick="event.stopPropagation();photoViewerNav(-1)">${icon(ICO.back,28)}</button>` : ''}
    <div class="photo-viewer-img-wrap" onclick="event.stopPropagation()">
      <img src="${esc(p.url)}" alt="${esc(p.label || '')}">
      ${p.label ? `<div class="photo-viewer-label">${esc(p.label)}</div>` : ''}
      ${multi ? `<div class="photo-viewer-counter">${v.idx + 1} / ${v.photos.length}</div>` : ''}
      ${showSetDefault ? `<button class="photo-viewer-default" onclick="event.stopPropagation();setDefaultPhoto(${jsArg(figId)},${p.n});window.toast&&window.toast('★ Set as default')" title="Use this as the list/grid thumbnail">★ Set as default</button>` : ''}
      ${isAlreadyDefault ? `<div class="photo-viewer-default-badge">★ Default</div>` : ''}
    </div>
    ${multi ? `<button class="photo-viewer-nav next" onclick="event.stopPropagation();photoViewerNav(1)">${icon(ICO.chevR,28)}</button>` : ''}
  </div>`;
}

// v6.31: window mirrors so delegated handlers can call them without
// import cycles. (checkShareLink moved to share.js in v6.81.)
window.appConfirm = appConfirm;
window.appPromptText = appPromptText;
window.toast = toast;
// v6.33: tab-swipe handler in handlers.js needs renderContent so it can
// pre-render the destination tab into a sibling pane during a swipe.
window.renderContent = renderContent;

// ── Exports ─────────────────────────────────────────────────
// v6.79: trimmed to names actually imported by other modules. Several
// render helpers (renderFigRow/Card, renderCopyCard, yearHeader, etc.)
// are internal-only and were dropped from this list — they're still
// defined and used within render.js, just no longer part of the public
// surface, which keeps the module boundary honest.
export {
  toast, haptic, appConfirm, appPromptText, triggerPulse, toastUndo, toastAction, showUpdateBanner, patchFigRow, updateNavBadge, render, renderLoading, renderMain, renderSelectActionbar, renderNavBtn, renderBreadcrumb, renderKidsCoreAdminSheet, renderContent, renderLinesGrid, renderSublines, renderFigList, patchDetailStatus, renderDetail, renderPhotoViewer
};
