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
    advance: {
      type: 'always',
      // Use the app's named navigation rather than history.back() so the
      // tour isn't coupled to a particular history-stack shape.
      onNext: () => {
        if (typeof window.navTo === 'function') window.navTo('all');
        else if (history.length > 1) history.back();
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
  },
];

// ── Tour state (single source of truth) ──────────────────────────────

const tour = {
  active: false,
  stepIdx: 0,
  triggerEl: null,        // element that started the tour, for focus return
  cleanupFns: [],         // per-step cleanup (observers, listeners)
  globalCleanupFns: [],   // tour-wide cleanup (resize, key handlers)
  cycleSnapshot: null,    // { figId, entry } for restore on exit
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
  if (reason === 'completed') {
    saveState({ completed: 1 });
    if (window.toast) window.toast('🎓 Tour complete — replay anytime from the Lines screen', { duration: 3500 });
  } else if (reason === 'skipped') {
    saveState({ completed: 0 });
    if (window.toast) window.toast('Tour skipped — replay anytime from the Lines screen', { duration: 3000 });
  } else if (reason === 'failed') {
    saveState({ completed: 0 });
    if (window.toast) window.toast('Couldn\u2019t finish the tour — try again from the Lines screen', { duration: 3500 });
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

  // Pure-tooltip step (no spotlight).
  if (!step.target) {
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
  renderStep(step, null, 'Tap back to return to the figure list.');
  const handle = setInterval(() => {
    if (!tour.active) { clearInterval(handle); return; }
    if (S.screen === step.requireScreen) {
      clearInterval(handle);
      // Let the resulting render flush before resolving the target
      requestAnimationFrame(() => {
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

// Step-specific entry behavior. For the cycle demo, snapshot the
// figure's current collection entry so we can restore it on exit
// (skip, finish, or failure). Then prime status to '' so the first
// click is a clean cleared→owned transition.
function primeIfNeeded(step, target) {
  if (step.advance.type !== 'cycle-demo') return;

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

  const reposition = () => {
    if (!tour.active) return;
    // Re-resolve in case the original node was replaced
    const cur = querySelectors(step.target);
    if (!cur) return;

    // Re-attach ResizeObserver if the underlying node was swapped
    if (cur !== lastResizeTarget) {
      if (ro) ro.disconnect();
      ro = new ResizeObserver(scheduleReposition);
      ro.observe(cur);
      lastResizeTarget = cur;
    }

    const r = cur.getBoundingClientRect();
    const sig = r.top + ',' + r.left + ',' + r.width + ',' + r.height;
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
  const mo = new MutationObserver(scheduleReposition);
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

  // Skip — present on every step
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'tutorial-skip';
  skip.textContent = step.finalStep ? 'Close' : 'Skip tour';
  skip.addEventListener('click', () => endTutorial('skipped'));
  actions.appendChild(skip);

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
  if (idx > 0 && isAlways) {
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
// Build the checklist using DOM nodes instead of innerHTML strings so
// the inline status colors are CSS classes, not inline styles. The
// tooltip body is replaced; everything else on the dialog is preserved.

function renderCycleProgress(seenSet, ready) {
  const tip = document.getElementById('tutorialTooltip');
  if (!tip) return;

  const bodyEl = tip.querySelector('#tutorialBody');
  if (!bodyEl) return;

  bodyEl.innerHTML = '';

  // Headline
  const headline = document.createElement('div');
  if (ready) {
    headline.className = 'tutorial-cycle-done';
    headline.textContent = '✓ Nice — you’ve seen how the cycle works.';
  } else {
    headline.innerHTML = '<strong>Tap the highlighted circle</strong> to cycle through statuses.';
  }
  bodyEl.appendChild(headline);

  // Checklist
  const list = document.createElement('div');
  list.className = 'cycle-list';
  for (const s of CYCLE_ORDER) {
    const seen = seenSet.has(s);
    const row = document.createElement('div');
    row.className = 'cycle-row' + (seen ? ' seen' : '');

    const dot = document.createElement('span');
    // Class-based status color (no inline style); see CSS additions
    dot.className = 'cycle-dot s-' + (s || 'cleared');
    row.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'cycle-label';
    label.textContent = CYCLE_LABEL[s];
    row.appendChild(label);

    if (seen) {
      const check = document.createElement('span');
      check.className = 'cycle-check';
      check.textContent = '✓';
      check.setAttribute('aria-hidden', 'true');
      row.appendChild(check);
    }
    list.appendChild(row);
  }
  bodyEl.appendChild(list);

  // Tip — long-press OR regular tap (covers gesture-alternative UX)
  const tip2 = document.createElement('div');
  tip2.className = 'cycle-tip';
  tip2.textContent = 'Tip: tap a figure to open it for the full menu, or long-press for shortcuts.';
  bodyEl.appendChild(tip2);

  // Re-render actions so the Next button reflects ready/not ready
  renderActions(tip, STEPS[tour.stepIdx]);

  // Reposition — content height has changed
  const target = querySelectors(STEPS[tour.stepIdx].target);
  if (target) positionTooltip(tip, target, STEPS[tour.stepIdx]);
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

  // Reset positioning state
  tip.style.left = '12px';
  tip.style.right = '12px';
  tip.style.top = 'auto';
  tip.style.bottom = 'auto';
  tip.style.transform = '';
  tip.style.visibility = 'hidden';
  tip.classList.remove('arrow-down', 'arrow-up');

  if (anchor === 'bottom-fixed') {
    tip.style.bottom = 'calc(20px + var(--safe-bottom, 0px))';
    requestAnimationFrame(() => {
      if (tour.active) tip.style.visibility = '';
    });
    return;
  }

  if (!target) {
    tip.style.top = '50%';
    tip.style.transform = 'translateY(-50%)';
    requestAnimationFrame(() => {
      if (tour.active) tip.style.visibility = '';
    });
    return;
  }

  // For 'row' anchor, use the row/card box rather than the tiny target
  // (e.g. 24px status circle). Gives more space for placement and
  // avoids the tooltip ever covering the small target.
  let anchorEl = target;
  if (anchor === 'row') {
    anchorEl = target.closest('.fig-row, .fig-card, [data-fig-id]') || target;
  }
  const r = anchorEl.getBoundingClientRect();
  const vh = window.innerHeight;
  const spaceAbove = r.top - margin;
  const spaceBelow = vh - r.bottom - margin;

  requestAnimationFrame(() => {
    if (!tour.active) return;
    const tipH = tip.offsetHeight;
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

    if (placement === 'top') {
      tip.style.bottom = (vh - r.top + margin) + 'px';
      tip.style.top = 'auto';
      tip.classList.add('arrow-down');
    } else {
      tip.style.top = (r.bottom + margin) + 'px';
      tip.style.bottom = 'auto';
      tip.classList.add('arrow-up');
    }
    tip.style.visibility = '';
  });
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

// ── Window exposure ──────────────────────────────────────────────────

window.startTutorial = startTutorial;
window.tutorialState = tutorialState;

export { startTutorial, tutorialState };
