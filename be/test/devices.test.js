import test from 'node:test';
import assert from 'node:assert/strict';
import { setupApp, makeClient, randomAesKey, nowEpoch } from './helpers.js';

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
  const t = nowEpoch();
  const s = client.signSignup({ u, a, d, t });
  return app.inject({
    method: 'POST',
    url: '/api/signup',
    payload: { u, p: client.p, x: client.x, a, d, t, s },
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

// Enrollment is signed exactly like signup: canonical({ a, d, p, t, u, x }).
async function enroll(app, client, u, d) {
  const a = randomAesKey();
  const t = nowEpoch();
  const s = client.signSignup({ u, a, d, t });
  return app.inject({
    method: 'POST',
    url: '/api/devices/enroll',
    payload: { u, p: client.p, x: client.x, a, d, t, s },
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
    const badSigClient = makeClient();
    const badSig = await app.inject({
      method: 'POST',
      url: '/api/devices/enroll',
      payload: { u, p: badSigClient.p, x: badSigClient.x, a: randomAesKey(), d: 'device-badsig-01', t: nowEpoch(), s: 'A'.repeat(86) },
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

test('enroll rejects stale or replayed payloads (M6)', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const u = 'alice';
    const main = makeClient();
    assert.equal((await signupUser(app, main, u, 'main-device-0001')).statusCode, 201);

    // Stale timestamp.
    const stale = makeClient();
    const a = randomAesKey();
    const t = nowEpoch() - 3600;
    const staleRes = await app.inject({
      method: 'POST',
      url: '/api/devices/enroll',
      payload: { u, p: stale.p, x: stale.x, a, d: 'device-stale-0001', t, s: stale.signSignup({ u, a, d: 'device-stale-0001', t }) },
    });
    assert.equal(staleRes.statusCode, 400);
    assert.equal(staleRes.json().error, 'stale_payload');

    // Replay: the exact same signed enrollment cannot be sent twice.
    const second = makeClient();
    const a2 = randomAesKey();
    const t2 = nowEpoch();
    const d2 = 'second-device-0002';
    const payload = { u, p: second.p, x: second.x, a: a2, d: d2, t: t2, s: second.signSignup({ u, a: a2, d: d2, t: t2 }) };
    assert.equal((await app.inject({ method: 'POST', url: '/api/devices/enroll', payload })).statusCode, 201);
    const replay = await app.inject({ method: 'POST', url: '/api/devices/enroll', payload });
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().error, 'replay');
  } finally {
    await teardown();
  }
});

test('pending endpoint shows what would be approved (L6)', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const u = 'alice';
    const main = makeClient();
    assert.equal((await signupUser(app, main, u, 'main-device-0001')).statusCode, 201);
    const tokenMain = await getToken(app, main, u, 'main-device-0001');

    const second = makeClient();
    const dSecond = 'second-device-0002';
    const { code } = (await enroll(app, second, u, dSecond)).json();

    // Without a token.
    const noAuth = await app.inject({ method: 'POST', url: '/api/devices/pending', payload: { code } });
    assert.equal(noAuth.statusCode, 401);

    // With a token: device id + request time.
    const res = await app.inject({
      method: 'POST',
      url: '/api/devices/pending',
      headers: { authorization: `Bearer ${tokenMain}` },
      payload: { code },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().d, dSecond);
    assert.ok(res.json().requestedAt);

    // Unknown code.
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/devices/pending',
      headers: { authorization: `Bearer ${tokenMain}` },
      payload: { code: '000000' },
    });
    assert.equal(unknown.statusCode, 404);
  } finally {
    await teardown();
  }
});

test('admin device removal revokes the device session (H4)', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const u = 'alice';
    const main = makeClient();
    assert.equal((await signupUser(app, main, u, 'main-device-0001')).statusCode, 201);
    const tokenMain = await getToken(app, main, u, 'main-device-0001');

    // Add + log in a second device.
    const second = makeClient();
    const dSecond = 'second-device-0002';
    const { code } = (await enroll(app, second, u, dSecond)).json();
    assert.equal(
      (await app.inject({
        method: 'POST',
        url: '/api/devices/approve',
        headers: { authorization: `Bearer ${tokenMain}` },
        payload: { code },
      })).statusCode,
      200,
    );
    const tokenSecond = await getToken(app, second, u, dSecond);

    const before = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${tokenSecond}` },
    });
    assert.equal(before.statusCode, 200);

    // Remove the second device the same way the admin route does.
    await mongo.db.collection('users').updateOne({ ul: u }, { $pull: { devices: { id: dSecond } } });

    const after = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${tokenSecond}` },
    });
    assert.equal(after.statusCode, 401);

    // Crucially, the revoked device can no longer approve further devices.
    const rogue = makeClient();
    const rogueEnroll = await enroll(app, rogue, u, 'rogue-device-0001');
    const rogueApprove = await app.inject({
      method: 'POST',
      url: '/api/devices/approve',
      headers: { authorization: `Bearer ${tokenSecond}` },
      payload: { code: rogueEnroll.json().code },
    });
    assert.equal(rogueApprove.statusCode, 401);

    // The main device still works.
    const mainStillOk = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${tokenMain}` },
    });
    assert.equal(mainStillOk.statusCode, 200);
  } finally {
    await teardown();
  }
});
