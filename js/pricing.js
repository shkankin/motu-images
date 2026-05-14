// ════════════════════════════════════════════════════════════════════
// MOTU Vault — pricing.js (v6.57)
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

export function renderMarketValueBlock(figId, paidArr, condition) {
  if (!figId) return '';
  const cached = getCachedPricing(figId);
  if (!cached || !cached.data) {
    if (!isPricingConfigured()) return '';   // silent when no backend
    // Only fetch once per session per figId — re-renders after patchDetailStatus
    // would otherwise re-trigger indefinitely.
    if (!_fetched.has(figId) && !_inflight.has(figId)) {
      _fetched.add(figId);
      const meta = renderMarketValueBlock._meta || {};
      fetchPricing(figId, { line: meta.line, wave: meta.wave, year: meta.year }).then(r => {
        // v6.57: re-render the MV block in place so users don't have to leave
        // the detail screen and come back to see the result.
        if (typeof window.rerenderMVBlock === 'function') window.rerenderMVBlock(figId);
        else if (typeof window.patchDetailStatus === 'function') window.patchDetailStatus();
      });
    }
    // v6.57: refresh button — covers slow networks and the case where the
    // initial fetch fails silently. Tapping it forces a new attempt.
    return `<div class="market-value-block placeholder">
      <div class="text-sm text-dim" style="text-align:center;padding:10px 0">Looking up market value…</div>
      <div class="mv-actions"><button onclick="window.refreshPricing && window.refreshPricing(${esc(JSON.stringify(figId))})">↻ Refresh</button></div>
    </div>`;
  }
  const d = cached.data;
  if (!d.sealed && !d.loose) return `<div class="market-value-block">
    <div class="mv-header"><span class="mv-title">Market Value</span></div>
    <div class="text-sm text-dim" style="text-align:center;padding:8px 0">No pricing data found</div>
    <div class="mv-actions"><button onclick="window.refreshPricing && window.refreshPricing(${JSON.stringify(figId)})">↻ Refresh</button></div>
  </div>`;
  const stale = !cached.fresh;
  const fmtMoney = n => '$' + (Math.round(n * 100) / 100).toFixed(2);
  const ageText = (() => {
    const days = Math.floor(cached.age / (24 * 60 * 60 * 1000));
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    return days + 'd ago';
  })();
  // If we have a paid value, show a small comparison badge.
  const paidNums = (paidArr || []).map(v => parseFloat(v)).filter(v => Number.isFinite(v) && v > 0);
  const avgPaid = paidNums.length ? paidNums.reduce((a,b) => a+b, 0) / paidNums.length : 0;
  const compare = (avg) => {
    if (!avgPaid || !avg) return '';
    const diff = (avg - avgPaid) / avgPaid;
    if (Math.abs(diff) < 0.05) return ` <span class="mv-flat" title="Within 5% of avg sold">≈</span>`;
    if (diff > 0) return ` <span class="mv-good" title="${Math.round(diff*100)}% under avg sold">↓</span>`;
    return ` <span class="mv-warn" title="${Math.round(-diff*100)}% over avg sold">↑</span>`;
  };
  // Determine which bucket matches the user's copy condition.
  const SEALED_CONDS = new Set(['Mint in Box','Mint on Card','New/Sealed']);
  const LOOSE_CONDS  = new Set(['Loose Complete','Loose Incomplete','Damaged']);
  const condIsSealed = condition && SEALED_CONDS.has(condition);
  const condIsLoose  = condition && LOOSE_CONDS.has(condition);
  const sealedActive = condIsSealed;
  const looseActive  = condIsLoose;
  const sealedDim    = condition && !condIsSealed;
  const looseDim     = condition && !condIsLoose;

  // v6.56: confidence badge — buckets with <5 samples carry confidence:'low'
  const confBadge = (b) => {
    if (!b || b.confidence === 'high') return '';
    const txt = b.confidence === 'low' ? 'Low sample' : 'Limited data';
    return ` <span class="mv-confidence mv-conf-${b.confidence}" title="${esc(txt)} (n=${b.n})">${txt}</span>`;
  };
  // v6.56-fix: only render range when low/high are present, non-zero, and not identical.
  // Community-curated entries often lack low/high; we used to render "$0.00–$0.00".
  const rangePart = (b) => {
    if (!b) return '';
    const lo = b.low, hi = b.high;
    if (lo == null || hi == null) return '';
    if (lo === 0 && hi === 0) return '';
    if (lo === hi) return '';
    return ` · ${fmtMoney(lo)}–${fmtMoney(hi)}`;
  };
  const sealedRow = d.sealed ? `
    <div class="mv-row${sealedActive ? ' mv-active' : sealedDim ? ' mv-dim' : ''}">
      <span class="mv-label">Sealed</span>
      <span class="mv-value">${fmtMoney(d.sealed.avg)}${compare(d.sealed.avg)}</span>
      <span class="mv-meta">avg of ${d.sealed.n}${rangePart(d.sealed)}${confBadge(d.sealed)}</span>
    </div>` : '';
  const looseRow = d.loose ? `
    <div class="mv-row${looseActive ? ' mv-active' : looseDim ? ' mv-dim' : ''}">
      <span class="mv-label">Loose</span>
      <span class="mv-value">${fmtMoney(d.loose.avg)}${compare(d.loose.avg)}</span>
      <span class="mv-meta">avg of ${d.loose.n}${rangePart(d.loose)}${confBadge(d.loose)}</span>
    </div>` : '';
  const sourceLabel = {
    'ebay-sold':      'eBay sold (last 30d)',
    'ebay-active':    'eBay asking prices',
    'ebay-finding':   'eBay sold (last 30d)',   // legacy
    'ebay-browse':    'eBay listings',          // legacy
    'pricecharting':  'PriceCharting',
    'community':      'Community-curated',
    'unavailable':    'Unavailable',
  }[d.source] || esc(d.source);
  return `<div class="market-value-block${stale ? ' stale' : ''}">
    <div class="mv-header">
      <span class="mv-title">Market Value</span>
      <span class="mv-source text-dim">${sourceLabel}</span>
      <span class="mv-age text-dim" title="Cached ${ageText}">${stale ? '⟳ ' : ''}${ageText}</span>
    </div>
    ${sealedRow}${looseRow}
    ${d.note ? `<div class="mv-note text-dim text-sm">${esc(d.note)}</div>` : ''}
    <div class="mv-actions">
      <button onclick="window.refreshPricing && window.refreshPricing(${esc(JSON.stringify(figId))})">↻ Refresh</button>
    </div>
  </div>`;
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
