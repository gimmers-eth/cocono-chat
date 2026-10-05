import test from 'node:test';
import assert from 'node:assert/strict';
import { setupApp } from './helpers.js';

// 'Send diagnostics' — POST /api/diagnostics.
test('diagnostics: stores anonymous reports with metadata', async () => {
  const { app, mongo, teardown } = await setupApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/diagnostics',
      payload: { report: '--- now ---\norigin: https://dev.co.co.no\nindexeddb: none present' },
      headers: { 'user-agent': 'PhoneBrowser/1.0' },
    });
    assert.equal(res.statusCode, 202);

    const doc = await mongo.db.collection('diagnostics').findOne({ account: null });
    assert.ok(doc, 'report stored');
    assert.match(doc.report, /indexeddb: none present/);
    assert.equal(doc.ua, 'PhoneBrowser/1.0');
  } finally {
    await teardown();
  }
});

test('diagnostics: empty reports are rejected', async () => {
  const { app, teardown } = await setupApp();
  try {
    for (const payload of [{}, { report: '   ' }, { report: 42 }]) {
      const res = await app.inject({ method: 'POST', url: '/api/diagnostics', payload });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, 'invalid_report');
    }
  } finally {
    await teardown();
  }
});

test('diagnostics: rate limit is per IP', async () => {
  const { app, teardown } = await setupApp({ diagIpLimit: 3, diagIpWindowSec: 60 });
  try {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/diagnostics', payload: { report: `r${i}` } });
      assert.equal(res.statusCode, 202);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/diagnostics', payload: { report: 'one too many' } });
    assert.equal(limited.statusCode, 429);
  } finally {
    await teardown();
  }
});
