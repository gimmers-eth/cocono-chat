// The update notice, EXECUTED: boot records the build that served the page;
// when the server moves on, the footer version becomes a reload button; the
// click remembers its target and reloads; and a page that reloads but STILL
// finds itself old gets the "close and re-open" copy instead (the app-shell
// cache past-reload case). Runs the real module against the DOM shim and the
// real index.html markup, so the ids are guarded too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { installDomShim } from './domshim.js';

const APP = path.resolve(import.meta.dirname, '..', 'app');
const dom = installDomShim(readFileSync(path.join(APP, 'index.html'), 'utf8'));

const { initUpdateNotice, BOOT_VERSION_KEY } = await import('../app/js/update.js');
const TRIED_KEY = 'cocono.update.tried';

const BOOT = { name: 'x', version: 'aaa (2026-01-01)', build: 12 };
const NEWER = { name: 'x', version: 'bbb (2026-02-02)', build: 13 };

let reloaded = 0;
globalThis.location = { reload: () => { reloaded += 1; } };

function freshSession(...served) {
  dom.reset();
  localStorage.removeItem(BOOT_VERSION_KEY);
  localStorage.removeItem(TRIED_KEY);
  reloaded = 0;
  let i = 0;
  // the LAST entry stays pinned (models "server has moved on and stays there")
  const fetchAppInfo = async () => structuredClone(served[Math.min(i++, served.length - 1)]);
  const ui = initUpdateNotice({ fetchAppInfo, pollMs: 0 });
  return ui;
}

const notice = () => dom.byId('update-notice');
const versionEl = () => dom.byId('client-version');
const btn = () => dom.created.filter((e) => e.tagName === 'BUTTON' && e._classes.has('btn-update')).at(-1);

test('footer version is a plain number and no notice at boot', async () => {
  const ui = freshSession(BOOT);
  await ui.refresh();
  assert.equal(versionEl().textContent, 'v12');
  assert.match(versionEl().title, /aaa/, 'full git identity stays in the tooltip');
  assert.equal(notice().hidden, true);
  assert.equal(localStorage.getItem(BOOT_VERSION_KEY), BOOT.version);
  ui.stop();
});

test('a newer server build turns the footer into a reload button', async () => {
  const ui = freshSession(BOOT, NEWER); // poll now sees the deploy that shipped mid-session
  await ui.refresh();
  await ui.refresh();
  assert.equal(versionEl().textContent, 'v13');
  assert.equal(notice().hidden, false);
  const b = btn();
  assert.ok(b, 'button rendered');
  assert.match(b.textContent, /Update available — v13/);
  b.click();
  assert.equal(reloaded, 1, 'click reloads');
  assert.equal(localStorage.getItem(TRIED_KEY), NEWER.version, 'reload target recorded');
  ui.stop();
});

test('reload that did not take falls back to close-and-re-open copy', async () => {
  // models the stale app shell: button clicked (TRIED recorded), reload ran,
  // but the page STILL boots the old build against the same server
  localStorage.removeItem(BOOT_VERSION_KEY);
  localStorage.removeItem(TRIED_KEY);
  dom.reset();
  localStorage.setItem(BOOT_VERSION_KEY, BOOT.version); // old page boots
  localStorage.setItem(TRIED_KEY, NEWER.version); // ...right after a reload attempt
  const ui = initUpdateNotice({ fetchAppInfo: async () => structuredClone(NEWER), pollMs: 0 });
  await ui.refresh();
  assert.equal(notice().hidden, false);
  assert.ok(!btn(), 'no reload button after a failed reload');
  assert.match(notice().textContent, /reload did not take/);
  assert.match(notice().textContent, /Close the app/);
  ui.stop();
});

test('a page that boots current shows nothing and clears any stale attempt', async () => {
  localStorage.setItem(TRIED_KEY, 'leftover');
  const ui = freshSession(NEWER); // booting straight onto the new build
  await ui.refresh();
  assert.equal(notice().hidden, true);
  assert.equal(localStorage.getItem(TRIED_KEY), null);
  ui.stop();
});

test('no build number (git unavailable): fall back to the sha label', async () => {
  const ui = freshSession({ name: 'x', version: 'abc1234 (2026-01-01)' });
  await ui.refresh();
  assert.equal(versionEl().textContent, 'vabc1234');
  ui.stop();
});

test('index.html declares the slots the module paints', () => {
  assert.ok(dom.declaredIds.has('client-version'));
  assert.ok(dom.declaredIds.has('update-notice'));
});
