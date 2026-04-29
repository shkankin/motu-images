// MOTU Vault — Tutorial Walkthrough (v7.00)
// ─────────────────────────────────────────────────────────────────────
// Action-driven coachmark tour. Spotlights real UI elements, advances
// when the user performs the relevant action.
//
// v7.00 — full a11y + correctness rewrite:
//   • Native dialog semantics (role="dialog", aria-modal, aria-labelledby,
//     aria-describedby), focus management on open/close, focus return
//     to trigger.
//   • Full keyboard support: Esc dismisses, Tab traps within dialog +
//     spotlight target, ←/→ navigate where applicable.
//   • Polite live region announces step changes and cycle progress
//     to screen readers.
//   • prefers-reduced-motion honored in JS as well as CSS.
//   • Skip ≠ Complete — distinct persistence so users who skipped can
//     replay; permanent replay link in the Getting Started banner.
//   • No more user data destruction — figure status snapshotted on
//     entry to the cycle demo and restored on exit (skip OR finish).
//   • MutationObserver replaces 100ms target-scan poll; ResizeObserver
//     replaces 200ms spotlight-tracking poll; click-driven cycle-demo
//     state tracking replaces 100ms status poll.
//   • Selectors centralized; data-tour attributes preferred over
//     structural selectors with graceful fallback.
//   • Cycle demo unlocks Next at 3/5 states (was 5/5) and is dismissible
//     from step 1, not just at completion.
//   • Back button on always-advance steps; consistent CTA layout.
//   • Tour-incomplete on hard timeout is announced rather than silent.
//   • Inline color styles replaced with CSS classes (forced-colors-safe).
//   • Resize listener added/removed with tour lifecycle, not module load.
//
// Storage:
//   motu-tutorial-state — { version, seen, completed, skippedAt }
//   (legacy 'motu-tutorial-seen' key still read for backward compat)
//
// Public API:
//   startTutorial()            — begin the tour
//   tutorialState()            — { seen, completed } for UI gating
//   window.startTutorial       — same, for inline onclick handlers
// ─────────────────────────────────────────────────────────────────────

import { S, store, STATUS_LABEL } from './state.js';
import { getLoadout } from './data.js';

// ── Configuration ────────────────────────────────────────────────────

const TUTORIAL_VERSION = 'v7';
const STORAGE_KEY = 'motu-tutorial-state';
const LEGACY_KEY  = 'motu-tutorial-seen';

// Cycle order matches handlers.js STATUS_CYCLE: owned → wishlist
// → ordered → for-sale → cleared. Colors live in CSS (.cycle-dot.s-*).
const CYCLE_ORDER = ['owned', 'wishlist', 'ordered', 'for-sale', ''];
const CYCLE_LABEL = { ...STATUS_LABEL, '': 'Cleared' };

// Min unique states the user must visit for the cycle demo to unlock
// the Next button. The button is always visible (just disabled until
// threshold met) so the step is never a dead-end.
const CYCLE_MIN_STATES = 3;

// Centralized selectors. Each entry is an array of candidates; the
// first match wins. Stable data-tour attributes are tried first so a
// future render.js refactor only needs `data-tour="..."` to keep the
// tour working — no churn here.
const SELECTORS = {
  navAll:        ['[data-tour="nav-all"]',        '.bottom-nav button:nth-child(2)'],
  navCollection: ['[data-tour="nav-collection"]', '.bottom-nav button:nth-child(3)'],
  figRow:        ['[data-tour="fig-row"][data-fig-id]',
                  '.fig-row[data-fig-id]',
                  '.fig-card[data-fig-id]'],
  statusCircle:  ['[data-tour="fig-row"][data-fig-id] .quick-own',
                  '.fig-row[data-fig-id] .quick-own',
                  '.fig-card[data-fig-id] .quick-own'],
};

// Step model:
//   id              unique id for storage / debugging
//   title           short heading; used for aria-labelledby
//   body            HTML body; used for aria-describedby
//   instruction     short call-to-action ("Tap All to continue.")
//   target          selector key from SELECTORS, or null for no spotlight
//   tooltipAnchor   'target' (default) | 'row' | 'bottom-fixed'
//   placement       'top' | 'bottom' | 'auto'  (ignored for bottom-fixed)
//   showOverlay     false to suppress the dim/spotlight (e.g. detail screen)
//   compact         true for the translucent compact tooltip variant
//   pulse           false to disable the spotlight pulse animation
//   advance         { type: 'state' | 'always' | 'cycle-demo',
//                     when?: () => boolean,                  (state)
//                     onNext?: () => void }                  (always)
//   requireScreen   wait for S.screen === this before resolving target
//   allowBack       show Back button on this step (default true for
//                   'always'/'cycle-demo' steps with idx > 0)
//   finalStep       last step; CTA reads "Finish" and tour ends on next
const STEPS = [
  {
    id: 'nav-all',
    title: 'Three main views',
    body: 'Three views at the bottom: <strong>Lines</strong> (browse by era), <strong>All</strong> (full catalog), <strong>Collection</strong> (what you own).',
    instruction: 'Tap <strong>All</strong> to continue.',
    target: 'navAll',
    placement: 'top',
    advance: { type: 'state', when: () => S.tab === 'all' },
  },
  {
    id: 'open-figure',
    title: 'Open a figure',
    body: 'Each row is a figure in the catalog.',
    instruction: 'Tap any figure name to open its details.',
    target: 'figRow',
    // The whole row is the spotlight, but the .quick-own status circle
    // inside the row is excluded — tapping it would cycle status (mutating
    // the user's data) instead of navigating to detail. The click trap
    // blocks .quick-own clicks during this step.
    excludeClicks: '.quick-own',
    tooltipAnchor: 'target',
    placement: 'auto',
    advance: { type: 'state', when: () => S.screen === 'figure' },
  },
  {
    id: 'detail-overview',
    title: 'Detail screen',
    body: 'Photos, accessories, condition notes, and history. Scroll to explore.',
    instruction: 'Tap <strong>Next</strong> when ready.',
    target: null,
    showOverlay: false,
    tooltipAnchor: 'bottom-fixed',
    compact: true,
    requireScreen: 'figure', // wait for the figure detail to be on-screen
    noBack: true,            // user navigated here from step 2; "back" would
                             // land them on a step that expects S.screen='main'
    // v6.23: artificially populate the figure as owned with a Loose Complete
    // copy so the user sees a fully-furnished detail screen during the tour
    // (vs the empty unowned state). Snapshot + restore on cleanup ensures
    // their actual data is untouched. Cleanup runs from the Next button (see
    // renderActions) BEFORE onNext navigates, so the artificial state never
    // leaks onto the destination screen.
    prime: () => {
      const figId = S.activeFig?.id;
      if (!figId || S.screen !== 'figure') return;
      const original = S.coll[figId];
      tour.detailSnapshot = {
        figId,
        entry: original ? structuredClone(original) : null,
      };
      // Pull the canonical loadout if available so the demo shows accessory
      // chips populated. getLoadout returns null for figures without a
      // shared loadout entry — in that case we leave accessories empty.
      let loadout = [];
      try { loadout = getLoadout(figId) || []; } catch {}
      S.coll[figId] = {
        status: 'owned',
        copies: [{
          id: 1,
          condition: 'Loose Complete',
          accessories: loadout.length ? [...loadout] : undefined,
        }],
      };
      if (window.saveColl) window.saveColl();
      if (window.render) window.render();
      addCleanup(() => {
        const snap = tour.detailSnapshot;
        if (!snap) return;
        tour.detailSnapshot = null;
        if (snap.entry) S.coll[snap.figId] = snap.entry;
        else delete S.coll[snap.figId];
        if (window.saveColl) window.saveColl();
        if (window.render) window.render();
      });
    },
    advance: {
      type: 'always',
      // Exit the figure detail screen, then switch to the All tab. We
      // mutate S.screen directly (mirroring what the popstate handler
      // does on browser-back, and what deleteFig does at line ~434 of
      // eggs.js) instead of calling closeDetail/history.back. Reasons:
      //   - navTo() only changes S.tab; it does NOT change S.screen,
      //     so calling it alone leaves the user stuck on the figure
      //     detail screen with the tab silently switched underneath.
      //   - history.back() is async (popstate fires later), so combining
      //     it with a synchronous navTo() produces a brief frame where
      //     S.screen='figure' and S.tab='all' render together.
      // The leaked openFig history entry is harmless: when the user
      // later presses back at root, popstate sees S.screen='main' and
      // walks the standard "are we at root?" branches.
      onNext: () => {
        if (S.screen === 'figure') {
          S.screen = 'main';
          S.activeFig = null;
        }
        if (typeof window.navTo === 'function') window.navTo('all');
      },
    },
  },
  {
    id: 'cycle-demo',
    title: 'Track ownership',
    body: '', // built dynamically from CYCLE_ORDER in renderCycleProgress
    instruction: 'Tap the highlighted circle to cycle through statuses.',
    target: 'statusCircle',
    tooltipAnchor: 'row',
    placement: 'top',
    advance: { type: 'cycle-demo' },
    requireScreen: 'main',
  },
  {
    id: 'nav-collection',
    title: 'Your Collection',
    body: '<strong>Collection</strong> shows just the figures you own. Tap any status circle to start filling it.',
    instruction: 'Tap <strong>Collection</strong> to finish the tour.',
    target: 'navCollection',
    placement: 'top',
    advance: { type: 'state', when: () => S.tab === 'collection' },
    finalStep: true,
    // The Skip button is suppressed on this step — tapping Collection
    // is the entire point of the final step, and Close was an easy
    // out that left users without ever actually visiting the screen
    // the tour was teaching them about. Esc still ends the tour for
    // users who genuinely need an escape hatch.
    hideSkip: true,
  },
];

// ── Tour state (single source of truth) ──────────────────────────────

const tour = {
  active: false,
  stepIdx: 0,
  triggerEl: null,        // element that started the tour, for focus return
  cleanupFns: [],         // per-step cleanup (observers, listeners)
  globalCleanupFns: [],   // tour-wide cleanup (resize, key handlers)
  cycleSnapshot: null,    // { figId, entry } for restore on exit (cycle demo)
  detailSnapshot: null,   // { figId, entry } for restore on exit (step 3 detail)
  cycleSeen: null,        // Set of states visited during cycle demo
  reducedMotion: false,
};

function isReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { return false; }
}

function addCleanup(fn)       { tour.cleanupFns.push(fn); }
function addGlobalCleanup(fn) { tour.globalCleanupFns.push(fn); }

function runStepCleanup() {
  while (tour.cleanupFns.length) {
    const fn = tour.cleanupFns.pop();
    try { fn(); } catch (err) { console.warn('tutorial cleanup failed:', err); }
  }
}

function runGlobalCleanup() {
  while (tour.globalCleanupFns.length) {
    const fn = tour.globalCleanupFns.pop();
    try { fn(); } catch (err) { console.warn('tutorial global cleanup failed:', err); }
  }
}

// ── Persistence ──────────────────────────────────────────────────────
//
// Skip ≠ Complete. We track both flags so the UI can decide whether to
// show "🎓 Take a 1-minute tour" (never seen), "🎓 Replay tour"
// (skipped or completed), or hide the link entirely.

function loadState() {
  const raw = store.get(STORAGE_KEY);
  if (raw && typeof raw === 'object') return raw;
  // Migrate legacy boolean key
  const legacy = store.get(LEGACY_KEY);
  if (legacy) {
    return { version: 'legacy', seen: 1, completed: 1 };
  }
  return { version: TUTORIAL_VERSION, seen: 0, completed: 0 };
}

function saveState(patch) {
  const cur = loadState();
  const next = { ...cur, ...patch, version: TUTORIAL_VERSION };
  store.set(STORAGE_KEY, next);
  // Also keep the legacy boolean updated for any code path that still
  // reads it directly. Removable once render.js uses tutorialState().
  if (patch.completed || patch.seen) store.set(LEGACY_KEY, 1);
}

// Public helper for render.js: lets the banner show "Take tour" vs
// "Replay tour" vs nothing, satisfying WCAG 3.2.6 Consistent Help.
function tutorialState() {
  const s = loadState();
  return { seen: !!s.seen, completed: !!s.completed };
}

// ── Selector resolution ──────────────────────────────────────────────

function querySelectors(key) {
  const list = SELECTORS[key];
  if (!list) return null;
  for (const sel of list) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function selectorString(key) {
  // Combined selector for MutationObserver target detection
  return (SELECTORS[key] || []).join(', ');
}

// ── Lifecycle ────────────────────────────────────────────────────────

function startTutorial() {
  if (tour.active) return;
  tour.active = true;
  tour.stepIdx = 0;
  tour.triggerEl = document.activeElement && document.activeElement !== document.body
    ? document.activeElement : null;
  tour.reducedMotion = isReducedMotion();

  // Mark seen immediately so the "Take tour" banner switches to "Replay
  // tour" right away. Completion is set separately on tour finish.
  saveState({ seen: 1 });

  // Get to the Lines screen if we aren't there. Done before the first
  // step renders so any in-flight render settles first.
  if (S.screen !== 'main' || S.tab !== 'lines') {
    if (window.navTo) window.navTo('lines');
  }

  installGlobalKeyHandlers();
  installResizeHandler();
  installClickTrap();

  // Defer first paint by one rAF so the tour isn't competing with the
  // navTo render, and so reduced-motion users get an immediate but not
  // jarring appearance.
  requestAnimationFrame(() => requestAnimationFrame(() => showStep(0)));
}

function endTutorial(reason /* 'completed' | 'skipped' | 'failed' */) {
  if (!tour.active) return;
  tour.active = false;

  runStepCleanup();
  runGlobalCleanup();

  document.getElementById('tutorialOverlay')?.remove();
  document.getElementById('tutorialTooltip')?.remove();
  document.getElementById('tutorialLive')?.remove();

  // Return focus to whatever opened the tour. If that element is gone
  // (e.g. the banner was dismissed mid-tour), fall back to <body>.
  const focusTarget =
    (tour.triggerEl && document.contains(tour.triggerEl)) ? tour.triggerEl : null;
  if (focusTarget) {
    try { focusTarget.focus({ preventScroll: true }); } catch {}
  }
  tour.triggerEl = null;

  // Persist outcome and toast accordingly.
  // v6.23: tutorial toasts use showTourToast (below) rather than calling
  // window.toast directly. The global .toast rule in vault.css hardcodes
  // a fade-out animation that starts at 1.7s, so even with a long JS
  // duration the message becomes invisible at 2s — far too short for
  // multi-word "Tour complete — replay anytime from the Lines screen".
  // showTourToast overrides the animation inline on the just-appended
  // element so the fade-out fires when we want it to.
  if (reason === 'completed') {
    saveState({ completed: 1 });
    showTourToast('🎓 Tour complete — replay anytime from the Lines screen', 4);
  } else if (reason === 'skipped') {
    saveState({ completed: 0 });
    showTourToast('Tour skipped — replay anytime from the Lines screen', 3);
  } else if (reason === 'failed') {
    saveState({ completed: 0 });
    showTourToast('Couldn\u2019t finish the tour — try again from the Lines screen', 4);
  }
}

// Show a toast with an explicit "visible time" before the fade-out
// starts. visibleSec is seconds (3, 4, etc.). The function calls
// window.toast() and then overrides the .toast element's animation
// inline, which is the only way to delay the fade — the global CSS
// rule's 1.7s fade-out delay isn't parameterized.
function showTourToast(msg, visibleSec) {
  if (typeof window.toast !== 'function') return;
  // Total lifecycle = fade-in (0.25s) + visible + fade-out (0.3s) + small
  // buffer so the JS removal doesn't cut the fade short on slow devices.
  const totalMs = Math.round((0.25 + visibleSec + 0.3 + 0.2) * 1000);
  window.toast(msg, { duration: totalMs });
  // The toast element is the last child of .toast-container right after
  // window.toast() returns. We grab and override its animation inline.
  const container = document.querySelector('.toast-container');
  const el = container && container.lastElementChild;
  if (el && el.classList && el.classList.contains('toast')) {
    el.style.animation =
      `toastIn 0.25s ease-out, toastOut 0.3s ease-in ${visibleSec}s forwards`;
  }
}

// ── Step machinery ───────────────────────────────────────────────────

function showStep(idx) {
  if (!tour.active) return;
  if (idx < 0 || idx >= STEPS.length) {
    endTutorial(idx >= STEPS.length ? 'completed' : 'skipped');
    return;
  }

  tour.stepIdx = idx;
  const step = STEPS[idx];
  runStepCleanup();

  // Pure-tooltip step (no spotlight). Still prime if the step has a
  // prime() function (e.g. step 3 marks the figure as owned for the demo).
  if (!step.target) {
    if (step.requireScreen && S.screen !== step.requireScreen) {
      waitForScreen(step);
      return;
    }
    primeIfNeeded(step, null);
    renderStep(step, null);
    setupAdvancement(step, null);
    return;
  }

  // requireScreen gate — wait for screen state before resolving target
  if (step.requireScreen && S.screen !== step.requireScreen) {
    waitForScreen(step);
    return;
  }

  // Try immediate resolution; otherwise watch for the target to appear
  const target = querySelectors(step.target);
  if (target) {
    onTargetReady(step, target);
  } else {
    renderStep(step, null, 'Looking for the right place\u2026');
    waitForTarget(step);
  }
}

function onTargetReady(step, target) {
  primeIfNeeded(step, target);
  renderStep(step, target);
  startTracking(step);
  setupAdvancement(step, target);
}

// Wait for S.screen change without a polling loop. We use a 200ms tick
// because there's no subscribe API in state.js, but this is bounded —
// the moment the predicate matches we tear it down.
function waitForScreen(step) {
  renderStep(step, null, 'Waiting for the right screen\u2026');
  const handle = setInterval(() => {
    if (!tour.active) { clearInterval(handle); return; }
    if (S.screen === step.requireScreen) {
      clearInterval(handle);
      // Let the resulting render flush before resolving the target / priming
      requestAnimationFrame(() => {
        if (!tour.active) return;
        // Null-target step: just prime + render
        if (!step.target) {
          primeIfNeeded(step, null);
          renderStep(step, null);
          setupAdvancement(step, null);
          return;
        }
        const target = querySelectors(step.target);
        if (target) onTargetReady(step, target);
        else waitForTarget(step);
      });
    }
  }, 200);
  addCleanup(() => clearInterval(handle));
}

// Watch for the target to appear in the DOM. MutationObserver replaces
// the previous 100ms scan loop. A safety timeout still bounds how long
// we wait, but on timeout we now announce the failure rather than going
// silent.
function waitForTarget(step) {
  const sel = selectorString(step.target);
  let resolved = false;

  const observer = new MutationObserver(() => {
    if (resolved || !tour.active) return;
    const el = document.querySelector(sel);
    if (el) {
      resolved = true;
      observer.disconnect();
      clearTimeout(timeoutId);
      onTargetReady(step, el);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // 30s safety timeout — far less than the old 60s and now produces a
  // user-facing message instead of disappearing silently.
  const timeoutId = setTimeout(() => {
    if (resolved || !tour.active) return;
    resolved = true;
    observer.disconnect();
    endTutorial('failed');
  }, 30000);

  addCleanup(() => { observer.disconnect(); clearTimeout(timeoutId); });
}

// Step-specific entry behavior. Each step can declare its own prime()
// function (e.g. step 3 artificially marks the figure as owned, step 4
// snapshots+clears the figure status for a clean demo). Prime functions
// are responsible for registering their own cleanup via addCleanup() so
// the original state is restored on every exit path (Next, Skip, Esc,
// browser back, tour fail).
function primeIfNeeded(step, target) {
  if (typeof step.prime === 'function') {
    try { step.prime(target); }
    catch (err) { console.warn('tutorial prime failed:', err); }
  }
  // Cycle-demo's priming has special structure (depends on target) and
  // is kept here so the snapshot/cleanup logic is co-located with the
  // setupCycleDemo state-tracking that uses it.
  if (step.advance && step.advance.type === 'cycle-demo') {
    primeCycleDemo(step, target);
  }
}

function primeCycleDemo(step, target) {
  if (!target) return;
  const row = target.closest('[data-fig-id]');
  const figId = row?.dataset?.figId;
  if (!figId) return;

  const original = S.coll[figId];
  // structuredClone is available in state.js's _clone but not exported;
  // use a direct deep clone here to avoid coupling.
  tour.cycleSnapshot = {
    figId,
    entry: original ? structuredClone(original) : null,
  };
  // Restore on cleanup, regardless of how the step ends.
  addCleanup(() => {
    const snap = tour.cycleSnapshot;
    if (!snap) return;
    tour.cycleSnapshot = null;
    if (snap.entry) S.coll[snap.figId] = snap.entry;
    else delete S.coll[snap.figId];
    if (window.saveColl) window.saveColl();
    if (window.render) window.render();
  });

  // Prime to cleared state for a clean demo
  if (S.coll[figId]?.status) {
    delete S.coll[figId].status;
    if (window.saveColl) window.saveColl();
    if (window.render) window.render();
  }
}

// ── Spotlight tracking ───────────────────────────────────────────────
//
// As the DOM updates (cycleStatus rerenders the row, list scroll,
// orientation change) the highlighted target moves. We track it via:
//   • ResizeObserver on the target — fires when it resizes
//   • MutationObserver on document.body — re-resolves the selector when
//     the original node is replaced
//   • scroll listener (passive) — handles list scrolling
// All three reposition both the overlay and the tooltip.

function startTracking(step) {
  let lastSig = '';
  let rafQueued = false;
  let ro = null;
  let lastResizeTarget = null;

  // Resolve the element used for *placement* and *sig comparison*.
  // For tooltipAnchor='row', this is the parent row, not the small
  // target inside it. Critical for step 4: the .quick-own status
  // circle scales 1.0→1.25→1.0 during cycleStatus's triggerPulse
  // animation. If sig used the target's bbox, the pulse would trip
  // sig changes on every tap and trigger an unnecessary reposition
  // (which itself produces a one-frame flash even when the math
  // resolves to the same final placement). The row's bbox is stable
  // through the pulse, so sig stays unchanged and reposition skips.
  const resolveAnchor = (cur) => {
    const anchor = step.tooltipAnchor || 'target';
    if (anchor === 'row') {
      return cur.closest('.fig-row, .fig-card, [data-fig-id]') || cur;
    }
    return cur;
  };

  const reposition = () => {
    if (!tour.active) return;
    // Re-resolve in case the original node was replaced by a render
    // (patchFigRow rewrites .fig-actions innerHTML on every cycle tap,
    // which destroys and recreates the .quick-own element).
    const cur = querySelectors(step.target);
    if (!cur) return;

    // Re-attach ResizeObserver if the underlying node was swapped
    if (cur !== lastResizeTarget) {
      if (ro) ro.disconnect();
      ro = new ResizeObserver(scheduleReposition);
      ro.observe(cur);
      lastResizeTarget = cur;
    }

    const anchorEl = resolveAnchor(cur);
    const r = anchorEl.getBoundingClientRect();
    // Round to integer pixels so sub-pixel jitter from re-renders
    // doesn't trip a sig change.
    const sig = Math.round(r.top) + ',' + Math.round(r.left) + ',' +
                Math.round(r.width) + ',' + Math.round(r.height);
    if (sig === lastSig) return;
    lastSig = sig;
    const overlay = document.getElementById('tutorialOverlay');
    const tip = document.getElementById('tutorialTooltip');
    if (overlay) positionOverlay(overlay, cur, step);
    if (tip) positionTooltip(tip, cur, step);
  };

  // rAF coalescing — many MutationObserver callbacks can fire in one
  // task; we only need to reposition once per frame.
  const scheduleReposition = () => {
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(() => {
      rafQueued = false;
      reposition();
    });
  };

  // Single subtree observer handles both target-replacement detection
  // and ResizeObserver rebinding via the unified reposition path.
  // We filter out mutations that originate inside the tutorial dialog
  // itself: the dialog's own incremental updates (headline text,
  // cycle-progress class toggles, etc.) cannot have moved the
  // spotlight target, so reacting to them is wasted work — and
  // worse, can produce a visible flash when positionTooltip runs
  // for an unchanged geometry.
  const mo = new MutationObserver((mutations) => {
    const tip = document.getElementById('tutorialTooltip');
    if (tip) {
      let allInsideDialog = true;
      for (const m of mutations) {
        if (!tip.contains(m.target)) { allInsideDialog = false; break; }
      }
      if (allInsideDialog) return;
    }
    scheduleReposition();
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // Initial bind
  reposition();

  // Scroll repositioning — tooltip and spotlight are viewport-fixed,
  // so any scrolling needs a refresh. Capture phase catches scroll
  // events from any scroll container.
  const onScroll = () => scheduleReposition();
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });

  addCleanup(() => {
    mo.disconnect();
    if (ro) ro.disconnect();
    window.removeEventListener('scroll', onScroll, { capture: true });
  });
}

// ── Advancement ──────────────────────────────────────────────────────

function setupAdvancement(step, target) {
  const adv = step.advance || { type: 'always' };

  if (adv.type === 'state') {
    // Poll predicate at 150ms while we wait. Bounded by step lifetime
    // and torn down via cleanup. (state.js has no subscribe API or
    // we'd avoid the interval entirely.)
    const handle = setInterval(() => {
      if (!tour.active) { clearInterval(handle); return; }
      if (adv.when && adv.when()) {
        clearInterval(handle);
        // Let the navigation render settle before showing next step
        requestAnimationFrame(() => showStep(tour.stepIdx + 1));
      }
    }, 150);
    addCleanup(() => clearInterval(handle));
    return;
  }

  if (adv.type === 'cycle-demo' && target) {
    setupCycleDemo(step, target);
    return;
  }

  // 'always' — Next/Finish button handles advancement (rendered in renderStep)
}

// Cycle demo: track which states the user has visited. Driven by a
// document-level click listener on the spotlight target rather than a
// polling loop. After each click we read the new status in a microtask
// (handlers.cycleStatus runs synchronously then calls render(), so by
// the next microtask S.coll[figId].status is already updated).
function setupCycleDemo(step, target) {
  const figId = target.closest('[data-fig-id]')?.dataset?.figId;
  if (!figId) {
    // Fall back to manual Next if we can't identify the figure
    tour.cycleSeen = new Set();
    renderCycleProgress(tour.cycleSeen, true);
    return;
  }

  tour.cycleSeen = new Set();
  let lastStatus = (S.coll[figId]?.status) || '';
  renderCycleProgress(tour.cycleSeen, false);

  // Click handler — fires when user clicks anywhere; we filter to the
  // specific spotlit figure (not just any .quick-own — clicking a
  // different row's status circle should not advance the demo). Capture
  // phase so we register the intent before handlers.cycleStatus
  // re-renders and detaches the original node.
  const onClick = (ev) => {
    if (!tour.active) return;
    // Match by figId on the clicked row, scoped to .quick-own to ignore
    // clicks elsewhere on the row (figure-name link, etc.).
    const rowOfClick = ev.target.closest('[data-fig-id]');
    if (!rowOfClick || rowOfClick.dataset.figId !== figId) return;
    if (!ev.target.closest('.quick-own')) return;

    // Read status after the click handler runs and re-render commits.
    // Use rAF rather than microtask because handlers.cycleStatus calls
    // render() which may itself defer.
    requestAnimationFrame(() => {
      if (!tour.active) return;
      const cur = (S.coll[figId]?.status) || '';
      if (cur === lastStatus) return;
      lastStatus = cur;
      tour.cycleSeen.add(cur);
      const enough = tour.cycleSeen.size >= CYCLE_MIN_STATES;
      renderCycleProgress(tour.cycleSeen, enough);
      announceLive(`Status: ${CYCLE_LABEL[cur]}. ${tour.cycleSeen.size} of ${CYCLE_ORDER.length} seen.`);
    });
  };
  document.addEventListener('click', onClick, true);
  addCleanup(() => document.removeEventListener('click', onClick, true));
}

// ── Rendering ────────────────────────────────────────────────────────
//
// The tooltip is built once via document.createElement (no innerHTML
// for the structural shell) and updated in place across step changes
// when it makes sense to do so. We do still set body.innerHTML for the
// step body — the body comes from STEPS (author-controlled, no user
// data interpolated), so it's safe.

function ensureLiveRegion() {
  let live = document.getElementById('tutorialLive');
  if (live) return live;
  live = document.createElement('div');
  live.id = 'tutorialLive';
  live.className = 'sr-only';        // existing visually-hidden helper in vault.css
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  document.body.appendChild(live);
  return live;
}

function announceLive(msg) {
  const live = document.getElementById('tutorialLive') || ensureLiveRegion();
  // Toggle text to retrigger announcement even when message repeats
  live.textContent = '';
  // Microtask defer — many ATs need the empty→content transition
  requestAnimationFrame(() => { if (tour.active) live.textContent = msg; });
}

function buildTooltipShell() {
  const tip = document.createElement('div');
  tip.id = 'tutorialTooltip';
  tip.className = 'tutorial-tooltip';
  tip.setAttribute('role', 'dialog');
  tip.setAttribute('aria-modal', 'true');
  tip.setAttribute('aria-labelledby', 'tutorialTitle');
  tip.setAttribute('aria-describedby', 'tutorialBody');
  // v6.23: hide the freshly-created tooltip until the first
  // positionTooltip() call settles it. positionTooltip clears this on
  // first run; subsequent step transitions leave visibility alone, which
  // eliminates the inter-step blink the previous version produced
  // (visibility:hidden was being toggled on every reposition).
  tip.style.visibility = 'hidden';

  const stepCount = document.createElement('div');
  stepCount.className = 'tutorial-step-count';
  // Title doubles as visible step count + screen-reader title
  stepCount.id = 'tutorialTitle';

  const text = document.createElement('div');
  text.className = 'tutorial-text';
  text.id = 'tutorialBody';

  const actions = document.createElement('div');
  actions.className = 'tutorial-actions';

  tip.appendChild(stepCount);
  tip.appendChild(text);
  tip.appendChild(actions);
  return tip;
}

function renderStep(step, target, hint) {
  let overlay = document.getElementById('tutorialOverlay');
  let tip = document.getElementById('tutorialTooltip');

  ensureLiveRegion();

  // Overlay — built/destroyed depending on step preference
  if (step.showOverlay !== false) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'tutorialOverlay';
      overlay.className = 'tutorial-overlay';
      // Make the dim a presentation-only layer; aria-hidden so AT
      // doesn't dive into it.
      overlay.setAttribute('aria-hidden', 'true');
      document.body.appendChild(overlay);
    }
    overlay.classList.toggle('pulse', step.pulse !== false && !tour.reducedMotion);
    positionOverlay(overlay, target, step);
  } else if (overlay) {
    overlay.remove();
  }

  // Tooltip shell — built once
  if (!tip) {
    tip = buildTooltipShell();
    document.body.appendChild(tip);
  }
  tip.classList.toggle('compact', !!step.compact);

  // Step counter / title
  const stepNum = tour.stepIdx + 1;
  const total = STEPS.length;
  const stepCountEl = tip.querySelector('#tutorialTitle');
  // Visible label uses Step N of M; aria-label gives screen readers a
  // more descriptive title combining step + step.title.
  stepCountEl.textContent = `Step ${stepNum} of ${total}`;
  stepCountEl.setAttribute('aria-label', `Step ${stepNum} of ${total}: ${step.title}`);

  // Body — hint + body + instruction
  const bodyEl = tip.querySelector('#tutorialBody');
  bodyEl.innerHTML = '';
  if (hint) {
    const hintEl = document.createElement('em');
    hintEl.className = 'tutorial-hint';
    hintEl.textContent = hint;
    bodyEl.appendChild(hintEl);
    bodyEl.appendChild(document.createElement('br'));
    bodyEl.appendChild(document.createElement('br'));
  }
  if (step.body) {
    const bodyHtml = document.createElement('span');
    bodyHtml.innerHTML = step.body; // STEPS body is author-controlled, no user data
    bodyEl.appendChild(bodyHtml);
  }
  if (step.instruction) {
    if (step.body) {
      bodyEl.appendChild(document.createElement('br'));
      bodyEl.appendChild(document.createElement('br'));
    }
    const instr = document.createElement('span');
    instr.innerHTML = step.instruction;
    bodyEl.appendChild(instr);
  }

  // Actions
  renderActions(tip, step);

  // Position
  positionTooltip(tip, target, step);

  // Move focus into the dialog (title element with tabindex=-1) so AT
  // announces the step. Skip for the cycle-demo step's progress
  // updates, which use the live region instead.
  manageFocus(tip);

  // Announce step change to screen readers (covers users who skip
  // focus moves)
  announceLive(`Step ${stepNum} of ${total}. ${step.title}.`);
}

function renderActions(tip, step) {
  const actions = tip.querySelector('.tutorial-actions');
  actions.innerHTML = '';

  const adv = step.advance || { type: 'always' };
  const isAlways = adv.type === 'always';
  const isCycle  = adv.type === 'cycle-demo';
  const idx      = tour.stepIdx;

  // Skip — present on every step UNLESS the step explicitly opts out
  // via hideSkip. Used by the final "Tap Collection" step where Close
  // would let users dodge the very action the step is teaching.
  if (!step.hideSkip) {
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'tutorial-skip';
    skip.textContent = step.finalStep ? 'Close' : 'Skip tour';
    skip.addEventListener('click', () => endTutorial('skipped'));
    actions.appendChild(skip);
  }

  // Spacer pushes Back/Next to the right
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  actions.appendChild(spacer);

  // Back — for always-advance steps after step 1 only. State-driven
  // and cycle-demo steps don't show Back: state-driven steps would
  // require undoing a navigation; cycle-demo's prior step (detail
  // overview) expects to be on the figure detail screen, but by the
  // time we reach cycle-demo we're back on the list view, so Back
  // would land the user on a "Detail screen" step while not on the
  // detail screen. Skip is the correct exit there.
  // step.noBack also lets a specific step opt out (e.g. step 3, where
  // going back from the figure detail to "Open a figure" would hit a
  // navigation-state mismatch similar to cycle-demo).
  if (idx > 0 && isAlways && !step.noBack) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'tutorial-back';
    back.textContent = '← Back';
    back.addEventListener('click', () => {
      // Cleanup current step before going back
      runStepCleanup();
      showStep(idx - 1);
    });
    actions.appendChild(back);
  }

  // Next / Finish — for always-advance steps and cycle demo (when ready)
  if (isAlways || isCycle) {
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'tutorial-next';
    next.textContent = step.finalStep ? 'Finish' : 'Next →';

    if (isCycle) {
      // Disabled until enough cycle states visited
      const seen = tour.cycleSeen ? tour.cycleSeen.size : 0;
      const ready = seen >= CYCLE_MIN_STATES;
      next.disabled = !ready;
      if (!ready) {
        next.setAttribute('aria-disabled', 'true');
        next.title = `Cycle through at least ${CYCLE_MIN_STATES} statuses to continue`;
      }
    }

    next.addEventListener('click', () => {
      if (next.disabled) return;
      // v6.23: run step cleanup BEFORE onNext so any data restoration
      // (e.g. step 3 unmarking the artificial "owned" state) completes
      // before the navigation re-renders the destination screen. Without
      // this, the destination would briefly show artificial state until
      // showStep's own cleanup runs a frame later. cleanupFns is emptied
      // here, so showStep(idx+1)'s runStepCleanup is a harmless no-op.
      runStepCleanup();
      try { if (typeof adv.onNext === 'function') adv.onNext(); } catch (err) {
        console.warn('tutorial onNext failed:', err);
      }
      if (step.finalStep) {
        endTutorial('completed');
        return;
      }
      // After onNext (which may navigate), defer one frame so the
      // resulting render commits before we resolve the next step's
      // target. waitForTarget would handle a missing target via its
      // MutationObserver, but the rAF avoids a flash of the next
      // dialog over the prior view.
      requestAnimationFrame(() => showStep(tour.stepIdx + 1));
    });
    actions.appendChild(next);
  }
}

// ── Cycle demo progress UI ───────────────────────────────────────────
//
// v6.23: this used to rebuild the dialog body on every tap (innerHTML
// clear + re-append), which produced a visible flash between cycle
// taps — there's a frame where the body is empty before the new content
// lands. The refactored version builds the static structure once and
// then mutates only what changed:
//   • headline text/class (transitions at 3-of-5 and 5-of-5 thresholds)
//   • per-row .seen class (CSS handles the ✓ fade-in)
//   • Next button's disabled state (no need to rebuild the whole
//     actions row, which itself caused subtle button-shape churn)
// Position is unchanged — content height is stable across taps.

function buildCycleStructure(bodyEl) {
  bodyEl.innerHTML = '';

  const headline = document.createElement('div');
  headline.className = 'cycle-headline';
  bodyEl.appendChild(headline);

  const list = document.createElement('div');
  list.className = 'cycle-list';
  for (const s of CYCLE_ORDER) {
    const row = document.createElement('div');
    row.className = 'cycle-row';
    row.dataset.state = s || 'cleared';

    const dot = document.createElement('span');
    dot.className = 'cycle-dot s-' + (s || 'cleared');
    row.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'cycle-label';
    label.textContent = CYCLE_LABEL[s];
    row.appendChild(label);

    // Pre-create the check; CSS hides it via opacity:0 unless the row
    // also has .seen. Pre-creating avoids any layout shift when toggling
    // the seen state — and avoids the parent flash from creating/
    // destroying child nodes mid-tap.
    const check = document.createElement('span');
    check.className = 'cycle-check';
    check.textContent = '✓';
    check.setAttribute('aria-hidden', 'true');
    row.appendChild(check);

    list.appendChild(row);
  }
  bodyEl.appendChild(list);
}

function renderCycleProgress(seenSet, ready) {
  const tip = document.getElementById('tutorialTooltip');
  if (!tip) return;
  const bodyEl = tip.querySelector('#tutorialBody');
  if (!bodyEl) return;

  // Build static structure on first invocation. After that, every call
  // is a targeted update that doesn't touch innerHTML.
  let list = bodyEl.querySelector('.cycle-list');
  const isFirstBuild = !list;
  if (isFirstBuild) {
    buildCycleStructure(bodyEl);
    list = bodyEl.querySelector('.cycle-list');
    // Render actions once, then update Next.disabled in place on
    // subsequent calls.
    renderActions(tip, STEPS[tour.stepIdx]);
  }

  // Update headline text in place — three states. Messages deliberately
  // don't reference the "Next" button (the button is two rows below;
  // mentioning it in body text reads as a duplicate) and don't include
  // a "(N of 5)" count (the cycle-list itself is the progress meter —
  // each visited state lights up its row).
  const headline = bodyEl.querySelector('.cycle-headline');
  if (headline) {
    const total = CYCLE_ORDER.length; // 5
    const seen = seenSet.size;
    if (seen >= total) {
      headline.className = 'cycle-headline tutorial-cycle-done';
      headline.textContent = '✓ Full cycle complete.';
    } else if (ready) {
      headline.className = 'cycle-headline tutorial-cycle-progress';
      headline.textContent = 'Got the hang of it. Keep cycling or move on.';
    } else {
      headline.className = 'cycle-headline';
      headline.innerHTML = '<strong>Tap the highlighted circle</strong> to cycle through statuses.';
    }
  }

  // Toggle .seen on each row — CSS handles the visual transition
  for (const s of CYCLE_ORDER) {
    const key = s || 'cleared';
    const row = list.querySelector(`.cycle-row[data-state="${key}"]`);
    if (row) row.classList.toggle('seen', seenSet.has(s));
  }

  // Update Next button's disabled state without rebuilding the actions row
  const nextBtn = tip.querySelector('.tutorial-next');
  if (nextBtn) {
    nextBtn.disabled = !ready;
    if (ready) {
      nextBtn.removeAttribute('aria-disabled');
      nextBtn.removeAttribute('title');
    } else {
      nextBtn.setAttribute('aria-disabled', 'true');
      nextBtn.title = `Cycle through at least ${CYCLE_MIN_STATES} statuses to continue`;
    }
  }

  // Position only on first build — content height is stable across taps,
  // so subsequent positionTooltip calls are unnecessary work that can
  // cause subtle reflow flicker on lower-end devices.
  if (isFirstBuild) {
    const target = querySelectors(STEPS[tour.stepIdx].target);
    if (target) positionTooltip(tip, target, STEPS[tour.stepIdx]);
  }
}

// ── Focus management & keyboard ──────────────────────────────────────

function manageFocus(tip) {
  // Move focus to the dialog title so the dialog name is the first
  // thing AT announces. The title element is given tabindex=-1 only
  // for this purpose.
  const title = tip.querySelector('#tutorialTitle');
  if (!title) return;
  title.setAttribute('tabindex', '-1');
  // Defer one frame so the dialog is fully laid out
  requestAnimationFrame(() => {
    if (!tour.active) return;
    try { title.focus({ preventScroll: true }); } catch {}
  });
}

// Build the cycling focus list: [skip, back?, next?, spotlight target?].
// Including the spotlight target lets keyboard users actually interact
// with what the tour is pointing at (the bottom-nav button, status
// circle, etc.) rather than being trapped only on dialog buttons.
function getFocusables() {
  const tip = document.getElementById('tutorialTooltip');
  const list = [];
  if (tip) {
    tip.querySelectorAll('button').forEach(b => {
      if (!b.disabled) list.push(b);
    });
  }
  const step = STEPS[tour.stepIdx];
  if (step?.target) {
    const t = querySelectors(step.target);
    if (t && t.tabIndex !== -1 && !t.disabled) list.push(t);
  }
  return list;
}

function trapTab(ev) {
  if (ev.key !== 'Tab') return;
  const list = getFocusables();
  if (!list.length) return;
  const active = document.activeElement;
  const idx = list.indexOf(active);
  ev.preventDefault();
  if (ev.shiftKey) {
    const prev = idx <= 0 ? list[list.length - 1] : list[idx - 1];
    try { prev.focus({ preventScroll: false }); } catch {}
  } else {
    const next = idx === -1 || idx === list.length - 1 ? list[0] : list[idx + 1];
    try { next.focus({ preventScroll: false }); } catch {}
  }
}

function installGlobalKeyHandlers() {
  const onKey = (ev) => {
    if (!tour.active) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      endTutorial('skipped');
      return;
    }
    if (ev.key === 'Tab') {
      trapTab(ev);
      return;
    }
    // Optional ←/→ for always-advance steps. State-driven steps
    // intentionally don't accept arrow nav since the user must perform
    // the spotlit action.
    const step = STEPS[tour.stepIdx];
    const adv = step?.advance || {};
    const isManual = adv.type === 'always' || adv.type === 'cycle-demo';
    if (!isManual) return;

    if (ev.key === 'ArrowRight') {
      const tip = document.getElementById('tutorialTooltip');
      const next = tip?.querySelector('.tutorial-next');
      if (next && !next.disabled) { ev.preventDefault(); next.click(); }
    } else if (ev.key === 'ArrowLeft') {
      const tip = document.getElementById('tutorialTooltip');
      const back = tip?.querySelector('.tutorial-back');
      if (back) { ev.preventDefault(); back.click(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  addGlobalCleanup(() => document.removeEventListener('keydown', onKey, true));
}

// ── Positioning ──────────────────────────────────────────────────────

function positionOverlay(overlay, target, step) {
  if (!target) {
    overlay.style.cssText = 'top:50%;left:50%;width:0;height:0';
    overlay.classList.add('no-target');
    return;
  }
  overlay.classList.remove('no-target');
  const r = target.getBoundingClientRect();
  const pad = 6;
  overlay.style.top    = (r.top - pad) + 'px';
  overlay.style.left   = (r.left - pad) + 'px';
  overlay.style.width  = (r.width + pad * 2) + 'px';
  overlay.style.height = (r.height + pad * 2) + 'px';
}

function positionTooltip(tip, target, step) {
  const anchor = step.tooltipAnchor || 'target';
  const margin = 18;

  // Reveals the tooltip iff it's still hidden from initial creation.
  // Subsequent calls (after first reveal) are no-ops.
  const reveal = () => {
    if (tour.active && tip.style.visibility === 'hidden') {
      tip.style.visibility = '';
    }
  };

  // v6.23: positioning is set atomically — we never write `top:auto`
  // or `bottom:auto` at the start and then set the real value in a
  // later rAF. That intermediate "no positioning" state caused a
  // one-frame flash whenever positionTooltip was called for an
  // already-rendered dialog (which happens whenever any sig change
  // trips the reposition path). Instead we compute everything
  // synchronously, set only the styles that need to change, and
  // explicitly clear the *opposite* side after setting the active one.

  if (anchor === 'bottom-fixed') {
    tip.style.left = '12px';
    tip.style.right = '12px';
    tip.style.top = 'auto';
    tip.style.bottom = 'calc(20px + var(--safe-bottom, 0px))';
    tip.style.transform = '';
    tip.classList.remove('arrow-down', 'arrow-up');
    requestAnimationFrame(reveal);
    return;
  }

  if (!target) {
    tip.style.left = '12px';
    tip.style.right = '12px';
    tip.style.bottom = 'auto';
    tip.style.top = '50%';
    tip.style.transform = 'translateY(-50%)';
    tip.classList.remove('arrow-down', 'arrow-up');
    requestAnimationFrame(reveal);
    return;
  }

  // For 'row' anchor, use the row/card box rather than the tiny target
  // (e.g. 24px status circle). Gives more space for placement and
  // avoids the tooltip ever covering the small target. Critically,
  // it also stays stable through the pulse animation that scales the
  // status circle on every cycleStatus call.
  let anchorEl = target;
  if (anchor === 'row') {
    anchorEl = target.closest('.fig-row, .fig-card, [data-fig-id]') || target;
  }
  const r = anchorEl.getBoundingClientRect();
  const vh = window.innerHeight;
  const spaceAbove = r.top - margin;
  const spaceBelow = vh - r.bottom - margin;

  // Read tooltip height synchronously. On the very first paint, the
  // tooltip is visibility:hidden but already in the DOM with content,
  // so offsetHeight reflects content size. If for some reason it's
  // 0 (race with content build), fall back to a reasonable estimate
  // so we don't make a placement decision against zero space.
  const tipH = tip.offsetHeight || 200;
  const preferred = step.placement || 'auto';
  let placement;
  if (preferred === 'top') placement = 'top';
  else if (preferred === 'bottom') placement = 'bottom';
  else placement = spaceAbove >= spaceBelow ? 'top' : 'bottom';

  // Flip if chosen side doesn't fit
  if (placement === 'top' && tipH > spaceAbove && tipH <= spaceBelow) {
    placement = 'bottom';
  } else if (placement === 'bottom' && tipH > spaceBelow && tipH <= spaceAbove) {
    placement = 'top';
  }

  tip.style.left = '12px';
  tip.style.right = '12px';
  tip.style.transform = '';
  if (placement === 'top') {
    // Set the active edge first, then clear the inactive edge — never
    // a frame where both are auto.
    tip.style.bottom = (vh - r.top + margin) + 'px';
    tip.style.top = 'auto';
    tip.classList.remove('arrow-up');
    tip.classList.add('arrow-down');
  } else {
    tip.style.top = (r.bottom + margin) + 'px';
    tip.style.bottom = 'auto';
    tip.classList.remove('arrow-down');
    tip.classList.add('arrow-up');
  }
  requestAnimationFrame(reveal);
}

// ── Resize handling ──────────────────────────────────────────────────
//
// Installed only while the tour is active. Repositions both overlay
// and tooltip on viewport changes (orientation, keyboard open/close).

function installResizeHandler() {
  const onResize = () => {
    if (!tour.active) return;
    const step = STEPS[tour.stepIdx];
    if (!step) return;
    const target = step.target ? querySelectors(step.target) : null;
    const tip = document.getElementById('tutorialTooltip');
    const overlay = document.getElementById('tutorialOverlay');
    if (overlay) positionOverlay(overlay, target, step);
    if (tip) positionTooltip(tip, target, step);
  };
  window.addEventListener('resize', onResize);
  // Visual viewport API catches iOS keyboard show/hide more reliably
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onResize);
    addGlobalCleanup(() => window.visualViewport.removeEventListener('resize', onResize));
  }
  addGlobalCleanup(() => window.removeEventListener('resize', onResize));
}

// ── Click trap ───────────────────────────────────────────────────────
//
// v6.23: while the tour is active, block clicks anywhere except the
// dialog itself and the spotlight target. Without this, a stray tap
// outside the spotlight could navigate, mutate data, or open menus
// behind the overlay (the overlay has pointer-events:none so it can
// be visually translucent; clicks pass through it).
//
// We listen in the capture phase on `document` so our handler fires
// before any element-level listeners. Click is the primary block;
// pointerdown is also blocked so buttons don't get the visual
// "pressed" state on disallowed targets, which would feel like the
// tap "almost" worked.
//
// Allowed regions:
//   - The dialog (#tutorialTooltip and descendants)
//   - The current step's spotlight target (and descendants), minus
//     anything matching step.excludeClicks (e.g. step 2 excludes the
//     status circle to prevent accidental status mutation when the
//     intent is to navigate to detail).

function installClickTrap() {
  const isAllowed = (evTarget) => {
    const tip = document.getElementById('tutorialTooltip');
    if (tip && tip.contains(evTarget)) return true;
    const step = STEPS[tour.stepIdx];
    if (!step || !step.target) return false;
    const t = querySelectors(step.target);
    if (!t) return false;
    if (t !== evTarget && !t.contains(evTarget)) return false;
    // Inside the spotlight — but check excludeClicks (sub-zones the
    // step explicitly bars even though they're visually within the
    // spotlight).
    if (step.excludeClicks) {
      const excluded = evTarget.closest(step.excludeClicks);
      if (excluded && t.contains(excluded)) return false;
    }
    return true;
  };

  const block = (ev) => {
    if (!tour.active) return;
    if (isAllowed(ev.target)) return;
    ev.preventDefault();
    ev.stopPropagation();
  };

  // Capture phase so we run before element-level listeners. We block
  // 'click' only (not pointerdown/touchstart) — preventDefault on the
  // press half of a tap can suppress native touch scrolling, which we
  // need to remain functional (especially on step 3, where the user
  // is supposed to scroll the figure detail screen). Click fires only
  // on tap-release, so blocking click stops button activation while
  // letting scroll gestures complete normally.
  document.addEventListener('click', block, true);
  addGlobalCleanup(() => {
    document.removeEventListener('click', block, true);
  });
}

// ── Window exposure ──────────────────────────────────────────────────

window.startTutorial = startTutorial;
window.tutorialState = tutorialState;

export { startTutorial, tutorialState };
