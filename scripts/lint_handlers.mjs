#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// MOTU Vault — handler lint (v1.1)
// ────────────────────────────────────────────────────────────────────
// Catches "dead button" bugs that the JS engine never reports, because
// inline handlers fail silently at click time:
//
//   1. INLINE handlers — `onclick="fooBar(...)"` in a render template run
//      in WINDOW scope. If `fooBar` is only a module-scoped function and was
//      never exposed (via `window.fooBar = …` or `Object.assign(window, …)`),
//      the click throws "fooBar is not defined" — but only when a user
//      actually taps it. This linter resolves every inline call target
//      against the set of globals the app exposes.
//
//   2. DELEGATED handlers — `data-action="foo"` (and `data-<evt>-action="foo"`)
//      are dispatched through delegate.js. If no module called
//      `register('foo', …)` / `registerAll({ foo… })`, the tap hits the
//      dispatcher's "no handler for" branch and silently does nothing.
//
//   3. (v1.1) UNBRIDGED window refs — `window.fooBar?.()` (or any read of
//      `window.fooBar`) where no module ever assigns `window.fooBar = …`.
//      This is the §1-handoff bug class that shipped three separate times:
//      a function exists as an ES export but was never bridged to window,
//      so the optional-chained call resolves to undefined?.() — no error,
//      no console output, "nothing happens when I tap". Every window.X
//      READ in js/ must resolve to a window.X ASSIGNMENT somewhere in js/
//      (or a browser built-in on the whitelist below).
//
// This is the safety net for the inline→delegation migration (it's what lets
// you eventually drop script-src 'unsafe-inline' from the app CSP): run it in
// CI so a half-migrated handler can't ship.
//
// Usage:  node scripts/lint_handlers.mjs [jsDir]   (default ./js)
// Exit 0 = clean, 1 = orphans found (or the js dir is missing).
// ════════════════════════════════════════════════════════════════════

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const jsDir = process.argv[2] || 'js';
if (!existsSync(jsDir)) {
  console.error(`✗ js directory not found: ${jsDir}`);
  process.exit(1);
}

const files = readdirSync(jsDir).filter(f => f.endsWith('.js'));
const sources = Object.fromEntries(files.map(f => [f, readFileSync(join(jsDir, f), 'utf8')]));
const all = Object.values(sources).join('\n');

// ── Globals the app actually exposes (the "defined" set for inline calls) ──
const globals = new Set();
//   window.NAME = …
for (const m of all.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) globals.add(m[1]);
//   Object.assign(window, { NAME, NAME2: …, … }) — strip comments first
//   (a comment containing ':' would otherwise swallow the next key: the
//   `: value` stripper matched across newlines, so `// v6.28: pricing layer`
//   consumed everything up to the next comma INCLUDING the following key —
//   found via lint self-test in v1.1), then strip `: value` expressions so
//   only the KEYS remain (a naive comma-delimited scan drops every other
//   shorthand key because the delimiter gets consumed).
for (const blk of all.matchAll(/Object\.assign\(\s*window\s*,\s*\{([\s\S]*?)\}\s*\)/g)) {
  const noComments = stripComments(blk[1]);
  const keysOnly = noComments.replace(/:\s*[^,}\n]+/g, '');   // remove `: someValue` (bounded at EOL)
  for (const k of keysOnly.matchAll(/([A-Za-z_$][\w$]*)/g)) globals.add(k[1]);
}

// Host/builtin globals that inline handlers may legitimately call.
const BUILTINS = new Set([
  'if','for','while','return','typeof','new','void','delete','in','of','do','else','switch','case',
  'function','var','let','const','catch','throw','try','await','async','yield',
  'event','this','window','document','console','Math','JSON','Number','String','Boolean','Array',
  'Object','Date','RegExp','Promise','Map','Set','parseInt','parseFloat','isNaN','isFinite',
  'alert','confirm','prompt','setTimeout','setInterval','clearTimeout','clearInterval',
  'requestAnimationFrame','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI','fetch',
  'localStorage','sessionStorage','navigator','location','history','URL','Blob','FileReader',
]);

// ── Registered delegated actions (the "defined" set for data-action) ──
// registerAll({ … }) bodies contain nested braces (arrow-fn bodies), so a
// brace-balanced regex is unreliable. Instead: (a) any register('x', …) call
// anywhere, and (b) every quoted-kebab key followed by ':' inside the
// registration module(s) — those files exist to hold registerAll maps, so a
// `'foo-bar':` line there is a registration by construction.
const actions = new Set();
for (const m of all.matchAll(/\bregister\(\s*['"]([a-z0-9-]+)['"]/g)) actions.add(m[1]);
for (const [file, raw] of Object.entries(sources)) {
  if (!/registerAll\s*\(/.test(raw)) continue;   // only registration modules
  for (const k of raw.matchAll(/['"]([a-z][a-z0-9-]+)['"]\s*:/g)) actions.add(k[1]);
}

// ── Walk references, skipping comments & template-doc noise ──
const inlineOrphans = new Map();   // name -> [file:line]
const actionOrphans = new Map();   // action -> [file:line]
const windowOrphans = new Map();   // name -> [file:line]  (check 3, v1.1)

// Browser-provided window properties that legitimately have no in-repo
// assignment. Add here (with a comment) if a new platform API is adopted.
const WINDOW_BUILTINS = new Set([
  // navigation / environment
  'location', 'history', 'navigator', 'origin', 'name', 'parent', 'top',
  'self', 'opener', 'frames', 'document', 'console', 'screen',
  'devicePixelRatio', 'innerWidth', 'innerHeight', 'isSecureContext',
  'visualViewport', 'performance', 'crypto', 'indexedDB', 'caches',
  'localStorage', 'sessionStorage', 'launchQueue',
  // events / timing
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'event',
  'onerror', 'onunhandledrejection', 'onload',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  // scrolling / geometry
  'scrollTo', 'scrollBy', 'scrollY', 'scrollX', 'pageYOffset', 'pageXOffset',
  'getComputedStyle', 'getSelection', 'matchMedia',
  // dialogs / windows
  'alert', 'confirm', 'prompt', 'open', 'close', 'focus', 'blur', 'print',
  // data / net / files
  'fetch', 'btoa', 'atob', 'structuredClone', 'URL', 'URLSearchParams',
  'Blob', 'File', 'FileReader', 'FormData', 'DOMParser', 'Image', 'Audio',
  'AudioContext', 'webkitAudioContext', 'showSaveFilePicker',
  // feature-detected platform APIs (photos.js barcode scanner)
  'BarcodeDetector',
]);

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))   // block comments
            .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length)); // line comments
}

for (const [file, raw] of Object.entries(sources)) {
  const src = stripComments(raw);
  const lineAt = idx => src.slice(0, idx).split('\n').length;

  // (1) inline on<event>="…": extract bare call targets.
  // Strip ${…} first: those run at RENDER time (module scope) while the rest
  // of the attribute runs at CLICK time (window scope). A function called only
  // inside ${…} (jsArg, esc, render helpers) is not a click-time global and
  // must not be flagged.
  for (const h of src.matchAll(/\bon[a-z]+\s*=\s*"([^"]*)"/g)) {
    const body = h[1].replace(/\$\{[^}]*\}/g, '');
    for (const c of body.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = c[2];
      if (BUILTINS.has(name) || globals.has(name)) continue;
      const key = `${file}:${lineAt(h.index)}`;
      if (!inlineOrphans.has(name)) inlineOrphans.set(name, []);
      if (!inlineOrphans.get(name).includes(key)) inlineOrphans.get(name).push(key);
    }
  }

  // (2) data-action="…" / data-<evt>-action="…"
  for (const a of src.matchAll(/data-(?:[a-z]+-)?action\s*=\s*"([a-z0-9-]+)"/g)) {
    const action = a[1];
    if (actions.has(action)) continue;
    const key = `${file}:${lineAt(a.index)}`;
    if (!actionOrphans.has(action)) actionOrphans.set(action, []);
    if (!actionOrphans.get(action).includes(key)) actionOrphans.get(action).push(key);
  }

  // (3) window.NAME reads/calls that no module ever assigns. An occurrence
  // immediately followed by `=` (but not `==`/`===`) is the assignment
  // itself and is skipped; everything else — window.X(), window.X?.(),
  // window.X.prop, bare window.X — must resolve to `globals` or a builtin.
  for (const w of src.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)/g)) {
    const name = w[1];
    if (WINDOW_BUILTINS.has(name) || globals.has(name)) continue;
    const rest = src.slice(w.index + w[0].length);
    if (/^\s*=(?![=>])/.test(rest)) continue;   // it's the assignment site
    const key = `${file}:${lineAt(w.index)}`;
    if (!windowOrphans.has(name)) windowOrphans.set(name, []);
    if (!windowOrphans.get(name).includes(key)) windowOrphans.get(name).push(key);
  }
}

// ── Report ──
let bad = false;
console.log(`handler-lint: ${files.length} modules · ${globals.size} window globals · ${actions.size} delegated actions\n`);

if (inlineOrphans.size) {
  bad = true;
  console.log(`✗ ${inlineOrphans.size} inline handler(s) call an undefined global:`);
  for (const [name, locs] of inlineOrphans) console.log(`   ${name}()  —  ${locs.join(', ')}`);
  console.log('');
}
if (actionOrphans.size) {
  bad = true;
  console.log(`✗ ${actionOrphans.size} data-action(s) with no register() handler:`);
  for (const [action, locs] of actionOrphans) console.log(`   "${action}"  —  ${locs.join(', ')}`);
  console.log('');
}
if (windowOrphans.size) {
  bad = true;
  console.log(`✗ ${windowOrphans.size} window.* reference(s) never assigned anywhere:`);
  for (const [name, locs] of windowOrphans) console.log(`   window.${name}  —  ${locs.join(', ')}`);
  console.log('');
}

if (bad) {
  console.log('Dead-button risk: these fire silently at tap time. Expose the global');
  console.log('(window.X = … / Object.assign(window, {X})) or register the action.');
  console.log('For window.* orphans: add the bridge line in the defining module,');
  console.log('or whitelist it in WINDOW_BUILTINS if it is a real platform API.');
  process.exit(1);
}
console.log('✓ Every inline handler resolves, every data-action is registered,');
console.log('  and every window.* reference has a matching assignment.');
