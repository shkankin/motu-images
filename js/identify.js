// identify.js — REMOVED in v7.89 (owner: Identify by Photo "never worked well").
//
// Intentionally empty. Nothing imports this module and the service worker no
// longer precaches it. It is kept as a stub rather than deleted because a
// release zip can overwrite a file but cannot delete one — and leaving the old
// contents in js/ would have failed lint_handlers (its template still carried
// data-action="identify-*" attributes whose handlers are gone) and turned CI
// red. Delete this file and its 'identify.js' deploy.html PATH_MAP entry
// together, in one step, whenever convenient.
export {};
