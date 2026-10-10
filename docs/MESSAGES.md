# Messages — Sending & Delivery

How end-to-end encrypted 1:1 messages are sent and delivered: online, offline,
and across multiple devices. Overview first, then the wire protocol, envelope
format and API/frame examples.

Related: [SIGNUP.md](./SIGNUP.md) (accounts, keys, devices) ·
[DESIGN.md](./DESIGN.md) · [BE_TECH.md](./BE_TECH.md)

---

## 1. Overview

Messaging is **store-and-forward** over a WebSocket channel, with the server
acting as an encrypted post office:

- The server **never sees plaintext**. Content is end-to-end encrypted per
  *device pair*: sender and each recipient device derive an identical
  conversation key from their X25519 keys (ECDH + HKDF), so no key-exchange
  messages ever traverse the network and the server stores no key material for
  conversations.
- The server **does** see routing metadata: sender/recipient usernames,
  recipient device id, message size, timestamps, and a per-message HMAC (needed
  to authenticate the sender).
- Every message is **addressed to one device**, not to a user. Multi-device
  means the sender's client fetches the recipient's device list and encrypts
  **one copy per device**, each under that device's own pairwise key.
- A message copy lives on the server until the destination device explicitly
  confirms it with a `pulled` frame; the sender is then notified (`delivered`).
  Pulled copies are kept for a bounded **resync window** (`MSG_RETENTION_SEC`,
  30 d default) and never-pulled copies are pruned after **`MSG_QUEUE_MAX_DAYS`**
  (30 d default) — the server queue is time-bounded in both directions.

Delivery modes at a glance:

| Recipient state | Path |
| --------------- | ---- |
| **Online** (device has a WS connection on any server node) | persist to MongoDB → publish to Redis channel `dm:<ul>:<dv>` → pushed to the socket in real time |
| **Offline** (no connection) | persist to MongoDB → nothing else happens → on the device's next WS connect the server replays all pending copies (oldest first, ≤500 per batch) |
| **Multi-device** | the above happens independently **per recipient device**; each of the recipient's devices stores and confirms its own copy |

### Sequence diagram — online recipient

```
 Alice (sender)                 Server                     Bob (recipient)
 ──────────────                 ──────                     ───────────────
 GET /api/users/bob/keys ──────►
 ◄── bob's devices [p, x]
 derive conv key (X25519+HKDF)
 encrypt + HMAC
 WS {type:'msg', msg:env} ────►
                                validate, persist (Mongo), publish dm:bob:<dv>
 ◄── {type:'ack', cid, ok:true}                       WS ◄── {type:'msg', id, ts, env}
                                        Bob decrypts, saves to IndexedDB
                                        Bob confirms ──►
                                WS {type:'pulled', ids:[id]}
                                copy marked pulled (resync TTL); publish to Alice's channel
 ◄── {type:'delivered', cid, to:'bobby'}
 UI: ✓ → ✓✓
```

### Sequence diagram — offline recipient

```
 Alice                    Server                      Bob (offline)
 ──────                   ──────                      ─────────────
 msg ────────────────────►
 ◄── ack ok              persisted in MongoDB (queued; no live push possible)
   (UI shows ✓)

 ...hours later, Bob opens the app, authenticates, connects WS...
                         ◄──── WS /ws?token=<jwt>
                         deliverPending: {type:'msg', id, ...} ×N
 Bob confirms ──────────►  {type:'pulled', ids:[...]}
                         copies marked pulled (resync TTL); Alice (online or offline —
                         receipt goes to her device channel) gets {type:'delivered'}
```

---

## 2. Technical details

### 2.1 Prerequisites — peer device keys

The sender needs the recipient's device list (ids + public keys). Conversation
keys are derived locally; the server only ever distributes **public** material.

```bash
curl http://127.0.0.1:3000/api/users/bobby/keys \
  -H "authorization: Bearer $ALICE_JWT"
```

```json
{
  "u": "bobby",
  "devices": [
    { "d": "0f0e0d0c-1234-4567-89ab-cdef01234567", "p": "k7Sb3Q...", "x": "YMyc5f..." },
    { "d": "77a1b2c3-d4e5-4f60-8a9b-0c1d2e3f4a5b", "p": "nT3dQ7...", "x": "bV6cX1..." }
  ]
}
```

Rate limited per IP (`USER_KEYS_IP_LIMIT`, default 60/15 min). Unknown user →
404 `unknown_account`.

### 2.2 Conversation keys (E2EE key agreement)

For each (sender device, recipient device) pair, both sides derive the same
AES-GCM-256 key:

```
shared = X25519( myXPriv,  peerXPub )
info   = "cocono-conv-v1|" + sorted([ "<senderUl>:<senderDv>", "<peerUl>:<peerDv>" ]).join("|")
key    = HKDF-SHA256( salt = ∅, ikm = shared, info = info, len = 32 )
```

Notes (`client/src/crypto.js`, mirrored in `be/test/messaging.test.js`):

- The info string sorts the `ul:deviceId` identifiers, so both endpoints derive
  the same key without coordinating who is "a" and who is "b".
- Every **device pair** has its own key — this is what makes multi-device
  correct without users' own devices sharing secrets: Bob's phone and Bob's
  laptop each independently decrypt their own ciphertext copy.
- Wire format of ciphertext `m.d`: `b64u( iv(12) ‖ ciphertext ‖ tag(16) )`
  (AES-GCM; WebCrypto appends the tag, so FE sends `iv‖ct‖tag`).

### 2.3 The WebSocket connection

Endpoint (same port as REST):

```
ws://127.0.0.1:3000/ws?token=<JWT>        # wss:// in production (nginx TLS)
```

- The JWT goes in the upgrade **query** (browsers cannot set WS upgrade
  headers); it is redacted from server logs.
- On connect the server validates the token **and** that the token's device is
  still registered; otherwise the socket closes with code `4401`.
- **One live connection per device** — a newer connection silently replaces the
  older one (old socket closed with `4000 replaced`).
- The server sends `{ "type": "hello" }`, then immediately replays any pending
  messages for that device (see offline, §2.6).
- **Server-initiated heartbeat**: ping every `WS_HEARTBEAT_SEC` (default 30 s);
  a connection that misses a pong is terminated. Browsers answer pings
  automatically.
- Incoming frames are capped at 64 KB (`4413 frame too large` closes the
  connection).
- FE reconnect policy (`client/src/transport.js`): exponential backoff `min(1000·2^n, 30 s)`
  + up to 1 s jitter, plus immediate reconnect on `visibilitychange → visible`
  and `navigator.onLine`.

Wire protocol (all frames are JSON):

| Direction | Frame | Meaning |
| --------- | ----- | ------- |
| c → s | `{ "type": "msg", "msg": <envelope> }` | send a message copy |
| c → s | `{ "type": "pulled", "ids": [<mid>, ...] }` | confirm receipt → copy marked pulled (kept for the resync window) |
| c → s | `{ "type": "resync" }` | re-deliver this device's already-pulled copies still inside the retention window |
| s → c | `{ "type": "hello" }` | connection accepted |
| s → c | `{ "type": "msg", "id", "ts", "env" }` | incoming message (`id` = server message id, `ts` = server receive time in ms) |
| s → c | `{ "type": "ack", "cid", "ok", "error?" }` | envelope accepted/rejected |
| s → c | `{ "type": "delivered", "cid", "to" }` | a recipient device pulled your message |
| s → c | `{ "type": "error", "error": "internal" }` | unexpected handler failure |

Message ids and ordering are **server-assigned** (`mid`, `ts`); client clocks are
never trusted for ordering.

### 2.4 The envelope

```javascript
{
  m: {
    d,   // b64u iv‖ct‖tag — E2EE ciphertext, encrypted under the key shared with THIS recipient device
    u,   // recipient username (display casing)
    dv,  // recipient device id — routing is per device
    f,   // sender username
    fd,  // sender device id
    cid, // client message id, 8–64 chars [a-zA-Z0-9_-] (crypto.randomUUID) — idempotency key
    t,   // client epoch seconds (freshness only; ordering uses server ts)
    h,   // HMAC-SHA256 over canonical(m minus h), keyed with the sender's transport AES key
    sync, // optional 1: outgoing multi-device sync copy (§2.7) — only legal
          // when u == f (the sender's own account); never pushed, never
          // counted as a sent message. Inside the HMAC'd block.
    att,  // optional (M4 §2.11): plaintext attachment descriptor
          // { id, kind: 'image'|'video'|'file', size } — `size` is the
          // CIPHERTEXT byte length. Inside the HMAC'd block, so it is
          // sender-authenticated; the server must read it to run the blob
          // lifecycle and it reveals nothing beyond "N encrypted bytes".
  },
  s,     // optional: Ed25519 signature over canonical(m) by the sender device key
}
```

Building `h` (client side, `client/src/client.js` + `crypto.js`):

```javascript
const m = { d, u: 'bobby', dv: bobDevice.d, f: 'alice', fd: myDeviceId, cid, t };
const h = await hmac(aesMac, canonical(m));           // b64u of HMAC-SHA256
socket.send({ type: 'msg', msg: { m: { ...m, h } } }); // no s → encryption-only
```

`h` proves the envelope came from the authenticated device's transport key — the
server looks up the connecting device's stored `aes` and recomputes it
(`be/src/routes/ws-routes/envelope.js`). `s` is optional for chat messages; it
is required for account-level signed payloads (signup/enroll, see
[SIGNUP.md](./SIGNUP.md)).

### 2.5 Sending — server-side validation & the ack

`handleSend` (`be/src/routes/ws-routes/handlers.js`) runs on every inbound
`msg` frame, in order:

1. **Structure** — all fields present and well-formed (`invalid_envelope`),
   including `cid` regex and username/device-id formats.
2. **Rate limits** — `rl:msg:<account>` (default 120/15 min) and
   `rl:msgip:<ip>` (240/15 min) → `rate_limited`.
3. **Sender match** — `m.f`/`m.fd` must equal the authenticated JWT's
   user/device → `sender_mismatch`.
4. **Envelope verification** — `t` within the freshness window
   (`stale_payload`), HMAC `h` against the sender device's transport key
   (`bad_hmac`), and `s` if present against the sender's Ed25519 key
   (`bad_signature`).
5. **Recipient exists** — `m.u` account with a device `m.dv` → else
   `unknown_recipient`.
6. **Persist** — one MongoDB `messages` doc:

   ```javascript
   { mid: <server uuid>, to: { ul, dv }, from: { ul, fd }, cid, env, ts: Date }
   ```

   A unique index on `(from.ul, from.fd, cid)` makes **retries idempotent**: if
   the insert hits the duplicate key, the server acks `ok: true` without
   storing a second copy — a client that re-sends after a dropped connection
   never creates duplicates.
7. **Live fan-out** — publish the frame `{type:'msg', id, ts, env}` to the
   Redis channel `dm:<ul>:<dv>`. Every server node pattern-subscribes to
   `dm:*` and forwards to the target socket if that device is connected
   locally. No local socket = no-op; the Mongo copy waits.
8. **Ack** — `{ "type": "ack", "cid": "<cid>", "ok": true }` to the sender's
   socket.

Sender UI state machine (FE): `sending` (saved locally on send) → `sent ✓` on
`ack ok:true` → `delivered ✓✓` on the matching `delivered` receipt; `ack
ok:false` → `failed ✗` with the error code.

### 2.6 Receiving — online, offline, and the `pulled` contract

**Online.** The recipient device is connected; the published frame arrives via
`dm:<ul>:<dv>` → client receives `{type:'msg', id, ts, env}`, decrypts `m.d`
with the pairwise conversation key for `(sender ul:fd, my ul:dv)`, saves
plaintext + `mid` in IndexedDB, and immediately confirms:

```javascript
socket.send({ type: 'pulled', ids: [msg.id] });
```

**Offline / catch-up.** Nothing is pushed while the device is disconnected. On
the next WS connect, after `hello`, the server runs `deliverPending`:

```javascript
messages.find({ 'to.ul': ul, 'to.dv': dv }).sort({ ts: 1 }).limit(500)
```

and sends each as the same `{type:'msg', id, ts, env}` frame — the client code
path is identical whether the frame arrived live or on reconnect. (Batch cap
`PENDING_BATCH = 500`; the next connection delivers the remainder.)

**Confirmation & retention.** `handlePulled` marks the listed `mid`s **scoped
to the pulling device only** (`{ mid: {$in: ids}, 'to.ul': auth.sub, 'to.dv':
auth.d }`) — a device can only ever confirm its own mail. Copies are NOT
deleted on pull: they get `pulledAt` + `expireAt = pulledAt +
MSG_RETENTION_SEC` so a device that later loses its local store can recover
them via `resync` (same device identity only — ciphertext is per-device).
Every newly-pulled doc triggers a receipt published to the sender's device
channel:

```javascript
{ "type": "delivered", "cid": "<cid>", "to": "bobby" }
```

**Read semantics.** "Delivered == read by that device": once a copy is pulled,
the device has it. There is no separate read receipt layer yet.

**Self-chat.** Sending to your own username routes a copy to your own specified
device like any other message; the FE recognizes the echo (sender == self),
acks/pulls it so the server drops it, but does not re-save it — it already has
the message as outgoing.

### 2.7 Multi-device delivery

Delivery is per **device**, not per account. Concretely, when Alice (on device
`A1`) sends "hi" to Bob who has devices `B1` and `B2` (`client/src/client.js`):

```javascript
for (const dev of peer.devices) {                      // [B1, B2]
  const cid = crypto.randomUUID();                    // one cid per device copy
  const key = convKey(identity.xPriv, dev.x,
              pairInfo('alice', 'A1', 'bobby', dev.d)); // per-device-pair key
  const d = encrypt(key, 'hi');
  const m = { d, u: 'bobby', dv: dev.d, f: 'alice', fd: 'A1', cid, t };
  ws.send({ type: 'msg', msg: { m: { ...m, h: hmac(aliceMac, canonical(m)) } } });
}
```

Resulting guarantees (asserted in `be/test/multidev-repro.test.js`):

- **Exactly one copy per recipient device** — `B1` and `B2` each receive (and
  each decrypt only) their own ciphertext; a device cannot read another
  device's copy.
- Alice receives **one ack per copy** (two acks, distinct `cid`s) and one
  `delivered` receipt per copy as each device pulls. The FE maps every
  `cid → local message`, so the first receipt flips the bubble to `✓✓`
  ("delivered to at least one of Bob's devices"); per-device delivery status is
  a future refinement.
- **Outgoing multi-device sync:** Alice's other devices (say `A2`) DO receive
  a copy of what she sent from `A1`, as a **sync copy**: alongside the peer
  fan-out, `A1` sends one extra envelope per own other device with the
  plaintext flag `m.sync = 1` (legal only toward the sender's own account)
  and an E2EE payload `{"sync":1, "id":<localId>, "peer":<recipient>,
  "text":..., "ts":...}`. `A2`'s SDK surfaces it as a **`sync` event** (never
  `message`), and the app stores it under the SAME record id
  (`out:<localId>`, `state:'synced'`) so every device shows the same outgoing
  history. Sync copies are never pushed (your own send must not ring your
  other phone), never counted in the sent-message counter, and their
  acks/`delivered` receipts are swallowed by the SDK — delivery ticks stay
  owned by the originating device's peer copies. Self-chat is unchanged (it
  already reaches every own device as a normal copy; no double fan-out).
  **Not synced:** history sent before a device paired (new devices start
  empty — backfill needs device-to-device transfer, future work), delivery
  state, read markers and clear/delete actions (all device-local).
- Offline applies per device: if `B1` is online and `B2` has been off for a
  week, `B1` gets the message live, `B2` gets it replayed on its next connect,
  and the server holds `B2`'s copy until then.

### 2.8 Retention & cleanup

- **Queue cap (never-pulled copies):** every copy is stamped
  `expireAt = ts + MSG_QUEUE_MAX_DAYS` (default 30) at insert; MongoDB's TTL
  index prunes it if the destination device never shows up. A device offline
  past the cap loses its queued copies (the sender's bubble simply never
  reaches ✓✓).
- **Resync window (pulled copies):** `expireAt = pulledAt +
  MSG_RETENTION_SEC` (default 30 d) — re-deliverable via `resync` to the SAME
  device identity until the TTL sweeps it.
- **Planned, not yet implemented** (tracked in `docs/BE_TECH.md` roadmap):
  per-recipient queue COUNT caps, and removal of non-main devices inactive
  ≥14 days together with their pending messages (DESIGN.md rule).
- Plaintext, conversation keys and full history exist only in each device's
  IndexedDB; there is no server-side history.

### 2.9 Failure modes cheat-sheet

| Symptom | Frame / code | Cause |
| ------- | ------------ | ----- |
| Send rejected | `ack ok:false, error:'invalid_envelope'` | missing/malformed fields, bad `cid` format |
| Send rejected | `error:'sender_mismatch'` | `f`/`fd` ≠ the connection's JWT identity |
| Send rejected | `error:'bad_hmac'` | `h` not computed with the registered transport key (or `m` tampered) |
| Send rejected | `error:'bad_signature'` | optional `s` does not verify against the device's `p` |
| Send rejected | `error:'stale_payload'` | `t` outside `SIGNED_PAYLOAD_MAX_AGE_SEC` of server time |
| Send rejected | `error:'unknown_recipient'` | no such user, or user has no device `dv` |
| Send rejected | `error:'rate_limited'` | account/IP message budget exhausted |
| Send rejected | `error:'unknown_attachment'` | `m.att` names no blob of THIS sender's (gone, foreign, or never uploaded) — M4 |
| Upload refused (REST) | `413 media_too_large` / `413 thumb_too_large` | over `MEDIA_MAX_BYTES` / `MEDIA_THUMB_MAX_BYTES` |
| Upload refused (REST) | `413 media_quota` | the account's server-held media budget is full |
| Upload refused (REST) | `400 bad_sha256` | the claimed digest does not match the uploaded bytes |
| Download refused (REST) | `404 unknown_media` | missing, swept, or the caller's (account, device) is not on `devices` — one answer for all three |
| Client-side failure | `media_tampered` | downloaded ciphertext does not match the sender's digest (never acked) |
| No preview image | `404 no_thumb` (REST) | the blob exists and the caller is listed, but it has no thumbnail — **not** "the payload is gone", and nothing may ack because of it |
| Socket closed | `4401` | missing/invalid JWT, or device no longer registered |
| Socket closed | `4000 replaced` | same device connected elsewhere (newest wins) |
| Socket closed | `4413` | frame over 64 KB |
| No delivery ever | (message stays queued) | recipient device offline; delivered on next connect — until the future undelivered sweep |

### 2.11 Media messages (milestone 4)

A photo, video or file is **a message that references a blob**, not a blob in a
frame. WS frames are capped at 64 KB, so the bytes move over REST
(`POST /api/media`, `GET /api/media/:id[?part=thumb]`, `POST /api/media/:id/ack`
— see [BE_TECH.md](./BE_TECH.md)) while the *message* rides this exact path.
Delivery, ordering, idempotent retries, receipts, push gating, resync and
offline replay therefore work untouched: a media message IS a message.

- **Plaintext inside the recipient's envelope** (so E2EE, the same channel as
  `{"sys":…}`) is a JSON descriptor:

  ```json
  { "media": { "id": "<blob id>", "kind": "image", "mime": "image/jpeg",
      "name": "holiday.jpg", "size": 183402, "key": "<b64u AES-GCM-256 key>",
      "iv": "<b64u>", "thumbIv": "<b64u?>",
      "sha256": "<b64u digest of the CIPHERTEXT>",
      "w": 1600, "h": 1200, "dur": 12.4, "animated": true } }
  ```

  The `key` is a per-file random AES-GCM-256 key generated by the sender and is
  IDENTICAL in every device copy (only the envelope differs per device pair).
  Blob wire format is the same `iv(12) ‖ ciphertext ‖ tag(16)` as `m.d`. A
  thumbnail is generated by the sender's client (256 px) under the same key with
  its own IV — which is what lets bubbles, the image wall and video posters
  render without pulling 10 MB.
- **Visible to the server**: only `m.att`. `handleSend` requires the blob to
  exist, to belong to the sender (`unknown_attachment`), and to match
  `att.kind`/`att.size` (`invalid_envelope`); it then `$addToSet`s the addressed
  device into the blob's `devices` (may download) and `pending` (owes an ack).
- **Store once**: one upload = one blob for all recipient devices. It dies when
  `pending` empties — every device answered `downloaded` or `declined`, sync
  copies of the sender's own devices included — or by the retention sweep. A
  device that replays a message whose blob is gone gets `404 unknown_media` and
  shows a "no longer available" placeholder (`state:'expired'`).
- **Only a PAYLOAD fetch may ack.** A video's poster (`?part=thumb`) is
  decoration: a poster request that fails — because the sender's browser could
  not capture a frame, which is normal on iOS — changes nothing, acks nothing,
  and never moves the record out of `pending`. (It used to share the failure
  path of a real download, and the ack that followed marked the video expired
  and deleted it for every device. Guarded end-to-end in
  `client/test/appmediaflow.test.js` against the real server.)
- **The server reads nothing.** Moderation gets plaintext only because a
  reporter's own client hands over the file keys of its conversation (§2.12).
- **Outgoing sync** (§2.7) mirrors media the same way as text: payload
  `{"sync":1, id, peer, ts, media:{…}}` plus the same plaintext `att`, so the
  sender's other devices enter `pending` and the bytes cannot be deleted before
  they too have downloaded or declined.

### 2.12 Report media (req 9 — reported media must be readable by the server)

`POST /api/me/report` accepts `media: [{ blobId, kind, name, mime, key, iv,
thumbIv?, data? }]`, capped at 3 items and `REPORT_MEDIA_MAX_BYTES` (30 MB) of
plaintext. For each item the server requires the reporter to be the uploader or
an account listed in the blob's `devices` — without that check the route would
be a decryption oracle for guessed blob ids and a channel for planted evidence.
Then it decrypts the blob it still holds (`source:'server'`), or stores the
reporter's own plaintext copy (`source:'reporter'`) when the bytes are already
gone, or records the item `undecryptable`. One broken item never fails a report.
Whatever the outcome, the blob is pinned `reported: true` and outlives every
sweep until the admin deletes the report (which deletes its media docs with it).

### 2.13 Retention (what expires, where)

| What | Where | Bound | Mechanism |
| ---- | ----- | ----- | --------- |
| Never-pulled message copies (media envelopes included) | `messages` | `MSG_QUEUE_MAX_DAYS` (30 d) | `expireAt` at insert + TTL index |
| Pulled message copies (resync window) | `messages` | `MSG_RETENTION_SEC` (30 d) | existing TTL |
| Media blobs not yet acked by all devices | `media` | `MEDIA_RETENTION_DAYS` (7 d) | hourly sweeper (`be/src/lib/media.js`) |
| Orphan uploads (uploaded, never sent) | `media` | 24 h | same sweeper |
| Media blobs acked by all devices | `media` | immediate | delete-on-empty-`pending` |
| Report-pinned media | `media` | until the report is deleted | `reported: true` excludes every delete path |
| Decrypted media bytes on a device | client IDB `media` | settings drawer, 7 d default | boot + daily prune, measured **from when the bytes landed on that device** (`storedAt`), not from the message's age; `keep: true` ("Keep on this device") exempt |
| Text transcripts on a device | client IDB `messages` | none — the user's own history | clear-chat stays manual |

### 2.13a What "Keep on this device" does (and what it does not)

The pin is **local and per-device**: it exempts one device's decrypted bytes
from the row above. It is not a server statement (the acks decide when a blob
dies), it does not sync to your other devices, and it does not survive clearing
the chat or the device's app data.

Without it, once the window passes the sweep drops the file's bytes and the
record becomes `pruned`. What stays: the message in the transcript, its
name/size/date, and for a photo or video the 256 px thumbnail — so the wall
keeps its picture and only the payload goes. What goes: the full-resolution
image, the video, the file, and with them the ability to **Save to device**.
The viewer then offers **Download again**, because only the server knows whether
a copy survives (a blob lives until EVERY listed device has acked) — and it
takes the answer, `404 unknown_media` → `expired`, as the verdict. `pruned` is
therefore not `expired`: one is this device choosing to let bytes go, the other
is the network confirming there is nothing left to fetch.

### 2.14 Scaling & implementation notes

- Stateless REST + per-node WS maps + Redis pub/sub (`dm:*` pattern
  subscription) means any node can serve any device; no sticky sessions. A
  message published on node X reaches a device connected to node Y.
- Immediate Mongo persistence before fan-out (deviation from the earlier
  "Redis queue, Mongo later" sketch) is strictly more durable and removes timer
  jobs.
- `handleSend` / `handlePulled` are the deliberate seam for moving
  persistence/crypto work onto `worker_threads` later; processing is inline for
  milestone 3 to keep the flow testable.
- Integration tests exercising all of the above with real WebSockets:
  `be/test/messaging.test.js`, `be/test/multidev-repro.test.js`.
