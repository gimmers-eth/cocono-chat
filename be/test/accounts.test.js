import test from 'node:test';
import assert from 'node:assert/strict';
import { setupApp, makeClient, randomAesKey, nowEpoch } from './helpers.js';
import { canonical } from '../src/lib/canon.js';

// Relaxed limits so the happy-path tests don't trip the limiter.
const LIMITS = {
  signupIpLimit: 1000,
  challengeIpLimit: 1000,
  verifyAccountLimit: 1000,
};

async function signupUser(app, client, u, a, d, t = nowEpoch()) {
  const s = client.signSignup({ u, a, d, t });
  return app.inject({
    method: 'POST',
    url: '/api/signup',
    payload: { u, p: client.p, x: client.x, a, d, t, s },
  });
}

test('accounts happy path: signup -> challenge -> verify -> me', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const client = makeClient();
    const u = 'alice';
    const a = randomAesKey();
    const d = '01234567-89ab-cdef-0123-456789abcdef';

    const res = await signupUser(app, client, u, a, d);
    assert.equal(res.statusCode, 201);

    const challenge = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { u, d },
    });
    assert.equal(challenge.statusCode, 200);
    const { n } = challenge.json();
    assert.ok(n);

    const sig = client.signBytes(Buffer.from(n, 'utf8'));
    const verify = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { u, d, n, s: sig },
    });
    assert.equal(verify.statusCode, 200);
    const { token } = verify.json();
    assert.ok(token);

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().u, u);
    assert.equal(me.json().d, d);
  } finally {
    await teardown();
  }
});

test('signup rejects invalid usernames and reserved names', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const client = makeClient();
    const d = 'device-one-123';

    const tooLong = 'a'.repeat(65); // L3 fix: usernames capped at 64
    for (const u of ['abcd', 'has space', 'punct!', 'server', 'admin', tooLong]) {
      const res = await signupUser(app, client, u, randomAesKey(), d);
      assert.equal(res.statusCode, 400, `username ${u.slice(0, 20)} should be rejected`);
    }
  } finally {
    await teardown();
  }
});

test('signup is case-insensitive for uniqueness', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const c1 = makeClient();
    const c2 = makeClient();
    const d = 'device-one-123';

    assert.equal((await signupUser(app, c1, 'alice', randomAesKey(), d)).statusCode, 201);
    const dup = await signupUser(app, c2, 'ALICE', randomAesKey(), d);
    assert.equal(dup.statusCode, 409);
  } finally {
    await teardown();
  }
});

test('signup rejects a bad signature', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const client = makeClient();
    const u = 'alice';
    const res = await app.inject({
      method: 'POST',
      url: '/api/signup',
      payload: {
        u,
        p: client.p,
        x: client.x,
        a: randomAesKey(),
        d: 'device-one-123',
        t: nowEpoch(),
        s: 'A'.repeat(86), // wrong signature
      },
    });
    assert.equal(res.statusCode, 401);
  } finally {
    await teardown();
  }
});

test('signup rejects malformed keys', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const client = makeClient();
    const d = 'device-one-123';

    const badPub = await app.inject({
      method: 'POST',
      url: '/api/signup',
      payload: { u: 'alice', p: 'too-short', a: randomAesKey(), d, t: nowEpoch(), s: 'x' },
    });
    assert.equal(badPub.statusCode, 400);

    const badAes = await signupUser(app, client, 'bob', 'not-a-key', d);
    assert.equal(badAes.statusCode, 400);
  } finally {
    await teardown();
  }
});

test('signup rejects stale or replayed payloads (M6)', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    // Stale timestamp: outside the freshness window.
    const stale = makeClient();
    const staleRes = await signupUser(app, stale, 'staleuser', randomAesKey(), 'device-stale-01', nowEpoch() - 3600);
    assert.equal(staleRes.statusCode, 400);
    assert.equal(staleRes.json().error, 'stale_payload');

    // Replay: the exact same signed payload cannot be used twice.
    const client = makeClient();
    const u = 'alice';
    const a = randomAesKey();
    const d = 'device-one-123';
    assert.equal((await signupUser(app, client, u, a, d)).statusCode, 201);
    const replay = await signupUser(app, client, u, a, d); // identical payload + signature
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().error, 'replay');
  } finally {
    await teardown();
  }
});

test('challenge no longer reveals account/device existence (L1)', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const client = makeClient();
    const d = 'device-one-123';
    await signupUser(app, client, 'alice', randomAesKey(), d);

    // Unknown account and unknown device both get a nonce now — same shape
    // as a real one, so existence cannot be probed via challenge.
    const noUser = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { u: 'nobody-here', d },
    });
    assert.equal(noUser.statusCode, 200);
    assert.ok(noUser.json().n);

    const noDevice = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { u: 'alice', d: 'other-device-999' },
    });
    assert.equal(noDevice.statusCode, 200);
    assert.ok(noDevice.json().n);

    // ...but verify still fails for the phantom nonce.
    const verify = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { u: 'nobody-here', d, n: noUser.json().n, s: client.signBytes(Buffer.from(noUser.json().n, 'utf8')) },
    });
    assert.equal(verify.statusCode, 401);
  } finally {
    await teardown();
  }
});

test('verify junk cannot exhaust an account budget (M1)', async () => {
  const { app, teardown } = await setupApp({ ...LIMITS, verifyAccountLimit: 3 });
  try {
    const client = makeClient();
    const u = 'alice';
    const d = 'device-one-123';
    await signupUser(app, client, u, randomAesKey(), d);

    // Junk verify requests (no valid nonce) must not consume the budget.
    for (let i = 0; i < 10; i++) {
      const junk = await app.inject({
        method: 'POST',
        url: '/api/auth/verify',
        payload: { u, d, n: `junknonce${i}`, s: 'B'.repeat(86) },
      });
      assert.equal(junk.statusCode, 401);
    }

    // The victim can still log in afterwards.
    const { n } = (
      await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u, d } })
    ).json();
    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { u, d, n, s: client.signBytes(Buffer.from(n, 'utf8')) },
    });
    assert.equal(ok.statusCode, 200);
  } finally {
    await teardown();
  }
});

test('a removed device loses access immediately (H4)', async () => {
  const { app, mongo, teardown } = await setupApp(LIMITS);
  try {
    const client = makeClient();
    const u = 'alice';
    const d = 'device-one-123';
    await signupUser(app, client, u, randomAesKey(), d);

    const { n } = (
      await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u, d } })
    ).json();
    const { token } = (
      await app.inject({
        method: 'POST',
        url: '/api/auth/verify',
        payload: { u, d, n, s: client.signBytes(Buffer.from(n, 'utf8')) },
      })
    ).json();

    const before = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(before.statusCode, 200);

    // Simulate admin removing the device (add a dummy second one first so the
    // removal is legal, then pull the token's device).
    await mongo.db.collection('users').updateOne(
      { ul: u },
      { $push: { devices: { id: 'dummy-device-0002', pub: 'x', aes: 'x', main: false } } },
    );
    await mongo.db.collection('users').updateOne({ ul: u }, { $pull: { devices: { id: d } } });

    // The still-valid JWT must be rejected now.
    const after = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(after.statusCode, 401);
  } finally {
    await teardown();
  }
});

test('verify rejects bad signature, wrong device, and replayed nonce', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const client = makeClient();
    const u = 'alice';
    const d = 'device-one-123';
    await signupUser(app, client, u, randomAesKey(), d);

    const newNonce = async () =>
      (
        await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { u, d } })
      ).json().n;

    // Nonces are single-use: a failed attempt consumes it.
    const n1 = await newNonce();
    const badSig = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { u, d, n: n1, s: 'B'.repeat(86) },
    });
    assert.equal(badSig.statusCode, 401);

    const n2 = await newNonce();
    const sig2 = client.signBytes(Buffer.from(n2, 'utf8'));
    const wrongDevice = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { u, d: 'other-device-999', n: n2, s: sig2 },
    });
    assert.equal(wrongDevice.statusCode, 401);

    const n3 = await newNonce();
    const sig3 = client.signBytes(Buffer.from(n3, 'utf8'));
    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { u, d, n: n3, s: sig3 },
    });
    assert.equal(ok.statusCode, 200);

    // Replay of the consumed nonce must fail.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { u, d, n: n3, s: sig3 },
    });
    assert.equal(replay.statusCode, 401);
  } finally {
    await teardown();
  }
});

test('/api/me requires a valid token', async () => {
  const { app, teardown } = await setupApp(LIMITS);
  try {
    const noToken = await app.inject({ method: 'GET', url: '/api/me' });
    assert.equal(noToken.statusCode, 401);

    const badToken = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: 'Bearer not-a-token' },
    });
    assert.equal(badToken.statusCode, 401);
  } finally {
    await teardown();
  }
});

test('signup rate limiting kicks in after the limit', async () => {
  const { app, teardown } = await setupApp({ ...LIMITS, signupIpLimit: 2 });
  try {
    const client = makeClient();
    const d = 'device-one-123';

    await signupUser(app, client, 'user-one', randomAesKey(), d);
    await signupUser(app, makeClient(), 'user-two', randomAesKey(), d);

    const blocked = await signupUser(app, makeClient(), 'user-three', randomAesKey(), d);
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 0);
  } finally {
    await teardown();
  }
});

test('canonical signup payload is what the client signs', async () => {
  // Guards against FE/BE canonical drift for the exact signup shape.
  const body = { a: 'AAA', d: 'device-one-123', p: 'BBB', t: 1700000000, u: 'alice', x: 'XXX' };
  assert.equal(
    canonical(body),
    canonical({ u: 'alice', t: 1700000000, x: 'XXX', p: 'BBB', d: 'device-one-123', a: 'AAA' }),
  );
});
