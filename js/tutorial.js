// MOTU Vault — Tutorial Walkthrough (v6.17)
// ─────────────────────────────────────────────
// 5-step coachmark tour for new users. Triggered from the Getting Started
// banner on the Lines screen. Gentle but direct: spotlights the target,
// explains it briefly, lets the user tap anywhere to advance. A persistent
// "Skip tour" button is always visible.
//
// Storage:
//   motu-tutorial-seen — set to 1 once the user finishes or skips the tour.
//                        Hides the "Take Tour" button on the onboard banner
//                        for return users (banner itself stays until they
//                        dismiss it normally via motu-onboarded).
//
// Architecture:
//   - One overlay element (#tutorialOverlay) with a 9999px box-shadow that
//     fills the screen except the spotlight cutout. Re-positioned per step.
//   - One tooltip element (#tutorialTooltip) positioned near the spotlight,
//     auto-flipping above/below to stay on-screen.
//   - Each step has a `target` selector and `text` to show. Optional `wait`
//     hooks let a step pause until the user navigates somewhere first.
//   - Steps that depend on a particular screen (e.g. a figure row) use
//     queryUntilFound to retry while the user navigates. Auto-advances when
//     the target appears.

import { S, store } from './state.js';

const STEPS = [
  {
    target: '.bottom-nav button[onclick*="navTo(\'lines\')"], .bottom-nav button:nth-child(1)',
    text: '<strong>Three ways to browse.</strong><br>Lines groups by era. All shows the full catalog. Collection shows what you own.',
    placement: 'top',
  },
  {
    // Wait for a line card on the Lines screen, OR skip ahead if user already
    // navigated to All. Either way, the next step finds a figure to highlight.
    target: '.line-card, .line-row, .fig-row[data-fig-id], .fig-card[data-fig-id]',
    text: '<strong>Tap any line</strong> to drill into its figures, or use <strong>All</strong> to see everything in one list.',
    placement: 'auto',
    waitForTarget: true,
  },
  {
    target: '.fig-row[data-fig-id], .fig-card[data-fig-id]',
    text: '<strong>Tap the status circle</strong> on the right to cycle through: <span style="color:#888">none</span> → <span style="color:#4ade80">owned</span> → <span style="color:#fb923c">ordered</span> → <span style="color:#666">skip</span>.<br><br><strong>Long-press</strong> for more options like wishlist or for-sale.',
    placement: 'auto',
    spotlightExtra: { right: 0, width: 80 }, // emphasize the status circle area
    waitForTarget: true,
  },
  {
    target: '.fig-row[data-fig-id], .fig-card[data-fig-id]',
    text: '<strong>Tap a figure</strong> to open the detail screen — track copies, paid price, condition, location, photos, and notes per figure.',
    placement: 'auto',
    waitForTarget: true,
  },
  {
    target: '.bottom-nav button:nth-child(3), .bottom-nav button[onclick*="collection"]',
    text: "<strong>Collection</strong> shows just the figures you've marked owned. That's it — you're all set!",
    placement: 'top',
    finalStep: true,
  },
];

let _stepIdx = 0;
let _active = false;
let _scanInterval = null;

function startTutorial() {
  if (_active) return;
  _active = true;
  _stepIdx = 0;
  // Make sure user lands on the Lines screen so step 1's target exists
  if (S.screen !== 'main' || S.tab !== 'lines') {
    if (window.navTo) window.navTo('lines');
  }
  // Defer so any pending render finishes first
  setTimeout(() => showStep(0), 100);
}

function endTutorial(completed) {
  _active = false;
  if (_scanInterval) { clearInterval(_scanInterval); _scanInterval = null; }
  document.getElementById('tutorialOverlay')?.remove();
  document.getElementById('tutorialTooltip')?.remove();
  if (completed) {
    store.set('motu-tutorial-seen', 1);
    if (window.toast) window.toast('🎓 Tutorial complete', { duration: 2000 });
  }
}

function showStep(idx) {
  if (!_active) return;
  if (idx >= STEPS.length) { endTutorial(true); return; }
  _stepIdx = idx;
  const step = STEPS[idx];

  if (step.waitForTarget) {
    // Poll for the target — user may need to navigate first. Auto-advances
    // the visible step when the target appears.
    if (_scanInterval) clearInterval(_scanInterval);
    let ticks = 0;
    _scanInterval = setInterval(() => {
      ticks++;
      const el = document.querySelector(step.target);
      if (el) {
        clearInterval(_scanInterval);
        _scanInterval = null;
        renderStep(step, el);
      } else if (ticks > 600) {
        // 60 seconds with no target — bail gracefully
        clearInterval(_scanInterval);
        _scanInterval = null;
        endTutorial(false);
      }
    }, 100);
    // Show a hint immediately even before target appears
    renderStep(step, null);
  } else {
    const el = document.querySelector(step.target);
    renderStep(step, el);
  }
}

function renderStep(step, target) {
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

  // Position spotlight
  if (target) {
    const r = target.getBoundingClientRect();
    const pad = 6;
    const extra = step.spotlightExtra || {};
    const top = (extra.top != null ? extra.top : r.top) - pad;
    const left = extra.right === 0
      ? (r.right - (extra.width || r.width)) - pad
      : (extra.left != null ? extra.left : r.left) - pad;
    const width = (extra.width != null ? extra.width : r.width) + pad * 2;
    const height = (extra.height != null ? extra.height : r.height) + pad * 2;
    overlay.style.cssText = `top:${top}px;left:${left}px;width:${width}px;height:${height}px`;
    overlay.classList.remove('no-target');
  } else {
    // No target visible yet — full-screen darken with no cutout
    overlay.style.cssText = 'top:50%;left:50%;width:0;height:0';
    overlay.classList.add('no-target');
  }

  // Position tooltip
  const stepNum = _stepIdx + 1;
  const total = STEPS.length;
  tip.innerHTML = `
    <div class="tutorial-step-count">Step ${stepNum} of ${total}</div>
    <div class="tutorial-text">${step.text}</div>
    <div class="tutorial-actions">
      <button class="tutorial-skip">Skip tour</button>
      <button class="tutorial-next">${step.finalStep ? 'Finish' : 'Got it →'}</button>
    </div>
  `;
  tip.querySelector('.tutorial-skip').onclick = () => endTutorial(true); // mark seen even on skip
  tip.querySelector('.tutorial-next').onclick = () => {
    if (step.finalStep) endTutorial(true);
    else showStep(_stepIdx + 1);
  };

  // Position tooltip relative to the target. 'auto' picks above/below by
  // available space. 'top' forces above (used when target is at the bottom
  // of the screen, like the bottom-nav).
  if (target) {
    const r = target.getBoundingClientRect();
    tip.style.visibility = 'hidden';
    tip.style.left = '12px';
    tip.style.right = '12px';
    tip.style.bottom = 'auto';
    tip.style.top = '50%';
    requestAnimationFrame(() => {
      const tipH = tip.offsetHeight;
      const vh = window.innerHeight;
      const placement = step.placement === 'top' ? 'top'
        : step.placement === 'bottom' ? 'bottom'
        : (r.top > vh / 2 ? 'top' : 'bottom');
      if (placement === 'top') {
        tip.style.top = 'auto';
        tip.style.bottom = (vh - r.top + 16) + 'px';
      } else {
        tip.style.top = (r.bottom + 16) + 'px';
        tip.style.bottom = 'auto';
      }
      tip.style.visibility = '';
    });
  } else {
    // Center vertically when no target
    tip.style.left = '12px';
    tip.style.right = '12px';
    tip.style.top = '50%';
    tip.style.bottom = 'auto';
    tip.style.transform = 'translateY(-50%)';
  }
}

// Re-position on viewport changes (rotation, keyboard, scroll past target)
window.addEventListener('resize', () => {
  if (_active && _stepIdx >= 0) {
    const step = STEPS[_stepIdx];
    const target = document.querySelector(step.target);
    if (target) renderStep(step, target);
  }
});

// Expose for the onboard-banner button
window.startTutorial = startTutorial;

export { startTutorial };
