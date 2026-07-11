// ════════════════════════════════════════════════════════════════════
// MOTU Vault — state.js
// ────────────────────────────────────────────────────────────────────
// Constants, icons, localStorage wrapper, and the shared `S` state
// object. This is the leaf module — imports from nothing, imported
// by everything else. Order within file matters: STORAGE must be
// defined before STATE because S = { theme: store.get(...), ... }.
// ════════════════════════════════════════════════════════════════════

// § ICONS ── SVG icon paths + icon() helper ────────────────────────
const ICO = {
  lines:   'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  list:    'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  heart:   'M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z',
  search:  'M11 3a8 8 0 100 16 8 8 0 000-16zM21 21l-4.35-4.35',
  filter:  'M22 3H2l8 9.46V19l4 2V12.46L22 3z',
  sort:    'M3 6h18M6 12h12M10 18h4',
  grip:    'M9 6L9 6M9 12L9 12M9 18L9 18M15 6L15 6M15 12L15 12M15 18L15 18',
  check:   'M20 6L9 17l-5-5',
  plus:    'M12 5v14M5 12h14',
  x:       'M18 6L6 18M6 6l12 12',
  back:    'M19 12H5M12 19l-7-7 7-7',
  edit:    'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
  trash:   'M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2',
  export:  'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  import:  'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12',
  palette: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c.55 0 1-.45 1-1 0-.26-.1-.5-.26-.69-.16-.2-.25-.44-.25-.69 0-.55.45-1 1-1h1.18c3.07 0 5.57-2.5 5.57-5.57C20.26 5.6 16.56 2 12 2z',
  img:     'M21 19V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14l4-4h12a2 2 0 002-2zM8.5 12.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z',
  sync:    'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15',
  chevR:   'M9 18l6-6-6-6',
  menu:    'M4 6h16M4 12h16M4 18h16',
  share:   'M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13',
  qr:      'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM17 14h.01M14 14h.01M14 17h.01M17 17h.01M20 14h.01M20 17h.01M20 20h.01M14 20h.01M17 20h.01',
  // v5.06: status-button icons (audit recommended visual redundancy)
  box:     'M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12',
  tag:     'M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82zM7 7h.01',
  // v6.91: detail-screen redesign — hero FABs + databox affordances.
  camera:  'M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2zM12 17a4 4 0 100-8 4 4 0 000 8z',
  dollar:  'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  // Filled star for the "Default" hero badge / primary-photo marker.
  star:    'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z',
};

function icon(d, size = 20, strokeW = 2) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
}

// § CONSTANTS ── IMG, URLs, LINES, FACTIONS, STATUS_*, THEMES, SUBLINES, maps ──
const ROOT = 'https://raw.githubusercontent.com/shkankin/motu-images/main';
const IMG  = ROOT + '/images';
const FIGS_URL     = ROOT + '/figures.json';
const LOADOUTS_URL = ROOT + '/loadouts.json';
const KIDS_CORE_URL = ROOT + '/kids-core.json';
// v6.03: shared loadouts (what each figure shipped with). Local override
// in motu-acc-avail beats repo default for the same figId — same merge
// model as kids-core. File is optional; 404 is fine.
const CACHE_KEY = 'motu-figs-cache';
const LOADOUTS_CACHE_KEY = 'motu-loadouts-cache'; // v6.24: persisted alongside figs cache
const KIDS_CORE_KEY = 'motu-kids-core';  // localStorage key for local Kids Core figures
const CUSTOM_FIGS_KEY = 'motu-custom-figs'; // v5.04: localStorage key for user-defined custom figures
const CACHE_TTL = 24 * 60 * 60 * 1000;

const LINES = [
  {id:'origins',    name:'Origins',         yr:'2019–2026', mfr:'Mattel',  sc:'5.5"'},
  {id:'masterverse',name:'Masterverse',     yr:'2021–2026', mfr:'Mattel',  sc:'7"'},
  {id:'kids-core',  name:'Kids Core',        yr:'2026–',     mfr:'Mattel',  sc:'5.5"'},
  {id:'chronicles', name:'Chronicles',      yr:'2026',      mfr:'Mattel',  sc:'7"'},
  // v6.61: Cross-Brand & Collabs — designer collabs (Mondo, Super7-style art toys
  // when not housed under their own line), fashion/collector dolls (Barbie x MOTU,
  // Monster High crossover), Hot Wheels & die-cast (Hot Wheels Character Cars,
  // Hot Wheels Wheelos, etc.), and mini/build/games (Mega Construx, Monopoly,
  // Clue, Operation, Loyal Subjects minis, etc.). Manufacturer "Various" since
  // these span Mattel, Hasbro partnerships, Hot Wheels, Mega, USAopoly, etc.
  {id:'cross-brand',name:'Cross-Brand & Collabs', yr:'2020–', mfr:'Various', sc:'Various'},
  // v7.01: "Mattel Classics" → "Classics", "Mattel 200x" → "200x" (display names only; ids unchanged)
  {id:'classics',   name:'Classics',        yr:'2008–2016', mfr:'Mattel',  sc:'6"'},
  {id:'200x',       name:'200x',            yr:'2002–2004', mfr:'Mattel',  sc:'6"'},
  // v6.99: "Original" renamed to "Vintage" — display name only; the id stays
  // 'original' so all 1,194 figures (which reference the line by id) and the
  // scraper/AF411 mapping keep working unchanged.
  {id:'original',   name:'Vintage',         yr:'1981–1988', mfr:'Mattel',  sc:'5.5"'},
  {id:'new-adventures', name:'New Adventures', yr:'1989–1992', mfr:'Mattel', sc:'5.5"'},
  {id:'mondo',      name:'Mondo',           yr:'2018–2025', mfr:'Mondo',   sc:'1/6'},
  {id:'super7',     name:'Super7',          yr:'2016–2020', mfr:'Super7',  sc:'7"'},
  {id:'eternia-minis', name:'Eternia Minis', yr:'2013–2022', mfr:'Mattel', sc:'2"'},
  // v6.99: new flat line (no sublines).
  // v7.01: year corrected to 2026.
  {id:'mighty-masters', name:'Mighty Masters', yr:'2026', mfr:'Mattel', sc:'—'},
  // v7.01: new line.
  {id:'motu-giants', name:'MOTU Giants', yr:'2014', mfr:'Mattel', sc:'12"'},
];

const FACTIONS = ['Heroic Warriors','Evil Warriors','Evil Horde','Snake Men','Great Rebellion','Other'];
const CONDITIONS = ['Mint in Box','Mint on Card','Loose Complete','Loose Incomplete','Damaged','New/Sealed'];
// v4.87: canonical accessory list. Covers classic MOTU loadouts — the
// "Custom…" picker option lets users enter anything not listed. The list
// intentionally stays flat (no categories) to keep the picker simple on mobile.
const ACCESSORIES = [
  'Sword','Power Sword','Half Sword','Shield','Axe','Mace','Club',
  'Hammer','Staff','Spear','Trident','Bow','Crossbow','Gun/Blaster',
  'Chain','Chain & Lock','Whip','Nunchucks','Hook',
  'Cape','Harness','Armor','Helmet','Mask','Belt',
  'Backpack','Comic','Minicomic','Mini-figure',
  'Stand','Info Card','Accessory Card','Instructions','Other',
];
const STATUSES = ['owned','wishlist','ordered','for-sale'];
const STATUS_LABEL = {owned:'Owned',wishlist:'Wishlist',ordered:'Ordered','for-sale':'For Sale'};
const STATUS_COLOR = {owned:'var(--gn)',wishlist:'var(--bl)',ordered:'var(--or)','for-sale':'var(--rd)'};
const STATUS_HEX = {owned:'#34d399',wishlist:'#60a5fa',ordered:'#fb923c','for-sale':'#f87171'};

// v6.23: paper goods — accessories that don't count toward "complete."
// A figure with the full hard-goods loadout (sword/cape/etc.) but missing
// these is still considered Loose Complete. They appear in the missing-
// pills row so users can still add them, but absence doesn't block the
// ✓ Complete badge or the auto-flip to Loose Complete.
const OPTIONAL_ACCESSORIES = new Set([
  'Comic', 'Minicomic', 'Info Card', 'Accessory Card', 'Instructions',
]);

// v6.94: each entry carries fg/fg2 (its own primary/secondary text color,
// mirroring the --t1/--t2 in vault.css) so the picker renders every option
// legibly regardless of the active theme.
// v6.97: theme reshuffle. The display NAMES and palettes changed but the KEYS
// are intentionally unchanged, so saved `motu-theme` values keep working with
// no migration and the title-tap egg dispatch (keyed on S.theme==='eternia')
// still fires for the right theme:
//   • key `eternia` → now shown as "Snake Mountain" (the dark default, :root in
//     vault.css; its Orko title-tap egg is now the Snake Mountain egg). Palette
//     from snake.html.
//   • key `light`   → now shown as "Eternia" (a light theme themed after the
//     Filmation Sorceress — sky blue + falcon orange). Palette from
//     sorcespreview.html.
const THEMES = {
  eternia:  {name:'Snake Mountain', bg:'#11131a', acc:'#a855f7', gold:'#3b82f6', fg:'#f8fafc', fg2:'#94a3b8', icons:['eternia1-icon.png']},
  skeletor: {name:'Skeletor',      bg:'#090212', acc:'#b14eff', gold:'#f2e162', fg:'#faf5ff', fg2:'#c0a8e6', icons:['skeletor-icon.png'], titles:['MOTU Collector','NYAAAH!','I Must Possess All'], sounds:[null, '/nyaaah.mp3', '/i-must-possess-all.mp3']},
  heman:    {name:'He-Man',        bg:'#140803', acc:'#cbd5e1', gold:'#ff8a1f', fg:'#fff7ed', fg2:'#d6c5b3', icons:['he-man-icon.png']},
  grayskull:{name:'Grayskull',     bg:'#030d06', acc:'#a3e635', gold:'#b8e070', fg:'#f0fdf4', fg2:'#86a693', icons:['grayskull-icon.png']},
  // Light theme (Filmation Sorceress palette). bg matches vault.css
  // [data-theme="light"] --bg so the picker preview and the dynamic
  // <meta name="theme-color"> stay accurate.
  light:    {name:'Eternia',       bg:'#f0f6fc', acc:'#0284c7', gold:'#ea580c', fg:'#0f172a', fg2:'#334155', icons:['eternia1-icon.png']},
};

const SUBLINES = {
  origins: [
    {key:'action',label:'Action Figures',groups:['Action Figures']},
    {key:'exclusives',label:'Exclusives',groups:['Exclusives']},
    {key:'vehicles',label:'Vehicles & Playsets',groups:['Vehicles & Playsets']},
    {key:'turtles',label:'Turtles of Grayskull',groups:['Turtles of Grayskull']},
    {key:'crossovers',label:'Crossovers',groups:['Crossovers']},
    {key:'wwe',label:'WWE',groups:['WWE']},
    {key:'movie',label:'Movie (2026)',groups:['Movie (2026)']},
    {key:'rulers',label:'Rulers of the Sun',groups:['Rulers of the Sun']},
    {key:'cartoon',label:'Cartoon Collection',groups:['Cartoon Collection']},
    {key:'powers',label:'Powers of Grayskull',groups:['Powers of Grayskull']},
    {key:'thundercats',label:'MOTU x Thundercats',groups:['MOTU x Thundercats']},
    {key:'sketchbook',label:'Sketchbook Series',groups:['Sketchbook Series']},
  ],
  masterverse: [
    {key:'revelation',label:'Revelation',groups:['Revelation','Revelation Deluxe']},
    {key:'new-eternia',label:'New Eternia',groups:['New Eternia']},
    {key:'new-etheria',label:'New Etheria',groups:['New Etheria']},
    {key:'princess-power',label:'Princess of Power',groups:['Princess of Power']},
    {key:'revolution',label:'Revolution',groups:['Revolution']},
    {key:'new-adventures',label:'New Adventures',groups:['New Adventures']},
    {key:'movie',label:'Movie (1987)',groups:['Movie']},
    {key:'cgi',label:'CGI Cartoon',groups:['CGI Cartoon']},
    {key:'40th',label:'40th Anniversary',groups:['40th Anniversary']},
    {key:'rulers',label:'Rulers of the Sun',groups:['Rulers of the Sun']},
    {key:'vintage',label:'Vintage Collection',groups:['Vintage Collection']},
  ],
  classics: [
    {key:'heroic',label:'Heroic Warriors',groups:['Heroic Warriors']},
    {key:'evil',label:'Evil Warriors',groups:['Evil Warriors']},
    {key:'horde',label:'Evil Horde',groups:['Evil Horde']},
    {key:'snake',label:'Snake Men',groups:['Snake Men']},
    {key:'rebellion',label:'Great Rebellion',groups:['Great Rebellion']},
    {key:'galactic',label:'Galactic Protectors',groups:['Galactic Protectors']},
    {key:'mutants',label:'Evil Mutants',groups:['Evil Mutants']},
    {key:'packs',label:'Packs',groups:['Packs']},
    {key:'creatures',label:'Creatures',groups:['Creatures']},
    {key:'vehicles',label:'Vehicles & Playsets',groups:['Vehicles & Playsets']},
  ],
  'kids-core': [
    {key:'action',label:'Action Figures',groups:['Action Figures']},
    {key:'movie',label:'Movie (2026)',groups:['Movie (2026)','Movie']},
  ],
  original: [
    {key:'action',label:'Action Figures',groups:['Action Figures']},
    {key:'vehicles',label:'Vehicles & Playsets',groups:['Vehicles and Playsets','Vehicles & Playsets']},
    {key:'sheera',label:'She-Ra / Princess of Power',groups:['She-Ra / Princess of Power']},
    {key:'meteorbs',label:'Meteorbs',groups:['Meteorbs']},
    {key:'commemorative',label:'Commemorative Series',groups:['Commemorative Series']},
  ],
  '200x': [
    {key:'action',label:'Action Figures',groups:['Action Figures']},
    {key:'creatures',label:'Creatures',groups:['Creatures']},
    {key:'vehicles',label:'Vehicles & Playsets',groups:['Vehicles & Playsets']},
  ],
  super7: [
    {key:'ultimate',label:'Ultimate',groups:['Ultimate']},
    {key:'club',label:'Club Grayskull',groups:['Club Grayskull']},
    {key:'vintage',label:'Vintage',groups:['Vintage']},
    {key:'classics',label:'Classics',groups:['Classics']},
  ],
  chronicles: [
    {key:'movie',label:'Movie',groups:['Movie']},
    {key:'action',label:'Action Figures',groups:['Action Figures']},
  ],
  'new-adventures': [
    {key:'action',label:'Action Figures',groups:['Action Figures']},
    {key:'veh-playsets',label:'Vehicles & Playsets',groups:['Vehicles & Playsets']},
  ],
  'eternia-minis': [
    {key:'action',label:'Action Figures',groups:['Action Figures']},
    {key:'vehicles',label:'Vehicles & Playsets',groups:['Vehicles & Playsets']},
  ],
  'mighty-masters': [
    {key:'action',label:'Action Figures',groups:['Action Figures']},
  ],
  // v6.61: Cross-Brand & Collabs sublines.
  //  - designer:    artist/designer collabs and limited-run art toys (e.g. Mondo
  //                 one-offs not housed in the main Mondo line, KAWS-style, etc.)
  //  - dolls:       Barbie x MOTU, Monster High crossover dolls, Integrity Toys
  //  - hot-wheels:  Hot Wheels Character Cars, Hot Wheels Premium, die-cast tie-ins
  //  - minis-games: Mega Construx sets, Monopoly/Clue/Operation MOTU editions,
  //                 Loyal Subjects minis, blind-bag minis, board games
  'cross-brand': [
    {key:'designer',label:'Designer & Artist Collaborations',groups:['Designer & Artist Collaborations']},
    {key:'dolls',label:'Fashion & Collector Dolls',groups:['Fashion & Collector Dolls']},
    {key:'hot-wheels',label:'Hot Wheels & Die-Cast',groups:['Hot Wheels & Die-Cast']},
    {key:'loyal-subjects',label:'Loyal Subjects',groups:['Loyal Subjects']},
  ],
};

const SERIES_MAP = {
  'Origins':'origins','Masterverse':'masterverse',
  // Legacy names kept for backup/import compatibility; new display names also mapped.
  'Mattel Classics':'classics','Classics':'classics',
  'Mattel 200x':'200x','200x':'200x',
  'Eternia Minis':'eternia-minis','Mondo':'mondo',
  'Super7':'super7','The New Adventures of He-Man':'new-adventures','Original':'original',
  'Kids Core':'kids-core','Chronicles':'chronicles',
  // v6.99: 'Original' line renamed to 'Vintage' (id unchanged). Keep 'Original'
  // so older backups/imports still resolve; add 'Vintage' and the new lines.
  'Vintage':'original','Mighty Masters':'mighty-masters',
  // v7.01: new line.
  'MOTU Giants':'motu-giants',
  // v6.61: cross-brand accepts a couple of common spellings from imports.
  'Cross-Brand & Collabs':'cross-brand','Cross-Brand':'cross-brand',
};
const COND_MAP = {'Boxed':'Mint in Box','Loose':'Loose Complete','Incomplete':'Loose Incomplete','Damaged':'Damaged','':''};
const GROUP_MAP = {
  'Origins Action Figures':'Action Figures','Origins Deluxe':'Action Figures',
  'Origins Exclusives':'Exclusives','Origins Beasts, Vehicles and Playsets':'Vehicles & Playsets',
  'Turtles of Grayskull':'Turtles of Grayskull','Stranger Things Crossover':'Crossovers',
  'Thundercats Crossover':'Crossovers','Transformers Collaboration':'Crossovers',
  'Revelation Action Figures':'Revelation','Revelation Deluxe Figures':'Revelation Deluxe',
  'Eternia Action Figures':'Action Figures','Eternia Vehicles and Playsets':'Vehicles & Playsets',
  'Original Action Figures':'Action Figures','Original Vehicles and Playsets':'Vehicles and Playsets',
};

const ln = id => LINES.find(l => l.id === id)?.name || id;
const normalize = s => (s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
// v6.26: JS-string-literal-safe interpolation for inline event handlers.
// `esc()` alone is unsafe inside `onclick="fn('${esc(x)}')"` because the HTML
// parser decodes `&#39;` back to `'` *before* the JS engine sees the string,
// letting a value like `evil');alert(1);//` break out. `jsArg()` JSON-encodes
// (which produces a valid JS string literal with embedded quotes) and then
// HTML-escapes the result so it survives the attribute layer too. Use as:
//   `<button onclick="cycleStatus(event,${jsArg(figId)})">…</button>`
// Note: NO surrounding quotes — JSON.stringify already adds them.
const jsArg = s => esc(JSON.stringify(s == null ? '' : String(s)));
const isSelecting = () => !!S.selectMode;
// v4.86: structuredClone is ~3× faster than JSON.parse(JSON.stringify(...)) for
// the small undo snapshots we take on every status tap. Fallback retained for
// older Safari/Android WebView that predate structuredClone.
const _clone = (typeof structuredClone === 'function')
  ? (v => structuredClone(v))
  : (v => JSON.parse(JSON.stringify(v)));

// § STORAGE ── localStorage wrapper (store.get/set) ───────────────
// v6.30: storage failure is now persistent. Safari private mode in
// particular returns 0 quota and rejects every write. The previous
// version showed exactly one toast on first failure, then silently
// dropped subsequent writes — leaving a user with the impression that
// their collection was being saved when it wasn't. Now we expose
// `storageBroken` so render.js can show a persistent banner that the
// user has to deliberately dismiss; once shown, every save attempt
// re-checks (in case quota was freed up).
let _quotaWarned = false;
let _storageBroken = false;
const _storageListeners = new Set();
function _notifyStorageChange() {
  for (const fn of _storageListeners) {
    try { fn(_storageBroken); } catch {}
  }
}
const store = {
  get: k => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set: (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      // Recovery path: a previously-broken store starts working again
      // (e.g. user freed up quota in another tab, exited private mode).
      if (_storageBroken) {
        _storageBroken = false;
        _notifyStorageChange();
      }
      return true;
    }
    catch(e) {
      const quota = e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(e.message||''));
      if (!_storageBroken) {
        _storageBroken = true;
        _notifyStorageChange();
      }
      if (quota && !_quotaWarned) {
        _quotaWarned = true;
        // v7.51: explicit window.toast — state.js is the leaf module and
        // cannot import render.js; the bare `toast` resolved only via the
        // Object.assign(window,…) side effect in app.js. Optional-chained:
        // before app.js runs (or if it never does), this quietly no-ops,
        // which is exactly what the old try/catch was hedging against.
        try { window.toast?.('✗ Storage full — changes may not persist', { duration: 8000 }); } catch {}
      }
      return false;
    }
  },
  isBroken: () => _storageBroken,
  // Subscribe to storageBroken transitions. Used by render.js to add/remove
  // the persistent storage banner without needing a full re-render.
  onChange: (fn) => { _storageListeners.add(fn); return () => _storageListeners.delete(fn); },
};

// § STATE ── Global S object, DEFAULT_TITLE ────────────────────────
const S = {
  figs: [],
  coll: {},
  customPhotos: {},
  imgErrors: {},
  tab: 'lines',       // lines | all | collection
  activeLine: null,
  activeSubline: null,
  screen: 'main',     // main | figure
  activeFig: null,
  search: '',
  filterFaction: '',
  filterLine: '',
  filterStatus: '',
  filterVariants: false,
  // v6.37: 'complete' | 'incomplete' | '' (off). Implicit-owned — only
  // matters for figures with status === 'owned' AND a defined loadout.
  filterLoadout: '',
  // v6.37: Filter sheet keeps the long Line list collapsed by default,
  // expanded inline by tapping the section header. UI-only state, not
  // persisted — defaults to collapsed each session.
  _filterLineExpanded: false,
  // v6.33: 'all' (name + line name + group/subline) | 'name' (name only).
  // Setting persists via 'motu-search-scope'. Default 'all' preserves the
  // existing behavior where "she-ra" pulls everything in the She-Ra
  // subline; users who want strictly figure-name matches set this to 'name'.
  searchScope: store.get('motu-search-scope') || 'all',
  sortBy: store.get('motu-sort') || 'year',
  viewMode: (v => (v === 'grid' || v === 'list') ? v : 'list')(store.get('motu-view')),  // list | grid — v6.72: sanitized (short-lived 'text' mode removed)
  theme: (t => THEMES[t] ? t : 'eternia')(store.get('motu-theme')),  // v6.75: fall back if saved theme was removed (e.g. snake)
  // v6.62: merge any line ids from LINES that are missing from the stored
  // order. Previously, when a new line was added (e.g. cross-brand in v6.61),
  // users with an existing stored lineOrder array got the new line appended
  // by the render fallback but it wasn't actually IN lineOrder, so the
  // up/down arrows in Manage Collection couldn't move it. New ids are pushed
  // to the end so existing user ordering is preserved.
  lineOrder: (() => {
    const stored = store.get('motu-line-order');
    const allIds = LINES.map(l => l.id);
    if (!Array.isArray(stored)) return allIds;
    const known = new Set(stored);
    const missing = allIds.filter(id => !known.has(id));
    // Also strip any stored ids that no longer exist in LINES (line renames/removals).
    const validStored = stored.filter(id => allIds.includes(id));
    return missing.length ? [...validStored, ...missing] : validStored;
  })(),
  hiddenItems: store.get('motu-hidden') || [],
  sheet: null,
  loaded: false,
  fetchError: false,
  isOffline: typeof navigator !== 'undefined' && navigator.onLine === false,
  // v6.30: per-session dismiss for the storage-unavailable banner. Not
  // persisted because the storage that would persist it is the same one
  // we're warning about — and we want users to see the warning each new
  // session if their environment still doesn't support storage.
  storageDismissed: false,
  syncStatus: 'idle',
  syncTs: null,
  editingOrder: false,
  savedScroll: 0,
  searchBarHidden: false,
  barsHidden: false,
  titleIdx: 0,
  newFigIds: new Set(),     // IDs added since last sync
  _recentChanges: [],       // Last changed figure IDs (most recent first)
  _justNavigated: false,
  _hiddenKey: null,         // cached join of hiddenItems for figIsHidden
  _collVersion: 0,          // v4.86: bumped on every saveColl, used by _derived._makeKey
  photoViewer: null,        // {figId, photos[], idx} when full-screen viewer open
  confirmClear: false,      // pending clear confirmation in select actionbar
  iconOverride: null,       // session override for theme icon (e.g. Orko after Eternia egg)
  onboarded: !!store.get('motu-onboarded'),
  selected: new Set(),      // selected figure IDs
  defaultPhoto: {},         // { figId: n } — which photo is the list/grid thumbnail (-1 = stock)
  _repoLoadouts: {},        // v6.03: shared loadouts.json from repo. {[figId]: ['Power Sword', ...]}. Local override (motu-acc-avail) beats this.
  _repoCustomAccessories: [], // v6.33: master list of admin-added accessory names from loadouts.json schema v2. Merged into picker offer below the canonical ACCESSORIES list.
  _repoCustomSublines: {},  // v6.40: custom subline definitions from loadouts.json. Injected into SUBLINES at runtime.
  _lastDetailFigId: null,   // v6.40: fig id last viewed in detail — used to scroll list back to it on exit.
  _sublineOrder: {},        // v6.43: {[lineId]: [key, ...]} — persisted display order for sublines per line.
  // v7.12: per-device subline order, set via drag-and-drop in the app itself
  // (Lines tab → drill into a line → Reorder). Same shape as _sublineOrder
  // ({[lineId]: [key,...]}) so it's a drop-in fit if this is ever promoted
  // to the canonical/shared loadouts.json order later — but for now it's
  // local-only (localStorage key 'motu-subline-order') and, where set,
  // takes precedence over the admin/canonical order from loadouts.json.
  // See getOrderedSublines() in data.js for the precedence.
  _localSublineOrder: (store.get('motu-subline-order') || {}),
};

const DEFAULT_TITLE = 'MOTU Collector';

function getThemeTitles() {
  return THEMES[S.theme]?.titles || [DEFAULT_TITLE];
}
// v7.34: delegate-handlers.js's 'title-cycle' action (fires for any theme
// with multiple titles — currently just skeletor, 3 titles) calls
// window.getThemeTitles?.() — that module system has no imports at all by
// design, window-only. This was only ever an ES module export, never
// actually assigned to window, so the call silently resolved to undefined
// and the handler returned immediately without doing anything. This is
// the real cause of "tapping the title does nothing" for the skeletor
// theme specifically — it always takes this code path since it has 3
// titles, not the single-title-per-theme branches the other themes use.
window.getThemeTitles = getThemeTitles;

// ── Exports ─────────────────────────────────────────────────
export {
  ICO, icon, ROOT, IMG, FIGS_URL, KIDS_CORE_URL, LOADOUTS_URL, CACHE_KEY, LOADOUTS_CACHE_KEY, KIDS_CORE_KEY, CUSTOM_FIGS_KEY, CACHE_TTL, LINES, FACTIONS, CONDITIONS, ACCESSORIES, OPTIONAL_ACCESSORIES, STATUSES, STATUS_LABEL, STATUS_COLOR, STATUS_HEX, THEMES, SUBLINES, SERIES_MAP, COND_MAP, GROUP_MAP, ln, normalize, esc, jsArg, isSelecting, _clone, store, S, DEFAULT_TITLE, getThemeTitles
};
