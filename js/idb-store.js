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

function _idbGet(db, key) {
  return new Promise((resolve) => {
    let tx;
    try { tx = db.transaction(STORE_NAME, 'readonly'); }
    catch { resolve(undefined); return; }
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);     // undefined when the key is absent
    req.onerror = () => resolve(undefined);
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

// ── Synchronous in-memory mirror ─────────────────────────────────────
const _mem = new Map();
let _useIdb = false;     // resolved at hydrate()
let _hydrated = false;
const _failListeners = new Set();

function _notifyFail() { for (const fn of _failListeners) { try { fn(); } catch {} } }

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
      const got = await _idbGet(db, key);
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
             .then(ok => { if (!ok) { _lsSet(key, val); _notifyFail(); } })
             .catch(() => { _lsSet(key, val); _notifyFail(); });
  } else {
    _lsSet(key, val);
  }
  return true;
}

/** Remove a key from the mirror, IndexedDB, and localStorage. */
export function bigRemove(key) {
  _mem.delete(key);
  if (_useIdb) _openDB().then(db => { if (db) _idbDelete(db, key); }).catch(() => {});
  _lsRemove(key);
}

/** Best-effort synchronous-ish flush used on tab-hide. Updates the mirror
 *  immediately and starts the IndexedDB write; the write is not guaranteed to
 *  complete if the page is killed, so this is paired with eager bigSet() on
 *  every change (the mirror/IDB are already near-current). Returns nothing. */
export function bigFlush(key, val) {
  _mem.set(key, val);
  if (_useIdb) { _openDB().then(db => { if (db) _idbSet(db, key, val); }).catch(() => {}); }
  else { _lsSet(key, val); }
}

export function idbAvailable() { return _useIdb; }
export function isHydrated() { return _hydrated; }
/** Subscribe to "an IndexedDB write failed and we fell back to localStorage". */
export function onPersistFail(fn) { _failListeners.add(fn); return () => _failListeners.delete(fn); }

// ── PHASE 2 (collection) — design note, not yet wired ────────────────
// The collection (motu-c2) is irreplaceable and is flushed *synchronously*
// from data.js on pagehide/visibilitychange. An IndexedDB write started in a
// pagehide handler is not guaranteed to finish before the page is killed.
// The planned approach: write the collection through bigSet() on every
// (debounced) change so IDB is essentially always current, call bigFlush() on
// hide, and on the next boot reconcile against a small synchronous localStorage
// "journal" written on hide (cleared once IDB is confirmed current) so the very
// last change can never be lost. That belongs in its own change with focused
// tests — this module already exposes the primitives (bigFlush, onPersistFail)
// it will need.
