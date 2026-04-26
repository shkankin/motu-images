// ── Lazy shims for window-only handlers (resolve at call time) ──
const closeSheet = (...a) => window.closeSheet?.(...a);
const exportPhotosZip = (...a) => window.exportPhotosZip?.(...a);
const exportSettings = (...a) => window.exportSettings?.(...a);
const openSheet = (...a) => window.openSheet?.(...a);

// ════════════════════════════════════════════════════════════════════
// MOTU Vault — data.js
// ────────────────────────────────────────────────────────────────────
// figures.json fetch + CSV parser, schema migrations, collection ops
// (status/copies/overrides/hidden), the derived-stats cache keyed on
// S._collVersion, and CSV/JSON/ZIP import-export.
// ────────────────────────────────────────────────────────────────────
// patchFigRow + updateNavBadge live in render.js (DOM-touching) but
// setStatus calls them via window.* to break the data→render cycle.
// ════════════════════════════════════════════════════════════════════

import {
  S, store, ICO, icon, IMG, FIGS_URL, KIDS_CORE_URL, KIDS_CORE_KEY,
  CUSTOM_FIGS_KEY, CACHE_KEY, CACHE_TTL,
  LINES, FACTIONS, CONDITIONS, ACCESSORIES,
  STATUSES, STATUS_LABEL, STATUS_COLOR, STATUS_HEX,
  THEMES, SUBLINES, SERIES_MAP, COND_MAP, GROUP_MAP,
  ln, normalize, esc, isSelecting, _clone,
} from './state.js';
import {
  MAX_PHOTOS, PHOTO_LABELS_KEY, PHOTO_COPY_KEY,
  photoStore, photoURLs, photoCopyOf, setPhotoCopy,
  loadPhotoLabels, savePhotoLabels, loadPhotoCopyMap, savePhotoCopyMap,
} from './photos.js';

// § DATA-FETCH ── parseCSV, fetchFigs, newFigIds detection ─────────
function parseCSV(text) {
  if (text.length > 10000000) throw new Error('File too large');
  const lines = text.split('\n').filter(l => l.trim());
  const parseRow = line => {
    const cols = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === ',' && !inQ) { cols.push(cur); cur = ''; }
      else cur += c;
    }
    cols.push(cur); return cols;
  };
  const headers = parseRow(lines[0]).map(h => h.trim());
  const idx = h => headers.indexOf(h);
  const [iGenre,iSeries,iGroup,iName,iWave,iPaid,iCond,iNote,iWhere,iVariation] =
    ['Genre','Series','Group','Name','Wave','Purchase Price','Condition','Note','Where Purchased','Variation Name'].map(idx);
  return lines.slice(1).map(l => {
    const c = parseRow(l);
    const csvGroup = c[iGroup]?.trim() || '';
    return { genre:c[iGenre], series:c[iSeries], name:c[iName]?.trim(),
      group:GROUP_MAP[csvGroup]||csvGroup, wave:c[iWave]?.trim()||'', paid:c[iPaid]?.trim(),
      cond:COND_MAP[c[iCond]?.trim()]||'', note:c[iNote]?.trim(), where:c[iWhere]?.trim(),
      variation:c[iVariation]?.trim()||'' };
  }).filter(r => r.genre === 'Masters of the Universe' && SERIES_MAP[r.series]);
}

// ─── Data Fetching ────────────────────────────────────────────────
// Concurrency guard: if a fetch is already in flight, return its promise
// instead of starting a second one. Prevents the 1s init() timer and a
// manual sync tap from racing each other on S.figs = [...].
let _fetchInFlight = null;
async function fetchFigs(manual = false, firstLoad = false) {
  if (_fetchInFlight) return _fetchInFlight;
  _fetchInFlight = (async () => {
    S.syncStatus = 'syncing'; render();
    S.fetchError = false;
    try {
      // Fetch main figures.json and kids-core.json in parallel
      const [res, kcRes] = await Promise.all([
        fetch(FIGS_URL + '?t=' + Date.now()),
        fetch(KIDS_CORE_URL + '?t=' + Date.now()).catch(() => null),
      ]);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const remote = await res.json();
      if (!Array.isArray(remote) || remote.length < 100) throw new Error('Invalid data');

      // Kids Core figures from repo (optional — 404 is fine if file doesn't exist yet)
      let kcRemote = [];
      if (kcRes && kcRes.ok) {
        try { kcRemote = await kcRes.json(); } catch {}
      }
      // Merge: remote kids-core figures get source:'kids-core' and image from slug
      const kcHydrated = (Array.isArray(kcRemote) ? kcRemote : []).map(f => ({
        ...f,
        line: 'kids-core',
        source: 'kids-core',
        image: f.slug ? `${IMG}/${f.slug}.jpg` : (f.image || ''),
      }));

      // Detect newly added figures
      const prevIds = new Set(S.figs.map(f => f.id));
      const custom = S.figs.filter(f => f.line === 'custom');
      // v5.04: Local custom figures (added via standalone editor). Same
      // pattern as Kids Core local — kept across syncs, prefixed with
      // 'custom-' to avoid future AF411 ID collisions. Each entry can
      // declare its own `line` (origins, masterverse, etc.) so the figure
      // appears in the right line's list.
      const localCustom = store.get(CUSTOM_FIGS_KEY) || [];
      // Local Kids Core figures (added via admin UI) — kept across syncs
      const localKC = store.get(KIDS_CORE_KEY) || [];
      const remoteIds = new Set([...remote, ...kcHydrated].map(f => f.id));
      const localKCFigs = localKC.map(f => ({
        ...f, line: 'kids-core', source: 'kids-core-local',
        image: f.slug ? `${IMG}/${f.slug}.jpg` : (f.image || ''),
      })).filter(f => !remoteIds.has(f.id)); // dedupe against repo
      const localCustomFigs = localCustom.map(f => ({
        ...f, source: 'custom-local',
        // Force ID prefix to prevent collision with future AF411 IDs
        id: f.id && f.id.startsWith('custom-') ? f.id : 'custom-' + f.id,
        // v5.05: coerce year to Number so it sort-merges with AF411 entries.
        // Editor saves as string; sort-by-year groups use strict equality.
        year: f.year ? Number(f.year) : f.year,
        // Coerce retail too for consistency
        retail: f.retail ? Number(f.retail) : f.retail,
        image: f.slug ? `${IMG}/${f.slug}.jpg` : (f.image || ''),
      })).filter(f => !remoteIds.has(f.id));

      const hydrated = remote.map(f => ({...f, image: f.slug ? `${IMG}/${f.slug}.jpg` : ''}));
      // Only flag as new if we had a previous catalog loaded (not first boot)
      if (prevIds.size > 100) {
        [...hydrated, ...kcHydrated].forEach(f => { if (!prevIds.has(f.id)) S.newFigIds.add(f.id); });
      }
      const kcIds = new Set([...kcHydrated, ...localKCFigs].map(f => f.id));
      const customIds = new Set(localCustomFigs.map(f => f.id));
      S.figs = [
        ...hydrated,
        ...kcHydrated,
        ...localKCFigs,
        ...localCustomFigs,
        ...custom.filter(f => !remoteIds.has(f.id) && !kcIds.has(f.id) && !customIds.has(f.id)),
      ];
      rebuildFigIndex();
      S.syncTs = Date.now();
      store.set(CACHE_KEY, { rows: S.figs, ts: S.syncTs });
      S.syncStatus = 'ok';
      if (firstLoad) { S.loaded = true; }
      const newCount = S.newFigIds.size;
      if (manual || newCount) toast(`✓ Synced ${S.figs.length} figures${newCount ? ` · ${newCount} new` : ''}`);
      render();
      setTimeout(() => { S.syncStatus = 'idle'; render(); }, 3000);
    } catch(e) {
      console.error('Fetch failed:', e);
      S.syncStatus = manual ? 'err' : 'idle';
      if (manual) {
        // Detect offline vs other error
        const isNetwork = !navigator.onLine || /network|failed to fetch/i.test(e.message);
        if (isNetwork) {
          S.isOffline = !navigator.onLine;
          toast('✗ No connection — using cached data');
        } else {
          toast('✗ Sync failed');
        }
        setTimeout(() => { S.syncStatus = 'idle'; render(); }, 5000);
      }
      if (firstLoad) { S.fetchError = true; render(); }
      else render();
    } finally {
      _fetchInFlight = null;
    }
  })();
  return _fetchInFlight;
}

// § COLLECTION-OPS ── saveColl, setStatus, patchFigRow, updateColl, copy ops, overrides, stats, getSortedFigs ──
let _saveCollTimer = null;
function saveColl() {
  // Debounce localStorage writes (~80ms) to coalesce rapid taps (batch select,
  // fast status cycling, notes typing). In-memory S.coll is always current.
  // v4.86: bump version counter so _derived cache key invalidates without
  // having to re-hash Object.keys(S.coll) on every render.
  S._collVersion++;
  if (_saveCollTimer) clearTimeout(_saveCollTimer);
  _saveCollTimer = setTimeout(() => { store.set('motu-c2', S.coll); _saveCollTimer = null; }, 80);
}
function flushSaveColl() {
  if (_saveCollTimer) { clearTimeout(_saveCollTimer); _saveCollTimer = null; }
  store.set('motu-c2', S.coll);
}
// Unload: apply pending field debounces first, then persist collection.
// Order matters — field flushes write into S.coll, saveColl flushes S.coll to localStorage.
function flushAllPending() {
  // flushFieldDebounces is defined later in the script; guard in case of early unload.
  if (typeof flushFieldDebounces === 'function') flushFieldDebounces();
  flushSaveColl();
}
window.addEventListener('pagehide', flushAllPending);
window.addEventListener('beforeunload', flushAllPending);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAllPending(); });
// Release OPFS blob URLs on page unload so the browser doesn't flag unreleased blobs
window.addEventListener('pagehide', () => {
  Object.values(photoURLs).forEach(url => { if (url && url.startsWith('blob:')) URL.revokeObjectURL(url); });
});

// O(1) figure lookup by id — rebuilt whenever S.figs changes.
let _figById = new Map();
function rebuildFigIndex() {
  // Apply any local field overrides before indexing so figById reflects them.
  applyOverrides();
  _figById = new Map();
  for (const f of S.figs) _figById.set(f.id, f);
}
function figById(id) { return _figById.get(id); }

// ─── Figure Overrides (v4.47) ────────────────────────────────────
// Local patches on top of figures.json — fixes incomplete entries (e.g. a
// figure that's only tagged with a line and missing faction/group/year).
// Storage: localStorage 'motu-overrides' = {figId: {fields: {...}}}
// Survives AF411 sync, restored on every load.
const OVERRIDES_KEY = 'motu-overrides';
let _overrides = {};
function loadOverrides() {
  try { _overrides = JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}'); } catch { _overrides = {}; }
}
function saveOverrides() {
  try { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(_overrides)); } catch {}
}
// Walk S.figs once and merge any override fields. Idempotent — pure assignment.
function applyOverrides() {
  if (!_overrides || !Object.keys(_overrides).length) return;
  for (let i = 0; i < S.figs.length; i++) {
    const ov = _overrides[S.figs[i].id];
    if (!ov || !ov.fields) continue;
    // Mark with _overridden so future audits/UI can show "this entry has local edits"
    S.figs[i] = { ...S.figs[i], ...ov.fields, _overridden: true };
  }
}
// Get a single field's override value (or undefined).
function getOverrideField(figId, key) {
  return _overrides[figId]?.fields?.[key];
}
// Set/clear a single field. Empty string = clear that field's override.
function setOverrideField(figId, key, val) {
  if (!_overrides[figId]) _overrides[figId] = { fields: {} };
  if (val === '' || val == null) {
    delete _overrides[figId].fields[key];
    if (!Object.keys(_overrides[figId].fields).length) delete _overrides[figId];
  } else {
    _overrides[figId].fields[key] = val;
    // When reassigning to a new line, clear any group override so the figure
    // isn't orphaned in a group that doesn't exist in the new line.
    if (key === 'line') delete _overrides[figId].fields.group;
  }
  saveOverrides();
  // Re-apply so figById reflects the change immediately
  rebuildFigIndex();
}
// Clear all overrides for a figure (revert to AF411 source data).
function clearOverrides(figId) {
  delete _overrides[figId];
  saveOverrides();
  // Reload figs from cache to wipe the in-memory overridden values
  const cached = store.get(CACHE_KEY);
  if (cached?.rows?.length) {
    S.figs = cached.rows.map(f => ({...f, image: f.image || (f.slug ? `${IMG}/${f.slug}.jpg` : '')}));
  }
  rebuildFigIndex();
}
window.setOverrideField = setOverrideField;
window.clearOverrides = clearOverrides;

// ─── Multi-Copy Schema (v4.42+) ─────────────────────────────────
// Each collection entry can hold multiple physical copies. Schema:
//   c = {
//     status: 'owned' | 'wishlist' | 'ordered' | 'for-sale',
//     copies: [{ id, condition?, paid?, notes?, variant? }, ...]
//   }
// Legacy entries (status + flat condition/paid/notes/variants) are
// migrated on load via migrateColl(). Reads go through getPrimaryCopy()
// which gracefully handles both shapes.

function isMigrated(c) { return c && Array.isArray(c.copies); }

function migrateEntry(c) {
  if (!c) return c;
  if (isMigrated(c)) return c;
  const out = {};
  if (c.status) out.status = c.status;
  out.copies = [];
  const hasPerCopyData = !!(c.condition || c.paid || c.notes || c.variants);
  const ownsPhysical = c.status === 'owned' || c.status === 'for-sale';
  if (hasPerCopyData || ownsPhysical) {
    const copy = { id: 1 };
    if (c.condition) copy.condition = c.condition;
    if (c.paid) copy.paid = c.paid;
    if (c.notes) copy.notes = c.notes;
    if (c.variants) copy.variant = c.variants;  // singular in new schema
    out.copies.push(copy);
  }
  return out;
}

function migrateColl(coll) {
  const out = {};
  for (const [id, entry] of Object.entries(coll || {})) {
    out[id] = migrateEntry(entry);
  }
  return out;
}

// Returns the primary (first) copy with all its fields, or null if there
// are no copies. Falls back to flat-shape read for safety on un-migrated
// entries (defensive — should never happen post-init).
function getPrimaryCopy(c) {
  if (!c) return null;
  if (isMigrated(c)) return c.copies[0] || null;
  if (!c.condition && !c.paid && !c.notes && !c.variants) return null;
  return { id: 1, condition: c.condition, paid: c.paid, notes: c.notes, variant: c.variants };
}

// Convenience getters that read either schema. Safe to use anywhere a
// "what is the user's primary copy data?" question is being asked.
function copyCondition(c) { const p = getPrimaryCopy(c); return p ? p.condition : undefined; }
function copyPaid(c)      { const p = getPrimaryCopy(c); return p ? p.paid : undefined; }
function copyNotes(c)     { const p = getPrimaryCopy(c); return p ? p.notes : undefined; }
function copyVariant(c)   {
  const p = getPrimaryCopy(c);
  if (p && p.variant) return p.variant;
  // legacy plural fallback
  return c && c.variants;
}

// Total physical copies across the collection (for stats).
function totalCopyCount() {
  let n = 0;
  for (const id in S.coll) {
    const c = S.coll[id];
    if (isMigrated(c)) n += c.copies.length;
    else if (c?.status === 'owned' || c?.status === 'for-sale') n += 1;
  }
  return n;
}

// Number of copies for a single entry (0 for wishlist, 1+ for owned/for-sale).
function entryCopyCount(c) {
  if (!c) return 0;
  if (isMigrated(c)) return c.copies.length;
  if (c.status === 'owned' || c.status === 'for-sale') return 1;
  return 0;
}

function toggleHidden(key) {
  const i = S.hiddenItems.indexOf(key);
  if (i >= 0) S.hiddenItems.splice(i, 1);
  else S.hiddenItems.push(key);
  S._hiddenKey = null;      // invalidate figIsHidden key cache
  _derived.invalidate();    // invalidate getStats/getSortedFigs cache
  store.set('motu-hidden', S.hiddenItems);
  render();
}
function isLineFullyHidden(lineId) {
  // A line is fully hidden if the line itself is hidden
  return S.hiddenItems.includes(lineId);
}
function isSublineHidden(lineId, subKey) {
  return S.hiddenItems.includes(lineId + ':' + subKey);
}
// Memoized: cache keyed on current hiddenItems signature. Reset whenever
// hiddenItems changes (via toggleHidden) or S.figs size changes.
// _hiddenKey is pre-computed and nulled on change, so the join only
// runs once per render cycle rather than once per figure.
let _hidCache = new Map();
let _hidCacheKey = '';
function figIsHidden(f) {
  // Cache key includes activeSubline so navigating into/out of a hidden subline busts it
  if (S._hiddenKey == null) S._hiddenKey = S.hiddenItems.length ? S.hiddenItems.join('|') : '';
  const cacheKey = S._hiddenKey + '\x00' + (S.activeSubline || '');
  if (_hidCacheKey !== cacheKey) { _hidCache = new Map(); _hidCacheKey = cacheKey; }
  const cached = _hidCache.get(f.id);
  if (cached !== undefined) return cached;
  let hidden = false;
  if (isLineFullyHidden(f.line)) hidden = true;
  else {
    const subs = SUBLINES[f.line];
    if (subs) {
      for (const sl of subs) {
        // Don't treat figures as hidden if we're actively browsing inside that subline
        if (sl.groups.includes(f.group) && isSublineHidden(f.line, sl.key)) {
          if (S.activeSubline === sl.key) { hidden = false; break; }
          hidden = true; break;
        }
      }
    }
  }
  _hidCache.set(f.id, hidden);
  return hidden;
}

// v4.87: migrate ordered-status fields into the first copy when a figure
// transitions from 'ordered' → 'owned'. Called from both setStatus() and
// cycleStatus() — previously only setStatus had this logic, so quick-cycling
// the status dot in list/grid view silently dropped orderedFrom/orderedPaid.
// Caller is responsible for having already flipped S.coll[id].status to 'owned'.
function migrateOrderedToOwned(id) {
  const entry = S.coll[id];
  if (!entry) return;
  if (!isMigrated(entry)) S.coll[id] = migrateEntry(entry);
  const e = S.coll[id];
  if (!e.copies || !e.copies.length) e.copies = [{id: 1}];
  const copy = e.copies[0];
  if (e.orderedFrom) {
    const prefix = `Ordered from: ${e.orderedFrom}`;
    copy.notes = copy.notes ? `${prefix}\n${copy.notes}` : prefix;
  }
  if (e.orderedPaid != null && e.orderedPaid !== '' && !copy.paid) copy.paid = String(e.orderedPaid);
  delete e.orderedFrom;
  delete e.orderedDate;
  delete e.orderedPaid;
}

function setStatus(id, status) {
  if (!S.coll[id]) S.coll[id] = {};
  // Ensure migrated shape
  if (!isMigrated(S.coll[id])) S.coll[id] = migrateEntry(S.coll[id]);
  if (!S.coll[id].copies) S.coll[id].copies = [];

  const wasStatus = S.coll[id].status;
  const prevColl = _clone(S.coll[id] || {});
  if (S.coll[id].status === status) {
    // Toggle off: clear status. If there's no remaining ownership signal
    // (no status and no copies), drop the entry entirely.
    delete S.coll[id].status;
    if (!S.coll[id].status && (!S.coll[id].copies || S.coll[id].copies.length === 0)) {
      delete S.coll[id];
    }
  } else {
    S.coll[id] = {...S.coll[id], status};
    // v4.90: ensure owned/for-sale always has at least one copy slot.
    // Previously setStatus left `copies: []` for newly-owned figures, while
    // batchSetStatus/batchAddCopy auto-populated copies[0]. The detail-screen
    // renderer masked this by defensively injecting copy #1 for display, so
    // users didn't see a blank — but operations that touch cp.copies[0]
    // directly (addAccessory, addLocation via the picker, etc.) would fail
    // silently until the user edited a scalar field and triggered updateCopy.
    if ((status === 'owned' || status === 'for-sale') &&
        (!S.coll[id].copies || S.coll[id].copies.length === 0)) {
      S.coll[id] = {...S.coll[id], copies: [{ id: 1 }]};
    }
    // When transitioning from ordered → owned, migrate order details into
    // the copy fields so the data isn't lost.
    if (wasStatus === 'ordered' && status === 'owned') migrateOrderedToOwned(id);
  }
  saveColl(); haptic();
  S._recentChanges = [id, ...S._recentChanges.filter(x => x !== id)].slice(0, 10);
  store.set('motu-recent', S._recentChanges);
  const fig = figById(id);
  const name = fig ? fig.name : id;
  const newStatus = S.coll[id]?.status;
  // On the detail screen, the user sees the status change immediately in-place —
  // no toast needed, and we don't want a full main-screen render (which causes
  // the detail screen to scroll back to top when renderDetail re-fires).
  const onDetail = S.screen === 'figure' && S.activeFig && S.activeFig.id === id;
  if (!onDetail) {
    if (newStatus) toastUndo(`✓ ${name} → ${STATUS_LABEL[newStatus]}`, id, prevColl);
    else toastUndo(`✗ ${name} cleared`, id, prevColl);
    triggerPulse(id, newStatus);
    if (!patchFigRow(id)) render();
  }
  // Check completion celebrations (kept on detail too — confetti is the reward)
  if (newStatus === 'owned' && fig) checkCompletion(fig);
}

// Per-copy field names (write into copies[0]). The UI may submit 'variants'
// (legacy plural) which is normalized to 'variant' (singular) in the schema.
const PER_COPY_FIELDS = new Set(['condition', 'paid', 'notes', 'variant', 'variants']);

function updateColl(id, key, val) {
  const cur = S.coll[id] || {};
  // Ensure migrated shape so future reads are consistent.
  let next = isMigrated(cur) ? {...cur, copies: cur.copies.map(c => ({...c}))} : migrateEntry(cur);
  if (!next.copies) next.copies = [];

  if (PER_COPY_FIELDS.has(key)) {
    const writeKey = (key === 'variants') ? 'variant' : key;
    // Ensure a primary copy exists to write into. If none, create one.
    if (!next.copies.length) next.copies.push({ id: 1 });
    const copy = {...next.copies[0]};
    if (val === '' || val == null) delete copy[writeKey];
    else copy[writeKey] = val;
    next.copies[0] = copy;
  } else {
    // Top-level field (status, etc.)
    if (val === '' || val == null) delete next[key];
    else next[key] = val;
  }

  S.coll[id] = next;
  saveColl();
}

// Debounced version for oninput on long-text fields (e.g. notes) so
// a pending edit doesn't get lost if the app is force-closed mid-typing.
// Stores pending args alongside timer so flushFieldDebounces() can apply
// them synchronously on pagehide / beforeunload / visibilitychange.
const _updDebounces = {};  // { dk: {timer, args: [id,key,val]} }
window.updateCollDebounced = (id, key, val) => {
  const dk = id + ':' + key;
  if (_updDebounces[dk]) clearTimeout(_updDebounces[dk].timer);
  _updDebounces[dk] = {
    args: [id, key, val],
    timer: setTimeout(() => {
      updateColl(id, key, val);
      delete _updDebounces[dk];
    }, 400),
  };
};

// ─── Multi-Copy Operations (v4.43) ───────────────────────────────
// addCopy / removeCopy / updateCopy work directly on the copies array
// by stable copy id (cp.id), not array index — so DOM and array stay
// in sync even after reorders/deletions.

function nextCopyId(c) {
  if (!isMigrated(c) || !c.copies.length) return 1;
  return c.copies.reduce((m, cp) => Math.max(m, cp.id || 0), 0) + 1;
}

window.addCopy = id => {
  let c = S.coll[id];
  if (!c) {
    // Tapping "add copy" on an entry with no status yet — assume owned.
    c = { status: 'owned', copies: [] };
  } else if (!isMigrated(c)) {
    c = migrateEntry(c);
  } else {
    c = {...c, copies: [...c.copies]};
  }
  c.copies.push({ id: nextCopyId(c) });
  S.coll[id] = c;
  saveColl();
  haptic();
  // Re-render just the status block so the new copy card appears
  // without scrolling the detail screen back to top.
  patchDetailStatus();
};

window.removeCopy = async (id, copyId) => {
  const c = S.coll[id];
  if (!c || !isMigrated(c)) return;
  const cp = c.copies.find(x => x.id === copyId);
  if (!cp) return;
  // Confirm only if copy has data — empty copies delete silently.
  const hasData = cp.condition || cp.paid || cp.notes || cp.variant || cp.location || (Array.isArray(cp.accessories) && cp.accessories.length);
  if (hasData && !await appConfirm('Remove this copy and its data?', {danger: true, ok: 'Remove'})) return;
  const newCopies = c.copies.filter(x => x.id !== copyId);
  // If this was the last copy and the figure is owned, leave a single
  // empty copy so the form is still editable. The user can change status
  // to wishlist if they no longer own one.
  if (newCopies.length === 0 && (c.status === 'owned' || c.status === 'for-sale')) {
    newCopies.push({ id: 1 });
  }
  S.coll[id] = {...c, copies: newCopies};
  saveColl();
  haptic();
  patchDetailStatus();
};

window.updateCopy = (id, copyId, key, val) => {
  const c = S.coll[id];
  if (!c) return;
  // Auto-migrate (defensive — shouldn't happen post-v4.42 init).
  let next = isMigrated(c) ? {...c, copies: c.copies.map(cp => ({...cp}))} : migrateEntry(c);
  if (!next.copies) next.copies = [];
  let cp = next.copies.find(x => x.id === copyId);
  if (!cp) {
    // Copy id no longer exists (race with removeCopy?). Bail.
    return;
  }
  if (val === '' || val == null) delete cp[key];
  else cp[key] = val;
  S.coll[id] = next;
  saveColl();
  // v4.91: if the key is 'location', refresh the datalist so the value is
  // immediately available as a suggestion in other copies' location inputs
  // within the same detail view.
  if (key === 'location') {
    const dl = document.getElementById('locationSuggestions');
    if (dl) {
      dl.innerHTML = getAllLocations().map(l => `<option value="${esc(l)}"></option>`).join('');
    }
  }
};

// Copy-field debounce — same pattern as _updDebounces. See flushFieldDebounces().
const _copyDebounces = {};  // { dk: {timer, args: [id,copyId,key,val]} }
window.updateCopyDebounced = (id, copyId, key, val) => {
  const dk = id + ':' + copyId + ':' + key;
  if (_copyDebounces[dk]) clearTimeout(_copyDebounces[dk].timer);
  _copyDebounces[dk] = {
    args: [id, copyId, key, val],
    timer: setTimeout(() => {
      window.updateCopy(id, copyId, key, val);
      delete _copyDebounces[dk];
    }, 400),
  };
};

// Update ordered-status fields (orderedFrom, orderedDate, orderedPaid).
// These live on the collection entry directly, not on a copy.
window.updateOrderedField = (id, key, val) => {
  const c = S.coll[id];
  if (!c) return;
  const next = {...c};
  if (val === '' || val == null) delete next[key];
  else next[key] = val;
  S.coll[id] = next;
  saveColl();
};

// ─── Accessories + Location (v4.87) ──────────────────────────────
// Per-copy accessories array and free-text location field. Stored as
// cp.accessories = ['Power Sword', 'Cape', ...] and cp.location = 'Shelf A'.
// updateCopy already supports arbitrary keys, so add/remove just mutate
// the array and re-save.

// Collect all distinct location strings in use across the entire collection,
// sorted alphabetically. Used to populate the <datalist> for autocomplete.
function getAllLocations() {
  const set = new Set();
  for (const id in S.coll) {
    const e = S.coll[id];
    if (!e || !e.copies) continue;
    for (const cp of e.copies) {
      if (cp && cp.location) set.add(cp.location);
    }
  }
  return [...set].sort((a,b) => a.localeCompare(b));
}

window.addAccessory = (figId, copyId, name) => {
  if (!name) return;
  const c = S.coll[figId];
  if (!c || !isMigrated(c)) return;
  const next = {...c, copies: c.copies.map(cp => ({...cp}))};
  const cp = next.copies.find(x => x.id === copyId);
  if (!cp) return;
  const list = Array.isArray(cp.accessories) ? [...cp.accessories] : [];
  if (!list.includes(name)) list.push(name);
  cp.accessories = list;
  S.coll[figId] = next;
  saveColl();
  // Picker is open — re-render it so the checkmark appears. If we're not
  // in the picker (e.g. custom-add flow), fall back to detail re-render.
  if (S.sheet === 'accessoryPicker') renderSheetBody();
  else patchDetailStatus();
};

window.removeAccessory = (figId, copyId, idx) => {
  const c = S.coll[figId];
  if (!c || !isMigrated(c)) return;
  const next = {...c, copies: c.copies.map(cp => ({...cp}))};
  const cp = next.copies.find(x => x.id === copyId);
  if (!cp || !Array.isArray(cp.accessories)) return;
  const list = [...cp.accessories];
  list.splice(idx, 1);
  if (list.length) cp.accessories = list;
  else delete cp.accessories;  // keep entries clean — no empty arrays
  S.coll[figId] = next;
  saveColl();
  haptic();
  // v4.91: if the accessory picker is open, re-render the picker body so the
  // tapped item's checkmark disappears immediately. Previously only addAccessory
  // did this, which meant tapping to REMOVE appeared to do nothing until a
  // subsequent tap on another item triggered the refresh.
  if (S.sheet === 'accessoryPicker') renderSheetBody();
  else patchDetailStatus();
};

// Called from the picker sheet when the user taps one of the canonical
// accessories. Toggles membership: adds if missing, removes if present.
window.toggleAccessoryInPicker = name => {
  const figId = S._accPickFigId, copyId = S._accPickCopyId;
  if (!figId || copyId == null) return;
  const c = S.coll[figId];
  if (!c || !isMigrated(c)) return;
  const cp = c.copies.find(x => x.id === copyId);
  if (!cp) return;
  const list = Array.isArray(cp.accessories) ? cp.accessories : [];
  const idx = list.indexOf(name);
  if (idx >= 0) window.removeAccessory(figId, copyId, idx);
  else window.addAccessory(figId, copyId, name);
  haptic();
};

window.addCustomAccessory = () => {
  const input = document.getElementById('accPickerCustomInput');
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;
  window.addAccessory(S._accPickFigId, S._accPickCopyId, val);
  input.value = '';
  haptic();
};

window.openAccessoryPicker = (figId, copyId) => {
  S._accPickFigId = figId;
  S._accPickCopyId = copyId;
  openSheet('accessoryPicker');
};

// Lightweight re-render of just the sheet body — used by the picker so
// toggling an accessory updates the checkmarks without rebuilding the
// whole app. Falls back to full render() if the body element is missing.
function renderSheetBody() {
  const body = document.querySelector('.sheet-body');
  if (!body || S.sheet !== 'accessoryPicker') { render(); return; }
  body.innerHTML = renderAccessoryPickerSheet();
}

function renderAccessoryPickerSheet() {
  const figId = S._accPickFigId, copyId = S._accPickCopyId;
  const c = figId ? S.coll[figId] : null;
  const cp = (c && isMigrated(c)) ? c.copies.find(x => x.id === copyId) : null;
  const current = (cp && Array.isArray(cp.accessories)) ? cp.accessories : [];
  const currentSet = new Set(current);
  // v5.03: per-figure accessory availability list. If set for this figId,
  // the picker only offers those (plus anything already on the copy or
  // custom-added). Useful for "Battle Armor He-Man only came with Sword,
  // Battle Axe, and mini comic" — limit the picker to those three.
  const allAvail = getAccAvail();
  const figAvail = allAvail[figId];   // array | undefined
  const adminMode = !!S._accPickAdmin;
  // In admin mode, ALL global accessories are listed with the figure's
  // available subset checked. Tapping toggles inclusion in the available
  // list (does NOT touch what's on the copy).
  let h = '';
  if (!cp) {
    return '<div class="text-dim text-sm" style="padding:20px;text-align:center">Copy no longer exists.</div>';
  }
  const jsArg = s => esc(JSON.stringify(s));

  // Header / mode toggle
  if (adminMode) {
    h += `<div class="text-dim text-sm" style="margin-bottom:8px;line-height:1.5">
      Editing available accessories for this figure. Selected items will be the only ones offered when checking off accessories. Leave all unchecked to allow everything.
    </div>
    <div style="display:flex;gap:6px;margin-bottom:10px">
      <button onclick="S._accPickAdmin=false;renderSheetBody()" style="padding:7px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--bg3);color:var(--t1);font-size:12px">‹ Back to Picker</button>
      <button onclick="resetAccAvail('${esc(figId)}')" style="padding:7px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--bg3);color:var(--t3);font-size:12px">Reset to All</button>
    </div>`;
  } else {
    h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <div class="text-dim text-sm">Tap to toggle. ${figAvail ? '<span style="color:var(--acc)">Filtered list active.</span>' : 'Added items apply to this copy only.'}</div>
      <button onclick="S._accPickAdmin=true;renderSheetBody()" title="Edit available accessories" style="padding:5px 10px;border-radius:8px;border:1px solid var(--bd);background:var(--bg3);color:var(--t3);font-size:11px;font-weight:600">⚙ Limit list</button>
    </div>`;
  }

  h += `<div class="acc-picker-list">`;
  if (adminMode) {
    // Admin mode: list ALL global accessories. Checked = part of figure's
    // available list. customSelected aren't shown here (they're per-copy
    // tags, not picker options).
    const figAvailSet = new Set(figAvail || []);
    ACCESSORIES.forEach(name => {
      const on = figAvailSet.has(name);
      h += `<button class="acc-picker-item${on ? ' selected' : ''}" onclick="toggleAccAvail(${jsArg(name)})">
        <span>${esc(name)}</span>
        ${on ? '<span class="acc-picker-check">✓</span>' : ''}
      </button>`;
    });
  } else {
    // Normal mode: show only the figure's available list (or all, if none).
    // Custom-already-on-copy entries surface at top so they can be removed.
    const customSelected = current.filter(a => !ACCESSORIES.includes(a));
    customSelected.forEach(name => {
      h += `<button class="acc-picker-item selected" onclick="toggleAccessoryInPicker(${jsArg(name)})">
        <span>${esc(name)}</span>
        <span class="acc-picker-check">✓</span>
      </button>`;
    });
    const offerList = (figAvail && figAvail.length) ? figAvail : ACCESSORIES;
    offerList.forEach(name => {
      const on = currentSet.has(name);
      h += `<button class="acc-picker-item${on ? ' selected' : ''}" onclick="toggleAccessoryInPicker(${jsArg(name)})">
        <span>${esc(name)}</span>
        ${on ? '<span class="acc-picker-check">✓</span>' : ''}
      </button>`;
    });
  }
  h += `</div>`;
  if (!adminMode) {
    h += `<div class="acc-picker-custom">
      <input type="text" id="accPickerCustomInput" placeholder="Custom accessory…" maxlength="60"
             onkeydown="if(event.key==='Enter'){event.preventDefault();addCustomAccessory()}">
      <button onclick="addCustomAccessory()">Add</button>
    </div>`;
  }
  h += `<div style="margin-top:14px;display:flex;justify-content:flex-end">
    <button onclick="S._accPickAdmin=false;closeSheet()" style="padding:10px 18px;border-radius:10px;background:var(--bg3);border:1px solid var(--bd);color:var(--t1);font-size:13px;font-weight:600">Done</button>
  </div>`;
  return h;
}

// v5.03: per-figure accessory availability
const ACC_AVAIL_KEY = 'motu-acc-avail';
function getAccAvail() {
  try { return JSON.parse(localStorage.getItem(ACC_AVAIL_KEY) || '{}'); }
  catch { return {}; }
}
function saveAccAvail(map) {
  try { localStorage.setItem(ACC_AVAIL_KEY, JSON.stringify(map)); } catch {}
}
window.toggleAccAvail = name => {
  const figId = S._accPickFigId; if (!figId) return;
  const all = getAccAvail();
  const list = new Set(all[figId] || []);
  if (list.has(name)) list.delete(name); else list.add(name);
  if (list.size === 0) delete all[figId];
  else all[figId] = [...list];
  saveAccAvail(all);
  renderSheetBody();
};
window.resetAccAvail = figId => {
  const all = getAccAvail();
  delete all[figId];
  saveAccAvail(all);
  renderSheetBody();
};

// Synchronously apply any pending field debounces. Called from unload
// handlers so note edits typed within 400ms of backgrounding aren't lost.
// Must run BEFORE flushSaveColl so the writes land in S.coll, then get
// persisted by the collection flush.
function flushFieldDebounces() {
  for (const dk in _updDebounces) {
    const entry = _updDebounces[dk];
    if (!entry) continue;
    clearTimeout(entry.timer);
    try { updateColl(...entry.args); } catch {}
    delete _updDebounces[dk];
  }
  for (const dk in _copyDebounces) {
    const entry = _copyDebounces[dk];
    if (!entry) continue;
    clearTimeout(entry.timer);
    try { window.updateCopy(...entry.args); } catch {}
    delete _copyDebounces[dk];
  }
}

// § Derived-state cache — invalidates when inputs change, saves re-computing
// getStats() and getSortedFigs() on every render() call.
// Key covers all state that affects either result.
const _derived = {
  _statsKey: null, _sortedKey: null, _sorted: null, _stats: null,
  _makeKey() {
    // v4.86: reuse S._hiddenKey (already maintained by figIsHidden / toggleHidden)
    // instead of re-joining hiddenItems on every render. Also use S._collVersion
    // (bumped by saveColl) instead of Object.keys(S.coll).length, which allocated
    // an array of ~600 keys on every key check.
    if (S._hiddenKey == null) S._hiddenKey = S.hiddenItems.length ? S.hiddenItems.join('|') : '';
    return [
      S.tab, S.activeLine, S.activeSubline, S.search,
      S.sortBy, S.filterFaction, S.filterStatus,
      S.filterVariants ? 1 : 0, S.filterLine,
      S.figs.length, S._hiddenKey,
      S._collVersion,
    ].join('\x00');
  },
  invalidate() { this._statsKey = null; this._sortedKey = null; this._sorted = null; this._stats = null; },
};

function getStats() {
  const k = _derived._makeKey();
  if (_derived._statsKey === k && _derived._stats) return _derived._stats;
  _derived._statsKey = k;
  _derived._stats = _computeStats();
  return _derived._stats;
}

function getSortedFigs() {
  const k = _derived._makeKey();
  if (_derived._sortedKey === k && _derived._sorted) return _derived._sorted;
  _derived._sortedKey = k;
  _derived._sorted = _computeSortedFigs();
  return _derived._sorted;
}

function _computeStats() {
  let total = 0, owned = 0, wish = 0, ord = 0, sale = 0;
  for (const f of S.figs) {
    if (figIsHidden(f)) continue;
    total++;
    const s = S.coll[f.id]?.status;
    if (s === 'owned') owned++;
    else if (s === 'wishlist') wish++;
    else if (s === 'ordered') ord++;
    else if (s === 'for-sale') sale++;
  }
  return { total, owned, wish, ord, sale };
}

function _computeSortedFigs() {
  let list = S.figs.filter(f => !figIsHidden(f));
  const isSearch = S.search.length > 0;
  if (S.activeLine) list = list.filter(f => f.line === S.activeLine);
  if (!isSearch && S.activeSubline && S.activeSubline !== '__all__') {
    const subs = SUBLINES[S.activeLine] || [];
    const sl = subs.find(s => s.key === S.activeSubline);
    if (sl) list = list.filter(f => sl.groups.includes(f.group));
  }
  if (!isSearch && S.tab === 'collection') list = list.filter(f => S.coll[f.id]?.status);
  if (S.filterLine) list = list.filter(f => f.line === S.filterLine);
  if (S.filterFaction) list = list.filter(f => f.faction === S.filterFaction);
  if (S.filterStatus === 'unowned') list = list.filter(f => !S.coll[f.id]?.status);
  else if (S.filterStatus) list = list.filter(f => S.coll[f.id]?.status === S.filterStatus);
  if (S.filterVariants) list = list.filter(f => /\w/.test(copyVariant(S.coll[f.id]) || ''));
  if (S.search) {
    const s = S.search.toLowerCase().replace(/[-'']/g, '');
    list = list.filter(f => {
      const name = f.name.toLowerCase().replace(/[-'']/g, '');
      if (name.includes(s)) return true;
      const lineName = ln(f.line).toLowerCase().replace(/[-'']/g, '');
      const group = (f.group||'').toLowerCase().replace(/[-'']/g, '');
      return lineName.includes(s) || group.includes(s);
    });
  }
  const sb = S.sortBy;
  if (sb === 'name') list.sort((a,b) => a.name.localeCompare(b.name));
  else if (sb === 'name-desc') list.sort((a,b) => b.name.localeCompare(a.name));
  else if (sb === 'year') list.sort((a,b) => (a.year||9999)-(b.year||9999));
  else if (sb === 'year-desc') list.sort((a,b) => (b.year||0)-(a.year||0));
  else if (sb === 'wave') list.sort((a,b) => { const na=parseFloat(a.wave||''),nb=parseFloat(b.wave||''); return (isNaN(na)?99:na)-(isNaN(nb)?99:nb); });
  else if (sb === 'retail') list.sort((a,b) => (a.retail||0)-(b.retail||0));
  else if (sb === 'retail-desc') list.sort((a,b) => (b.retail||0)-(a.retail||0));
  return list;
}

// v4.86: restored missing `function getLineStats() {` declaration. The body
// existed as orphan code (causing `Unexpected token '}'` at the trailing
// brace and `Illegal return` at line 3697 in classic-script parsers).
// getLineStats is called twice in renderLinesGrid / renderLinesGridContent.
function getLineStats() {
  const agg = {}; // lineId -> {total, owned}
  for (const f of S.figs) {
    if (figIsHidden(f)) continue;
    const a = agg[f.line] || (agg[f.line] = {total: 0, owned: 0});
    a.total++;
    if (S.coll[f.id]?.status === 'owned') a.owned++;
  }
  return LINES.map(l => {
    const a = agg[l.id] || {total: 0, owned: 0};
    return {...l, total: a.total, owned: a.owned, pct: a.total ? Math.round(a.owned/a.total*100) : 0};
  });
}

function hasFilters() { return S.search || S.filterFaction || S.filterStatus || S.filterVariants || S.filterLine; }

function progressRing(pct, size=48, color='var(--acc)') {
  const r = (size/2)-4, circ = 2*Math.PI*r;
  const complete = pct === 100;
  const c = complete ? 'var(--gn)' : color;
  return `<svg width="${size}" height="${size}"><circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--bd)" stroke-width="3"/>` +
    `<circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${c}" stroke-width="3" ` +
    `stroke-dasharray="${circ}" stroke-dashoffset="${circ*(1-pct/100)}" stroke-linecap="round" transform="rotate(-90 ${size/2} ${size/2})" style="transition:stroke-dashoffset .4s"/>` +
    `<text x="${size/2}" y="${size/2+4}" text-anchor="middle" fill="${c}" font-size="11" font-weight="700" font-family="'Outfit',sans-serif">${pct}%</text></svg>`;
}

// § IMPORT-EXPORT ── exportCSV, exportJSON, importJSON, doImport*, ZIP encoder ──
// v4.86: restored missing `function exportCSV(filter) {` declaration. The
// body remained as orphan code in v4.77 (never shipped) — header was lost
// in a refactor. Matches the v4.73 production signature.
function exportCSV(filter) {
  const h = ['Name','Line','Group','Wave','Year','Retail','Faction','Status','Copy #','Condition','Paid','Variant','Accessories','Location','Notes'];
  let list = S.figs;
  if (filter === 'owned') list = list.filter(f => S.coll[f.id]?.status === 'owned');
  else if (filter === 'wishlist') list = list.filter(f => S.coll[f.id]?.status === 'wishlist');
  else if (filter === 'ordered') list = list.filter(f => S.coll[f.id]?.status === 'ordered');
  else if (filter === 'for-sale') list = list.filter(f => S.coll[f.id]?.status === 'for-sale');
  else if (filter === 'unowned') list = list.filter(f => !S.coll[f.id]?.status);
  else if (filter === 'any-status') list = list.filter(f => S.coll[f.id]?.status);
  const rows = [];
  let totalRowCount = 0;
  for (const f of list) {
    const c = S.coll[f.id] || {};
    const base = [f.name, ln(f.line), f.group, f.wave, f.year, f.retail, f.faction, c.status || ''];
    if (isMigrated(c) && c.copies.length > 0) {
      // One row per copy. Copy # is 1-indexed.
      c.copies.forEach((cp, i) => {
        const acc = Array.isArray(cp.accessories) ? cp.accessories.join('; ') : '';
        rows.push([...base, i + 1, cp.condition || '', cp.paid || '', cp.variant || '', acc, cp.location || '', cp.notes || '']);
        totalRowCount++;
      });
    } else if (!isMigrated(c) && (c.condition || c.paid || c.notes || c.variants)) {
      // Defensive: legacy entry that somehow escaped migration
      rows.push([...base, 1, c.condition || '', c.paid || '', c.variants || '', '', '', c.notes || '']);
      totalRowCount++;
    } else {
      // No copies (wishlist / ordered / unowned with status only)
      rows.push([...base, '', '', '', '', '', '', '']);
      totalRowCount++;
    }
  }
  const csv = [h, ...rows].map(r => r.map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  const a = document.createElement('a');
  const suffix = filter ? '-' + filter : '';
  a.href = url; a.download = 'motu' + suffix + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  const summary = totalRowCount === list.length
    ? `✓ Exported ${list.length} figures`
    : `✓ Exported ${list.length} figures · ${totalRowCount} rows`;
  toast(summary);
}

// ─── Minimal ZIP encoder (STORE method, no compression) ──────────
// Produces a valid uncompressed .zip file. Photos are already JPEG, so
// compression wouldn't help much anyway. Pure-JS, no dependencies.
// Spec: PKWARE APPNOTE.TXT (only the bits we actually need).
const _crc32Table = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = _crc32Table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function _u16le(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
function _u32le(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }
async function buildZip(entries) {
  // entries: [{name: string, blob: Blob}, ...]
  // Yields to the event loop every 5 entries so the "Packaging…" toast
  // actually renders and the UI doesn't freeze on large photo sets.
  const enc = new TextEncoder();
  const localChunks = [];
  const centralDirChunks = [];
  let offset = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const nameBytes = enc.encode(entry.name);
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    const crc = crc32(data);
    // Local file header
    const lfh = [
      ..._u32le(0x04034b50), ..._u16le(20), ..._u16le(0),
      ..._u16le(0), ..._u16le(0), ..._u16le(0),
      ..._u32le(crc), ..._u32le(data.length), ..._u32le(data.length),
      ..._u16le(nameBytes.length), ..._u16le(0),
    ];
    localChunks.push(new Uint8Array(lfh), nameBytes, data);
    // Central directory header
    const cdh = [
      ..._u32le(0x02014b50), ..._u16le(20), ..._u16le(20), ..._u16le(0),
      ..._u16le(0), ..._u16le(0), ..._u16le(0),
      ..._u32le(crc), ..._u32le(data.length), ..._u32le(data.length),
      ..._u16le(nameBytes.length), ..._u16le(0), ..._u16le(0),
      ..._u16le(0), ..._u16le(0), ..._u32le(0), ..._u32le(offset),
    ];
    centralDirChunks.push(new Uint8Array(cdh), nameBytes);
    offset += lfh.length + nameBytes.length + data.length;
    // Yield every 5 entries so the UI can breathe
    if (i % 5 === 4 && i < entries.length - 1) {
      await new Promise(r => requestAnimationFrame(r));
    }
  }
  const cdSize = centralDirChunks.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array([
    ..._u32le(0x06054b50), ..._u16le(0), ..._u16le(0),
    ..._u16le(entries.length), ..._u16le(entries.length),
    ..._u32le(cdSize), ..._u32le(offset), ..._u16le(0),
  ]);
  return new Blob([...localChunks, ...centralDirChunks, eocd], { type: 'application/zip' });
}

// Sanitize a string for use in a ZIP filename (replaces problematic chars).
function _zipSafeName(s) {
  return String(s || '').replace(/[\/\\?%*:|"<>\x00-\x1f]/g, '_').slice(0, 80);
}

window.exportPhotosZip = async () => {
  const ids = Object.keys(S.customPhotos).filter(id => (S.customPhotos[id] || []).length > 0);
  if (ids.length === 0) { toast('✗ No custom photos to export'); return; }
  toast('Packaging photos…');
  const entries = [];
  let total = 0;
  for (const figId of ids) {
    const fig = figById(figId);
    const figName = fig ? _zipSafeName(fig.name) : figId;
    const blobs = await photoStore.getAllAsBlobs(figId);
    blobs.forEach(({n, label, blob}) => {
      // Folder structure: <figure-name>__<figId>/<n>-<label>.jpg
      // The figId is included so duplicates of the same name don't collide.
      const labelPart = label ? '-' + _zipSafeName(label) : '';
      const fileName = `${figName}__${figId}/${String(n).padStart(2,'0')}${labelPart}.jpg`;
      entries.push({ name: fileName, blob });
      total++;
    });
  }
  if (entries.length === 0) { toast('✗ No photos found'); return; }
  // Manifest file inside the zip mapping figId → figure name + photo list
  const manifest = ids.map(figId => {
    const fig = figById(figId);
    return {
      figId,
      name: fig ? fig.name : figId,
      line: fig ? fig.line : null,
      photos: (S.customPhotos[figId] || []).map(p => ({ n: p.n, label: p.label || '' })),
    };
  });
  entries.push({
    name: 'manifest.json',
    blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
  });
  const zip = await buildZip(entries);
  const url = URL.createObjectURL(zip);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = `motu-vault-photos-${ts}.zip`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`✓ Exported ${total} photos`);
};

async function exportJSON() {
  const backup = {
    version: 'motu-vault-backup-v4',  // v4: includes per-copy photo assignments + figure overrides
    exported: new Date().toISOString(),
    collection: S.coll,
    photos: {},
    photoCopy: _photoCopy,  // {figId: {n: copyId}} — which copy each photo belongs to
    overrides: _overrides,  // {figId: {fields: {...}}} — local field patches
  };
  // Include custom photos as arrays of {label, dataUrl}
  let totalPhotos = 0;
  for (const id of Object.keys(S.customPhotos)) {
    const photos = await photoStore.exportAllAsDataURLs(id);
    if (photos.length) {
      backup.photos[id] = photos;
      totalPhotos += photos.length;
    }
  }
  const blob = new Blob([JSON.stringify(backup, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'motu-vault-backup.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`✓ Backup saved · ${totalPhotos} photos`);
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const backup = JSON.parse(ev.target.result);
      const knownVersions = ['motu-vault-backup-v1', 'motu-vault-backup-v2', 'motu-vault-backup-v3', 'motu-vault-backup-v4'];
      if (!knownVersions.includes(backup.version)) throw new Error('Unknown format');
      if (!backup.collection || typeof backup.collection !== 'object') throw new Error('Invalid collection data');
      const overwrite = document.querySelector('.checkbox.checked') !== null;
      let imported = 0, skipped = 0, photos = 0;
      // v1/v2 backups have flat-shape entries; v3 has copies[]. migrateEntry
      // is idempotent so it's safe to run on either.
      Object.entries(backup.collection).forEach(([id, entry]) => {
        if (!overwrite && S.coll[id]?.status) { skipped++; return; }
        const incoming = migrateEntry(entry);
        if (overwrite) {
          S.coll[id] = incoming;
        } else {
          // Merge: keep existing copies, append incoming copies as additional
          // ones (avoiding obvious dupes by paid+condition+notes signature).
          const existing = S.coll[id];
          if (!existing) {
            S.coll[id] = incoming;
          } else {
            const merged = isMigrated(existing) ? {...existing, copies: [...existing.copies]} : migrateEntry(existing);
            if (incoming.status && !merged.status) merged.status = incoming.status;
            if (incoming.copies) {
              const sig = c => [c.condition||'', c.paid||'', c.variant||'', (c.notes||'').slice(0,40)].join('|');
              const have = new Set((merged.copies||[]).map(sig));
              let nextId = (merged.copies||[]).reduce((m,c) => Math.max(m, c.id||0), 0) + 1;
              for (const cp of incoming.copies) {
                if (!have.has(sig(cp))) {
                  merged.copies.push({...cp, id: nextId++});
                }
              }
            }
            S.coll[id] = merged;
          }
        }
        imported++;
      });
      saveColl();
      // Restore photos (handle both v1 single-photo and v2/v3/v4 multi-photo formats)
      if (backup.photos) {
        for (const [id, val] of Object.entries(backup.photos)) {
          // v1 format: photos[id] is a single dataUrl string
          // v2+ format: photos[id] is an array of {label, dataUrl}
          const photoArr = typeof val === 'string'
            ? [{label: '', dataUrl: val}]
            : (Array.isArray(val) ? val : []);
          const count = await photoStore.importPhotos(id, photoArr);
          photos += count;
        }
      }
      // v4: restore per-copy photo assignments
      if (backup.photoCopy && typeof backup.photoCopy === 'object') {
        if (overwrite) {
          _photoCopy = {...backup.photoCopy};
        } else {
          // Merge — incoming wins on conflict
          for (const [figId, m] of Object.entries(backup.photoCopy)) {
            _photoCopy[figId] = {...(_photoCopy[figId] || {}), ...m};
          }
        }
        savePhotoCopyMap();
      }
      // v4 (added later): restore figure field overrides
      if (backup.overrides && typeof backup.overrides === 'object') {
        if (overwrite) {
          _overrides = {...backup.overrides};
        } else {
          for (const [figId, m] of Object.entries(backup.overrides)) {
            const incoming = m?.fields || {};
            const existing = _overrides[figId]?.fields || {};
            _overrides[figId] = { fields: { ...existing, ...incoming } };
          }
        }
        saveOverrides();
        // Re-apply against current S.figs so the view updates without a reload
        rebuildFigIndex();
      }
      const body = document.querySelector('.sheet-body');
      if (body) {
        body.innerHTML = `<div style="text-align:center;padding:20px 0">
          <div style="font-size:48px;margin-bottom:12px">${imported>0?'✅':'🤷'}</div>
          <div class="font-display" style="font-size:22px;color:var(--gold);margin-bottom:4px">${imported} restored</div>
          ${skipped>0 ? `<div class="text-sm text-dim" style="margin-bottom:4px">${skipped} skipped (already set)</div>` : ''}
          ${photos>0 ? `<div class="text-sm text-dim">${photos} photos restored</div>` : ''}
        </div>`;
      }
      // Ensure the collection write hits localStorage before the user can
      // close the app. The view re-renders automatically via popstate when
      // the sheet is dismissed, so no render() here (it would clobber the
      // success summary above).
      flushSaveColl();
    } catch(e) {
      toast('✗ Invalid backup: ' + e.message.slice(0, 80));
    }
  };
  reader.readAsText(file);
}

window.exportJSON = exportJSON;

// v4.99: export/import app settings separately from collection data.
// Includes theme, sort, view mode, line order, hidden items, recent
// changes — anything that's a UI/preference toggle, NOT collection data.
// Useful when setting up a new device without touching what's already there.
const SETTINGS_KEYS = [
  'motu-theme', 'motu-sort', 'motu-view', 'motu-lines-view', 'motu-line-order',
  'motu-hidden', 'motu-recent', 'motu-default-photo', 'motu-onboarded',
  'motu-celebrated', 'motu-ptr-enabled', 'motu-acc-avail', 'motu-custom-figs',
];
window.exportSettings = () => {
  const settings = {};
  for (const k of SETTINGS_KEYS) {
    const v = store.get(k);
    if (v != null) settings[k] = v;
  }
  const payload = { version: 'motu-vault-settings-v1', exportedAt: Date.now(), settings };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `motu-vault-settings-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  toast('✓ Settings exported');
};

window.importSettings = file => {
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const payload = JSON.parse(ev.target.result);
      if (payload.version !== 'motu-vault-settings-v1' || !payload.settings) {
        toast('✗ Not a settings file'); return;
      }
      let restored = 0;
      for (const k of SETTINGS_KEYS) {
        if (payload.settings[k] != null) {
          store.set(k, payload.settings[k]);
          restored++;
        }
      }
      toast(`✓ Restored ${restored} settings — reloading…`);
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      toast('✗ Import failed: ' + e.message);
    }
  };
  reader.readAsText(file);
};

window.handleImportFile = input => {
  const file = input.files?.[0]; if (!file) return;
  if (file.name.endsWith('.json')) {
    // v4.99: peek at the version field to route between collection backup
    // and settings backup automatically.
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const peek = JSON.parse(ev.target.result);
        if (peek.version === 'motu-vault-settings-v1') {
          window.importSettings(file);
        } else {
          importJSON(file);
        }
      } catch {
        importJSON(file);  // fallthrough; importJSON will surface its own error
      }
    };
    reader.readAsText(file);
    return;
  }
  handleCSV(input);
};

function renderExportSheet() {
  const stats = getStats();
  // v4.86: single linear scan instead of 5 separate S.figs.filter() passes.
  // anyStatus is the count of figures with any status set; the per-status
  // counts (wish/ord/sale) come from getStats() which already has them, but
  // getStats only includes non-hidden figures and we want the unfiltered
  // export totals here, so we re-tally locally.
  let anyStatus = 0, wish = 0, ord = 0, sale = 0, unowned = 0;
  for (const f of S.figs) {
    const s = S.coll[f.id]?.status;
    if (!s) { unowned++; continue; }
    anyStatus++;
    if (s === 'wishlist') wish++;
    else if (s === 'ordered') ord++;
    else if (s === 'for-sale') sale++;
  }
  const photoCount = Object.values(S.customPhotos).reduce((sum, arr) => sum + (arr?.length || 0), 0);
  const opts = [
    {filter:'', label:'Full Catalog', count:S.figs.length},
    {filter:'any-status', label:'All w/ Status', count:anyStatus},
    {filter:'owned', label:'Owned', count:stats.owned},
    {filter:'wishlist', label:'Wishlist', count:wish},
    {filter:'ordered', label:'Ordered', count:ord},
    {filter:'for-sale', label:'For Sale', count:sale},
    {filter:'unowned', label:'Unowned', count:unowned},
  ];
  let html = '<div class="label text-upper text-dim text-xs" style="margin-bottom:10px">CSV Export</div>';
  html += opts.map(o => `
    <button onclick="exportCSV('${o.filter}');closeSheet()" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);margin-bottom:8px;text-align:left;font-size:15px;color:var(--t1)">
      <span>${o.label}</span>
      <span style="color:var(--t3);font-size:12px">${o.count} figures</span>
    </button>`).join('');
  html += '<div style="height:1px;background:var(--bd);margin:16px 0"></div>';
  html += '<div class="label text-upper text-dim text-xs" style="margin-bottom:10px">Full Backup (JSON)</div>';
  html += `<button onclick="exportJSON();closeSheet()" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-radius:12px;border:1px solid var(--gold);background:color-mix(in srgb, var(--gold) 8%, transparent);margin-bottom:8px;text-align:left;font-size:15px;color:var(--gold)">
    <span>Backup Collection + Photos</span>
    <span style="color:var(--t3);font-size:12px">${anyStatus} entries · ${photoCount} photos</span>
  </button>`;
  html += '<div class="text-sm text-dim" style="line-height:1.5">Includes all statuses, conditions, notes, variants, and custom photos. Use to restore your full collection.</div>';
  if (photoCount > 0) {
    html += '<div style="height:1px;background:var(--bd);margin:16px 0"></div>';
    html += '<div class="label text-upper text-dim text-xs" style="margin-bottom:10px">Photos Only (ZIP)</div>';
    html += `<button onclick="exportPhotosZip();closeSheet()" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);margin-bottom:8px;text-align:left;font-size:15px;color:var(--t1)">
      <span>Download Photos as ZIP</span>
      <span style="color:var(--t3);font-size:12px">${photoCount} photos</span>
    </button>`;
    html += '<div class="text-sm text-dim" style="line-height:1.5">Downloads all custom photos as a ZIP archive, organized by figure folder. Useful for backing up to cloud storage (Drive, Dropbox, etc.) or transferring to another device.</div>';
  }
  // v4.99: settings export — separate from collection data, useful for
  // moving theme/sort/view/line-order preferences to another device.
  html += '<div style="height:1px;background:var(--bd);margin:16px 0"></div>';
  html += '<div class="label text-upper text-dim text-xs" style="margin-bottom:10px">Settings Only</div>';
  html += `<button onclick="exportSettings();closeSheet()" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);margin-bottom:8px;text-align:left;font-size:15px;color:var(--t1)">
    <span>Export App Settings</span>
    <span style="color:var(--t3);font-size:12px">theme · sort · order</span>
  </button>`;
  html += '<div class="text-sm text-dim" style="line-height:1.5">Just the preferences — theme, sort order, view mode, line order, hidden items, recent changes. Does NOT include collection data or photos.</div>';
  return html;
}

function doImport(csvText, overwrite = false) {
  // Detect format: MOTU Vault export has 'Line' header, AF411 has 'Series'
  const firstLine = csvText.split('\n')[0] || '';
  const isVaultFormat = /\bLine\b/.test(firstLine) && !/\bSeries\b/.test(firstLine);

  if (isVaultFormat) return doImportVault(csvText, overwrite);
  return doImportAF411(csvText, overwrite);
}

// Reverse map: line name → line id
const LINE_ID_MAP = Object.fromEntries(LINES.map(l => [l.name, l.id]));

function buildFigIndexes() {
  const idx4 = {}, idx3 = {}, idx2 = {};
  S.figs.forEach(f => {
    const k4 = normalize(f.name)+'|'+f.line+'|'+normalize(f.group||'')+'|'+normalize(f.wave||'');
    const k3 = normalize(f.name)+'|'+f.line+'|'+normalize(f.group||'');
    const k2 = normalize(f.name)+'|'+f.line;
    if (!idx4[k4]) idx4[k4] = f;
    if (!idx3[k3]) idx3[k3] = f;
    idx2[k2] = idx2[k2] ? 'AMBIGUOUS' : f;
  });
  return {idx4, idx3, idx2};
}
function doImportVault(csvText, overwrite) {
  const lines = csvText.split('\n').filter(l => l.trim());
  const parseRow = line => {
    const cols = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === ',' && !inQ) { cols.push(cur); cur = ''; }
      else cur += c;
    }
    cols.push(cur); return cols;
  };
  const headers = parseRow(lines[0]).map(h => h.trim());
  const col = h => headers.indexOf(h);
  const [iName,iLine,iGroup,iWave,iStatus,iCond,iPaid,iNotes] =
    ['Name','Line','Group','Wave','Status','Condition','Paid','Notes'].map(col);
  // v4.87: Accessories + Location are optional columns — missing columns
  // stay blank without breaking older CSV exports.
  const iVariant = col('Variant');
  const iAcc = col('Accessories');
  const iLoc = col('Location');
  // v4.95: read Copy # for multi-copy round-trip. If absent (older exports
  // or single-copy lines), each row gets a unique copy id.
  const iCopyNum = col('Copy #');

  const {idx4, idx3, idx2} = buildFigIndexes();

  const matchedIds = new Set();
  let skipped = 0; const unmatched = [];

  lines.slice(1).forEach(l => {
    const c = parseRow(l);
    const name = c[iName]?.trim();
    if (!name) return;
    const lineName = c[iLine]?.trim() || '';
    const lineId = LINE_ID_MAP[lineName] || lineName.toLowerCase().replace(/\s+/g,'-');
    const group = c[iGroup]?.trim() || '';
    const wave = c[iWave]?.trim() || '';
    const status = c[iStatus]?.trim() || '';
    const cond = c[iCond]?.trim() || '';
    const paid = c[iPaid]?.trim() || '';
    const notes = c[iNotes]?.trim() || '';
    const variant = iVariant >= 0 ? (c[iVariant]?.trim() || '') : '';
    const accRaw = iAcc >= 0 ? (c[iAcc]?.trim() || '') : '';
    const location = iLoc >= 0 ? (c[iLoc]?.trim() || '') : '';

    const k4 = normalize(name)+'|'+lineId+'|'+normalize(group)+'|'+normalize(wave);
    const k3 = normalize(name)+'|'+lineId+'|'+normalize(group);
    const k2 = normalize(name)+'|'+lineId;
    const fig = idx4[k4] || idx3[k3] || (() => {
      const c2 = idx2[k2];
      if (!c2 || c2 === 'AMBIGUOUS') return null;
      return c2;
    })();

    if (!fig) { unmatched.push(lineName + ': ' + name + (group ? ' [' + group + ']' : '')); return; }
    // v4.95: previously skipped any second row for the same figure, collapsing
    // multi-copy CSVs back to copy #1. Now append additional rows as new copies.
    // First-row-per-figure logic still respects overwrite vs merge semantics.
    const isFirstRow = !matchedIds.has(fig.id);
    if (isFirstRow && !overwrite && S.coll[fig.id]?.status && status) { skipped++; return; }

    if (status) {
      const accessories = accRaw ? accRaw.split(/\s*;\s*/).filter(Boolean) : [];
      const existing = S.coll[fig.id];
      let base;
      if (isFirstRow) {
        // Reset/create on first row of this figure
        if (existing && isMigrated(existing) && !overwrite) base = {...existing, copies: [...existing.copies]};
        else if (existing && !overwrite) base = migrateEntry(existing);
        else base = { copies: [] };
        base.status = status;
        if (overwrite) base.copies = [];  // overwrite mode: drop pre-existing copies
      } else {
        base = isMigrated(S.coll[fig.id]) ? {...S.coll[fig.id], copies: [...S.coll[fig.id].copies]} : { copies: [], status };
      }
      // Build the copy from this row
      const copy = { id: 0 };  // id assigned below
      if (cond) copy.condition = cond;
      if (paid) copy.paid = paid;
      if (variant) copy.variant = variant;
      if (notes) copy.notes = notes;
      if (accessories.length) copy.accessories = accessories;
      if (location) copy.location = location;
      // Decide whether this row defines a copy (any data field set, OR
      // status is owned/for-sale which always needs at least one copy)
      const rowDefinesCopy = cond || paid || variant || notes || accessories.length || location ||
                              (isFirstRow && (status === 'owned' || status === 'for-sale'));
      if (rowDefinesCopy) {
        const nextId = base.copies.reduce((m, cp) => Math.max(m, cp.id || 0), 0) + 1;
        copy.id = nextId;
        base.copies.push(copy);
      }
      S.coll[fig.id] = base;
    }
    matchedIds.add(fig.id);
  });
  saveColl();
  return { matched: matchedIds.size, skipped, unmatched };
}

function doImportAF411(csvText, overwrite) {
  const motuRows = parseCSV(csvText);
  const {idx4, idx3, idx2} = buildFigIndexes();
  const matchedIds = new Set();
  let skipped = 0; const unmatched = [];
  motuRows.forEach(row => {
    const lineId = SERIES_MAP[row.series];
    const k4 = normalize(row.name)+'|'+lineId+'|'+normalize(row.group||'')+'|'+normalize(row.wave||'');
    const k3 = normalize(row.name)+'|'+lineId+'|'+normalize(row.group||'');
    const k2 = normalize(row.name)+'|'+lineId;
    const fig = idx4[k4] || idx3[k3] || (() => {
      const c = idx2[k2];
      if (!c || c === 'AMBIGUOUS') return null;
      if (normalize(c.name) !== normalize(row.name)) return null;
      return c;
    })();
    if (!fig) { unmatched.push(ln(lineId)+': '+row.name+(row.group?' ['+row.group+']':'')); return; }
    if (matchedIds.has(fig.id)) {
      if (row.variation) {
        // Append variation to existing primary copy's variant field
        const cur = S.coll[fig.id];
        if (cur && isMigrated(cur) && cur.copies.length) {
          const ex = cur.copies[0].variant || '';
          if (!ex.split(',').map(v=>v.trim()).includes(row.variation)) {
            const merged = [ex, row.variation].filter(Boolean).join(', ');
            const newCopies = [...cur.copies];
            newCopies[0] = {...newCopies[0], variant: merged};
            S.coll[fig.id] = {...cur, copies: newCopies};
          }
        }
      }
      skipped++; return;
    }
    if (!overwrite && S.coll[fig.id]?.status === 'owned') { skipped++; return; }
    const importNote = [row.note, row.where ? 'From: '+row.where : ''].filter(Boolean).join(' | ');
    // Build the new entry directly in v4.42 schema.
    const copy = { id: 1 };
    if (row.cond) copy.condition = row.cond;
    if (row.paid) copy.paid = row.paid;
    if (importNote) copy.notes = importNote;
    if (row.variation) copy.variant = row.variation;
    S.coll[fig.id] = { status: 'owned', copies: [copy] };
    matchedIds.add(fig.id);
  });
  saveColl();
  return { matched: matchedIds.size, skipped, unmatched };
}

// ── window.* mirrors for inline-onclick handlers ──
window.setStatus = setStatus;
window.fetchFigs = fetchFigs;
window.exportCSV = exportCSV;

// ── Exports ─────────────────────────────────────────────────
export {
  parseCSV, fetchFigs, saveColl, flushSaveColl, flushAllPending, rebuildFigIndex, figById, OVERRIDES_KEY, loadOverrides, saveOverrides, applyOverrides, getOverrideField, setOverrideField, clearOverrides, isMigrated, migrateEntry, migrateColl, getPrimaryCopy, copyCondition, copyPaid, copyNotes, copyVariant, totalCopyCount, entryCopyCount, toggleHidden, isLineFullyHidden, isSublineHidden, figIsHidden, migrateOrderedToOwned, setStatus, PER_COPY_FIELDS, updateColl, nextCopyId, getAllLocations, renderSheetBody, renderAccessoryPickerSheet, ACC_AVAIL_KEY, getAccAvail, saveAccAvail, flushFieldDebounces, _derived, getStats, getSortedFigs, getLineStats, hasFilters, progressRing, exportCSV, crc32, buildZip, exportJSON, importJSON, SETTINGS_KEYS, renderExportSheet, doImport, LINE_ID_MAP, buildFigIndexes, doImportVault, doImportAF411
};
