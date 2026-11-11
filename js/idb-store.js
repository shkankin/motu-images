// js/idb-store.js
// ════════════════════════════════════════════════════════════════════
// IndexedDB-backed key/value store with a synchronous in-memory mirror.
//
// WHY: localStorage tops out around ~5 MB per origin, and the catalog cache
// (~1,200 figures) plus a growing collection were the two blobs pushing
// toward that ceiling. IndexedDB's quota is far larger (hundreds of MB to
// GBs). But IndexedDB is *asynchronous*, and the app is built on synchronous
// store.get()/store.set(). Rewriting every call site to be async would be a
// large, risky change to the persistence layer.
//
// HOW: this module keeps the chosen keys in an in-memory Map that is hydrated
// from IndexedDB ONCE at boot (a single awaited step). After that, `get` is a
// synchronous Map read and `set` is a synchronous Map write that *mirrors* to
// IndexedDB in the background. So callers keep their synchronous ergonomics
// while the bytes actually live in IndexedDB.
//
// SAFETY / FALLBACK: if IndexedDB is unavailable (old browser, some private
// modes, blocked), everything transparently falls back to localStorage, so
// behavior is identical to before. Migration from localStorage is one-way and
// only deletes the localStorage copy AFTER a confirmed IndexedDB write, so a
// failed migration never loses data. Values are stored as structured clones
// (no JSON (de)serialization), which is both faster and lossless for the plain
// data this app persists.
//
// This is the foundation for moving the large stores off localStorage. Phase 1
// migrates the disposable catalog cache (zero data-loss risk). The collection
// (irreplaceable, and flushed synchronously on tab-hide) is a separate, more
// careful phase — see the note at the bottom of this file.
// ════════════════════════════════════════════════════════════════════

const DB_NAME = 'motu-vault';
const STORE_NAME = 'kv';
const DB_VERSION = 1;

// ── Low-level IndexedDB open (memoized) ──────────────────────────────
let _dbPromise = null;
function _openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // Another tab holding an older DB version open blocks the upgrade; rather
    // than hang, fall back to localStorage for this session.
    req.onblocked = () => resolve(null);
  });
  return _dbPromise;
}

// v8.14: a FAILED read is not the same as an absent key. It used to resolve
// undefined either way, so a one-off IndexedDB error at boot looked like "no
// collection yet"; the app then loaded {} as if it were real, and the next
// tab-hide saved that empty collection over the intact one (pre-launch
// review, blocker). Failures now resolve READ_ERR; hydrate retries once and
// records the key in _readFailed so the app can refuse to save over it.
const READ_ERR = Symbol('idb-read-error');
const _readFailed = new Set();
function _idbGet(db, key) {
  return new Promise((resolve) => {
    let tx;
    try { tx = db.transaction(STORE_NAME, 'readonly'); }
    catch { resolve(READ_ERR); return; }
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);     // undefined when the key is absent
    req.onerror = () => resolve(READ_ERR);
  });
}

function _idbSet(db, key, val) {
  return new Promise((resolve) => {
    let tx;
    try { tx = db.transaction(STORE_NAME, 'readwrite'); }
    catch { resolve(false); return; }
    try { tx.objectStore(STORE_NAME).put(val, key); }
    catch { resolve(false); return; }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

function _idbDelete(db, key) {
  return new Promise((resolve) => {
    let tx;
    try { tx = db.transaction(STORE_NAME, 'readwrite'); }
    catch { resolve(false); return; }
    try { tx.objectStore(STORE_NAME).delete(key); }
    catch { resolve(false); return; }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

// ── localStorage helpers (fallback + migration source) ───────────────
// Mirror the JSON semantics of the state.js `store` wrapper exactly.
function _lsGet(k) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; }
  catch { return null; }
}
function _lsSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch { return false; }
}
function _lsRemove(k) { try { localStorage.removeItem(k); } catch {} }

// v8.19 (audit A1): rescue-copy bookkeeping. When an IndexedDB write fails,
// bigSet saves the value to localStorage instead. Until v8.19 nothing ever
// read that copy back: the next launch found the OLDER value still in
// IndexedDB and used it, so the change was lost and the copy sat there for
// good. The marker below records WHICH keys hold a rescue copy that is newer
// than IndexedDB. hydrate() trusts a localStorage copy only when the marker
// names it — a bare leftover from an older version has no marker and is
// ignored exactly as before, because a later successful IndexedDB write may
// have made it stale.
const RESCUE_KEY = 'motu-idb-rescue';
let _rescue = null;
function _rescueMap() {
  if (!_rescue) { const m = _lsGet(RESCUE_KEY); _rescue = (m && typeof m === 'object' && !Array.isArray(m)) ? m : {}; }
  return _rescue;
}
function _rescueMark(key) {
  const m = _rescueMap();
  if (m[key]) return;
  m[key] = Date.now();
  _lsSet(RESCUE_KEY, m);
}
function _rescueClear(key) {
  const m = _rescueMap();
  if (!m[key]) return;
  delete m[key];
  if (Object.keys(m).length) _lsSet(RESCUE_KEY, m); else _lsRemove(RESCUE_KEY);
  _lsRemove(key);
}
// One place for "the IndexedDB write failed": keep the value in localStorage,
// mark it as the newer copy, and tell the app. `saved` is false when even the
// localStorage copy could not be written (both stores full).
function _rescueWrite(key, val) {
  const saved = _lsSet(key, val);
  if (saved) _rescueMark(key);
  _notifyFail(saved);
}

// ── Synchronous in-memory mirror ─────────────────────────────────────
const _mem = new Map();
let _useIdb = false;     // resolved at hydrate()
let _hydrated = false;
const _failListeners = new Set();

function _notifyFail(saved) { for (const fn of _failListeners) { try { fn(saved); } catch {} } }

/**
 * Hydrate the given keys from IndexedDB (migrating any that still live only in
 * localStorage) into the in-memory mirror. Must be awaited once, early in boot,
 * BEFORE any get()/set() for these keys. Returns true if IndexedDB is the
 * active backend, false if we fell back to localStorage.
 *
 * @param {string[]} keys
 * @param {object} [opts]
 * @param {boolean} [opts.migrate=true]  copy localStorage→IDB and delete the LS copy
 */
export async function hydrate(keys, opts = {}) {
  const migrate = opts.migrate !== false;
  const db = await _openDB();
  _useIdb = !!db;

  for (const key of keys) {
    if (_useIdb) {
      let got = await _idbGet(db, key);
      if (got === READ_ERR) got = await _idbGet(db, key);     // v8.14: one retry for a transient error
      if (got === READ_ERR) {
        // v8.14: the read FAILED. Use a localStorage copy if one exists, but
        // never treat this as "absent" and never migrate over it.
        _readFailed.add(key);
        _mem.set(key, _lsGet(key));
        continue;
      }
      // v8.19 (audit A1): a marked rescue copy is newer than IndexedDB — use
      // it, write it through, and free it only after a CONFIRMED write.
      if (_rescueMap()[key]) {
        const rescued = _lsGet(key);
        if (rescued !== null) {
          _mem.set(key, rescued);
          if (await _idbSet(db, key, rescued)) _rescueClear(key);
          continue;
        }
        _rescueClear(key);            // marker without a copy: nothing to recover
      }
      if (got !== undefined) { _mem.set(key, got); continue; }   // already in IDB
      // Not in IDB yet — migrate from localStorage if present.
      const ls = _lsGet(key);
      if (ls !== null) {
        const wrote = migrate ? await _idbSet(db, key, ls) : false;
        _mem.set(key, ls);
        if (wrote) _lsRemove(key);   // only free localStorage after a CONFIRMED IDB write
        continue;
      }
      _mem.set(key, null);           // absent in both
    } else {
      _mem.set(key, _lsGet(key));    // IDB unavailable: behave exactly like localStorage
    }
  }
  _hydrated = true;
  return _useIdb;
}

/** Synchronous read from the in-memory mirror (falls back to localStorage if
 *  called before hydrate or for an un-hydrated key). */
export function bigGet(key) {
  if (_hydrated && _mem.has(key)) return _mem.get(key);
  return _lsGet(key);
}

/** Synchronous write to the mirror; persists to IndexedDB in the background
 *  (or localStorage when IDB is unavailable). Returns immediately. */
export function bigSet(key, val) {
  _mem.set(key, val);
  if (_useIdb) {
    _openDB().then(db => db ? _idbSet(db, key, val) : false)
             .then(ok => {
               // v8.19: a write that lands makes any earlier rescue copy stale.
               // Only when the mirror still holds THIS value — a newer bigSet
               // may be in flight and may yet fail.
               if (ok) { if (_mem.get(key) === val) _rescueClear(key); }
               else _rescueWrite(key, val);
             })
             .catch(() => _rescueWrite(key, val));
  } else {
    _lsSet(key, val);
  }
  return true;
}

/** Remove a key from the mirror, IndexedDB, and localStorage. */
export function bigRemove(key) {
  _mem.delete(key);
  _rescueClear(key);
  if (_useIdb) _openDB().then(db => { if (db) _idbDelete(db, key); }).catch(() => {});
  _lsRemove(key);
}

/** Best-effort synchronous-ish flush used on tab-hide. Updates the mirror
 *  immediately and starts the IndexedDB write; the write is not guaranteed to
 *  complete if the page is killed, so this is paired with eager bigSet() on
 *  every change (the mirror/IDB are already near-current). Returns nothing. */
export function bigFlush(key, val) {
  _mem.set(key, val);
  if (_useIdb) {
    // v8.19: same rescue path as bigSet. The tab is being hidden, so the app
    // is not told (no banner to show) — the copy is simply there next launch.
    _openDB().then(db => db ? _idbSet(db, key, val) : false)
             .then(ok => { if (!ok && _lsSet(key, val)) _rescueMark(key); })
             .catch(() => { if (_lsSet(key, val)) _rescueMark(key); });
  }
  else { _lsSet(key, val); }
}

export function idbAvailable() { return _useIdb; }
/** v8.14: true when hydrate could not READ this key (not merely absent). */
export function readFailed(key) { return _readFailed.has(key); }
export function isHydrated() { return _hydrated; }
/** Subscribe to "an IndexedDB write failed and we fell back to localStorage".
 *  The listener gets one argument: true when the fallback copy was saved,
 *  false when that failed too. */
export function onPersistFail(fn) { _failListeners.add(fn); return () => _failListeners.delete(fn); }

// ── PHASE 2 (collection) — IMPLEMENTED in v6.96 ──────────────────────
// The collection (motu-c2) is irreplaceable and is flushed *synchronously*
// from data.js on pagehide/visibilitychange. An IndexedDB write started in a
// pagehide handler is not guaranteed to finish before the page is killed, so
// the collection uses bigSet() on every (debounced) change (IDB stays current
// within ~80ms) plus bigFlush() on hide, backed by a small SYNCHRONOUS
// localStorage "journal" written on hide and reconciled on the next boot — so
// the last change can't be lost even if the async IDB write didn't commit. The
// journal is cleared on resume and only written when IndexedDB is the active
// backend (in localStorage-fallback mode the collection is already written
// synchronously, so no journal is needed). See data.js saveColl/flushSaveColl
// and the journal recovery in app.js boot.
