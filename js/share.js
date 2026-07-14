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

import { S, store, ICO, icon, esc, ln, IMG, STATUS_HEX, STATUS_LABEL } from './state.js';
import { fetchFigs, figIsHidden } from './data.js';
import { pushNav } from './handlers.js';
import { toast } from './render.js';

// Local shim mirroring render.js: openSheet is owned by eggs.js (window.openSheet).
const openSheet = (...a) => window.openSheet?.(...a);
// render() is bridged onto window in app.js; reach it lazily to avoid a cycle.
const render = (...a) => window.render?.(...a);

// ─── Want-List Share Link (v4.58, v7.33: opens desktop.html, v7.35: fixes,
//      v7.36: compact binary encoding, v7.37: shorter manual-figure tokens) ─
// v7.37: manually-added figures were still encoding their FULL descriptive
// suffix (e.g. "jungle-he-man-he-man-guerrero-mp0e83ff", ~38 chars) — for
// a wishlist with many manual figures this dominated the link length and
// made the v7.36 improvement much smaller than it should've been (14%
// instead of the ~35-55% typical elsewhere). Checked the real catalog:
// just the segment after the LAST hyphen (e.g. "mp0e83ff", ≤8 chars) is
// already unique across all 107 manually-added figures on its own — the
// descriptive name prefix was never actually needed for uniqueness.
// Manual figures now encode only that trailing segment.
function buildShareURL() {
  // v7.41: trailing digits are no longer assumed unique for catalog
  // figures — a real collision now exists (two kids-core sets both end in
  // 13924), the exact silent-substitution failure v7.35 fixed for manual
  // figures. Any figure whose trailing number is shared by another
  // catalog figure is encoded as a string token (existing 0x01 type)
  // carrying its FULL id, which the decoder resolves exactly. Costs
  // length only for the colliding figures (currently 2 in the catalog);
  // everything else keeps the 3-byte numeric form. Old links and old
  // decoders are unaffected — no new type byte.
  const numCount = new Map();
  for (const f of S.figs) {
    if (!f.id || f.id.startsWith('manual-')) continue;
    const m = f.id.match(/(\d+)$/);
    if (m) numCount.set(m[1], (numCount.get(m[1]) || 0) + 1);
  }
  const entries = Object.entries(S.coll)
    .filter(([, c]) => c.status === 'wishlist')
    .map(([id]) => {
      if (id.startsWith('manual-')) {
        const suffix = id.slice('manual-'.length);
        const code = suffix.includes('-') ? suffix.slice(suffix.lastIndexOf('-') + 1) : suffix;
        return { manual: true, suffix: code, id };
      }
      const m = id.match(/(\d+)$/);
      if (!m) return null;
      if ((numCount.get(m[1]) || 0) > 1) return { manual: true, suffix: id, id };  // ambiguous → full id
      return { manual: false, num: parseInt(m[1], 10), id };
    })
    .filter(Boolean);
  if (!entries.length) return null;

  // v7.58: optional per-figure extras, emitted AFTER the figure's token —
  // 0x02 = note (len + utf8, notes trimmed to 120 chars), 0x03 = target
  // price (2 bytes, whole dollars). Off by default and gated behind the
  // share sheet's "Include notes & target prices" toggle
  // (motu-share-extras): notes are private annotations and shouldn't leak
  // into a link by surprise. Both deployed decoders ship in the same
  // release, and links are always minted fresh, so no compatibility
  // window exists; old links simply contain no 0x02/0x03 tokens.
  const extras = !!store.get('motu-share-extras');
  const coll = S.coll;
  const bytes = [0xFE];
  const enc = new TextEncoder();
  for (const e of entries) {
    if (e.manual) {
      const strBytes = enc.encode(e.suffix);
      if (strBytes.length > 255) continue;  // pathological; skip rather than corrupt the stream
      bytes.push(0x01, strBytes.length, ...strBytes);
    } else if (e.num <= 0xFFFF) {
      bytes.push(0x00, (e.num >> 8) & 0xFF, e.num & 0xFF);
    } else { continue; }
    if (extras && e.id) {
      const c = coll[e.id];
      const note = String(c?.copies?.[0]?.notes || '').trim().slice(0, 120);
      if (note) {
        const nb = enc.encode(note);
        if (nb.length <= 255) bytes.push(0x02, nb.length, ...nb);
      }
      const tp = Math.round(parseFloat(c?.targetPrice));
      if (Number.isFinite(tp) && tp > 0 && tp <= 0xFFFF) bytes.push(0x03, (tp >> 8) & 0xFF, tp & 0xFF);
    }
    // ids over 65535 silently skipped — none exist in the catalog today
    // (max ~14,000); the old text format is still readable as a fallback
    // if that ever changes before this format is revisited.
  }
  const binStr = bytes.map(b => String.fromCharCode(b)).join('');
  const payload = btoa(binStr)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Swap whatever page this was generated from (normally motu-vault.html)
  // for its sibling desktop.html — same directory, just a different file.
  const base = location.href.split('#')[0].replace(/[^/]*$/, '') + 'desktop.html';
  return `${base}#wl=${payload}`;
}

function decodeShareURL(hash) {
  const m = hash.match(/[#&]wl=([A-Za-z0-9\-_]+)/);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    // v7.36: binary format marker. The old text format's decoded string
    // only ever starts with a digit ('0'-'9', code 48-57) or 'm' (code
    // 109) — 0xFE (254) can never collide with that, so it safely tells
    // the two formats apart. Old-format links already sent out before
    // this change still decode correctly via the fallback below.
    if (bin.charCodeAt(0) === 0xFE) {
      // v7.58: items are now objects { t, note?, price? }. 0x02 (note) and
      // 0x03 (target price, whole dollars) attach to the most recent
      // figure token. Links without extras decode to items with just t.
      const items = [];
      let i = 1;
      const readStr = () => {
        if (i + 1 > bin.length) return null;
        const len = bin.charCodeAt(i++);
        if (i + len > bin.length) return null;
        const strBytes = new Uint8Array(len);
        for (let j = 0; j < len; j++) strBytes[j] = bin.charCodeAt(i + j);
        i += len;
        return new TextDecoder().decode(strBytes);
      };
      while (i < bin.length) {
        const type = bin.charCodeAt(i++);
        if (type === 0x00) {
          if (i + 2 > bin.length) break;
          const num = (bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1);
          i += 2;
          items.push({ t: String(num) });
        } else if (type === 0x01) {
          const s = readStr();
          if (s === null) break;
          items.push({ t: 'm:' + s });
        } else if (type === 0x02) {
          const s = readStr();
          if (s === null) break;
          if (items.length) items[items.length - 1].note = s;
        } else if (type === 0x03) {
          if (i + 2 > bin.length) break;
          const p = (bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1);
          i += 2;
          if (items.length) items[items.length - 1].price = p;
        } else {
          break;  // unrecognized type byte — stop rather than misread the rest
        }
      }
      return items;
    }
    return bin.split(',').map(n => n.trim()).filter(Boolean).map(t => ({ t }));
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
  const result = window.qrEncode(str);   // v7.51: explicit window. (see data.js handleCSV note)
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
    ${(() => {
      // v7.58: notes & target prices are OPT-IN — notes are private
      // annotations and must not leak into a link by surprise. The toggle
      // persists (motu-share-extras); flipping it re-renders this sheet,
      // which re-mints the URL and QR above with/without 0x02/0x03 tokens.
      const on = !!store.get('motu-share-extras');
      let carrying = 0;
      for (const f2 of wishFigs) {
        const c2 = S.coll[f2.id];
        if (String(c2?.copies?.[0]?.notes || '').trim() || (parseFloat(c2?.targetPrice) > 0)) carrying++;
      }
      if (!carrying) return '';
      return `<button data-action="toggle-share-extras" style="width:100%;display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:10px;border:1px solid ${on ? 'var(--acc)' : 'var(--bd)'};background:var(--bg3);margin-bottom:12px;text-align:left">
        <div style="width:18px;height:18px;border-radius:5px;border:2px solid ${on ? 'var(--acc)' : 'var(--bd)'};background:${on ? 'var(--acc)' : 'transparent'};color:var(--btn-t);font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">${on ? '✓' : ''}</div>
        <div style="flex:1"><div style="font-size:13px;color:var(--t1)">Include notes & target prices</div>
        <div style="font-size:11px;color:var(--t3)">${carrying} figure${carrying === 1 ? ' has' : 's have'} them · makes the link longer</div></div>
      </button>`;
    })()}
    <div style="background:var(--bg3);border:1px solid var(--bd);border-radius:10px;padding:10px 12px;margin-bottom:12px;display:flex;align-items:center;gap:8px">
      <div style="flex:1;font-size:11px;color:var(--t3);word-break:break-all;font-family:monospace;line-height:1.4">${esc(url)}</div>
      <button data-action="copy-share-url" style="flex-shrink:0;padding:8px 12px;border-radius:8px;border:1px solid var(--bd);background:var(--bg2);color:var(--acc);font-size:12px;font-weight:600">Copy</button>
    </div>
    ${canShare ? `<button data-action="native-share" style="width:100%;padding:14px;border-radius:12px;border:1px solid var(--acc);background:var(--acc);color:var(--btn-t);font-size:15px;font-weight:700;margin-bottom:10px">
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
      <button data-action="share-trade-list" style="width:100%;padding:13px;border-radius:12px;border:1px solid color-mix(in srgb,var(--gold) 45%,transparent);background:var(--bg3);color:var(--gold);font-size:14px;font-weight:600">
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
  const tokens = decodeShareURL(location.hash);
  if (!tokens || !tokens.length) return;
  // Wait for figs to be loaded (may be called before/after figures.json)
  let _retries = 0;
  function show() {
    if (!S.figs.length) {
      if (++_retries > 150) { toast('✗ Could not load want list'); return; }
      setTimeout(show, 200); return;
    }
    // v7.35: two lookup maps — bare numeric tokens match a catalog
    // figure's trailing AF411 id; 'm:' tokens match a manually-added
    // figure's trailing unique code (see buildShareURL's note on why
    // that used to silently collide).
    // v7.41: trailing numbers turned out NOT to be unique by construction
    // after all (real collision: 13924, two kids-core sets). New links
    // encode ambiguous figures by full id inside the same string-token
    // type, so 'm:' resolution now tries the manual map first, then a
    // full-id map. Old links with an ambiguous bare number can't be
    // disambiguated — first catalog match wins, as before.
    const byNum = new Map(), byManual = new Map(), byFullId = new Map();
    S.figs.forEach(f => {
      if (!f.id) return;
      byFullId.set(f.id, f);
      if (f.id.startsWith('manual-')) {
        const suffix = f.id.slice('manual-'.length);
        const code = suffix.includes('-') ? suffix.slice(suffix.lastIndexOf('-') + 1) : suffix;
        byManual.set(code, f);
      }
      else { const m = f.id.match(/(\d+)$/); if (m && !byNum.has(m[1])) byNum.set(m[1], f); }
    });
    // v7.58: tokens are item objects { t, note?, price? }; the shared list
    // is now [{ fig, note, price }] so the view can show the sender's note
    // and target price. recordWishlistView keeps its old (tokens, figs)
    // string/figure shapes.
    const items = tokens
      .map(it => {
        const t = it.t;
        const fig = t.startsWith('m:') ? (byManual.get(t.slice(2)) || byFullId.get(t.slice(2))) : byNum.get(t);
        return fig ? { fig, note: it.note, price: it.price } : null;
      })
      .filter(Boolean);
    if (!items.length) return;
    try { window.recordWishlistView?.(tokens.map(it => it.t), items.map(it => it.fig)); } catch {}
    S.sheet = 'wantListView';
    S._sharedWantList = items;
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

// v7.58: local-only "found it" checklist for the recipient — someone
// working a shared list at a convention or across stores ticks items off
// as they find them. Keyed by a prefix of the link payload so different
// shared lists keep separate checklists; stored locally, never sent
// anywhere, invisible to the sender.
function _sharedFoundKey() {
  const m = location.hash.match(/[#&]wl=([A-Za-z0-9\-_]+)/);
  return m ? 'wl:' + m[1].slice(0, 24) : 'wl:current';
}
function _sharedFound() {
  const all = store.get('motu-shared-found') || {};
  return new Set(all[_sharedFoundKey()] || []);
}
// v7.59: full-size image overlay for the shared view. Built via DOM (the
// app page's CSP forbids inline scripts; delegated data-action + this
// window fn is the house pattern). Tap anywhere to dismiss.
window.sharedImgZoom = src => {
  if (!src) return;
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(6,3,12,0.92);z-index:9999;display:grid;place-items:center;cursor:zoom-out';
  const img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'max-width:94vw;max-height:90vh;border-radius:12px';
  ov.appendChild(img);
  ov.addEventListener('click', () => ov.remove());
  document.body.appendChild(ov);
};

window.toggleSharedFound = figId => {
  const all = store.get('motu-shared-found') || {};
  const key = _sharedFoundKey();
  const set = new Set(all[key] || []);
  set.has(figId) ? set.delete(figId) : set.add(figId);
  all[key] = [...set];
  // keep the store tidy: cap at 20 remembered lists, oldest-ish out
  const keys = Object.keys(all);
  if (keys.length > 20) delete all[keys[0]];
  store.set('motu-shared-found', all);
  // v7.60: refresh the sheet body IN PLACE (scroll preserved). A full
  // render() rebuilt the entire app behind the overlay — visible flash
  // of the app "in the background" — and replaced the sheet, resetting
  // scroll to the top on every tap. User-reported, and fair.
  window.refreshSheetBody ? window.refreshSheetBody() : render();
};

function renderWantListViewSheet() {
  const items = (S._sharedWantList || []).map(x => x.fig ? x : { fig: x });  // tolerate legacy shape
  const figs = items.map(x => x.fig);
  if (!figs.length) return '<div class="text-sm text-dim">Empty want list.</div>';
  const found = _sharedFound();
  const scrollHint = figs.length > 4 ? '<div style="font-size:11px;color:var(--t3);text-align:center;margin-bottom:8px">↕ Scroll to see all</div>' : '';
  let h = `<div style="font-size:13px;color:var(--t2);margin-bottom:6px">${figs.length} figure${figs.length===1?'':'s'} wanted</div>`;
  // v7.57: scan-to-verify for the person HOLDING the list. Collectors are
  // exact about releases (an Origins He-Man ≠ a Masterverse He-Man); the
  // recipient often isn't a collector at all. In a store, they can point
  // the scanner at a box and get a plain verdict: on the list, or not
  // (and if not, what it actually is). Uses the same BarcodeDetector
  // scanner as the app's search; S._scanVerifyIds switches its verdict
  // to list-membership. Feature-gated: no BarcodeDetector → a quiet hint
  // instead of a dead button. UPCs are printed per figure below too, so
  // even without the scanner the number on the box can be eyeballed.
  const scannable = figs.filter(f => f.upc).length;
  if ('BarcodeDetector' in window && scannable) {
    h += `<button data-action="shared-scan-verify" style="width:100%;padding:12px;border-radius:12px;border:1px solid var(--acc);background:var(--bg3);color:var(--acc);font-size:14px;font-weight:700;margin-bottom:6px">${icon(ICO.camera || ICO.search, 15)} Scan a barcode to verify</button>
    <div style="font-size:11px;color:var(--t3);text-align:center;margin-bottom:10px">${scannable} of ${figs.length} on this list can be verified by barcode</div>`;
  } else if (scannable) {
    h += `<div style="font-size:11px;color:var(--t3);text-align:center;margin-bottom:10px">Tip: barcode numbers are shown below — compare against the box. (Scanning needs Chrome on Android.)</div>`;
  }
  if (found.size) h += `<div style="font-size:12px;color:var(--gn);text-align:center;margin-bottom:8px">✓ ${found.size} of ${figs.length} found</div>`;
  h += scrollHint;
  // v6.26: only allow http(s) and data: image URLs. Custom figures can carry
  // user-controlled image fields, so reject anything else (javascript:, etc.)
  // and HTML-escape what we keep so it can't break out of the src attribute.
  const safeImgSrc = (u) => {
    const s = String(u || '');
    return /^(https?:|data:image\/)/i.test(s) ? esc(s) : '';
  };
  // v7.59: catalog figures get their real catalog image (custom figures
  // keep their own f.image), and tapping any thumbnail opens a full-size
  // view — buying the right release is easier with a big picture.
  const cardImg = f => safeImgSrc(f.image) || (f.slug ? esc(`${IMG}/${f.slug}.jpg`) : '');
  items.forEach(({ fig: f, note, price }) => {
    const entry = S.coll[f.id];
    const owned = entry?.status === 'owned' || entry?.status === 'for-sale';
    const isFound = found.has(f.id);
    const imgSrc = cardImg(f);
    h += `<div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg3);border:1px solid ${isFound?'var(--gn)':owned?'var(--gn)':'var(--bd)'};border-radius:12px;margin-bottom:10px;${isFound?'opacity:0.55':''}">
      <button data-action="shared-toggle-found" data-fig-id="${esc(f.id)}" title="Mark as found" style="width:30px;height:30px;border-radius:50%;border:2px solid ${isFound?'var(--gn)':'var(--bd)'};background:${isFound?'var(--gn)':'transparent'};color:var(--btn-t);font-size:16px;font-weight:700;flex-shrink:0;display:flex;align-items:center;justify-content:center">${isFound?'✓':''}</button>
      ${imgSrc ? `<img src="${imgSrc}" alt="" data-action="shared-img-zoom" data-error-action="img-hide" style="width:72px;height:72px;object-fit:cover;border-radius:8px;flex-shrink:0;background:var(--bd);cursor:zoom-in">` : `<div style="width:72px;height:72px;border-radius:8px;flex-shrink:0;background:var(--bd)"></div>`}
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:700;color:var(--t1);line-height:1.25">${esc(f.name)}</div>
        <div style="font-size:12px;color:var(--t3);margin-top:2px">${esc([ln(f.line), f.wave ? 'W' + f.wave : null, f.year].filter(Boolean).join(' · '))}${Number.isFinite(f.retail) ? ` · $${f.retail.toFixed(2)} MSRP` : ''}</div>
        ${f.upc ? `<div style="font-size:11px;color:var(--t3);font-family:monospace;letter-spacing:0.5px;margin-top:3px" title="Barcode on the box">▌${esc(f.upc)}</div>` : ''}
        ${note ? `<div style="font-size:12px;color:var(--t2);font-style:italic;margin-top:4px">💬 ${esc(note)}</div>` : ''}
        ${price ? `<div style="font-size:12px;color:var(--gold);font-weight:600;margin-top:2px">Try to pay ≤ $${price}</div>` : ''}
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
