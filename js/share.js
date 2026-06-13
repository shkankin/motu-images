// ════════════════════════════════════════════════════════════════════
// share.js — Want-List Share Link + QR + Trade List (extracted in v6.81)
// ════════════════════════════════════════════════════════════════════
// Self-contained share/want-list layer pulled out of render.js:
//   • buildShareURL / decodeShareURL — compact #wl= want-list links
//   • qrEncode (window) + renderQR — minimal byte-mode QR encoder/SVG
//   • renderShareSheet — the outgoing "Share want list" sheet body
//   • copyShareURL / nativeShare / shareTradeList (window) — share actions
//   • SHORTCUT_ACTIONS + checkShortcutAction — PWA app-icon shortcuts
//   • checkShareLink + renderWantListViewSheet — incoming shared want lists
// Cross-module data comes through explicit imports below. render() and
// openSheet() are reached via window.* (bridged in app.js / eggs.js) to
// avoid a circular import with render.js — same recipe as stats.js (v6.80).

import { S, store, ICO, icon, esc, ln, STATUS_HEX, STATUS_LABEL } from './state.js';
import { fetchFigs, figIsHidden } from './data.js';
import { pushNav } from './handlers.js';
import { toast } from './render.js';

// Local shim mirroring render.js: openSheet is owned by eggs.js (window.openSheet).
const openSheet = (...a) => window.openSheet?.(...a);
// render() is bridged onto window in app.js; reach it lazily to avoid a cycle.
const render = (...a) => window.render?.(...a);

// ─── Want-List Share Link (v4.58) ─────────────────────────────────
// Encodes wishlist figure IDs into a compact URL fragment.
// Format: <base_url>#wl=<base64url(numeric_ids joined by comma)>
// We store only the trailing numeric AF411 ID from each slug
// (e.g. "he-man-40th-anniversary-4220" → 4220) to keep the payload small.
// The receiver reconstructs figure info from their own figures.json cache.

function buildShareURL() {
  const ids = Object.entries(S.coll)
    .filter(([, c]) => c.status === 'wishlist' || c.status === 'ordered')
    .map(([id]) => id.match(/(\d+)$/)?.[1])
    .filter(Boolean);
  if (!ids.length) return null;
  const payload = btoa(ids.join(','))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const base = location.href.split('#')[0];
  return `${base}#wl=${payload}`;
}

function decodeShareURL(hash) {
  const m = hash.match(/[#&]wl=([A-Za-z0-9\-_]+)/);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    return atob(b64).split(',').map(n => n.trim()).filter(Boolean);
  } catch { return null; }
}

// Minimal QR Code encoder — byte mode, error correction level M.
// Produces a matrix (2D boolean array) from a UTF-8 string ≤ ~800 chars.
// Based on the ISO 18004 spec; covers all URL characters.
(function() {
  // Reed-Solomon GF(256) arithmetic
  const GF = (() => {
    const exp = new Uint8Array(512), log = new Uint8Array(256);
    let x = 1;
    for (let i = 0; i < 255; i++) {
      exp[i] = x; log[x] = i;
      x = x << 1; if (x > 255) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
    return {
      mul: (a, b) => a && b ? exp[log[a] + log[b]] : 0,
      poly: (ec) => {
        let g = [1];
        for (let i = 0; i < ec; i++) {
          const n = []; const root = exp[i];
          for (let j = 0; j < g.length + 1; j++)
            n[j] = (g[j] ? GF.mul(g[j], root) : 0) ^ (g[j-1] || 0);
          g = n;
        }
        return g;
      },
      rem: (data, poly) => {
        const d = [...data];
        for (let i = 0; i < poly.length - 1; i++) d.push(0);
        for (let i = 0; i < data.length; i++) {
          const c = d[i];
          if (!c) continue;
          for (let j = 1; j < poly.length; j++)
            d[i + j] ^= GF.mul(poly[j], c);
        }
        return d.slice(data.length);
      },
    };
  })();

  // Version/capacity tables (versions 1-10, EC level M)
  const VER = [
    null,
    {cap:16,  ec:10, blocks:[[1,19,16]]},
    {cap:28,  ec:16, blocks:[[1,34,28]]},
    {cap:44,  ec:26, blocks:[[1,55,44]]},
    {cap:64,  ec:18, blocks:[[2,25,16]]},
    {cap:86,  ec:24, blocks:[[2,33,24]]},
    {cap:108, ec:16, blocks:[[4,27,19]]},
    {cap:124, ec:18, blocks:[[4,29,22],[1,31,22]]},
    {cap:154, ec:22, blocks:[[2,42,33],[2,43,33]]},
    {cap:182, ec:22, blocks:[[3,39,30],[2,40,30]]},
    {cap:216, ec:26, blocks:[[4,40,24],[1,41,24]]},
  ];

  function encode(str) {
    // UTF-8 bytes
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) { bytes.push(0xC0|(c>>6)); bytes.push(0x80|(c&0x3f)); }
      else { bytes.push(0xE0|(c>>12)); bytes.push(0x80|((c>>6)&0x3f)); bytes.push(0x80|(c&0x3f)); }
    }
    // Find version
    let ver = 1;
    while (ver <= 10 && VER[ver].cap < bytes.length) ver++;
    if (ver > 10) return null; // too long
    const v = VER[ver];

    // Build data codewords
    const bits = [];
    const push = (val, len) => { for (let i = len-1; i >= 0; i--) bits.push((val>>i)&1); };
    push(0b0100, 4); push(bytes.length, 8);
    bytes.forEach(b => push(b, 8));
    push(0, 4); // terminator
    while (bits.length % 8) bits.push(0);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0; for (let j = 0; j < 8; j++) b = (b<<1)|(bits[i+j]||0); cw.push(b);
    }
    const pads = [0xEC, 0x11];
    while (cw.length < v.blocks.reduce((s,[n,,k])=>s+n*k,0)) cw.push(pads[(cw.length)%2===0?0:1]);

    // Split into blocks + compute EC
    const allBlocks = []; let idx = 0;
    v.blocks.forEach(([n, total, kk]) => {
      for (let i = 0; i < n; i++) {
        const d = cw.slice(idx, idx+kk); idx += kk;
        allBlocks.push({d, e: GF.rem(d, GF.poly(total-kk))});
      }
    });
    // Interleave
    const out = [];
    const maxD = Math.max(...allBlocks.map(b=>b.d.length));
    const maxE = allBlocks[0].e.length;
    for (let i=0;i<maxD;i++) allBlocks.forEach(b=>{if(i<b.d.length)out.push(b.d[i]);});
    for (let i=0;i<maxE;i++) allBlocks.forEach(b=>out.push(b.e[i]));

    // Place in matrix
    const size = ver*4+17;
    const mat = Array.from({length:size}, ()=>new Int8Array(size).fill(-1));
    const res = Array.from({length:size}, ()=>new Uint8Array(size));
    function setM(r,c,v,fn=false){mat[r][c]=v;if(fn||v>=0)res[r][c]=1;}

    // Finder patterns
    [[0,0],[0,size-7],[size-7,0]].forEach(([r,c])=>{
      for(let i=0;i<7;i++)for(let j=0;j<7;j++){
        setM(r+i,c+j,(i===0||i===6||j===0||j===6)?1:(i>=2&&i<=4&&j>=2&&j<=4)?1:0,true);
      }
      // Separator
      for(let i=0;i<8;i++){
        if(r+7<size&&c+i<size)setM(r+7,c+i,0,true);
        if(r+i<size&&c+7<size)setM(r+i,c+7,0,true);
        if(r>0&&r-1>=0&&c+i<size)setM(r-1,c+i,0,true);
        if(c>0&&c-1>=0&&r+i<size)setM(r+i,c-1,0,true);
      }
    });

    // Timing
    for(let i=8;i<size-8;i++){setM(6,i,i%2===0?1:0,true);setM(i,6,i%2===0?1:0,true);}

    // Alignment (ver >= 2)
    if(ver>=2){
      const ap=[6,ver<=6?18:ver<=13?22:26];
      for(let ar=0;ar<ap.length;ar++)for(let ac=0;ac<ap.length;ac++){
        const r=ap[ar],c=ap[ac];
        if(res[r][c])continue;
        for(let i=-2;i<=2;i++)for(let j=-2;j<=2;j++)
          setM(r+i,c+j,(Math.abs(i)===2||Math.abs(j)===2)?1:(i===0&&j===0)?1:0,true);
      }
    }

    // Dark module
    setM(size-8,8,1,true);

    // Format info placeholder
    for(let i=0;i<6;i++){res[8][i]=1;res[i][8]=1;}
    res[8][7]=1;res[7][8]=1;res[8][8]=1;
    for(let i=0;i<8;i++){res[8][size-1-i]=1;res[size-1-i][8]=1;}

    // Data placement
    let bitIdx=0; let up=true;
    for(let col=size-1;col>0;col-=2){
      if(col===6)col=5;
      for(let row=up?size-1:0; up?row>=0:row<size; up?row--:row++){
        for(let dc=0;dc<2;dc++){
          const c=col-dc;
          if(res[row][c])continue;
          const bit=bitIdx<out.length*8?(out[bitIdx>>3]>>(7-(bitIdx&7)))&1:0;
          mat[row][c]=bit; bitIdx++;
        }
      }
      up=!up;
    }

    // Mask pattern 0: (row+col)%2===0
    for(let r=0;r<size;r++)for(let c=0;c<size;c++)
      if(!res[r][c]&&(r+c)%2===0)mat[r][c]^=1;

    // Format string (EC=M=01, mask=0=000 → 101010000010010, XOR 101010000010010)
    const fmtBits=[1,0,1,0,1,0,0,0,0,0,1,0,0,1,0];
    for(let i=0;i<6;i++){mat[8][i]=fmtBits[i];mat[i][8]=fmtBits[i];}
    mat[8][7]=fmtBits[6];mat[7][8]=fmtBits[6];mat[8][8]=fmtBits[7];
    for(let i=0;i<8;i++){mat[8][size-1-i]=fmtBits[14-i];mat[size-1-i][8]=fmtBits[14-i];}

    return {mat,size};
  }

  window.qrEncode = encode;
})();

function renderQR(str, px=4) {
  const result = qrEncode(str);
  if (!result) return '<div class="text-sm text-dim">URL too long for QR</div>';
  const {mat, size} = result;
  const quiet = 2; // quiet zone modules
  const total = (size + quiet*2) * px;
  let svg = `<svg viewBox="0 0 ${total} ${total}" width="${total}" height="${total}" xmlns="http://www.w3.org/2000/svg" style="display:block;border-radius:8px;background:#fff;padding:${quiet*px}px">`;
  for (let r=0;r<size;r++) for(let c=0;c<size;c++)
    if (mat[r][c]===1) svg += `<rect x="${c*px}" y="${r*px}" width="${px}" height="${px}" fill="#000"/>`;
  svg += '</svg>';
  return svg;
}

function renderShareSheet() {
  const wishFigs = S.figs.filter(f => {
    const c = S.coll[f.id];
    return c && (c.status === 'wishlist' || c.status === 'ordered');
  });
  if (!wishFigs.length) {
    return `<div style="text-align:center;padding:32px 16px">
      <div style="font-size:32px;margin-bottom:12px">📋</div>
      <div style="font-size:15px;font-weight:600;color:var(--t1);margin-bottom:6px">No want list yet</div>
      <div style="font-size:13px;color:var(--t3)">Mark figures as Wishlist or Ordered to share them.</div>
    </div>`;
  }

  const url = buildShareURL();
  const qrSvg = renderQR(url, 4);
  const canShare = !!navigator.share;

  return `
    <div style="text-align:center;margin-bottom:16px">
      <div style="font-size:13px;color:var(--t2);margin-bottom:12px">${wishFigs.length} figure${wishFigs.length===1?'':'s'} on your want list</div>
      <div style="display:inline-block;padding:10px;background:#fff;border-radius:12px;margin-bottom:14px">${qrSvg}</div>
      <div style="font-size:11px;color:var(--t3);margin-bottom:14px">Scan to view want list</div>
    </div>
    <div style="background:var(--bg3);border:1px solid var(--bd);border-radius:10px;padding:10px 12px;margin-bottom:12px;display:flex;align-items:center;gap:8px">
      <div style="flex:1;font-size:11px;color:var(--t3);word-break:break-all;font-family:monospace;line-height:1.4">${esc(url)}</div>
      <button onclick="copyShareURL()" style="flex-shrink:0;padding:8px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--bg2);color:var(--acc);font-size:12px;font-weight:600">Copy</button>
    </div>
    ${canShare ? `<button onclick="nativeShare()" style="width:100%;padding:14px;border-radius:12px;border:1px solid var(--acc);background:var(--acc);color:var(--btn-t);font-size:15px;font-weight:700;margin-bottom:10px">
      ${icon(ICO.share,16)} Share…
    </button>` : ''}
    ${(() => {
      // v6.69: trade list — extra copies (×2+) and for-sale figures as a
      // shareable text block for forums/DMs. Counts shown here; the text
      // itself is built on tap (shareTradeList) so it's always current.
      let extras = 0, sale = 0;
      for (const f2 of S.figs) {
        const c2 = S.coll[f2.id];
        if (!c2) continue;
        if (c2.status === 'for-sale') sale++;
        else if (c2.status === 'owned' && Array.isArray(c2.copies) && c2.copies.length > 1) extras++;
      }
      if (!extras && !sale) return '';
      return `<div style="height:1px;background:var(--bd);margin:14px 0"></div>
      <div class="label text-upper text-dim text-xs" style="margin-bottom:8px">Trade List</div>
      <div style="font-size:12px;color:var(--t3);margin-bottom:10px">${sale ? `${sale} for sale` : ''}${sale && extras ? ' · ' : ''}${extras ? `${extras} with extra copies` : ''}</div>
      <button onclick="shareTradeList()" style="width:100%;padding:13px;border-radius:12px;border:1px solid color-mix(in srgb,var(--gold) 45%,transparent);background:var(--bg3);color:var(--gold);font-size:14px;font-weight:600">
        ${icon(ICO.export,15)} ${navigator.share ? 'Share' : 'Copy'} trade list as text
      </button>`;
    })()}
    <div style="margin-top:14px">
      <div class="label text-upper text-dim text-xs" style="margin-bottom:8px">On your list</div>
      ${wishFigs.slice(0,8).map(f => {
        const c = S.coll[f.id];
        const color = STATUS_HEX[c.status];
        return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid color-mix(in srgb,var(--bd) 40%,transparent)">
          <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div>
          <div style="font-size:13px;color:var(--t1);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</div>
          <div style="font-size:11px;color:var(--t3)">${STATUS_LABEL[c.status]}</div>
        </div>`;
      }).join('')}
      ${wishFigs.length > 8 ? `<div style="font-size:12px;color:var(--t3);padding:8px 0">+${wishFigs.length-8} more</div>` : ''}
    </div>`;
}

window.copyShareURL = () => {
  const url = buildShareURL();
  if (!url) return;
  // v6.30: navigator.clipboard is undefined on insecure (http://) origins
  // and inside some embedded webviews. Guard the access so we don't throw
  // a TypeError before reaching the fallback path.
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('✓ Link copied'); } catch { toast('✗ Copy failed — long-press the URL to copy'); }
    ta.remove();
  };
  if (!navigator.clipboard?.writeText) { fallback(); return; }
  navigator.clipboard.writeText(url).then(
    () => toast('✓ Link copied'),
    fallback,
  );
};

window.nativeShare = () => {
  const url = buildShareURL();
  if (!url || !navigator.share) return;
  navigator.share({ title: 'MOTU Collector — Want List', url })
    .catch(() => {});
};

// ─── Want-List View (incoming share link) ─────────────────────────
// Reads #wl= fragment on load and shows a read-only list.
// v5.00: PWA app-icon shortcuts. The manifest.json declares shortcuts that
// long-pressing the installed PWA icon exposes as quick actions; each links
// back to the app with ?action=<key>. We dispatch on that key here once
// figures are loaded. Action runs once then the URL is cleaned so a refresh
// doesn't re-trigger.
const SHORTCUT_ACTIONS = {
  'share-wantlist': () => openSheet('share'),
  'stats':          () => openSheet('stats'),
  'sync':           () => fetchFigs(true),
  'menu':           () => openSheet('menu'),
};
function checkShortcutAction() {
  const params = new URLSearchParams(location.search);
  const action = params.get('action');
  if (!action || !SHORTCUT_ACTIONS[action]) return;
  // Wait for figures to land for actions that need them.
  let _retries = 0;
  function run() {
    if (!S.figs.length && action !== 'sync') {
      if (++_retries > 100) return;
      setTimeout(run, 150);
      return;
    }
    try { SHORTCUT_ACTIONS[action](); } catch {}
    // Clean the URL so reload doesn't re-fire the action.
    if (history.replaceState) {
      params.delete('action');
      const q = params.toString();
      history.replaceState({}, '', location.pathname + (q ? '?' + q : '') + location.hash);
    }
  }
  run();
}

function checkShareLink() {
  const nums = decodeShareURL(location.hash);
  if (!nums || !nums.length) return;
  // Wait for figs to be loaded (may be called before/after figures.json)
  let _retries = 0;
  function show() {
    if (!S.figs.length) {
      if (++_retries > 150) { toast('✗ Could not load want list'); return; }
      setTimeout(show, 200); return;
    }
    // Build a numeric suffix → figId map
    const byNum = new Map();
    S.figs.forEach(f => { const m = f.id.match(/(\d+)$/); if(m) byNum.set(m[1], f); });
    const figs = nums.map(n => byNum.get(n)).filter(Boolean);
    if (!figs.length) return;
    // v6.31: record this view in the user's wishlist history so they can
    // revisit it from Settings later. Re-opening the same link bumps the
    // timestamp instead of duplicating.
    try { window.recordWishlistView?.(nums, figs); } catch {}
    S.sheet = 'wantListView';
    S._sharedWantList = figs;
    pushNav();
    render();
  }
  show();
}

// ── v6.69: trade list text builder ──────────────────────────────────
// "FOR SALE" = for-sale figures (with per-copy asking when set);
// "EXTRAS / FOR TRADE" = owned figures with 2+ copies (the spares).
// Shared via native sheet where available, else copied to clipboard.
window.shareTradeList = async () => {
  const saleLines = [], extraLines = [];
  const sorted = [...S.figs].sort((a, b) => a.name.localeCompare(b.name));
  for (const f of sorted) {
    const c = S.coll[f.id];
    if (!c || figIsHidden(f)) continue;
    if (c.status === 'for-sale' && Array.isArray(c.copies)) {
      for (const cp of c.copies) {
        const bits = [cp.condition, cp.variant].filter(Boolean).join(', ');
        const ask = parseFloat(cp.asking);
        saleLines.push(`• ${f.name} (${ln(f.line)})${bits ? ` — ${bits}` : ''}${Number.isFinite(ask) ? ` — $${ask.toFixed(2)}` : ''}`);
      }
    } else if (c.status === 'owned' && Array.isArray(c.copies) && c.copies.length > 1) {
      const spare = c.copies.length - 1;
      extraLines.push(`• ${f.name} (${ln(f.line)}) — ${spare} spare cop${spare === 1 ? 'y' : 'ies'}`);
    }
  }
  if (!saleLines.length && !extraLines.length) { toast('Nothing to trade yet'); return; }
  let text = `MY TRADE LIST — ${new Date().toLocaleDateString()}\n`;
  if (saleLines.length) text += `\nFOR SALE (${saleLines.length}):\n${saleLines.join('\n')}\n`;
  if (extraLines.length) text += `\nEXTRAS / FOR TRADE (${extraLines.length}):\n${extraLines.join('\n')}\n`;
  text += `\n— via MOTU Collector`;
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('✓ Trade list copied');
  } catch {
    toast('✗ Could not copy — clipboard unavailable');
  }
};

function renderWantListViewSheet() {
  const figs = S._sharedWantList || [];
  if (!figs.length) return '<div class="text-sm text-dim">Empty want list.</div>';
  const scrollHint = figs.length > 4 ? '<div style="font-size:11px;color:var(--t3);text-align:center;margin-bottom:8px">↕ Scroll to see all</div>' : '';
  let h = `<div style="font-size:13px;color:var(--t2);margin-bottom:6px">${figs.length} figure${figs.length===1?'':'s'} wanted</div>${scrollHint}`;
  // v6.26: only allow http(s) and data: image URLs. Custom figures can carry
  // user-controlled image fields, so reject anything else (javascript:, etc.)
  // and HTML-escape what we keep so it can't break out of the src attribute.
  const safeImgSrc = (u) => {
    const s = String(u || '');
    return /^(https?:|data:image\/)/i.test(s) ? esc(s) : '';
  };
  figs.forEach(f => {
    const entry = S.coll[f.id];
    const owned = entry?.status === 'owned' || entry?.status === 'for-sale';
    const imgSrc = safeImgSrc(f.image);
    h += `<div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg3);border:1px solid ${owned?'var(--gn)':'var(--bd)'};border-radius:10px;margin-bottom:8px">
      ${imgSrc ? `<img src="${imgSrc}" alt="" onerror="this.style.display='none'" style="width:40px;height:40px;object-fit:cover;border-radius:6px;flex-shrink:0;background:var(--bd)">` : `<div style="width:40px;height:40px;border-radius:6px;flex-shrink:0;background:var(--bd)"></div>`}
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</div>
        <div style="font-size:11px;color:var(--t3)">${esc([f.line, f.wave].filter(Boolean).join(' · '))}</div>
      </div>
      ${owned ? `<div style="font-size:11px;font-weight:700;color:var(--gn)">✓ You own it</div>` : ''}
    </div>`;
  });
  return h;
}

// v6.31: window mirror so delegated handlers (delegate-handlers.js) can
// call checkShareLink without an import cycle. (Moved here from render.js
// in v6.81 along with the rest of the share layer.)
window.checkShareLink = checkShareLink;

export {
  buildShareURL, decodeShareURL, renderQR, renderShareSheet,
  renderWantListViewSheet, checkShareLink, checkShortcutAction,
  SHORTCUT_ACTIONS,
};
