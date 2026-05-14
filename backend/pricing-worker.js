// ════════════════════════════════════════════════════════════════════
// MOTU Vault — pricing-worker.js (Cloudflare Workers) — v6.60
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
      const fresh = body.fresh === true;
      const results = await Promise.all(
        ids.map(id => getPricing(id, env, ctx, meta, { fresh }).catch(e => ({
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
      // v6.59: ?fresh=1 bypasses the worker KV cache so the in-app refresh
      // button can re-query eBay through the new filters without manual KV deletes.
      const fresh = url.searchParams.get('fresh') === '1';
      // v6.60: ?debug=1 returns up to 8 sample rejected titles per bucket so
      // we can see exactly what the filters caught.
      if (url.searchParams.get('debug') === '1') meta._debug = true;
      try {
        const data = await getPricing(figId, env, ctx, meta, { fresh });
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

async function getPricing(figId, env, ctx, meta = {}, opts = {}) {
  // 1. Cache (skipped when opts.fresh — used by the in-app Refresh button via ?fresh=1)
  if (!opts.fresh) {
    const cached = await env.PRICING_CACHE.get(figId, { type: 'json' });
    if (cached) return cached;
  }

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
        // v6.60-fix2: don't cache debug responses, and strip the _debug field
        // before write so a non-debug call later doesn't get a debug-shaped
        // hit (defensive — debug responses aren't supposed to be cached at all).
        if (!meta._debug) {
          const { _debug, ...cacheable } = out;
          ctx.waitUntil(env.PRICING_CACHE.put(figId, JSON.stringify(cacheable), { expirationTtl: CACHE_TTL_SECONDS }));
        }
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

  const out = {
    figId,
    sealed,
    loose,
    asof:     raw?.asof || new Date().toISOString(),
    source:   raw?.source || providerName,
    currency: raw?.currency || 'USD',
    note,
  };
  // v6.60-fix2: pass _debug through when present so ?debug=1 actually works.
  if (raw?._debug) out._debug = raw._debug;
  return out;
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
  // v6.60-fix4: expanded with real-world phrasings seen in eBay listings:
  // mosc (Mint On Sealed Card), still sealed, in (the) package, in (the) box,
  // in (the) card, never opened, complete in card. Origins MOC listings often
  // use these instead of bare MOC/MIB.
  const SEALED_RE = /\b(mib|moc|mosc|nib|nip|sealed|unopened|never opened|new in (?:box|package|card)|brand new in (?:box|package)|mint in (?:box|package|card)|in (?:the )?(?:box|package|card)|complete in card|carded|factory sealed|still sealed)\b/i;

  // v6.60-fix4: loose markers — explicit signals that a listing is NOT sealed.
  // Used to break the tie when a title has neither a sealed marker nor a loose
  // marker. For Origins specifically, untagged listings are far more likely to
  // be MOC than loose, so we default ambiguous-but-line-tagged to sealed.
  const LOOSE_RE = /\b(loose|opened|out of (?:box|package)|complete loose|no (?:box|package|card)|figure only|displayed|used|preowned|pre-owned|played with)\b/i;

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
  // v6.59: line REQUIRED — title must explicitly mention the line. Unlabeled
  // ambiguous listings are tossed rather than guessed. Far less contamination,
  // smaller but more honest samples.
  const lineRequired = LINE_REQUIRED_TERMS[meta.line];
  // v6.60: collect a few rejected titles for diagnostics so we can tune the
  // filters against real eBay traffic. Only kept when meta._debug truthy.
  const debug = !!meta._debug;
  const dbg = { junk: [], line: [], ambig: [] };

  const sealed = [], loose = [];
  let rejJunk = 0, rejLine = 0, rejAmbig = 0;
  // v6.60-fix4: capture a few kept titles per bucket so we can see what's
  // actually being classified as sealed vs loose. Until now the debug only
  // showed rejected items, but the loose bucket's $99 high suggested
  // sealed-but-untagged listings were leaking into loose.
  const keptSealed = [], keptLoose = [];
  // For Origins (and other modern carded lines), untagged listings default to
  // sealed since modern figures are mostly sold MOC. For vintage, the opposite.
  const isModernLine = ['origins', 'masterverse', 'classics', 'super7', 'mondo', 'kids-core', 'eternia-minis'].includes(meta.line);
  for (const it of items) {
    const price = parseFloat(it?.price?.value);
    const rawTitle = it?.title || '';
    if (!Number.isFinite(price) || price < 5) {
      rejJunk++; if (debug && dbg.junk.length < 8) dbg.junk.push(`$${price} ${rawTitle.slice(0, 80)}`);
      continue;
    }
    const title = rawTitle.toLowerCase();
    if (JUNK_RE.test(title)) { rejJunk++; if (debug && dbg.junk.length < 8) dbg.junk.push(rawTitle.slice(0, 80)); continue; }
    // v6.60-fix3: check REQUIRED first, then NEGATIVE. Previous order let the
    // negative filter kill reissue listings that mentioned both their line
    // AND the original vintage year ("Tung Lashor 1985 character — 2023
    // Origins MOC"). Now: if the title positively names the line, accept it.
    // Only listings missing the line keyword get tested for off-line signals.
    const hasRequired = !lineRequired || lineRequired.test(title);
    if (hasRequired) {
      const hasSealed = SEALED_RE.test(title);
      const hasLoose  = LOOSE_RE.test(title);
      let bucket;
      if (hasSealed && !hasLoose) bucket = 'sealed';
      else if (hasLoose && !hasSealed) bucket = 'loose';
      else if (hasSealed && hasLoose) bucket = 'loose';  // "loose figure, no box" + "MOC" mention → loose wins
      else bucket = isModernLine ? 'sealed' : 'loose';   // ambiguous: default by era
      if (bucket === 'sealed') { sealed.push(price); if (debug && keptSealed.length < 8) keptSealed.push(`$${price} ${rawTitle.slice(0, 70)}`); }
      else                     { loose.push(price);  if (debug && keptLoose.length  < 8) keptLoose.push(`$${price} ${rawTitle.slice(0, 70)}`); }
      continue;
    }
    // No line keyword — try negative filter to distinguish "probably wrong line"
    // (kill it) from "ambiguous/unlabeled" (kill it but for different reason).
    if (lineNegative && lineNegative.test(title)) { rejLine++; if (debug && dbg.line.length < 8) dbg.line.push(rawTitle.slice(0, 80)); continue; }
    rejAmbig++; if (debug && dbg.ambig.length < 8) dbg.ambig.push(rawTitle.slice(0, 80));
  }
  const filterParts = [];
  if (rejJunk)  filterParts.push(`${rejJunk} junk`);
  if (rejLine)  filterParts.push(`${rejLine} off-line`);
  if (rejAmbig) filterParts.push(`${rejAmbig} unlabeled`);
  const out = {
    sealed: bucketStats(sealed),
    loose:  bucketStats(loose),
    source: 'ebay-active',
    note:   `Active listings (asking prices) for "${queryName}" — not sold prices${filterParts.length ? ` · filtered ${filterParts.join(', ')}` : ''}`,
  };
  if (debug) out._debug = { query: queryName, total: items.length, kept: sealed.length + loose.length, rejected: dbg, keptSealed, keptLoose };
  return out;
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
// v6.60-fix3: Restored vintage/198[0-9]/filmation markers — now safe because
// the filter order changed (required check runs first). Reissue listings that
// contain "origins" or "retro play" are accepted regardless of what else they
// say. Only listings missing the line keyword reach this negative filter, so
// flagging "vintage" and "1985" here correctly catches vintage listings that
// snuck through ambiguity.
const LINE_NEGATIVE_TERMS = {
  'origins':        /\b(vintage|vtg|198[0-9]|199[0-9]|1980s?|1990s?|filmation|motuc|classics|masterverse|super ?7|club grayskull|mondo|200x toy line|new adventures of he[- ]?man)\b/i,
  'classics':       /\b(vintage|vtg|198[0-9]|1980s?|filmation|origins|masterverse|super ?7|mondo|200x|new adventures|kids[- ]?core)\b/i,
  'masterverse':    /\b(vintage|vtg|198[0-9]|1980s?|filmation|origins|motuc|classics|super ?7|mondo|200x|new adventures|kids[- ]?core)\b/i,
  'original':       /\b(origins|motuc|classics|masterverse|super ?7|mondo|200x|kids[- ]?core|movie 2025|2023 reissue|retro play)\b/i,
  '200x':           /\b(vintage|vtg|198[0-9]|1980s?|filmation|origins|motuc|classics|masterverse|super ?7|mondo|new adventures|kids[- ]?core)\b/i,
  'new-adventures': /\b(vintage|vtg|198[0-9]|1980s?|filmation|origins|motuc|classics|masterverse|super ?7|mondo|200x|kids[- ]?core)\b/i,
  'super7':         /\b(vintage|vtg|198[0-9]|1980s?|origins|motuc|classics|masterverse|mondo|200x|new adventures|kids[- ]?core)\b/i,
  'mondo':          /\b(vintage|vtg|198[0-9]|1980s?|origins|motuc|classics|masterverse|super ?7|200x|new adventures|kids[- ]?core)\b/i,
  'kids-core':      /\b(vintage|vtg|198[0-9]|1980s?|origins|motuc|classics|masterverse|super ?7|mondo|200x|new adventures)\b/i,
  'eternia-minis':  /\b(vintage|vtg|198[0-9]|1980s?|origins|motuc|classics|masterverse|super ?7|mondo|200x)\b/i,
};

// v6.59: per-line REQUIRED title regex — listing must match at least one of
// these to count. Listings that don't mention any line keyword are ambiguous
// wildcards and historically polluted the buckets (an unlabeled "Tung Lashor
// MOC" listing could be vintage at $300 or Origins at $30). Better to be
// strict and discard than guess wrong. Multiple acceptable phrasings per
// line — "new adventures of he-man" or "he-man new adventures" both match;
// "kids core" or "kids-core" or bare "core" all match; etc.
// v6.60-fix3: Origins also accepts "retro play" — Mattel's actual carded
// marketing phrase. Lots of Origins listings use it instead of "origins".
const LINE_REQUIRED_TERMS = {
  'origins':        /\b(origins|retro play)\b/i,
  'classics':       /\b(classics|motuc)\b/i,
  'masterverse':    /\b(masterverse|masters ?verse)\b/i,
  'original':       /\b(vintage|198[0-9]|199[0-9]|1980s?|1990s?|filmation|original)\b/i,
  '200x':           /\b(200x|2002|mike young|mya|modern series)\b/i,
  'new-adventures': /\b(new adventures|nahm|new[- ]?adv|na he[- ]?man)\b/i,
  'super7':         /\b(super ?7|club grayskull|filmation collection)\b/i,
  'mondo':          /\b(mondo)\b/i,
  'kids-core':      /\b(kids[- ]?core|core power|core(?:[- ]eternia)?)\b/i,
  'eternia-minis':  /\b(minis?|eternia minis|micro)\b/i,
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
