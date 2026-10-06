# @cocono/client — JavaScript SDK

Event-driven SDK for the cocono-chat API: account registration, passwordless
login, multi-device pairing and end-to-end encrypted messaging. Everything a
client does — REST and WebSocket — runs through this SDK; the app never talks
to the API directly.

- **Isomorphic**: browsers (ES modules) and Node.js ≥ 22.9. Uses only Web
  APIs: `fetch`, `WebSocket`, `crypto.subtle` (Ed25519 + X25519).
- **Event-driven**: incoming messages, acks and delivery receipts are events.
- **Key-safe**: private keys are non-extractable `CryptoKey` handles and never
  leave the device (see [SIGNUP.md](./SIGNUP.md) for the crypto design).
- **Pluggable storage**: identity persistence via `MemoryStorage` (default),
  `IdbStorage` (browser IndexedDB) or your own adapter.
- **Console logging is off by default**, toggled with one option.

Protocol background: [DESIGN.md](./DESIGN.md),
[SIGNUP.md](./SIGNUP.md), [MESSAGES.md](./MESSAGES.md),
[be/openapi.yaml](../be/openapi.yaml).

## Install

Monorepo package — from the repo root:

```bash
pnpm install
```

```js
import { CoconoClient } from '@cocono/client';
// or without a package runner: import from 'client/src/index.js'
```

## Quick start

```js
const client = new CoconoClient({
  baseUrl: 'http://127.0.0.1:3000', // '' in a browser served by the BE
  logging: true,                    // console output, tagged [cocono-sdk]
});

// 1. Create an account (this device becomes the main one)
await client.register('gimmers');

// 2. Go online
client.on('message', (m) => console.log(`@${m.from}: ${m.text}`));
client.connect();
await new Promise((r) => client.once('state', (s) => s.state === 'open' && r()));

// 3. Send an E2EE message
const { localId, cids } = await client.sendMessage('mike1', 'hello');

// 4. Follow up on delivery
client.on('ack', ({ cid, ok, error }) => ...);       // per envelope
client.on('delivered', ({ cid, to }) => ...);        // recipient pulled it
```

## Options

| Option      | Default          | Description |
| ----------- | ---------------- | ----------- |
| `baseUrl`   | `''` (same-origin) | Server origin. Must be absolute (`http://…`) in Node; the WebSocket URL is derived from it (`ws://…`). |
| `logging`   | `false`          | `false` = silent, `true` = `[cocono-sdk]`-tagged `console.log`, or a custom sink `(level, ...args) => void`. |
| `storage`   | `MemoryStorage`  | Identity persistence (see below). |
| `fetchImpl` | `globalThis.fetch` | Injectable fetch (tests / polyfills). |

### Storage

The identity record (username, deviceId, non-extractable CryptoKey handles +
public material) is persisted through a tiny adapter:

```js
{ loadIdentity(): Promise<Identity>, saveIdentity(rec): Promise<void>, clearIdentity(): Promise<void> }
```

- `MemoryStorage` — per-session, gone on reload (fine for tests/CLI).
- `IdbStorage` — browser IndexedDB (structured clone keeps CryptoKeys).
  Identity records are keyed **per username** (`identity:<username>`) with a
  `current` pointer selecting the active account, so several accounts can
  coexist in one browser's storage without bleeding into each other (the
  client uses one active account per device for now).
- Bring your own for Electron/tauri/etc.

Losing the identity = losing access to the account from that device (no
recovery in the MVP, by design). `client.forget()` wipes the active account's
identity; the web app additionally deletes that account's message database
and read markers (`deleteAccountData()` in `client/app/js/store.js`).

## API

### Account & session

| Method | Description |
| ------ | ----------- |
| `register(username)` | Create account + first device, store identity, log in. → `{username, deviceId, token}` |
| `login()` | Challenge/response login with the stored identity. → `token` |
| `logout()` | Drop the session token (identity stays). |
| `forget()` | `logout()` + wipe the on-device identity. |
| `me()` | Account info (`GET /api/me`). |
| `devices()` | This account's devices (`GET /api/devices`). |
| `peerKeys(username, {refresh})` | Peer device key material (cached; `forgetPeer(username)` or `refresh: true` after they add devices). |

Usernames: 5–64 chars of `[a-zA-Z0-9_-]`, case-insensitive, some reserved —
see [SIGNUP.md](./SIGNUP.md).

### Device pairing (multi-device)

Two sides, mirroring [SIGNUP.md](./SIGNUP.md#multi-device):

```js
// On the NEW device (no identity yet):
const { code, deviceId, expiresInSec } = await newDevice.beginPairing('gimmers');
show(code);                                     // user types it into an existing device

// On an EXISTING, logged-in device:
const what = await existing.pendingPairing(code);   // { d, requestedAt } — inspect first
await existing.approvePairing(code);                // single-use code

// Back on the NEW device — resolves once approved, then logs in:
await newDevice.completePairing({ pollIntervalMs: 2000 });   // abortable via cancelPairing()
```

`beginPairing()` + `completePairing()` must run on the new device (its keys
are generated there and never leave). `cancelPairing()` aborts a pending or
in-flight pairing. Codes expire after `expiresInSec`
(server config, default 600 s); `completePairing()` throws `pairing_expired`
past the deadline.

### Messaging

| Method | Description |
| ------ | ----------- |
| `connect()` | Open the WebSocket (idempotent; auto-reconnect with backoff + jitter). |
| `disconnect()` | Close it. |
| `connectionState` | `'connecting' \| 'open' \| 'closing' \| 'closed'`. |
| `sendMessage(username, text)` | E2EE text message. Fans out **one envelope per recipient device** (pairwise keys, DESIGN.md) sharing one `localId`. → `{localId, peer, cids: string[]}` |

Messages are pulled-and-confirmed: when you receive a `'message'` event the
SDK has already told the server it can delete its copy. If decryption fails
the copy stays queued and an `'error'` (`decrypt_failed`) is emitted — a
tampered or key-mismatched message is never silently dropped.

## Events

All on the client itself (`client.on(type, fn)` → returns an `off()` function;
`once`, `off`, `removeAllListeners` also available).

| Event | Payload | Meaning |
| ----- | ------- | ------- |
| `ready` | `{username, deviceId}` | After register/login/pairing completes. |
| `state` | `{state}` | WebSocket: `'connecting'`, `'open'`, `'closed'`. |
| `message` | `{mid, peer, from, fromDeviceId, text, ts, self}` | Decrypted incoming message. `ts` is the **server-assigned** receive time (ms epoch) — use it for ordering, never client clocks. `self: true` for a message from another device of your own account (e.g. the other half of a self-chat). |
| `ack` | `{cid, localId, ok, error?}` | Server accepted/rejected one envelope. A fan-out send to a 2-device peer yields 2 acks with the same `localId`. |
| `delivered` | `{cid, localId, to}` | A recipient device pulled that copy. Expect one per recipient device. |
| `error` | `{error: Error}` | Server error frame or decrypt failure. |

Wire-level error codes on failed acks (`error.code` … see envelope checks in
`be/src/routes/ws-routes/`): `bad_hmac`, `sender_mismatch`,
`unknown_recipient`, `stale_payload`, `rate_limited`, …

Errors thrown by the SDK:

- `CoconoApiError` — any non-2xx REST response: `status`, `code` (server
  machine-readable), `message`.
- `CoconoError` — local misuse: `code` is one of `no_identity`,
  `identity_exists`, `not_authenticated`, `not_connected`,
  `no_peer_devices`, `no_pending_pairing`, `pairing_expired`,
  `pairing_cancelled`, `decrypt_failed`.

## Displaying messages (the sender's side)

A sent message produces: 1 optimistic local record (your app's own store) +
N acks + up to N delivered receipts (N = recipient device count). Dedupe by
**`localId`**, never by `cid`/`mid`:

```js
const store = new Map();                       // or IndexedDB, see fe/js/db.js
const { localId } = await client.sendMessage(peer, text);
store.set(localId, { text, state: 'sending' });

client.on('ack', ({ localId: id, ok }) => {
  if (id && store.has(id)) store.get(id).state = ok ? 'sent' : 'failed';
});
client.on('delivered', ({ localId: id }) => {
  if (id && store.has(id)) store.get(id).state = 'delivered';
});
```

And when rendering: rebuild the view atomically (build a fragment, then
`list.replaceChildren(fragment)`) — the classic
`clear → await → append` pattern races when several events land together and
shows bubbles twice. (This was a real bug; the SDK's events make the correct
pattern straightforward.)

## Logging

```js
new CoconoClient({ logging: true });                      // console
new CoconoClient({ logging: (level, ...a) => myLog(level, a) }); // custom sink
```

Off by default — no console noise in production. Logs cover REST calls, WS
state transitions, pairing and identity events; payloads are not dumped.

## Testing

From the repo root (needs the local Redis, see README):

```bash
pnpm --filter @cocono/client test
```

- `client/test/unit.test.js` — no server: wire-format contracts validated
  **against the backend's own canonicalizer/decoder/verifier**, plus
  emitter/logger/storage/REST plumbing.
- `client/test/integration.test.js` — boots the real Fastify app in-process
  (in-memory MongoDB via mongodb-memory-server + Redis), then exercises full
  SDK flows: register → login, pairing, messaging, multi-device fan-out,
  store-and-forward. Every test deletes the users it created and stops the
  server in `t.after()` hooks.

Local overrides go in `client/.env.test` (gitignored): `TEST_REDIS_URL`,
`REDIS_URL`, `LOG_LEVEL`.

## Notes & limits

- **Origins are separate worlds.** The identity lives in IndexedDB, which is
  scoped per origin: `http://localhost:3000`, `http://127.0.0.1:3000` and a LAN
  IP are three different key stores sharing one server. Moving between them
  yields `bad_signature` on login (the BE keeps that message deliberately
  generic to avoid account enumeration). Pick one URL per device; to migrate,
  pair the new location through the pairing flow.
- Text messages only (milestone 3); files/groups/tags land in later milestones
  and will extend `sendMessage` or add typed variants.
- One tab per device in browsers (the app-level guard in the FE; the SDK
  itself doesn't enforce it).
- The peer key cache is only refreshed via `peerKeys(_, {refresh: true})` /
  `forgetPeer()` — call it when a peer may have paired a new device, or the
  fan-out will miss it.
- Reconnection is automatic; messages queued while you were offline arrive on
  the next `'open'`.
