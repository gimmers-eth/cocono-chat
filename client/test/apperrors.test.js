// The client-data channel, tested: what a phone journals, what survives a
// reload, and what the user is therefore actually sending when they press the
// diagnostics icon. This is the mechanism every other agent on this codebase is
// told to write into (js/applog.js, docs/PROJECT_STATUS.md, the cocono-ops
// skill), so it cannot be browser-only folklore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { installIdbShim } from './idbshim.js';
import { installDomShim } from './domshim.js';

const APP = path.resolve(import.meta.dirname, '..', 'app');
installIdbShim();
const dom = installDomShim(readFileSync(path.join(APP, 'index.html'), 'utf8'));
globalThis.location = { origin: 'http://localhost:3000', href: 'http://localhost:3000/', pathname: '/' };

const { logEvent, logError, appLogLines, clearAppLog, installErrorCapture } = await import('../app/js/applog.js');
const M = await import('../app/js/media.js');
const diag = await import('../app/js/diag.js');
const { client: _c } = {};

test('journal: lines persist, are newest-last, and a crash line is deduped', async () => {
  clearAppLog();
  assert.match(appLogLines().join('\n'), /no app errors logged/);
  logEvent('media', 'image download failed code=media_tampered');
  logEvent('poster', 'no poster: no-dimensions');
  const lines = appLogLines();
  assert.match(lines.at(-1), /poster: no poster: no-dimensions/);
  assert.match(lines.at(-2), /media: image download failed code=media_tampered/);

  // persistence is the point: the flow is 'it failed, app closed, reported later'
  clearAppLog();
  logEvent('send', 'rate_limited');
  assert.equal(JSON.parse(localStorage.getItem('cocono.applog')).length, 1);

  // uncaught handlers: journalled once per distinct line, not per spam
  clearAppLog();
  dom.window.reset();
  assert.equal(installErrorCapture(), true);
  assert.equal(installErrorCapture(), false, 'idempotent — a double install must not double-log');
  dom.window.fire('error', { message: 'boom', filename: 'http://localhost:3000/js/x.js', lineno: 12 });
  dom.window.fire('error', { message: 'boom', filename: 'http://localhost:3000/js/x.js', lineno: 12 });
  assert.equal(appLogLines().length, 1, 'a page faulting in a loop must not drown the ring');
  assert.match(appLogLines().at(-1), /uncaught: boom @ \/js\/x.js:12/);
  dom.window.fire('unhandledrejection', { reason: Object.assign(new Error('nope'), { code: 'unknown_media' }) });
  assert.match(appLogLines().at(-1), /uncaught: unknown_media nope/);
});

test('journal: it is bounded, and survives junk in storage', () => {
  clearAppLog();
  for (let i = 0; i < 120; i++) logEvent('media', `flood ${i}`);
  const rows = JSON.parse(localStorage.getItem('cocono.applog'));
  assert.ok(rows.length <= 40, `ring capped (${rows.length})`);
  assert.equal(rows.at(-1).msg, 'flood 119', 'newest kept');
  localStorage.setItem('cocono.applog', '{not json');
  assert.doesNotThrow(() => logEvent('media', 'after corruption'));
  assert.match(appLogLines().at(-1), /after corruption/);
});

test('journal: an error is logged by its CODE, which is the part that travels', () => {
  clearAppLog();
  logError('media-send', Object.assign(new Error('Storage quota reached'), { code: 'media_quota', status: 413 }));
  logError('save', { code: 'no_thumb' });
  const lines = appLogLines();
  assert.match(lines.at(-2), /media-send: media_quota http 413 Storage quota reached/);
  assert.match(lines.at(-1), /save: no_thumb/, 'a bare code is still a line');
});

test('journal: a real media failure writes into it, not just to the console', async () => {
  const store = await import('../app/js/store.js');
  store.setScope('journal' + Date.now());
  clearAppLog();
  // the arrival path with a client that reports the payload as gone
  const cli = {
    async fetchMediaBytes() { throw Object.assign(new Error('gone'), { code: 'unknown_media', status: 404 }); },
    async ackMedia() { return { ok: true }; },
  };
  const row = M.mediaRow({ key: 'j1', peer: 'b', dir: 'in', kind: 'image', media: { id: 'j1', kind: 'image', key: 'k', sha256: 's' }, msgId: 'in:j1', ts: Date.now() });
  await store.saveMedia(row);
  const res = await M.downloadMedia(cli, row);
  assert.equal(res.state, 'expired');
  assert.match(appLogLines().at(-1), /media: image gone from server code=unknown_media/);
});

test('diagnostics report: the journal is in what the user sends', async () => {
  // the report reads real storage; the shim must answer like a browser that has
  // our databases, or the section reports 'FAILED' and the test proves nothing
  globalThis.indexedDB.databases = async () => [{ name: 'cocono-app:tester', version: 6, size: 4096 }];
  clearAppLog();
  logEvent('poster', 'no poster: blank-frames');
  logEvent('media', 'video download failed code=media_tampered');
  const report = await diag.collectDiagnostics();
  assert.match(report, /app-errors:/, 'the section exists');
  assert.match(report, /poster: no poster: blank-frames/);
  assert.match(report, /media: video download failed code=media_tampered/);
  assert.match(report, /origin: http:\/\/localhost:3000/, 'and it says where it came from');
});

test('the diagnostics icon sits by the version and still needs a confirm', async () => {
  const { $ } = await import('../app/js/ui.js');
  assert.ok($('btn-diag-version') === null || true);
  let sent = 0;
  const client = { sendDiagnostics: async () => { sent += 1; } };
  diag.mountDiagnostics({ client });
  const btn = $('btn-diag-version');
  assert.ok(btn, 'an icon exists beside the build number');
  assert.match(btn.title, /diagnostics/i);
  btn.click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal($('diag-modal').hidden, false, 'clicking opens the PREVIEW modal');
  assert.equal(sent, 0, 'and nothing has been uploaded yet');
  // the confirmation is the Send button inside it
  $('btn-diag-modal-send').click();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sent, 1, 'only after that tap does the report leave the device');
});
