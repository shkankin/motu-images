// MOTU Vault — Tutorial Walkthrough (v6.18)
// ─────────────────────────────────────────────
// Action-driven coachmark tour. Each step waits for the user to perform
// the highlighted action — tapping the spotlighted target advances the
// tutorial. No auto-advance on action steps.
//
// Triggered from the Getting Started banner on the Lines screen.
// Persistent "Skip tour" button always visible.
//
// Storage:
//   motu-tutorial-seen — set to 1 once the user finishes or skips the tour.

import { S, store } from './state.js';

const STEPS = [
  // Step 1: Bottom nav — guide them to the All tab
  {
    target: '.bottom-nav button:nth-child(2)', // "All" — middle
    text: '<strong>Three views</strong> at the bottom: Lines (browse by era), <span style="color:var(--acc)">All</span> (full catalog), Collection (what you own).<br><br>Tap <strong>All</strong> to continue.',
    placement: 'top',
    advanceOn: 'screen',
    waitFor: { tab: 'all' },
  },

  // Step 2: Tap a figure to open detail
  {
    target: '.fig-row[data-fig-id], .fig-card[data-fig-id]',
    text: '<strong>Tap any figure name</strong> to open its details.',
    placement: 'auto',
    advanceOn: 'screen',
    waitFor: { screen: 'figure' },
  },

  // Step 3: Detail screen — auto-close on Next so user doesn't have to
  // hit back manually. Tooltip pinned to bottom so the screen contents
  // are visible above it.
  {
    target: null,
    text: '<strong>Detail screen.</strong> Track copies, paid price, condition, location, photos, and notes per figure.<br><br>Tap <strong>Next</strong> when you\'ve had a look.',
    placement: 'bottom-fixed',
    advanceOn: 'always',
    nextLabel: 'Next →',
    onNext: () => {
      // Close the detail screen on the user's behalf
      if (typeof history !== 'undefined') history.back();
    },
  },

  // Step 4: Interactive status cycle demo. User taps the spotlit circle
  // and watches the color change; counter tracks progress through the
  // 4 colors. Next button only appears once they've seen all 4.
  {
    target: '.fig-row[data-fig-id] .status-btn, .fig-card[data-fig-id] .status-btn, .fig-row[data-fig-id] .status-circle, .fig-card[data-fig-id] .status-circle',
    text: '<strong>Tap the highlighted circle</strong> to cycle through statuses.<br><br><span style="color:#34d399">●</span> Owned · <span style="color:#fb923c">●</span> Ordered<br><span style="color:#60a5fa">●</span> Wishlist · <span style="color:#f87171">●</span> For Sale<br><br><span class="cycle-progress" data-progress="0">Tap to begin: <strong>0 / 4</strong> colors seen</span><br><br><em style="color:var(--t3);font-size:12px">Tip: long-press any figure for the full menu.</em>',
    placement: 'auto',
    advanceOn: 'cycle-demo',
    requireScreen: 'main',
    requiredCount: 4, // need 4 distinct status changes (covers all 4 colors)
  },

  // Step 5: Collection tab — final
  {
    target: '.bottom-nav button:nth-child(3)',
    text: '<strong>Collection</strong> shows just the figures you own.<br><br>Tap any status circle on a figure to start filling it. You\'re all set!',
    placement: 'top',
    advanceOn: 'always',
    nextLabel: 'Finish',
    finalStep: true,
  },
];

let _stepIdx = 0;
let _active = false;
let _scanInterval = null;
let _screenWatcher = null;
let _clickListener = null;

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

  if (step.target == null) {
    // Targetless step — show tooltip only (e.g. detail screen overview)
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
    renderStep(step, target);
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
      renderStep(step, el);
      setupAdvancement(step, el);
    } else if (ticks > 600) {
      clearInterval(_scanInterval);
      _scanInterval = null;
      endTutorial(false);
    }
  }, 100);
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
  } else if (advance === 'click' && target) {
    _clickListener = (e) => {
      if (target.contains(e.target) || e.target === target) {
        document.removeEventListener('click', _clickListener, true);
        _clickListener = null;
        setTimeout(() => showStep(_stepIdx + 1), 300);
      }
    };
    document.addEventListener('click', _clickListener, true);
  } else if (advance === 'cycle-demo' && target) {
    setupCycleDemo(step, target);
  }
  // 'always' — Got it → button (rendered in renderStep)
}

// Step 4 interactive demo. The user taps the spotlit status circle, which
// triggers cycleStatus() on the underlying figure. We watch S.coll[figId]
// and count distinct status values seen. When the count hits the required
// number, the tooltip swaps to a Next button so they can advance.
//
// Implementation: find the figure ID from the target's data-fig-id, then
// poll S.coll[figId].status to detect changes. Polling beats hooking the
// status mutation because the existing cycleStatus does its own render
// which destroys the click listener anyway.
function setupCycleDemo(step, target) {
  const row = target.closest('[data-fig-id]');
  const figId = row?.dataset?.figId;
  if (!figId) {
    // Couldn't identify the figure — fall back to manual advance
    showCycleProgress(0, step.requiredCount, true);
    return;
  }

  const seen = new Set();
  let lastStatus = (S.coll[figId]?.status) || '';
  if (lastStatus) seen.add(lastStatus);

  showCycleProgress(seen.size, step.requiredCount, false);

  _screenWatcher = setInterval(() => {
    if (!_active) return;
    // Re-find the row + button after any re-render. Without this, the
    // spotlight can drift off the new DOM node.
    const row2 = document.querySelector(`[data-fig-id="${figId}"]`);
    if (row2) {
      const btn = row2.querySelector('.status-btn, .status-circle');
      if (btn) {
        const tip = document.getElementById('tutorialTooltip');
        const overlay = document.getElementById('tutorialOverlay');
        if (overlay) {
          const r = btn.getBoundingClientRect();
          const pad = 6;
          overlay.style.cssText = `top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
        }
        if (tip) positionTooltip(tip, btn, step.placement);
      }
    }

    const cur = (S.coll[figId]?.status) || '';
    if (cur !== lastStatus) {
      lastStatus = cur;
      if (cur) seen.add(cur);
      showCycleProgress(seen.size, step.requiredCount, seen.size >= step.requiredCount);
      if (seen.size >= step.requiredCount) {
        clearInterval(_screenWatcher);
        _screenWatcher = null;
      }
    }
  }, 150);
}

// Update the inline progress text inside the tooltip and toggle the Next
// button visibility. Called by setupCycleDemo as the user cycles statuses.
function showCycleProgress(count, total, complete) {
  const tip = document.getElementById('tutorialTooltip');
  if (!tip) return;
  const progress = tip.querySelector('.cycle-progress');
  if (progress) {
    if (complete) {
      progress.innerHTML = `<strong style="color:var(--gn,#34d399)">✓ Great! All ${total} colors seen.</strong>`;
    } else {
      progress.innerHTML = `Keep tapping: <strong>${count} / ${total}</strong> colors seen`;
    }
  }
  // Add a Next button if it's not there and the demo is complete
  const actions = tip.querySelector('.tutorial-actions');
  if (!actions) return;
  let nextBtn = actions.querySelector('.tutorial-next');
  if (complete && !nextBtn) {
    nextBtn = document.createElement('button');
    nextBtn.className = 'tutorial-next';
    nextBtn.textContent = 'Got it →';
    nextBtn.onclick = () => {
      setTimeout(() => showStep(_stepIdx + 1), 100);
    };
    actions.appendChild(nextBtn);
  }
}

function renderStep(step, target, hint) {
  let overlay = document.getElementById('tutorialOverlay');
  let tip = document.getElementById('tutorialTooltip');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'tutorialOverlay';
    overlay.className = 'tutorial-overlay';
    document.body.appendChild(overlay);
  }
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'tutorialTooltip';
    tip.className = 'tutorial-tooltip';
    document.body.appendChild(tip);
  }

  if (target) {
    const r = target.getBoundingClientRect();
    const pad = 6;
    overlay.style.cssText = `top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
    overlay.classList.remove('no-target');
  } else {
    overlay.style.cssText = 'top:50%;left:50%;width:0;height:0';
    overlay.classList.add('no-target');
  }

  const stepNum = _stepIdx + 1;
  const total = STEPS.length;
  const advance = step.advanceOn || 'click';
  // 'cycle-demo' starts without a Next button — it's added when the user
  // completes the demo (see showCycleProgress)
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
      // Run the step's optional onNext side effect (e.g. step 3 closes
      // the detail screen so the user doesn't have to back out manually).
      if (typeof step.onNext === 'function') {
        try { step.onNext(); } catch (err) { console.warn('tutorial onNext failed:', err); }
      }
      if (step.finalStep) endTutorial(true);
      else setTimeout(() => showStep(_stepIdx + 1), step.onNext ? 250 : 0);
    };
  }

  positionTooltip(tip, target, step.placement);
}

function positionTooltip(tip, target, preferredPlacement) {
  tip.style.left = '12px';
  tip.style.right = '12px';
  tip.style.top = 'auto';
  tip.style.bottom = 'auto';
  tip.style.transform = '';
  tip.style.visibility = 'hidden';

  // bottom-fixed: pin to bottom edge regardless of target (used for the
  // detail-screen step where the entire screen is the "target")
  if (preferredPlacement === 'bottom-fixed') {
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

  const r = target.getBoundingClientRect();
  const vh = window.innerHeight;
  const margin = 16;

  requestAnimationFrame(() => {
    const tipH = tip.offsetHeight;
    const spaceAbove = r.top - margin;
    const spaceBelow = vh - r.bottom - margin;

    let placement;
    if (preferredPlacement === 'top') placement = 'top';
    else if (preferredPlacement === 'bottom') placement = 'bottom';
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
    } else {
      tip.style.top = (r.bottom + margin) + 'px';
      tip.style.bottom = 'auto';
    }
    tip.style.visibility = '';
  });
}

// Re-position on viewport changes
window.addEventListener('resize', () => {
  if (!_active) return;
  const step = STEPS[_stepIdx];
  if (!step) return;
  const target = step.target ? document.querySelector(step.target) : null;
  const tip = document.getElementById('tutorialTooltip');
  const overlay = document.getElementById('tutorialOverlay');
  if (!tip || !overlay) return;
  if (target) {
    const r = target.getBoundingClientRect();
    const pad = 6;
    overlay.style.cssText = `top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
  }
  positionTooltip(tip, target, step.placement);
});

window.startTutorial = startTutorial;

export { startTutorial };
