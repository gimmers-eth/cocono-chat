// The update notice, EXECUTED. The page's OWN build is a fact (the number
// baked into the served shell — here injected via getOwnBuild), so:
//   * a current page is never nagged, even when an EARLIER session left a
//     stale version record in localStorage (the shipped-bug regression:
//     "v307 is out" told the newest build it was old, forever);
//   * a stale shell reloads, and a reload that provably did not take
//     switches to close-and-re-open copy;
//   * with no baked marker (old shell / server without git) the notice falls
//     back to per-page-load boot recording — also overwritten fresh, never
//     honouring a previous session's value.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { installDomShim } from './domshim.js';

const APP = path.resolve(import.meta.dirname, '..', 'app');
const INDEX_HTML = readFileSync(path.join(APP, 'index.html'), 'utf8');
const dom = installDomShim(INDEX_HTML);

const { initUpdateNotice, BOOT_VERSION_KEY } = await import('../app/js/update.js');
const TRIED_KEY = 'cocono.update.tried';

const V12 = 'aaa (2026-01-01)';
const V13 = 'bbb (2026-02-02)';
const BOOT = { name: 'x', version: V12, build: 12 };
const NEWER = { name: 'x', version: V13, build: 13 };

let reloaded = 0;
globalThis.location = { reload: () => { reloaded += 1; } };

const notice = () => dom.byId('update-notice');
const versionEl = () => dom.byId('client-version');
const btn = () => dom.created.filter((e) => e.tagName === 'BUTTON' && e._classes.has('btn-update')).at(-1);
const manual = () => dom.created.filter((e) => e._classes.has('update-manual')).at(-1);

/** A fresh page load: clean storage, pinned fetch sequence, marker builds. */
function load({ served, own, bootSeed, triedSeed } = {}) {
  dom.reset();
  dom.created.length = 0;
  localStorage.removeItem(BOOT_VERSION_KEY);
  localStorage.removeItem(TRIED_KEY);
  if (bootSeed !== undefined) localStorage.setItem(BOOT_VERSION_KEY, bootSeed);
  if (triedSeed !== undefined) localStorage.setItem(TRIED_KEY, triedSeed);
  reloaded = 0;
  let i = 0;
  const fetchAppInfo = async () => structuredClone(served[Math.min(i++, served.length - 1)]);
  const getOwnBuild = own === null ? () => null : () => own;
  const ui = initUpdateNotice({ fetchAppInfo, getOwnBuild, pollMs: 0 });
  return ui;
}

test('marker: current build shows nothing — even with a stale record from an earlier session (REGRESSION)', async () => {
  const ui = load({
    served: [NEWER],
    own: 13, // this page IS the current shell
    bootSeed: V12, // an older session's localStorage — the shipped bug honoured this
    triedSeed: 'leftover',
  });
  await ui.refresh();
  assert.equal(notice().hidden, true, 'no notice on a current page');
  assert.equal(localStorage.getItem(TRIED_KEY), null, 'stale attempt record cleared');
  assert.equal(versionEl().textContent, 'v13');
  ui.stop();
});

test('marker: stale shell gets the reload button; click records + reloads', async () => {
  const ui = load({ served: [NEWER], own: 12 });
  await ui.refresh();
  assert.equal(notice().hidden, false);
  assert.match(btn().textContent, /Update available — v13/);
  btn().click();
  assert.equal(reloaded, 1);
  assert.equal(localStorage.getItem(TRIED_KEY), V13);
  ui.stop();
});

test('marker: reload that did not take (still the old shell) switches to close-and-re-open', async () => {
  const ui = load({ served: [NEWER], own: 12, triedSeed: V13 }); // booted old again after reload
  await ui.refresh();
  assert.ok(manual(), 'manual copy rendered');
  assert.equal(btn(), undefined, 'no reload button after a failed reload');
  assert.match(manual().textContent, /reload did not take/);
  assert.match(notice().textContent, /Close the app/);
  ui.stop();
});

test('marker: close-and-re-open to the new shell clears everything', async () => {
  const ui = load({ served: [NEWER], own: 13, triedSeed: V13 });
  await ui.refresh();
  assert.equal(notice().hidden, true);
  assert.equal(localStorage.getItem(TRIED_KEY), null);
  ui.stop();
});

test('fallback (no marker): boot proxy is recorded fresh per page load — stale carry-over never nags (REGRESSION)', async () => {
  const ui = load({ served: [NEWER], own: null, bootSeed: V12 });
  await ui.refresh(); // THIS load records V13 as its boot version, overwriting V12
  assert.equal(notice().hidden, true, 'a fresh page must not be called stale');
  assert.equal(localStorage.getItem(BOOT_VERSION_KEY), V13, 'record overwritten at first contact');
  ui.stop();
});

test('fallback (no marker): deploy during the session raises the button', async () => {
  const ui = load({ served: [BOOT, NEWER], own: null });
  await ui.refresh();
  await ui.refresh();
  assert.equal(notice().hidden, false);
  assert.match(btn().textContent, /Update available — v13/);
  btn().click();
  assert.equal(reloaded, 1);
  ui.stop();
});

test('footer version is a plain number; sha when the server has no number', async () => {
  const ui = load({ served: [BOOT], own: 12 });
  await ui.refresh();
  assert.equal(versionEl().textContent, 'v12');
  ui.stop();
  const ui2 = load({ served: [{ name: 'x', version: 'abc1234 (2026-01-01)' }], own: null });
  await ui2.refresh();
  assert.equal(versionEl().textContent, 'vabc1234');
  ui2.stop();
});

test('markup declares the slots and the baked-build token', () => {
  assert.ok(dom.declaredIds.has('client-version'));
  assert.ok(dom.declaredIds.has('update-notice'));
  assert.match(INDEX_HTML, /<meta name="app-build" content="__APP_BUILD__"/,
    'the shell carries the token be/src/app.js rewrites');
});
