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
          ? `<button class="quick-own" data-action="cycle-status" data-fig-id="${id}" title="Cycle status" style="border-color:${STATUS_COLOR[c.status]}"><div class="fig-status-dot ${statusCls}"></div></button>`
          : `<button class="quick-own" data-action="set-status-owned" data-fig-id="${id}" title="Mark owned">${icon(ICO.check,16)}</button>`);
    }
    // v7.22: keep the swipe panel's active-button highlight in sync too —
    // otherwise reopening it after a quick tier-1/2 swipe commit (which
    // closes the panel immediately) would show the status it had BEFORE
    // that commit, not the one it was just set to.
    const panel = row.closest('.fig-row-wrap')?.querySelector('.fig-swipe-panel');
    if (panel) {
      panel.querySelectorAll('.fig-swipe-btn').forEach(btn => {
        const key = btn.dataset.swipeDo;
        const active = key !== 'detail' && c.status === key;
        btn.classList.toggle('active', active);
        btn.style.setProperty('--status-color', active ? STATUS_HEX[key] : '');
      });
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
      // v7.24 fix: STAGGER_CAP was being applied to the PER-ROW delay
      // (`min(last-i, CAP)`), not to which rows get staggered at all. For
      // a short list (Lines, ~10 items) `last` is small, so `last-i` never
      // actually reaches the cap and every item gets a real, distinct
      // delay — the intended wave. For a long list (All/Collection,
      // hundreds+) EVERY visible row is near the TOP, meaning `last-i` is
      // huge for all of them, so they ALL clamped to the same maxed-out
      // delay and just faded in together — no stagger, just a pause then
      // a simultaneous fade. That's the "never as smooth as Lines"
      // symptom. Fix: cap the EFFECTIVE list length to the stagger window
      // first, then compute delay within that — only the rows actually
      // visible after a fresh scroll-to-top navigation participate; rows
      // beyond the window get no explicit delay (CSS defaults to 0, which
      // is correct — they're off-screen until scrolled to regardless).
      requestAnimationFrame(() => {
        const STAGGER_CAP = 11;
        const nodes = app().querySelectorAll('.fig-row,.fig-card,.line-card,.line-row,.subline-card');
        const effectiveLast = Math.min(nodes.length - 1, STAGGER_CAP);
        for (let i = 0; i <= effectiveLast; i++) {
          nodes[i].style.setProperty('--stagger-i', effectiveLast - i);
        }
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
      <button class="retry-btn" data-action="recover-to-main">Recover</button>
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
  // v6.97: per-scope scroll memory. The scope-match check resets scroll to top
  // whenever the scope key changes — right when drilling INTO a new scope (a
  // subline should open at the top), but wrong when popping BACK out (lines →
  // line → subline → back should land where you left the parent list). So we
  // remember each scope's scrollTop as we leave it and restore it on return; a
  // brand-new scope has no memory and still opens at the top. (This is what the
  // detail-screen savedScroll already does for figure→list; it never covered
  // the line→subline drill-down within the main screen, hence the lines tab not
  // holding position while the flat tabs did.)
  S._scrollMemory = S._scrollMemory || {};
  if (_prevCa && _prevListKey && !S.sheet && !_returningFromDetail) {
    S._scrollMemory[_prevListKey] = _prevCa.scrollTop;
  }
  const _returningToKnownScope = !_scopeMatches &&
    Object.prototype.hasOwnProperty.call(S._scrollMemory, _listKey);
  const _preservedScroll = (!S.sheet && _prevCa && !_returningFromDetail)
    ? (_scopeMatches ? _prevCa.scrollTop
                     : (_returningToKnownScope ? S._scrollMemory[_listKey] : 0))
    : 0;

  const stats = getStats();
  const sortLabel = S.sortBy === 'added-desc' ? 'Added' : S.sortBy.includes('year') ? 'Year' : S.sortBy === 'wave' ? 'Wave' : S.sortBy.includes('name') ? 'Name' : 'Price';
  const hf = hasFilters();
  const syncCls = S.isOffline ? 'offline' : (S.syncStatus === 'syncing' ? 'syncing' : S.syncStatus === 'ok' ? 'sync-ok' : S.syncStatus === 'err' ? 'sync-err' : '');
  const syncClick = S.isOffline ? 'sync-offline' : 'sync-now';
  const syncTitle = S.isOffline ? 'Offline' : 'Sync';

  const themeTitles = getThemeTitles();
  const themeIcon = getThemeIcon();
  const hasTitleCycle = themeTitles.length > 1;
  const titleClick = hasTitleCycle
    ? 'title-cycle'
    : (S.theme === 'eternia'   ? 'title-tap-eternia'   :
       S.theme === 'heman'     ? 'title-tap-heman'     :
       S.theme === 'grayskull' ? 'title-tap-grayskull' :
       S.theme === 'skeletor'  ? 'title-tap-skeletor'  :
       S.theme === 'light'     ? 'title-tap-light'     : 'go-home');

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
        <img src="${themeIcon}" alt="" class="logo-icon" data-action="home-icon" style="cursor:pointer">
        <div>
          <div class="logo-title font-display text-gold" data-action="${titleClick}" style="cursor:pointer;user-select:none">${themeTitles[S.titleIdx % themeTitles.length]}</div>
          <div class="logo-subtitle text-dim text-upper">${stats.total} Figures · ${stats.owned} Owned · <span class="text-gold" style="text-transform:none">v7.40</span></div>
        </div>
      </div>
      <div class="header-actions">
        <button class="icon-btn ${syncCls}" title="${syncTitle}" data-action="${syncClick}">${icon(ICO.sync,16)}</button>
        <button class="icon-btn" title="Menu" data-action="open-sheet" data-sheet="menu">${icon(ICO.menu,20)}</button>
      </div>
    </div>
    <div class="search-bar-wrap${S.searchBarHidden?' hidden':''}" id="searchBar">
    <div class="search-row">
      <div class="search-wrap">
        <span class="search-icon">${icon(ICO.search,16)}</span>
        <input id="searchInput" value="${esc(S.search)}" placeholder="${S.activeLine ? 'Search '+ln(S.activeLine)+'…' : 'Search figures…'}" data-input-action="on-search" data-keydown-action="search-blur-on-enter" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        ${S.search ? `<button class="search-clear" data-action="clear-search">${icon(ICO.x,14)}</button>` : ''}
        <button class="search-scan" data-action="open-barcode-scanner" title="Scan a barcode" aria-label="Scan barcode">${icon(ICO.qr,16)}</button>
      </div>
      <button class="filter-btn ${hf?'active':''}" data-action="open-sheet" data-sheet="filter">
        ${icon(ICO.filter,18)}${hf ? '<span class="filter-dot"></span>' : ''}
      </button>
      <button class="sort-btn" data-action="open-sheet" data-sheet="sort">
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
    } else if (_preservedScroll > 0 && !S.sheet && (!S._justNavigated || _returningToKnownScope)) {
      // v6.97: normally suppressed during a navigation (_justNavigated) so a
      // forward drill-down starts at the top — but when we're returning to a
      // scope we have a remembered position for, apply it even though the
      // back-nav set _justNavigated. _preservedScroll is already scope-correct.
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
        <button data-action="cancel-confirm-clear"
          style="padding:10px 16px;border-radius:10px;border:1px solid var(--bd);background:var(--bg3);color:var(--t2);font-size:13px;font-weight:600">
          Cancel
        </button>
        <button data-action="confirm-batch-clear"
          style="padding:10px 18px;border-radius:10px;border:2px solid var(--rd);background:color-mix(in srgb,var(--rd) 18%,var(--bg3));color:var(--rd);font-size:13px;font-weight:800">
          Clear
        </button>
      </div>
    </div>`;
  }

  const statusRow = STATUSES.map(s =>
    `<button class="sa-status-btn" ${dis} style="--st-c:${STATUS_HEX[s]}"
      data-action="batch-set-status" data-status="${s}">${STATUS_LABEL[s]}</button>`
  ).join('');
  let anySelectedHasPhotos = false;
  for (const id of S.selected) {
    if ((S.customPhotos[id] || []).length) { anySelectedHasPhotos = true; break; }
  }
  return `<div class="select-actionbar visible">
    <div class="sa-row">
      <span class="count">${n}</span>
      <button data-action="select-all-visible" title="${allSelected ? 'Deselect all' : 'Select all'}">
        ${allSelected ? 'None' : 'All'}
      </button>
      <button class="primary" ${dis} data-action="open-batch-editor" style="flex:1">
        ${icon(ICO.edit, 14)} Batch Edit…
      </button>
      ${anySelectedHasPhotos ? `<button data-action="batch-delete-photos"
        style="padding:9px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--rd) 35%,var(--bd));background:color-mix(in srgb,var(--rd) 6%,var(--bg3));color:var(--rd);font-size:12px;font-weight:600;flex-shrink:0">
        ${icon(ICO.trash,12)} Photos
      </button>` : ''}
      <button ${dis} data-action="begin-confirm-clear"
        style="padding:9px 14px;border-radius:10px;border:2px solid color-mix(in srgb,var(--rd) 50%,var(--bd));background:color-mix(in srgb,var(--rd) 10%,var(--bg3));color:var(--rd);font-size:13px;font-weight:800;flex-shrink:0">
        Clear
      </button>
      <button data-action="exit-select"
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
  // v7.15: the subline-reorder trigger lived here briefly (v7.13) but was
  // the wrong spot — a breadcrumb is for wayfinding, not actions. Entry
  // point is now the hamburger menu's "Reorder Sublines" item (conditional,
  // ui-sheets.js renderMenuSheet), matching how "Manage Collections"
  // already handles this for lines. Nothing to render here anymore.
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
        data-input-action="kc-set-field" data-field="${esc(key)}" ${extra}>
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
  const curFaction = v.faction != null ? v.faction : (existing?.faction || '');
  h += `<div style="margin-bottom:12px">
    <div class="field-label text-dim text-sm">Faction</div>
    <select data-change-action="kc-set-faction">
      <option value="">— Select —</option>
      ${FACTIONS.map(f => `<option value="${esc(f)}" ${curFaction===f?'selected':''}>${esc(f)}</option>`).join('')}
    </select>
  </div>`;

  // Group pills
  h += `<div style="margin-bottom:12px">
    <div class="field-label text-dim text-sm">Group *</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${groups.map(g => `<button type="button" data-action="kc-set-group" data-group="${esc(g)}" style="padding:6px 14px;border-radius:20px;border:1px solid ${curGroup===g?'var(--acc)':'var(--bd)'};background:${curGroup===g?'color-mix(in srgb,var(--acc) 18%,transparent)':'var(--bg2)'};color:${curGroup===g?'var(--acc)':'var(--t2)'};font-size:13px;font-weight:500">${g}</button>`).join('')}
    </div>
  </div>`;

  h += `<button data-action="save-kc-fig" style="width:100%;padding:14px;border-radius:12px;background:var(--acc);color:var(--btn-t);font-size:15px;font-weight:700;margin-bottom:10px">
    ${editing ? 'Save Changes' : 'Add Figure'}
  </button>`;

  if (editing) {
    h += `<button data-action="delete-kc-fig" data-fig-id="${esc(editing)}" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--rd);background:color-mix(in srgb,var(--rd) 10%,transparent);color:var(--rd);font-size:14px;font-weight:600">
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
        <button data-action="kc-edit-fig" data-fig-id="${esc(f.id)}" style="padding:5px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--bg3);color:var(--t2);font-size:12px">Edit</button>
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
    // v7.08: show the tour button on every render so users who skipped
    // or completed can replay. Label switches between Take / Replay
    // based on tour state read via window.tutorialState() (exposed
    // from tutorial.js).
    const tState = (typeof window.tutorialState === 'function') ? window.tutorialState() : { seen: false };
    const tourLabel = tState.seen ? '🎓 Replay tour' : '🎓 Take a 1-minute tour';
    html += `<div class="onboard-banner">
      <div style="flex:1;position:relative;z-index:1">👋 <strong style="color:var(--t1)">Getting started:</strong> Tap a line below to browse its figures. Tap any figure to mark it Owned, Wishlist, or For Sale — it'll appear in your Collection tab.<br><button data-action="start-tutorial" style="margin-top:10px;background:var(--acc);color:var(--bg);border:none;padding:7px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer">${tourLabel}</button></div>
      <img class="onboard-mascot" src="${IMG}/he-man-icon.png" alt="" aria-hidden="true" data-error-action="img-hide">
      <button class="onboard-dismiss" data-action="dismiss-onboard" title="Dismiss">×</button>
    </div>`;
  }
  if (S.editingOrder) {
    html += `<div class="reorder-toggle"><button class="active" data-action="toggle-reorder">✓ Done</button></div>`;
  }

  if (S.editingOrder) {
    html += '<div class="reorder-list" data-reorder-scope="lines">';
    ordered.forEach(l => {
      const hidden = isLineFullyHidden(l.id);
      const hasSublines = getOrderedSublines(l.id).length > 1;
      html += `<div class="reorder-item${hidden?' is-hidden':''}" data-reorder-item data-key="${esc(l.id)}">
        <button class="reorder-handle" aria-label="Drag to reorder ${esc(l.name)}" title="Drag to reorder">${icon(ICO.grip,18,3)}</button>
        <div style="flex:1;min-width:0">
          <div class="font-display" style="font-size:14px;color:var(--t1)">${esc(l.name)}</div>
          <div class="text-sm text-dim" style="margin-top:2px">${l.yr} · ${l.total} figures · ${l.owned} owned · ${l.pct}%</div>
        </div>
        ${hasSublines ? `<button class="reorder-handle" data-action="reorder-drill-line" data-line-id="${esc(l.id)}" aria-label="Manage ${esc(l.name)} sublines" title="Manage sublines">${icon(ICO.chevR,18,3)}</button>` : ''}
        <button class="reorder-hide-btn" data-action="toggle-line-hidden" data-line-id="${esc(l.id)}" aria-label="${hidden?'Show':'Hide'} ${esc(l.name)}">
          ${hidden?'Show':'Hide'}
        </button>
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
        <button class="${linesView==='list'?'active':''}" data-action="set-lines-view" data-view="list" title="List view" aria-label="List view">${icon(ICO.list,15)}</button>
        <button class="${linesView==='grid'?'active':''}" data-action="set-lines-view" data-view="grid" title="Grid view" aria-label="Grid view">${icon(ICO.lines,15)}</button>
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
            <img src="${IMG}/${l.id}.jpg" alt="" data-error-action="img-fallback" data-fallback-src="${IMG}/${l.id}.png" loading="lazy">
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
          <img src="${IMG}/${l.id}.jpg" alt="${esc(l.name)}" data-error-action="img-fallback" data-fallback-src="${IMG}/${l.id}.png" loading="lazy">
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

  // v7.12: sublines with at least one figure — same set the normal view
  // shows (empty sublines are skipped below too), computed once so both
  // branches (reorder mode / normal mode) and the header count agree.
  const populated = subs
    .map(sl => ({ sl, slFigs: S.figs.filter(f => f.line === S.activeLine && sl.groups.includes(f.group)) }))
    .filter(x => x.slFigs.length);

  if (S.editingOrder) {
    let html = `<div class="reorder-toggle"><button class="active" data-action="toggle-reorder">✓ Done</button></div>`;
    html += '<div class="reorder-list" data-reorder-scope="sublines" data-line-id="' + esc(S.activeLine) + '">';
    populated.forEach(({ sl, slFigs }) => {
      const hidden = isSublineHidden(S.activeLine, sl.key);
      html += `<div class="reorder-item${hidden?' is-hidden':''}" data-reorder-item data-key="${esc(sl.key)}">
        <button class="reorder-handle" aria-label="Drag to reorder ${esc(sl.label)}" title="Drag to reorder">${icon(ICO.grip,18,3)}</button>
        <div style="flex:1;min-width:0">
          <div class="font-display" style="font-size:14px;color:var(--t1)">${esc(sl.label)}</div>
          <div class="text-sm text-dim" style="margin-top:2px">${slFigs.length} figures</div>
        </div>
        <button class="reorder-hide-btn" data-action="toggle-subline-hidden" data-line-id="${esc(S.activeLine)}" data-subline="${esc(sl.key)}" aria-label="${hidden?'Show':'Hide'} ${esc(sl.label)}">
          ${hidden?'Show':'Hide'}
        </button>
      </div>`;
    });
    html += '</div>';
    return html;
  }

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
  populated.forEach(({ sl, slFigs }) => {
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

  // v7.22: swipe-to-action. Off for select mode (own interaction model),
  // standalone (reused in non-list contexts), and variant-nested rows.
  const swipeEnabled = !S.selectMode && !standalone && !f.variantOf;
  const rowHtml = `<div class="fig-row${isSelected ? ' selected' : ''}${f.variantOf && !standalone ? ' variant-nested' : ''}" data-fig-id="${eId}" data-action="${rowAction}">
    ${S.selectMode ? `<div class="select-checkbox ${isSelected ? 'checked' : ''}">${checkSvg}</div>` : ''}
    <div class="fig-thumb ${statusCls}${copyN > 1 ? ' has-stack' : ''}">
      ${showImg && imgSrc ? `<img src="${esc(imgSrc)}" alt="" loading="lazy" data-error-action="img-error" data-load-action="img-loaded" data-fig-id="${eId}">` :
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

  if (!swipeEnabled) return rowHtml;

  // v7.25: panel starts EMPTY — buttons are built lazily by
  // swipePanelButtonsHtml() (below) the first time a row is actually
  // touched (handlers.js's touchstart), not upfront for every row. This
  // used to add ~1.7KB of markup per row for a panel that's invisible for
  // 99.9% of rows at any given time (only one can ever be open) — across
  // 1000+ figures on the All tab that was ~1.8MB of pure waste, and a
  // real contributor to the tab feeling slow to open.
  return `<div class="fig-row-wrap" data-fig-id="${eId}">
    <div class="fig-swipe-panel" data-swipe-panel="${eId}"></div>
    ${rowHtml}
  </div>`;
}

// v7.31: reordered — the old order (for-sale, ordered, detail, wishlist,
// owned) put Detail awkwardly in the middle of the four status options
// instead of grouped with or after them, which read as visually
// disorganized. Flex with justify-content:flex-end just aligns the whole
// group to the row's trailing edge when it doesn't fill the available
// width — it doesn't reverse child order — so DOM order here now matches
// left-to-right display order directly: Owned, Wishlist, Ordered, For
// Sale, Detail. Neutral by default, only the CURRENT status colored —
// reuses the exact icon/color choices the detail screen's own status-pill
// already established (STATUS_HEX, ICO.check/heart/box/tag).
function swipePanelButtonsHtml(figId) {
  const eId = esc(figId);
  const status = S.coll[figId]?.status;
  const swipeBtnMeta = {
    owned:      { i: ICO.check, l: 'Owned' },
    wishlist:   { i: ICO.heart, l: 'Wishlist' },
    ordered:    { i: ICO.box,   l: 'Ordered' },
    'for-sale': { i: ICO.tag,   l: 'For Sale' },
    detail:     { i: ICO.chevR, l: 'Detail' },
  };
  return ['owned', 'wishlist', 'ordered', 'for-sale', 'detail'].map(key => {
    const m = swipeBtnMeta[key];
    const active = key !== 'detail' && status === key;
    const styleAttr = active ? ` style="--status-color:${STATUS_HEX[key]}"` : '';
    return `<button class="fig-swipe-btn${active ? ' active' : ''}${key === 'detail' ? ' detail' : ''}" data-action="swipe-commit" data-fig-id="${eId}" data-swipe-do="${key}"${styleAttr}>${icon(m.i, 18)}<span>${m.l}</span></button>`;
  }).join('');
}
window.swipePanelButtonsHtml = swipePanelButtonsHtml;

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
      ${showImg && imgSrc ? `<img src="${esc(imgSrc)}" alt="" loading="lazy" data-error-action="img-error" data-load-action="img-loaded" data-fig-id="${eId}">` :
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
    <button class="select-btn${S.selectMode ? ' active' : ''}" data-action="${S.selectMode ? 'exit-select' : 'enter-select'}" title="Select mode">
      ${S.selectMode ? 'Done' : 'Select'}
    </button>
    <div class="view-toggle">
      <button class="${listActive}" data-action="set-view" data-view="list" title="List view">${icon(ICO.list,14)}</button>
      <button class="${gridActive}" data-action="set-view" data-view="grid" title="Grid view">${icon(ICO.lines,14)}</button>
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
      // Bind long-press to rendered rows (idempotent via the _lpBound guard).
      const bindLongPress = (root) => root.querySelectorAll('[data-fig-id]').forEach(el => {
        if (!el._lpBound) { el._lpBound = true; initLongPress(el, el.dataset.figId); }
      });
      if (isGrid) {
        // v6.100: render the deferred remainder in frame-sized chunks rather
        // than one big innerHTML, so opening a large line (e.g. origins = 326
        // figures) doesn't hitch on a single long frame after the first 80.
        // Grid rows are a flat card list and chunk cleanly; the header-
        // interleaved list path below stays single-pass (headers span the set).
        const REST_CHUNK = 80;
        let i = 0;
        const step = () => {
          const container = document.getElementById('figListRest');
          if (!container) return;  // navigated away mid-render — abort
          container.insertAdjacentHTML('beforeend', rest.slice(i, i + REST_CHUNK).map(f => renderFigCard(f)).join(''));
          bindLongPress(container);
          i += REST_CHUNK;
          if (i < rest.length) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      } else {
        requestAnimationFrame(() => {
          const container = document.getElementById('figListRest');
          if (!container) return;
          container.innerHTML = renderFigsWithHeaders(rest, renderFigItem);
          bindLongPress(container);
        });
      }
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
  // v6.91: status row is now a horizontal scrollable pill bar (matches the
  // showcase mock). Each pill is equal-flex; the active one takes its status
  // color as a tint + border. Icons sit inline before the label.
  let h = `<div class="status-bar">`;
  STATUSES.forEach(s => {
    const active = c.status === s;
    const statIcon = {
      owned: ICO.check,
      wishlist: ICO.heart,
      ordered: ICO.box || ICO.cart || ICO.check,
      'for-sale': ICO.tag || ICO.dollar || ICO.check,
    }[s] || ICO.check;
    h += `<button class="status-pill ${active?'active':''}" style="--status-color:${STATUS_HEX[s]}" data-action="set-status" data-fig-id="${eId}" data-status="${esc(s)}">${icon(statIcon, 16)}<span>${STATUS_LABEL[s]}</span></button>`;
  });
  h += `</div>`;

  if (c.status) {
    const showsCopies = c.status === 'owned' || c.status === 'for-sale';
    if (showsCopies) {
      // Ensure we always have at least one copy slot to edit.
      const copies = (isMigrated(c) && c.copies.length) ? c.copies : [{ id: 1 }];
      const isMulti = copies.length > 1;
      copies.forEach((cp, i) => {
        h += renderCopyCard(f, cp, i, isMulti, copies.length);
      });
      // v6.91: "Add a copy" lives in the bottom action bar next to Add Variant
      // (see renderDetail), so it sits with the other figure-level actions.
    }

    // v6.69: Price Watch — wishlist/ordered figures can carry a target price.
    if (c.status === 'wishlist') {
      const target = parseFloat(c.targetPrice);
      const askingNow = getCachedAskingPrice(f);
      const isDeal = Number.isFinite(target) && askingNow != null && askingNow <= target;
      h += `<div class="databox">
        <div class="databox-header">
          <div class="databox-title-wrap">
            <h3 class="databox-title" style="color:${STATUS_HEX.wishlist}">Price Watch</h3>
          </div>
        </div>
        <div class="ghost-grid" style="margin-bottom:0">
          <div class="input-group">
            <label>Target Price</label>
            <input type="number" step="0.01" class="ghost-input" value="${esc(c.targetPrice || '')}" placeholder="Alert at or below…" data-change-action="update-ordered-field" data-fig-id="${eId}" data-field="targetPrice">
          </div>
          ${Number.isFinite(target) ? `<div class="input-group" style="justify-content:flex-end">
            <div class="price-watch-note" style="color:${isDeal ? 'var(--gn)' : 'var(--t3)'}">
            ${askingNow != null
              ? (isDeal ? `✓ Deal! Asking $${askingNow.toFixed(2)} ≤ your $${target.toFixed(2)} target` : `Asking $${askingNow.toFixed(2)} — above your $${target.toFixed(2)} target`)
              : 'No asking price cached yet'}
            </div>
          </div>` : ''}
        </div>
      </div>`;
    }

    if (c.status === 'ordered') {
      h += `<div class="databox ordered-state">
        <div class="databox-header">
          <div class="databox-title-wrap">
            <h3 class="databox-title">Order Details</h3>
          </div>
        </div>
        <div class="ghost-grid" style="margin-bottom:0">
          <div class="input-group">
            <label>Ordered From</label>
            <input type="text" class="ghost-input" value="${esc(c.orderedFrom||'')}" placeholder="e.g. Walmart, BBTS…" data-change-action="update-ordered-field" data-fig-id="${eId}" data-field="orderedFrom">
          </div>
          <div class="input-group">
            <label>Expected Date</label>
            <input type="month" class="ghost-input" value="${esc(c.orderedDate||'')}" data-change-action="update-ordered-field" data-fig-id="${eId}" data-field="orderedDate">
          </div>
          <div class="input-group">
            <label>Price Paid</label>
            <input type="number" step="0.01" class="ghost-input" value="${esc(c.orderedPaid||'')}" placeholder="$0.00" data-change-action="update-ordered-field" data-fig-id="${eId}" data-field="orderedPaid">
          </div>
        </div>
      </div>`;
    }
  }
  return h;
}

// Renders a single copy as a "databox" card matching the showcase mock.
// `i` is the visual index (0-based); `isMulti` flags multi-copy figures (shows
// the drag handle + delete + per-copy photos); `total` is the copy count.
function renderCopyCard(f, cp, i, isMulti, total) {
  const cond = cp.condition || '';
  const paid = cp.paid || '';
  const variant = cp.variant || '';
  const notes = cp.notes || '';
  const accessories = Array.isArray(cp.accessories) ? cp.accessories : [];
  const location = cp.location || '';
  const eId = esc(f.id);
  const jId = jsArg(f.id);
  const cid = cp.id;
  const status = S.coll[f.id]?.status;
  const isForSale = status === 'for-sale';
  // v6.91: a figure that IS a variant (has a parent) gets the gold
  // "variant-showcase" databox + a Variant badge on its first copy, so the
  // detail screen visually flags it the way the showcase mock does.
  const isVariant = !!f.variantOf && i === 0;
  // Status determines the databox tint class (owned = green title, for-sale =
  // red border/title). Variant showcase overrides for the first card.
  const stateCls = isVariant ? ' variant-showcase' : (isForSale ? ' for-sale-state' : '');
  const stateWord = isForSale ? 'For Sale' : 'Owned';
  const titleText = isMulti ? `Copy ${i + 1} — ${stateWord}` : stateWord;
  const titleCls = (isForSale || isVariant) ? 'databox-title' : 'databox-title owned-title';

  let h = `<div class="databox${stateCls}" data-copy-id="${cid}">
    <div class="databox-header">
      <div class="databox-title-wrap">
        ${isMulti ? `<div class="drag-handle" title="Drag to reorder">${icon(ICO.menu,16)}</div>` : ''}
        <h3 class="${titleCls}">${esc(titleText)}</h3>
        ${isVariant ? `<span class="variant-badge">Variant</span>` : ''}
      </div>
      ${isVariant
        ? `<button class="delete-btn" title="Delete this variant" data-action="delete-custom-fig" data-fig-id="${eId}">${icon(ICO.trash,18)}</button>`
        : (isMulti ? `<button class="delete-btn" title="Remove this copy" data-action="remove-copy" data-fig-id="${eId}" data-copy-id="${cid}">${icon(ICO.trash,18)}</button>` : '')}
    </div>`;

  // Original Retail anchor — a figure-level fact, shown once at the top of the
  // first copy's box as a comparison point above Price Paid.
  // v6.92: on the For Sale screen, the eBay Asking (market median) sits right
  // next to Original Retail here, as selling context.
  if (i === 0) {
    const retailPart = f.retail ? `Original Retail <span class="price">$${f.retail.toFixed(2)}</span>` : '';
    let ebayPart = '';
    if (isForSale) {
      const cps = (S.coll[f.id] && Array.isArray(S.coll[f.id].copies)) ? S.coll[f.id].copies : [];
      const paidArr = cps.map(x => x.paid).filter(Boolean);
      renderMarketValueBlock._meta = { line: f.line, wave: f.wave, year: f.year };
      const ebay = renderMarketValueBlock(f.id, paidArr, cp.condition || undefined);
      if (ebay) ebayPart = `<span id="mvBlock_${eId}" data-mv-figid="${eId}" data-paid="${esc(JSON.stringify(paidArr))}" data-condition="${esc(cp.condition || '')}">${ebay}</span>`;
    }
    const sep = (retailPart && ebayPart) ? ` <span class="text-dim" style="margin:0 6px">·</span> ` : '';
    if (retailPart || ebayPart) {
      h += `<div class="databox-retail">${retailPart}${sep}${ebayPart}</div>`;
    }
  }

  // Ghost-input field grid.
  h += `<div class="ghost-grid">
    <div class="input-group">
      <label>Condition</label>
      <select class="ghost-input" data-change-action="update-copy-field" data-fig-id="${eId}" data-copy-id="${cid}" data-field="condition">
        <option value="">Select...</option>
        ${CONDITIONS.map(x => `<option value="${esc(x)}" ${cond===x?'selected':''}>${esc(x)}</option>`).join('')}
      </select>
    </div>
    <div class="input-group">
      <label>Price Paid</label>
      <input type="number" step="0.01" class="ghost-input" value="${esc(paid || '')}" placeholder="${f.retail != null ? esc(f.retail.toFixed(2)) : '0.00'}" data-focus-action="select-all" data-change-action="update-copy-field" data-fig-id="${eId}" data-copy-id="${cid}" data-field="paid">
    </div>
    ${isForSale ? `<div class="input-group">
      <label>Asking Price</label>
      <input type="number" step="0.01" class="ghost-input" value="${esc(cp.asking || '')}" placeholder="$0.00" data-change-action="update-copy-field" data-fig-id="${eId}" data-copy-id="${cid}" data-field="asking">
    </div>
    <div class="input-group">
      <label>Location</label>
      <input type="text" class="ghost-input" value="${esc(location)}" placeholder="e.g. Display shelf, On loan…" list="locationSuggestions" data-change-action="update-copy-field" data-fig-id="${eId}" data-copy-id="${cid}" data-field="location">
    </div>` : `<div class="input-group">
      <label>Acquired</label>
      <input type="text" inputmode="numeric" maxlength="7" class="ghost-input" value="${esc(cp.acquired || '')}"
        placeholder="MM/YYYY" pattern="\\d{1,2}/\\d{4}"
        data-input-action="format-acquired"
        data-change-action="update-copy-field" data-fig-id="${eId}" data-copy-id="${cid}" data-field="acquired">
    </div>
    <div class="input-group">
      <label>Location</label>
      <input type="text" class="ghost-input" value="${esc(location)}" placeholder="e.g. Display shelf, On loan…" list="locationSuggestions" data-change-action="update-copy-field" data-fig-id="${eId}" data-copy-id="${cid}" data-field="location">
    </div>`}
    ${variant ? `<div class="input-group" style="grid-column:span 2">
      <label>Variant (legacy)</label>
      <input type="text" class="ghost-input" value="${esc(variant)}" data-change-action="update-copy-field" data-fig-id="${eId}" data-copy-id="${cid}" data-field="variant">
    </div>` : ''}
  </div>`;

  // Accessories block with completeness badge + chips.
  h += `<div class="acc-group">
    <label><span>Accessories</span>${(() => {
      const comp = getCopyCompleteness(f.id, cp);
      if (!comp) return '';
      if (comp.complete) return `<span class="badge-complete" title="All loadout items present">✓ Complete</span>`;
      return `<span class="acc-badge partial" title="${comp.have}/${comp.total} loadout items present">Missing ${comp.missing.length}</span>`;
    })()}</label>
    <div class="acc-chips">`;
  accessories.forEach((a, idx) => {
    h += `<span class="acc-chip"><span class="acc-chip-label">${esc(a)}</span><button class="acc-chip-x" title="Remove" data-action="remove-accessory" data-fig-id="${eId}" data-copy-id="${cid}" data-acc-idx="${idx}">×</button></span>`;
  });
  h += `<button class="acc-add" data-action="open-accessory-picker" data-fig-id="${eId}" data-copy-id="${cid}">+ Add</button>
    </div>
    ${(() => {
      const comp = getCopyCompleteness(f.id, cp);
      if (!comp || comp.complete || !comp.missing.length) return '';
      const items = comp.missing.map(name =>
        `<button class="acc-missing-pill" data-action="add-accessory" data-fig-id="${eId}" data-copy-id="${cid}" data-acc-name="${esc(name)}" title="Mark as present">+ ${esc(name)}</button>`
      ).join('');
      return `<div class="acc-missing-row"><span class="acc-missing-label text-dim">Missing:</span>${items}</div>`;
    })()}
  </div>`;

  // Collapsible "More details…" — per-copy photos (multi-copy) + notes.
  const copyPhotos = isMulti ? photoStore.getForCopy(f.id, cid, false) : [];
  h += `<details class="more-details">
    <summary>More details…</summary>
    <div class="details-content ghost-grid" style="margin-bottom:0">`;
  if (isMulti) {
    h += `<div class="input-group" style="grid-column:span 2">
      <label>Photos for this copy</label>
      <div class="copy-photos-strip">`;
    copyPhotos.forEach(p => {
      h += `<div class="copy-photo-thumb" data-action="open-copy-photo" data-fig-id="${eId}" data-photo-n="${p.n}">
        <img src="${esc(p.url)}" alt="${esc(p.label || '')}" loading="lazy">
        <button class="copy-photo-unlink" title="Make shared" data-action="unlink-copy-photo" data-fig-id="${eId}" data-photo-n="${p.n}">⌫</button>
      </div>`;
    });
    h += `<label class="copy-photo-add" title="Add photo to this copy">
        ${icon(ICO.img,18)}
        <input type="file" accept="image/*" style="display:none" data-change-action="handle-copy-photo" data-fig-id="${eId}" data-copy-id="${cid}">
      </label>
      </div>
    </div>`;
  }
  h += `<div class="input-group" style="grid-column:span 2">
      <label>Notes</label>
      <textarea class="ghost-input" rows="3" placeholder="Notes…" data-input-action="update-copy-notes-debounced" data-blur-action="update-copy-notes" data-fig-id="${eId}" data-copy-id="${cid}">${esc(notes)}</textarea>
    </div>
    </div>
  </details>`;

  // Mark Sold action for for-sale copies.
  if (isForSale) {
    h += `<button class="mark-sold-btn" data-action="mark-copy-sold" data-fig-id="${eId}" data-copy-id="${cid}" title="Record the sale and remove this copy">
      ${icon(ICO.tag || ICO.check, 16)} Mark Sold…
    </button>`;
  }

  h += `</div>`;
  return h;
}

function patchDetailStatus() {
  if (S.screen !== 'figure' || !S.activeFig) return;
  const el = document.getElementById('detailStatusBlock');
  if (!el) return;
  // v6.92: changing status swaps this block's contents, and the different
  // states have very different heights (copy cards vs. price watch vs. order
  // details). Without preserving scroll, the container clamps/relayouts and
  // the status pills "bounce" under the user's finger. Save the scroll
  // position of the actual scroller and restore it after the swap.
  const scroller = document.querySelector('.detail-scroll');
  const savedTop = scroller ? scroller.scrollTop : 0;
  const c = S.coll[S.activeFig.id] || {};
  el.innerHTML = renderDetailStatusBlock(S.activeFig, c);
  if (scroller) {
    // restore after layout settles; clamp to the new max so we never overscroll
    requestAnimationFrame(() => {
      const maxTop = scroller.scrollHeight - scroller.clientHeight;
      scroller.scrollTop = Math.max(0, Math.min(savedTop, maxTop));
    });
  }
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
window.patchFigRow = patchFigRow;

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
  // v6.91: Original Retail lives in the copy databox now; this header line is
  // only the eBay Asking context (for-sale screen), so don't duplicate retail.
  const asking = renderMarketValueBlock(figId, paidArr, condition);
  el.innerHTML = asking;
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

  // v6.91: detail redesign — the photo area is now a full-bleed 400px "hero"
  // (matches the finalized showcase mock). Multi-photo figures keep the
  // swipeable carousel; single-photo figures show one cover image. Floating
  // circular FABs overlay the hero: back (top-left), a Default star badge
  // (top-right, shown when the visible primary slide is the user's chosen
  // default), and camera/gallery icon buttons (bottom-right).
  const heroInner = slides.length === 0
    ? `<div class="hero-empty"><span class="initial-large">${esc(f.name[0])}</span></div>`
    : `<div class="photo-carousel" id="photoCarousel">
        ${slides.map((s, si) => {
          const isDef = s.n === defaultN;
          return `
          <div class="photo-slide" data-action="open-slide-viewer" data-fig-id="${eId}" data-slide-idx="${si}">
            <img src="${esc(s.url)}" alt="${esc(s.label || f.name)}" ${s.stock ? `data-error-action="img-error" data-fig-id="${eId}"` : ''}>
            ${s.label ? `<div class="photo-slide-label">${esc(s.label)}</div>` : ''}
            ${!s.stock ? `<button class="photo-slide-remove" data-action="remove-photo" data-fig-id="${eId}" data-photo-n="${s.n}">${icon(ICO.x,14)}</button>` : ''}
            <button class="photo-slide-default${isDef ? ' active' : ''}" data-action="set-default-photo" data-fig-id="${eId}" data-photo-n="${s.n}" title="${isDef ? 'Primary photo' : 'Set as primary'}">${icon(ICO.star,16)}</button>
          </div>`;
        }).join('')}
      </div>
      ${slides.length > 1 ? `<div class="photo-dots">${slides.map((_,i) => `<div class="photo-dot" data-idx="${i}"></div>`).join('')}</div>` : ''}`;

  // Is the user's chosen default photo a real (non-stock) custom photo? Only
  // then does the gold "Default" hero badge make sense.
  const hasChosenDefault = hasCustom && defaultN !== -1;

  let html = `
  <div class="detail-scroll">
    <div class="hero-image">
      <button class="back-fab" data-action="close-detail" title="Back">${icon(ICO.back,24,2.5)}</button>
      ${hasChosenDefault ? `<div class="default-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="${ICO.star}"/></svg> Default</div>` : ''}
      ${heroInner}
      <div class="photo-controls">
        ${canAddMore ? `<button class="icon-fab" data-action="trigger-camera" title="Camera">${icon(ICO.camera,20)}</button>
        <button class="icon-fab" data-action="trigger-gallery" title="Gallery${userPhotos.length > 0 ? ` — ${userPhotos.length}/${MAX_PHOTOS}` : ''}">${icon(ICO.img,20)}</button>`
        : `<div class="icon-fab" style="opacity:0.5;cursor:default" title="Max ${MAX_PHOTOS} photos">${icon(ICO.img,20)}</div>`}
      </div>
      <input type="file" id="photoCamera" accept="image/*" capture="environment" style="display:none" data-change-action="handle-photo" data-fig-id="${eId}">
      <input type="file" id="photoGallery" accept="image/*" style="display:none" data-change-action="handle-photo" data-fig-id="${eId}">
    </div>

    <div class="detail-body">
    <div class="sticky-title-bar">
      <div class="detail-title">${esc(f.name)}</div>
      ${pills.length ? `<div class="detail-subtitle">${pills.map(p => esc(p)).join(' · ')}</div>` : ''}
    </div>
    ${userPhotos.length > 0 ? `<details class="more-details photo-labels-details">
      <summary>Photo labels (${userPhotos.length})</summary>
      <div class="photo-labels">
      ${userPhotos.map(p => `
        <div class="photo-label-row">
          <span class="photo-label-num">#${userPhotos.indexOf(p)+1}</span>
          <input type="text" class="ghost-input" placeholder="Label (optional) — e.g. UPC, Back, Loose" value="${esc(p.label)}"
                 data-blur-action="save-photo-label" data-fig-id="${eId}" data-photo-n="${p.n}" maxlength="20">
        </div>
      `).join('')}
      </div>
    </details>` : ''}
    <!-- v6.89: metadata pills moved to the header subtitle line under the
         name; the floating pill band was removed here. -->
    ${(() => {
      // v6.65: variant tour. If this figure is part of a variant family
      // (it has variants, or it IS a variant), render a horizontal strip of
      // the whole family — parent first, then each variant — with thumbs.
      // Tapping a member opens its own detail screen; the current member is
      // highlighted. (v6.93: the "Variant of …" text line was removed — the
      // strip itself already conveys the family relationship.)
      const parent = f.variantOf ? figById(f.variantOf) : null;
      const root = parent || f;
      const fam = [root, ...figVariants(root.id)];
      // v6.89.1: only show the strip when there's an actual variant family
      // (2+ members) — as it behaved before the redesign. A solo figure with
      // no variants shows nothing here; "Add Variant" lives in the bottom
      // action bar instead.
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
        <div class="variant-strip">${fam.map(chip).join('')}<div class="variant-chip variant-chip-add" data-action="add-variant" data-fig-id="${esc(root.id)}" title="Add a variant">
          <div class="variant-chip-thumb"><span style="font-size:28px;color:var(--gold)">+</span></div>
          <div class="variant-chip-label">Add</div>
        </div></div>
      </div>`;
    })()}
    ${(() => {
      // v6.92: the eBay Asking line is no longer rendered here in the header.
      // It now sits next to Original Retail INSIDE the For Sale copy databox
      // (see renderDetailStatusBlock → databox-retail), which is where the
      // user expects the selling context. Kept this slot empty so the rest of
      // the detail layout is unchanged.
      return '';
    })()}
    <div id="detailStatusBlock">${renderDetailStatusBlock(f, c)}</div>
    <datalist id="locationSuggestions">
      ${getAllLocations().map(l => `<option value="${esc(l)}"></option>`).join('')}
    </datalist>
    <div class="detail-spacer"></div>
    </div>
  </div>
  ${(() => {
    // v6.91: fixed bottom action bar (matches the showcase mock's structure:
    // equal-width grid, utilities + a gold primary creation action). A
    // collection app keeps status + data up top; AF411/Edit are utilities,
    // Add Variant is the creation action from a figure's context (adding a
    // brand-new unrelated figure happens from the list screen, not here).
    const btn = (action, label, ic, cls, extra='') => `<button data-action="${action}" ${extra} class="action-btn${cls ? ' ' + cls : ''}">${icon(ic, 16)}<span>${label}</span></button>`;
    const btns = [];
    const supportsVariants = f.line !== 'kids-core' && f.line !== 'custom';
    if (supportsVariants)
      btns.push(btn('open-af411', 'AF411', ICO.export, '', `data-fig-id="${eId}"`));
    btns.push(btn('open-figure-editor', 'Edit', ICO.edit, '', `data-fig-id="${eId}"`));
    if (f.source === 'custom-local' && !f.variantOf)
      btns.push(btn('delete-custom-fig', 'Delete', ICO.trash, 'red-btn', `data-fig-id="${eId}"`));
    const showsCopies = c.status === 'owned' || c.status === 'for-sale';
    if (showsCopies)
      btns.push(btn('add-copy', 'Add Copy', ICO.plus, 'purple-btn', `data-fig-id="${eId}"`));
    if (supportsVariants)
      btns.push(btn('add-variant', 'Add Variant', ICO.plus, 'primary', `data-fig-id="${eId}"`));
    const cols = Math.min(btns.length, 4);
    return `<div class="action-bar-bottom" style="grid-template-columns:repeat(${cols},1fr)">${btns.join('')}</div>`;
  })()}`;
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
  // v6.85: resolve the EFFECTIVE default the same way the detail carousel
  // does. Previously this checked S.defaultPhoto[figId] === p.n by strict
  // equality only — so a photo that is the IMPLICIT default (no explicit
  // entry yet; the first user photo) was wrongly shown as "Set as default".
  // Tapping it then wrote a redundant explicit entry that fought the implicit
  // fallback and broke list-thumbnail behavior. Mirror the carousel's
  // `?? firstPhoto.n` fallback so implicit and explicit defaults agree.
  const explicitDefault = (figId && S.defaultPhoto) ? S.defaultPhoto[figId] : undefined;
  const userNs = v.photos.filter(ph => !ph.stock && ph.n !== -1).map(ph => ph.n);
  const effectiveDefault = explicitDefault != null
    ? explicitDefault
    : (userNs.length ? userNs[0] : -1);
  const isAlreadyDefault = !isStock && effectiveDefault === p.n;
  const showSetDefault = !isStock && figId && !isAlreadyDefault;
  return `<div class="photo-viewer" data-action="close-photo-viewer-bg">
    <button class="photo-viewer-close" data-action="close-photo-viewer">${icon(ICO.x,28)}</button>
    ${multi ? `<button class="photo-viewer-nav prev" data-action="photo-viewer-nav" data-dir="-1">${icon(ICO.back,28)}</button>` : ''}
    <div class="photo-viewer-img-wrap" data-action="photo-viewer-noop">
      <img src="${esc(p.url)}" alt="${esc(p.label || '')}">
      ${p.label ? `<div class="photo-viewer-label">${esc(p.label)}</div>` : ''}
      ${multi ? `<div class="photo-viewer-counter">${v.idx + 1} / ${v.photos.length}</div>` : ''}
      ${showSetDefault ? `<button class="photo-viewer-default" data-action="set-default-photo" data-fig-id="${esc(figId)}" data-photo-n="${p.n}" title="Use this as the list/grid thumbnail">★ Set as default</button>` : ''}
      ${isAlreadyDefault ? `<div class="photo-viewer-default-badge">★ Default</div>` : ''}
    </div>
    ${multi ? `<button class="photo-viewer-nav next" data-action="photo-viewer-nav" data-dir="1">${icon(ICO.chevR,28)}</button>` : ''}
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
