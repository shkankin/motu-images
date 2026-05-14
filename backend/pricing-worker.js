// ════════════════════════════════════════════════════════════════════
// MOTU Vault — pricing-worker.js (Cloudflare Workers) — v6.58
// ────────────────────────────────────────────────────────────────────
// Reference backend for the client-side pricing.js. Deploy to Cloudflare
// Workers (free tier covers a multi-thousand-figure catalog comfortably).
//
// Routes:
//   GET  /pricing/<figId>         → JSON in the shape pricing.js expects
//   POST /pricing/bulk            → batch lookups (1–50 figIds)
//   GET  /health                  → status + active provider chain
//   POST /admin/community/<figId> → write community-curated price (admin auth)
//
// Providers (configured via env.PROVIDER_CHAIN — comma-separated list, tried
// in order until one returns a positive result):
//   "community"    — KV-backed crowdsource/curate. Zero API cost. Authoritative.
//   "ebay-sold"    — eBay Marketplace Insights API (true sold prices).
//                    Requires partner approval; throws until enabled.
//   "ebay-active"  — eBay Browse API. ASKING prices, not sold. Flagged so
//                    the UI can warn the user.
//   "stub"         — deterministic mock data for dev.
//
// Default chain: "community,ebay-active". Community fills authoritative
// data when present; eBay active is the honest fallback. Once Marketplace
// Insights is approved, change to "community,ebay-sold,ebay-active".
//
// Cache: positive provider responses cached in KV for CACHE_TTL_SECONDS
// (default 24h). Negative results are NOT cached.
//
// Bindings (see wrangler.toml):
//   KV: PRICING_CACHE, COMMUNITY_PRICES, (optional) QUERY_MAP
//   vars: PROVIDER_CHAIN (or legacy PROVIDER), ALLOWED_ORIGINS, MIN_SAMPLES
//   secrets: EBAY_APP_ID, EBAY_CERT_ID, ADMIN_TOKEN
// ════════════════════════════════════════════════════════════════════

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const MIN_SAMPLES_DEFAULT = 1;          // v6.56: keep low-sample data, flag confidence
const DEFAULT_CHAIN = 'community,ebay-active';
const BULK_MAX = 50;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/health') {
      return json({ status: 'ok', chain: getChain(env) }, 200, cors);
    }

    // POST /pricing/bulk  body: { figIds: [...], meta?: {line, wave, year} }
    if (url.pathname === '/pricing/bulk' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400, cors); }
      const ids = Array.isArray(body?.figIds) ? body.figIds : [];
      if (ids.length === 0 || ids.length > BULK_MAX) {
        return json({ error: `provide 1–${BULK_MAX} figIds` }, 400, cors);
      }
      const invalid = ids.filter(id => !isValidFigId(id));
      if (invalid.length) return json({ error: 'invalid figIds', invalid }, 400, cors);
      const meta = (body.meta && typeof body.meta === 'object') ? body.meta : {};
      const results = await Promise.all(
        ids.map(id => getPricing(id, env, ctx, meta).catch(e => ({
          figId: id, sealed: null, loose: null, source: 'error',
          error: String(e.message || e), asof: new Date().toISOString(),
        })))
      );
      return json({ results }, 200, cors);
    }

    // GET /pricing/<figId>
    const m = url.pathname.match(/^\/pricing\/([^\/]+)$/);
    if (m && request.method === 'GET') {
      const figId = decodeURIComponent(m[1]);
      if (!isValidFigId(figId)) return json({ error: 'invalid figId' }, 400, cors);
      const meta = {
        line: url.searchParams.get('line') || undefined,
        wave: url.searchParams.get('wave') || undefined,
        year: url.searchParams.get('year') || undefined,
      };
      try {
        const data = await getPricing(figId, env, ctx, meta);
        return json(data, 200, cors);
      } catch (e) {
        return json({ error: 'upstream', message: String(e.message || e) }, 502, cors);
      }
    }

    // POST /admin/community/<figId>  body: {sealed?, loose?, note?}
    const am = url.pathname.match(/^\/admin\/community\/([^\/]+)$/);
    if (am && request.method === 'POST') {
      if (!authorizeAdmin(request, env)) return json({ error: 'unauthorized' }, 401, cors);
      const figId = decodeURIComponent(am[1]);
      if (!isValidFigId(figId)) return json({ error: 'invalid figId' }, 400, cors);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400, cors); }
      const cleaned = cleanCommunityEntry(body);
      if (!cleaned.sealed && !cleaned.loose) return json({ error: 'no buckets' }, 400, cors);
      cleaned.updatedAt = new Date().toISOString();
      await env.COMMUNITY_PRICES.put(figId, JSON.stringify(cleaned));
      await env.PRICING_CACHE.delete(figId);   // bust cache so next read sees fresh
      return json({ ok: true, figId }, 200, cors);
    }

    return json({ error: 'not found' }, 404, cors);
  },
};

// ── Provider registry & dispatch ────────────────────────────────────

const PROVIDERS = {
  'community':   communityProvider,
  'ebay-sold':   ebaySoldProvider,
  'ebay-active': ebayActiveProvider,
  'stub':        stubProvider,
};

function getChain(env) {
  // Backwards-compat: legacy PROVIDER env still works as single-entry chain.
  const raw = env.PROVIDER_CHAIN || env.PROVIDER || DEFAULT_CHAIN;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

async function getPricing(figId, env, ctx, meta = {}) {
  // 1. Cache
  const cached = await env.PRICING_CACHE.get(figId, { type: 'json' });
  if (cached) return cached;

  // 2. Try each provider in chain until one returns positive data
  const chain = getChain(env);
  let lastErr = null;
  for (const name of chain) {
    const fn = PROVIDERS[name];
    if (!fn) continue;
    try {
      const raw = await fn(figId, env, meta);
      const out = shapeResult(figId, raw, name, env);
      if (out.sealed || out.loose) {
        ctx.waitUntil(env.PRICING_CACHE.put(figId, JSON.stringify(out), { expirationTtl: CACHE_TTL_SECONDS }));
        return out;
      }
      // empty — try next provider
    } catch (e) {
      lastErr = e;
      // continue to next provider — soft-fail one provider, don't kill the request
    }
  }

  // 3. All providers exhausted — return graceful no-data shape (NOT cached)
  return {
    figId, sealed: null, loose: null,
    asof: new Date().toISOString(),
    source: 'unavailable',
    currency: 'USD',
    note: lastErr ? `Pricing temporarily unavailable: ${lastErr.message}` : 'No market data found',
  };
}

function shapeResult(figId, raw, providerName, env) {
  const minN = parseInt(env.MIN_SAMPLES || MIN_SAMPLES_DEFAULT, 10);
  const sealed = validateBucket(raw?.sealed, minN);
  const loose  = validateBucket(raw?.loose,  minN);

  // v6.56: append confidence note if any bucket is low-sample.
  let note = raw?.note || null;
  const lowConf = (sealed?.confidence === 'low') || (loose?.confidence === 'low');
  if (lowConf) note = (note ? note + ' · ' : '') + 'Low sample size — estimate only';

  return {
    figId,
    sealed,
    loose,
    asof:     raw?.asof || new Date().toISOString(),
    source:   raw?.source || providerName,
    currency: raw?.currency || 'USD',
    note,
  };
}

// ── Providers ───────────────────────────────────────────────────────

async function communityProvider(figId, env) {
  const raw = await env.COMMUNITY_PRICES.get(figId, { type: 'json' });
  if (!raw) return { sealed: null, loose: null, source: 'community' };
  return {
    sealed: raw.sealed,
    loose:  raw.loose,
    asof:   raw.updatedAt,
    source: 'community',
    note:   raw.note,
  };
}

function stubProvider(figId) {
  // Deterministic mock for development.
  let h = 0;
  for (let i = 0; i < figId.length; i++) h = (h * 31 + figId.charCodeAt(i)) >>> 0;
  const base = (h % 80) + 20;
  return {
    sealed: { avg: base * 1.4, median: base * 1.35, n: 5 + (h % 15) },
    loose:  { avg: base * 0.6, median: base * 0.55, n: 8 + (h % 20) },
    source: 'stub',
    note:   'Mock data — configure a real provider before deploying',
  };
}

// ── eBay Sold (Marketplace Insights) — wired but inert until approved ──
async function ebaySoldProvider(figId, env, meta) {
  // Marketplace Insights API returns true sold-price history but requires
  // partner-program approval. Once approved, replace this body with a real
  // call to /buy/marketplace_insights/v1_beta/item_sales/search.
  throw new Error('MARKETPLACE_INSIGHTS_REQUIRED — apply at developer.ebay.com');
}

// ── eBay Active (Browse API) — ASKING prices, flagged honestly ──
async function ebayActiveProvider(figId, env, meta = {}) {
  const token = await getEbayToken(env);
  const queryName = (await getQueryMapping(figId, env)) || figIdToQuery(figId, meta);
  // v6.58: fetch the full 100-item page so trimmed mean / median have more
  // to chew on. eBay caps Browse at 200; 100 is plenty without a second call.
  const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?' + new URLSearchParams({
    q: queryName,
    filter: 'buyingOptions:{FIXED_PRICE},price:[5..]',  // price floor: kill $0.99 shipping bait
    limit: '100',
  });
  const res = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'X-EBAY-C-ENDUSERCTX': 'contextualLocation=country%3DUS',
    },
  });
  const rawBody = await res.text();
  if (!res.ok) throw new Error('eBay HTTP ' + res.status + ' — ' + rawBody.slice(0, 300));
  const data = JSON.parse(rawBody);
  const items = data.itemSummaries || [];

  // v6.58: sealed markers — strict, no bare \bnew\b.
  const SEALED_RE = /\b(mib|moc|nib|nip|sealed|unopened|new in (?:box|package|card)|brand new in (?:box|package)|mint in (?:box|package|card)|carded|factory sealed)\b/i;

  // v6.58: junk filter — drop listings that aren't a single complete figure.
  // These contaminate both buckets:
  //  - "lot of 5 figures" → wrong unit price
  //  - "custom Tung Lashor" / "repro card" → not the official product
  //  - "broken / parts only / missing head" → not market value
  //  - "art print / poster / sticker / magnet" → merch, not figure
  const JUNK_RE = /\b(lot of|bundle|joblot|job lot|x ?\d+ figures?|custom (?:painted|head|made)|reproduction|repro card|repro bubble|bootleg|knockoff|ko[ -]?figure|broken|damaged|incomplete|missing|parts only|for parts|read description|art print|poster|sticker|magnet|t-?shirt|button pin|keychain|fan art|3d print(?:ed)?)\b/i;

  // v6.58: line mismatch — if the user is asking about Origins, reject titles
  // that strongly signal a different line. Origins-specific because that's
  // the most contaminated query (vintage Tung Lashor sells for 10× Origins).
  const lineNegative = LINE_NEGATIVE_TERMS[meta.line];

  const sealed = [], loose = [];
  let rejected = 0;
  for (const it of items) {
    const price = parseFloat(it?.price?.value);
    if (!Number.isFinite(price) || price < 5) { rejected++; continue; }
    const title = (it.title || '').toLowerCase();
    if (JUNK_RE.test(title)) { rejected++; continue; }
    if (lineNegative && lineNegative.test(title)) { rejected++; continue; }
    if (SEALED_RE.test(title)) sealed.push(price);
    else loose.push(price);
  }
  return {
    sealed: bucketStats(sealed),
    loose:  bucketStats(loose),
    source: 'ebay-active',
    note:   `Active listings (asking prices) for "${queryName}" — not sold prices${rejected ? ` · filtered ${rejected} junk/off-line` : ''}`,
  };
}

// ── eBay OAuth token (client-credentials, KV-cached 2h) ─────────────
async function getEbayToken(env) {
  const cached = await env.PRICING_CACHE.get('__ebay_token__', { type: 'json' }).catch(() => null);
  if (cached && cached.expires > Date.now()) return cached.token;

  if (!env.EBAY_APP_ID || !env.EBAY_CERT_ID) throw new Error('EBAY_APP_ID / EBAY_CERT_ID not configured');
  const creds = btoa(env.EBAY_APP_ID + ':' + env.EBAY_CERT_ID);
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + creds,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('eBay token HTTP ' + res.status + ' — ' + body.slice(0, 200));
  }
  const data = await res.json();
  const token = data.access_token;
  const expires = Date.now() + (data.expires_in - 300) * 1000;   // 5-min buffer
  // Fire-and-forget write. Concurrent cold requests may double-fetch, accepted.
  env.PRICING_CACHE.put('__ebay_token__', JSON.stringify({ token, expires }), { expirationTtl: 7200 }).catch(() => {});
  return token;
}

// ── Stats & validation ──────────────────────────────────────────────

function bucketStats(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;

  // v6.58: trimmed mean — drop the bottom 20% and top 20% before averaging.
  // For collectibles markets where listings span "parts" to "graded perfect",
  // trimmed mean is FAR more representative than a plain avg, and more robust
  // than IQR for skewed distributions. Floor of 1 trim either side so even
  // small samples benefit.
  let use;
  if (n >= 5) {
    const trim = Math.max(1, Math.floor(n * 0.2));
    use = sorted.slice(trim, n - trim);
  } else {
    use = sorted; // too small to trim meaningfully
  }
  if (!use.length) use = sorted;

  const sum = use.reduce((a, b) => a + b, 0);
  const avg = sum / use.length;
  // True median across the FULL sorted set (not the trimmed slice) — median is
  // already outlier-resistant by definition.
  const median = n % 2
    ? sorted[(n - 1) / 2]
    : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;

  // Confidence: keep low/medium/high but base on FULL n, not trimmed length.
  let confidence = 'high';
  if (n < 5) confidence = 'low';
  else if (n < 15) confidence = 'medium';

  return {
    avg:    round2(avg),       // trimmed mean — shown in raw data, not headline
    median: round2(median),    // CLIENT renders this as the headline price
    n,
    low:  round2(use[0]),                // low/high of the trimmed range, not raw
    high: round2(use[use.length - 1]),
    confidence,
    samples: use.slice(0, 10).map(round2),
  };
}
function round2(n) { return Math.round(n * 100) / 100; }

function validateBucket(b, minN) {
  if (!b) return null;
  const avg    = Number(b.avg);
  const median = Number(b.median);
  const n      = parseInt(b.n, 10);
  if (!Number.isFinite(avg) || !Number.isFinite(median)) return null;
  if (!Number.isInteger(n) || n < minN) return null;
  const low  = Number.isFinite(Number(b.low))  ? round2(Number(b.low))  : null;
  const high = Number.isFinite(Number(b.high)) ? round2(Number(b.high)) : null;
  const confidence = typeof b.confidence === 'string'
    ? b.confidence
    : (n < 5 ? 'low' : n < 15 ? 'medium' : 'high');
  return { avg: round2(avg), median: round2(median), n, low, high, confidence };
}

function cleanCommunityEntry(body) {
  return {
    sealed: validateBucket(body?.sealed, 1),
    loose:  validateBucket(body?.loose, 1),
    note:   typeof body?.note === 'string' ? body.note.slice(0, 200) : null,
  };
}

async function getQueryMapping(figId, env) {
  if (!env.QUERY_MAP) return null;
  return await env.QUERY_MAP.get(figId).catch(() => null);
}

// ── Search query construction ───────────────────────────────────────

const LINE_SEARCH_TERMS = {
  'original':       'Masters of the Universe vintage',
  'new-adventures': 'He-Man New Adventures',
  '200x':           'Masters of the Universe 200x',
  'classics':       'Masters of the Universe Classics',
  'origins':        'Masters of the Universe Origins',
  'masterverse':    'Masterverse Masters of the Universe',
  'kids-core':      'Masters of the Universe Kids Core',
  'super7':         'Super7 Masters of the Universe',
  'mondo':          'Mondo Masters of the Universe',
  'eternia-minis':  'Masters of the Universe Minis',
};

// v6.58: per-line negative title regex — applied to eBay results to reject
// cross-line contamination. Origins is the worst offender because the
// generic toy name (e.g. "Tung Lashor") matches vintage listings that sell
// for 10× the Origins price. Each regex rejects titles signalling the
// WRONG line for the requested figure.
const LINE_NEGATIVE_TERMS = {
  'origins':        /\b(vintage|1980s?|1990s?|198[0-9]|199[0-9]|filmation|classics|masterverse|super ?7|mondo|200x|new adventures|2002|movie)\b/i,
  'classics':       /\b(vintage|1980s?|filmation|origins|masterverse|super ?7|mondo|200x|new adventures|kids core)\b/i,
  'masterverse':    /\b(vintage|1980s?|filmation|origins|classics|super ?7|mondo|200x|new adventures|kids core)\b/i,
  'original':       /\b(origins|classics|masterverse|super ?7|mondo|200x|new adventures|kids core|movie 2025)\b/i,
  '200x':           /\b(vintage|1980s?|filmation|origins|classics|masterverse|super ?7|mondo|new adventures|kids core)\b/i,
  'new-adventures': /\b(vintage|1980s?|filmation|origins|classics|masterverse|super ?7|mondo|200x|kids core)\b/i,
  'super7':         /\b(vintage|1980s?|origins|classics|masterverse|mondo|200x|new adventures|kids core)\b/i,
  'mondo':          /\b(vintage|1980s?|origins|classics|masterverse|super ?7|200x|new adventures|kids core)\b/i,
  'kids-core':      /\b(vintage|1980s?|origins|classics|masterverse|super ?7|mondo|200x|new adventures)\b/i,
  'eternia-minis':  /\b(vintage|1980s?|origins|classics|masterverse|super ?7|mondo|200x)\b/i,
};

function figIdToQuery(figId, meta = {}) {
  const name = figId.replace(/-\d{2,6}$/, '').replace(/-/g, ' ').trim();
  const lineTerm = (meta.line && LINE_SEARCH_TERMS[meta.line]) || 'Masters of the Universe';
  return name + ' ' + lineTerm;
}
function isValidFigId(s) {
  return typeof s === 'string' && s.length > 0 && s.length < 200 && /^[a-zA-Z0-9_-]+$/.test(s);
}

function authorizeAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const auth = request.headers.get('authorization') || '';
  return auth === 'Bearer ' + env.ADMIN_TOKEN;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowList = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allow = allowList.length === 0 ? '*' : (allowList.includes(origin) ? origin : allowList[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extra || {}) },
  });
}
