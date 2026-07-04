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
  S, store, ICO, icon, IMG, LINES, FACTIONS, KIDS_CORE_KEY, CUSTOM_FIGS_KEY,
  STATUSES, STATUS_LABEL, STATUS_COLOR, STATUS_HEX, SUBLINES,
  ln, normalize, esc, _clone, isSelecting,
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
  recordSale, getSoldLog,
} from './data.js';
import { render, toast, haptic, appConfirm, appPromptText, patchFigRow, toastUndo, triggerPulse, renderContent, renderSelectActionbar } from './render.js';
import { checkCompletion } from './eggs.js';

// ── v6.66: in-app variant creation ──────────────────────────────────
// Users can attach their own variants to any catalog figure without the
// standalone editor. The new figure is a local custom record (survives
// AF411 syncs via CUSTOM_FIGS_KEY, same mechanism as v5.04 custom figs)
// carrying variantOf/variantName so it nests under the parent. If invoked
// on a figure that is itself a variant, the new one attaches to the same
// root — no variant-of-variant chains.
// v6.75: keep the figures cache in sync with custom additions so a cold
// start never loses them (belt-and-braces with the boot-merge in app.js).
function _refreshFigCache() {
  try {
    const cached = store.get('motu-figs-cache');
    if (cached) { cached.rows = S.figs; store.set('motu-figs-cache', cached); }
  } catch {}
}

window.addVariant = async (parentId) => {
  const parent = figById(parentId);
  if (!parent) return;
  const root = (parent.variantOf && figById(parent.variantOf)) || parent;
  const raw = await appPromptText(`Add a variant of “${root.name}”`, {
    placeholder: 'Variant name — e.g. Dark Face', ok: 'Add variant',
  });
  if (raw == null) return;
  const nm = raw.trim();
  if (!nm) { toast('Variant name is required'); return; }
  const id = 'custom-var-' + Date.now().toString(36);
  const entry = {
    id,
    name: `${root.name} (${nm})`,
    line: root.line,
    ...(root.group ? { group: root.group } : {}),
    ...(root.wave ? { wave: root.wave } : {}),
    ...(root.year ? { year: root.year } : {}),
    ...(root.retail ? { retail: root.retail } : {}),
    ...(root.faction ? { faction: root.faction } : {}),
    variantOf: root.id,
    variantName: nm,
    slug: '',                 // no repo image — user attaches photos
    source: 'custom-local',
  };
  const arr = store.get(CUSTOM_FIGS_KEY) || [];
  arr.push(entry);
  store.set(CUSTOM_FIGS_KEY, arr);
  S.figs.push({ ...entry, image: '' });
  rebuildFigIndex();
  _refreshFigCache();
  _derived.invalidate();
  haptic && haptic(15);
  toast(`✓ Variant added — “${nm}”`);
  window.openFig?.(id);
};

// ── v6.67: mark a copy sold ─────────────────────────────────────────
// Completes the for-sale lifecycle: prompts for the sale price (prefilled
// from the copy's asking price), records the transaction in the sold log
// for realized-gain stats, and removes the copy. If it was the last copy,
// the figure leaves the collection entirely (status cleared) — selling out
// is the one case where "owned" should genuinely end.
window.markCopySold = async (figId, copyId) => {
  const f = figById(figId);
  const c = S.coll[figId];
  if (!f || !c || !isMigrated(c)) return;
  const cp = c.copies.find(x => x.id === copyId);
  if (!cp) return;
  const raw = await appPromptText(`Sold price for “${f.name}”`, {
    placeholder: 'e.g. 45.00', ok: 'Mark sold', value: cp.asking ? String(cp.asking) : '',
  });
  if (raw == null) return;
  const price = parseFloat(String(raw).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(price) || price < 0) { toast('✗ Enter a valid price'); return; }
  const paid = parseFloat(cp.paid);
  recordSale({
    figId, name: f.name, line: f.line,
    paid: Number.isFinite(paid) ? paid : null,
    price,
    date: new Date().toISOString(),
    variant: cp.variant || f.variantName || '',
  });
  const newCopies = c.copies.filter(x => x.id !== copyId);
  if (newCopies.length === 0) {
    delete S.coll[figId];
    window.logStatusEvent?.(figId, c.status, null);
  } else {
    S.coll[figId] = { ...c, copies: newCopies };
  }
  saveColl();
  _derived.invalidate();
  haptic && haptic(20);
  const profit = Number.isFinite(paid) ? price - paid : null;
  const profitStr = profit == null ? '' :
    ` · ${profit >= 0 ? '+' : '−'}$${Math.abs(profit).toFixed(2)} ${profit >= 0 ? 'profit' : 'loss'}`;
  toast(`✓ Sold for $${price.toFixed(2)}${profitStr}${newCopies.length === 0 ? ' · removed from collection' : ''}`);
  if (newCopies.length === 0 && S.screen === 'figure') render();
  else window.patchDetailStatus?.();
};

// Delete a user-created variant / custom figure (source 'custom-local' only —
// catalog figures are managed by the repo editor). Removes the record, its
// collection entry, and any custom photos.
window.deleteCustomFig = async (figId) => {
  const f = figById(figId);
  if (!f || f.source !== 'custom-local') { toast('Only user-added figures can be deleted here'); return; }
  const ok = await appConfirm(`Delete “${f.name}”? Its photos and collection data are removed too.`, { danger: true, ok: 'Delete' });
  if (!ok) return;
  const arr = (store.get(CUSTOM_FIGS_KEY) || []).filter(x => x.id !== figId && 'custom-' + x.id !== figId);
  store.set(CUSTOM_FIGS_KEY, arr);
  S.figs = S.figs.filter(x => x.id !== figId);
  if (S.coll[figId]) { delete S.coll[figId]; saveColl(); }
  try { await photoStore.delAll(figId); } catch {}
  rebuildFigIndex();
  _refreshFigCache();
  _derived.invalidate();
  if (S.screen === 'figure' && S.activeFig?.id === figId) window.closeDetail?.();
  toast('✓ Deleted');
  render();
};


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

// v6.73 BUG FIX: the long-press timer is module-global but its cancel
// listeners (touchend/touchcancel) live on the row element. When a tap
// triggers a DOM rebuild mid-gesture — e.g. first status change from
// cleared replaces the quick-own button via patchFigRow/render — the
// original touch target is detached, its touchend never propagates, the
// timer survives the tap, and the context menu pops 500ms later. Fix is
// belt-and-braces: a global cancel hook (called by render/patchFigRow,
// which run synchronously inside the very tap that caused the rebuild)
// plus document-level capture listeners as a final net.
window.cancelLongPress = () => {
  if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
};
document.addEventListener('touchend', () => window.cancelLongPress(), { capture: true, passive: true });
document.addEventListener('touchcancel', () => window.cancelLongPress(), { capture: true, passive: true });

function initLongPress(el, figId) {
  // Passive touchstart — do NOT preventDefault here or it kills scrolling.
  // We suppress the Android copy/paste callout via contextmenu instead.
  el.addEventListener('touchstart', e => {
    if (isSelecting()) return;
    // v6.74: never arm the long-press timer when the press starts on an
    // interactive control (status dot, buttons, inputs). Pressing the
    // quick-own dot a beat too long was legitimately crossing the 500ms
    // threshold and popping the row menu — long-press belongs to the row
    // surface, not its controls.
    if (e.target.closest && e.target.closest('button, input, a, .quick-own')) return;
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
    // v6.74: capture the exact node touched. If a patch/render swaps it out
    // mid-gesture (rapid status cycling races the click-driven rebuild),
    // its touchend is dispatched on the detached node and never reaches the
    // row OR the document — no cancel path exists. So instead of relying
    // on cancellation, validate at fire time: a node that left the DOM
    // means this was a tap race, never a deliberate hold.
    const touchedNode = e.target;
    _lpTimer = setTimeout(() => {
      if (_lpMoved) return;
      if (touchedNode && !touchedNode.isConnected) return;
      _lpFired = true;
      haptic(25);
      showContextMenu(figId, lx, ly);
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
    e.preventDefault();  // always block the native callout (incl. on controls)
    if (isSelecting()) return;
    if (e.target.closest && e.target.closest('button, input, a, .quick-own')) return;  // v6.74
    haptic(15);
    showContextMenu(figId, e.clientX, e.clientY);
  });
  // Prevent tap from firing after long-press
  el.addEventListener('click', e => {
    if (_lpFired) { e.stopPropagation(); e.preventDefault(); _lpFired = false; }
  }, {capture: true});
}

// ── v7.12: drag-to-reorder ───────────────────────────────────────────
// Press-drag-release reordering for the Lines tab's line list and a
// line's subline list ("Manage Collections" / the in-line Reorder
// button) — grab the handle, drag, drop, like reordering a queue.
// Pointer Events (not the touchstart/touchmove pattern used elsewhere in
// this file) since this is a self-contained gesture that benefits from
// covering mouse + touch in one handler instead of two.
//
// One delegated listener on `document`, registered once at module load —
// works after every re-render without rebinding, same reasoning as the
// touchend/touchcancel listeners above (§166–184): the container's
// innerHTML is rebuilt on every render(), but document itself never is.
//
// Algorithm: on move, compute how many item-heights the pointer has
// travelled from the drag start and round to the nearest whole slot.
// Every *other* item's displayed position is then derived fresh from that
// slot number vs. its own original index — not accumulated frame to
// frame — so there's no drift no matter how the pointer wanders. Only on
// release do we touch real state: read the final DOM-key order, persist
// it, and render() once.
let _dragState = null;

document.addEventListener('pointerdown', e => {
  if (e.button != null && e.button !== 0) return;   // left-click / touch / pen only
  const handle = e.target.closest('.reorder-handle');
  if (!handle) return;
  const item = handle.closest('[data-reorder-item]');
  const container = item && item.closest('[data-reorder-scope]');
  if (!item || !container) return;
  e.preventDefault();

  const all = [...container.querySelectorAll('[data-reorder-item]')];
  const originalKeys = all.map(el => el.dataset.key);
  const origIndex = all.indexOf(item);
  const itemH = item.getBoundingClientRect().height;
  if (!itemH) return;

  all.forEach(el => { if (el !== item) el.style.transition = 'transform 0.15s ease'; });
  item.style.zIndex = '5';
  item.classList.add('dragging');
  try { item.setPointerCapture(e.pointerId); } catch {}
  haptic(10);

  _dragState = {
    pointerId: e.pointerId, container, all, originalKeys, origIndex, itemH,
    item, startY: e.clientY, lastSlot: origIndex, scrollRAF: null, edgeDir: 0,
  };
}, { passive: false });

function _applyDragTransforms(slot) {
  const { all, item, origIndex } = _dragState;
  all.forEach((el, i) => {
    if (el === item) return;
    let displayIndex = i;
    if (i > origIndex && i <= slot) displayIndex = i - 1;
    else if (i < origIndex && i >= slot) displayIndex = i + 1;
    const offset = (displayIndex - i) * _dragState.itemH;
    el.style.transform = offset ? `translateY(${offset}px)` : '';
  });
}

function _dragAutoScroll() {
  if (!_dragState) return;
  if (_dragState.edgeDir) {
    window.scrollBy(0, _dragState.edgeDir * 12);
    _dragState.scrollRAF = requestAnimationFrame(_dragAutoScroll);
  } else {
    _dragState.scrollRAF = null;
  }
}

document.addEventListener('pointermove', e => {
  if (!_dragState || e.pointerId !== _dragState.pointerId) return;
  const d = _dragState;
  const dy = e.clientY - d.startY;
  d.item.style.transform = `translateY(${dy}px)`;

  const rawSlot = d.origIndex + Math.round(dy / d.itemH);
  const slot = Math.min(Math.max(rawSlot, 0), d.all.length - 1);
  if (slot !== d.lastSlot) {
    haptic(6);
    d.lastSlot = slot;
    _applyDragTransforms(slot);
  }

  // Auto-scroll when dragging near the top/bottom of the viewport.
  const EDGE = 70;
  if (e.clientY < EDGE) d.edgeDir = -1;
  else if (e.clientY > window.innerHeight - EDGE) d.edgeDir = 1;
  else d.edgeDir = 0;
  if (d.edgeDir && !d.scrollRAF) d.scrollRAF = requestAnimationFrame(_dragAutoScroll);
}, { passive: true });

function _dragEnd() {
  if (!_dragState) return;
  const { container, all, item, originalKeys, origIndex, lastSlot, scrollRAF } = _dragState;
  if (scrollRAF) cancelAnimationFrame(scrollRAF);
  all.forEach(el => { el.style.transition = ''; el.style.transform = ''; });
  item.style.zIndex = '';
  item.classList.remove('dragging');
  _dragState = null;

  if (lastSlot === origIndex) return;   // dropped back where it started — no-op
  const finalKeys = originalKeys.filter((_, i) => i !== origIndex);
  finalKeys.splice(lastSlot, 0, originalKeys[origIndex]);
  haptic(15);

  const scope = container.dataset.reorderScope;
  if (scope === 'lines') {
    S.lineOrder = finalKeys;
    store.set('motu-line-order', finalKeys);
  } else if (scope === 'sublines') {
    const lineId = container.dataset.lineId;
    S._localSublineOrder = { ...S._localSublineOrder, [lineId]: finalKeys };
    store.set('motu-subline-order', S._localSublineOrder);
  }
  render();
}
document.addEventListener('pointerup', e => {
  if (_dragState && e.pointerId === _dragState.pointerId) _dragEnd();
}, { passive: true });
document.addEventListener('pointercancel', e => {
  if (_dragState && e.pointerId === _dragState.pointerId) _dragEnd();
}, { passive: true });

// ── v7.24: swipe-to-action on figure list rows ───────────────────────
// v7.22 had two auto-committing tiers (light swipe = Owned, more = 
// Wishlist) plus a reveal-only third tier. Removed per feedback — auto-
// commit-on-release was producing false positives (an imprecise swipe
// distance shouldn't silently change someone's collection). Now there's
// exactly one threshold: swipe far enough and release, the row pins open
// showing all five choices (Owned/Wishlist/Ordered/For Sale/Detail) as
// real buttons. Nothing ever commits without an explicit tap.
//
// Touch events (not the Pointer Events the reorder-drag engine above
// uses) — deliberately matching the direction-lock convention the tab-
// swipe code in this same file already established on #contentArea.
// NOTE: tab-swipe is currently hard-disabled (_swipeAllowed() → false,
// v6.36). If it's ever re-enabled, it listens on the same #contentArea
// these rows live inside and the two WILL need to arbitrate — right now
// there's nothing to arbitrate against, so this doesn't attempt to.
const SWIPE_DEAD   = 10;   // px — jitter tolerance before committing to a direction
const SWIPE_REVEAL = 110;  // past this on release, pin the panel open
const SWIPE_MAX_PAD = 20;  // small rubber-band allowance past the panel's own measured width
// v7.31/v7.32: the pinned-open resting position used to be a hardcoded
// 380px (assumed 5 × 76px fixed-width buttons). v7.31 switched to
// measuring panel.scrollWidth instead — which turned out to be an
// incomplete fix on its own, since the buttons still had a fixed CSS
// width; scrollWidth was just re-deriving the same constant 380px on
// every device, not actually adapting to anything. Still reported as
// offset. The real fix is in vault.css (v7.32): .fig-swipe-btn is now
// flex:1 instead of a fixed width, so the panel always exactly fills
// whatever the row's real rendered width is, by construction — and NOW
// panel.scrollWidth genuinely reflects that, on every device.

let _rowSwipe = null;          // active in-progress gesture state, or null
let _rowSwipeOpenId = null;    // figId of the currently pinned-open row, if any

function _closeSwipeRow(figId, animate = true) {
  if (!figId) return;
  const wrap = document.querySelector(`.fig-row-wrap[data-fig-id="${CSS.escape(figId)}"]`);
  const row = wrap?.querySelector('.fig-row');
  if (row) {
    row.style.transition = animate ? 'transform 0.2s ease' : '';
    row.style.transform = '';
    row.classList.remove('swipe-pinned');
  }
  const panel = wrap?.querySelector('.fig-swipe-panel');
  if (panel) panel.style.visibility = '';   // back to the CSS default (hidden)
  if (_rowSwipeOpenId === figId) _rowSwipeOpenId = null;
}

document.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) return;
  let row = e.target.closest('.fig-row');
  let wrap = row?.closest('.fig-row-wrap');
  if (!wrap) {
    // v7.30 fix: once a row is pinned open, .fig-row is translated out of
    // the way — only a thin sliver of it remains on screen. Most of what's
    // actually visible where the row used to be is the revealed panel
    // (.fig-swipe-panel), which the check above never matched, so a swipe
    // starting there (the natural place to put your finger to close it)
    // was silently ignored. Closing only ever worked as a side effect of
    // starting a touch on a DIFFERENT row. This lets a touch starting on
    // the panel of an ALREADY-PINNED row count too — a plain tap on one of
    // its buttons still works normally, since nothing here calls
    // preventDefault() or takes over unless real horizontal drag distance
    // is detected later in touchmove.
    const panel = e.target.closest('.fig-swipe-panel');
    const panelWrap = panel?.closest('.fig-row-wrap');
    const pinnedRow = panelWrap?.querySelector('.fig-row.swipe-pinned');
    if (!pinnedRow) return;
    wrap = panelWrap;
    row = pinnedRow;
  }
  const figId = wrap.dataset.figId;
  // A touch starting on a DIFFERENT row while one is pinned open closes it
  // first — same convention as a swipe-open email row elsewhere closing
  // when you interact with another one.
  if (_rowSwipeOpenId && _rowSwipeOpenId !== figId) _closeSwipeRow(_rowSwipeOpenId);
  row.style.transition = '';
  const panel = wrap.querySelector('.fig-swipe-panel');
  if (panel) {
    panel.style.visibility = 'visible';   // only reveal on a real touch
    // v7.25: panel markup is now built lazily (render.js no longer bakes
    // it into every row upfront — see the note there). First real touch
    // on a given row builds its 5 buttons once; later touches reuse them.
    if (!panel.childElementCount) panel.innerHTML = window.swipePanelButtonsHtml?.(figId) || '';
  }
  // v7.31: measure now that the panel is guaranteed built (fresh or
  // reused) — this is what SWIPE_PIN used to be a fixed guess for.
  const pinWidth = panel ? panel.scrollWidth : 0;
  _rowSwipe = {
    wrap, row, figId, panel, pinWidth,
    startX: e.touches[0].clientX,
    startY: e.touches[0].clientY,
    dirLocked: null,
    crossedReveal: false,
    wasPinned: row.classList.contains('swipe-pinned'),
    baseX: row.classList.contains('swipe-pinned') ? -pinWidth : 0,
  };
}, { passive: true });

document.addEventListener('touchmove', e => {
  if (!_rowSwipe || e.touches.length !== 1) return;
  const dx = e.touches[0].clientX - _rowSwipe.startX;
  const dy = e.touches[0].clientY - _rowSwipe.startY;
  if (!_rowSwipe.dirLocked) {
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < SWIPE_DEAD && ay < SWIPE_DEAD) return;
    _rowSwipe.dirLocked = (ax > ay * 1.5) ? 'h' : 'v';
  }
  if (_rowSwipe.dirLocked !== 'h') return;
  e.preventDefault();
  const dragged = Math.max(0, Math.min(_rowSwipe.pinWidth + SWIPE_MAX_PAD, -_rowSwipe.baseX - dx));
  _rowSwipe.row.style.transform = `translateX(${-dragged}px)`;
  _rowSwipe.dragged = dragged;
  // Single haptic tick the moment the reveal threshold is crossed (in
  // either direction), same idea as before but with one threshold instead
  // of three — nothing here commits anything, it's purely a feel cue.
  const crossed = dragged >= SWIPE_REVEAL;
  if (crossed !== _rowSwipe.crossedReveal) {
    haptic(crossed ? 8 : 4);
    _rowSwipe.crossedReveal = crossed;
  }
}, { passive: false });

function _rowSwipeEnd() {
  if (!_rowSwipe) return;
  const { row, figId, panel, dirLocked, dragged = 0, wasPinned, pinWidth } = _rowSwipe;
  _rowSwipe = null;
  if (dirLocked !== 'h') return;   // vertical scroll — nothing to settle
  row.style.transition = 'transform 0.2s ease';
  // v7.25 fix: threshold must differ by starting state. A FRESH drag
  // (starting closed) needs SWIPE_REVEAL to pin open — fine. But when
  // RE-dragging an ALREADY-pinned row (closing it), `dragged` measures how
  // much is still revealed, not how much was newly revealed — using the
  // same low SWIPE_REVEAL threshold there meant a normal close-swipe (say,
  // 200px right, leaving dragged=180) stayed above 110 for nearly the
  // entire gesture and just re-pinned instead of closing. Reported: "swipe
  // right to close doesn't work, stays static." Midpoint of the pinned
  // width is the right check for that case instead.
  const threshold = wasPinned ? pinWidth / 2 : SWIPE_REVEAL;
  if (dragged >= threshold) {
    row.style.transform = `translateX(${-pinWidth}px)`;
    row.classList.add('swipe-pinned');
    _rowSwipeOpenId = figId;
  } else {
    row.style.transform = '';
    row.classList.remove('swipe-pinned');
    if (panel) panel.style.visibility = '';
  }
}
document.addEventListener('touchend', _rowSwipeEnd, { passive: true });
document.addEventListener('touchcancel', _rowSwipeEnd, { passive: true });

// A pinned-open row is still tappable on its still-visible sliver (the
// part of .fig-row not covered by the revealed panel) — that should close
// it, not open the detail screen underneath. Capture phase so this runs
// before delegate.js's own click dispatch.
document.addEventListener('click', e => {
  const row = e.target.closest('.fig-row.swipe-pinned');
  if (!row) return;
  const wrap = row.closest('.fig-row-wrap');
  e.preventDefault();
  e.stopPropagation();
  _closeSwipeRow(wrap?.dataset.figId);
}, { capture: true });
window._closeSwipeRow = _closeSwipeRow;

function showContextMenu(figId, x, y) {
  // Prevent the regular tap from firing
  const fig = figById(figId);
  if (!fig) return;
  // v6.74: long-press on Android can also start native text selection in
  // the row (user report: words highlighted under the popup). Kill any
  // selection the gesture produced; CSS user-select:none on rows prevents
  // new ones.
  try { window.getSelection()?.removeAllRanges(); } catch {}
  const c = S.coll[figId] || {};
  dismissContextMenu();
  // v4.86: escape figId for innerHTML onclick interpolation. AF411 slugs are
  // alphanumeric+hyphens in practice, but the pattern is unsafe — any future
  // ID source (import, manual edit) could carry a quote and break out.
  const eFigId = esc(figId);
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
  // v7.09: data-action delegation (was inline onclick="…"). The v7.00 strict
  // CSP (script-src 'self', no 'unsafe-inline') blocks inline handlers, so the
  // entire long-press menu was dead at tap time. eFigId is HTML-escaped; the
  // ctx-* handlers live in delegate-handlers.js.
  STATUSES.forEach(s => {
    const active = c.status === s;
    const dotColor = STATUS_HEX[s];
    items += `<button class="ctx-menu-item ${active ? 'active' : ''}" data-action="ctx-set-status" data-fig-id="${eFigId}" data-status="${s}">
      <span class="ctx-dot" style="background:${dotColor}"></span>
      ${active ? '✓ ' : ''}${STATUS_LABEL[s]}
    </button>`;
  });
  if (c.status) {
    items += `<button class="ctx-menu-item" data-action="ctx-set-status" data-fig-id="${eFigId}" data-status="clear" style="color:var(--t3)">
      <span class="ctx-dot" style="background:var(--bd)"></span>Clear status
    </button>`;
  }
  items += '<div class="ctx-menu-sep"></div>';
  // Quick "Add copy" shortcut for figures that already have at least one copy.
  // Skips opening the detail screen for power users adding multiples in bulk.
  if (c.status === 'owned' || c.status === 'for-sale') {
    items += `<button class="ctx-menu-item" data-action="ctx-add-copy" data-fig-id="${eFigId}">
      ${icon(ICO.import, 16)} Add another copy
    </button>`;
  }
  if (fig.line !== 'kids-core' && fig.line !== 'custom') {
    items += `<button class="ctx-menu-item" data-action="ctx-af411" data-fig-id="${eFigId}">
      ${icon(ICO.export, 16)} View on AF411
    </button>`;
  }
  items += `<button class="ctx-menu-item" data-action="ctx-open" data-fig-id="${eFigId}">
    ${icon(ICO.edit, 16)} ${copyN > 1 ? 'Manage copies' : 'Open details'}
  </button>`;
  // Local edit (override) — for fixing missing/wrong AF411 metadata
  items += `<button class="ctx-menu-item" data-action="ctx-edit-info" data-fig-id="${eFigId}">
    ${icon(ICO.menu, 16)} Edit info…${fig._overridden ? ' <span style="font-size:9px;color:var(--gold);background:color-mix(in srgb,var(--gold) 18%,transparent);padding:1px 5px;border-radius:5px;margin-left:auto">EDITED</span>' : ''}
  </button>`;
  // v6.66: in-app variant creation from long-press
  items += `<button class="ctx-menu-item" data-action="ctx-add-variant" data-fig-id="${eFigId}">
    ${icon(ICO.plus, 16)} Add variant…
  </button>`;
  items += `<button class="ctx-menu-item" data-action="ctx-select" data-fig-id="${eFigId}">
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
    // Always restore bars on back navigation.
    // v6.71 BUG FIX: resetting the flags alone isn't enough. The root-level
    // "press back again to exit" path below doesn't call render(), so the
    // topBar kept its `immersive-hide` CSS class while S.barsHidden was
    // already false — and with the flag false, the scroll-up handler's
    // un-hide branch (gated on S.barsHidden) never fired. Result: permanent
    // blank space where the header should be until the next full render.
    // Reconcile the DOM classes here directly so every popstate path —
    // render or not — leaves the bars actually visible.
    S.barsHidden = false;
    S.searchBarHidden = false;
    {
      const tb = document.getElementById('topBar');
      const bn = document.getElementById('bottomNav');
      const sb = document.getElementById('searchBar');
      if (tb) tb.classList.remove('immersive-hide');
      if (bn) bn.classList.remove('immersive-hide');
      if (sb) sb.classList.remove('hidden');
    }

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
      S._lastDetailFigId = S.activeFig?.id || null;
      S._returningFromDetail = true;
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
    // bars were already force-shown at the top of this handler (v6.71),
    // both flags and CSS classes, so no conditional render is needed here.
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
window.navTo = (key, opts = {}) => {
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
  // v6.33: opts.suppressStagger=true skips the stagger entrance animation.
  // Used by the tab-swipe handler — items are already on screen via the
  // pre-rendered pane, so animating them in again looks janky.
  S._justNavigated = !opts.suppressStagger;
  pushNav();
  render();
};
window.goToLine = id => { S.activeLine = id; S.activeSubline = null; S.tab = 'all'; S.savedScroll = 0; S.searchBarHidden = false; S.barsHidden = false; S._justNavigated = true; pushNav(); render(); };
window.goBack = () => { history.back(); };
window.goHome = () => { S.tab = 'lines'; S.activeLine = null; S.activeSubline = null; S.search = ''; S.savedScroll = 0; S.searchBarHidden = false; S.barsHidden = false; S._justNavigated = true; pushNav(); render(); };
// Home/theme icon tap — always navigates home. Easter eggs are title-tap only.
window.homeIconClick = () => { goHome(); };

// § TAB-SWIPE ── horizontal swipe between top-level tabs ───────────
// v6.33: lets users swipe between Lines / All / Collection seamlessly.
// The destination pane is pre-rendered into a sibling of #contentArea
// so the user actually sees the next tab's content sliding in, not a
// fade-then-load transition.
//
// Constraints (intentional):
//   - Only fires when at top level (no activeLine, no sheet, no
//     photo viewer, no select mode, no editingOrder).
//   - Only fires from horizontal-dominant gestures (>1.5× horizontal
//     vs vertical) so vertical scroll wins ties.
//   - The pre-rendered pane is thrown away after settle; we never
//     accumulate stale DOM.
//   - During transit, the existing scroll handler is suspended so
//     it doesn't get confused by the horizontal motion.
const TAB_ORDER = ['lines', 'all', 'collection'];
let _swipe = null;   // active swipe state — null when not in a swipe

function _swipeAllowed() {
  // v6.36: tab-swipe disabled. Implementation kept intact below in case
  // we revisit; flipping this to an actual condition re-enables it.
  return false;
}
function _swipeAllowed_disabled() {
  return S.tab && TAB_ORDER.includes(S.tab)
    && !S.activeLine && !S.activeSubline
    && !S.sheet && !S.photoViewer
    && !S.selectMode && !S.editingOrder;
}

// v6.33b: cache of pre-rendered neighbor pane HTML, keyed by tab name.
// Built during idle time after each render; consumed at swipe-start so
// touchstart→pane-on-screen is instant rather than waiting on a list
// re-render. Invalidated on any state change that would change a tab's
// content (collection mutation, search change, filter change).
let _neighborCache = { sig: null, html: {} };

function _neighborSig() {
  // Cheap signature that captures everything that would affect what
  // a tab's renderContent returns. Doesn't need to be perfect — a
  // false-cache-miss is harmless (we just re-render at swipe time),
  // a false-cache-hit would show stale content (unacceptable).
  return [
    S.tab,
    S.search || '',
    S.filterLine || '',
    S.filterFaction || '',
    S.filterStatus || '',
    S.filterVariants ? '1' : '',
    S.searchScope || '',
    S.sortBy || '',
    S.viewMode || '',
    // Collection version bumps on any S.coll mutation via _derived
    // invalidation; reading a fresh sortedFigs would re-derive it. Use
    // length as a coarse proxy — gets us a fresh cache on add/remove.
    Object.keys(S.coll || {}).length,
  ].join('|');
}

function _buildNeighborCache() {
  if (!_swipeAllowed()) {
    _neighborCache = { sig: null, html: {} };
    return;
  }
  const sig = _neighborSig();
  if (sig === _neighborCache.sig) return;   // nothing changed
  const idx = TAB_ORDER.indexOf(S.tab);
  const prevTab = idx > 0 ? TAB_ORDER[idx - 1] : null;
  const nextTab = idx < TAB_ORDER.length - 1 ? TAB_ORDER[idx + 1] : null;
  const out = {};
  if (prevTab) out[prevTab] = _renderTabSnapshot(prevTab);
  if (nextTab) out[nextTab] = _renderTabSnapshot(nextTab);
  _neighborCache = { sig, html: out };
}

// Schedule a neighbor-cache build for the next idle window. Cancels any
// previous pending build so we don't stack work.
let _neighborBuildPending = null;
function _scheduleNeighborBuild() {
  if (_neighborBuildPending) {
    if (typeof cancelIdleCallback === 'function') cancelIdleCallback(_neighborBuildPending);
    else clearTimeout(_neighborBuildPending);
  }
  const run = () => { _neighborBuildPending = null; try { _buildNeighborCache(); } catch {} };
  _neighborBuildPending = (typeof requestIdleCallback === 'function')
    ? requestIdleCallback(run, { timeout: 800 })
    : setTimeout(run, 250);
}

function _renderTabSnapshot(tab) {
  // Render the figure list for `tab` without mutating S permanently.
  // renderContent reads S.tab + S.activeLine; flip just S.tab, render,
  // restore. We never touch activeLine because top-level tabs always
  // mean activeLine is null.
  const prevTab = S.tab;
  S.tab = tab;
  // _derived caches by tab implicitly through getStats / getSortedFigs;
  // we want the destination's filtered list, so invalidate before reading.
  if (typeof window._derivedInvalidate === 'function') window._derivedInvalidate();
  const html = window.renderContent ? window.renderContent() : '';
  S.tab = prevTab;
  if (typeof window._derivedInvalidate === 'function') window._derivedInvalidate();
  return html;
}

function _attachSwipe() {
  const ca = document.getElementById('contentArea');
  if (!ca || ca._tabSwipeAttached) return;
  ca._tabSwipeAttached = true;

  let startX = 0, startY = 0;
  let dirLocked = null;   // 'h' | 'v' | null
  let trackEl = null;     // wrapper holding [prev?, current, next?]
  let paneW = 0;
  let activeNeighbors = null;  // {prev, next} both 'tab'|null
  let baseTranslate = 0;
  let originalScrollY = 0;

  function buildTrack(touchX, touchY) {
    paneW = ca.clientWidth;
    const idx = TAB_ORDER.indexOf(S.tab);
    const prevTab = idx > 0 ? TAB_ORDER[idx - 1] : null;
    const nextTab = idx < TAB_ORDER.length - 1 ? TAB_ORDER[idx + 1] : null;
    activeNeighbors = { prev: prevTab, next: nextTab };
    // v6.33b: prefer the pre-rendered neighbor cache (built during idle
    // time after each render). Falls back to live render if the cache
    // is stale or wasn't built — the live render is what made the
    // first-frame delay noticeable, so we go through the cache when we can.
    const cache = _neighborCache && _neighborCache.sig === _neighborSig() ? _neighborCache.html : null;
    // Wrap the existing children of #contentArea (topSpacer + content) into
    // a fixed-width pane, then add neighbor panes on either side.
    const cur = document.createElement('div');
    cur.className = 'tab-swipe-pane current';
    while (ca.firstChild) cur.appendChild(ca.firstChild);
    trackEl = document.createElement('div');
    trackEl.className = 'tab-swipe-track';
    const spH = document.getElementById('topBar')?.offsetHeight || 0;
    if (prevTab) {
      const p = document.createElement('div');
      p.className = 'tab-swipe-pane';
      p.dataset.tab = prevTab;
      const html = (cache && cache[prevTab]) || _renderTabSnapshot(prevTab);
      p.innerHTML = `<div style="height:${spH}px"></div>` + html;
      trackEl.appendChild(p);
    }
    trackEl.appendChild(cur);
    if (nextTab) {
      const p = document.createElement('div');
      p.className = 'tab-swipe-pane';
      p.dataset.tab = nextTab;
      const html = (cache && cache[nextTab]) || _renderTabSnapshot(nextTab);
      p.innerHTML = `<div style="height:${spH}px"></div>` + html;
      trackEl.appendChild(p);
    }
    ca.appendChild(trackEl);
    baseTranslate = prevTab ? -paneW : 0;
    trackEl.style.transform = `translate3d(${baseTranslate}px,0,0)`;
    // Suspend vertical-scroll bar-toggle during transit so it doesn't
    // fight the gesture. Save/restore current scroll so vertical state
    // is preserved when the gesture is cancelled.
    originalScrollY = ca.scrollTop;
    ca.style.overflow = 'hidden';
  }

  function teardown(commitTab) {
    if (!trackEl) return;
    const ca2 = ca;
    if (commitTab && commitTab !== S.tab && TAB_ORDER.includes(commitTab)) {
      // Commit: swap the destination pane content into #contentArea, then
      // call navTo so state + history update without a render-flash. The
      // committed pane already has the right HTML in the DOM, so we lift
      // it out of the track before nav fires its own render.
      // v6.33b: suppressStagger because the items are already on screen
      // (in the pre-rendered destination pane); replaying the entrance
      // animation after navTo's render() looks like a stutter.
      // v6.34: set the sync-build flag so the next neighbor cache build
      // runs synchronously rather than via idle. The user just used the
      // gesture; another swipe is likely coming and we want it instant.
      _neighborBuildSync = true;
      window.navTo?.(commitTab, { suppressStagger: true });
      // navTo calls render() which rebuilds #contentArea; the track was
      // a child, so it's gone now. Done.
    } else {
      // Cancel: restore the original children to ca, drop the track.
      const cur = trackEl.querySelector('.tab-swipe-pane.current');
      if (cur) {
        while (cur.firstChild) ca2.appendChild(cur.firstChild);
      }
      trackEl.remove();
      ca2.style.overflow = '';
      ca2.scrollTop = originalScrollY;
    }
    trackEl = null;
    activeNeighbors = null;
    dirLocked = null;
  }

  ca.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    if (!_swipeAllowed()) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dirLocked = null;
    _swipe = { active: true };
  }, { passive: true });

  ca.addEventListener('touchmove', e => {
    if (!_swipe?.active || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!dirLocked) {
      const ax = Math.abs(dx), ay = Math.abs(dy);
      // Need a few px of motion before we commit a direction. <8px is jitter.
      if (ax < 8 && ay < 8) return;
      // Horizontal commitment: ax must be >1.5× ay for the swipe to take
      // priority over vertical scroll. Otherwise lock to vertical and let
      // the scroll continue uninterrupted for the rest of this gesture.
      if (ax > ay * 1.5) {
        // v6.34: short-circuit when there's no neighbor in the swipe
        // direction. dx > 0 = swiping right (want previous tab); dx < 0 =
        // swiping left (want next tab). Building the track for a no-op
        // swipe means doing the full DOM dance just to rubber-band back —
        // user perceives that as a delay even though nothing should be
        // happening. Better to ignore the gesture entirely and let it
        // pass through (e.g. native pull-to-refresh, Android back gesture).
        const idx = TAB_ORDER.indexOf(S.tab);
        const wantPrev = dx > 0;
        const hasTarget = wantPrev ? (idx > 0) : (idx < TAB_ORDER.length - 1);
        if (!hasTarget) {
          dirLocked = 'v';   // pretend it's vertical so we stop intercepting
          return;
        }
        dirLocked = 'h';
        buildTrack();
      } else {
        dirLocked = 'v';
      }
    }
    if (dirLocked !== 'h' || !trackEl) return;
    // Resist past-edge swipes (rubber-band damping) so the user feels they
    // hit a wall rather than the swipe just snapping back hard.
    let effDx = dx;
    if (!activeNeighbors.prev && dx > 0) effDx = dx * 0.3;
    if (!activeNeighbors.next && dx < 0) effDx = dx * 0.3;
    trackEl.style.transform = `translate3d(${baseTranslate + effDx}px,0,0)`;
    e.preventDefault();
  }, { passive: false });

  function _onEnd() {
    if (!_swipe?.active) return;
    _swipe.active = false;
    if (dirLocked !== 'h' || !trackEl) {
      dirLocked = null;
      return;
    }
    // Read current transform delta from the inline style we set last
    const m = (trackEl.style.transform || '').match(/translate3d\((-?[\d.]+)px/);
    const cur = m ? parseFloat(m[1]) : baseTranslate;
    const dx = cur - baseTranslate;
    const threshold = paneW * 0.30;
    let target = baseTranslate;
    let commit = null;
    if (dx < -threshold && activeNeighbors.next) {
      target = baseTranslate - paneW;
      commit = activeNeighbors.next;
    } else if (dx > threshold && activeNeighbors.prev) {
      target = baseTranslate + paneW;
      commit = activeNeighbors.prev;
    }
    // Animate to target, then teardown.
    trackEl.style.transition = 'transform 0.28s cubic-bezier(0.22, 0.61, 0.36, 1)';
    trackEl.style.transform = `translate3d(${target}px,0,0)`;
    const onDone = () => {
      trackEl?.removeEventListener('transitionend', onDone);
      teardown(commit);
    };
    trackEl.addEventListener('transitionend', onDone);
    // Safety timer in case transitionend doesn't fire (e.g. element
    // detaches before the transition completes).
    setTimeout(onDone, 350);
  }
  ca.addEventListener('touchend', _onEnd, { passive: true });
  ca.addEventListener('touchcancel', _onEnd, { passive: true });
}

// v6.34: when a swipe just committed, the user has clearly demonstrated
// they're using the gesture and another swipe is likely. Build the next
// neighbors synchronously after the render rather than via idle —
// ~30-50ms of extra work that's invisible because we're already mid-
// transition, but it makes the next swipe instant. Tap-driven nav still
// goes through idle so we don't add latency to the tap path.
let _neighborBuildSync = false;

// Re-attach after every render — the previous #contentArea is destroyed
// when render() rewrites innerHTML. Hook into a render-complete signal.
function _reattachSwipeAfterRender() {
  // requestAnimationFrame defers until after the current render's DOM
  // commit, so #contentArea exists. _attachSwipe is idempotent (uses a
  // _tabSwipeAttached flag on the element).
  requestAnimationFrame(() => {
    _attachSwipe();
    // v6.33b: also kick off a neighbor pane pre-render during idle time
    // so the next swipe starts instantly rather than blocking on a fresh
    // render of the destination tab's full list.
    if (_neighborBuildSync) {
      _neighborBuildSync = false;
      try { _buildNeighborCache(); } catch {}
    } else {
      _scheduleNeighborBuild();
    }
  });
}
// The render path doesn't have a hook; observe DOM mutations on #app to
// catch every render. ResizeObserver overkill; MutationObserver on the
// app root is the simplest correct path.
if (typeof MutationObserver !== 'undefined') {
  const _appRoot = document.getElementById('app');
  if (_appRoot) {
    new MutationObserver(_reattachSwipeAfterRender).observe(_appRoot, {
      childList: true, subtree: false,
    });
  }
}
// Initial attach (in case the observer misses the very first render).
_reattachSwipeAfterRender();

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
  // v6.39: helper. Matches setStatus version.
  function _todayMMYYYY() {
    const d = new Date();
    return String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
  }
  const stamp = _todayMMYYYY();
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
      // v6.39: auto-stamp acquired on copy[0] when first becoming owned.
      // Skips entries that already have a date (e.g. transitioning from
      // ordered → owned where the date may have been set during ordering).
      if (status === 'owned' && wasStatus !== 'owned' && next.copies && next.copies[0] && !next.copies[0].acquired) {
        next.copies[0] = { ...next.copies[0], acquired: stamp };
      }
      S.coll[id] = next;
      // v4.87: same ordered→owned migration setStatus/cycleStatus do.
      if (wasStatus === 'ordered' && status === 'owned') migrateOrderedToOwned(id);
    }
    // v6.31: log event for stat history. Same logic as setStatus —
    // captures the transition for the monthly-activity chart.
    if (wasStatus !== (S.coll[id]?.status)) {
      try { window.logStatusEvent?.(id, wasStatus, S.coll[id]?.status); } catch {}
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
    if (extras.acquired) copy.acquired = extras.acquired;
    if (extras.location) copy.location = extras.location;
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

// v6.28: bulk-delete user photos for the selected figures. Stock images
// are untouched. Useful when reorganizing — previously the only delete
// path was per-figure on the detail screen.
// v6.102: batch UPDATE — write filled fields onto each selected figure's
// existing (first) copy rather than appending a new one, so bulk-editing a
// selection never creates duplicate copies. Blank fields are left untouched.
// A figure with no copy yet is promoted to Owned so the details can attach
// (unless the user explicitly picked a non-owned status). Status is changed
// only when explicitly chosen.
window.batchUpdateExisting = (presetCondition = '', extras = {}) => {
  const ids = Array.from(S.selected);
  if (!ids.length) return;
  const _todayMMYYYY = () => { const d = new Date(); return String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear(); };
  const stamp = _todayMMYYYY();

  const copyFields = {};
  if (presetCondition) copyFields.condition = presetCondition;
  if (extras.variant)  copyFields.variant  = extras.variant;
  if (extras.paid)     copyFields.paid     = extras.paid;
  if (extras.acquired) copyFields.acquired = extras.acquired;
  if (extras.location) copyFields.location = extras.location;
  if (extras.notes)    copyFields.notes    = extras.notes;
  const hasCopyFields = Object.keys(copyFields).length > 0;
  const explicit = extras.status || '';

  let updated = 0, promoted = 0, skipped = 0;
  ids.forEach(id => {
    let cur = S.coll[id];
    const wasStatus = cur?.status;
    cur = cur ? (isMigrated(cur) ? { ...cur, copies: [...cur.copies] } : migrateEntry(cur)) : { copies: [] };
    let touched = false;

    // 1) Explicit status change (mirrors batchSetStatus semantics).
    if (explicit) {
      cur.status = explicit;
      if ((explicit === 'owned' || explicit === 'for-sale') && (!cur.copies || !cur.copies.length)) cur.copies = [{ id: 1 }];
      if (explicit === 'owned' && wasStatus !== 'owned' && cur.copies?.[0] && !cur.copies[0].acquired && !copyFields.acquired) {
        cur.copies[0] = { ...cur.copies[0], acquired: stamp };
      }
      touched = true;
    }

    // 2) Copy-field updates — only meaningful for owned / for-sale figures.
    if (hasCopyFields) {
      let ownedish = cur.status === 'owned' || cur.status === 'for-sale';
      // No explicit status + not owned yet ⇒ infer Owned so details can attach.
      if (!ownedish && !explicit) {
        cur.status = 'owned';
        ownedish = true;
        promoted++;
        if (!cur.copies || !cur.copies.length) cur.copies = [{ id: 1 }];
        if (wasStatus !== 'owned' && cur.copies[0] && !cur.copies[0].acquired && !copyFields.acquired) {
          cur.copies[0] = { ...cur.copies[0], acquired: stamp };
        }
      }
      if (ownedish) {
        if (!cur.copies || !cur.copies.length) cur.copies = [{ id: 1 }];
        cur.copies[0] = { ...cur.copies[0], ...copyFields };
        touched = true;
      }
    }

    if (!touched) { skipped++; return; }
    S.coll[id] = cur;
    if (wasStatus === 'ordered' && cur.status === 'owned') migrateOrderedToOwned(id);
    S._recentChanges = [id, ...S._recentChanges.filter(x => x !== id)].slice(0, 10);
    updated++;
  });

  saveColl();
  store.set('motu-recent', S._recentChanges);
  haptic && haptic(25);
  let msg = `✓ Updated ${updated} figure${updated === 1 ? '' : 's'}`;
  if (promoted) msg += ` · ${promoted} marked owned`;
  if (skipped)  msg += ` · ${skipped} skipped`;
  toast(msg);
  render();
};

window.batchDeletePhotos = async () => {
  const ids = Array.from(S.selected);
  if (!ids.length) return;
  let withPhotos = 0, totalPhotos = 0;
  for (const id of ids) {
    const arr = S.customPhotos[id] || [];
    if (arr.length) { withPhotos++; totalPhotos += arr.length; }
  }
  if (totalPhotos === 0) {
    toast('✗ Selected figures have no custom photos');
    return;
  }
  const ok = await appConfirm(
    `Delete ${totalPhotos} custom photo${totalPhotos===1?'':'s'} across ${withPhotos} figure${withPhotos===1?'':'s'}?`,
    { danger: true, ok: 'Delete' }
  );
  if (!ok) return;
  for (const id of ids) {
    try { await photoStore.delAll(id); } catch {}
  }
  haptic && haptic(25);
  toast(`✓ Removed ${totalPhotos} photos`);
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
  // v6.30: Photo viewer keyboard support — Esc closes, arrows navigate.
  // Previously documented as "has its own dismissal flow" but actually had
  // none; desktop users could only click the close button. Single-photo
  // viewers ignore the arrow keys but Esc still works.
  if (S.photoViewer) {
    if (e.key === 'Escape') {
      e.preventDefault();
      window.closePhotoViewer?.();
    } else if (e.key === 'ArrowLeft' && S.photoViewer.photos?.length > 1) {
      e.preventDefault();
      window.photoViewerNav?.(-1);
    } else if (e.key === 'ArrowRight' && S.photoViewer.photos?.length > 1) {
      e.preventDefault();
      window.photoViewerNav?.(1);
    }
    return;
  }
  // Ignore when a sheet or tutorial is open — those have their own dismissal
  // flows (sheet has the close button + backdrop tap; tutorial has its own
  // capture-phase handler).
  if (S.sheet) return;
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

// v6.63: auto-format MM/YYYY date inputs for the Acquired field on figure
// detail. The mobile numeric keyboard doesn't expose the slash, so users
// would type "042026" and get a validation failure. This lifts that pain:
// digits are stripped to MM and YYYY components and reformatted live as
// the user types, with backspace behaving naturally because deleting a
// digit just shifts the partial date one place left.
window.formatAcquired = (el) => {
  if (!el) return;
  const oldVal = el.value || '';
  const oldCaret = el.selectionStart ?? oldVal.length;
  // v6.101: split on the existing slash so editing one segment never cascades
  // into the other. Previously we stripped ALL non-digits and re-split at index
  // 2, so backspacing a month digit ("04/2026" → "0/2026") pulled a year digit
  // into the month ("02/026"); now the two segments stay independent and the
  // slash is only auto-inserted while you're first typing past two month digits.
  const slashIdx = oldVal.indexOf('/');
  const hadSlash = slashIdx >= 0;
  let mm, yyyy;
  if (hadSlash) {
    mm   = oldVal.slice(0, slashIdx).replace(/\D/g, '').slice(0, 2);
    yyyy = oldVal.slice(slashIdx + 1).replace(/\D/g, '').slice(0, 4);
  } else {
    const d = oldVal.replace(/\D/g, '').slice(0, 6);
    mm = d.slice(0, 2);
    yyyy = d.slice(2);
  }
  let next;
  if (hadSlash)           next = mm + '/' + yyyy;   // keep both segments as-is
  else if (mm.length < 2) next = mm;                // still entering the month
  else                    next = mm + '/' + yyyy;   // auto-insert slash after 2 digits
  if (next === oldVal) return;
  // Keep the caret after the same number of digits the user had before it, so a
  // mid-field edit doesn't jump to the end.
  const digitsBefore = oldVal.slice(0, oldCaret).replace(/\D/g, '').length;
  let pos = 0, seen = 0;
  while (pos < next.length && seen < digitsBefore) {
    const cc = next.charCodeAt(pos);
    if (cc >= 48 && cc <= 57) seen++;
    pos++;
  }
  if (next[pos] === '/') pos++;   // don't land just before the slash
  el.value = next;
  try { el.setSelectionRange(pos, pos); } catch {}
};

// ── Exports ─────────────────────────────────────────────────
export {
  initLongPress, showContextMenu, dismissContextMenu, navState, pushNav, restoreNav
};
