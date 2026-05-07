// ── Lazy shims for window-only handlers (resolve at call time) ──
const batchAddCopy = (...a) => window.batchAddCopy?.(...a);
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
  _derived, clearOverrides,
} from './data.js';
import {
  renderQR, renderShareSheet, renderStatsSheet,
  renderKidsCoreAdminSheet, renderWantListViewSheet, buildShareURL,
  renderContent, render, appConfirm,
} from './render.js';
import { pushNav } from './handlers.js';

// § RENDER-SHEETS ── renderSheet, filter/sort/import/export/theme/menu/stats/edit/batch/share sheets ──
function renderSheet() {
  const titles = {filter:'Filter', sort:'Sort By', import:'Import', export:'Export / Backup', theme:'Theme', menu:'Settings', stats:'Collection Stats', edit:'Edit Figure Info', batch:'Edit Selected Figures', share:'Share Want List', wantListView:'Want List', kidsCoreAdmin:'Kids Core — Add Figure', accessoryPicker:'Accessories', pricing:'Pricing Backend'};
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

  return `<div class="sheet-overlay" id="sheetOverlay" onclick="if(event.target===this||event.target.classList.contains('sheet-backdrop'))closeSheet()">
    <div class="sheet-backdrop"></div>
    <div class="sheet-panel">
      <div class="sheet-handle"><div class="sheet-handle-bar"></div></div>
      <div class="sheet-header">
        <div class="sheet-title">${titles[S.sheet]||'Options'}</div>
        <button class="sheet-close" onclick="closeSheet()">${icon(ICO.x,20)}</button>
      </div>
      <div class="sheet-body">${body}</div>
      ${S.sheet === 'wantListView' ? `<div class="sheet-footer" style="text-align:center">
        <div style="font-size:12px;color:var(--t3);margin-bottom:10px">Browse the full MOTU catalog</div>
        <a href="https://www.actionfigure411.com/masters-of-the-universe/" target="_blank" rel="noopener" style="display:inline-block;padding:10px 24px;border-radius:10px;background:var(--acc);color:var(--btn-t);font-size:13px;font-weight:700;text-decoration:none">View on AF411</a>
      </div>` : ''}
    </div>
  </div>`;
}

function renderMenuSheet() {
  const menuItems = [
    {label:'Collection Stats',    icon:ICO.heart,   action:"openSheet('stats')"},
    {label:'Share Want List',     icon:ICO.share,   action:"openSheet('share')"},
    {label:'Theme',               icon:ICO.palette, action:"openSheet('theme')"},
    {label:'Manage Collections',  icon:ICO.sort,    action:"closeSheet();S.editingOrder=true;S.tab='lines';S.activeLine=null;S.activeSubline=null;render()"},
    {label:'Import',              icon:ICO.import,  action:"openSheet('import')"},
    {label:'Export / Backup',     icon:ICO.export,  action:"openSheet('export')"},
    {label:'Pricing Backend',     icon:ICO.tag,     action:"openSheet('pricing')"},
  ];
  let html = menuItems.map(m => `
    <button onclick="${m.action}" style="width:100%;display:flex;align-items:center;gap:14px;padding:16px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);margin-bottom:10px;text-align:left;font-size:15px;color:var(--t1)">
      <span style="color:var(--acc)">${icon(m.icon, 20)}</span>
      ${m.label}
      <span style="margin-left:auto;color:var(--t3)">${icon(ICO.chevR, 16)}</span>
    </button>`).join('');
  // v5.00: PTR toggle. Default off — sync runs on page load and visibility
  // change anyway, and PTR can fire spuriously on sensitive touch hardware.
  const ptrOn = !!store.get('motu-ptr-enabled');
  html += `<div style="height:1px;background:var(--bd);margin:14px 4px"></div>
    <div class="text-xs text-upper text-dim" style="padding:0 4px 8px;letter-spacing:1.2px">Sync</div>
    <button onclick="store.set('motu-ptr-enabled',${ptrOn?'false':'true'});render()" style="width:100%;display:flex;align-items:center;gap:14px;padding:16px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);margin-bottom:10px;text-align:left;font-size:15px;color:var(--t1)">
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
    <button onclick="closeSheet();window.startTutorial && window.startTutorial()" style="width:100%;display:flex;align-items:center;gap:14px;padding:16px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);margin-bottom:10px;text-align:left;font-size:15px;color:var(--t1)">
      <span style="color:var(--acc);font-size:18px">🎓</span>
      <span style="flex:1">${tourLabel}</span>
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
    <button onclick="savePricingBackend()" style="flex:1;padding:12px;border-radius:10px;border:none;background:var(--acc);color:var(--btn-t);font-size:14px;font-weight:700">Save & test</button>
    ${configured ? `<button onclick="disconnectPricingBackend()" style="padding:12px 16px;border-radius:10px;border:1px solid var(--rd);background:color-mix(in srgb,var(--rd) 10%,transparent);color:var(--rd);font-size:14px;font-weight:600">Disconnect</button>` : ''}
  </div>
  ${configured ? `<button onclick="window.clearPricingCache && window.clearPricingCache();window.toast && window.toast('✓ Pricing cache cleared')" style="width:100%;margin-top:10px;padding:10px;border-radius:10px;border:1px solid var(--bd);background:var(--bg3);color:var(--t2);font-size:13px;font-weight:500">Clear pricing cache</button>` : ''}`;
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

function renderFilterSheet() {
  // v5.01: chip clicks call patchFilter() which rewrites only the sheet body
  // and invalidates _derived, instead of full render(). Eliminates the
  // visual flicker that came from regenerating the entire app shell.
  let html = '<div class="label text-upper text-dim text-xs" style="margin-bottom:10px">Line</div><div class="chip-group">';
  const lineFilter = S.filterLine || '';
  [{id:'',name:'All Lines'}, ...LINES].forEach(l => {
    html += `<button class="chip ${lineFilter===l.id?'active':''}" onclick="patchFilter('line','${l.id}')">${esc(l.name)}</button>`;
  });
  html += '</div><div class="label text-upper text-dim text-xs" style="margin-bottom:10px">Faction</div><div class="chip-group">';
  ['', ...FACTIONS].forEach(f => {
    html += `<button class="chip ${S.filterFaction===f?'active':''}" onclick="patchFilter('faction',${jsArg(f)})">${f||'All'}</button>`;
  });
  html += '</div><div class="label text-upper text-dim text-xs" style="margin-bottom:10px">Status</div><div class="chip-group">';
  const statusOpts = [
    {v:'', l:'All'}, ...STATUSES.map(s => ({v:s, l:STATUS_LABEL[s]})), {v:'unowned', l:'Unowned'}
  ];
  statusOpts.forEach(s => {
    const active = S.filterStatus === s.v;
    html += `<button class="chip ${active?'active':''}" onclick="patchFilter('status','${s.v}')">${s.l}</button>`;
  });
  html += '</div><div class="label text-upper text-dim text-xs" style="margin-bottom:10px">Variants</div><div class="chip-group">';
  html += `<button class="chip ${!S.filterVariants?'active':''}" onclick="patchFilter('variants',false)">All</button>`;
  html += `<button class="chip ${S.filterVariants?'active':''}" onclick="patchFilter('variants',true)">Has Variants</button>`;
  html += '</div>';
  if (hasFilters()) html += `<button class="clear-all-btn" onclick="patchFilter('clear')">Clear All Filters</button>`;
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
    S.filterFaction=''; S.filterStatus=''; S.filterVariants=false; S.filterLine=''; S.search='';
  } else if (key === 'line')     S.filterLine = val;
  else if (key === 'faction')    S.filterFaction = val;
  else if (key === 'status')     S.filterStatus = val;
  else if (key === 'variants')   S.filterVariants = val;
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
    {v:'wave',l:'Wave'},{v:'name',l:'Name A → Z'},{v:'name-desc',l:'Name Z → A'},
    {v:'retail',l:'Price (low → high)'},{v:'retail-desc',l:'Price (high → low)'},
  ];
  return opts.map(o => `<button class="sort-option ${S.sortBy===o.v?'active':''}" onclick="S.sortBy='${o.v}';store.set('motu-sort',S.sortBy);closeSheet()">
    ${o.l}${S.sortBy===o.v ? icon(ICO.check,18) : ''}
  </button>`).join('');
}

function renderImportSheet() {
  return `<p class="text-md text-muted" style="margin-bottom:16px;line-height:1.6">
    Import from ActionFigure411.com CSV, a MOTU Vault CSV export, a JSON collection backup, or an app settings file. The format is auto-detected.
  </p>
  <div class="overwrite-toggle" onclick="this.querySelector('.checkbox').classList.toggle('checked')">
    <div class="checkbox"><span style="color:#fff">${icon(ICO.check,14)}</span></div>
    <div>
      <div class="text-md" style="font-weight:500">Overwrite existing</div>
      <div class="text-sm text-dim">Re-import figures already marked as owned</div>
    </div>
  </div>
  <div class="drop-zone" id="dropZone" onclick="document.getElementById('csvInput').click()">
    <div style="font-size:48px;margin-bottom:12px">📂</div>
    <div class="text-md" style="font-weight:500;margin-bottom:4px">Drop CSV or JSON backup here</div>
    <div class="text-sm text-dim">or tap to browse files</div>
    <input type="file" id="csvInput" accept=".csv,.json,text/csv,application/json,application/vnd.ms-excel,text/comma-separated-values,text/plain" style="display:none" onchange="handleImportFile(this)">
  </div>`;
}

// ─── Batch Edit Sheet (v4.50) ─────────────────────────────────────
// "Add Copy" sheet — opened from the select actionbar "Add Copy…" button.
// Status buttons in the actionbar handle quick status-only changes.
// This sheet adds a copy to each selected figure with full field control.
function renderBatchEditSheet() {
  const n = S.selected.size;
  if (!n) return '<div class="text-sm text-dim">No figures selected.</div>';
  const be = S.batchEdit || (S.batchEdit = { condition: '', variant: '', paid: '', notes: '', status: 'owned' });

  const h = `<div style="margin-bottom:12px">
      <div class="field-label text-dim text-sm">Status</div>
      <select onchange="S.batchEdit.status=this.value">
        ${STATUSES.map(s => `<option value="${s}" ${be.status===s?'selected':''}>${STATUS_LABEL[s]}</option>`).join('')}
      </select>
    </div>
    <div style="margin-bottom:12px">
      <div class="field-label text-dim text-sm">Condition (optional)</div>
      <select onchange="S.batchEdit.condition=this.value">
        <option value="">— No condition —</option>
        ${CONDITIONS.map(c => `<option value="${esc(c)}" ${be.condition===c?'selected':''}>${esc(c)}</option>`).join('')}
      </select>
    </div>
    <div style="margin-bottom:12px">
      <div class="field-label text-dim text-sm">Variant (optional)</div>
      <input type="text" value="${esc(be.variant)}" placeholder="e.g. Dark Face" oninput="S.batchEdit.variant=this.value">
    </div>
    <div style="margin-bottom:12px">
      <div class="field-label text-dim text-sm">Price Paid (optional)</div>
      <input type="number" step="0.01" value="${esc(be.paid)}" placeholder="$0.00" oninput="S.batchEdit.paid=this.value">
    </div>
    <div style="margin-bottom:12px">
      <div class="field-label text-dim text-sm">Notes (optional)</div>
      <textarea rows="3" placeholder="Notes…" oninput="S.batchEdit.notes=this.value">${esc(be.notes)}</textarea>
    </div>
    <div class="text-sm text-dim" style="line-height:1.5;margin-bottom:14px">
      Adds one copy to each of the ${n} selected figure${n===1?'':'s'} with the fields above.
    </div>
    <div style="height:1px;background:var(--bd);margin:8px 0 16px"></div>
    <div style="display:flex;gap:10px">
      <button onclick="closeSheet()" style="flex:1;padding:14px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);color:var(--t1);font-size:14px;font-weight:600">Cancel</button>
      <button onclick="applyBatchEdit()" style="flex:2;padding:14px;border-radius:12px;border:1px solid var(--acc);background:var(--acc);color:var(--btn-t);font-size:14px;font-weight:700">Add to ${n}</button>
    </div>`;
  return h;
}



window.openBatchEditor = () => {
  if (!S.selected.size) return;
  S.batchEdit = { condition: '', variant: '', paid: '', notes: '', status: 'owned' };
  S.sheet = 'batch';
  pushNav();
  render();
};

window.applyBatchEdit = () => {
  const be = S.batchEdit; if (!be) return;
  batchAddCopy(be.condition, { variant: be.variant, paid: be.paid, notes: be.notes, status: be.status });
  closeSheet();
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
    `<select onchange="setOverrideField(${jFigId},'line',this.value);refreshEditSheet()">
      <option value="">— Use source —</option>
      ${LINES.map(l => `<option value="${esc(l.id)}" ${curLine===l.id?'selected':''}>${esc(l.name)}</option>`).join('')}
    </select>`,
    f.line && !ov.line ? `Source: ${esc(ln(f.line))}` : (ov.line ? `Overrides source: ${esc(ln(f.line))}` : '')
  );

  // Faction
  h += row('faction', 'Faction',
    `<select onchange="setOverrideField(${jFigId},'faction',this.value);refreshEditSheet()">
      <option value="">— Use source —</option>
      ${FACTIONS.map(opt => `<option value="${esc(opt)}" ${(ov.faction||f.faction)===opt?'selected':''}>${esc(opt)}</option>`).join('')}
    </select>`,
    f.faction && !ov.faction ? `Source: ${esc(f.faction)}` : ''
  );

  // Group (pills from existing groups in this line, plus free text)
  const lineGroups = [...new Set(S.figs.filter(g => g.line === f.line && g.group).map(g => g.group))].sort();
  const curGroup = ov.group || f.group || '';
  const groupInput = `
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
      ${lineGroups.map(g => `<button type="button" onclick="setOverrideField(${jFigId},'group',${jsArg(g)});refreshEditSheet()" style="padding:5px 12px;border-radius:20px;border:1px solid ${curGroup===g?'var(--acc)':'var(--bd)'};background:${curGroup===g?'color-mix(in srgb,var(--acc) 18%,transparent)':'var(--bg2)'};color:${curGroup===g?'var(--acc)':'var(--t2)'};font-size:12px;font-weight:500">${esc(g)}</button>`).join('')}
    </div>
    <input type="text" value="${esc(curGroup)}" placeholder="Or type a custom group…" onchange="setOverrideField(${jFigId},'group',this.value);refreshEditSheet()">`;
  h += row('group', 'Group', groupInput,
    f.group && !ov.group ? `Source: ${esc(f.group)}` : ''
  );

  // Wave
  h += row('wave', 'Wave',
    `<input type="text" value="${esc(ov.wave || f.wave || '')}" placeholder="e.g. 1, 2, …" onchange="setOverrideField(${jFigId},'wave',this.value);refreshEditSheet()">`,
    f.wave && !ov.wave ? `Source: ${esc(f.wave)}` : ''
  );

  // Year
  h += row('year', 'Year',
    `<input type="number" value="${esc(ov.year || f.year || '')}" placeholder="e.g. 2024" onchange="setOverrideField(${jFigId},'year',this.value?Number(this.value):'');refreshEditSheet()">`,
    f.year && !ov.year ? `Source: ${esc(f.year)}` : ''
  );

  // Retail price
  h += row('retail', 'Retail Price',
    `<input type="number" step="0.01" value="${esc(ov.retail || f.retail || '')}" placeholder="$0.00" onchange="setOverrideField(${jFigId},'retail',this.value?Number(this.value):'');refreshEditSheet()">`,
    f.retail && !ov.retail ? `Source: $${Number(f.retail).toFixed(2)}` : ''
  );

  // Name
  let sourceName = '';
  if (ov.name) {
    const cached = store.get(CACHE_KEY);
    const src = cached?.rows?.find(r => r.id === figId);
    if (src && src.name && src.name !== ov.name) sourceName = src.name;
  }
  h += row('name', 'Name',
    `<input type="text" value="${esc(ov.name || f.name || '')}" onchange="setOverrideField(${jFigId},'name',this.value);refreshEditSheet()">`,
    sourceName ? `Source: ${esc(sourceName)}` : ''
  );

  // Reset button — only meaningful when there's something to reset
  if (has) {
    h += `<div style="height:1px;background:var(--bd);margin:18px 0"></div>
    <button onclick="resetFigureOverrides(${jFigId})" style="width:100%;display:flex;align-items:center;justify-content:center;gap:8px;padding:14px;border-radius:12px;border:1px solid var(--rd);background:color-mix(in srgb,var(--rd) 10%,transparent);color:var(--rd);font-size:14px;font-weight:600">
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
    `<button class="theme-option" style="border-color:${S.theme===key?th.acc:'var(--bd)'};background:${th.bg}" onclick="setTheme('${key}')">
      <div class="swatch" style="background:linear-gradient(135deg,${th.gold},${th.acc})"></div>
      <div style="flex:1">
        <div class="font-display" style="font-size:15px;color:var(--t1)">${th.name}</div>
        <div class="text-sm" style="color:var(--t2);margin-top:2px">${th.bg} · ${th.acc}</div>
      </div>
      ${S.theme===key ? `<div style="color:${th.acc}">${icon(ICO.check,20)}</div>` : ''}
    </button>`
  ).join('');
}

// ── Exports ─────────────────────────────────────────────────
export {
  renderSheet, renderMenuSheet, renderFilterSheet, renderSortSheet, renderImportSheet, renderBatchEditSheet, renderEditFigureSheet, renderThemeSheet
};
