import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { registerSecurityHeaders } from '../src/routes/shared.js';

// The admin panel is a no-build static app: index.html + app.js + godview.js +
// style.css + the vendored d3-force files, served from be/admin by src/admin.js.
// There is no bundler and no browser in CI, so the failure modes worth guarding
// are the ones a browser would find for us: a script path that 404s, a module
// that does not parse, an import the panel cannot resolve, and a page/element
// id the JS reaches for but the HTML never declared.
//
// This suite serves the REAL directory the way admin.js does (same static
// plugin, same CSP) and checks the wiring end to end over HTTP.

const ADMIN_ROOT = path.resolve(import.meta.dirname, '..', 'admin');
const read = (rel) => readFileSync(path.join(ADMIN_ROOT, rel), 'utf8');

async function serveAdmin() {
  const app = Fastify({ logger: false });
  registerSecurityHeaders(app);
  // exactly what src/admin.js does: the badge artwork lives in the CLIENT app
  // and is served from disk, so the panel and the app share one art source
  app.get('/badges-art.js', (request, reply) => {
    reply.header('cache-control', 'no-cache');
    return reply.type('application/javascript').send(
      readFileSync(path.resolve(ADMIN_ROOT, '..', '..', 'client', 'app', 'js', 'badges-art.js')));
  });
  await app.register(fastifyStatic, { root: ADMIN_ROOT, cacheControl: 'no-cache' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { base: `http://127.0.0.1:${app.server.address().port}`, app };
}

test('admin panel: every script and stylesheet the HTML names is served', async () => {
  const { base, app } = await serveAdmin();
  try {
    const html = await (await fetch(`${base}/index.html`)).text();
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    const links = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.includes('/app.js'), 'app.js is loaded');
    assert.ok(srcs.includes('/badges-art.js'), 'the shared badge artwork is loaded');
    for (const src of srcs) {
      const res = await fetch(`${base}${src}`);
      assert.equal(res.status, 200, `${src} must be served (a 404 here is a silent dead panel)`);
    }
    for (const href of links) {
      assert.equal((await fetch(`${base}${href}`)).status, 200, `${href} must be served`);
    }
    // the CSP the panel runs under must still allow its own scripts
    const csp = (await fetch(`${base}/index.html`)).headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
  } finally {
    await app.close();
  }
});

test('admin panel: God View physics is vendored in dependency order', async () => {
  const html = read('index.html');
  const order = ['d3-dispatch', 'd3-quadtree', 'd3-timer', 'd3-force']
    .map((name) => `/vendor/d3/${name}.min.js`);
  let last = -1;
  for (const src of order) {
    const at = html.indexOf(src);
    assert.ok(at > -1, `${src} must be loaded by index.html`);
    assert.ok(at > last, `${src} must come after the modules it depends on`);
    last = at;
  }
  // classic scripts: they must run BEFORE the deferred module scripts
  assert.ok(html.indexOf('/vendor/d3/d3-force.min.js') < html.indexOf('src="/app.js"'),
    'd3 must be on window.d3 before app.js (and godview.js) evaluate');

  const { base, app } = await serveAdmin();
  try {
    for (const src of order) {
      const res = await fetch(`${base}${src}`);
      assert.equal(res.status, 200, `${src} must be served`);
      assert.match(res.headers.get('content-type') ?? '', /javascript/);
    }
    // the UMD builds really do expose the forces godview.js drives
    const force = await (await fetch(`${base}/vendor/d3/d3-force.min.js`)).text();
    for (const fn of ['forceSimulation', 'forceLink', 'forceManyBody', 'forceCollide']) {
      assert.ok(force.includes(fn), `d3-force must export ${fn}`);
    }
  } finally {
    await app.close();
  }
});

test('admin panel: godview.js parses as a module and only imports what exists', async () => {
  const src = read('godview.js');
  // parse check for both panel scripts (be/package.json is type:module, so
  // --check reads them as ESM): a syntax error here is a blank page in the
  // browser and nothing else would catch it before someone opens the panel
  for (const file of ['godview.js', 'app.js']) {
    execFileSync(process.execPath, ['--check', path.join(ADMIN_ROOT, file)], { stdio: 'pipe' });
  }
  // godview.js has no DOM access at module scope, so it really can be
  // imported here: this asserts both the parse and the export contract
  const mod = await import(pathToFileURL(path.join(ADMIN_ROOT, 'godview.js')).href);
  assert.equal(typeof mod.initGodView, 'function', 'godview.js exports its initialiser');

  // every relative import must resolve inside be/admin
  for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
    assert.doesNotThrow(() => read(m[1].replace(/^\.\//, '')), `import ${m[1]} must exist`);
  }

  const app = read('app.js');
  assert.match(app, /import \{ initGodView \} from '\.\/godview\.js';/, 'app.js wires the God View');
  assert.match(app, /initGodView\(\{/, 'app.js constructs it with the shared plumbing');
  // the helpers godview.js is handed must actually be passed (a missing one
  // is an undefined-is-not-a-function at click time, not at load time)
  const wired = app.slice(app.indexOf('const godView = initGodView({'));
  for (const dep of ['api', 'esc', 'fmtDate', 'fmtAgo', 'avatarUrl', 'openUser', 'setStatus']) {
    assert.match(wired.slice(0, wired.indexOf('});')), new RegExp(`\\b${dep},`), `${dep} must be passed in`);
    assert.match(app, new RegExp(`(function|const) ${dep}\\b`), `${dep} must be defined in app.js`);
  }
  // the physics global the vendored files create is the one it reads
  assert.match(src, /window\.d3/, 'godview.js reads the vendored d3 global');
  assert.match(src, /forceSimulation/, 'and drives the simulation itself');
});

test('admin panel: the God View page and Shares tab exist in the markup', async () => {
  const html = read('index.html');
  // nav entry + page section
  assert.match(html, /<button class="nav-item" data-page="godview">God View<\/button>/);
  assert.match(html, /<section class="page" data-page="godview" hidden>/);
  // user panel Shares tab + its lazy container
  assert.match(html, /data-uptab="shares"[^>]*>Shares</);
  assert.match(html, /<div id="user-shares" hidden><\/div>/);

  const app = read('app.js');
  assert.match(app, /'godview'/, 'the page router knows godview');
  assert.match(app, /async function loadShares\(/, 'the Shares tab has a loader');
  assert.match(app, /userTab === 'shares'\) loadShares\(\)/, 'the Shares tab refreshes with the panel');
  assert.match(app, /u\.ref/, 'Details shows the parent user');

  // every id godview.js reaches for must be declared by the page
  const gv = read('godview.js');
  const ids = new Set([...gv.matchAll(/\$\('([a-z0-9-]+)'\)/gi)].map((m) => m[1]));
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is used by godview.js but missing from index.html`);
  }
  // and the palette the spec asks for lives in one place
  const css = read('style.css');
  assert.match(css, /--gv-brand: #7d6ce0/, 'brand purple (client --accent) drives the created edges');
  assert.match(css, /--gv-deep: #6c5fd0/, 'dark purple drives the seen edges');
  assert.match(css, /\.gv-card \{[^}]*width: 150px; height: 94px/s, 'the card box the edge trimmer assumes');
});
