// ════════════════════════════════════════════════════════════════════
// MOTU Vault — pricing.js (v6.28)
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
//     "sealed":  { "avg": 84.20, "median": 79.99, "n": 12, "samples": [80, 90, ...] } | null,
//     "loose":   { "avg": 32.10, "median": 30.00, "n": 23, "samples": [...] }       | null,
//     "asof":    "2026-05-01T12:00:00Z",
//     "source":  "ebay-finding" | "pricecharting" | "community" | string,
//     "currency": "USD",
//     "note":    "30-day window" (optional)
//   }
// Either sealed or loose may be null when the sample size is too small
// (< MIN_SAMPLES) to be meaningful — the client renders only the side
// that has data.
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
const MIN_SAMPLES = 3;                           // below this, treat as no-signal
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
      const url = backend.url + '/pricing/' + encodeURIComponent(figId);
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
  if (avg == null || n < MIN_SAMPLES) return null;
  return { avg, median, n };
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
export function renderMarketValueBlock(figId, paidArr) {
  if (!figId) return '';
  const cached = getCachedPricing(figId);
  if (!cached || !cached.data) {
    if (!isPricingConfigured()) return '';   // silent when no backend
    // Backend configured but no data yet — render a placeholder + auto-fetch.
    // The detail screen will refresh when fetchPricing resolves.
    queueMicrotask(() => fetchPricing(figId).then(r => {
      if (r && typeof window.patchDetailStatus === 'function') window.patchDetailStatus();
    }));
    return `<div class="market-value-block placeholder">
      <div class="text-sm text-dim" style="text-align:center;padding:10px 0">Looking up market value…</div>
    </div>`;
  }
  const d = cached.data;
  if (!d.sealed && !d.loose) return '';
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
  const sealedRow = d.sealed ? `
    <div class="mv-row">
      <span class="mv-label">Sealed</span>
      <span class="mv-value">${fmtMoney(d.sealed.avg)}${compare(d.sealed.avg)}</span>
      <span class="mv-meta">avg of ${d.sealed.n}</span>
    </div>` : '';
  const looseRow = d.loose ? `
    <div class="mv-row">
      <span class="mv-label">Loose</span>
      <span class="mv-value">${fmtMoney(d.loose.avg)}${compare(d.loose.avg)}</span>
      <span class="mv-meta">avg of ${d.loose.n}</span>
    </div>` : '';
  const sourceLabel = {
    'ebay-finding':   'eBay sold (last 30d)',
    'ebay-browse':    'eBay listings',
    'pricecharting':  'PriceCharting',
    'community':      'Community-curated',
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
  const r = await fetchPricing(figId, { force: true });
  if (typeof window.patchDetailStatus === 'function') window.patchDetailStatus();
  if (typeof window.toast === 'function') {
    window.toast(r ? '✓ Pricing refreshed' : '✗ Pricing fetch failed');
  }
};
