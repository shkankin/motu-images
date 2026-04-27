// ════════════════════════════════════════════════════════════════════
// MOTU Vault — eggs.js
// ────────────────────────────────────────────────────────────────────
// Audio context & sound playback (used by triggerPulse + easter eggs),
// completion celebrations / confetti, and the He-Man / Grayskull /
// Eternia easter-egg gestures.
// ════════════════════════════════════════════════════════════════════

import {
  S, ICO, icon, IMG, THEMES, store,
  esc, normalize, getThemeTitles,
} from './state.js';
import {
  figById, toggleHidden, clearOverrides, saveColl, rebuildFigIndex,
} from './data.js';
import { toast, haptic, render, appConfirm } from './render.js';
import { pushNav } from './handlers.js';
import { photoStore } from './photos.js';

// § AUDIO ── SND urls, AudioContext, playSound, preloadSound ─────
// Shared sound URLs (resolved relative to the motu-images repo).
const SND = {
  powerGrayskull: IMG + '/power_grayskull.mp3',
  iHaveThePower:  IMG + '/i_have_the_power.mp3',
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
  return (THEMES[S.theme]?.sounds || [null]).map(s => s ? IMG + s : null);
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

// § CELEBRATIONS ── checkCompletion, celebrateCompletion, spawnConfetti ──
const _celebrated = store.get('motu-celebrated') || {};

function checkCompletion(fig) {
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

// ─── Grayskull Easter Egg ─────────────────────────────────────────
// Trigger: title tap (grayskull theme). grayskull-icon.png rises from
// below in full color with green glow. Plays power_grayskull.mp3. ~4.2s.
window.triggerGrayskullEgg = () => {
  if (document.querySelector('.egg-overlay')) return;
  playSound(SND.powerGrayskull);
  haptic && haptic(30);

  const stars = Array.from({length: 55}, () => {
    const size = 1 + Math.random() * 2.5;
    const twinkleDur = 1.2 + Math.random() * 2.5;
    const x = Math.random() * 100;
    const y = 5 + Math.random() * 60;
    return `<div class="egg-star" style="left:${x}%;top:${y}%;width:${size}px;height:${size}px;animation-duration:${twinkleDur}s,4.2s"></div>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'egg-overlay';
  overlay.innerHTML = `
    <div class="egg-eternia-bg"></div>
    ${stars}
    <div class="egg-castle-wrap">
      <img class="egg-grayskull-img" src="${IMG}/grayskull-icon.png" alt="">
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', () => overlay.remove(), {once: true});
  setTimeout(() => { overlay.remove(); }, 4250);
};

// ─── Eternia Easter Egg (Orko) ────────────────────────────────────
// Trigger: title tap (eternia theme). Unstable portal zaps open,
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

window.openAF411 = figId => {
  const fig = figById(figId);
  if (!fig) return;
  // v4.95: previously gated on fig.source==='af411'. Now any non-Kids-Core,
  // non-custom figure can use it — falls back to AF411's site search by name
  // when we don't have a deep-link slug for the group.
  if (fig.line === 'kids-core' || fig.line === 'custom') return;
  const groupSlug = AF411_GROUP_SLUG[fig.line + '|' + fig.group];
  // v4.98: previously gated on fig.source==='af411'. But many figures are
  // actually AF411-sourced and just missing that field in figures.json.
  // Tiered approach:
  //  1. If we have a group slug AND fig.id matches AF411's <slug>-<NNNNN>
  //     pattern (numeric suffix is their post ID), build the deep link.
  //  2. Else if we have a group slug, open the group's index page (the
  //     user can scroll/Ctrl+F to find their figure).
  //  3. Else fall back to the all-figures index.
  const af411IdPattern = /-\d{3,6}$/.test(fig.id);
  if (groupSlug && af411IdPattern) {
    window.open(`https://www.actionfigure411.com/masters-of-the-universe/${fig.line}/${groupSlug}/${fig.id}.php`, '_blank', 'noopener');
    return;
  }
  if (groupSlug) {
    window.open(`https://www.actionfigure411.com/masters-of-the-universe/${fig.line}/${groupSlug}/`, '_blank', 'noopener');
    return;
  }
  window.open('https://www.actionfigure411.com/masters-of-the-universe/all-action-figures.php', '_blank', 'noopener');
};

window.searchCharacter = name => {
  // Extract base character name: strip parenthetical suffixes, "Battle Armor", "200x" prefixes etc.
  let base = name.replace(/\s*\(.*?\)\s*/g, '').replace(/\s*-\s*(Battle|Deluxe|Mega|Mini|Giant|Lord|King|Prince).*$/i, '').trim();
  // Use first two words if name is long (e.g. "Battle Armor He-Man" → "He-Man")
  const parts = base.split(/\s+/);
  if (parts.length > 2) {
    // Try to find the core name — usually the last hyphenated word or proper noun
    const hyphenated = parts.find(p => p.includes('-'));
    if (hyphenated) base = hyphenated;
    else base = parts.slice(-2).join(' ');
  }
  S.screen = 'main'; S.search = base; S.tab = 'all';
  S.activeLine = null; S.activeSubline = null;
  S.savedScroll = 0; S.barsHidden = false; S.searchBarHidden = false;
  pushNav(); render();
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
window.moveLine = (id, dir) => {
  const arr = [...S.lineOrder]; const i = arr.indexOf(id); const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  S.lineOrder = arr; store.set('motu-line-order', arr); render();
};

window.openFig = id => {
  const ca = document.getElementById('contentArea');
  if (ca) S.savedScroll = ca.scrollTop;
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
      S.screen = 'main';
      S.activeFig = null;
      render();
    }
  }, 350);
};
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
window.setTheme = t => { S.theme = t; S.titleIdx = 0; S.iconOverride = null; store.set('motu-theme', t); document.documentElement.setAttribute('data-theme', t); closeSheet(); };
window.imgErr = id => { S.imgErrors[id] = true; };

// ── Exports ─────────────────────────────────────────────────
export {
  SND, getAudioContext, loadAudioBuffer, preloadSound, preloadImage, playSound, getThemeSounds, getThemeIcon, playTitleSound, checkCompletion, celebrateCompletion, spawnConfetti, AF411_GROUP_SLUG
};
