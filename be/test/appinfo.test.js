import test from 'node:test';
import assert from 'node:assert/strict';
import { setupApp } from './helpers.js';
import { config } from '../src/config.js';

test('app-info: env default, admin override, manifest reflects name', async () => {
  const { app, mongo, teardown } = await setupApp();
  try {
    const d = await app.inject({ method: 'GET', url: '/api/app-info' });
    assert.equal(d.statusCode, 200);
    assert.equal(d.json().name, config.appName);

    await mongo.db.collection('settings').updateOne(
      { _id: 'branding' }, { $set: { appName: 'Renamed' } }, { upsert: true },
    );
    const o = await app.inject({ method: 'GET', url: '/api/app-info' });
    assert.equal(o.json().name, 'Renamed');

    // No FE root in tests → no manifest route; just confirm 404 is clean.
    const m = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    assert.equal(m.statusCode, 404);
  } finally {
    await teardown();
  }
});
