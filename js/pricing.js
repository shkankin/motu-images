// ════════════════════════════════════════════════════════════════════
// MOTU Vault — pricing.js (v6.64)
// ────────────────────────────────────────────────────────────────────
// Client-side market-value layer. Talks to a configurable backend that
// returns recent-sold averages per figure. The backend is intentionally
// abstracted: it can be a Cloudflare Worker hitting eBay's APIs, a
// PriceCharting proxy, a community-curated static JSON file in the
// figures repo, or anything else that returns the documented JSON shape.
//
// Wire format the backend MUST return for GET <base>/pricing/<figId>:
//   {
//     "figId": "he-man-1234",
//     "sealed":  { "avg": 84.20, "median": 79.99, "n": 12, "low": 60, "high": 110,
//                  "confidence": "high"|"medium"|"low", "samples": [80, 90, ...] } | null,
//     "loose":   { ... same shape ... } | null,
//     "asof":    "2026-05-01T12:00:00Z",
//     "source":  "community" | "ebay-sold" | "ebay-active" | "unavailable" | string,
//     "currency": "USD",
//     "note":    "30-day window" (optional)
//   }
// v6.56: buckets now carry a `confidence` flag instead of being nulled
// for low sample size. The client renders the value with a "Low sample"
// badge so users can see the data exists but treat it as an estimate.
//
// Storage:
//   localStorage motu-pricing-backend = { url: string, apiKey?: string }
//   localStorage motu-pricing-cache   = { [figId]: { data, fetchedAt } }
//
// The cache is honored for CACHE_TTL after which a background refresh
// runs on next access. Stale-while-revalidate so users never wait.
// ════════════════════════════════════════════════════════════════════

import { S, store, esc } from './state.js';

const BACKEND_KEY = 'motu-pricing-backend';
const CACHE_KEY   = 'motu-pricing-cache';
const CACHE_TTL   = 24 * 60 * 60 * 1000;        // 24h
const STALE_TTL   = 7  * 24 * 60 * 60 * 1000;   // 7d — beyond this, treat as expired
const MIN_SAMPLES = 1;                           // v6.56: keep low-sample, flag confidence
const REQUEST_TIMEOUT = 8000;                    // 8s — backend SLO

let _cache = null;
let _backend = null;
const _inflight = new Map();   // figId → Promise to dedupe concurrent calls

function _loadCache() {
  if (_cache) return _cache;
  _cache = store.get(CACHE_KEY) || {};
  return _cache;
}
function _saveCache() {
  if (_cache) store.set(CACHE_KEY, _cache);
}
function _loadBackend() {
  if (_backend !== null) return _backend;
  const v = store.get(BACKEND_KEY);
  _backend = (v && typeof v === 'object' && v.url) ? v : null;
  return _backend;
}

// ── Public API ──────────────────────────────────────────────────────

export function isPricingConfigured() { return !!_loadBackend(); }

// v6.88: drop the in-memory backend cache so the next read re-pulls from
// storage. Called after a settings import restores motu-pricing-backend, so
// a restored pricing backend works immediately without a page reload.
export function reloadBackend() { _backend = null; return _loadBackend(); }

export function getPricingBackend() {
  const b = _loadBackend();
  return b ? { url: b.url, hasKey: !!b.apiKey } : null;
}

export function configurePricingBackend(url, apiKey) {
  if (!url) {
    store.set(BACKEND_KEY, null);
    localStorage.removeItem(BACKEND_KEY);
    _backend = null;
    return;
  }
  // Validate URL — must be http(s), no embedded credentials, no fragment.
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Not a valid URL'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Backend URL must be http(s)');
  if (parsed.username || parsed.password) throw new Error('Embedded credentials not allowed');
  // Strip trailing slash for predictable path-joining
  const cleanUrl = parsed.origin + parsed.pathname.replace(/\/$/, '');
  store.set(BACKEND_KEY, { url: cleanUrl, apiKey: apiKey || undefined });
  _backend = { url: cleanUrl, apiKey: apiKey || undefined };
}

// Synchronous read of cached pricing (no network). Returns the cached
// data if present and not too stale, regardless of TTL — callers decide
// whether to render stale data while a refresh is in flight.
export function getCachedPricing(figId) {
  const cache = _loadCache();
  const entry = cache[figId];
  if (!entry || !entry.data) return null;
  const age = Date.now() - (entry.fetchedAt || 0);
  if (age > STALE_TTL) return null;
  return { data: entry.data, age, fresh: age < CACHE_TTL };
}

// Async fetch + cache. Returns the same shape getCachedPricing returns.
// Background-refreshes if cached data is older than CACHE_TTL but younger
// than STALE_TTL (stale-while-revalidate).
export async function fetchPricing(figId, opts = {}) {
  if (!figId) return null;
  const force = !!opts.force;
  const backend = _loadBackend();
  if (!backend) return null;

  const cached = getCachedPricing(figId);
  if (cached && cached.fresh && !force) return cached;

  // Dedupe concurrent calls for the same figId
  if (_inflight.has(figId)) return _inflight.get(figId);

  const p = (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT);
      const headers = { 'Accept': 'application/json' };
      if (backend.apiKey) headers['Authorization'] = 'Bearer ' + backend.apiKey;
      // Path encoding — figId can contain hyphens but never slashes; still safer to encodeURIComponent.
      // Pass fig metadata as query params so the worker can build a precise eBay search query.
      const urlObj = new URL(backend.url + '/pricing/' + encodeURIComponent(figId));
      if (opts.line) urlObj.searchParams.set('line', opts.line);
      if (opts.wave) urlObj.searchParams.set('wave', opts.wave);
      if (opts.year) urlObj.searchParams.set('year', String(opts.year));
      // v6.59: force=true also bypasses the WORKER's KV cache, not just the
      // client cache. Without this the refresh button just re-reads the same
      // cached eBay result the worker stored 24h ago.
      if (force) urlObj.searchParams.set('fresh', '1');
      const url = urlObj.toString();
      const res = await fetch(url, { headers, signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data || typeof data !== 'object') throw new Error('Invalid response');
      // Light validation — drop obviously bad data so the renderer doesn't
      // need defensive checks.
      const clean = _sanitize(data);
      const cache = _loadCache();
      cache[figId] = { data: clean, fetchedAt: Date.now() };
      _cache = cache;
      _saveCache();
      _recordHistory(figId, clean, opts.line);  // v6.69: sparkline history
      return { data: clean, age: 0, fresh: true };
    } catch (e) {
      // Network/timeout/parse failure — return stale data if we have any,
      // otherwise null. Don't poison the cache.
      return cached || null;
    } finally {
      _inflight.delete(figId);
    }
  })();
  _inflight.set(figId, p);
  return p;
}

// Drop everything cached. Useful for a Settings "clear pricing cache" button.
export function clearPricingCache() {
  _cache = {};
  store.set(CACHE_KEY, {});
}

// ── Validation / sanitization ───────────────────────────────────────

function _sanitizeBucket(b) {
  if (!b || typeof b !== 'object') return null;
  const avg    = Number.isFinite(+b.avg)    ? +b.avg    : null;
  const median = Number.isFinite(+b.median) ? +b.median : null;
  const n      = Number.isInteger(+b.n) && +b.n >= 0 ? +b.n : 0;
  const low    = Number.isFinite(+b.low)    ? +b.low    : null;
  const high   = Number.isFinite(+b.high)   ? +b.high   : null;
  if (avg == null || n < MIN_SAMPLES) return null;
  // v6.56: preserve confidence flag from backend; default by sample size.
  const confidence = (b.confidence === 'high' || b.confidence === 'medium' || b.confidence === 'low')
    ? b.confidence
    : (n < 5 ? 'low' : n < 15 ? 'medium' : 'high');
  return { avg, median, n, low, high, confidence };
}
function _sanitize(d) {
  return {
    figId:    String(d.figId || ''),
    sealed:   _sanitizeBucket(d.sealed),
    loose:    _sanitizeBucket(d.loose),
    asof:     typeof d.asof === 'string' ? d.asof : null,
    source:   typeof d.source === 'string' ? d.source.slice(0, 40) : 'unknown',
    currency: typeof d.currency === 'string' ? d.currency.slice(0, 8) : 'USD',
    note:     typeof d.note === 'string' ? d.note.slice(0, 200) : null,
  };
}

// ── Render helpers ──────────────────────────────────────────────────

// Render a compact market-value block. Returns '' when there's no data
// to show (no backend, no cache, etc.) so callers can drop it inline
// without conditional wrappers.
const _fetched = new Set(); // figIds fetched this session — prevents re-fetch on re-render

// Modern lines use sealed-bucket median (figures sold mostly MOC); vintage lines
// use loose-bucket median (figures sold mostly out-of-package). Determined by
// line id; any line not in this set is treated as modern by default.
const VINTAGE_LINES = new Set(['original', 'new-adventures']);

// v6.64: inline "Asking" price renderer. Returns a small fragment meant to
// sit next to Retail (e.g. "Original Retail: $17.99 · Asking: $55"), not a
// full block. Drops the old condition rows, source labels, confidence
// badges, refresh button, and stale indicator — everything that made the
// market-value block a "production." Just one number.
//
// Returns:
//   ""        — when no backend is configured, or no data yet (silent fail)
//   "loading" sentinel HTML on first fetch so the caller can lay it out
//   "<span>…</span>" when data is available
export function renderMarketValueBlock(figId, paidArr, condition) {
  if (!figId) return '';
  const cached = getCachedPricing(figId);
  if (!cached || !cached.data) {
    if (!isPricingConfigured()) return '';
    if (!_fetched.has(figId) && !_inflight.has(figId)) {
      _fetched.add(figId);
      const meta = renderMarketValueBlock._meta || {};
      fetchPricing(figId, { line: meta.line, wave: meta.wave, year: meta.year }).then(() => {
        if (typeof window.rerenderMVBlock === 'function') window.rerenderMVBlock(figId);
      });
    }
    return `<span class="mv-inline mv-loading text-dim">eBay Asking: …</span>`;
  }
  const d = cached.data;
  if (!d.sealed && !d.loose) return '';
  const meta = renderMarketValueBlock._meta || {};
  // v6.64: pick the bucket that matches the era. Modern → sealed; vintage → loose.
  // Fall back to whichever bucket is populated if the preferred one is empty.
  const prefersSealed = !VINTAGE_LINES.has(meta.line);
  const primary   = prefersSealed ? d.sealed : d.loose;
  const fallback  = prefersSealed ? d.loose  : d.sealed;
  const bucket = primary || fallback;
  if (!bucket) return '';
  const price = Number.isFinite(bucket.median) ? bucket.median : bucket.avg;
  if (!Number.isFinite(price) || price <= 0) return '';
  const fmtMoney = n => '$' + (Math.round(n * 100) / 100).toFixed(2);
  // Show low-sample as dim so users can tell it's an estimate without a badge.
  const dimClass = (bucket.confidence === 'low') ? ' mv-inline-dim' : '';
  return `<span class="mv-inline${dimClass}" title="Median of ${bucket.n} eBay BIN listings">eBay Asking: <span class="price">${fmtMoney(price)}</span></span>`;
}

// v6.67: synchronous cached asking price for a figure record. Mirrors the
// bucket-selection logic in renderMarketValueBlock (modern → sealed median,
// vintage → loose median, fall back to the populated bucket). Used by the
// collection-value dashboard to aggregate without any network traffic.
export function getCachedAskingPrice(fig) {
  if (!fig || !fig.id) return null;
  const cached = getCachedPricing(fig.id);
  if (!cached || !cached.data) return null;
  const d = cached.data;
  const prefersSealed = !VINTAGE_LINES.has(fig.line);
  const bucket = (prefersSealed ? d.sealed : d.loose) || (prefersSealed ? d.loose : d.sealed);
  if (!bucket) return null;
  const price = Number.isFinite(bucket.median) ? bucket.median : bucket.avg;
  return (Number.isFinite(price) && price > 0) ? price : null;
}

// ── v6.69: price history + sparkline ────────────────────────────────
// Every successful fetch appends a daily {d, p} point per figure (same-day
// fetches overwrite; capped at 40 points ≈ a year of weekly checks). The
// detail screen renders an inline sparkline once 3+ points exist.
// localStorage motu-pricing-history = { [figId]: [{d:'YYYY-MM-DD', p:number}] }
const HISTORY_KEY = 'motu-pricing-history';
const HISTORY_CAP = 40;
let _history = null;
function _loadHistory() {
  if (!_history) _history = store.get(HISTORY_KEY) || {};
  return _history;
}
function _recordHistory(figId, data, line) {
  const prefersSealed = !VINTAGE_LINES.has(line);
  const bucket = (prefersSealed ? data.sealed : data.loose) || (prefersSealed ? data.loose : data.sealed);
  if (!bucket) return;
  const price = Number.isFinite(bucket.median) ? bucket.median : bucket.avg;
  if (!Number.isFinite(price) || price <= 0) return;
  const h = _loadHistory();
  const arr = h[figId] || (h[figId] = []);
  const day = new Date().toISOString().slice(0, 10);
  const last = arr[arr.length - 1];
  if (last && last.d === day) last.p = price;
  else arr.push({ d: day, p: price });
  if (arr.length > HISTORY_CAP) arr.splice(0, arr.length - HISTORY_CAP);
  store.set(HISTORY_KEY, h);
}
export function getPriceHistory(figId) {
  return _loadHistory()[figId] || [];
}
// Tiny inline SVG sparkline (64×16). Returns '' below 3 points. Stroke is
// green/red by overall trend so the price direction reads at a glance.
export function renderSparkline(figId) {
  const pts = getPriceHistory(figId);
  if (pts.length < 3) return '';
  const W = 64, H = 16, P = 2;
  const ps = pts.map(x => x.p);
  const min = Math.min(...ps), max = Math.max(...ps);
  const span = (max - min) || 1;
  const step = (W - 2 * P) / (pts.length - 1);
  const poly = ps.map((p, i) =>
    `${(P + i * step).toFixed(1)},${(H - P - ((p - min) / span) * (H - 2 * P)).toFixed(1)}`).join(' ');
  const up = ps[ps.length - 1] >= ps[0];
  const col = up ? 'var(--gn)' : 'var(--rd)';
  return `<svg class="mv-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="vertical-align:-3px;margin-left:6px" aria-label="price trend"><polyline points="${poly}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// Inline action — exposed to inline-onclick. Forces a fresh fetch.
window.refreshPricing = async (figId) => {
  if (!figId) return;
  _fetched.delete(figId); // allow re-fetch
  const meta = renderMarketValueBlock._meta || {};
  const r = await fetchPricing(figId, { force: true, line: meta.line, wave: meta.wave, year: meta.year });
  // v6.57: prefer in-place MV re-render; fall back to patchDetailStatus.
  if (typeof window.rerenderMVBlock === 'function') window.rerenderMVBlock(figId);
  else if (typeof window.patchDetailStatus === 'function') window.patchDetailStatus();
  if (typeof window.toast === 'function') {
    window.toast(r?.data?.loose || r?.data?.sealed ? '✓ Pricing refreshed' : '✗ No pricing data found');
  }
};
