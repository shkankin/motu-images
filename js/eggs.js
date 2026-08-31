// ════════════════════════════════════════════════════════════════════
// MOTU Vault — eggs.js
// ────────────────────────────────────────────────────────────────────
// Audio context & sound playback (used by triggerPulse + easter eggs),
// completion celebrations / confetti, and the He-Man / Grayskull /
// Eternia easter-egg gestures.
// ════════════════════════════════════════════════════════════════════

import {
  S, ICO, icon, ROOT, IMG, THEMES, store,
  esc, normalize, getThemeTitles, ln, SUBLINES,
} from './state.js';
import {
  figById, figIsHidden, toggleHidden, clearOverrides, saveColl, rebuildFigIndex,
  getSortedFigs,
} from './data.js';
import { toast, haptic, render, appConfirm } from './render.js';
import { pushNav } from './handlers.js';
import { photoStore } from './photos.js';

// § AUDIO ── SND urls, AudioContext, playSound, preloadSound ─────
// Shared sound URLs (resolved relative to the motu-images repo).
const SND = {
  // powerGrayskull: ROOT + '/power_grayskull.mp3',   // v7.72: castle egg retired; entry commented so boot no longer preloads a dead sound
  iHaveThePower:  ROOT + '/i_have_the_power.mp3',
};

// Web Audio API playback — avoids the crackle that HTMLAudioElement produces
// on Android when audio focus transitions or the buffer starts before the
// download completes. We pre-decode each file into an AudioBuffer on first
// use, then play from the in-memory buffer (zero network latency on repeat).
// A 5ms gain ramp at start/end prevents DAC pop on abrupt onset/offset.
let _actx = null;
const _audioBuffers = {};   // url → decoded AudioBuffer
const _audioPending = {};   // url → Promise (dedupes concurrent fetches)

function getAudioContext() {
  // On mobile, an AudioContext can reach 'closed' state after a long period
  // of inactivity or OS audio-focus transitions. A closed context can't be
  // resumed or used — recreate it and drop stale decoded buffers (which
  // were bound to the old context and won't play from the new one).
  if (_actx && _actx.state === 'closed') {
    _actx = null;
    for (const k in _audioBuffers) delete _audioBuffers[k];
  }
  if (!_actx) _actx = new (window.AudioContext || window.webkitAudioContext)();
  // Mobile browsers suspend the context until a user gesture — resume here.
  // We're always called from a tap/click so this is safe.
  if (_actx.state === 'suspended') _actx.resume().catch(() => {});
  return _actx;
}

async function loadAudioBuffer(url) {
  if (_audioBuffers[url]) return _audioBuffers[url];
  if (_audioPending[url]) return _audioPending[url];
  _audioPending[url] = fetch(url)
    .then(r => r.arrayBuffer())
    .then(ab => getAudioContext().decodeAudioData(ab))
    .then(buf => { _audioBuffers[url] = buf; delete _audioPending[url]; return buf; })
    .catch(() => { delete _audioPending[url]; return null; });
  return _audioPending[url];
}

// Preload a buffer without playing it (call during init / theme switch).
function preloadSound(url) { if (url) loadAudioBuffer(url).catch(() => {}); }

// Preload an image so it's in the browser cache when an egg fires.
function preloadImage(url) {
  if (!url) return;
  const img = new Image();
  img.src = url;
}

function playSound(url, volume = 0.9) {
  if (!url) return;
  const ctx = getAudioContext();
  loadAudioBuffer(url).then(buf => {
    if (!buf) return;
    const source = ctx.createBufferSource();
    source.buffer = buf;
    // Gain node for smooth ramp — eliminates onset/offset click
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.005); // 5ms attack
    gain.gain.setValueAtTime(volume, ctx.currentTime + buf.duration - 0.04);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + buf.duration); // 40ms release
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(ctx.currentTime);
  }).catch(() => {});
}

function getThemeSounds() {
  // v7.09: theme sounds live at the repo ROOT, not the images/ subdir. The
  // SND object above already uses ROOT; this was missed in the v7.08 path
  // split, so the Skeletor title sounds (nyaaah.mp3 / i-must-possess-all.mp3)
  // 404'd. The stored values keep their leading slash, so ROOT + s is correct.
  return (THEMES[S.theme]?.sounds || [null]).map(s => s ? ROOT + s : null);
}
function getThemeIcon() {
  if (S.iconOverride) return IMG + '/' + S.iconOverride;
  const icons = THEMES[S.theme]?.icons || ['eternia1-icon.png'];
  return IMG + '/' + icons[0];
}
function playTitleSound(idx) {
  const sounds = getThemeSounds();
  const src = sounds[idx];
  if (src) playSound(src, 0.8);
}
// v7.34: same bug as getThemeTitles in state.js — delegate-handlers.js's
// 'title-cycle' action calls window.playTitleSound?.(), which was never
// actually bridged to window, only usable as a local function within this
// module. Silently did nothing when called from the delegate handler.
window.playTitleSound = playTitleSound;

// § CELEBRATIONS ── checkCompletion, celebrateCompletion, spawnConfetti ──
const _celebrated = store.get('motu-celebrated') || {};

// v7.85: collection-size milestones (v7.42) REMOVED at the owner's
// direction — "doesn't benefit user and a useless metric". Gone: the
// MILESTONES thresholds, _ownedCount, getMilestoneDates, checkMilestones,
// and the Stats trophy panel that read them. Deliberately KEPT: the owned
// figure COUNT in Stats, and celebrateCompletion (confetti + sound), which
// still fires on completing a line or subline. Do not reintroduce
// count-threshold rewards.
//
// Stored 'ms:<n>' keys in motu-celebrated are simply never read again. They
// are left in place rather than migrated away: harmless, a few bytes, and
// deleting user-scoped history to tidy up is not worth the risk.

function checkCompletion(fig) {
  // v7.85: the milestone check that used to run first here is gone. Line and
  // subline completion celebrations below are unchanged.
  // Check line completion
  const lineId = fig.line;
  const lineFigs = S.figs.filter(f => f.line === lineId && !figIsHidden(f));
  const lineOwned = lineFigs.filter(f => S.coll[f.id]?.status === 'owned').length;
  if (lineOwned === lineFigs.length && lineFigs.length > 1 && !_celebrated['line:' + lineId]) {
    _celebrated['line:' + lineId] = true;
    store.set('motu-celebrated', _celebrated);
    celebrateCompletion(ln(lineId) + ' complete!');
    return;
  }
  // Check subline completion
  const subs = SUBLINES[lineId];
  if (subs) {
    for (const sl of subs) {
      if (!sl.groups.includes(fig.group)) continue;
      const key = lineId + ':' + sl.key;
      if (_celebrated['sub:' + key]) continue;
      const slFigs = S.figs.filter(f => f.line === lineId && sl.groups.includes(f.group) && !figIsHidden(f));
      const slOwned = slFigs.filter(f => S.coll[f.id]?.status === 'owned').length;
      if (slOwned === slFigs.length && slFigs.length > 1) {
        _celebrated['sub:' + key] = true;
        store.set('motu-celebrated', _celebrated);
        celebrateCompletion(sl.label + ' complete!');
        return;
      }
    }
  }
}

function celebrateCompletion(label) {
  haptic(50);
  toast('🏆 ' + label);
  spawnConfetti();
  playSound(SND.iHaveThePower);
}

function spawnConfetti() {
  // v6.26: respect the user's motion preferences. Confetti is purely decorative
  // — anyone with reduced-motion turned on (vestibular sensitivity, motion
  // sickness, low-end device) shouldn't be hit with 40 animated divs.
  if (typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const container = document.createElement('div');
  container.className = 'confetti-container';
  document.body.appendChild(container);
  const colors = ['#d4a843','#34d399','#8b5cf6','#f87171','#60a5fa','#fb923c','#fbbf24'];
  for (let i = 0; i < 40; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    const size = 6 + Math.random() * 6;
    piece.style.cssText = `
      left: ${Math.random() * 100}%;
      width: ${size}px; height: ${size}px;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
      animation-duration: ${1.5 + Math.random() * 2}s;
      animation-delay: ${Math.random() * 0.6}s;
    `;
    container.appendChild(piece);
  }
  setTimeout(() => container.remove(), 4500);
}

// § EASTER-EGGS ── triggerHeManEgg, triggerGrayskullEgg, triggerEterniaEgg ──
// Trigger: title tap (heman theme). Full-screen rotating rainbow +
// Prince Adam icon Flash-era cheese animation. ~5s total.
window.triggerHeManEgg = () => {
  if (document.querySelector('.egg-overlay')) return;
  playSound(SND.iHaveThePower);
  haptic && haptic(40);

  const iconSrc = IMG + '/adam-icon.png';
  const overlay = document.createElement('div');
  overlay.className = 'egg-overlay';
  overlay.innerHTML = `
    <div class="egg-heman-bg"></div>
    <img class="egg-heman-icon" src="${iconSrc}" alt="">
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', () => overlay.remove(), {once: true});
  setTimeout(() => { overlay.remove(); }, 5200);
};

// v7.72: castle easter egg retired with the green Grayskull theme (user
// request). Kept commented for possible revival — its CSS block in
// vault.css and the THEMES entry in state.js are commented in parallel,
// and its title-tap-grayskull dispatch was removed from render.js and
// delegate-handlers.js.
// // ─── Grayskull Easter Egg ─────────────────────────────────────────
// // Trigger: title tap (grayskull theme). grayskull-icon.png rises from
// // below in full color with green glow. Plays power_grayskull.mp3. ~4.2s.
// window.triggerGrayskullEgg = () => {
//   if (document.querySelector('.egg-overlay')) return;
//   playSound(SND.powerGrayskull);
//   haptic && haptic(30);
// 
//   const stars = Array.from({length: 55}, () => {
//     const size = 1 + Math.random() * 2.5;
//     const twinkleDur = 1.2 + Math.random() * 2.5;
//     const x = Math.random() * 100;
//     const y = 5 + Math.random() * 60;
//     return `<div class="egg-star" style="left:${x}%;top:${y}%;width:${size}px;height:${size}px;animation-duration:${twinkleDur}s,4.2s"></div>`;
//   }).join('');
// 
//   const overlay = document.createElement('div');
//   overlay.className = 'egg-overlay';
//   overlay.innerHTML = `
//     <div class="egg-eternia-bg"></div>
//     ${stars}
//     <div class="egg-castle-wrap">
//       <img class="egg-grayskull-img" src="${IMG}/grayskull-icon.png" alt="">
//     </div>
//   `;
//   document.body.appendChild(overlay);
//   overlay.addEventListener('click', () => overlay.remove(), {once: true});
//   setTimeout(() => { overlay.remove(); }, 4250);
// };

// ─── Grayskull Easter Egg (Orko) ──────────────────────────────────
// v7.72: this theme slot is now displayed as "Grayskull" (previously
// "Snake Mountain" since v6.97, "Eternia" before that)
// (its key is still `eternia` — see THEMES in state.js — so this title-tap egg
// still fires for it). The function name + `eternia` key are kept aligned to
// avoid touching the inline-handler dispatch / saved theme values; only the
// user-facing theme name changed. The animation itself is unchanged (Orko's
// portal); swapping it for a Snake-Mountain-specific visual would be a separate
// art change.
// Trigger: title tap (Grayskull theme, key `eternia`). Unstable portal zaps open,
// Orko materialises — hovers, looks around confused, portal collapses.
// Second flash fires at 3.1s. Icon swaps to Orko for session. ~4s total.
window.triggerEterniaEgg = () => {
  if (document.querySelector('.egg-overlay')) return;
  haptic && haptic(25);

  const overlay = document.createElement('div');
  overlay.className = 'egg-overlay';
  overlay.innerHTML = `
    <div class="egg-orko-portal"></div>
    <div class="egg-orko-wrap">
      <img class="egg-orko-icon" src="${IMG}/eternia2-icon.png" alt="">
    </div>
    <div class="egg-orko-flash"></div>
    <div class="egg-orko-flash2"></div>
  `;
  document.body.appendChild(overlay);

  // Swap session icon to Orko at flash2 start (6.2s) — icon change fires with the flash
  const iconTimer = setTimeout(() => {
    S.iconOverride = 'eternia2-icon.png';
    const logoIcon = document.querySelector('.logo-icon');
    if (logoIcon) logoIcon.src = IMG + '/eternia2-icon.png';
  }, 6200);

  const removeTimer = setTimeout(() => { overlay.remove(); }, 6900);
  overlay.addEventListener('click', () => {
    clearTimeout(iconTimer);
    clearTimeout(removeTimer);
    overlay.remove();
  }, {once: true});
};
// AF411 URL: /masters-of-the-universe/{line}/{group-slug}/{figure-slug}.php
// Group slugs are mostly kebab(group) except a few confirmed exceptions.
const AF411_GROUP_SLUG = {
  'origins|Action Figures':          'origins-action-figures',
  'origins|Deluxe':                  'origins-deluxe',
  'origins|Exclusives':              'origins-exclusives',
  'origins|Vehicles & Playsets':     'origins-beasts-vehicles-and-playsets',
  'origins|Turtles of Grayskull':    'turtles-of-grayskull',
  'origins|Crossovers':              'stranger-things-crossover',
  'origins|Stranger Things':         'stranger-things-crossover',
  'origins|Thundercats':             'thundercats-crossover',
  'origins|Transformers':            'transformers-collaboration',
  'origins|WWE':                     'masters-of-the-wwe-universe-action-figures',
  'origins|WWE Rings':               'masters-of-the-wwe-universe-rings',
  'masterverse|Revelation':          'revelation',
  'masterverse|Revelation Deluxe':   'revelation',
  'masterverse|New Eternia':         'new-eternia',
  'masterverse|New Etheria':         'new-etheria',
  'masterverse|Princess of Power':   'princess-of-power',
  'masterverse|Revolution':          'revolution',
  'masterverse|New Adventures':      'new-adventures',
  'masterverse|Movie':               'movie',
  'masterverse|CGI Cartoon':         'cgi-cartoon',
  'masterverse|40th Anniversary':    '40th-anniversary',
  'masterverse|Rulers of the Sun':   'rulers-of-the-sun',
  'masterverse|Vintage Collection':  'vintage-collection',
  'classics|Heroic Warriors':        'heroic-warriors',
  'classics|Evil Warriors':          'evil-warriors',
  'classics|Evil Horde':             'evil-horde',
  'classics|Snake Men':              'snake-men',
  'classics|Great Rebellion':        'great-rebellion',
  'classics|Galactic Protectors':    'galactic-protectors',
  'classics|Evil Mutants':           'evil-mutants',
  'classics|Packs':                  'multi-packs',
  'classics|Creatures':              'creatures',
  'classics|Vehicles & Playsets':    'vehicles-playsets',
  '200x|Action Figures':             '200x-action-figures',
  '200x|Creatures':                  'creatures',
  '200x|Vehicles & Playsets':        'vehicles-playsets',
  'original|Action Figures':         'original-action-figures',
  'original|Vehicles & Playsets':    'vehicles-playsets',
  'original|She-Ra / Princess of Power': 'she-ra-princess-of-power',
  'super7|Ultimate':                 'ultimate',
  'super7|Club Grayskull':           'club-grayskull',
  'super7|Vintage':                  'vintage',
  'super7|Classics':                 'classics',
  'new-adventures|Action Figures':   'new-adventures-action-figures',
  'new-adventures|Vehicles & Playsets': 'vehicles-playsets',
  'mondo|Action Figures':            'action-figures',
};

// v7.47/v7.48: open an external URL from inside the standalone PWA.
// FIX (user-reported, two rounds): the AF411 button hit a Cloudflare
// block from inside the installed PWA while the same URL opened fine in
// the Chrome app. Round 1 (v7.47) removed the window.open FEATURES string
// so the navigation got a real Custom Tab instead of a stripped popup —
// screenshot confirmed the Custom Tab, but AF411's WAF still served the
// hard "Attention Required" block. A Custom Tab launched from an
// installed web app still differs from plain Chrome in ways web code
// cannot change: it carries the app's Referer and (on many versions) an
// X-Requested-With: <package> header, and either is enough for a WAF
// rule to match. Round 2 (v7.48): stop using a Custom Tab entirely — on
// Android in standalone display mode, navigate to an intent:// URL,
// which asks Android to open the link in the DEFAULT BROWSER APP — the
// exact context the user confirmed works. S.browser_fallback_url keeps
// the old behavior on any device that can't resolve the intent. All
// other platforms (browser tab, iOS) use a plain anchor click, now with
// noreferrer so the PWA origin is never sent as a Referer anywhere.
function openExternal(url) {
  const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  const isAndroid = /Android/i.test(navigator.userAgent);
  if (isStandalone && isAndroid) {
    try {
      const u = new URL(url);
      const scheme = u.protocol.replace(':', '');
      location.href = `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${scheme};S.browser_fallback_url=${encodeURIComponent(url)};end`;
      return;
    } catch { /* malformed URL — fall through to the anchor path */ }
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer external';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

window.openAF411 = figId => {
  const fig = figById(figId);
  if (!fig) return;
  const BASE = 'https://www.actionfigure411.com/masters-of-the-universe';
  const LANDING = `${BASE}/all-action-figures.php`;

  // v7.85: rewritten. AF411 deep links are
  //   /masters-of-the-universe/{series}/{group}/{slug}.php
  // and the {series}/{group} pair is AF411's OWN taxonomy — it does NOT
  // track our line/subline names (all "Cartoon Collection" figures sit
  // under origins/origins-action-figures; our `chronicles` is their
  // `mattel-chronicles`). The old code guessed with AF411_GROUP_SLUG,
  // which covered 46 of 61 line|group combos, so 339 figures — 222 of
  // them AF411-sourced with perfectly deep-linkable ids — silently fell
  // through to the index. The canonical URL has no short form that omits
  // the group (verified against a live page), so the pair has to come
  // from AF411 itself: sync_af411.py now emits af411-paths.json from the
  // hrefs it already parses, and that is tier 1 below.
  const key = fig.line + '|' + (fig.group || '');

  // The figure's AF411 slug. af411_id (AF411's current slug-num) wins over
  // our id when they differ — that is exactly what it records.
  // v7.85: `af411` (bare int) is gone; af411_id is the single field.
  const afSlug = fig.af411_id || fig.slug || fig.id;
  const looksAF411 = /-\d{3,6}$/.test(String(afSlug));

  // Tier 1 — generated map. Accurate and self-healing.
  const genPath = S._af411Paths?.[key];
  if (genPath && looksAF411) {
    openExternal(`${BASE}/${genPath}/${afSlug}.php`);
    return;
  }

  // Tier 2 — the legacy hand-written map. Kept ONLY as a bridge: it is
  // still correct for the combos it covers, so behaviour never regresses
  // on a device that hasn't fetched af411-paths.json yet. Do not extend
  // it; add nothing here. The sync owns this mapping now.
  const legacy = AF411_GROUP_SLUG[key];
  if (legacy && looksAF411) {
    openExternal(`${BASE}/${fig.line}/${legacy}/${afSlug}.php`);
    return;
  }

  // Tier 3 — the MOTU landing page. This is the owner-specified fallback
  // for manual entries, pack figures, customs and anything with no link
  // back to AF411. v7.85: kids-core and custom used to hit a bare
  // `return` here, so the button did nothing at all — a dead control.
  openExternal(LANDING);
};

// v4.91: Breadcrumb-specific handlers. Previously "Lines" used goBack() and
// "Origins" used history.back() via clearSubline — both rely on browser
// history being in the right state, which isn't guaranteed (e.g. arriving
// from a deep link or after certain sheet interactions). These set state
// directly so the breadcrumb nav is always predictable.
window.crumbToLines = () => {
  // v4.93: must also reset tab. goToLine sets S.tab='all' when entering a
  // line, so tab is still 'all' when we click the Lines breadcrumb. Without
  // setting tab back to 'lines', renderContent falls through to renderFigList()
  // and shows the entire flat catalog instead of the lines grid.
  S.tab = 'lines';
  S.activeLine = null; S.activeSubline = null;
  S.savedScroll = 0; S.barsHidden = false; S.searchBarHidden = false;
  S._justNavigated = true;
  pushNav(); render();
};
window.crumbToLine = () => {
  // From a subline view, go back to the line's sublines screen.
  S.activeSubline = null;
  S.savedScroll = 0; S.barsHidden = false; S.searchBarHidden = false;
  S._justNavigated = true;
  pushNav(); render();
};
window.clearSubline = () => { history.back(); };
window.selectSubline = key => { S.activeSubline = key; S.tab = 'all'; S.savedScroll = 0; S.searchBarHidden = false; S.barsHidden = false; S._justNavigated = true; pushNav(); render(); };
window.toggleReorder = () => { S.editingOrder = !S.editingOrder; render(); };
window.setViewMode = mode => { S.viewMode = mode; store.set('motu-view', mode); render(); };
window.goToFiltered = status => {
  S.sheet = null;
  S.filterStatus = status;
  S.filterFaction = '';
  S.filterVariants = false;
  S.filterWave = '';
  S.activeLine = null;
  S.activeSubline = null;
  S.tab = 'all';
  S.savedScroll = 0;
  S.barsHidden = false;
  S.searchBarHidden = false;
  pushNav();
  render();
};
// v6.68: jump to a wave checklist from the Stats sheet. Shows the full
// wave (owned + unowned, status dots intact) so it reads as a checklist.
window.goToWave = (lineId, wave) => {
  S.sheet = null;
  S.filterStatus = '';
  S.filterFaction = '';
  S.filterVariants = false;
  S.filterLine = lineId;
  S.filterWave = String(wave);
  S.activeLine = null;
  S.activeSubline = null;
  S.tab = 'all';
  S.savedScroll = 0;
  S.barsHidden = false;
  S.searchBarHidden = false;
  pushNav();
  render();
};
window.toggleHidden = toggleHidden;

window.openFig = id => {
  const ca = document.getElementById('contentArea');
  if (ca) S.savedScroll = ca.scrollTop;
  // v6.82: if a sheet is open (e.g. Collection Stats → missing-wave chip),
  // dismiss it first. Otherwise renderDetail() re-appends the sheet overlay
  // on top of the detail screen and the figure opens hidden behind it.
  S.sheet = null;
  S.activeFig = figById(id);
  S.screen = 'figure'; pushNav(); render();
};
// v6.07: closeDetail. Lots of churn here in v6.04/05/06 that didn't help.
// Going back to the simplest possible version: history.back fires popstate,
// popstate handler in handlers.js sees S.screen === 'figure' and does the
// work. 350ms watchdog covers the case where popstate doesn't fire (rare,
// but it has happened on Android in PWA context). Watchdog forces the
// state change if popstate didn't run.
//
// Why earlier attempts failed:
//   v6.05 inverted order to "mutate first". This caused popstate to find
//     S.screen already 'main' and walk through OTHER state branches.
//   v6.06 added a flag to suppress popstate, but the flag could get stuck
//     if popstate didn't fire promptly.
window.closeDetail = () => {
  history.back();
  setTimeout(() => {
    if (S.screen === 'figure') {
      S._lastDetailFigId = S.activeFig?.id || null;
      S._returningFromDetail = true;
      S.screen = 'main';
      S.activeFig = null;
      render();
    }
  }, 350);
};

// § DETAIL SWIPE NAVIGATION ── v6.40 ────────────────────────────
// Navigate between figures in the current sorted/filtered list via
// horizontal swipe or keyboard arrow keys on the detail screen.

function _navigateDetail(dir) {
  // dir: +1 = next, -1 = prev
  const list = getSortedFigs();
  const idx = list.findIndex(f => f.id === S.activeFig?.id);
  if (idx === -1) return;
  const next = list[idx + dir];
  if (!next) {
    // Edge: rubber-band haptic — short double pulse
    haptic(8); setTimeout(() => haptic(8), 80);
    _rubberBand(dir);
    return;
  }
  const outClass  = dir > 0 ? 'slide-out-left'  : 'slide-out-right';
  const inClass   = dir > 0 ? 'slide-in-right'  : 'slide-in-left';
  const app = document.getElementById('app');
  if (!app) { S.activeFig = next; render(); return; }
  app.classList.add(outClass);
  haptic(12);
  const onEnd = () => {
    app.removeEventListener('transitionend', onEnd);
    app.classList.remove(outClass);
    S.activeFig = next;
    // Don't push nav — swipes don't build a per-figure history stack.
    // S.savedScroll stays intact for when user eventually exits detail.
    render();
    requestAnimationFrame(() => {
      app.classList.add(inClass);
      requestAnimationFrame(() => app.classList.remove(inClass));
    });
  };
  app.addEventListener('transitionend', onEnd, { once: true });
  // Safety fallback if transitionend doesn't fire (e.g. reduced-motion)
  setTimeout(() => { if (S.activeFig?.id !== next.id) onEnd(); }, 320);
}

function _rubberBand(dir) {
  const app = document.getElementById('app');
  if (!app) return;
  const cls = dir > 0 ? 'rubber-band-left' : 'rubber-band-right';
  app.classList.add(cls);
  setTimeout(() => app.classList.remove(cls), 350);
}

window.goNextDetail = () => _navigateDetail(+1);
window.goPrevDetail = () => _navigateDetail(-1);

// Touch handler — attached once to #app via non-passive listener.
// Re-registers if #app is replaced (should not happen — app div is stable).
(function initDetailSwipe() {
  let sx = 0, sy = 0, tracking = false, locked = false;
  function attach(el) {
    el.addEventListener('touchstart', e => {
      if (S.screen !== 'figure' || S.sheet || S.photoViewer) return;
      // v7.81: gestures that START inside the photo carousel belong to
      // the carousel (its own horizontal scroll-snap strip). The v6.84
      // CSS (touch-action/overscroll-behavior) only stopped scroll
      // hijacking — the touchend here still fired figure navigation on
      // top of the photo swipe. Owner report: photo swipe was flipping
      // the whole detail screen to the next figure.
      if (e.target && e.target.closest && e.target.closest('#photoCarousel')) { tracking = false; return; }
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      tracking = true; locked = false;
    }, { passive: true });

    el.addEventListener('touchmove', e => {
      if (!tracking || locked) return;
      const dx = e.touches[0].clientX - sx;
      const dy = e.touches[0].clientY - sy;
      // Once we know it's a vertical scroll, stop tracking entirely
      if (!locked && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
        tracking = false; return;
      }
      // Confirmed horizontal — prevent scroll takeover
      if (Math.abs(dx) > 8) { locked = true; e.preventDefault(); }
    }, { passive: false });

    el.addEventListener('touchend', e => {
      if (!tracking || !locked) { tracking = false; locked = false; return; }
      const dx = e.changedTouches[0].clientX - sx;
      tracking = false; locked = false;
      if (Math.abs(dx) < 50) return;
      if (dx < 0) window.goNextDetail();
      else         window.goPrevDetail();
    }, { passive: true });
  }
  // #app is created once in motu-vault.html and never replaced
  const el = document.getElementById('app');
  if (el) attach(el);
  else document.addEventListener('DOMContentLoaded', () => {
    const a = document.getElementById('app'); if (a) attach(a);
  });
})();

// Keyboard arrow navigation on detail screen
document.addEventListener('keydown', e => {
  if (S.screen !== 'figure' || S.sheet || S.photoViewer) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); window.goNextDetail(); }
  if (e.key === 'ArrowLeft')  { e.preventDefault(); window.goPrevDetail(); }
});

window.deleteFig = async id => {
  if (!await appConfirm('Delete this figure and all its data?', {danger: true, ok: 'Delete'})) return;
  // Clean up all side-data before dropping the figure itself.
  // Order: photos (OPFS + labels + copy assignments), then overrides,
  // then collection entry, then figure row.
  try { await photoStore.delAll(id); } catch {}
  try { clearOverrides(id); } catch {}
  S.figs = S.figs.filter(f => f.id !== id);
  rebuildFigIndex();
  delete S.coll[id]; saveColl();
  S.screen = 'main'; render();
};

window.openSheet = name => { S.sheet = name; pushNav(); render();
  requestAnimationFrame(() => { const el = document.getElementById('sheetOverlay'); if (el) el.classList.add('visible'); });
};
window.closeSheet = () => { history.back(); };
window.setTheme = t => { S.theme = t; S.titleIdx = 0; S.iconOverride = null; store.set('motu-theme', t); document.documentElement.setAttribute('data-theme', t); _syncThemeColor(t); history.back(); };
// v6.94: keep <meta name="theme-color"> aligned with the active theme so the
// mobile browser chrome matches — most noticeable for the light theme, where a
// stale dark status bar over a light app looks broken. Exported so boot can
// call it too (a saved light theme should paint light chrome from first frame).
export function _syncThemeColor(t) {
  try {
    const mc = document.querySelector('meta[name="theme-color"]');
    if (mc && THEMES[t]?.bg) mc.setAttribute('content', THEMES[t].bg);
  } catch {}
}
// v7.81: errors are keyed by the failing URL, no longer by figure id.
// The old fig-keyed flag conflated "this catalog image 404'd" with
// "never show ANY image for this figure" — so a pack figure whose repo
// art isn't uploaded yet poisoned its own user photos: the list thumb
// suppressed a valid blob URL, a close/reopen (imgErrors resets at
// boot) briefly showed it, and the next detail visit re-rendered the
// broken stock slide, re-tripped the flag, and the thumbnail
// "randomly" vanished again. URL-keying makes each source stand on its
// own; the legacy id-only call shape still records something harmless.
window.imgErr = (id, src) => { if (src) S.imgErrors[src] = true; else if (id) S.imgErrors[id] = true; };

// ── Exports ─────────────────────────────────────────────────
export {
  SND, getAudioContext, loadAudioBuffer, preloadSound, preloadImage, playSound, getThemeSounds, getThemeIcon, playTitleSound, checkCompletion, celebrateCompletion, spawnConfetti, AF411_GROUP_SLUG
};
