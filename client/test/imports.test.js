// Static import guard — the class of bug that broke session resume THREE
// times today (a helper defined in the wrong scope, a usage added before its
// import, an if-not-in-file guard masked by same-script insertions): node
// --check cannot see these and no DOM-less test executes them.
//
// For every app module: any store.js export CALLED in the file must be
// imported by that file. Heuristic by design — it only inspects names this
// project owns (exports of the tracked modules), so false positives are
// controllable and real misses are loud.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(import.meta.dirname, '..', 'app', 'js');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function exportsOf(file) {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
}

const TRACKED = ['store.js', 'ui.js', 'icons.js', 'userline.js', 'peername.js', 'badges.js', 'errors.js', 'blocks.js', 'reports.js', 'tags.js', 'accountPurge.js', 'swkv.js', 'shares.js',
  'media.js', 'components/mediabubble.js', 'components/mediaview.js']
  .map((f) => join(APP, f))
  .filter((f) => { try { return exportsOf(f); } catch { return false; } });

const NAMES = new Map(); // exported name -> file it comes from
for (const f of TRACKED) for (const n of exportsOf(f)) NAMES.set(n, f);

for (const file of walk(APP)) {
  const src = readFileSync(file, 'utf8');
  const imported = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const name of m[1].split(',')) imported.add(name.trim().split(/\s+as\s+/)[0].trim());
  }
  const rel = file.slice(APP.length + 1);
  for (const [name, origin] of NAMES) {
    if (origin === file) continue; // self-export
    const called = new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(src);
    if (called && !imported.has(name)) {
      test(`imports: ${rel} calls ${name}() without importing it`, () => {
        assert.fail(`${rel} calls ${name}() but has no matching import — add it to the ${origin.endsWith('store.js') ? 'store.js' : 'module'} import line`);
      });
    }
  }
}
