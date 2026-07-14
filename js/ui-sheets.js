// ── Lazy shims for window-only handlers (resolve at call time) ──
const batchAddCopy = (...a) => window.batchAddCopy?.(...a);
const batchUpdateExisting = (...a) => window.batchUpdateExisting?.(...a);
const closeSheet = (...a) => window.closeSheet?.(...a);
const refreshEditSheet = (...a) => window.refreshEditSheet?.(...a);

// ════════════════════════════════════════════════════════════════════
// MOTU Vault — ui-sheets.js
// ────────────────────────────────────────────────────────────────────
// Sheet renderers: filter, sort, import, batch-edit, edit-figure,
// theme, menu. The dispatcher is renderSheet(); each S.sheet value
// routes to a specific render function.
// ════════════════════════════════════════════════════════════════════

import {
  S, store, ICO, icon, IMG, THEMES, LINES, FACTIONS, STATUSES,
  STATUS_LABEL, STATUS_COLOR, STATUS_HEX, ACCESSORIES, CONDITIONS,
  SUBLINES, SERIES_MAP, GROUP_MAP, CACHE_KEY,
  ln, normalize, esc, jsArg, _clone, getThemeTitles,
} from './state.js';
import { bigGet } from './idb-store.js';
import {
  MAX_PHOTOS, photoStore, photoURLs,
} from './photos.js';
import {
  figById, figIsHidden, getStats, getSortedFigs, getLineStats,
  hasFilters, getOverrideField, getOverridesFor, getAccAvail, totalCopyCount,
  entryCopyCount, getPrimaryCopy, copyVariant, copyCondition,
  copyPaid, copyNotes, getAllLocations,
  renderExportSheet, renderSheetBody,
  renderAccessoryPickerSheet, SETTINGS_KEYS,
  _derived, clearOverrides, backupDue, getBackupMeta,
} from './data.js';
import {
  renderKidsCoreAdminSheet,
  renderContent, render, appConfirm,
} from './render.js';
import {
  renderQR, renderShareSheet,
  renderWantListViewSheet, buildShareURL,
} from './share.js';
import { renderStatsSheet } from './stats.js';
import { pushNav } from './handlers.js';

// § RENDER-SHEETS ── renderSheet, filter/sort/import/export/theme/menu/stats/edit/batch/share sheets ──
// v7.60: the sheet-body builder, extracted from renderSheet so a sheet can
// refresh ITS OWN body without a full app render. Full render() rebuilds
// everything behind the overlay (the app visibly repaints "in the
// background") and replaces the sheet wholesale, losing scroll position —
// user-reported as "clicking [the found circle] refreshes the whole page
// and resets you to the top".
function buildSheetBody() {
  let body = '';
  if (S.sheet === 'filter') body = renderFilterSheet();
  else if (S.sheet === 'sort') body = renderSortSheet();
  else if (S.sheet === 'import') body = renderImportSheet();
  else if (S.sheet === 'export') body = renderExportSheet();
  else if (S.sheet === 'theme') body = renderThemeSheet();
  else if (S.sheet === 'menu') body = renderMenuSheet();
  else if (S.sheet === 'stats') body = renderStatsSheet();
  else if (S.sheet === 'edit') body = renderEditFigureSheet();
  else if (S.sheet === 'batch') body = renderBatchEditSheet();
  else if (S.sheet === 'share') body = renderShareSheet();
  else if (S.sheet === 'wantListView') body = renderWantListViewSheet();
  else if (S.sheet === 'kidsCoreAdmin') body = renderKidsCoreAdminSheet();
  else if (S.sheet === 'accessoryPicker') body = renderAccessoryPickerSheet();
  else if (S.sheet === 'pricing') body = renderPricingSheet();
  else if (S.sheet === 'wishlistHistory') body = renderWishlistHistorySheet();
  else if (S.sheet === 'about') body = renderAboutSheet();
  else if (S.sheet === 'locations') body = renderLocationsSheet();
  return body;
}

// Scroll-preserving in-place refresh of the open sheet's body. Bridged to
// window for share.js / delegate handlers.
function refreshSheetBody() {
  const el = document.querySelector('.sheet-body');
  if (!el || !S.sheet) { render(); return; }
  const top = el.scrollTop;
  const body = buildSheetBody();
  if (!body) { render(); return; }   // unknown sheet → let renderSheet's fallback handle it
  el.innerHTML = body;
  el.scrollTop = top;
}
window.refreshSheetBody = refreshSheetBody;

function renderSheet() {
  const titles = {filter:'Filter', sort:'Sort By', import:'Import', export:'Export / Backup', theme:'Theme', menu:'Settings', stats:'Collection Stats', edit:'Edit Figure Info', batch:'Edit Selected Figures', share:'Share Want List', wantListView:'Want List', kidsCoreAdmin:'Kids Core — Add Figure', accessoryPicker:'Accessories', pricing:'Pricing Backend', wishlistHistory:'Viewed Wishlists', about:'About', locations:'Locations'};
  let body = buildSheetBody();

  // v6.30: Defensive fallback. If a deep link / shortcut / typo lands us on
  // an unknown sheet name, S.sheet is set but no body renders. Without this,
  // the user sees a blank sheet with no way to understand what's wrong.
  if (!body && S.sheet) {
    body = `<div style="text-align:center;padding:32px 16px">
      <div style="font-size:32px;margin-bottom:12px">🤔</div>
      <div style="font-size:14px;color:var(--t2);margin-bottom:8px">Nothing to show here</div>
      <div style="font-size:12px;color:var(--t3)">Tap outside to close.</div>
    </div>`;
  }

  return `<div class="sheet-overlay" id="sheetOverlay" data-action="close-sheet-bg">
    <div class="sheet-backdrop"></div>
    <div class="sheet-panel">
      <div class="sheet-handle"><div class="sheet-handle-bar"></div></div>
      <div class="sheet-header">
        <div class="sheet-title">${titles[S.sheet]||'Options'}</div>
        <button class="sheet-close" data-action="close-sheet">${icon(ICO.x,20)}</button>
      </div>
      <div class="sheet-body">${body}</div>
      ${S.sheet === 'wantListView' ? `<div class="sheet-footer" style="text-align:center">
        <!-- v7.60 (user request): the pitch + history links returned. Closing
             the sheet lands the visitor in the full app they're already
             running — the cheapest "try it yourself" there is. -->
        <!-- v7.61: "Past want lists" removed on user request; the history
             sheet remains reachable from Settings as before. -->
        <button data-action="close-sheet" style="display:inline-block;padding:10px 20px;border-radius:10px;background:var(--acc);color:var(--btn-t);border:none;font-size:13px;font-weight:700;margin:0 4px 8px">Track your own collection — free</button>
        <div style="font-size:12px;color:var(--t3);margin-top:4px"><a href="https://www.actionfigure411.com/masters-of-the-universe/" target="_blank" rel="noopener" style="color:var(--t2)">Browse the full MOTU catalog on AF411 →</a></div>
      </div>` : ''}
    </div>
  </div>`;
}

// ── v6.68: Locations browser ─────────────────────────────────────────
// Top level: every distinct copy location with figure/copy counts.
// Drill-down (S._locView): the figures whose copies live there, with
// per-copy condition; tap a row to open the figure's detail screen.
// Helps physically find figures and doubles as a shelf/bin inventory.
function _locIndex() {
  const map = new Map(); // location → [{fig, copies:[cp,…]}]
  for (const id in S.coll) {
    const e = S.coll[id];
    if (!e || !Array.isArray(e.copies)) continue;
    const f = figById(id);
    if (!f || figIsHidden(f)) continue;
    const byLoc = {};
    for (const cp of e.copies) {
      if (!cp || !cp.location) continue;
      (byLoc[cp.location] = byLoc[cp.location] || []).push(cp);
    }
    for (const loc in byLoc) {
      const arr = map.get(loc) || [];
      arr.push({ fig: f, copies: byLoc[loc] });
      map.set(loc, arr);
    }
  }
  return map;
}

function renderLocationsSheet() {
  const idx = _locIndex();
  if (S._locView && idx.has(S._locView)) {
    const entries = idx.get(S._locView).sort((a, b) => a.fig.name.localeCompare(b.fig.name));
    let h = `<button data-action="loc-sheet-back" style="display:inline-flex;align-items:center;gap:6px;padding:8px 12px;margin-bottom:12px;border-radius:10px;border:1px solid var(--bd);background:var(--bg3);color:var(--t2);font-size:12px;font-weight:600">‹ All locations</button>
      <div style="font-family:'Cinzel',serif;font-size:16px;font-weight:700;color:var(--gold);margin-bottom:10px">${esc(S._locView)}</div>`;
    entries.forEach(({ fig, copies }) => {
      const img = (S.customPhotos[fig.id] && photoStore.get(fig.id)) || (!S.imgErrors[fig.id] && fig.image) || '';
      const condStr = copies.map(cp => cp.condition).filter(Boolean).join(', ');
      h += `<button data-action="loc-open-fig" data-fig-id="${esc(fig.id)}" style="width:100%;display:flex;align-items:center;gap:12px;padding:9px 0;border:none;background:none;border-bottom:1px solid color-mix(in srgb, var(--bd) 30%, transparent);text-align:left;cursor:pointer">
        <div style="width:40px;height:40px;border-radius:8px;overflow:hidden;background:var(--bg3);flex-shrink:0;display:flex;align-items:center;justify-content:center">
          ${img ? `<img src="${esc(img)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">` : `<span style="font-family:'Cinzel',serif;color:var(--t3);font-size:16px">${esc(fig.name[0])}</span>`}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--t1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(fig.name)}${copies.length > 1 ? ` <span style="color:var(--gold);font-size:11px">×${copies.length}</span>` : ''}</div>
          ${condStr ? `<div style="font-size:11px;color:var(--t3)">${esc(condStr)}</div>` : ''}
        </div>
        <span style="color:var(--t3)">${icon(ICO.chevR, 14)}</span>
      </button>`;
    });
    return h;
  }
  // Top level
  const locs = [...idx.keys()].sort((a, b) => a.localeCompare(b));
  if (!locs.length) {
    return `<div style="text-align:center;padding:28px 12px;color:var(--t3);font-size:13px">No locations yet.<br>Set a copy's Location field on any figure's detail screen and it'll show up here.</div>`;
  }
  let h = `<div style="font-size:12px;color:var(--t3);margin-bottom:12px">Where your figures physically live — tap a location to see what's there.</div>`;
  locs.forEach(loc => {
    const entries = idx.get(loc);
    const copies = entries.reduce((n, e) => n + e.copies.length, 0);
    h += `<button data-action="loc-drill" data-loc="${esc(loc)}" style="width:100%;display:flex;align-items:center;gap:12px;padding:13px 0;border:none;background:none;border-bottom:1px solid color-mix(in srgb, var(--bd) 30%, transparent);text-align:left;cursor:pointer">
      <span style="color:var(--acc)">${icon(ICO.box || ICO.tag, 18)}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600;color:var(--t1)">${esc(loc)}</div>
        <div style="font-size:11px;color:var(--t3)">${entries.length} figure${entries.length === 1 ? '' : 's'}${copies !== entries.length ? ` · ${copies} copies` : ''}</div>
      </div>
      <span style="color:var(--t3)">${icon(ICO.chevR, 14)}</span>
    </button>`;
  });
  return h;
}

// In-place drill-down — same pattern as patchFilter (sheet body only).
window.patchLocSheet = (loc) => {
  S._locView = loc;
  const body = document.querySelector('.sheet-body');
  if (body && S.sheet === 'locations') body.innerHTML = renderLocationsSheet();
};

function renderMenuSheet() {
  const menuItems = [
    {label:'Collection Stats',    icon:ICO.heart,   action:'open-sheet', sheet:'stats'},
    {label:'Share Want List',     icon:ICO.share,   action:'open-sheet', sheet:'share'},
    {label:'Theme',               icon:ICO.palette, action:'open-sheet', sheet:'theme'},
    {label:'Manage Collections',  icon:ICO.sort,    action:'menu-manage-collections'},
    {label:'Import',              icon:ICO.import,  action:'open-sheet', sheet:'import'},
    {label:'Export / Backup' + (backupDue() ? ` <span style="font-size:9px;font-weight:700;color:var(--bg);background:var(--gold);padding:2px 7px;border-radius:99px;vertical-align:1px">${getBackupMeta().changes} UNSAVED</span>` : ''), icon:ICO.export, action:'open-sheet', sheet:'export'},
    {label:'Pricing Backend',     icon:ICO.tag,     action:'open-sheet', sheet:'pricing'},
  ];
  // v6.68: Locations browser — only shown once at least one copy has a
  // location set, mirroring the Viewed Wishlists pattern below.
  const _locs = getAllLocations();
  if (_locs.length) {
    menuItems.splice(3, 0, {
      label: `Locations (${_locs.length})`,
      icon: ICO.box || ICO.tag,
      action: 'menu-open-locations',
    });
  }
  // v7.29: the conditional "Manage Sublines" menu item (v7.15-v7.17) is
  // gone — replaced by a "Sublines" drill-in button directly on each row
  // inside line-reorder mode (Manage Collections → tap a line's Sublines
  // button). That's one menu entry instead of two, and doesn't require
  // already knowing you have to navigate into a line first before the
  // option even appears — the exact discoverability complaint that
  // prompted this change.
  // v6.31: insert "Viewed Wishlists" only when there's at least one entry,
  // so new users don't see an empty option that won't do anything.
  const wlHistory = (typeof window.getWishlistHistory === 'function') ? window.getWishlistHistory() : [];
  if (wlHistory.length) {
    menuItems.push({
      label: `Viewed Wishlists (${wlHistory.length})`,
      icon: ICO.box || ICO.heart,
      action: 'open-sheet', sheet: 'wishlistHistory',
    });
  }
  let html = menuItems.map(m => `
    <button data-action="${esc(m.action)}" ${m.sheet ? `data-sheet="${esc(m.sheet)}"` : ''} style="width:100%;display:flex;align-items:center;gap:14px;padding:16px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);margin-bottom:10px;text-align:left;font-size:15px;color:var(--t1)">
      <span style="color:var(--acc)">${icon(m.icon, 20)}</span>
      ${m.label}
      <span style="margin-left:auto;color:var(--t3)">${icon(ICO.chevR, 16)}</span>
    </button>`).join('');
  const ptrOn = !!store.get('motu-ptr-enabled');
  html += `<div style="height:1px;background:var(--bd);margin:14px 4px"></div>
    <div class="text-xs text-upper text-dim" style="padding:0 4px 8px;letter-spacing:1.2px">Sync</div>
    <button data-action="toggle-ptr" style="width:100%;display:flex;align-items:center;gap:14px;padding:16px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);margin-bottom:10px;text-align:left;font-size:15px;color:var(--t1)">
      <span style="color:var(--acc)">${icon(ICO.refresh || ICO.sort, 20)}</span>
      <span style="flex:1">Pull-to-refresh
        <span style="display:block;font-size:11px;color:var(--t3);font-weight:400;margin-top:2px;line-height:1.4">Pull down at the top of the list to sync. Off by default to avoid accidental refreshes.</span>
      </span>
      <span style="padding:5px 11px;border-radius:999px;background:${ptrOn?'var(--gn)':'var(--bg2)'};color:${ptrOn?'var(--bg)':'var(--t3)'};font-size:11px;font-weight:700">${ptrOn?'ON':'OFF'}</span>
    </button>`;
  // v6.28: Help section — replay the tutorial. Previously the only entry
  // point was the dismissable banner on the Lines screen, which became
  // unreachable once dismissed. Tutorial state is read via the same
  // window.tutorialState() helper used by renderLinesGrid.
  const tState = (typeof window.tutorialState === 'function') ? window.tutorialState() : { seen: false };
  const tourLabel = tState.seen ? 'Replay 1-minute tour' : 'Take the 1-minute tour';
  html += `<div style="height:1px;background:var(--bd);margin:14px 4px"></div>
    <div class="text-xs text-upper text-dim" style="padding:0 4px 8px;letter-spacing:1.2px">Help</div>
    <button data-action="menu-start-tutorial" style="width:100%;display:flex;align-items:center;gap:14px;padding:16px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);margin-bottom:10px;text-align:left;font-size:15px;color:var(--t1)">
      <span style="color:var(--acc);font-size:18px">🎓</span>
      <span style="flex:1">${tourLabel}</span>
      <span style="margin-left:auto;color:var(--t3)">${icon(ICO.chevR, 16)}</span>
    </button>
    <button data-action="open-sheet" data-sheet="about" style="width:100%;display:flex;align-items:center;gap:14px;padding:16px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);margin-bottom:10px;text-align:left;font-size:15px;color:var(--t1)">
      <span style="color:var(--acc);font-size:18px">ⓘ</span>
      <span style="flex:1">About MOTU Collector</span>
      <span style="margin-left:auto;color:var(--t3)">${icon(ICO.chevR, 16)}</span>
    </button>`;
  return html;
}

function renderPricingSheet() {
  // v6.28: configure the pricing backend URL + optional API key. The Worker
  // README walks through deployment; this sheet is the client-side pairing.
  const cfg = (typeof window.getPricingBackend === 'function') ? window.getPricingBackend() : null;
  const configured = !!cfg;
  return `<div class="text-sm text-dim" style="line-height:1.5;margin-bottom:14px">
    Connect to a pricing backend to see recent-sold averages on each figure's detail screen.
    The app caches results for 24 hours and refreshes in the background.
    See the README in the <code>backend/</code> folder for deployment.
  </div>
  <div class="field-label text-dim text-sm">Backend URL</div>
  <input id="pricingBackendUrl" type="url" inputmode="url" autocomplete="off" autocapitalize="off"
    spellcheck="false" placeholder="https://motu-vault-pricing.example.workers.dev"
    value="${esc(cfg?.url || '')}"
    style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--bd);background:var(--bg2);color:var(--t1);font-family:ui-monospace,monospace;font-size:13px;margin-bottom:12px">
  <div class="field-label text-dim text-sm">API Key (optional)</div>
  <input id="pricingBackendKey" type="password" autocomplete="off" placeholder="${configured && cfg.hasKey ? '••••••••' : 'Leave blank if your backend is public'}"
    style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--bd);background:var(--bg2);color:var(--t1);font-family:ui-monospace,monospace;font-size:13px;margin-bottom:14px">
  <div style="display:flex;gap:8px">
    <button data-action="save-pricing-backend" style="flex:1;padding:12px;border-radius:10px;border:none;background:var(--acc);color:var(--btn-t);font-size:14px;font-weight:700">Save & test</button>
    ${configured ? `<button data-action="disconnect-pricing-backend" style="padding:12px 16px;border-radius:10px;border:1px solid var(--rd);background:color-mix(in srgb,var(--rd) 10%,transparent);color:var(--rd);font-size:14px;font-weight:600">Disconnect</button>` : ''}
  </div>
  ${configured ? `<button data-action="clear-pricing-cache" style="width:100%;margin-top:10px;padding:10px;border-radius:10px;border:1px solid var(--bd);background:var(--bg3);color:var(--t2);font-size:13px;font-weight:500">Clear pricing cache</button>` : ''}`;
}

window.savePricingBackend = async () => {
  const urlInput = document.getElementById('pricingBackendUrl');
  const keyInput = document.getElementById('pricingBackendKey');
  const url = (urlInput?.value || '').trim();
  const key = (keyInput?.value || '').trim();
  if (!url) {
    window.toast?.('✗ Backend URL is required');
    return;
  }
  try {
    window.configurePricingBackend(url, key);
  } catch (e) {
    window.toast?.('✗ ' + e.message);
    return;
  }
  // Quick health check — hit /health and report. Don't block on it.
  let healthOk = false;
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/health', { headers: key ? { Authorization: 'Bearer ' + key } : {} });
    healthOk = res.ok;
  } catch {}
  window.toast?.(healthOk ? '✓ Pricing backend connected' : '⚠ Saved, but health check failed');
  // Re-render the sheet so Disconnect/Clear-cache appear
  const body = document.querySelector('.sheet-body');
  if (body && S.sheet === 'pricing') body.innerHTML = renderPricingSheet();
};

window.disconnectPricingBackend = () => {
  window.configurePricingBackend('');
  window.clearPricingCache?.();
  window.toast?.('✓ Disconnected');
  const body = document.querySelector('.sheet-body');
  if (body && S.sheet === 'pricing') body.innerHTML = renderPricingSheet();
};

// v6.31: About sheet. Surfaces version, repo/issues link, credits, and
// license. Uses masters_logo.png for visual polish at the top.
// v6.32: plays main-theme.mp3 in the background while the sheet is
// open. <audio loop> rather than Web Audio buffer because looping a
// 60+ second track via buffer source forces the whole file into memory
// and offers no streaming. Mute state persisted per-user.
const ABOUT_MUTE_KEY = 'motu-about-mute';
let _aboutAudioEl = null;
function _stopAboutMusic() {
  if (_aboutAudioEl) {
    try { _aboutAudioEl.pause(); _aboutAudioEl.currentTime = 0; } catch {}
    try { _aboutAudioEl.remove(); } catch {}
    _aboutAudioEl = null;
  }
}
function _startAboutMusic() {
  // Defensive: never stack multiple instances. Stop any previous one first.
  _stopAboutMusic();
  // Default-mute when the user has reduced-motion turned on (many people
  // with auditory sensitivities also have this set, and this respects them
  // without an explicit "audio" preference key).
  const prefersReduced = (typeof matchMedia === 'function')
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const userMuted = !!store.get(ABOUT_MUTE_KEY);
  const muted = userMuted || prefersReduced;
  const a = document.createElement('audio');
  a.src = 'main-theme.mp3';
  a.loop = true;
  a.preload = 'auto';
  a.volume = 0.4;
  a.muted = muted;
  a.style.display = 'none';
  document.body.appendChild(a);
  _aboutAudioEl = a;
  // Autoplay can still reject (e.g. iOS lockscreen, Low Power Mode).
  // Failure is silent — the mute button on screen lets the user try again.
  a.play().catch(() => {});
}
// Toggle mute. Returns the new muted state for the UI to reflect.
window.toggleAboutMute = () => {
  if (!_aboutAudioEl) return true;
  const next = !_aboutAudioEl.muted;
  _aboutAudioEl.muted = next;
  store.set(ABOUT_MUTE_KEY, next);
  // Re-render the button label/icon
  const btn = document.querySelector('[data-action="toggle-about-mute"]');
  if (btn) btn.innerHTML = next ? '🔇 Unmute' : '🔊 Mute';
  // If we just unmuted but autoplay was previously rejected, calling play()
  // here from a user gesture works.
  if (!next && _aboutAudioEl.paused) {
    _aboutAudioEl.play().catch(() => {});
  }
  return next;
};

function renderAboutSheet() {
  // Pulled from the version display string in render.js so it's the
  // single source of truth.
  const verMatch = document.querySelector('.logo-subtitle')?.textContent?.match(/v\d+\.\d+/);
  const version = verMatch ? verMatch[0] : 'unknown';
  const userMuted = !!store.get(ABOUT_MUTE_KEY);
  // Kick off the audio element. Done from inside the renderer (which
  // runs because openSheet → render → renderSheet → renderAboutSheet)
  // so we have the user-gesture context autoplay needs.
  setTimeout(() => _startAboutMusic(), 0);
  return `<div style="text-align:center;padding:0 0 8px;position:relative">
    <button data-action="toggle-about-mute"
      title="${userMuted ? 'Unmute background music' : 'Mute background music'}"
      style="position:absolute;top:0;right:0;padding:6px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--bg3);color:var(--t2);font-size:12px;font-weight:600;cursor:pointer;z-index:1">
      ${userMuted ? '🔇 Unmute' : '🔊 Mute'}
    </button>
    <img src="${IMG}/masters_logo.png" alt="Masters of the Universe"
      data-error-action="img-hide"
      style="max-width:240px;width:75%;height:auto;margin:0 auto 16px;display:block;filter:drop-shadow(0 4px 14px rgba(0,0,0,0.5))">
    <div class="font-display text-gold" style="font-size:24px;letter-spacing:1.5px;margin-bottom:4px">MOTU COLLECTOR</div>
    <div style="font-size:12px;color:var(--t3);letter-spacing:0.5px">Version ${esc(version)}</div>
  </div>

  <div style="margin:20px 0 14px;padding:14px 16px;background:var(--bg3);border:1px solid var(--bd);border-radius:12px;line-height:1.55;font-size:13px;color:var(--t2)">
    A catalog and collection tracker for Masters of the Universe action figures.
    Mark what you own, build a wishlist, share it with friends, and track copies,
    accessories, and prices paid — all stored on your device, no account needed.
  </div>

  <div class="text-xs text-upper text-dim" style="padding:0 4px 8px;letter-spacing:1.2px;margin-top:18px">Links</div>
  <a href="https://motucollector.app/" target="_blank" rel="noopener noreferrer"
    style="width:100%;display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);margin-bottom:8px;text-decoration:none;color:var(--t1);font-size:14px">
    <span style="color:var(--acc);font-size:16px">⌂</span>
    <div style="flex:1">
      <div style="font-weight:600">GitHub Repository</div>
      <div style="font-size:11px;color:var(--t3);margin-top:2px">motucollector.app</div>
    </div>
    <span style="color:var(--t3)">↗</span>
  </a>
  <a href="https://github.com/shkankin/motu-images/issues" target="_blank" rel="noopener noreferrer"
    style="width:100%;display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);margin-bottom:8px;text-decoration:none;color:var(--t1);font-size:14px">
    <span style="color:var(--acc);font-size:16px">⚑</span>
    <div style="flex:1">
      <div style="font-weight:600">Report a Bug / Request a Feature</div>
      <div style="font-size:11px;color:var(--t3);margin-top:2px">Opens GitHub Issues</div>
    </div>
    <span style="color:var(--t3)">↗</span>
  </a>

  <div class="text-xs text-upper text-dim" style="padding:0 4px 8px;letter-spacing:1.2px;margin-top:18px">Credits</div>
  <div style="padding:14px 16px;background:var(--bg3);border:1px solid var(--bd);border-radius:12px;margin-bottom:8px;line-height:1.7;font-size:13px;color:var(--t2)">
    <div><span style="color:var(--t3);width:80px;display:inline-block">Built by</span> <span style="color:var(--t1);font-weight:600">Brand-or, Defender of the Stash</span></div>
    <div><span style="color:var(--t3);width:80px;display:inline-block">Catalog</span> <a href="https://www.actionfigure411.com/masters-of-the-universe/" target="_blank" rel="noopener noreferrer" style="color:var(--acc);text-decoration:none">ActionFigure411</a></div>
    <div><span style="color:var(--t3);width:80px;display:inline-block">With</span> <span style="color:var(--t1)">Claude (Anthropic) as a coding collaborator</span></div>
  </div>

  <div class="text-xs text-upper text-dim" style="padding:0 4px 8px;letter-spacing:1.2px;margin-top:18px">License</div>
  <div style="padding:14px 16px;background:var(--bg3);border:1px solid var(--bd);border-radius:12px;margin-bottom:8px;font-size:12px;color:var(--t2);line-height:1.55">
    <div style="font-weight:600;color:var(--t1);margin-bottom:6px">CC BY-NC 4.0</div>
    Free to use, share, and modify for personal or non-commercial purposes.
    Please credit the original work. Not for sale or commercial redistribution.
    <a href="https://creativecommons.org/licenses/by-nc/4.0/" target="_blank" rel="noopener noreferrer" style="color:var(--acc);text-decoration:none;display:block;margin-top:8px;font-size:11px">View full license terms ↗</a>
  </div>

  <div class="text-xs text-upper text-dim" style="padding:0 4px 8px;letter-spacing:1.2px;margin-top:18px">Privacy</div>
  <div style="padding:14px 16px;background:var(--bg3);border:1px solid var(--bd);border-radius:12px;margin-bottom:8px;font-size:12px;color:var(--t2);line-height:1.55">
    Your collection lives in your browser's local storage. Nothing is sent
    to any server unless you explicitly configure a pricing backend (see
    Settings → Pricing Backend). Backups stay on your device.
  </div>

  <div style="text-align:center;padding:20px 0 8px;color:var(--t3);font-size:11px;letter-spacing:0.5px">
    Masters of the Universe is a trademark of Mattel.<br>
    This is an unofficial fan-made tool, not affiliated with Mattel.
  </div>`;
}
// Stop the music whenever the About sheet leaves the screen. Two paths
// to cover:
//   1. User taps the X button or backdrop → window.closeSheet → history.back
//   2. User uses the OS back gesture / hardware back → popstate directly
// Both paths flip S.sheet, so we hook popstate (which fires for both) and
// kill audio if the about sheet is no longer current.
window.addEventListener('popstate', () => {
  if (_aboutAudioEl && S.sheet !== 'about') _stopAboutMusic();
});

// v6.31: Wishlist history sheet. Lists previously-viewed shared want
// lists with timestamps, names of the first few figures, and a
// re-open button for each.
function renderWishlistHistorySheet() {
  const arr = (typeof window.getWishlistHistory === 'function') ? window.getWishlistHistory() : [];
  if (!arr.length) {
    return `<div style="text-align:center;padding:32px 16px">
      <div style="font-size:32px;margin-bottom:12px">📋</div>
      <div style="font-size:15px;font-weight:600;color:var(--t1);margin-bottom:6px">No viewed wishlists</div>
      <div style="font-size:13px;color:var(--t3);line-height:1.5">When you scan a friend's QR code or open a shared want-list link, it'll be saved here so you can revisit it.</div>
    </div>`;
  }
  const fmtAge = (t) => {
    const ms = Date.now() - t;
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    const mo = Math.floor(d / 30);
    return `${mo}mo ago`;
  };
  let html = `<div class="text-sm text-dim" style="margin-bottom:12px;line-height:1.5">${arr.length} previously-viewed wishlist${arr.length===1?'':'s'}. Tap to re-open.</div>`;
  arr.forEach((entry, idx) => {
    const namesPreview = (entry.names || []).slice(0, 3).join(', ');
    const more = entry.figCount > 3 ? ` +${entry.figCount - 3} more` : '';
    html += `<div style="display:flex;align-items:center;gap:10px;padding:12px;background:var(--bg3);border:1px solid var(--bd);border-radius:10px;margin-bottom:8px">
      <button data-action="reopen-wishlist" data-idx="${idx}" style="flex:1;background:none;border:none;text-align:left;padding:0;color:var(--t1);cursor:pointer">
        <div style="font-size:13px;font-weight:600;color:var(--t1);margin-bottom:3px">${entry.figCount} figure${entry.figCount===1?'':'s'}</div>
        <div style="font-size:11px;color:var(--t3);line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(namesPreview)}${more}</div>
        <div style="font-size:10px;color:var(--t3);margin-top:4px">${fmtAge(entry.viewedAt)}</div>
      </button>
      <button data-action="delete-wishlist-entry" data-idx="${idx}" title="Remove from history" style="flex-shrink:0;width:32px;height:32px;border-radius:8px;border:1px solid var(--bd);background:var(--bg2);color:var(--t3);font-size:18px;line-height:1;cursor:pointer">×</button>
    </div>`;
  });
  if (arr.length > 1) {
    html += `<button data-action="clear-wishlist-history" style="width:100%;margin-top:8px;padding:10px;border-radius:10px;border:1px solid color-mix(in srgb,var(--rd) 30%,var(--bd));background:color-mix(in srgb,var(--rd) 6%,var(--bg3));color:var(--rd);font-size:12px;font-weight:600">Clear all history</button>`;
  }
  return html;
}

function renderFilterSheet() {
  // v5.01: chip clicks call patchFilter() which rewrites only the sheet body
  // and invalidates _derived, instead of full render(). Eliminates the
  // visual flicker that came from regenerating the entire app shell.
  // v6.37: cleaner layout — Reset moved to top; Line list collapsed by
  // default with a chevron expand (LINES is long and dominated the sheet);
  // Search Scope and Variants combined into a Misc row of binary toggles
  // to reduce vertical scrolling.
  const lineFilter = S.filterLine || '';
  const lineExpanded = S._filterLineExpanded || !!lineFilter;
  let html = '';
  if (hasFilters()) {
    html += `<button class="clear-all-btn" data-action="filter" data-filter-op="clear" style="width:100%;margin-bottom:14px">Reset all filters</button>`;
  }

  // Line — collapsed by default, expand via chevron. Active line shown
  // in the header so users can see the current state without expanding.
  const activeLineName = lineFilter
    ? (LINES.find(l => l.id === lineFilter)?.name || lineFilter)
    : 'All Lines';
  html += `<button class="filter-section-header" data-action="filter" data-filter-op="toggleLineExpand" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:10px 0 8px;background:none;border:none;color:var(--t1);text-align:left;cursor:pointer">
    <span class="text-upper text-dim text-xs" style="letter-spacing:1.2px">Line · <span style="color:var(--t1);font-weight:600;letter-spacing:0">${esc(activeLineName)}</span></span>
    <span style="color:var(--t3);font-size:14px;transform:rotate(${lineExpanded?'90':'0'}deg);transition:transform 0.15s">›</span>
  </button>`;
  if (lineExpanded) {
    html += '<div class="chip-group" style="margin-bottom:14px">';
    [{id:'',name:'All Lines'}, ...LINES].forEach(l => {
      html += `<button class="chip ${lineFilter===l.id?'active':''}" data-action="filter" data-filter-op="line" data-filter-val="${esc(l.id)}">${esc(l.name)}</button>`;
    });
    html += '</div>';
  }

  html += '<div class="label text-upper text-dim text-xs" style="margin-bottom:8px">Status</div><div class="chip-group">';
  const statusOpts = [
    {v:'', l:'All'}, ...STATUSES.map(s => ({v:s, l:STATUS_LABEL[s]})), {v:'unowned', l:'Unowned'}
  ];
  statusOpts.forEach(s => {
    const active = S.filterStatus === s.v;
    html += `<button class="chip ${active?'active':''}" data-action="filter" data-filter-op="status" data-filter-val="${esc(s.v)}">${s.l}</button>`;
  });

  html += '</div><div class="label text-upper text-dim text-xs" style="margin-bottom:8px">Faction</div><div class="chip-group">';
  ['', ...FACTIONS].forEach(f => {
    html += `<button class="chip ${S.filterFaction===f?'active':''}" data-action="filter" data-filter-op="faction" data-filter-val="${esc(f)}">${f||'All'}</button>`;
  });

  // Loadout filter — implicit-owned, only meaningful for figures with
  // a loadout defined. v6.37.
  html += '</div><div class="label text-upper text-dim text-xs" style="margin-bottom:8px">Loadout (Owned only)</div><div class="chip-group">';
  const lo = S.filterLoadout || '';
  html += `<button class="chip ${lo===''?'active':''}" data-action="filter" data-filter-op="loadout" data-filter-val="">All</button>`;
  html += `<button class="chip ${lo==='complete'?'active':''}" data-action="filter" data-filter-op="loadout" data-filter-val="complete">Complete</button>`;
  html += `<button class="chip ${lo==='incomplete'?'active':''}" data-action="filter" data-filter-op="loadout" data-filter-val="incomplete">Incomplete</button>`;

  // Misc binary toggles in a single row — Variants + Search Scope.
  // Reduces the section count and surfaces both as small toggles.
  html += '</div><div class="label text-upper text-dim text-xs" style="margin-bottom:8px">Misc</div><div class="chip-group">';
  html += `<button class="chip ${S.filterVariants?'active':''}" data-action="filter" data-filter-op="variants" data-filter-val="${!S.filterVariants}">${S.filterVariants?'☑':'☐'} Has variants</button>`;
  const scope = S.searchScope || 'all';
  html += `<button class="chip ${scope==='name'?'active':''}" data-action="filter" data-filter-op="searchScope" data-filter-val="${scope==='name'?'all':'name'}">${scope==='name'?'☑':'☐'} Name-only search</button>`;
  html += '</div>';

  return html;
}

// v5.01: in-place filter chip update — no full-app re-render flicker.
// v6.04: also refresh the underlying figure list so the user sees the filter
// applied immediately (was: list updated only on next full render, i.e. when
// the sheet was closed). renderContent() is a no-op-ish call: cheap to run
// because _derived.invalidate() just clears the cache; the list rebuild is
// the same work that would happen on sheet-close anyway.
window.patchFilter = (key, val) => {
  if (key === 'clear') {
    S.filterFaction=''; S.filterStatus=''; S.filterVariants=false; S.filterLine=''; S.search=''; S.filterLoadout=''; S.filterWave='';
  } else if (key === 'line')     S.filterLine = val;
  else if (key === 'faction')    S.filterFaction = val;
  else if (key === 'status')     S.filterStatus = val;
  else if (key === 'variants')   S.filterVariants = val;
  else if (key === 'loadout')    S.filterLoadout = val;   // v6.37: '' | 'complete' | 'incomplete'
  else if (key === 'toggleLineExpand') S._filterLineExpanded = !S._filterLineExpanded;
  else if (key === 'searchScope') {
    S.searchScope = val;
    store.set('motu-search-scope', val);
  }
  S.savedScroll = 0;
  _derived.invalidate();
  // Re-render only the sheet body — pills update without flicker.
  const body = document.querySelector('.sheet-body');
  if (body) body.innerHTML = renderFilterSheet();
  // v6.04: also patch the underlying contentArea so the figure list reflects
  // the active filter immediately. The sheet remains open on top.
  const contentArea = document.getElementById('contentArea');
  if (contentArea) contentArea.innerHTML = renderContent();
};

function renderSortSheet() {
  const opts = [
    {v:'year',l:'Year — oldest first (default)'},{v:'year-desc',l:'Year — newest first'},
    {v:'added-desc',l:'Recently Added'},
    {v:'wave',l:'Wave'},{v:'name',l:'Name A → Z'},{v:'name-desc',l:'Name Z → A'},
    {v:'retail',l:'Price (low → high)'},{v:'retail-desc',l:'Price (high → low)'},
  ];
  return opts.map(o => `<button class="sort-option ${S.sortBy===o.v?'active':''}" data-action="set-sort" data-sort="${esc(o.v)}">
    ${o.l}${S.sortBy===o.v ? icon(ICO.check,18) : ''}
  </button>`).join('');
}

function renderImportSheet() {
  return `<p class="text-md text-muted" style="margin-bottom:16px;line-height:1.6">
    Import from ActionFigure411.com CSV, a MOTU Collector CSV export, a JSON collection backup, or an app settings file. The format is auto-detected.
  </p>
  <div class="overwrite-toggle" data-action="toggle-overwrite">
    <div class="checkbox"><span style="color:#fff">${icon(ICO.check,14)}</span></div>
    <div>
      <div class="text-md" style="font-weight:500">Overwrite existing</div>
      <div class="text-sm text-dim">Re-import figures already marked as owned</div>
    </div>
  </div>
  <div class="drop-zone" id="dropZone" data-action="trigger-file-import">
    <div style="font-size:48px;margin-bottom:12px">📂</div>
    <div class="text-md" style="font-weight:500;margin-bottom:4px">Drop CSV or JSON backup here</div>
    <div class="text-sm text-dim">or tap to browse files</div>
    <input type="file" id="csvInput" accept=".csv,.json,text/csv,application/json,application/vnd.ms-excel,text/comma-separated-values,text/plain" style="display:none" data-change-action="handle-import-file">
  </div>`;
}

// ─── Batch Edit Sheet (v4.50) ─────────────────────────────────────
// "Add Copy" sheet — opened from the select actionbar "Add Copy…" button.
// Status buttons in the actionbar handle quick status-only changes.
// This sheet adds a copy to each selected figure with full field control.
function renderBatchEditSheet() {
  const n = S.selected.size;
  if (!n) return '<div class="text-sm text-dim">No figures selected.</div>';
  const be = S.batchEdit || (S.batchEdit = { mode: 'update', condition: '', variant: '', paid: '', notes: '', status: '', acquired: '', location: '' });
  if (!be.mode) be.mode = 'update';
  const isUpdate = be.mode === 'update';

  const seg = (val, label) => `<button data-action="batch-set-mode" data-mode="${val}" style="flex:1;padding:9px 8px;border-radius:9px;border:1px solid ${be.mode===val?'var(--acc)':'var(--bd)'};background:${be.mode===val?'color-mix(in srgb,var(--acc) 16%,var(--bg3))':'var(--bg3)'};color:${be.mode===val?'var(--acc)':'var(--t2)'};font-size:13px;font-weight:${be.mode===val?'700':'500'}">${label}</button>`;

  // Status: update mode can leave it alone; add mode always assigns one.
  const statusOpts = (isUpdate ? `<option value="" ${!be.status?'selected':''}>— Keep current —</option>` : '') +
    STATUSES.map(s => `<option value="${s}" ${be.status===s?'selected':''}>${STATUS_LABEL[s]}</option>`).join('');

  const h = `
    <div style="display:flex;gap:8px;margin-bottom:8px">
      ${seg('update','Update existing')}
      ${seg('add','Add new copy')}
    </div>
    <div class="text-sm text-dim" style="line-height:1.5;margin-bottom:14px">
      ${isUpdate
        ? `Writes the filled-in fields onto each selected figure's existing copy — no duplicates. Blank fields are left as-is. A figure with no copy yet is marked Owned so the details can attach.`
        : `Adds one new copy to each of the ${n} selected figure${n===1?'':'s'} with the fields below.`}
    </div>
    <div style="margin-bottom:12px">
      <div class="field-label text-dim text-sm">Status</div>
      <select data-change-action="batch-set-status-field">
        ${statusOpts}
      </select>
    </div>
    <div style="margin-bottom:12px">
      <div class="field-label text-dim text-sm">Condition (optional)</div>
      <select data-change-action="batch-set-condition">
        <option value="">${isUpdate ? '— Leave unchanged —' : '— No condition —'}</option>
        ${CONDITIONS.map(c => `<option value="${esc(c)}" ${be.condition===c?'selected':''}>${esc(c)}</option>`).join('')}
      </select>
    </div>
    <div style="margin-bottom:12px">
      <div class="field-label text-dim text-sm">Variant (optional)</div>
      <input type="text" value="${esc(be.variant)}" placeholder="e.g. Dark Face" data-input-action="batch-set-variant">
    </div>
    <div style="margin-bottom:12px">
      <div class="field-label text-dim text-sm">Price Paid (optional)</div>
      <input type="number" step="0.01" value="${esc(be.paid)}" placeholder="$0.00" data-input-action="batch-set-paid">
    </div>
    <div style="margin-bottom:12px">
      <div class="field-label text-dim text-sm">Date Acquired (optional)</div>
      <input type="text" inputmode="numeric" maxlength="7" value="${esc(be.acquired || '')}" placeholder="MM/YYYY" pattern="\\d{1,2}/\\d{4}" data-input-action="batch-format-acquired">
    </div>
    <div style="margin-bottom:12px">
      <div class="field-label text-dim text-sm">Location (optional)</div>
      <input type="text" value="${esc(be.location || '')}" placeholder="e.g. Display shelf, On loan…" list="locationSuggestions" data-input-action="batch-set-location">
    </div>
    <div style="margin-bottom:12px">
      <div class="field-label text-dim text-sm">Notes (optional)</div>
      <textarea rows="3" placeholder="Notes…" data-input-action="batch-set-notes">${esc(be.notes)}</textarea>
    </div>
    <div style="height:1px;background:var(--bd);margin:8px 0 16px"></div>
    <div style="display:flex;gap:10px">
      <button data-action="close-sheet" style="flex:1;padding:14px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);color:var(--t1);font-size:14px;font-weight:600">Cancel</button>
      <button data-action="apply-batch-edit" style="flex:2;padding:14px;border-radius:12px;border:1px solid var(--acc);background:var(--acc);color:var(--btn-t);font-size:14px;font-weight:700">${isUpdate ? 'Apply to' : 'Add to'} ${n}</button>
    </div>`;
  return h;
}



window.openBatchEditor = () => {
  if (!S.selected.size) return;
  S.batchEdit = { mode: 'update', condition: '', variant: '', paid: '', notes: '', status: '', acquired: '', location: '' };
  S.sheet = 'batch';
  pushNav();
  render();
};

window.applyBatchEdit = () => {
  const be = S.batchEdit; if (!be) return;
  const extras = { variant: be.variant, paid: be.paid, notes: be.notes, status: be.status, acquired: be.acquired, location: be.location };
  if (be.mode === 'add') batchAddCopy(be.condition, extras);
  else batchUpdateExisting(be.condition, extras);   // 'update' (default)
  closeSheet();
};

// v6.102: re-render just the batch sheet body so the mode toggle swaps the
// field set without a full re-render (no flicker, keeps the sheet scrolled).
window.refreshBatchSheet = () => {
  const body = document.querySelector('.sheet-body');
  if (body && S.sheet === 'batch') body.innerHTML = renderBatchEditSheet();
};


// ─── Edit Figure Sheet (v4.47) ────────────────────────────────────
// Local field overrides on top of figures.json. Useful for fixing entries
// that lack faction/group/year/etc. — the AF411 sync cannot stomp these.
function renderEditFigureSheet() {
  const figId = S.editingFigId;
  if (!figId) return '<div class="text-sm text-dim">No figure selected.</div>';
  const f = figById(figId);
  if (!f) return '<div class="text-sm text-dim">Figure not found.</div>';
  const eFigId = esc(figId);
  const jFigId = jsArg(figId);
  const ov = getOverridesFor(figId);
  const has = Object.keys(ov).length > 0;
  // For each editable field, show current effective value with an "overridden" hint.
  const row = (key, label, inputHtml, hint = '') => `
    <div style="margin-bottom:12px">
      <div class="field-label text-dim text-sm" style="display:flex;align-items:center;gap:6px">
        <span>${label}</span>
        ${ov[key] != null ? '<span style="font-size:9px;color:var(--gold);background:color-mix(in srgb,var(--gold) 18%,transparent);padding:1px 6px;border-radius:6px;letter-spacing:.3px">EDITED</span>' : ''}
      </div>
      ${inputHtml}
      ${hint ? `<div class="field-hint text-dim text-sm" style="margin-top:4px">${hint}</div>` : ''}
    </div>`;

  let h = `<div class="text-sm text-dim" style="line-height:1.5;margin-bottom:14px">
    Editing local info for <strong style="color:var(--gold)">${esc(f.name)}</strong>. Changes survive AF411 syncs and stay on this device. Leave a field blank to keep the source value.
  </div>`;

  // Line — allows reassigning a figure to a different line (e.g. Kids Core).
  // This override survives sync since applyOverrides runs after every fetch.
  const curLine = ov.line || f.line || '';
  h += row('line', 'Line',
    `<select data-change-action="edit-set-line" data-fig-id="${esc(figId)}">
      <option value="">— Use source —</option>
      ${LINES.map(l => `<option value="${esc(l.id)}" ${curLine===l.id?'selected':''}>${esc(l.name)}</option>`).join('')}
    </select>`,
    f.line && !ov.line ? `Source: ${esc(ln(f.line))}` : (ov.line ? `Overrides source: ${esc(ln(f.line))}` : '')
  );

  h += row('faction', 'Faction',
    `<select data-change-action="edit-set-faction" data-fig-id="${esc(figId)}">
      <option value="">— Use source —</option>
      ${FACTIONS.map(opt => `<option value="${esc(opt)}" ${(ov.faction||f.faction)===opt?'selected':''}>${esc(opt)}</option>`).join('')}
    </select>`,
    f.faction && !ov.faction ? `Source: ${esc(f.faction)}` : ''
  );

  // Group (pills from existing groups in this line, plus free text)
  // v6.62: use the EFFECTIVE line (override-aware) so moving a figure to a
  // new line shows that line's groups, not the source line's. Also fall back
  // to canonical groups from SUBLINES when no figures yet exist in the
  // effective line (otherwise a freshly-added line with no entries would
  // show zero pills and force users to type the group manually).
  const effectiveLine = curLine || f.line || '';
  const fromFigs = [...new Set(S.figs.filter(g => g.line === effectiveLine && g.group).map(g => g.group))];
  const fromSublines = (SUBLINES[effectiveLine] || []).flatMap(s => s.groups || []);
  const lineGroups = [...new Set([...fromFigs, ...fromSublines])].sort();
  const curGroup = ov.group || f.group || '';
  const groupInput = `
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
      ${lineGroups.map(g => `<button type="button" data-action="edit-set-group" data-fig-id="${esc(figId)}" data-group="${esc(g)}" style="padding:5px 12px;border-radius:20px;border:1px solid ${curGroup===g?'var(--acc)':'var(--bd)'};background:${curGroup===g?'color-mix(in srgb,var(--acc) 18%,transparent)':'var(--bg2)'};color:${curGroup===g?'var(--acc)':'var(--t2)'};font-size:12px;font-weight:500">${esc(g)}</button>`).join('')}
    </div>
    <input type="text" value="${esc(curGroup)}" placeholder="Or type a custom group…" data-change-action="edit-set-group-text" data-fig-id="${esc(figId)}">`;
  h += row('group', 'Group', groupInput,
    f.group && !ov.group ? `Source: ${esc(f.group)}` : ''
  );

  h += row('wave', 'Wave',
    `<input type="text" value="${esc(ov.wave || f.wave || '')}" placeholder="e.g. 1, 2, …" data-change-action="edit-set-wave" data-fig-id="${esc(figId)}">`,
    f.wave && !ov.wave ? `Source: ${esc(f.wave)}` : ''
  );

  h += row('year', 'Year',
    `<input type="number" value="${esc(ov.year || f.year || '')}" placeholder="e.g. 2024" data-change-action="edit-set-year" data-fig-id="${esc(figId)}">`,
    f.year && !ov.year ? `Source: ${esc(f.year)}` : ''
  );

  h += row('retail', 'Retail Price',
    `<input type="number" step="0.01" value="${esc(ov.retail || f.retail || '')}" placeholder="$0.00" data-change-action="edit-set-retail" data-fig-id="${esc(figId)}">`,
    f.retail && !ov.retail ? `Source: $${Number(f.retail).toFixed(2)}` : ''
  );

  h += row('name', 'Name',
    `<input type="text" value="${esc(ov.name || f.name || '')}" data-change-action="edit-set-name" data-fig-id="${esc(figId)}">`,
    // v7.45: was a bare `sourceName` — a ReferenceError that crashed the
    // whole Edit sheet for every figure the moment it rendered ("sourceName
    // is not defined" on the error screen). Same source-hint pattern as
    // the group/wave/year/retail rows above.
    f.sourceName && !ov.name ? `Source: ${esc(f.sourceName)}` : ''
  );

  if (has) {
    h += `<div style="height:1px;background:var(--bd);margin:18px 0"></div>
    <button data-action="reset-fig-overrides" data-fig-id="${esc(figId)}" style="width:100%;display:flex;align-items:center;justify-content:center;gap:8px;padding:14px;border-radius:12px;border:1px solid var(--rd);background:color-mix(in srgb,var(--rd) 10%,transparent);color:var(--rd);font-size:14px;font-weight:600">
      Reset all edits to source
    </button>`;
  }

  return h;
}

// Re-render the edit sheet body in place after a field change so the
// "EDITED" badge and Reset button update without closing/reopening.
window.refreshEditSheet = () => {
  const body = document.querySelector('.sheet-body');
  if (body && S.sheet === 'edit') body.innerHTML = renderEditFigureSheet();
};

window.resetFigureOverrides = async figId => {
  if (!await appConfirm('Reset all local edits for this figure?', {danger: true, ok: 'Reset'})) return;
  clearOverrides(figId);
  refreshEditSheet();
};

// Open the editor for a specific figure id.
window.openFigureEditor = figId => {
  // Save list scroll position before opening sheet so it's restored on close
  const ca = document.getElementById('contentArea');
  if (ca && ca.scrollTop > 0) S.savedScroll = ca.scrollTop;
  S.editingFigId = figId;
  S.sheet = 'edit';
  pushNav();
  render();
};

function renderThemeSheet() {
  return Object.entries(THEMES).map(([key, th]) =>
    `<button class="theme-option" style="border-color:${S.theme===key?th.acc:'var(--bd)'};background:${th.bg}" data-action="set-theme" data-theme="${esc(key)}">
      <div class="swatch" style="background:linear-gradient(135deg,${th.gold},${th.acc})"></div>
      <div style="flex:1">
        <div class="font-display" style="font-size:15px;color:${th.fg||'var(--t1)'}">${th.name}</div>
        <div class="text-sm" style="color:${th.fg2||'var(--t2)'};margin-top:2px">${th.bg} · ${th.acc}</div>
      </div>
      ${S.theme===key ? `<div style="color:${th.acc}">${icon(ICO.check,20)}</div>` : ''}
    </button>`
  ).join('');
}

// ── Exports ─────────────────────────────────────────────────
export {
  renderSheet, renderMenuSheet, renderFilterSheet, renderSortSheet, renderImportSheet, renderBatchEditSheet, renderEditFigureSheet, renderThemeSheet
};
