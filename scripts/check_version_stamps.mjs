#!/usr/bin/env node
// check_version_stamps.mjs — v1.0
//
// WHY. check_deployable.mjs proves a changed file was PUT IN the release zip.
// It cannot prove the file reached production. REL-01 is what that gap looks
// like: v7.84's sw.js and data.js deployed, motu-vault.html did not, and the
// shipped changelog described a CSP fix users never received. The photo
// export stayed broken and Prune stayed armed to delete healthy photos for
// three releases.
//
// A version stamp makes the drift visible. Every shell file that carries one
// must agree with CACHE in sw.js. Because sw.js is what the browser fetches
// on every update check, a mismatched stamp means the two files came from
// different releases — exactly the REL-01 signature.
//
// Run: node scripts/check_version_stamps.mjs [--repo <dir>]
import { readFileSync } from 'fs';
import path from 'path';

const i = process.argv.indexOf('--repo');
const repo = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : process.cwd();
const read = p => { try { return readFileSync(path.join(repo, p), 'utf8'); } catch { return null; } };

let problems = 0;
const bad = (m, d = '') => { problems++; console.log('  \u2717 ' + m + (d ? '\n      ' + d : '')); };

const sw = read('sw.js');
if (sw === null) { console.log('\u2717 sw.js not found'); process.exit(1); }
const cacheM = sw.match(/const CACHE = 'motu-vault-v([0-9.]+)'/);
if (!cacheM) { console.log("\u2717 could not parse CACHE from sw.js"); process.exit(1); }
const version = cacheM[1];
console.log(`sw.js CACHE version: ${version}\n`);

// Each entry: file, a regex with the version in group 1, and a description.
const STAMPS = [
  ['motu-vault.html', /<meta name="app-version" content="([0-9.]+)">/, 'app-version meta'],
  ['js/render.js',    />v([0-9.]+)<\/span>/,                          'header subtitle'],
];

for (const [file, rx, what] of STAMPS) {
  const src = read(file);
  if (src === null) { bad(`${file} not found`); continue; }
  const m = src.match(rx);
  if (!m) { bad(`${file}: no ${what} stamp found`, `expected something matching ${rx}`); continue; }
  if (m[1] !== version) bad(`${file}: ${what} says ${m[1]}, sw.js CACHE says ${version}`,
                            'these files came from different releases - one of them did not deploy');
  else console.log(`  \u2713 ${file} (${what}) = ${m[1]}`);
}

console.log(problems ? `\n\u2717 ${problems} version mismatch(es)` : '\n\u2713 all version stamps agree');
process.exit(problems ? 1 : 0);
