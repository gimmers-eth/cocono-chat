// The media UI is static files served by the backend — there is no DOM test
// harness, so the class of bug that bites here is a WIRING break: a module that
// is not served, an element id that does not exist (a typo silently no-ops a
// button, which no syntax check can see), a store version that never created
// its store, or a notification emitter left showing raw JSON.
//
// This test asserts exactly those, against the real served tree (same shape as
// app-serve.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildApp } from '@cocono/be/src/app.js';
import { config } from '@cocono/be/src/config.js';
import { connectMongo, connectRedis } from '@cocono/be/src/db.js';

const APP_ROOT = path.resolve(import.meta.dirname, '..', 'app');
const SDK_ROOT = path.resolve(import.meta.dirname, '..', 'src');
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';
const read = (rel) => readFileSync(path.join(APP_ROOT, rel), 'utf8');

async function serve() {
  const mongod = await MongoMemoryServer.create();
  const mongo = await connectMongo(mongod.getUri('cocono-media-ui-test'));
  const redis = await connectRedis(TEST_REDIS_URL);
  await redis.flushDb();
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

test('media: every module the feature needs is served', async (t) => {
  const srv = await serve();
  t.after(() => srv.stop());
  for (const file of ['js/media.js', 'js/components/mediabubble.js', 'js/components/mediaview.js']) {
    const res = await fetch(`${srv.base}/${file}`);
    assert.equal(res.status, 200, `${file} must be served (a missing module is a boot crash)`);
    assert.match(res.headers.get('content-type'), /javascript/);
  }
  const html = await (await fetch(`${srv.base}/`)).text();
  // the composer's + button, the two pickers, the tab strip, the tab panel and
  // the modal's media pane — the markup the components hang off
  for (const id of ['btn-attach', 'attach-menu', 'attach-photo-input', 'attach-file-input',
    'chat-tabs', 'chat-tabpanel', 'msg-media', 'media-retention']) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html needs #${id}`);
  }
  assert.match(html, /data-icon="attach"/, 'the attach glyph comes from the icon map');
});

test('media: every element id the media code touches exists in index.html', () => {
  const html = read('index.html');
  const present = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const files = ['js/components/chat.js', 'js/components/mediaview.js',
    'js/components/mediabubble.js', 'js/components/home.js', 'js/media.js'];
  const missing = [];
  for (const f of files) {
    for (const m of read(f).matchAll(/\$\('([^']+)'\)/g)) {
      if (!present.has(m[1])) missing.push(`${f} -> #${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'a $() on a missing id silently does nothing');
});

test('media: the message store is versioned up and creates its store', () => {
  const store = read('js/store.js');
  const version = Number(store.match(/const DB_VERSION = (\d+)/)?.[1]);
  assert.ok(version >= 6, `DB_VERSION must be ≥ 6 for the media store (is ${version})`);
  assert.match(store, /objectStoreNames\.contains\(MEDIA\)/, 'the upgrade creates `media`');
  assert.match(store, /createObjectStore\(MEDIA, \{ keyPath: 'id' \}\)/);
  assert.match(store, /store\.createIndex\('byPeer', 'peer'\)[\s\S]*?byState/,
    'the tabs read byPeer and the retry/prune sweeps read byState');
  // and the per-account wipe still reaches it: deleteDatabase drops the whole
  // file, but clearing a CHAT must not leave its blobs behind
  assert.match(store, /export async function clearMediaWith/);
});

test('media: chat.js is wired to the modules, not to its own copies', () => {
  const chat = read('js/components/chat.js');
  for (const name of ['prepareMedia', 'parseMediaPayload', 'mediaRow', 'applyArrivalPolicy',
    'retryFailedDownloads', 'pruneLocalMedia', 'bubbleNodes', 'buildTabStrip',
    'paintTabPanel', 'openViewer', 'releaseScope']) {
    assert.match(chat, new RegExp(`\\b${name}\\(`), `chat.js calls ${name}()`);
  }
  // named-import discipline (imports.test.js covers tracked modules; this is
  // the same lesson aimed at the media split specifically)
  for (const name of ['saveMedia', 'getMedia', 'updateMedia', 'mediaWith', 'deleteMedia', 'clearMediaWith']) {
    assert.match(chat, new RegExp(`\\b${name}\\(`), `chat.js calls ${name}()`);
  }
  const importBlock = chat.match(/import \{[\s\S]*?\} from '\.\/mediabubble\.js'/);
  assert.ok(importBlock, 'bubble painting is imported from its own module');
  const home = read('js/components/home.js');
  assert.match(home, /clearAllMedia\(\)/, 'settings → clear all messages clears blobs too');
  assert.match(home, /setLocalRetentionDays/, 'the retention window is a setting');
});

test('media: all THREE notification emitters name an attachment, never its JSON', () => {
  // 1. the worker's silent-resume peek (sw-lib.js) — the closed-app path
  const sw = read('sw-lib.js');
  assert.match(sw, /\{"media":/, 'the worker recognises a media payload');
  assert.match(sw, /'Photo'/);
  // 2. the page (chat.js): the transcript stores a LABEL, and the banner /
  //    notifyOS read that field, so JSON can never reach a notification
  const chat = read('js/components/chat.js');
  assert.match(chat, /displayText/, 'the message handler notifies from the label');
  const media = read('js/media.js');
  assert.match(media, /export function mediaLabel/);
  // 3. the server push stays BLIND (event type only) — nothing to change, and
  //    nothing may be added: assert the payload the ws layer sends is still
  //    content-free for media (the send path shares the text path)
  const handlers = readFileSync(path.resolve(APP_ROOT, '../../be/src/routes/ws-routes/handlers.js'), 'utf8');
  assert.match(handlers, /sendBlindPush\(config, recipientDevice\.push, 'msg', auth\.sub\)/,
    'a media message pushes exactly like a text one: blind');
  assert.doesNotMatch(handlers, /sendBlindPush\([^)]*m\.att/, 'no attachment metadata in a push');
});

test('media: the SDK surface the app calls exists and is exported', async (t) => {
  const clientSrc = readFileSync(path.join(SDK_ROOT, 'client.js'), 'utf8');
  for (const name of ['sendMedia', 'downloadMedia', 'downloadThumb', 'ackMedia']) {
    assert.match(clientSrc, new RegExp(`async ${name}\\(`), `CoconoClient.${name}`);
  }
  const apiSrc = readFileSync(path.join(SDK_ROOT, 'api.js'), 'utf8');
  assert.match(apiSrc, /\/api\/media/);
  assert.match(apiSrc, /\/ack/);
  assert.match(apiSrc, /part=/, 'thumb-only fetches are part of the transport');
  const cryptoSrc = readFileSync(path.join(SDK_ROOT, 'crypto.js'), 'utf8');
  for (const name of ['encryptBytes', 'decryptBytes', 'generateFileKey', 'importFileKey', 'sha256B64u']) {
    assert.match(cryptoSrc, new RegExp(`export async function ${name}\\b`));
  }
});
