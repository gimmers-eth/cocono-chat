// Serves the real static tree the backend now hosts: the new app (client/app)
// at / and the SDK at /sdk/. Guards the import map between app and SDK and
// the theme bootstrap files.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildApp } from '@cocono/be/src/app.js';
import { config } from '@cocono/be/src/config.js';
import { connectMongo, connectRedis } from '@cocono/be/src/db.js';

const APP_ROOT = path.resolve(import.meta.dirname, '..', 'app');
const SDK_ROOT = path.resolve(import.meta.dirname, '..', 'src');
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';

async function serve() {
  const mongod = await MongoMemoryServer.create();
  const mongo = await connectMongo(mongod.getUri('cocono-serve-test'));
  const redis = await connectRedis(TEST_REDIS_URL);
  const app = await buildApp({ mongo, redis, config, feRoot: APP_ROOT, sdkRoot: SDK_ROOT });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return {
    base: `http://127.0.0.1:${app.server.address().port}`,
    async stop() {
      await app.close();
      await redis.quit();
      await mongo.client.close();
      await mongod.stop();
    },
  };
}

test('app shell and assets are served', async (t) => {
  const srv = await serve();
  t.after(() => srv.stop());

  const index = await fetch(`${srv.base}/`);
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /<div id="view-app"/);
  assert.match(html, /id="theme-link"[^>]*themes\/dark\/theme\.css/);
  assert.match(html, /src="\/js\/main\.js"/);
  assert.match(html, /id="drawer-overlay" class="overlay"/);
  assert.match(html, /id="settings-drawer" class="drawer"[^>]*aria-modal="true"/);

  // The app must reach the SDK through the /sdk/ mount, not anywhere else.
  const mainSrc = await (await fetch(`${srv.base}/js/main.js`)).text();
  assert.match(mainSrc, /from '\/sdk\/index\.js'/);

  for (const [asset, ctype] of [
    ['/css/base.css', 'text/css'],
    ['/themes/dark/theme.css', 'text/css'],
    ['/themes/themes.json', 'application/json'],
    ['/manifest.webmanifest', 'application/'],
    ['/js/main.js', 'javascript'],
    ['/js/theme.js', 'javascript'],
    ['/js/store.js', 'javascript'],
    ['/js/components/auth.js', 'javascript'],
    ['/js/components/home.js', 'javascript'],
    ['/js/components/chat.js', 'javascript'],
  ]) {
    const res = await fetch(`${srv.base}${asset}`);
    assert.equal(res.status, 200, `${asset} should be served`);
    assert.ok(res.headers.get('content-type').includes(ctype), `${asset}: ${res.headers.get('content-type')}`);
  }
});

test('SDK is served under /sdk/ and its internal imports resolve', async (t) => {
  const srv = await serve();
  t.after(() => srv.stop());

  const entry = await fetch(`${srv.base}/sdk/index.js`);
  assert.equal(entry.status, 200);
  const text = await entry.text();
  assert.match(text, /export \{ CoconoClient \}/);

  // The entry imports './client.js' etc. relative to /sdk/ — spot-check one.
  const clientJs = await fetch(`${srv.base}/sdk/client.js`);
  assert.equal(clientJs.status, 200);
  const clientSrc = await clientJs.text();
  assert.match(clientSrc, /from '\.\/api\.js'/);
  const apiJs = await fetch(`${srv.base}/sdk/api.js`);
  assert.equal(apiJs.status, 200, 'relative SDK import chain must resolve under /sdk/');
});

test('theme registry is well-formed and every referenced file exists', async (t) => {
  const srv = await serve();
  t.after(() => srv.stop());

  const registry = await (await fetch(`${srv.base}/themes/themes.json`)).json();
  assert.ok(registry.themes.length >= 1);
  assert.ok(registry.themes.some((x) => x.id === registry.default), 'default theme must exist');
  const ids = registry.themes.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'theme ids must be unique');
  for (const theme of registry.themes) {
    const css = await fetch(`${srv.base}/themes/${theme.file}`);
    assert.equal(css.status, 200, `theme file ${theme.file}`);
    const body = await css.text();
    assert.match(body, /--bg|--panel|--text/, 'theme must define design tokens');
  }
});
