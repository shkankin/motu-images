// ════════════════════════════════════════════════════════════════════
// MOTU Vault — pricing-worker.js (Cloudflare Workers)
// ────────────────────────────────────────────────────────────────────
// Reference backend for the client-side pricing.js. Deploy to Cloudflare
// Workers (free tier covers a multi-thousand-figure catalog comfortably).
//
// Routes:
//   GET  /pricing/<figId>         → JSON in the shape pricing.js expects
//   GET  /health                  → "ok"
//   POST /admin/community/<figId> → write community-curated price (admin auth)
//
// Providers (configured via env.PROVIDER, see below):
//   "community" — reads from a JSON object in KV. Zero API costs. Best for
//                 starting out; you can crowdsource pricing via the admin
//                 endpoint or by editing KV directly.
//   "ebay-browse" — eBay Browse API (active listings filtered to "buy now",
//                   used as a soft proxy for current market). Requires
//                   env.EBAY_OAUTH_TOKEN.
//   "ebay-finding" — eBay Finding API with completedItems=true. Requires
//                    env.EBAY_APP_ID. Most accurate for sold prices but
//                    rate-limited (5000 calls/day on the default tier).
//   "stub" — returns deterministic mock data. Useful for development.
//
// Cache: a successful provider response is stored in KV with 24h TTL.
// Cold lookups for the same figId during that window are served from KV.
//
// Bindings expected (set up in `wrangler.toml`):
//   - kv_namespaces:
//       PRICING_CACHE   (read+write, 24h TTL)
//       COMMUNITY_PRICES (read-mostly, edited via /admin/community)
//   - vars: PROVIDER, ALLOWED_ORIGINS (comma-separated), MIN_SAMPLES
//   - secrets: EBAY_APP_ID, EBAY_OAUTH_TOKEN, ADMIN_TOKEN
//
// Wrangler config example (wrangler.toml):
//   name = "motu-vault-pricing"
//   main = "pricing-worker.js"
//   compatibility_date = "2026-01-01"
//   [[kv_namespaces]]
//   binding = "PRICING_CACHE"
//   id = "..."
//   [[kv_namespaces]]
//   binding = "COMMUNITY_PRICES"
//   id = "..."
//   [vars]
//   PROVIDER = "community"
//   ALLOWED_ORIGINS = "https://your-app.example.com"
//   MIN_SAMPLES = "3"
//
// ════════════════════════════════════════════════════════════════════

const CACHE_TTL_SECONDS = 24 * 60 * 60;
const MIN_SAMPLES_DEFAULT = 3;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/health') {
      return json({ status: 'ok', provider: env.PROVIDER || 'community' }, 200, cors);
    }

    // GET /pricing/<figId>
    const m = url.pathname.match(/^\/pricing\/([^\/]+)$/);
    if (m && request.method === 'GET') {
      const figId = decodeURIComponent(m[1]);
      if (!isValidFigId(figId)) return json({ error: 'invalid figId' }, 400, cors);
      // Optional fig metadata passed as query params to improve search accuracy.
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

    // POST /admin/community/<figId>  body: {sealed?:{avg,median,n}, loose?:{avg,median,n}, note?}
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
      // Bust the cache for this figId so the next read sees fresh data
      await env.PRICING_CACHE.delete(figId);
      return json({ ok: true, figId }, 200, cors);
    }

    return json({ error: 'not found' }, 404, cors);
  },
};

// ── Pricing dispatch ────────────────────────────────────────────────

async function getPricing(figId, env, ctx, meta = {}) {
  // 1. Cache hit
  const cached = await env.PRICING_CACHE.get(figId, { type: 'json' });
  if (cached) return cached;

  // 2. Fetch from configured provider
  const provider = env.PROVIDER || 'community';
  let result;
  switch (provider) {
    case 'community':    result = await communityProvider(figId, env); break;
    case 'ebay-finding': result = await ebayFindingProvider(figId, env, meta); break;
    case 'ebay-browse':  result = await ebayBrowseProvider(figId, env, meta); break;
    case 'stub':         result = stubProvider(figId); break;
    default: throw new Error('Unknown provider: ' + provider);
  }
  // Common shape — fill in defaults
  const minN = parseInt(env.MIN_SAMPLES || MIN_SAMPLES_DEFAULT, 10);
  const out = {
    figId,
    sealed: validateBucket(result.sealed, minN),
    loose:  validateBucket(result.loose,  minN),
    asof:   result.asof  || new Date().toISOString(),
    source: result.source || provider,
    currency: result.currency || 'USD',
    note:   result.note  || null,

  };
  // 3. Cache positive results only — don't cache empty/failed lookups long
  if (out.sealed || out.loose) {
    ctx.waitUntil(env.PRICING_CACHE.put(figId, JSON.stringify(out), { expirationTtl: CACHE_TTL_SECONDS }));
  }
  return out;
}

// ── Providers ───────────────────────────────────────────────────────

async function communityProvider(figId, env) {
  const raw = await env.COMMUNITY_PRICES.get(figId, { type: 'json' });
  if (!raw) return { sealed: null, loose: null, source: 'community' };
  return {
    sealed: raw.sealed,
    loose: raw.loose,
    asof: raw.updatedAt,
    source: 'community',
    note: raw.note,
  };
}

function stubProvider(figId) {
  // Deterministic mock — same figId always returns the same prices.
  // Useful for development before any real provider is wired up.
  let h = 0;
  for (let i = 0; i < figId.length; i++) h = (h * 31 + figId.charCodeAt(i)) >>> 0;
  const base = (h % 80) + 20;
  return {
    sealed: { avg: base * 1.4, median: base * 1.35, n: 5 + (h % 15) },
    loose:  { avg: base * 0.6, median: base * 0.55, n: 8 + (h % 20) },
    source: 'stub',
    note: 'Mock data — configure a real provider before deploying',
  };
}

// eBay Finding API — the only official API surface that returns "completed/sold" items.
// Note: requires partner approval for full Marketplace Insights access. The basic
// eBay client-credentials OAuth token — fetched fresh and cached in KV for 2h.
async function getEbayToken(env) {
  // Check KV cache first
  const cached = await env.PRICING_CACHE.get('__ebay_token__', 'json').catch(() => null);
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
  const expires = Date.now() + (data.expires_in - 300) * 1000; // 5-min buffer
  await env.PRICING_CACHE.put('__ebay_token__', JSON.stringify({ token, expires }), { expirationTtl: 7200 }).catch(() => {});
  return token;
}

// eBay Browse API with auto client-credentials OAuth.
// Uses active listings as a price proxy (completed-sold requires Marketplace Insights API,
// a paid add-on). Active Buy-It-Now prices are a reasonable real-world signal.
async function ebayFindingProvider(figId, env, meta = {}) {
  const token = await getEbayToken(env);
  const queryName = (await getQueryMapping(figId, env)) || figIdToQuery(figId, meta);
  const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?' + new URLSearchParams({
    q: queryName,
    filter: 'buyingOptions:{FIXED_PRICE}',
    limit: '50',
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
  const sealedBucket = [];
  const looseBucket  = [];
  const SEALED_RE = /\bmib\b|\bmoc\b|\bnib\b|\bsealed\b|\bunopened\b|new in (box|package)/i;
  for (const it of items) {
    const price = parseFloat(it?.price?.value);
    if (!Number.isFinite(price) || price <= 0) continue;
    const title = (it.title || '').toLowerCase();
    if (SEALED_RE.test(title)) sealedBucket.push(price);
    else looseBucket.push(price);
  }
  return {
    sealed: bucketStats(sealedBucket),
    loose:  bucketStats(looseBucket),
    source: 'ebay-browse',
    note:   `Active Buy-It-Now listings for "${queryName}"`,

  };
}

// eBay Browse API — alias kept for wrangler.toml PROVIDER=ebay-browse compatibility.
async function ebayBrowseProvider(figId, env, meta = {}) {
  return ebayFindingProvider(figId, env, meta);
}

// ── Helpers ─────────────────────────────────────────────────────────

function bucketStats(arr) {
  if (!arr.length) return null;
  // 1.5×IQR outlier filter so a single auction outlier doesn't move the avg.
  const sorted = [...arr].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const filtered = sorted.filter(v => v >= lo && v <= hi);
  if (!filtered.length) return null;
  const sum = filtered.reduce((a, b) => a + b, 0);
  const avg = sum / filtered.length;
  const median = filtered[Math.floor(filtered.length / 2)];
  return { avg: round2(avg), median: round2(median), n: filtered.length, samples: filtered.slice(0, 10).map(round2) };
}
function round2(n) { return Math.round(n * 100) / 100; }

function validateBucket(b, minN) {
  if (!b) return null;
  const avg    = Number(b.avg);
  const median = Number(b.median);
  const n      = parseInt(b.n, 10);
  if (!Number.isFinite(avg) || !Number.isFinite(median)) return null;
  if (!Number.isInteger(n) || n < minN) return null;
  return { avg: round2(avg), median: round2(median), n };
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

// Search term modifiers per line ID — narrows eBay results to the right
// toy line so e.g. "Tung Lashor" doesn't mix vintage and Origins prices.
const LINE_SEARCH_TERMS = {
  'original':       'MOTU vintage',
  'new-adventures': 'He-Man New Adventures',
  '200x':           'MOTU 200x',
  'classics':       'MOTUC Classics',
  'origins':        'MOTU Origins',
  'masterverse':    'Masterverse MOTU',
  'kids-core':      'MOTU Kids Core',
  'super7':         'Super7 MOTU',
  'mondo':          'Mondo MOTU',
  'eternia-minis':  'MOTU Minis',
};

function figIdToQuery(figId, meta = {}) {
  // Strip trailing AF411 numeric suffix, normalize hyphens to spaces.
  const name = figId.replace(/-\d{2,6}$/, '').replace(/-/g, ' ').trim();
  const lineTerm = (meta.line && LINE_SEARCH_TERMS[meta.line]) || 'Masters of the Universe';
  return name + ' ' + lineTerm;
}
function isValidFigId(s) {
  // figIds are alphanumeric + hyphens in this catalog. Reject anything else
  // to keep the KV key namespace clean and avoid traversal-style trickery.
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
