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
  S, store, ICO, icon, IMG, FIGS_URL, LOADOUTS_URL, KIDS_CORE_KEY,
  CUSTOM_FIGS_KEY, CACHE_KEY, LOADOUTS_CACHE_KEY, CACHE_TTL,
  LINES, FACTIONS, CONDITIONS, ACCESSORIES, OPTIONAL_ACCESSORIES,
  STATUSES, STATUS_LABEL, STATUS_COLOR, STATUS_HEX,
  THEMES, SUBLINES, SERIES_MAP, COND_MAP, GROUP_MAP,
  ln, normalize, esc, jsArg, isSelecting, _clone,
} from './state.js';
import {
  MAX_PHOTOS, PHOTO_LABELS_KEY, PHOTO_COPY_KEY,
  photoStore, photoURLs, photoCopyOf, setPhotoCopy,
  loadPhotoLabels, savePhotoLabels, loadPhotoCopyMap, savePhotoCopyMap,
  getPhotoCopyMap, replacePhotoCopyMap, mergePhotoCopyMap,
} from './photos.js';
import { render, toast, haptic, appConfirm, patchFigRow, patchDetailStatus, triggerPulse, toastUndo } from './render.js';
import { checkCompletion } from './eggs.js';

// v6.28: persist S.newFigIds across reloads. Stored as { figId: timestamp }
// so we can age-out stale entries. Default TTL: 14 days.
const NEW_FIG_IDS_KEY = 'motu-new-figs';
const NEW_BADGE_TTL = 14 * 24 * 60 * 60 * 1000;
function _persistNewFigIds() {
  try {
    const existing = store.get(NEW_FIG_IDS_KEY) || {};
    const now = Date.now();
    // Drop expired
    for (const id of Object.keys(existing)) {
      if (now - existing[id] > NEW_BADGE_TTL) delete existing[id];
    }
    // Add current set members with current timestamp (or keep older if already present)
    for (const id of S.newFigIds) {
      if (!existing[id]) existing[id] = now;
    }
    store.set(NEW_FIG_IDS_KEY, existing);
  } catch {}
}
function loadPersistedNewFigIds() {
  try {
    const map = store.get(NEW_FIG_IDS_KEY) || {};
    const now = Date.now();
    const set = new Set();
    let mutated = false;
    for (const [id, ts] of Object.entries(map)) {
      if (now - ts > NEW_BADGE_TTL) { delete map[id]; mutated = true; }
      else set.add(id);
    }
    if (mutated) store.set(NEW_FIG_IDS_KEY, map);
    S.newFigIds = set;
  } catch { S.newFigIds = new Set(); }
}

// § DATA-FETCH ── parseCSV, fetchFigs, newFigIds detection ─────────
// v6.27: rewrote the CSV parser to handle RFC-4180 quoted newlines correctly.
// Previous version did `text.split('\n')` first, which split mid-field for
// any cell containing a newline (notes columns frequently do). Also caps the
// row count to refuse pathological inputs early.
const _CSV_MAX_BYTES = 10_000_000;   // 10 MB
const _CSV_MAX_ROWS  = 100_000;
function parseCSVRows(text) {
  if (text.length > _CSV_MAX_BYTES) throw new Error('File too large');
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }   // escaped quote
        else inQ = false;                                // end of quoted field
      } else {
        cur += c;
      }
    } else {
      if (c === '"' && cur === '') inQ = true;          // start of quoted field
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; if (rows.length > _CSV_MAX_ROWS) throw new Error('Too many rows (max ' + _CSV_MAX_ROWS + ')'); }
      else if (c === '\r') { /* CRLF — eat the CR, the LF will close the row */ }
      else cur += c;
    }
  }
  // Trailing field / row at EOF
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  // Drop empty trailing rows (e.g., file ends with \n)
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}
function parseCSV(text) {
  const rows = parseCSVRows(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map(h => (h || '').trim());
  const idx = h => headers.indexOf(h);
  const [iGenre,iSeries,iGroup,iName,iWave,iPaid,iCond,iNote,iWhere,iVariation] =
    ['Genre','Series','Group','Name','Wave','Purchase Price','Condition','Note','Where Purchased','Variation Name'].map(idx);
  return rows.slice(1).map(c => {
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
    // v6.30: bound the catalog fetch with an AbortController. Without this,
    // a slow/stalled connection (2G, captive portal, throttled mobile) leaves
    // the skeleton screen up indefinitely on first load — the worst-possible
    // first-run experience. 15s is generous for a ~200KB JSON file even on
    // bad connections; longer than that and we're better off telling the
    // user something is wrong.
    const ctl = new AbortController();
    const timeoutId = setTimeout(() => ctl.abort(), 15000);
    try {
      // v6.16: kids-core.json is no longer maintained as a separate repo file.
      // Kids Core figures now live in figures.json with `line: 'kids-core'`,
      // managed by sync_af411.py like every other line. KIDS_CORE_KEY (local
      // admin entries) is still honored for back-compat — those merge in below.
      const [res, ldRes] = await Promise.all([
        fetch(FIGS_URL + '?t=' + Date.now(), { signal: ctl.signal }),
        // Loadouts is optional; let it share the same abort signal so we don't
        // hold the figures fetch waiting on a stuck loadouts call.
        fetch(LOADOUTS_URL + '?t=' + Date.now(), { signal: ctl.signal }).catch(() => null),
      ]);
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const remote = await res.json();
      if (!Array.isArray(remote) || remote.length < 100) throw new Error('Invalid data');

      // v6.03: Shared loadouts from repo (optional — 404 is fine).
      // Stored in S._repoLoadouts; merged with local override at read-time
      // by getLoadout(figId). Local entry beats repo entry for the same figId.
      // Schema: { version: 1, loadouts: { [figId]: ['Power Sword', ...] } }
      if (ldRes && ldRes.ok) {
        try {
          const ld = await ldRes.json();
          if (ld && ld.loadouts && typeof ld.loadouts === 'object') {
            S._repoLoadouts = ld.loadouts;
          }
        } catch {}
      }

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
      const remoteIds = new Set(remote.map(f => f.id));
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
        hydrated.forEach(f => { if (!prevIds.has(f.id)) S.newFigIds.add(f.id); });
      }
      // v6.28: persist newFigIds with timestamps so the NEW pill survives a
      // refresh. Auto-expire entries older than NEW_BADGE_TTL so stale "NEW"
      // badges from an old sync don't linger forever. The Set is rebuilt at
      // load (in app.js) from the persisted timestamp map.
      _persistNewFigIds();
      const kcIds = new Set(localKCFigs.map(f => f.id));
      const customIds = new Set(localCustomFigs.map(f => f.id));
      S.figs = [
        ...hydrated,
        ...localKCFigs,
        ...localCustomFigs,
        ...custom.filter(f => !remoteIds.has(f.id) && !kcIds.has(f.id) && !customIds.has(f.id)),
      ];
      rebuildFigIndex();
      _derived.invalidate();
      S.syncTs = Date.now();
      store.set(CACHE_KEY, { rows: S.figs, ts: S.syncTs });
      // v6.24: persist loadouts so cached cold-start renders show complete badges
      if (Object.keys(S._repoLoadouts).length) store.set(LOADOUTS_CACHE_KEY, S._repoLoadouts);
      S.syncStatus = 'ok';
      if (firstLoad) { S.loaded = true; }
      const newCount = S.newFigIds.size;
      if (manual || newCount) toast(`✓ Synced ${S.figs.length} figures${newCount ? ` · ${newCount} new` : ''}`);
      render();
      setTimeout(() => { S.syncStatus = 'idle'; render(); }, 3000);
    } catch(e) {
      clearTimeout(timeoutId);
      console.error('Fetch failed:', e);
      S.syncStatus = manual ? 'err' : 'idle';
      // v6.30: detect timeout/abort distinctly from generic offline so we
      // can show a more useful message ("slow connection" vs "no connection").
      const isAbort   = e?.name === 'AbortError';
      const isNetwork = !navigator.onLine || /network|failed to fetch/i.test(e.message);
      if (manual) {
        if (isAbort) {
          toast('✗ Connection too slow — try again in a moment');
        } else if (isNetwork) {
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

// v6.31: status-change event log. Persisted to localStorage as a capped
// ring of {t, id, from, to} tuples. Powers the monthly-activity chart on
// the Stats sheet ("when did I add the most things"). Cap at 2000 events
// — keeps localStorage usage to <200KB even for heavy users while giving
// 5+ years of history at typical collection rates.
const EVENTS_KEY  = 'motu-events';
const EVENTS_CAP  = 2000;
let _events = null;
function getEvents() {
  if (_events) return _events;
  try {
    const raw = store.get(EVENTS_KEY);
    _events = Array.isArray(raw) ? raw : [];
  } catch { _events = []; }
  return _events;
}
function logStatusEvent(id, from, to) {
  // Skip no-ops and identical writes (defensive — setStatus won't call
  // here in those cases, but if a future caller does we don't pollute
  // the log).
  if (from === to) return;
  const arr = getEvents();
  arr.push({ t: Date.now(), id, from: from || null, to: to || null });
  // Trim from the front when over cap
  if (arr.length > EVENTS_CAP) arr.splice(0, arr.length - EVENTS_CAP);
  // Use a debounced write — rapid bulk operations (batch select + status
  // change for 50 figures) shouldn't write to localStorage 50 times.
  if (_eventsSaveTimer) clearTimeout(_eventsSaveTimer);
  _eventsSaveTimer = setTimeout(() => {
    store.set(EVENTS_KEY, arr);
    _eventsSaveTimer = null;
  }, 200);
}
let _eventsSaveTimer = null;
// Returns events grouped by YYYY-MM, optionally filtered to a transition.
// e.g. groupEventsByMonth({to: 'owned'}) → {'2026-04': 12, '2026-05': 8, ...}
function groupEventsByMonth(filter = {}) {
  const out = {};
  for (const ev of getEvents()) {
    if (filter.to && ev.to !== filter.to) continue;
    if (filter.from && ev.from !== filter.from) continue;
    const d = new Date(ev.t);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

// v6.31: viewed wishlist history. When a user opens a #wl= share link
// (from a QR scan or pasted URL), the encoded ID list and a snapshot of
// the matched figure names are saved here so they can revisit later.
// Capped at 50 entries — older ones evicted on save. Stored as
// {nums, names, viewedAt, figCount}.
const WISHLIST_HISTORY_KEY = 'motu-wl-history';
const WISHLIST_HISTORY_CAP = 50;
function getWishlistHistory() {
  try {
    const raw = store.get(WISHLIST_HISTORY_KEY);
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
function saveWishlistHistory(arr) {
  store.set(WISHLIST_HISTORY_KEY, arr);
}
// Save (or update timestamp on) an entry. Dedupes by serialized nums list
// so re-opening the same link bumps the timestamp instead of duplicating.
function recordWishlistView(nums, figs) {
  if (!Array.isArray(nums) || !nums.length) return;
  const key = nums.slice().sort().join(',');
  const arr = getWishlistHistory();
  // Drop existing entry with matching nums (we'll re-prepend below)
  const existing = arr.findIndex(e => (e.nums || []).slice().sort().join(',') === key);
  if (existing >= 0) arr.splice(existing, 1);
  // Cap names list at first 5 so localStorage doesn't bloat
  const names = (figs || []).slice(0, 5).map(f => f.name).filter(Boolean);
  arr.unshift({
    nums: [...nums],
    names,
    figCount: (figs || []).length,
    viewedAt: Date.now(),
  });
  if (arr.length > WISHLIST_HISTORY_CAP) arr.length = WISHLIST_HISTORY_CAP;
  saveWishlistHistory(arr);
}
function clearWishlistHistory() {
  store.set(WISHLIST_HISTORY_KEY, []);
}
function deleteWishlistHistoryEntry(idx) {
  const arr = getWishlistHistory();
  if (idx < 0 || idx >= arr.length) return;
  arr.splice(idx, 1);
  saveWishlistHistory(arr);
}

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
// v6.10: Get the full {fields} object for a figure, or empty {}.
// Exported so ui-sheets can render the edit sheet without reaching into
// the module-private _overrides directly (which caused a ReferenceError).
function getOverridesFor(figId) {
  return _overrides[figId]?.fields || {};
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
  _derived.invalidate();
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
  // v6.31: log to the event ring for the stat-history chart. Captured
  // after the mutation so newStatus reflects the final state (may be
  // undefined if the change cleared the status entirely).
  logStatusEvent(id, wasStatus, S.coll[id]?.status);
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

// v6.23: conditions that imply the copy contains all loadout accessories.
// MIB/MOC/New-Sealed are packaged; Loose Complete is a user assertion.
// Used by updateCopy to auto-fill cp.accessories with the full loadout.
const AUTOFILL_CONDITIONS = new Set([
  'Mint in Box', 'Mint on Card', 'New/Sealed', 'Loose Complete',
]);

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

window.updateCopy = (id, copyId, key, val, opts) => {
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

  // v6.23: auto-fill accessories when the condition is set to a value that
  // implies a complete copy. MIB/MOC/New-Sealed = sealed in packaging,
  // assumed to contain everything. Loose Complete = user is asserting all
  // accessories are present. We populate cp.accessories with the full
  // loadout (including paper goods, since the user may want to start
  // "all marked" and uncheck specific items).
  //
  // We DON'T overwrite an existing accessories list — only add missing
  // items. This avoids destroying data the user explicitly tracked.
  //
  // Skipped when opts.skipAutofill is true — used by maybeSuggestConditionForCopy
  // which auto-flips condition based on accessories already being complete.
  // Without the skip, the user would see two toasts in a row ("Marked Loose
  // Complete" + "Marked N accessories") and we'd add paper goods they may
  // not actually have.
  const skipAutofill = !!(opts && opts.skipAutofill);
  if (key === 'condition' && AUTOFILL_CONDITIONS.has(val) && !skipAutofill) {
    const loadout = getLoadout(id);
    if (loadout && loadout.length) {
      const existing = new Set(Array.isArray(cp.accessories) ? cp.accessories : []);
      let added = 0;
      for (const name of loadout) {
        if (!existing.has(name)) { existing.add(name); added++; }
      }
      if (added > 0) {
        cp.accessories = [...existing];
        // Informational toast — non-blocking, surfaces what changed.
        try { toast(`✓ Marked ${added} accessor${added === 1 ? 'y' : 'ies'} present`); } catch {}
      }
    }
  }

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
  // v6.23: if condition just changed to an autofill condition and we
  // populated accessories, the detail screen needs to re-render so the
  // newly-checked accessory chips appear. patchDetailStatus is the
  // lightweight refresh path used elsewhere in this module.
  if (key === 'condition' && AUTOFILL_CONDITIONS.has(val) && !skipAutofill) {
    patchDetailStatus();
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

// v6.03 / v6.04: After an accessory add/remove, if the copy crossed the
// "all loadout items present" threshold in either direction, automatically
// flip the condition to match and show an informational toast.
//
// v6.03 originally surfaced this as an action toast ("Mark Loose Complete?")
// requiring a tap. v6.04 changes to auto-apply: the toast disappeared too
// fast in the original implementation, and the action is small enough that
// a confirm step adds friction without protecting the user (the change is
// trivially reversible by editing the condition dropdown). The informational
// toast still surfaces what happened so the user can correct it if undesired.
//
// Skipped entirely when:
//   - no loadout exists for this figure (nothing to be complete against)
//   - condition is sealed/mint (those track packaging, not loose contents)
//   - the new condition would equal the current condition (no-op)
//
// `prevComplete` is the completeness state captured BEFORE the accessory
// list was mutated. `nextCp` is the migrated copy after the mutation.
const SEALED_CONDITIONS = new Set(['Mint in Box', 'Mint on Card', 'New/Sealed']);
function maybeSuggestConditionForCopy(figId, copyId, nextCp, prevComplete) {
  if (!nextCp) return;
  const cond = nextCp.condition || '';
  if (SEALED_CONDITIONS.has(cond)) return;
  const after = getCopyCompleteness(figId, nextCp);
  if (!after) return; // no loadout
  // Only act on transitions: incomplete → complete, or complete → incomplete.
  // v6.23: pass skipAutofill so updateCopy doesn't try to auto-add paper
  // goods on top of the user's just-completed required items (would chain
  // a second "Marked N accessories" toast and add items the user may not
  // actually have).
  if (after.complete && !prevComplete && cond !== 'Loose Complete') {
    window.updateCopy(figId, copyId, 'condition', 'Loose Complete', { skipAutofill: true });
    toast('✓ Marked Loose Complete');
  } else if (!after.complete && prevComplete && cond === 'Loose Complete') {
    window.updateCopy(figId, copyId, 'condition', 'Loose Incomplete', { skipAutofill: true });
    toast('Marked Loose Incomplete');
  }
}

window.addAccessory = (figId, copyId, name) => {
  if (!name) return;
  const c = S.coll[figId];
  if (!c || !isMigrated(c)) return;
  // Capture completeness BEFORE the mutation so the suggestion logic can
  // detect the threshold-crossing accurately.
  const prevCp = c.copies.find(x => x.id === copyId);
  const prevState = prevCp ? getCopyCompleteness(figId, prevCp) : null;
  const prevComplete = !!(prevState && prevState.complete);
  const next = {...c, copies: c.copies.map(cp => ({...cp}))};
  const cp = next.copies.find(x => x.id === copyId);
  if (!cp) return;
  const list = Array.isArray(cp.accessories) ? [...cp.accessories] : [];
  if (!list.includes(name)) list.push(name);
  cp.accessories = list;
  S.coll[figId] = next;
  saveColl();
  maybeSuggestConditionForCopy(figId, copyId, cp, prevComplete);
  // Picker is open — re-render it so the checkmark appears. If we're not
  // in the picker (e.g. custom-add flow), fall back to detail re-render.
  if (S.sheet === 'accessoryPicker') renderSheetBody();
  else patchDetailStatus();
};

window.removeAccessory = (figId, copyId, idx) => {
  const c = S.coll[figId];
  if (!c || !isMigrated(c)) return;
  const prevCp = c.copies.find(x => x.id === copyId);
  const prevState = prevCp ? getCopyCompleteness(figId, prevCp) : null;
  const prevComplete = !!(prevState && prevState.complete);
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
  maybeSuggestConditionForCopy(figId, copyId, cp, prevComplete);
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
  // v5.03 / v6.03: per-figure loadout. Source priority is local override
  // (motu-acc-avail) > repo loadouts.json. The picker's *normal* mode reads
  // the merged loadout via getLoadout() so users see the same offer list
  // whether the loadout came from their device or from the repo. Admin mode
  // edits the local override only — the repo file is read-only and shipped
  // via the loadout-editor tool.
  const localAvail = getAccAvail();
  const figAvailLocal = localAvail[figId];   // local override only (admin edits this)
  const figLoadout = getLoadout(figId);      // merged: local || repo (normal mode reads this)
  const adminMode = !!S._accPickAdmin;
  // In admin mode, ALL global accessories are listed with the figure's
  // available subset checked. Tapping toggles inclusion in the available
  // list (does NOT touch what's on the copy).
  let h = '';
  if (!cp) {
    return '<div class="text-dim text-sm" style="padding:20px;text-align:center">Copy no longer exists.</div>';
  }
  // v6.26: jsArg now imported from state.js — local declaration removed.

  // Header / mode toggle
  if (adminMode) {
    h += `<div class="text-dim text-sm" style="margin-bottom:8px;line-height:1.5">
      Editing the shipped-with loadout for this figure. Selected items are tracked for completeness on every copy and limit what's offered when checking off accessories. Leave all unchecked to allow everything (no completeness tracking).
    </div>
    <div style="display:flex;gap:6px;margin-bottom:10px">
      <button onclick="S._accPickAdmin=false;renderSheetBody()" style="padding:7px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--bg3);color:var(--t1);font-size:12px">‹ Back to Picker</button>
      <button onclick="resetAccAvail(${jsArg(figId)})" style="padding:7px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--bg3);color:var(--t3);font-size:12px">Reset to All</button>
    </div>`;
  } else {
    h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <div class="text-dim text-sm">Tap to toggle. ${figLoadout ? '<span style="color:var(--acc)">Loadout active — completeness tracked.</span>' : 'Added items apply to this copy only.'}</div>
      <button onclick="S._accPickAdmin=true;renderSheetBody()" title="Edit shipped-with loadout" style="padding:5px 10px;border-radius:8px;border:1px solid var(--bd);background:var(--bg3);color:var(--t3);font-size:11px;font-weight:600">⚙ Edit Loadout</button>
    </div>`;
  }

  h += `<div class="acc-picker-list">`;
  if (adminMode) {
    // Admin mode: list ALL global accessories. Checked = part of figure's
    // LOCAL override (what admin is editing). The repo loadout is shown as
    // a hint above when present, but admin tap toggles the local override
    // only — repo defaults stay untouched.
    const figAvailSet = new Set(figAvailLocal || []);
    ACCESSORIES.forEach(name => {
      const on = figAvailSet.has(name);
      h += `<button class="acc-picker-item${on ? ' selected' : ''}" onclick="toggleAccAvail(${jsArg(name)})">
        <span>${esc(name)}</span>
        ${on ? '<span class="acc-picker-check">✓</span>' : ''}
      </button>`;
    });
  } else {
    // Normal mode: show only the figure's loadout (merged local-or-repo),
    // or all accessories if no loadout is set. Custom-already-on-copy
    // entries surface at top so they can be removed.
    const customSelected = current.filter(a => !ACCESSORIES.includes(a));
    customSelected.forEach(name => {
      h += `<button class="acc-picker-item selected" onclick="toggleAccessoryInPicker(${jsArg(name)})">
        <span>${esc(name)}</span>
        <span class="acc-picker-check">✓</span>
      </button>`;
    });
    const offerList = (figLoadout && figLoadout.length) ? figLoadout : ACCESSORIES;
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

// ─── Loadouts + Completeness (v6.03) ─────────────────────────────
// "Loadout" = the canonical list of accessories a figure shipped with.
// Source priority: local override (motu-acc-avail) > repo (loadouts.json).
// String entries today (v6.03). v6.04 may extend to {name, required} objects;
// getLoadout will normalize both shapes.
//
// Returns null when no loadout is known for this figId. Callers MUST handle
// null — UI features (completeness badge, missing row, condition suggestion)
// stay silent when no loadout exists, preserving v6.02 behavior.
function getLoadout(figId) {
  if (!figId) return null;
  const local = getAccAvail()[figId];
  if (Array.isArray(local) && local.length) return local.slice();
  const repo = (S._repoLoadouts || {})[figId];
  if (Array.isArray(repo) && repo.length) return repo.slice();
  return null;
}

// Computes how complete a copy is against its figure's loadout.
// Returns null when no loadout exists (caller renders nothing).
// Otherwise returns {have, total, pct, missing[], complete} where:
//   have     = how many loadout items are present on this copy
//   total    = loadout length
//   pct      = Math.round(have/total * 100)
//   missing  = loadout items NOT on this copy (for the "Missing:" row)
//   complete = have === total
// Custom (non-loadout) accessories on the copy do NOT count toward have/total.
// They're still shown in the chip row above the badge — they're extras, not gaps.
//
// v6.23: paper goods (Comic, Minicomic, Info Card, Accessory Card, Instructions)
// are treated as optional. Their absence does not block ✓ Complete or the
// auto-flip to Loose Complete — many collectors don't keep paper goods, and
// requiring them would mean the badge essentially never lights up. They still
// appear in the missing-pills row so users can add them if they want.
function getCopyCompleteness(figId, cp) {
  const loadout = getLoadout(figId);
  if (!loadout) return null;
  const have = Array.isArray(cp && cp.accessories) ? cp.accessories : [];
  const haveSet = new Set(have);
  // Split loadout into required (counts toward complete) and optional
  // (paper goods — informational only).
  const required = loadout.filter(name => !OPTIONAL_ACCESSORIES.has(name));
  const presentRequired = required.filter(name => haveSet.has(name));
  // missing list still includes optional missing items so the pills row
  // can still suggest adding them.
  const missing = loadout.filter(name => !haveSet.has(name));
  const missingRequired = required.filter(name => !haveSet.has(name));
  const total = required.length;
  const ct = presentRequired.length;
  return {
    have: ct,
    total,
    pct: total ? Math.round((ct / total) * 100) : 0,
    missing,
    missingRequired,
    // Complete = all REQUIRED items present. Paper-good absence is OK.
    // Edge case: a figure whose loadout is *entirely* paper goods (rare —
    // shouldn't happen in practice) would have total=0 and never be complete;
    // we treat that as "no meaningful loadout" and return complete=false to
    // match the prior contract.
    complete: total > 0 && ct === total,
  };
}

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
    // v6.27: normalize for diacritic + punctuation insensitivity. Collectors
    // type "Sheera" and expect to match "She-Ra"; international users type
    // "skeletor" for "Skèletor". NFD splits combining marks off, then we
    // strip them; remaining ASCII-folding handles hyphens / curly quotes.
    const fold = str => (str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')   // strip combining marks
      .toLowerCase()
      .replace(/[-'’‘`]/g, '');
    const s = fold(S.search);
    list = list.filter(f => {
      const name = fold(f.name);
      if (name.includes(s)) return true;
      const lineName = fold(ln(f.line));
      const group = fold(f.group||'');
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
  // v6.30: large backups (hundreds of photos as base64 data URLs) used to
  // build the entire string in memory at once, then JSON.stringify it with
  // null,2 pretty-printing — three full copies of the data resident at
  // peak. Mobile tabs were crashing on collections > ~200 photos. Now:
  //   - drop pretty-printing (backups are not human-read)
  //   - show a syncing toast so the user knows we're working on it
  //   - wrap the whole thing in try/catch so failure surfaces to the user
  //     instead of silently producing nothing
  // For extremely large collections (1000+ photos) this still won't be
  // bullet-proof — true streaming would require the File System Access API
  // which isn't broadly mobile-supported. This is the practical fix.
  let pendingToast = false;
  try {
    pendingToast = true;
    toast('Building backup…', { duration: 8000 });
    const backup = {
      version: 'motu-vault-backup-v4',  // v4: includes per-copy photo assignments + figure overrides
      exported: new Date().toISOString(),
      collection: S.coll,
      photos: {},
      photoCopy: getPhotoCopyMap(),  // {figId: {n: copyId}} — which copy each photo belongs to
      overrides: _overrides,  // {figId: {fields: {...}}} — local field patches
    };
    // Include custom photos as arrays of {label, dataUrl}.
    // Yield to the event loop every 25 figures so the UI can update — without
    // this, a 500-photo backup blocks the main thread for several seconds and
    // the toast above never paints.
    let totalPhotos = 0;
    const ids = Object.keys(S.customPhotos);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const photos = await photoStore.exportAllAsDataURLs(id);
      if (photos.length) {
        backup.photos[id] = photos;
        totalPhotos += photos.length;
      }
      if (i % 25 === 0) await new Promise(r => setTimeout(r, 0));
    }
    // No pretty-printing — saves ~15% size for backups (which can be
    // significant when photos push the file into the tens of MB range)
    // and one less full copy of the data resident during stringify.
    const json = JSON.stringify(backup);
    const blob = new Blob([json], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'motu-vault-backup.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast(`✓ Backup saved · ${totalPhotos} photo${totalPhotos===1?'':'s'}`);
  } catch (e) {
    console.error('Backup failed:', e);
    // Disambiguate the common failure mode: device ran out of memory
    // (manifests as a generic Error or tab crash recovery).
    const oom = /out of memory|allocation/i.test(e?.message || '');
    toast(oom
      ? '✗ Backup too large for this device — try exporting fewer photos'
      : '✗ Backup failed: ' + (e?.message || 'unknown error').slice(0, 60));
  }
}

// v6.27: split into apply-from-parsed-object + file wrapper. handleImportFile
// can now read the file once and pass the parsed object directly.
async function applyImportedBackup(backup) {
  // v6.26: sentinel keys to skip when iterating user-supplied JSON. Prevents
  // a crafted backup from manipulating S.coll's prototype via bracket-assignment.
  const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  try {
    const knownVersions = ['motu-vault-backup-v1', 'motu-vault-backup-v2', 'motu-vault-backup-v3', 'motu-vault-backup-v4'];
    if (!backup || !knownVersions.includes(backup.version)) throw new Error('Unknown format');
    if (!backup.collection || typeof backup.collection !== 'object') throw new Error('Invalid collection data');
    const overwrite = document.querySelector('.checkbox.checked') !== null;
    let imported = 0, skipped = 0, photos = 0;
    // v1/v2 backups have flat-shape entries; v3 has copies[]. migrateEntry
    // is idempotent so it's safe to run on either.
    Object.entries(backup.collection).forEach(([id, entry]) => {
      if (RESERVED_KEYS.has(id)) return;
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
        if (RESERVED_KEYS.has(id)) continue;
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
        replacePhotoCopyMap(backup.photoCopy);
      } else {
        // Merge — incoming wins on conflict (skips __proto__/constructor/prototype)
        mergePhotoCopyMap(backup.photoCopy);
      }
    }
    // v4 (added later): restore figure field overrides
    if (backup.overrides && typeof backup.overrides === 'object') {
      if (overwrite) {
        _overrides = {};
        for (const [figId, m] of Object.entries(backup.overrides)) {
          if (RESERVED_KEYS.has(figId)) continue;
          _overrides[figId] = m;
        }
      } else {
        for (const [figId, m] of Object.entries(backup.overrides)) {
          if (RESERVED_KEYS.has(figId)) continue;
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
  } catch (e) {
    toast('✗ Invalid backup: ' + (e.message || '').slice(0, 80));
  }
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = ev => {
    let parsed;
    try { parsed = JSON.parse(ev.target.result); }
    catch { toast('✗ File is not valid JSON'); return; }
    applyImportedBackup(parsed);
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
  'motu-tutorial-seen',
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

// v6.27: split into apply-from-parsed-object + file wrapper so handleImportFile
// can route after a single read. Keeps the public window.importSettings(file)
// API for any external caller (and the older code path that passes a File).
function applyImportedSettings(payload) {
  if (!payload || payload.version !== 'motu-vault-settings-v1' || !payload.settings) {
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
}

window.importSettings = file => {
  const reader = new FileReader();
  reader.onload = ev => {
    try { applyImportedSettings(JSON.parse(ev.target.result)); }
    catch (e) { toast('✗ Import failed: ' + e.message); }
  };
  reader.readAsText(file);
};

window.handleImportFile = input => {
  const file = input.files?.[0]; if (!file) return;
  if (file.name.endsWith('.json')) {
    // v6.27: read the file once, then dispatch on the parsed shape. The
    // previous version peeked at .version then re-read the file in the
    // chosen path — fine for a small settings file, wasteful for a 50MB
    // photo backup.
    const reader = new FileReader();
    reader.onload = ev => {
      let parsed;
      try { parsed = JSON.parse(ev.target.result); }
      catch { toast('✗ File is not valid JSON'); return; }
      if (parsed && parsed.version === 'motu-vault-settings-v1') {
        applyImportedSettings(parsed);
      } else {
        applyImportedBackup(parsed);
      }
    };
    reader.onerror = () => toast('✗ Could not read file');
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
  const rows = parseCSVRows(csvText);
  if (rows.length === 0) return { matched: 0, skipped: 0, unmatched: [] };
  const headers = rows[0].map(h => (h || '').trim());
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

  rows.slice(1).forEach(c => {
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
window.logStatusEvent = logStatusEvent;
window.recordWishlistView = recordWishlistView;
window.getWishlistHistory = getWishlistHistory;
window.deleteWishlistHistoryEntry = deleteWishlistHistoryEntry;
window.clearWishlistHistory = clearWishlistHistory;

// ── Exports ─────────────────────────────────────────────────
export {
  parseCSV, parseCSVRows, fetchFigs, saveColl, flushSaveColl, flushAllPending, rebuildFigIndex, figById, OVERRIDES_KEY, loadOverrides, saveOverrides, applyOverrides, getOverrideField, getOverridesFor, setOverrideField, clearOverrides, isMigrated, migrateEntry, migrateColl, getPrimaryCopy, copyCondition, copyPaid, copyNotes, copyVariant, totalCopyCount, entryCopyCount, toggleHidden, isLineFullyHidden, isSublineHidden, figIsHidden, migrateOrderedToOwned, setStatus, PER_COPY_FIELDS, updateColl, nextCopyId, getAllLocations, renderSheetBody, renderAccessoryPickerSheet, ACC_AVAIL_KEY, getAccAvail, saveAccAvail, getLoadout, getCopyCompleteness, flushFieldDebounces, _derived, getStats, getSortedFigs, getLineStats, hasFilters, progressRing, exportCSV, crc32, buildZip, exportJSON, importJSON, applyImportedBackup, applyImportedSettings, SETTINGS_KEYS, renderExportSheet, doImport, LINE_ID_MAP, buildFigIndexes, doImportVault, doImportAF411, loadPersistedNewFigIds, NEW_FIG_IDS_KEY, getEvents, groupEventsByMonth, EVENTS_KEY, getWishlistHistory, recordWishlistView, clearWishlistHistory, deleteWishlistHistoryEntry, WISHLIST_HISTORY_KEY
};
