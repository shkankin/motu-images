// ════════════════════════════════════════════════════════════════════
// MOTU Vault — delegate.js (v6.29)
// ────────────────────────────────────────────────────────────────────
// Single document-level event dispatcher. Replaces the historical pattern
// of inline `onclick="fn(event,'${esc(id)}')"` attributes — which were a
// permanent XSS hazard (mitigated since v6.26 by jsArg(), but the risk
// surface stays as long as inline handler attributes exist) and which
// keep the app from ever running under a strict CSP.
//
// Usage from any render function:
//
//   `<button data-action="cycle-status" data-fig-id="${esc(id)}">…</button>`
//
// instead of:
//
//   `<button onclick="cycleStatus(event,${jsArg(id)})">…</button>`
//
// data-* attributes are always HTML-escaped (esc(...) is enough — the
// browser parses them as plain text, never as code), and the delegated
// dispatcher decides what function to invoke based on the action name.
//
// Why a single registry instead of N separate document.addEventListener
// calls per module:
//   - One traversal of event.target ancestors per click, no matter how
//     many actions exist
//   - No memory churn — each module just registers a string→fn map at
//     boot, no per-render re-binding
//   - Easy to inventory which actions exist (just inspect the registry)
//   - Easy to add CSP-strict friendliness — no inline script ever
// ════════════════════════════════════════════════════════════════════

const _registry = {
  click:       new Map(),
  change:      new Map(),
  input:       new Map(),
  blur:        new Map(),
  focus:       new Map(),
  keydown:     new Map(),
  contextmenu: new Map(),
  // 'error' uses capture phase since image/script load errors don't bubble.
  error:       new Map(),
};

// Register handler. type defaults to 'click'.
//   register('cycle-status', (e, el, data) => {...})
//   register('save-label', (e, el, data) => {...}, 'blur')
export function register(action, handler, type = 'click') {
  if (!_registry[type]) throw new Error('Unknown event type: ' + type);
  if (_registry[type].has(action)) {
    // Re-registration is fine in practice (modules can be re-imported in
    // dev), but warn so accidental conflicts surface.
    if (typeof console !== 'undefined') console.warn('[delegate] re-registering', type, action);
  }
  _registry[type].set(action, handler);
}

// Bulk register. Convenient for module init.
export function registerAll(map, type = 'click') {
  for (const [action, handler] of Object.entries(map)) register(action, handler, type);
}

// For diagnostics — surface the action list in dev tools.
export function _listActions(type = 'click') { return [..._registry[type].keys()].sort(); }

// ── Dispatch ────────────────────────────────────────────────────────

function dispatch(type, e) {
  const map = _registry[type];
  if (!map.size) return;
  // Walk the ancestor chain looking for a matching data-action attribute.
  // closest() does this in one call and stops at document — fast even on
  // deep DOMs. We bound the walk at <body> for safety.
  let el = e.target;
  if (!el || !el.closest) return;
  const trigger = el.closest(`[data-${type === 'click' ? 'action' : type + '-action'}]`);
  if (!trigger) return;
  // Selector property name: data-action for click (the common case), and
  // data-{type}-action for everything else, so a single element can carry
  // multiple listeners (e.g. data-action="x" data-blur-action="save").
  const attrName = type === 'click' ? 'action' : type + 'Action';
  const action = trigger.dataset[attrName];
  if (!action) return;
  const handler = map.get(action);
  if (!handler) {
    if (typeof console !== 'undefined') console.warn('[delegate] no handler for', type, action);
    return;
  }
  // The handler receives (event, triggerElement, data). The data object
  // is just trigger.dataset — strings indexed by camelCase data-* names.
  // For numeric ids etc., the handler is responsible for parsing.
  try {
    handler(e, trigger, trigger.dataset);
  } catch (err) {
    if (typeof console !== 'undefined') console.error('[delegate]', action, 'threw:', err);
  }
}

// ── Boot ────────────────────────────────────────────────────────────

let _booted = false;
export function bootDelegation(root = document) {
  if (_booted) return;
  _booted = true;
  for (const type of Object.keys(_registry)) {
    // Capture phase used for 'error' and 'blur'/'focus' because they don't
    // bubble — capture is the only way a single document-level listener
    // sees them. Other events bubble normally so non-capture is fine.
    const useCapture = (type === 'error' || type === 'blur' || type === 'focus');
    root.addEventListener(type, (e) => dispatch(type, e), useCapture);
  }
}

// ── Helper for the migration ────────────────────────────────────────
// Build the data-* attribute string for a render template. Passes values
// through esc() so single quotes can't break the attribute. Use as:
//   <button ${dataAttrs({action: 'cycle-status', figId: id})}>
import { esc } from './state.js';

export function dataAttrs(map) {
  // Convert camelCase keys to data-kebab-case attributes (matching how
  // dataset.figId reads back as the "fig-id" attribute).
  const parts = ['data-action="' + esc(map.action || '') + '"'];
  for (const [k, v] of Object.entries(map)) {
    if (k === 'action' || v == null) continue;
    const attr = k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    parts.push('data-' + attr + '="' + esc(v) + '"');
  }
  return parts.join(' ');
}
