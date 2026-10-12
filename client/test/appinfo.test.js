// appinfo.js — the PAGE's single /api/app-info caller. The rules that keep
// one refresh at ONE request (in-flight dedup, a 30 s TTL equal to the
// server's own git-cache window, and failures NEVER cached) are pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAppInfo, resetAppInfo } from '../app/js/appinfo.js';

const realFetch = globalThis.fetch;

/** Install a counting fake fetch; `mode` decides the answer. */
async function withFetch(mode, fn) {
  resetAppInfo();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (mode === 'throw') throw new TypeError('offline');
    if (mode === 'limited') return { ok: false, status: 429 };
    await new Promise((r) => setTimeout(r, 5));
    return { ok: true, json: async () => ({ build: 331, version: 'abc (x)' }) };
  };
  try { await fn(() => calls); } finally { globalThis.fetch = realFetch; resetAppInfo(); }
}

test('appinfo: concurrent callers share ONE request (in-flight dedup)', async () => {
  await withFetch('ok', async (getCalls) => {
    const [a, b, c] = await Promise.all([getAppInfo(), getAppInfo(), getAppInfo()]);
    assert.equal(getCalls(), 1, 'the boot burst (branding + update notice + enablePush) is ONE hit');
    assert.deepEqual(a, b);
    assert.equal(c.build, 331);
  });
});

test('appinfo: the TTL answers without the wire; fresh:true forces it', async () => {
  await withFetch('ok', async (getCalls) => {
    await getAppInfo();
    assert.equal(getCalls(), 1);
    const reused = await getAppInfo(); // inside 30 s: provably the same answer
    assert.equal(getCalls(), 1, 'a re-read inside the server cache window cannot be newer');
    assert.equal(reused.build, 331);
    await getAppInfo({ fresh: true });
    assert.equal(getCalls(), 2, 'fresh:true bypasses the cache');
    await getAppInfo({ ttlMs: 0 }); // expired TTL (the 5-minute poll case)
    assert.equal(getCalls(), 3);
  });
});

test('appinfo: NOTHING is cached on failure — the next caller hits the wire', async () => {
  await withFetch('throw', async (getCalls) => {
    assert.equal(await getAppInfo(), null, 'offline yields null (callers keep defaults)');
    assert.equal(await getAppInfo(), null, 'and the failure did not cache');
    assert.equal(getCalls(), 2, 'every caller retries the wire — the update notice fast-retry relies on this');
  });
  await withFetch('limited', async (getCalls) => {
    assert.equal(await getAppInfo(), null, 'a 429 is not an answer to cache');
    assert.equal(getCalls(), 1);
    assert.equal(await getAppInfo(), null);
    assert.equal(getCalls(), 2, 'the limiter window passing is discovered by the NEXT caller');
  });
});
