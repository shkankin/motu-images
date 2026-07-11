// v7.51: ESLint config for the no-undef gate ONLY. Two shipped bugs were
// bare-identifier ReferenceErrors that node --check and lint_handlers.mjs
// structurally cannot see (valid syntax, wrong scope): `sourceName` crashed
// the Edit sheet (v7.45), and an unimported `getCachedAskingPrice` broke
// the insurance report since v6.69 (v7.51). no-undef is the one rule that
// catches this class at CI time. Everything else stays off — this codebase
// has its own conventions and the goal is the safety gate, not a style war.
import globals from 'globals';

export default [
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        BarcodeDetector: 'readonly',   // feature-detected in photos.js
      },
    },
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
    rules: { 'no-undef': 'error' },
  },
];
