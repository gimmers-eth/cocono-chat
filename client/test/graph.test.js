// Graph health test: every browser-side module must PARSE and every relative
// import must resolve. A syntax error in any chunked file (e.g. an await in a
// non-async handler) kills the whole module graph -> black screen, and no
// other suite boots the FE, so this is the regression net for that class of
// bug.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..'); // client/

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : [],
  );
}

const files = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'app', 'js')),
  path.join(ROOT, 'app', 'sw.js'),
  path.join(ROOT, 'app', 'sw-lib.js'),
];

test('FE/SDK: every module parses (node --check)', () => {
  assert.ok(files.length > 10, `expected a populated graph, found ${files.length} files`);
  for (const file of files) {
    // Copy to .mjs so the checker parses as ESM (browser files are modules).
    const tmp = path.join('/tmp', `syntax-${path.basename(file)}.mjs`);
    fs.copyFileSync(file, tmp);
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.relative(ROOT, file)}:\n${r.stderr}`);
  }
});

test('FE/SDK: every relative import resolves', () => {
  const failures = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      let target;
      if (spec.startsWith('/sdk/')) {
        target = path.join(ROOT, 'src', spec.slice('/sdk/'.length));
      } else if (spec.startsWith('/')) {
        target = path.join(ROOT, 'app', spec.slice(1)); // app-root absolute

      } else if (spec.startsWith('.')) {
        target = path.resolve(path.dirname(file), spec);
      } else {
        continue; // bare specifier (node/npm) — not a browser-graph concern
      }
      if (!fs.existsSync(target)) failures.push(`${path.relative(ROOT, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(failures, [], 'unresolved imports');
});
