# Messages — Sending & Delivery

How end-to-end encrypted 1:1 messages are sent and delivered: online, offline,
and across multiple devices. Overview first, then the wire protocol, envelope
format and API/frame examples.

Related: [SIGNUP.md](./SIGNUP.md) (accounts, keys, devices) ·
[DESIGN.md](../DESIGN.md) · [be/README_TECH.md](../be/README_TECH.md)

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
- A message copy lives on the server only until the destination device
  explicitly confirms it with a `pulled` frame; then it is deleted and the
  sender is notified (`delivered`).

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
                                delete copy; publish to Alice's channel
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
                         copies deleted; Alice (online or offline —
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

Notes (`fe/js/crypto.js`, mirrored in `be/test/messaging.test.js`):

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
- FE reconnect policy (`fe/js/ws.js`): exponential backoff `min(1000·2^n, 30 s)`
  + up to 1 s jitter, plus immediate reconnect on `visibilitychange → visible`
  and `navigator.onLine`.

Wire protocol (all frames are JSON):

| Direction | Frame | Meaning |
| --------- | ----- | ------- |
| c → s | `{ "type": "msg", "msg": <envelope> }` | send a message copy |
| c → s | `{ "type": "pulled", "ids": [<mid>, ...] }` | confirm receipt → server deletes |
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
  },
  s,     // optional: Ed25519 signature over canonical(m) by the sender device key
}
```

Building `h` (client side, `fe/js/components/chat.js` + `crypto.js`):

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

**Confirmation & deletion.** `handlePulled` deletes the listed `mid`s **scoped
to the pulling device only** (`{ mid: {$in: ids}, 'to.ul': auth.sub, 'to.dv':
auth.d }`) — a device can only ever confirm its own mail. Every deleted doc
triggers a receipt published to the sender's device channel:

```javascript
{ "type": "delivered", "cid": "<cid>", "to": "bobby" }
```

**Read semantics.** "Delivered == read by that device": once a copy is gone from
the server, the device has it. There is no separate read receipt layer yet.

**Self-chat.** Sending to your own username routes a copy to your own specified
device like any other message; the FE recognizes the echo (sender == self),
acks/pulls it so the server drops it, but does not re-save it — it already has
the message as outgoing.

### 2.7 Multi-device delivery

Delivery is per **device**, not per account. Concretely, when Alice (on device
`A1`) sends "hi" to Bob who has devices `B1` and `B2` (`fe/js/components/chat.js`):

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
- Alice's **other** devices (say `A2`) do **not** currently receive a copy of
  what she sent — outgoing messages are stored only on the sending device.
  Outgoing multi-device sync / history transfer to newly enrolled devices is
  planned but not part of milestone 3.
- Offline applies per device: if `B1` is online and `B2` has been off for a
  week, `B1` gets the message live, `B2` gets it replayed on its next connect,
  and the server holds `B2`'s copy until then.

### 2.8 Retention & cleanup

- Copies are deleted on confirmed pull (see §2.6).
- **Planned, not yet implemented** (tracked in `be/README_TECH.md` roadmap):
  undelivered-message sweep (delete copies older than X days), and removal of
  non-main devices inactive ≥14 days together with their pending messages
  (DESIGN.md rule).
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
| Socket closed | `4401` | missing/invalid JWT, or device no longer registered |
| Socket closed | `4000 replaced` | same device connected elsewhere (newest wins) |
| Socket closed | `4413` | frame over 64 KB |
| No delivery ever | (message stays queued) | recipient device offline; delivered on next connect — until the future undelivered sweep |

### 2.10 Scaling & implementation notes

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
