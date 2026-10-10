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
| `register(username, {referrer})` | Create account + first device, store identity, log in. → `{username, deviceId, token}`. `referrer` (optional) is the username whose share link this signup followed — see [Share links](#share-links). |
| `login()` | Challenge/response login with the stored identity. → `token` |
| `logout()` | Drop the session token (identity stays). |
| `forget()` | `logout()` + wipe the on-device identity. |
| `me()` | Account info (`GET /api/me`). |
| `devices()` | This account's devices (`GET /api/devices`). |
| `peerKeys(username, {refresh})` | Peer device key material (cached; `forgetPeer(username)` or `refresh: true` after they add devices). |

Usernames: 5–64 chars of `[a-zA-Z0-9_-]`, case-insensitive, some reserved —
see [SIGNUP.md](./SIGNUP.md).

### Share links

Attribution metadata for `/?chat=<username>` deep links — who brought whom to
the app. Full model, admin views and honest limits:
[SHARES.md](./SHARES.md).

| Method | Description |
| ------ | ----------- |
| `register(username, {referrer})` | `referrer` is sent as the UNSIGNED `r` field of the signup body and stored as the new account's parent. Omit for an organic signup. |
| `reportShareHit(owner)` | "This session opened `owner`'s link." → `{ok, recorded}`. **Never throws**: a failure (offline, deleted owner) is reported in the result, because attribution must not be able to disturb a boot path. Your own link is not sent at all. |
| `myShareLink()` | → `{ul, path, created, clicked}` — your link plus how many accounts it created / how many opened it. Counts only, never who. |

```js
// a visitor arrived from @alice's link and has no account yet
await client.register('gimmers', { referrer: 'alice' });

// an EXISTING account opening a link, once the session is up
const res = await client.reportShareHit('alice');   // {ok: true, recorded: true}
```

The shipped app parks the clicked link in `localStorage`
(`client/app/js/shares.js`) so it survives the auth screen: a signup carries it
as `referrer`, a login reports it as a hit, and an offline boot leaves it
parked for the next entry.

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
| `sendMessage(username, text, opts?)` | E2EE text message. Fans out **one envelope per recipient device** (pairwise keys, DESIGN.md) sharing one `localId`. Unless the target is your own account (self-chat), the message is ALSO mirrored to your other devices as an outgoing **sync copy** — those surface as `sync` events there, never as `message`, and their acks/receipts never reach you (`{ sync: false }` opts out; the mirror is best-effort). → `{localId, peer, cids: string[]}` (`cids` = peer copies only) |
| `sendMedia(username, media, opts?)` | E2EE **photo / video / file** (M4). `{ kind: 'image'\|'video'\|'file', bytes, thumb?, name?, mime?, w?, h?, dur?, animated? }` — `bytes`/`thumb` are `ArrayBuffer`/`Uint8Array`/`Blob` (the SDK has no DOM, so the APP resizes and thumbnails). Generates a per-file AES-GCM-256 key, encrypts, uploads the CIPHERTEXT (`POST /api/media`), then fans out one envelope per recipient device carrying the key inside it, plus the plaintext `att` descriptor; own other devices get the same media object as a **sync copy** whose `att` makes them owe a download+ack like any recipient. `{ localId }` in `opts` lets the caller pre-claim the id (the app writes the sender's own copy BEFORE the upload). Upload failure throws before any envelope leaves; a post-upload failure is reclaimed by the server's orphan sweep. → `{localId, peer, cids, media}` where `media` is the descriptor to store locally |
| `downloadMedia(id, media)` | Fetch a blob's ciphertext, **verify it against the sender's `sha256`**, decrypt → `{ data: Blob, thumb: Blob\|null }` (the thumbnail is fetched only when `media.thumbIv` exists). Mismatch throws `media_tampered` and must NOT be acked. 404 → `unknown_media` (the blob is gone: render "no longer available"). |
| `downloadThumb(id, media)` | Poster/preview bytes only — what a video arrival auto-fetches without pulling the file. Deliberately does **not** ack (only a full download or a decline settles the lifecycle). |
| `ackMedia(id, downloaded)` | Settle this device's debt: `true` = downloaded, `false` = declined ("delete it before I download it" — that counts as received). When every authorised device has acked, the server deletes the blob. |
| `reportUser(username, { reason, description, messages, media?, block? })` | `media` (M4) is `[{ blobId, kind, name, mime, key, iv, thumbIv?, bytes? }]` — the file keys this device legitimately holds for the reported conversation, plus its own plaintext where it still has it (`bytes`; the SDK base64url-encodes and trims to the server's 3-item cap). This is what makes reported media readable server-side; the UI warning says so before sending. |

Messages are pulled-and-confirmed: when you receive a `'message'` event the
SDK has already told the server the copy was pulled (it is kept only for the
bounded resync window). If decryption fails
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
| `sync` | `{id, peer, text, media?, ts, fromDeviceId}` | An OUTGOING message mirrored from another of your own devices (multi-device sync). Store it as an outgoing record under `id` (the originating device's `localId` — same id on every device, so replays dedupe naturally). `media` (M4) is set instead of `text` for a media send: the SAME descriptor the sender stored, so this device can join the blob lifecycle (download + ack) like any recipient. Never raise notifications, read markers or delivery ticks for it — status lives on the device that sent it. |
| `ack` | `{cid, localId, ok, error?}` | Server accepted/rejected one envelope. A fan-out send to a 2-device peer yields 2 acks with the same `localId`. |
| `delivered` | `{cid, localId, to}` | A recipient device pulled that copy. Expect one per recipient device. |
| `notice` | `{what}` | Content-free server nudge: a slice of server-authoritative state this account caches moved because of **someone else** (`what`: `friends`, `gone`, `profile`, `identity` — taxonomy in `be/src/lib/notify.js`). Re-pull that data yourself; never trust the frame for content. Offline = missed; reconcile-on-entry covers it. |
| `error` | `{error: Error}` | Server error frame or decrypt failure. |

Wire-level error codes on failed acks (`error.code` … see envelope checks in
`be/src/routes/ws-routes/`): `bad_hmac`, `sender_mismatch`,
`unknown_recipient`, `stale_payload`, `rate_limited`, `verify_required`,
`blocked`, `self_blocked`, and for media envelopes `unknown_attachment`
(the `att` names a blob that is gone, or is not this sender's own upload).

Errors thrown by the SDK:

- `CoconoApiError` — any non-2xx REST response: `status`, `code` (server
  machine-readable), `message`.
- `CoconoError` — local misuse: `code` is one of `no_identity`,
  `identity_exists`, `not_authenticated`, `not_connected`,
  `no_peer_devices`, `no_pending_pairing`, `pairing_expired`,
  `pairing_cancelled`, `decrypt_failed`, and for media
  `no_media` / `no_media_key` (missing inputs) or `media_tampered`
  (a download whose bytes do not match the sender's digest).
- Media REST codes arrive as `CoconoApiError`: `media_too_large`,
  `thumb_too_large`, `media_quota`, `bad_sha256`, `unknown_media`,
  `rate_limited` — the app maps them to sentences (see `client/app/js/media.js`).

## Displaying messages (the sender's side)

A sent message produces: 1 optimistic local record (your app's own store) +
N acks + up to N delivered receipts (N = recipient device count — sync copies
 to your own devices are invisible here, the SDK swallows their acks and
receipts). Dedupe by **`localId`**, never by `cid`/`mid`:

```js
const store = new Map();                       // or IndexedDB, see client/src/storage.js
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
- Media (milestone 4) is 1:1 only: ≤ 10 MB per blob, images resized to 1600 px
  client-side, no streaming/range downloads, no server-side transcoding, and
  once every device has acked the blob is gone for good (a reinstall shows
  "no longer available"). Groups (M5) will extend `sendMedia`'s fan-out.
- Text messages: `sendMessage` (milestone 3); media has its own `sendMedia`
  rather than an overload, because the transport is different (REST bytes).
- One tab per device in browsers (the app-level guard in the FE; the SDK
  itself doesn't enforce it).
- The peer key cache is only refreshed via `peerKeys(_, {refresh: true})` /
  `forgetPeer()` — call it when a peer may have paired a new device, or the
  fan-out will miss it.
- Reconnection is automatic; messages queued while you were offline arrive on
  the next `'open'`.

## Blocking

- `client.blockUser(username, reason)` — `reason` is REQUIRED and one of
  `'nospeak' | 'unknown' | 'scam'` (server-enforced enum; the app collects it
  via the three-line choice list in the block confirm modal). Blocking:
  severs the friends relation BOTH ways (all verify/trust flags die), refuses
  the blocked party's future sends at the ws send seam **before storage** (so
  live delivery, store-and-forward and push are all gated by one check),
  filters their already-stored copies out of the drain/resync seams, and
  rejects their add attempts (`403 blocked`, neutral copy — they are never
  told). The reason is stored on the blocker (`blockReasons.<ul>`) for recall
  in Settings > Relationships and admin context; the blocked party never sees
  it.
- `client.unblockUser(username)` — lifts the wall; nothing is restored.
- `client.relationships()` — `{ added: [...friend entries with trust
  stages...], blocked: [{ peer, addedBack, reason, at }] }`, backing the
  Settings > Relationships tab (searchable, Added/Blocked filter toggles,
  per-row Block/Unblock).
- WS ack errors: `blocked` (they blocked you — message never stored) and
  `self_blocked` (you blocked them — unblock to message).

## Muting (notifications-off per person)

- `client.muteUser(username)` / `client.unmuteUser(username)` — silences ALL
  notifications FROM that person: pushes are gated server-side at the send
  seam (the recipient's `muted: [ul]` list on the ACCOUNT doc, so every
  device mirrors it), and the app suppresses relationship notices from muted
  actors locally. Messages themselves still deliver, read, and count — a
  mute is quiet, not absence (a block is the severing tool). The mute is
  invisible to the muted party.
- `client.relationships()` now also returns `muted: [username]` — the app
  re-pulls this mirror at login and on the `'muted'` control nudge (another
  device flipped it).
