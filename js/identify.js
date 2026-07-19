// ═══════════════════════════════════════════════════════════════════
// § IDENTIFY ── Identify-by-Photo (v7.76)
// Photo → owner-deployed Cloudflare Worker (workers/identify-worker.js)
// → vision-model guess {character, lines, variant_hints} → LOCAL fuzzy
// match against S.figs → candidate list the user confirms by tap.
// Never auto-adds anything: line disambiguation (He-Man exists in 8+
// lines) and variant calls stay human decisions by design.
// Backend config mirrors pricing.js: localStorage motu-identify-backend
// = { url: string, secret?: string }. A secret keeps the endpoint
// owner-only (the worker enforces it); without one the worker's daily
// budget cap is the only spend guard.
// ═══════════════════════════════════════════════════════════════════
import { S, store, IMG, LINES, esc } from './state.js';

const BACKEND_KEY = 'motu-identify-backend';
let _backend = null;

function _loadBackend() {
  if (_backend) return _backend;
  const b = store.get(BACKEND_KEY);
  if (b && typeof b === 'object' && typeof b.url === 'string' && /^https:\/\//.test(b.url)) _backend = b;
  return _backend;
}
export function isIdentifyConfigured() { return !!_loadBackend(); }
// Mirrors pricing.js reloadBackend (v6.88 rationale): settings import
// restores the key; dropping the cache makes it work without a reload.
export function reloadIdentifyBackend() { _backend = null; return _loadBackend(); }
export function saveIdentifyBackend(url, secret) {
  url = String(url || '').trim();
  if (!/^https:\/\//.test(url)) return false;
  store.set(BACKEND_KEY, secret ? { url, secret: String(secret).trim() } : { url });
  _backend = null;
  return true;
}
export function clearIdentifyBackend() { store.set(BACKEND_KEY, null); _backend = null; }

// ── Photo → base64 (compression is best-effort; a raw file still works,
// the worker caps size server-side) ──
async function _fileToBase64(file) {
  // Downscale via canvas when available — the model needs ~768px, not 4000.
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const MAX = 768;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth || MAX, img.naturalHeight || MAX));
    const c = document.createElement('canvas');
    c.width = Math.round((img.naturalWidth || MAX) * scale);
    c.height = Math.round((img.naturalHeight || MAX) * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    const dataUrl = c.toDataURL('image/jpeg', 0.8);
    return { data: dataUrl.split(',')[1], media_type: 'image/jpeg' };
  } catch {
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error('read failed'));
      r.readAsDataURL(file);
    });
    const m = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/s);
    if (!m) throw new Error('unreadable photo');
    return { data: m[2], media_type: /^image\/(png|webp)$/.test(m[1]) ? m[1] : 'image/jpeg' };
  }
}

export async function requestIdentification(file) {
  const be = _loadBackend();
  if (!be) throw new Error('not configured');
  const { data, media_type } = await _fileToBase64(file);
  const headers = { 'content-type': 'application/json' };
  if (be.secret) headers['x-identify-secret'] = be.secret;
  const res = await fetch(be.url, { method: 'POST', headers, body: JSON.stringify({ image: data, media_type }) });
  let payload = null;
  try { payload = await res.json(); } catch { /* fall through */ }
  if (!res.ok || !payload || payload.ok !== true) {
    throw new Error((payload && payload.error) || ('backend error ' + res.status));
  }
  return payload.result;
}

// ── Local candidate matching ──
const _norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const _tokens = s => new Set(_norm(s).split(' ').filter(Boolean));

// Score a catalog figure against the model's guess. Name similarity
// dominates; line rank from the model boosts; variant hints matching the
// figure's variantName/name nudge same-character variants apart.
export function scoreFig(fig, result) {
  const charT = _tokens(result.character);
  if (!charT.size) return 0;
  const nameT = _tokens(fig.name);
  const nameN = _norm(fig.name);
  const charN = _norm(result.character);
  // Name evidence base. A full substring match of the guess is definitive
  // (covers hyphenated names: "He-Man" → "he man" appears in "he man
  // (golden armor)"). Otherwise require high token recall anchored by at
  // least one substantial (≥4-char) token — short fragments like the
  // "man" shared by He-Man/Beast Man/Ram Man are not evidence
  // (harness-caught: Beast Man surfacing for a He-Man guess via the
  // shared token + line boost).
  let score = 0;
  if (nameN.includes(charN)) score = 1;
  else {
    let inter = 0, strong = false;
    charT.forEach(t => { if (nameT.has(t)) { inter++; if (t.length >= 4) strong = true; } });
    const recall = inter / charT.size;
    if (strong && recall >= 0.8) score = 0.55 + 0.25 * recall;
  }
  // Line and variant boosts AMPLIFY name evidence — they never substitute
  // for it.
  if (score === 0) return 0;
  const li = (result.lines || []).indexOf(fig.line);
  if (li === 0) score += 0.6; else if (li === 1) score += 0.35; else if (li === 2) score += 0.2;
  const hintBlob = _norm((result.variant_hints || []).join(' '));
  const vn = _norm(fig.variantName || '');
  if (vn && hintBlob) {
    let vHit = 0;
    _tokens(vn).forEach(t => { if (hintBlob.includes(t)) vHit++; });
    if (vHit) score += 0.15 * vHit;
  }
  return score;
}

export function matchCandidates(result, figs) {
  if (!result || !Array.isArray(figs)) return [];
  return figs
    .map(fig => ({ fig, score: scoreFig(fig, result) }))
    .filter(c => c.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

// ── Sheet ──
// S._identify = undefined | {stage:'busy'} | {stage:'results', result, candidates}
//             | {stage:'error', message}
export function renderIdentifySheet() {
  const st = S._identify;
  let html = '';
  if (!isIdentifyConfigured()) {
    html += `<div class="text-sm text-dim" style="line-height:1.6;margin-bottom:12px">Identify figures from a photo using your own identification backend (a Cloudflare Worker — see <span style="color:var(--acc)">workers/identify-worker.js</span> in the repo). Enter its URL below; add the shared secret if your worker sets one.</div>`;
    html += `<input id="identifyUrl" type="text" placeholder="https://…workers.dev" autocomplete="off" style="width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--bd);background:var(--bg3);color:var(--t1);font-size:14px;margin-bottom:8px">`;
    html += `<input id="identifySecret" type="password" placeholder="Shared secret (optional)" autocomplete="off" style="width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--bd);background:var(--bg3);color:var(--t1);font-size:14px;margin-bottom:10px">`;
    html += `<button data-action="identify-save-backend" style="width:100%;padding:13px;border-radius:10px;border:1px solid var(--acc);background:color-mix(in srgb, var(--acc) 12%, transparent);color:var(--acc);font-size:14px;font-weight:600">Save Backend</button>`;
    return html;
  }
  if (!st) {
    html += `<div class="text-sm text-dim" style="line-height:1.6;margin-bottom:14px">Snap a loose figure and get the closest catalog matches to confirm. Best with one figure, decent light, plain-ish background. Carded figures are faster via the UPC scanner.</div>`;
    html += `<button data-action="identify-pick" style="width:100%;display:flex;align-items:center;justify-content:center;gap:10px;padding:16px;border-radius:12px;border:1px solid var(--acc);background:color-mix(in srgb, var(--acc) 12%, transparent);color:var(--acc);font-size:15px;font-weight:600">📷 Take / Choose Photo</button>`;
    html += `<input type="file" id="identifyCamera" accept="image/*" style="display:none" data-change-action="identify-photo">`;
    html += `<button data-action="identify-reset-backend" style="width:100%;margin-top:14px;padding:10px;border-radius:10px;border:1px solid var(--bd);background:var(--bg3);color:var(--t3);font-size:12px">Change backend…</button>`;
    return html;
  }
  if (st.stage === 'busy') {
    return `<div style="text-align:center;padding:34px 0" class="text-dim">🔎 Identifying…<div class="text-sm" style="margin-top:8px">Sending the photo to your backend.</div></div>`;
  }
  if (st.stage === 'error') {
    html += `<div class="text-sm" style="color:var(--rd);line-height:1.5;margin-bottom:12px">✗ ${esc(st.message)}</div>`;
    html += `<button data-action="identify-retry" style="width:100%;padding:13px;border-radius:10px;border:1px solid var(--bd);background:var(--bg3);color:var(--t1);font-size:14px">Try Again</button>`;
    return html;
  }
  // results
  const r = st.result || {};
  const lineName = id => (LINES.find(l => l.id === id) || {}).name || id;
  html += `<div class="text-sm" style="margin-bottom:4px">Model saw: <strong style="color:var(--t1)">${esc(r.character || 'unknown')}</strong>`;
  if ((r.lines || []).length) html += ` <span class="text-dim">· likely ${esc((r.lines || []).map(lineName).join(' / '))}</span>`;
  html += `</div>`;
  if (r.notes) html += `<div class="text-sm text-dim" style="margin-bottom:10px;line-height:1.4">${esc(r.notes)}</div>`;
  if (!st.candidates.length) {
    html += `<div class="text-sm text-dim" style="margin:12px 0;line-height:1.5">No catalog matches scored high enough. Try a clearer shot, or search "${esc(r.character || '')}" manually.</div>`;
  }
  st.candidates.forEach(c => {
    html += `<button data-action="identify-open" data-fig-id="${esc(c.fig.id)}" style="width:100%;display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:12px;border:1px solid var(--bd);background:var(--bg3);margin-bottom:8px;text-align:left;color:var(--t1)">
      <div style="width:48px;height:48px;border-radius:8px;overflow:hidden;background:var(--bg);flex-shrink:0"><img loading="lazy" src="${IMG}/${esc(c.fig.slug)}.jpg" alt="" style="width:100%;height:100%;object-fit:cover" data-error-action="img-hide"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.fig.name)}</div>
        <div class="text-sm text-dim">${esc(lineName(c.fig.line))}${c.fig.year ? ' · ' + esc(c.fig.year) : ''}</div>
      </div>
      <span style="color:var(--t3);font-size:12px">${Math.round(Math.min(c.score, 1.6) / 1.6 * 100)}%</span>
    </button>`;
  });
  html += `<button data-action="identify-retry" style="width:100%;margin-top:6px;padding:12px;border-radius:10px;border:1px solid var(--bd);background:var(--bg3);color:var(--t1);font-size:13px">Identify Another</button>`;
  return html;
}

// ── Drive (called by delegate handlers via window bridges) ──
export async function identifyFromInput(el) {
  const file = el && el.files && el.files[0];
  if (el) el.value = '';
  if (!file) return;
  S._identify = { stage: 'busy' };
  window.refreshSheetBody?.();
  try {
    const result = await requestIdentification(file);
    S._identify = { stage: 'results', result, candidates: matchCandidates(result, S.figs || []) };
  } catch (e) {
    S._identify = { stage: 'error', message: (e && e.message) || 'identification failed' };
  }
  window.refreshSheetBody?.();
}

window.identifyFromInput = identifyFromInput;
window.saveIdentifyBackend = saveIdentifyBackend;
window.clearIdentifyBackend = clearIdentifyBackend;
window.reloadIdentifyBackend = reloadIdentifyBackend;
