// MOTU Vault — Tutorial Walkthrough (v6.20)
// ─────────────────────────────────────────────
// Action-driven coachmark tour. Spotlights real UI elements, waits for
// real user actions, advances when those actions happen.
//
// Triggered from the Getting Started banner on the Lines screen.
// Persistent "Skip tour" button in every step.
//
// Storage:
//   motu-tutorial-seen — set to 1 once the user finishes or skips.
//
// Step model:
//   target:     CSS selector for the spotlight, or null for a pure
//               tooltip step (no dim, no spotlight)
//   tooltipAnchor: 'target' (default), 'row' (anchor to the row that
//               contains the target — better for narrow circles), or
//               'bottom-fixed' (pinned to the screen bottom).
//   text:       HTML for the tooltip
//   placement:  'top' | 'bottom' | 'auto' (only when tooltipAnchor is
//               not 'bottom-fixed')
//   advanceOn:  'screen' (S.screen/S.tab change) | 'always' (Next button)
//               | 'cycle-demo' (interactive status-cycle demo)
//   waitFor:    for advanceOn:'screen', { screen?, tab? }
//   requireScreen: don't try to find target until S.screen matches this
//   nextLabel:  custom Next button label
//   onNext:     side-effect to run when Next is pressed
//   showOverlay: false to suppress the dim/spotlight entirely (e.g.
//                step 3 detail screen — the user needs to read it)
//   pulse:      true (default) for animated outline; false for static

import { S, store } from './state.js';

// Cycle order matches handlers.js STATUS_CYCLE: owned → wishlist → ordered
// → for-sale → cleared. With a starting status of '' (cleared), the first
// click runs setStatus(...,'owned'); subsequent clicks run cycleStatus and
// walk the array. Five clicks total visit every visual state.
const CYCLE_ORDER = ['owned', 'wishlist', 'ordered', 'for-sale', ''];
const CYCLE_LABEL = {
  owned: 'Owned',
  wishlist: 'Wishlist',
  ordered: 'Ordered',
  'for-sale': 'For Sale',
  '': 'Cleared',
};
const CYCLE_HEX = {
  owned: '#34d399',
  wishlist: '#60a5fa',
  ordered: '#fb923c',
  'for-sale': '#f87171',
  '': '#6b7280',
};

const STEPS = [
  // Step 1 — bottom nav, send them to All
  {
    target: '.bottom-nav button:nth-child(2)',
    text: 'Three views at the bottom: <strong>Lines</strong> (browse by era), <strong>All</strong> (full catalog), <strong>Collection</strong> (what you own).<br><br>Tap <strong>All</strong> to continue.',
    placement: 'top',
    advanceOn: 'screen',
    waitFor: { tab: 'all' },
  },

  // Step 2 — tap any figure
  {
    target: '.fig-row[data-fig-id], .fig-card[data-fig-id]',
    tooltipAnchor: 'target',
    text: 'Tap any figure name to open its details.',
    placement: 'auto',
    advanceOn: 'screen',
    waitFor: { screen: 'figure' },
  },

  // Step 3 — detail screen overview. No overlay so user can scroll & read.
  // Compact translucent tooltip so the detail content is visible behind it.
  {
    target: null,
    showOverlay: false,
    tooltipAnchor: 'bottom-fixed',
    compact: true,
    text: '<strong>Detail screen.</strong> Scroll to explore. Tap <strong>Next</strong> when ready.',
    advanceOn: 'always',
    nextLabel: 'Next →',
    onNext: () => { try { history.back(); } catch {} },
  },

  // Step 4 — interactive status cycle demo
  {
    target: '.fig-row[data-fig-id] .quick-own, .fig-card[data-fig-id] .quick-own',
    tooltipAnchor: 'row', // anchor to the whole row, not the small circle
    text: '', // built dynamically from CYCLE_ORDER
    placement: 'top',
    advanceOn: 'cycle-demo',
    requireScreen: 'main',
  },

  // Step 5 — Collection tab. Tapping the spotlit tab auto-closes the tour.
  {
    target: '.bottom-nav button:nth-child(3)',
    text: '<strong>Collection</strong> shows just the figures you own. Tap any status circle to start filling it.<br><br>Tap <strong>Collection</strong> to finish the tour.',
    placement: 'top',
    advanceOn: 'screen',
    waitFor: { tab: 'collection' },
    finalStep: true,
  },
];

let _stepIdx = 0;
let _active = false;
let _scanInterval = null;
let _screenWatcher = null;
let _clickListener = null;
let _trackInterval = null; // re-positions the spotlight as DOM updates

function startTutorial() {
  if (_active) return;
  _active = true;
  _stepIdx = 0;
  if (S.screen !== 'main' || S.tab !== 'lines') {
    if (window.navTo) window.navTo('lines');
  }
  setTimeout(() => showStep(0), 150);
}

function endTutorial(completed) {
  _active = false;
  cleanup();
  document.getElementById('tutorialOverlay')?.remove();
  document.getElementById('tutorialTooltip')?.remove();
  if (completed) {
    store.set('motu-tutorial-seen', 1);
    if (window.toast) window.toast('🎓 Tutorial complete', { duration: 2000 });
  }
}

function cleanup() {
  if (_scanInterval) { clearInterval(_scanInterval); _scanInterval = null; }
  if (_screenWatcher) { clearInterval(_screenWatcher); _screenWatcher = null; }
  if (_trackInterval) { clearInterval(_trackInterval); _trackInterval = null; }
  if (_clickListener) {
    document.removeEventListener('click', _clickListener, true);
    _clickListener = null;
  }
}

function showStep(idx) {
  if (!_active) return;
  if (idx >= STEPS.length) { endTutorial(true); return; }
  _stepIdx = idx;
  const step = STEPS[idx];
  cleanup();

  // For the cycle-demo step, pre-clear the figure status so the first
  // click definitely runs setStatus(...,'owned') as a clean cleared→owned
  // transition. Without this, a figure that's already "owned" would skip
  // to wishlist on first click and confuse the demo counter.
  if (step.advanceOn === 'cycle-demo') {
    // Defer the actual reset until we've found a target (we need the figId)
  }

  if (step.target == null) {
    renderStep(step, null);
    setupAdvancement(step, null);
    return;
  }

  if (step.requireScreen && S.screen !== step.requireScreen) {
    waitForScreenThenFindTarget(step);
  } else {
    findTargetAndShow(step);
  }
}

function waitForScreenThenFindTarget(step) {
  renderStep(step, null, 'Tap back to return to the figure list.');
  _screenWatcher = setInterval(() => {
    if (!_active) return;
    if (S.screen === step.requireScreen) {
      clearInterval(_screenWatcher);
      _screenWatcher = null;
      setTimeout(() => findTargetAndShow(step), 250);
    }
  }, 200);
}

function findTargetAndShow(step) {
  const target = document.querySelector(step.target);
  if (target) {
    primeStepIfNeeded(step, target);
    renderStep(step, target);
    startTracking(step, target);
    setupAdvancement(step, target);
    return;
  }
  renderStep(step, null);
  let ticks = 0;
  _scanInterval = setInterval(() => {
    if (!_active) return;
    ticks++;
    const el = document.querySelector(step.target);
    if (el) {
      clearInterval(_scanInterval);
      _scanInterval = null;
      primeStepIfNeeded(step, el);
      renderStep(step, el);
      startTracking(step, el);
      setupAdvancement(step, el);
    } else if (ticks > 600) {
      clearInterval(_scanInterval);
      _scanInterval = null;
      endTutorial(false);
    }
  }, 100);
}

// Step-specific setup that runs once a target is in hand.
// For the cycle demo: clear the figure's status so the first click
// produces a clean cleared→owned transition.
function primeStepIfNeeded(step, target) {
  if (step.advanceOn === 'cycle-demo') {
    const row = target.closest('[data-fig-id]');
    const figId = row?.dataset?.figId;
    if (figId && S.coll[figId]?.status) {
      delete S.coll[figId].status;
      if (window.saveColl) window.saveColl();
      if (window.render) window.render();
    }
  }
}

// Re-position the spotlight + tooltip as the DOM changes (e.g. cycleStatus
// re-renders the row and the original target node is replaced). Without
// this the spotlight drifts off-screen after the first click.
function startTracking(step, target) {
  if (_trackInterval) clearInterval(_trackInterval);
  let lastBox = JSON.stringify(target.getBoundingClientRect());
  _trackInterval = setInterval(() => {
    if (!_active) return;
    // Re-resolve the target every tick — the original may have been replaced
    let cur = document.querySelector(step.target);
    if (!cur) return;
    const boxJson = JSON.stringify(cur.getBoundingClientRect());
    if (boxJson !== lastBox) {
      lastBox = boxJson;
      const overlay = document.getElementById('tutorialOverlay');
      const tip = document.getElementById('tutorialTooltip');
      if (overlay) positionOverlay(overlay, cur, step);
      if (tip) positionTooltip(tip, cur, step);
    }
  }, 200);
}

function setupAdvancement(step, target) {
  const advance = step.advanceOn || 'click';
  if (advance === 'screen') {
    _screenWatcher = setInterval(() => {
      if (!_active) return;
      const want = step.waitFor || {};
      const screenOk = want.screen == null || S.screen === want.screen;
      const tabOk = want.tab == null || S.tab === want.tab;
      if (screenOk && tabOk) {
        clearInterval(_screenWatcher);
        _screenWatcher = null;
        setTimeout(() => showStep(_stepIdx + 1), 300);
      }
    }, 150);
  } else if (advance === 'cycle-demo' && target) {
    setupCycleDemo(step, target);
  }
  // 'always' — Got it/Next button (rendered in renderStep)
}

// ── Step 4: cycle demo ──────────────────────────────────────────────
//
// User clicks the spotlit status button on a figure. We watch S.coll[figId]
// for the status changing, and check off each visited state in CYCLE_ORDER.
// After all 5 states have been visited (including '' cleared), we show
// the Next button.
function setupCycleDemo(step, target) {
  const row = target.closest('[data-fig-id]');
  const figId = row?.dataset?.figId;
  if (!figId) {
    // Couldn't identify the figure — fall back to manual advance
    renderCycleProgress([], true);
    return;
  }

  // Track which states we've seen. The tour only completes when the user
  // has cycled all the way back to '' (cleared). primeStepIfNeeded already
  // set status to cleared, but we don't credit it as "seen" until the user
  // returns to it via cycling.
  const seen = new Set();
  let lastStatus = (S.coll[figId]?.status) || '';

  renderCycleProgress(seen, false);

  _screenWatcher = setInterval(() => {
    if (!_active) return;
    const cur = (S.coll[figId]?.status) || '';
    if (cur !== lastStatus) {
      lastStatus = cur;
      seen.add(cur);
      const allSeen = CYCLE_ORDER.every(s => seen.has(s));
      renderCycleProgress(seen, allSeen);
      if (allSeen) {
        clearInterval(_screenWatcher);
        _screenWatcher = null;
      }
    }
  }, 100);
}

// Render the cycle progress checklist inside the tooltip. Each state in
// CYCLE_ORDER gets a row that shows ● + label, dimmed until visited.
function renderCycleProgress(seenSet, complete) {
  const tip = document.getElementById('tutorialTooltip');
  if (!tip) return;

  const headline = complete
    ? '<strong style="color:#34d399">✓ Nice — you\'ve seen the full cycle.</strong>'
    : '<strong>Tap the highlighted circle</strong> to cycle through statuses.';

  const checklist = CYCLE_ORDER.map(s => {
    const seen = seenSet.has(s);
    const color = CYCLE_HEX[s];
    const label = CYCLE_LABEL[s];
    return `<div class="cycle-row${seen ? ' seen' : ''}">
      <span class="cycle-dot" style="background:${color}"></span>
      <span class="cycle-label">${label}</span>
      ${seen ? '<span class="cycle-check">✓</span>' : ''}
    </div>`;
  }).join('');

  const body = tip.querySelector('.tutorial-text');
  if (body) {
    body.innerHTML = `${headline}<div class="cycle-list">${checklist}</div>
      <div class="cycle-tip">Long-press any figure for the full menu.</div>`;
  }

  // Add Next button when all states have been seen
  const actions = tip.querySelector('.tutorial-actions');
  if (!actions) return;
  let nextBtn = actions.querySelector('.tutorial-next');
  if (complete && !nextBtn) {
    nextBtn = document.createElement('button');
    nextBtn.className = 'tutorial-next';
    nextBtn.textContent = 'Next →';
    nextBtn.onclick = () => setTimeout(() => showStep(_stepIdx + 1), 100);
    actions.appendChild(nextBtn);
  }
  // Re-position tooltip after content change
  const overlay = document.getElementById('tutorialOverlay');
  if (overlay) {
    const step = STEPS[_stepIdx];
    const target = document.querySelector(step.target);
    if (target) positionTooltip(tip, target, step);
  }
}

// ── Rendering ───────────────────────────────────────────────────────

function renderStep(step, target, hint) {
  let overlay = document.getElementById('tutorialOverlay');
  let tip = document.getElementById('tutorialTooltip');

  // Manage overlay visibility per-step. Some steps don't want any dim
  // (step 3 detail screen — user needs to scroll and read).
  if (step.showOverlay !== false) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'tutorialOverlay';
      overlay.className = 'tutorial-overlay';
      document.body.appendChild(overlay);
    }
    overlay.classList.toggle('pulse', step.pulse !== false);
    positionOverlay(overlay, target, step);
  } else if (overlay) {
    overlay.remove();
  }

  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'tutorialTooltip';
    tip.className = 'tutorial-tooltip';
    document.body.appendChild(tip);
  }
  tip.classList.toggle('compact', !!step.compact);

  const stepNum = _stepIdx + 1;
  const total = STEPS.length;
  const advance = step.advanceOn || 'click';
  const showGotIt = advance === 'always' || step.finalStep;
  const nextLabel = step.nextLabel || (step.finalStep ? 'Finish' : 'Got it →');

  tip.innerHTML = `
    <div class="tutorial-step-count">Step ${stepNum} of ${total}</div>
    <div class="tutorial-text">${hint ? `<em style="color:var(--t3)">${hint}</em><br><br>` : ''}${step.text}</div>
    <div class="tutorial-actions">
      <button class="tutorial-skip">Skip tour</button>
      ${showGotIt ? `<button class="tutorial-next">${nextLabel}</button>` : ''}
    </div>
  `;
  tip.querySelector('.tutorial-skip').onclick = () => endTutorial(true);
  const nextBtn = tip.querySelector('.tutorial-next');
  if (nextBtn) {
    nextBtn.onclick = () => {
      if (typeof step.onNext === 'function') {
        try { step.onNext(); } catch (err) { console.warn('tutorial onNext failed:', err); }
      }
      if (step.finalStep) endTutorial(true);
      else setTimeout(() => showStep(_stepIdx + 1), step.onNext ? 250 : 0);
    };
  }

  positionTooltip(tip, target, step);
}

function positionOverlay(overlay, target, step) {
  if (!target) {
    overlay.style.cssText = 'top:50%;left:50%;width:0;height:0';
    overlay.classList.add('no-target');
    return;
  }
  overlay.classList.remove('no-target');
  const r = target.getBoundingClientRect();
  const pad = 6;
  overlay.style.cssText = `top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
}

function positionTooltip(tip, target, step) {
  const anchor = step.tooltipAnchor || 'target';
  const margin = 18;

  // Reset
  tip.style.left = '12px';
  tip.style.right = '12px';
  tip.style.top = 'auto';
  tip.style.bottom = 'auto';
  tip.style.transform = '';
  tip.style.visibility = 'hidden';
  tip.classList.remove('arrow-down', 'arrow-up');

  if (anchor === 'bottom-fixed') {
    tip.style.bottom = 'calc(20px + var(--safe-bottom, 0px))';
    requestAnimationFrame(() => { tip.style.visibility = ''; });
    return;
  }

  if (!target) {
    tip.style.top = '50%';
    tip.style.transform = 'translateY(-50%)';
    requestAnimationFrame(() => { tip.style.visibility = ''; });
    return;
  }

  // For 'row' anchor, use the closest row/card bounding box instead of
  // the small target (e.g. 24px status circle). This gives the tooltip
  // a much wider area to position relative to and avoids covering the
  // target itself.
  let anchorEl = target;
  if (anchor === 'row') {
    anchorEl = target.closest('.fig-row, .fig-card') || target;
  }
  const r = anchorEl.getBoundingClientRect();
  const vh = window.innerHeight;
  const spaceAbove = r.top - margin;
  const spaceBelow = vh - r.bottom - margin;

  requestAnimationFrame(() => {
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

window.addEventListener('resize', () => {
  if (!_active) return;
  const step = STEPS[_stepIdx];
  if (!step) return;
  const target = step.target ? document.querySelector(step.target) : null;
  const tip = document.getElementById('tutorialTooltip');
  const overlay = document.getElementById('tutorialOverlay');
  if (overlay) positionOverlay(overlay, target, step);
  if (tip) positionTooltip(tip, target, step);
});

window.startTutorial = startTutorial;

export { startTutorial };
