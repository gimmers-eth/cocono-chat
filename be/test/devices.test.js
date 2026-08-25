import test from 'node:test';
import assert from 'node:assert/strict';
import { setupApp, makeClient, randomAesKey } from './helpers.js';

// Relaxed limits so the happy-path tests don't trip the limiter.
const LIMITS = {
  signupIpLimit: 1000,
  challengeIpLimit: 1000,
  verifyAccountLimit: 1000,
  deviceEnrollIpLimit: 1000,
  deviceApproveAccountLimit: 1000,
};

async function signupUser(app, client, u, d) {
  const a = randomAesKey();
  const s = client.signSignup({ u, a, d });
  return app.inject({
    method: 'POST',
    url: '/api/signup',
    payload: { u, p: client.p, a, d, s },
  });
}

async function getToken(app, client, u, d) {
  const { n } = (
    await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u, d } })
  ).json();
  const s = client.signBytes(Buffer.from(n, 'utf8'));
  const { token } = (
    await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { u, d, n, s } })
  ).json();
  return token;
}

// Enrollment is signed exactly like signup: canonical({ a, d, p, u }).
async function enroll(app, client, u, d) {
  const a = randomAesKey();
  const s = client.signSignup({ u, a, d });
  return app.inject({
    method: 'POST',
    url: '/api/devices/enroll',
    payload: { u, p: client.p, a, d, s },
  });
}

test('device flow: enroll -> approve -> second device logs in', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const u = 'alice';
    const dMain = 'main-device-0001';
    const main = makeClient();
    assert.equal((await signupUser(app, main, u, dMain)).statusCode, 201);
    const tokenMain = await getToken(app, main, u, dMain);

    // New device enrolls.
    const second = makeClient();
    const dSecond = 'second-device-0002';
    const enrollRes = await enroll(app, second, u, dSecond);
    assert.equal(enrollRes.statusCode, 201);
    const { code, enrollId, expiresInSec } = enrollRes.json();
    assert.match(code, /^\d{6}$/);
    assert.ok(enrollId);
    assert.ok(expiresInSec > 0);

    // Polling before approval: pending.
    const pending = await app.inject({ method: 'GET', url: `/api/devices/enroll-status/${enrollId}` });
    assert.equal(pending.statusCode, 200);
    assert.deepEqual(pending.json(), { approved: false });

    // Approve from the main device.
    const approve = await app.inject({
      method: 'POST',
      url: '/api/devices/approve',
      headers: { authorization: `Bearer ${tokenMain}` },
      payload: { code },
    });
    assert.equal(approve.statusCode, 200);
    assert.equal(approve.json().approved, dSecond);

    // Polling after approval.
    const okStatus = await app.inject({ method: 'GET', url: `/api/devices/enroll-status/${enrollId}` });
    assert.deepEqual(okStatus.json(), { approved: true });

    // The second device can now authenticate with the standard flow.
    const tokenSecond = await getToken(app, second, u, dSecond);
    assert.ok(tokenSecond);

    // Device list shows both, with correct main/current flags.
    const listMain = await app.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { authorization: `Bearer ${tokenMain}` },
    });
    const body = listMain.json();
    assert.equal(body.devices.length, 2);
    assert.equal(body.maxDevices, 3);
    const mainDev = body.devices.find((dev) => dev.id === dMain);
    const secondDev = body.devices.find((dev) => dev.id === dSecond);
    assert.ok(mainDev.main && mainDev.current && !secondDev.main && !secondDev.current);

    const listSecond = await app.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { authorization: `Bearer ${tokenSecond}` },
    });
    assert.ok(listSecond.json().devices.find((dev) => dev.id === dSecond).current);
  } finally {
    await teardown();
  }
});

test('enroll rejects unknown accounts, bad signatures, duplicates and limits', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const u = 'alice';
    const dMain = 'main-device-0001';
    const main = makeClient();
    assert.equal((await signupUser(app, main, u, dMain)).statusCode, 201);

    // Unknown account.
    const ghost = makeClient();
    const ghostRes = await enroll(app, ghost, 'nobody-here', 'device-ghost-01');
    assert.equal(ghostRes.statusCode, 404);

    // Bad signature.
    const badSig = await app.inject({
      method: 'POST',
      url: '/api/devices/enroll',
      payload: { u, p: makeClient().p, a: randomAesKey(), d: 'device-badsig-01', s: 'A'.repeat(86) },
    });
    assert.equal(badSig.statusCode, 401);

    // Device id already registered.
    const dup = makeClient();
    const dupRes = await enroll(app, dup, u, dMain);
    assert.equal(dupRes.statusCode, 409);
    assert.equal(dupRes.json().error, 'device_exists');

    // Fill up to the limit (3 devices), then the 4th enroll is rejected.
    const tokenMain = await getToken(app, main, u, dMain);
    for (let i = 0; i < 2; i++) {
      const extra = makeClient();
      const dExtra = `extra-device-00${i}1`;
      const res = await enroll(app, extra, u, dExtra);
      assert.equal(res.statusCode, 201);
      const approve = await app.inject({
        method: 'POST',
        url: '/api/devices/approve',
        headers: { authorization: `Bearer ${tokenMain}` },
        payload: { code: res.json().code },
      });
      assert.equal(approve.statusCode, 200);
    }
    const overflow = await enroll(app, makeClient(), u, 'device-overflow1');
    assert.equal(overflow.statusCode, 409);
    assert.equal(overflow.json().error, 'device_limit');
  } finally {
    await teardown();
  }
});

test('approve guards: auth, format, scoping, single-use', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const u = 'alice';
    const dMain = 'main-device-0001';
    const main = makeClient();
    assert.equal((await signupUser(app, main, u, dMain)).statusCode, 201);
    const tokenMain = await getToken(app, main, u, dMain);

    // No token.
    const noAuth = await app.inject({ method: 'POST', url: '/api/devices/approve', payload: { code: '123456' } });
    assert.equal(noAuth.statusCode, 401);

    // Bad format.
    const badFormat = await app.inject({
      method: 'POST',
      url: '/api/devices/approve',
      headers: { authorization: `Bearer ${tokenMain}` },
      payload: { code: '12ab56' },
    });
    assert.equal(badFormat.statusCode, 400);

    // Unknown code.
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/devices/approve',
      headers: { authorization: `Bearer ${tokenMain}` },
      payload: { code: '000000' },
    });
    assert.equal(unknown.statusCode, 404);

    // Code is scoped per account: bob cannot approve alice's enrollment.
    const bob = makeClient();
    assert.equal((await signupUser(app, bob, 'bobby', 'bobs-device-0001')).statusCode, 201);
    const enrollRes = await enroll(app, makeClient(), u, 'third-device-001');
    const { code } = enrollRes.json();
    const tokenBob = await getToken(app, bob, 'bobby', 'bobs-device-0001');
    const cross = await app.inject({
      method: 'POST',
      url: '/api/devices/approve',
      headers: { authorization: `Bearer ${tokenBob}` },
      payload: { code },
    });
    assert.equal(cross.statusCode, 404);

    // Single-use: approve once, second attempt fails.
    const first = await app.inject({
      method: 'POST',
      url: '/api/devices/approve',
      headers: { authorization: `Bearer ${tokenMain}` },
      payload: { code },
    });
    assert.equal(first.statusCode, 200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/devices/approve',
      headers: { authorization: `Bearer ${tokenMain}` },
      payload: { code },
    });
    assert.equal(second.statusCode, 404);
  } finally {
    await teardown();
  }
});

test('enroll-status rejects malformed and unknown enrollIds', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const malformed = await app.inject({ method: 'GET', url: '/api/devices/enroll-status/!!' });
    assert.equal(malformed.statusCode, 400);

    const unknown = await app.inject({ method: 'GET', url: '/api/devices/enroll-status/AAAAAAAAAAAAAAAAAAAAAA' });
    assert.equal(unknown.statusCode, 410);
  } finally {
    await teardown();
  }
});
