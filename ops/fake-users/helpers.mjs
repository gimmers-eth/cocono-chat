// Shared services the fake-user types run on: real SDK accounts (keys live
// only in memory and die with the script), admin API calls, Redis/Mongo
// seeding for limiter + IP state, and a two-client friendship routine that
// produces genuine E2EE traffic.

import { CoconoClient, MemoryStorage } from '../../client/src/index.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeCtx({ baseUrl, adminUrl, adminToken, mongo, redis, config, quiet }) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  return {
    baseUrl, adminUrl, adminToken, mongo, redis, config,
    log,
    warn: (...a) => console.warn('⚠', ...a),
    fail: (...a) => console.error('✗', ...a),

    // One real account: SDK register (node WebCrypto keys, MemoryStorage →
    // nothing persists past process exit), then resolve its device id.
    // `referrer` rides the signup as the share-link parent (the God View's
    // solid purple edge) — see be/src/lib/shares.js.
    async account(username, { referrer = null } = {}) {
      const client = new CoconoClient({ baseUrl, storage: new MemoryStorage(), logging: false });
      await client.register(username, { referrer });
      const list = await client.devices();
      const current = list.devices.find((d) => d.current) ?? list.devices[0];
      return { ul: username.toLowerCase(), client, deviceId: current?.id ?? '', referrer: referrer ?? null };
    },

    async admin(method, path, body) {
      const res = await fetch(adminUrl + path, {
        method,
        headers: { 'x-admin-token': adminToken, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`admin ${method} ${path} → ${res.status}`);
      return res.json().catch(() => ({}));
    },

    // Plant a rate-limit counter exactly as the limiter would have made it.
    async seedRl(key, count, ttlSec) {
      await redis.set(key, String(count));
      await redis.expire(key, ttlSec);
    },

    // Latest-known egress IP for a device: the redis fast-path key the auth
    // hook uses + the device record field the admin UI reads.
    async deviceIp(ul, deviceId, ip) {
      await redis.set(`devip:${ul}:${deviceId}`, ip, { EX: 24 * 3600 });
      await mongo.collection('users').updateOne(
        { ul, 'devices.id': deviceId },
        { $set: { 'devices.$.lastIp': ip, 'devices.$.lastIpAt': new Date() } },
      );
    },

    async anonymousDiagnostics(text) {
      await fetch(`${baseUrl}/api/diagnostics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ report: text }),
      });
    },

    // connect + wait for the socket's 'open' state (sendMessage demands it;
    // a bare sleep races the handshake).
    async open(client, ms = 6000) {
      if (client.connectionState === 'open') return;
      await new Promise((resolve, reject) => {
        let off;
        const to = setTimeout(() => { off?.(); reject(new Error('websocket open timeout')); }, ms);
        off = client.on?.('state', ({ state }) => {
          if (state !== 'open') return;
          clearTimeout(to);
          off();
          resolve();
        });
      });
      await sleep(120); // let queued frames settle after the handshake
    },

    // A real friendship round between two live clients: mutual adds, the
    // verify/trust stages, and E2EE messages over the WebSocket.
    async bond(a, b, { verify = false, trust = false, messages = 0 } = {}) {
      await a.client.addFriend(b.ul);
      await b.client.addFriend(a.ul);
      if (verify) {
        await a.client.setFriendVerified(b.ul, true);
        await b.client.setFriendVerified(a.ul, true);
      }
      if (trust) await a.client.setFriendTrusted(b.ul, true);
      if (messages > 0) {
        await a.client.connect();
        await b.client.connect();
        await this.open(a.client);
        await this.open(b.client);
        for (let i = 1; i <= messages; i++) {
          await a.client.sendMessage(b.ul, `[${a.ul}→${b.ul}] friendly ping ${i}`);
          await b.client.sendMessage(a.ul, `[${b.ul}→${a.ul}] friendly pong ${i}`);
        }
        await sleep(300); // let acks/delivery land before we vanish
      }
    },
    async goodbye(...clients) {
      for (const c of clients) {
        try { c.disconnect?.(); } catch { /* bye */ }
      }
    },
  };
}
