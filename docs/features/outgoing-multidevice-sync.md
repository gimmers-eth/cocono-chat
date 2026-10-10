# Feature plan — Outgoing multi-device sync (+ server-side pruning)

Status: **PLAN → implementation starting on branch `multi-device-outgoing`.**
Read `docs/MESSAGES.md` first (especially §2.7 "Multi-device delivery", which
documents today's gap: *Alice's other devices do not receive a copy of what
she sent*). Related: `docs/features/images-and-files.md` (media sync rides the
same mechanism), `docs/PROJECT_STATUS.md` (P0 #2 queue DoS — pruning below is
its first instalment).

---

## 1. Goal

When a device sends a message, every OTHER device of the same account receives
a copy and stores it as an **outgoing** message — so all of a user's devices
show the same conversation history from the moment they pair. Plus: bound how
long the server keeps message copies (pruning), which today is *forever* for
never-pulled copies (P0 #2).

Non-goals (documented gaps, not this feature):
- **History transfer to NEWLY paired devices.** Sync only covers messages sent
  while the receiving device already exists. Backfill would need device-to-
  device transfer (or a sender-side outbox); deliberately deferred.
- Cross-device delivery-tick state (a synced copy carries no ✓/✓✓ — status
  lives only on the originating device).
- Read-state / clear-message sync (both stay device-local, as today).

## 2. Design

### 2.1 Mechanism — reuse the sys-message pattern

The codebase ALREADY sends account-private E2EE messages to its own devices:
`#broadcastFlag` / friend & notice sys messages (`client/src/client.js`) call
`sendMessage(ownUsername, '{"sys":...}')`, and every own device decrypts them
with the normal per-device-pair conversation key (pairInfo sorts
`alice:A1|alice:A2`, so own-device pairs derive keys exactly like peer pairs).
Outgoing sync = the same fan-out with a distinct payload and a few extra
rules. The server needs NO new endpoint and NO crypto involvement.

### 2.2 The sync payload (inside `m.d`, E2EE)

```json
{ "sync": 1, "id": "<localId of the original send>", "peer": "bobby",
  "text": "<original plaintext>", "ts": 1730000000000 }
```

- `id` = the originating device's `localId`, so the receiving device stores the
  record under the SAME id (`out:<localId>`) → natural dedup (IDB put by id)
  and identical transcripts across devices.
- `ts` = the originating device's send time → stable ordering everywhere.
- Detection is by the decrypted `{"sync":` prefix, mirroring the existing
  `{"sys":` convention (app-side) — BUT routing happens in the SDK (§2.4), so
  the app never sees sync payloads as messages.

### 2.3 Envelope extension — plaintext `sync` flag

`m` gains an optional `"sync": 1` (inside the HMAC'd block, so it is
sender-authenticated and tamper-proof). The server uses it for policy it
cannot derive from ciphertext:

- **Allowed only to self**: `m.sync && m.u.toLowerCase() !== auth.sub` →
  ack `invalid_envelope` (sync is not a delivery channel to other users).
- **No push, ever** — a sync copy must never ring on your own phone. Today's
  push gate (`m.d !== auth.d`) would push to your OTHER offline devices;
  `m.sync` short-circuits the whole push block. (This is emitter #1 of the
  three-emitter notification rule; §2.5 covers the other two.)
- **No `sent:` counter increment** — the "You've got mail" badge counts real
  messages; sync copies would multiply it by the device count. (Self-chat
  keeps counting, as today.)
- **No contact edge** — already excluded for self-sends (`rul !== auth.sub`).
- Everything else is unchanged: validation, rate limits, idempotent cid
  insert, store-and-forward, `pulled`, `delivered` receipts, resync. Sync
  copies to offline devices queue exactly like mail — that is the point.

Rate-limit note: sending to N peer devices + M own devices spends N+M of the
sender's `msg` budget (120/15 min). Acceptable at current device caps (≤5);
revisit the budget if device limits grow.

### 2.4 SDK changes (`client/src/client.js`)

`sendMessage(username, text)` — when `username` is NOT the own account (self-
chat already reaches all own devices as normal copies), after the peer fan-out:

1. `peerKeys(ownUsername)` → own device list; skip the current device.
2. Per own device: envelope with `d` = encrypted sync payload (§2.2),
   `sync: 1`, its own `cid`, HMAC — same `#getConvKey` path.
3. Sync cids go into a **separate `#syncCids` map**, NOT `#cidToLocal`:
   - `ack` for a sync cid → drop it silently (log on failure); it must never
     flip the bubble to failed — the peer copies own the visible state.
   - `delivered` for a sync cid → ignore (no ✓✓ from your own laptop).
4. Failures are non-fatal: peer fan-out success is what `sendMessage`
   reports; sync errors are logged (`logger.debug`), matching how
   `#broadcastFlag` treats its best-effort self-sends.

`#onIncoming` — new branch BEFORE the existing echo check:

- `senderUl === myUl && m.fd !== identity.deviceId && m.sync` → decrypt with
  the own-account pairwise key (existing `peerKeys` + `#getConvKey` path; the
  stale-cache refresh-and-retry applies as for peers), pull the copy
  (`{type:'pulled'}`), parse the payload defensively and emit a **new `sync`
  event**: `{ id, peer, text, ts, fromDeviceId }`. NEVER emit `message` for
  it (that is what keeps app-level notification/pill paths — emitter #2 —
  off automatically, since they hang off `message`).
- Unparsable/foreign sync payload → pull + log, emit nothing (a device must
  not strand its own queue over garbage).
- The existing echo case (`m.fd === identity.deviceId`) and self-chat case
  (non-sync copies from own other devices, stored as incoming notes-to-self)
  are untouched.

Self-chat disambiguation: a message to your OWN username fans out to all own
devices without the sync flag and without a second sync fan-out (guarded by
the `username !== own` condition) — behaviour identical to today.

### 2.5 Notification gating (three emitters — skill rule)

| Emitter | Gate |
|---|---|
| Server push (`handlers.js`) | skip the whole push block when `m.sync` (§2.3) |
| Page OS notice / in-app pill (`chat.js`, hangs off the SDK `message` event) | automatic: sync emits `sync`, not `message` |
| Worker peek banners (`sw-lib.js` `peek`) | skip decrypted texts matching `/^\{"(sync|sys)":/` when building `seen`; a queue containing ONLY sync/sys copies makes peek return null → worker stays silent (existing empty-queue contract). NOTE: this also fixes today's latent leak of raw `{"sys":...}` JSON into notification snippets |

### 2.6 App changes (`client/app/js/main.js`, `chat.js`, `store.js`)

- `client.on('sync', ...)` in `main.js` (next to the `message` handler):
  1. `saveMessage({ id: 'out:'+id, peer, dir: 'out', text, ts, state: 'synced' })`
     — but first `getMessage`: if a record with that id exists, leave it alone
     (the originating device never receives its own sync; this guards replays
     after partial wipes).
  2. If the chat with `peer` is open → `render()`; call `onHomeRefresh()` so
     the sidebar preview updates. No `markRead` (outgoing), no pills, no
     sounds — a synced message is not an arrival.
- `store.js`: allow `state: 'synced'` on out-records (no schema change — state
  is a free string).
- `chat.js`: `STATE_MARK` gains nothing — for `state === 'synced'` render NO
  status icon (ticks belong to the originating device; the sidebar/transcript
  stays quiet per the UI conventions). One-line guard where `m.dir === 'out'`
  appends the state icon (line ~417).
- Forwarding a synced message works as-is (plaintext is local).
- Report transcript assembly already reads the local store — synced messages
  are included automatically. Correct.

### 2.7 Server-side pruning (messages "pruned after a given time")

Today: pulled copies get `expireAt = pulledAt + MSG_RETENTION_SEC` (TTL
index, 30 d default) for the resync window; **never-pulled copies live
forever** (P0 #2 unbounded storage).

Change (`be/src/db.js`, `handlers.js`, `config.js`):

- New config `MSG_QUEUE_MAX_DAYS` (env, default **30**) →
  `msgQueueMaxSec`.
- On insert, every message doc gets `expireAt = ts + msgQueueMaxSec`
  (`$setOnInsert`-style: computed in the doc literal). TTL index already
  exists — no new index.
- `handlePulled` keeps overwriting `expireAt = pulledAt + msgRetentionSec`
  (pulled copies get their own, possibly longer, resync window — semantics
  unchanged).
- One-time backfill in `ensureIndexes`/setup:
  `updateMany({ expireAt: { $exists: false } }, [{$set: { expireAt:
  {$add: ['$ts', <ms>]}}}])` so pre-existing queued copies inherit the policy
  (old ones expire promptly — intended).
- Consequence (accepted, document in MESSAGES.md): a device offline for more
  than `MSG_QUEUE_MAX_DAYS` loses its queued copies; the sender's bubble
  simply never reaches ✓✓. No 'expired' receipt in this iteration.
- Media pruning is specified in `docs/features/images-and-files.md` §4.3/§4.5
  (blob retention sweep + all-acked deletion + local device pruning); it does
  not exist yet and is NOT part of this branch beyond the message queue cap.

Per-recipient queue COUNT caps (the other half of P0 #2) remain future work —
the time bound ships now because sync multiplies copy counts per send.

## 3. Wire/protocol summary (for MESSAGES.md update)

- `m.sync?: 1` — plaintext, HMAC-covered; only legal when `m.u` is the sender.
- New ack error: none (reuses `invalid_envelope`).
- New SDK event: `sync` `{id, peer, text, ts, fromDeviceId}`.
- New record state: `synced` (device-local).
- New config: `MSG_QUEUE_MAX_DAYS`.

## 4. Test plan

**Backend (`be/test/messaging.test.js` extensions or a new `sync.test.js`):**
- sync envelope to own other device: accepted, queued, delivered on connect;
  `pulled` scopes normally.
- sync envelope to ANOTHER user → `invalid_envelope`.
- no push attempt for sync copies even when the target own device is offline
  with a push subscription (assert the push path is not entered — spy/stub as
  in existing push tests, or assert absence of the coalesce key in Redis).
- `sent:` counter NOT incremented by sync copies; incremented once by the
  original peer send.
- pruning: insert sets `expireAt ≈ ts + msgQueueMaxSec`; pulled overwrites it
  with `pulledAt + msgRetentionSec`; backfill migration stamps legacy docs.

**Client (`client/test/integration.test.js` pattern — real backend in-process):**
- Account with devices A and B, peer Bob: A sends "hi" → Bob gets ONE
  message; B receives a `sync` event with the same text and `id`; B's store
  record is `out:<localId>`, `dir:'out'`, `state:'synced'`, dedup on replay.
- `delivered` from B's pull does NOT flip A's localId state; Bob's pull does.
- self-chat still behaves as today (all own devices get normal copies; no
  duplicate sync fan-out).
- worker peek filter: unit-test the `{"sync":`/`{"sys":` skip in the `seen`
  builder (extract the predicate so it is testable without a WS).
- `imports.test.js` / `graph.test.js` green with new/edited modules.

**Manual smoke (devbox, two browsers one account):** send from A → appears on
B without notification, no ticks on B, sidebar preview updates; offline B
receives on next connect; unverified-account gates unaffected (self-send is
already exempt from the cold-send rule).

## 5. Build order

1. BE: envelope `sync` validation + handler policy (push/counter skip) +
   pruning (config, insert expireAt, backfill). Tests.
2. SDK: fan-out, `#syncCids`, `sync` event, `#onIncoming` branch. Tests.
3. Worker peek filter (+ the latent `{"sys":` snippet fix).
4. App: `sync` handler in main.js, `synced` state rendering in chat.js.
5. Docs: MESSAGES.md (protocol table, §2.7 rewrite, pruning), CLIENT_SDK.md
   (event + behaviour), PROJECT_STATUS (milestone note + P0 #2 progress).

## 6. Security review points

- `sync` flag is inside the HMAC'd `m` — a third party cannot relabel a
  message as sync (and could not forge one into another account anyway:
  sender-match + self-only rule).
- Sync does not widen any disclosure: own devices already share the account;
  pairwise keys between own devices existed for sys broadcasts.
- Pruning REDUCES server-side data; no new metadata is exposed (the `sync`
  flag tells the server "this is intra-account traffic" — it already knew
  from `m.u == m.f`).
- Push suppression must be asserted by a test — a regression here rings
  users' phones with their own messages.
