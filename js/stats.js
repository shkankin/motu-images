// ════════════════════════════════════════════════════════════════════
// stats.js — Collection Stats sheet (extracted from render.js in v6.80)
// ════════════════════════════════════════════════════════════════════
// Self-contained: renderStatsSheet() builds the entire Collection Stats
// sheet body (status breakdown, collection-value dashboard, by-line bars,
// waves-in-progress, and the activity/spend charts). Two window-exposed
// companions live here too: fetchAllOwnedPricing (bulk price fetch) and
// toggleWaveExpand (waves drill-down). Cross-module data comes through
// explicit imports below; render() / openFig() / goToWave() etc. are
// reached via window.* (already bridged in app.js) to avoid a circular
// import with render.js.

import { S, store, esc, ln, icon, ICO, jsArg } from './state.js';
import {
  getStats, getLineStats, getSoldLog, figIsHidden, isMigrated,
  isLineFullyHidden, getEvents, getCompletenessStats,
} from './data.js';
import {
  getCachedAskingPrice, isPricingConfigured, fetchPricing,
} from './pricing.js';
import { toast } from './render.js';

// ── v6.67: bulk price fetch ─────────────────────────────────────────
// Fetches asking prices for every owned/for-sale figure that has no cached
// price. Sequential with a 300ms gap to be polite to the worker; capped at
// 150 per run (re-tap to continue on huge collections). Updates the stats
// sheet in place when done.
let _bulkFetchRunning = false;
// v6.78: expand/collapse a Waves-in-Progress row to reveal missing figures.
// DOM-only toggle (no render) so the sheet scroll position and other open
// rows are preserved.
window.toggleWaveExpand = (wid) => {
  const panel = document.getElementById(wid);
  const caret = document.getElementById(wid + '_caret');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  if (caret) caret.style.transform = open ? '' : 'rotate(90deg)';
};

window.fetchAllOwnedPricing = async () => {
  if (_bulkFetchRunning) { toast('Already fetching…'); return; }
  if (!isPricingConfigured()) { toast('Configure a pricing backend first (Settings → Pricing Backend)'); return; }
  const targets = S.figs.filter(f => {
    if (figIsHidden(f)) return false;
    const c = S.coll[f.id];
    const st = c?.status;
    const watched = (st === 'wishlist' || st === 'ordered') && Number.isFinite(parseFloat(c.targetPrice));
    if (st !== 'owned' && st !== 'for-sale' && !watched) return false;
    return getCachedAskingPrice(f) == null;
  }).slice(0, 150);
  if (!targets.length) { toast('✓ All owned figures already priced'); return; }
  _bulkFetchRunning = true;
  const btn = document.getElementById('fetchAllPricesBtn');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; btn.textContent = `Fetching 0/${targets.length}…`; }
  let done = 0, got = 0;
  try {
    for (const f of targets) {
      const r = await fetchPricing(f.id, { line: f.line, wave: f.wave, year: f.year });
      done++;
      if (r && getCachedAskingPrice(f) != null) got++;
      if (btn) btn.textContent = `Fetching ${done}/${targets.length}…`;
      await new Promise(res => setTimeout(res, 300));
    }
  } finally {
    _bulkFetchRunning = false;
  }
  toast(`✓ Priced ${got} of ${targets.length} figures${got < targets.length ? ' (no listings found for the rest)' : ''}`);
  // Refresh the stats sheet in place if it's still open.
  const body = document.querySelector('.sheet-body');
  if (body && S.sheet === 'stats') body.innerHTML = renderStatsSheet();
};

function renderStatsSheet() {
  const stats = getStats();
  const unowned = stats.total - stats.owned - stats.wish - stats.ord - stats.sale;
  const pct = n => stats.total ? (n / stats.total * 100).toFixed(1) : 0;
  // Spent totals — sum paid across all copies of each owned figure.
  let totalSpent = 0, paidCount = 0;
  S.figs.filter(f => !figIsHidden(f) && S.coll[f.id]?.status === 'owned').forEach(f => {
    const c = S.coll[f.id];
    if (isMigrated(c)) {
      for (const cp of c.copies) {
        const v = parseFloat(cp.paid) || 0;
        if (v > 0) { totalSpent += v; paidCount++; }
      }
    } else {
      const v = parseFloat(c.paid) || 0;
      if (v > 0) { totalSpent += v; paidCount++; }
    }
  });
  const avgStr = paidCount > 0 ? `$${(totalSpent / paidCount).toFixed(2)} avg` : '';

  let html = `<div class="stats-bar" style="padding:0 0 16px">
    <div class="stats-segments">
      ${stats.owned ? `<div class="seg owned" style="width:${pct(stats.owned)}%"></div>` : ''}
      ${stats.wish ? `<div class="seg wishlist" style="width:${pct(stats.wish)}%"></div>` : ''}
      ${stats.ord ? `<div class="seg ordered" style="width:${pct(stats.ord)}%"></div>` : ''}
      ${stats.sale ? `<div class="seg for-sale" style="width:${pct(stats.sale)}%"></div>` : ''}
    </div>
    <div class="stats-legend">
      <button class="stat-item" onclick="goToFiltered('owned')"><div class="stat-dot owned"></div><span class="stat-val">${stats.owned}</span> owned</button>
      <button class="stat-item" onclick="goToFiltered('wishlist')"><div class="stat-dot wishlist"></div><span class="stat-val">${stats.wish}</span> wish</button>
      <button class="stat-item" onclick="goToFiltered('ordered')"><div class="stat-dot ordered"></div><span class="stat-val">${stats.ord}</span> ord</button>
      ${stats.sale ? `<button class="stat-item" onclick="goToFiltered('for-sale')"><div class="stat-dot for-sale"></div><span class="stat-val">${stats.sale}</span> sale</button>` : ''}
      <button class="stat-item" onclick="goToFiltered('unowned')"><div class="stat-dot unowned"></div><span class="stat-val">${unowned}</span> unowned</button>
    </div>
    ${totalSpent > 0 ? `<div style="margin-top:10px;font-size:13px;color:var(--gold);font-weight:600">$${totalSpent.toFixed(2)} spent${avgStr ? ` · ${avgStr}` : ''}</div>` : ''}
  </div>`;

  // ── v6.67: Collection Value ──────────────────────────────────────
  // Aggregates cached asking prices (no network) across owned + for-sale
  // figures. Unrealized gain compares market value against paid for the
  // SAME priced subset — comparing against total spend would mix priced
  // and unpriced figures and overstate/understate the delta.
  {
    let haveTotal = 0, priced = 0, marketValue = 0, spentOnPriced = 0;
    S.figs.filter(f => !figIsHidden(f)).forEach(f => {
      const c = S.coll[f.id];
      const st = c?.status;
      if (st !== 'owned' && st !== 'for-sale') return;
      haveTotal++;
      const price = getCachedAskingPrice(f);
      if (price == null) return;
      priced++;
      const copies = isMigrated(c) && c.copies?.length ? c.copies.length : 1;
      marketValue += price * copies;
      if (isMigrated(c)) for (const cp of c.copies) { const v = parseFloat(cp.paid); if (Number.isFinite(v)) spentOnPriced += v; }
    });
    const soldLog = getSoldLog();
    let soldGross = 0, soldProfit = 0, soldWithPaid = 0;
    for (const s of soldLog) {
      soldGross += s.price || 0;
      if (Number.isFinite(s.paid)) { soldProfit += (s.price || 0) - s.paid; soldWithPaid++; }
    }
    if (priced > 0 || soldLog.length > 0 || isPricingConfigured()) {
      const unrealized = marketValue - spentOnPriced;
      const sign = n => (n >= 0 ? '+' : '−') + '$' + Math.abs(n).toFixed(2);
      html += `<div class="label text-upper text-dim text-xs" style="margin-bottom:10px">Collection Value</div>
      <div style="padding:0 0 14px">`;
      if (priced > 0) {
        html += `<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
          <span style="font-family:'Cinzel',serif;font-size:22px;font-weight:700;color:var(--gold)">$${marketValue.toFixed(2)}</span>
          <span style="font-size:11px;color:var(--t3)">market · ${priced}/${haveTotal} priced</span>
        </div>
        ${spentOnPriced > 0 ? `<div style="font-size:12px;color:${unrealized >= 0 ? 'var(--gn)' : 'var(--rd)'};margin-top:4px">${sign(unrealized)} unrealized vs $${spentOnPriced.toFixed(2)} paid (priced figures only)</div>` : ''}`;
      } else if (isPricingConfigured()) {
        html += `<div style="font-size:12px;color:var(--t3)">No cached prices yet — fetch below.</div>`;
      }
      if (isPricingConfigured() && priced < haveTotal) {
        html += `<button id="fetchAllPricesBtn" onclick="fetchAllOwnedPricing()" style="margin-top:10px;display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border-radius:10px;border:1px solid color-mix(in srgb,var(--gold) 45%,transparent);background:var(--bg3);color:var(--gold);font-size:12px;font-weight:600">
          ${icon(ICO.refresh || ICO.sort, 13)} Fetch prices for ${haveTotal - priced} unpriced
        </button>`;
      }
      if (soldLog.length) {
        html += `<div style="margin-top:12px;font-size:12px;color:var(--t2)">
          <span style="font-weight:700;color:var(--t1)">${soldLog.length}</span> sold · $${soldGross.toFixed(2)} gross${soldWithPaid ? ` · <span style="color:${soldProfit >= 0 ? 'var(--gn)' : 'var(--rd)'};font-weight:600">${sign(soldProfit)} realized</span>` : ''}
        </div>`;
      }
      html += `</div>`;
    }
  }

  // Per-line breakdown
  html += '<div class="label text-upper text-dim text-xs" style="margin-bottom:10px">By Line</div>';
  const lineStats = getLineStats();
  const ordered = [...S.lineOrder].map(id => lineStats.find(l => l.id === id)).filter(Boolean)
    .concat(lineStats.filter(l => !S.lineOrder.includes(l.id)));
  ordered.filter(l => !isLineFullyHidden(l.id) && l.total > 0).forEach(l => {
    html += `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid color-mix(in srgb, var(--bd) 30%, transparent)">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--t1);margin-bottom:4px">${esc(l.name)}</div>
        <div style="height:4px;background:var(--bd);border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${l.pct}%;background:${l.pct===100?'var(--gn)':'var(--acc)'};border-radius:2px;transition:width 0.3s"></div>
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:13px;font-weight:700;color:${l.pct===100?'var(--gn)':'var(--gold)'}">${l.pct}%</div>
        <div style="font-size:10px;color:var(--t3)">${l.owned}/${l.total}</div>
      </div>
    </div>`;
  });

  // ── v6.68: Waves in Progress ─────────────────────────────────────
  // Collectors complete by wave; this surfaces every line+wave the user
  // has started but not finished (0 < owned < total). v6.78: each row is
  // now tap-to-expand, listing the specific missing figures inline so the
  // section answers "what am I missing" without leaving the sheet. The
  // figure name still deep-links to that figure; a "View whole wave"
  // affordance jumps to the filtered checklist (goToWave).
  {
    const waveAgg = {}; // "line\x00wave" → {line, wave, total, owned, missing:[figs]}
    for (const f of S.figs) {
      if (figIsHidden(f) || !f.wave) continue;
      const k = f.line + '\x00' + f.wave;
      const a = waveAgg[k] || (waveAgg[k] = { line: f.line, wave: String(f.wave), total: 0, owned: 0, missing: [] });
      a.total++;
      const st = S.coll[f.id]?.status;
      if (st === 'owned' || st === 'for-sale') a.owned++;
      else a.missing.push(f);
    }
    const lineIdx = id => { const i = S.lineOrder.indexOf(id); return i === -1 ? 99 : i; };
    const inProgress = Object.values(waveAgg)
      .filter(a => a.owned > 0 && a.owned < a.total)
      .sort((a, b) => lineIdx(a.line) - lineIdx(b.line) ||
        ((parseFloat(a.wave) || 99) - (parseFloat(b.wave) || 99)) ||
        a.wave.localeCompare(b.wave));
    if (inProgress.length) {
      const shown = inProgress.slice(0, 14);
      html += `<div class="label text-upper text-dim text-xs" style="margin:14px 0 4px">Waves in Progress</div>
        <div style="font-size:11px;color:var(--t3);margin-bottom:10px">Tap a wave to see what you're missing.</div>`;
      shown.forEach(a => {
        const pctW = Math.round(a.owned / a.total * 100);
        const missing = a.total - a.owned;
        const wid = `wave_${esc(a.line)}_${esc(a.wave)}`.replace(/[^\w]/g, '');
        // Missing-figure chips, name-sorted; each deep-links to the figure.
        const missList = a.missing
          .slice()
          .sort((x, y) => x.name.localeCompare(y.name))
          .map(m => `<button class="wave-missing-chip" data-action="open-fig" data-fig-id="${esc(m.id)}" title="${esc(m.name)}">${esc(m.name)}</button>`)
          .join('');
        html += `<div class="wave-row">
          <button class="wave-row-head" onclick="toggleWaveExpand('${wid}')">
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;font-weight:600;color:var(--t1);margin-bottom:4px">${esc(ln(a.line))} · Wave ${esc(a.wave)}</div>
              <div style="height:3px;background:var(--bd);border-radius:2px;overflow:hidden">
                <div style="height:100%;width:${pctW}%;background:var(--acc);border-radius:2px"></div>
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0;display:flex;align-items:center;gap:8px">
              <div>
                <div style="font-size:12px;font-weight:700;color:var(--gold)">${a.owned}/${a.total}</div>
                <div style="font-size:10px;color:var(--t3)">${missing} to go</div>
              </div>
              <span class="wave-caret" id="${wid}_caret" style="color:var(--t3);transition:transform 0.2s">${icon(ICO.chevR, 14)}</span>
            </div>
          </button>
          <div class="wave-missing" id="${wid}" style="display:none">
            <div class="wave-missing-chips">${missList}</div>
            <button class="wave-viewall" onclick="goToWave(${jsArg(a.line)},${jsArg(a.wave)})">View whole wave →</button>
          </div>
        </div>`;
      });
      if (inProgress.length > shown.length) {
        html += `<div style="font-size:11px;color:var(--t3);padding:8px 0">+${inProgress.length - shown.length} more in-progress waves</div>`;
      }
    }
  }

  // v6.39: rebuilt activity & spend charts to walk owned copies directly
  // and use cp.acquired (MM/YYYY). Falls back to the v6.31 event-log
  // timestamp only for owned copies with no date set, so the chart now
  // shows truth-in-time even for AF411-imported collections going back
  // years (the original implementation would have grouped them all into
  // the import month, which was misleading).
  //
  // _bucketsByYM walks every owned copy across S.coll, returning
  //   {'YYYY-MM': {count, spend}, ...}
  function _bucketsByYM() {
    const out = {};
    const events = getEvents();
    // Build a fallback map: figId → first 'to:owned' event timestamp.
    const evFallback = {};
    for (const ev of events) {
      if (ev.to !== 'owned') continue;
      if (!evFallback[ev.id]) evFallback[ev.id] = ev.t;
    }
    for (const id in S.coll) {
      const c = S.coll[id];
      if (!c || c.status !== 'owned' || !isMigrated(c) || !c.copies) continue;
      for (const cp of c.copies) {
        let key = null;
        // Prefer cp.acquired ('MM/YYYY' string)
        if (cp.acquired && typeof cp.acquired === 'string') {
          const m = cp.acquired.match(/^(\d{1,2})\/(\d{4})$/);
          if (m) {
            key = m[2] + '-' + m[1].padStart(2, '0');
          }
        }
        // Fallback to event-log timestamp
        if (!key && evFallback[id]) {
          const d = new Date(evFallback[id]);
          key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        }
        if (!key) continue;   // no usable date — skip silently
        const paid = parseFloat(cp.paid) || 0;
        if (!out[key]) out[key] = { count: 0, spend: 0 };
        out[key].count += 1;
        if (paid > 0) out[key].spend += paid;
      }
    }
    return out;
  }
  const buckets = _bucketsByYM();
  const monthKeys = Object.keys(buckets);
  if (monthKeys.length >= 2) {
    // Build the last 12 months including any months with zero activity
    // (so the chart doesn't visually compress gaps and lie about pacing).
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const label = d.toLocaleString(undefined, { month: 'short' });
      months.push({ key, label, count: buckets[key]?.count || 0, year: d.getFullYear() });
    }
    const max = Math.max(1, ...months.map(m => m.count));
    const totalAdded = months.reduce((s, m) => s + m.count, 0);
    html += `<div style="height:1px;background:var(--bd);margin:18px 0 14px"></div>
    <div class="label text-upper text-dim text-xs" style="margin-bottom:4px;display:flex;align-items:baseline;justify-content:space-between">
      <span>Activity (last 12 months)</span>
      <span style="font-weight:400;color:var(--t3);text-transform:none;letter-spacing:0">${totalAdded} added</span>
    </div>
    <div style="display:flex;align-items:flex-end;gap:3px;height:80px;padding:8px 0 4px;background:var(--bg2);border-radius:8px;padding:10px 8px 8px">
      ${months.map(m => {
        const h = m.count ? Math.max(4, (m.count / max) * 60) : 2;
        const isCurrent = m.key === months[months.length - 1].key;
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px" title="${m.label} ${m.year}: ${m.count} added">
          <div style="width:100%;height:${h}px;background:${m.count ? (isCurrent ? 'var(--acc)' : 'var(--gold)') : 'var(--bd)'};border-radius:2px;transition:height 0.3s"></div>
          <div style="font-size:9px;color:var(--t3);font-weight:600">${m.label[0]}</div>
        </div>`;
      }).join('')}
    </div>`;
  }

  // v6.39: spend by year — same buckets, summed by YYYY.
  const yearSpend = {};
  for (const k in buckets) {
    const yr = k.slice(0, 4);
    yearSpend[yr] = (yearSpend[yr] || 0) + buckets[k].spend;
  }
  const years = Object.keys(yearSpend).filter(y => yearSpend[y] > 0).sort();
  if (years.length > 0) {
    const yearMax = Math.max(...years.map(y => yearSpend[y]));
    html += `<div style="height:1px;background:var(--bd);margin:18px 0 14px"></div>
    <div class="label text-upper text-dim text-xs" style="margin-bottom:8px">Spend by year</div>`;
    for (const y of years) {
      const v = yearSpend[y];
      const pct = (v / yearMax) * 100;
      html += `<div style="display:flex;align-items:center;gap:10px;padding:6px 0">
        <div style="font-size:12px;color:var(--t2);font-weight:600;width:40px;flex-shrink:0">${y}</div>
        <div style="flex:1;height:6px;background:var(--bd);border-radius:3px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:var(--gold);border-radius:3px"></div>
        </div>
        <div style="font-size:12px;color:var(--gold);font-weight:700;width:70px;text-align:right;flex-shrink:0">$${v.toFixed(0)}</div>
      </div>`;
    }
  }

  // v6.83: Data Completeness — surfaces owned figures missing priority fields
  // (condition, acquired, paid, location) and offers a one-tap gap-CSV export
  // that round-trips back through Import (matched by stable ID).
  const comp = getCompletenessStats();
  if (comp._rows > 0) {
    const FIELD_ORDER = [
      ['condition', 'Condition'], ['acquired', 'Date obtained'],
      ['paid', 'Purchase price'], ['location', 'Location'],
    ];
    const anyGap = FIELD_ORDER.some(([k]) => comp[k] > 0);
    html += `<div style="height:1px;background:var(--bd);margin:18px 0 14px"></div>
      <div class="label text-upper text-dim text-xs" style="margin-bottom:8px">Data completeness</div>`;
    if (!anyGap) {
      html += `<div style="font-size:13px;color:var(--gn);padding:4px 0 10px">✓ Every owned figure has condition, date, price, and location filled.</div>`;
    } else {
      html += `<div style="font-size:12px;color:var(--t3);margin-bottom:8px">${comp._figs} of ${comp._rows} owned ${comp._rows === 1 ? 'copy is' : 'copies are'} missing data</div>`;
      for (const [k, label] of FIELD_ORDER) {
        const n = comp[k];
        if (!n) continue;
        const pctMissing = Math.round((n / comp._rows) * 100);
        html += `<div style="display:flex;align-items:center;gap:10px;padding:5px 0">
          <div style="font-size:12px;color:var(--t2);font-weight:600;width:110px;flex-shrink:0">${label}</div>
          <div style="flex:1;height:6px;background:var(--bd);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${pctMissing}%;background:var(--acc);border-radius:3px"></div>
          </div>
          <div style="font-size:12px;color:var(--acc);font-weight:700;width:90px;text-align:right;flex-shrink:0">${n} missing</div>
        </div>`;
      }
      html += `<button onclick="exportGaps()" style="margin-top:12px;width:100%;padding:11px;border-radius:10px;border:1px solid var(--acc);background:color-mix(in srgb,var(--acc) 14%,transparent);color:var(--acc);font-size:13px;font-weight:600;cursor:pointer">
        ${icon(ICO.export, 15)} Export gaps to CSV
      </button>
      <div style="font-size:11px;color:var(--t3);margin-top:8px;line-height:1.5">Fill the blanks in any spreadsheet, then re-import (Menu → Import). Rows match by ID, so nothing else is touched.</div>`;
    }
  }

  return html;
}

export { renderStatsSheet };
