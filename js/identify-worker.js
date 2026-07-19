// MOTU Collector — Identify Worker
// Deploy as a Cloudflare Worker (module syntax), e.g. motu-vault-identify.
// Companion to the app's Identify-by-Photo sheet (js/identify.js, app v7.76+).
//
// Env vars (Dashboard → Settings → Variables):
//   ANTHROPIC_API_KEY   required — your Anthropic API key (Secret!)
//   IDENTIFY_SECRET     optional — if set, requests must send it in the
//                       x-identify-secret header. Set it to keep the
//                       endpoint owner-only; remove it to open to users.
//   ALLOW_ORIGIN        optional — CORS origin, default https://motucollector.app
//   MODEL               optional — default claude-haiku-4-5
//   DAILY_LIMIT         optional — max identifications/day, default 200
//   IDENTIFY_KV         optional KV binding — enables the daily budget
//                       counter. Without it the limit is best-effort
//                       per-isolate only (fine while IDENTIFY_SECRET is set).
//
// API:
//   GET  /   → { ok:true, service:'motu-identify', secured:bool }
//   POST /   → body { image: <base64, no data: prefix>, media_type, hints? }
//              → { ok:true, result:{ character, lines:[...], variant_hints:[...],
//                                     confidence, notes } }
//              errors → { ok:false, error }  with 4xx/5xx status

// The app's line ids — sent to the model so its guesses map directly onto
// the catalog. Keep in sync with LINES in js/state.js.
const LINE_IDS = ['original', 'origins', 'masterverse', 'classics', '200x',
  'new-adventures', 'super7', 'mondo', 'eternia-minis', 'motu-giants',
  'mighty-masters', 'cross-brand', 'chronicles', 'kids-core'];

const MAX_BODY = 2_500_000;          // ~2.5MB JSON body (image ≈ 1.8MB base64)
let _softCount = 0;                  // per-isolate fallback counter
let _softDay = '';

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || 'https://motucollector.app',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-identify-secret',
    'Access-Control-Max-Age': '86400',
  };
}
const json = (obj, status, env) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...cors(env) } });

async function overBudget(env) {
  const limit = parseInt(env.DAILY_LIMIT || '200', 10);
  const day = new Date().toISOString().slice(0, 10);
  if (env.IDENTIFY_KV) {
    const key = 'ident:' + day;
    const n = parseInt((await env.IDENTIFY_KV.get(key)) || '0', 10);
    if (n >= limit) return true;
    await env.IDENTIFY_KV.put(key, String(n + 1), { expirationTtl: 172800 });
    return false;
  }
  if (_softDay !== day) { _softDay = day; _softCount = 0; }
  return ++_softCount > limit;
}

const PROMPT = `You are identifying a Masters of the Universe (MOTU) action figure from a photo for a collection-tracking app.

Respond with ONLY a JSON object, no prose, no markdown fences:
{"character": "<character name, e.g. He-Man, Skeletor, Beast Man>",
 "lines": ["<most likely line id>", "<next>", ...],
 "variant_hints": ["<visible variant details: colors, armor, accessories>"],
 "confidence": <0.0-1.0 for the character identification>,
 "notes": "<one short sentence: what visual features drove the line guesses>"}

Line ids you may use, from these known toy lines: ${LINE_IDS.join(', ')}.
Key line cues: "original" = 1980s vintage (soft rubbery look, simple paint);
"origins" = 2020+ vintage-style reissues (crisper plastic, more articulation
visible at elbows/knees); "masterverse" = modern 7in highly-articulated;
"classics" = 2008-2018 adult collector 7in; "200x" = 2002 anime-styled;
"super7" = 5.5in vintage-style or ReAction flat-style; "mondo" = 1/6 scale
deluxe; "eternia-minis" = 2in stylized minis; "motu-giants" = 12in;
"new-adventures" = 1989-92 space-themed. Rank 1-3 line ids, best first.
If you cannot identify the character, use "character": "unknown" and
confidence 0.`;

async function callModel(env, image, media_type, hints) {
  const body = {
    model: env.MODEL || 'claude-haiku-4-5',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type, data: image } },
        { type: 'text', text: PROMPT + (hints ? `\nUser hints: ${String(hints).slice(0, 200)}` : '') },
      ],
    }],
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('model upstream ' + res.status);
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const clean = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);   // throws → 502 below
  return {
    character: String(parsed.character || 'unknown'),
    lines: Array.isArray(parsed.lines) ? parsed.lines.filter(l => LINE_IDS.includes(l)).slice(0, 3) : [],
    variant_hints: Array.isArray(parsed.variant_hints) ? parsed.variant_hints.slice(0, 5).map(String) : [],
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    notes: String(parsed.notes || '').slice(0, 300),
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    if (request.method === 'GET')
      return json({ ok: true, service: 'motu-identify', secured: !!env.IDENTIFY_SECRET }, 200, env);
    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405, env);

    if (env.IDENTIFY_SECRET && request.headers.get('x-identify-secret') !== env.IDENTIFY_SECRET)
      return json({ ok: false, error: 'unauthorized' }, 401, env);
    if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: 'worker not configured (no API key)' }, 500, env);

    const len = parseInt(request.headers.get('content-length') || '0', 10);
    if (len > MAX_BODY) return json({ ok: false, error: 'image too large' }, 413, env);

    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400, env); }
    const { image, media_type = 'image/jpeg', hints } = body || {};
    if (!image || typeof image !== 'string') return json({ ok: false, error: 'missing image' }, 400, env);
    if (image.length > MAX_BODY) return json({ ok: false, error: 'image too large' }, 413, env);
    if (!/^image\/(jpeg|png|webp)$/.test(media_type)) return json({ ok: false, error: 'bad media type' }, 400, env);

    if (await overBudget(env)) return json({ ok: false, error: 'daily identification budget reached' }, 429, env);

    try {
      const result = await callModel(env, image, media_type, hints);
      return json({ ok: true, result }, 200, env);
    } catch (e) {
      return json({ ok: false, error: 'identification failed: ' + (e && e.message || 'unknown') }, 502, env);
    }
  },
};
