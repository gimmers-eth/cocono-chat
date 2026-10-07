# Friends & Identity Verification

How "friend" trust works end to end: the model, the data, the sync, what is
verified, and — honestly — what is NOT. Written as the reference the code
comments point to; decisions logged in [ANSWERS.md §11](./ANSWERS.md).

## The model

A **friend** is a one-way trust statement: *"I trust this account."* It is
not mutual, not a contact request, not a chat permission — anyone can message
anyone (subject to block/report, a launch P0). Trust is anchored to the
**account identity key**:

- Every user doc carries `identity.p` — the founder device's Ed25519 public
  key, **frozen for the lifetime of the account**. Devices may enroll and
  detach freely; `identity.p` never changes. If the account is deleted and
  the username re-registered, the new account gets a **new** identity key.
- A friend entry is `{ u, p }` — the username plus the identity key **the
  server stamped at add time** (clients cannot claim a key; the binding is
  read from the target's own account doc).

## Data locations

| Where | What | Source of truth? |
|---|---|---|
| `users.friends` (Mongo) | `[{u, p}]` per account | ✅ **the** truth for friendship |
| `users.identity.p` (Mongo) | account anchor key | ✅ |
| IDB `friends` store (per account, per device) | mirror: `{peer, pub, gone, changed, trusted}` | cache |
| IDB `pins` store (per account, per device) | TOFU pins: `{peer, p, firstSeenAt, changedAt, prevP, verified}` | **device-local fact — the server never sees or controls it** |

## The API (JWT, rate-limited)

- `GET /api/me/friends` → entries annotated against the live directory:
  `gone` (account deleted), `changed` (identity no longer matches the
  binding — username re-registered), `trusted` (binding matches).
- `PUT /api/me/friends/:u` → bind (or **re-bind**: explicit re-add after a
  `changed` is the sanctioned recovery). Cap `FRIENDS_MAX` (default 500) →
  409; self → 400; unknown → 404.
- `DELETE /api/me/friends/:u` → revoke.
- `GET /api/users/:u/keys` → includes `id` (the account anchor) so devices
  can verify bindings and pins themselves.

## Multi-device sync (three layers)

1. **Live:** the acting device broadcasts an E2EE system message
   `{"sys":"friend+","u,p}` / `{"sys":"friend-","u}` to **its own account**
   over the normal message relay. Open devices apply it to their mirror
   instantly (the app filters sys payloads out of the transcript). The
   server relays this opaque envelope and **cannot forge or alter it**
   (relay HMAC is keyed with the sender's transport AES key).
2. **Reconcile on entry:** every app start calls `GET /api/me/friends` and
   **replaces** the local mirror (`setFriends`). New devices, offline
   devices and missed events all converge here.
3. **Verification on use:** opening a chat compares the server-stamped
   binding against the live `peerKeys.id` — and the device-local **pin**
   against both. See below.

## Verification layers (what makes green mean something)

| Layer | Catches | Independent of the server? |
|---|---|---|
| **Binding** (friend `p` = stamped identity key) | honest-server mistakes: re-registered usernames flagged `changed` | ❌ server data |
| **Auto-untrust** (chat open compares binding vs live `id`; `changed` ⇒ delete + sys `friend-` broadcast) | stale trust after re-registration — every device of yours converges | ❌ (inputs both come from the server, but convergence is client-driven) |
| **Pin (TOFU + change detection)** | ANY key change after first sight — even if the server insists everything is fine; also catches *inconsistent* lies across sessions | ✅ device-local, never leaves |
| **Safety number** | a server lying consistently from the first contact | ✅ — if the users compare out of band |
| **Verified flag** | the human record that the number WAS compared; bound to the exact key, reset automatically on any change | ✅ device-local |

`identity.js` renders the number: `SHA-256(identity key)` → first 16 bytes →
8 hex groups of 4 (deterministic, unit-tested with a fixed vector — changing
the format is a UX break for people who wrote numbers down).

The pin logic (`store.js`): first-seen key is pinned silently; a later
different key ⇒ `changed` + `verified` reset + `prevP` kept for audit. On
chat open, `changed` revokes friendship via the same auto-untrust path and
shows a red SECURITY ALERT strip. A pin that disagrees with the server
binding (`conflict`) is the loudest state: the server may be lying.

## UI state matrix

| State | Sidebar | Header/menu icon | Strip |
|---|---|---|---|
| you | solid user | — | — |
| trusted + verified | green shield | shield | none |
| trusted (bound, unverified) | green user | user | none (panel shows unverified) |
| stranger / unbound legacy | red x | red x | amber: "not trusted" |
| key changed (pin or server) | red x | red x | red SECURITY ALERT |
| account deleted | red slash + italic | slash + italic name | red "no longer exists", composer locked |

## Threat model, honestly

**The server is trusted for:** the friends list itself (`listFriends()` is
plain authenticated JSON — it can add/drop/relabel entries arbitrarily for
devices that only reconcile), message queueing/delivery, and metadata. It
cannot read content, forge envelopes/pushes, or see pins/safety numbers.

**What pinning + safety numbers do NOT protect against:**
- A server lying *consistently from your very first contact* — only an
  out-of-band safety-number comparison defeats that (that's what "Mark
  verified" means; skipping the comparison makes the flag theatre).
- Cross-device comparison of pins is not automatic (each device pins on its
  own TOFU moment); a device paired later trusts whatever the server hands.
- Silent *stale* state (server freezing your view) — detecting that needs
  the **signed append-only event log** (P2, deliberately deferred; it is a
  mini transparency-log project, and groups/M5 will force the issue anyway).

## Deletion & cleanup

**Server-side (every account-deletion path: last-device detach, admin delete,
admin device cascade):**
- The account doc, all messages to/from it, and its Redis state are swept
  (existing cascade) — and `purgeFriendReferences()` now ALSO strips the
  dead username from **every other account's friends list**. Trust in a
  nonexistent account is meaningless, and a purged entry can never
  silently point at whoever re-registers the name later. The `gone`/
  `changed` flags remain as defense-in-depth (purge failure, restore from
  an old backup), but the normal lifecycle is: account dies → lists clean.

**Device-local (logout via the power button):**
- The friends mirror is wiped (it is a cache — refetched at next entry).
- **Pins and verified flags are wiped too** (product decision): logging out
  destroys this device's TOFU history. Honest trade-off — change detection
  does NOT survive a logout; the next login re-pins fresh. Permanent,
  full-local erasure stays tied to "remove this device" (which deletes the
  whole per-account IndexedDB, messages included).

## Operational notes

- `FRIENDS_MAX`, rate limits: see `be/src/config.js` + `.env.example`.
- Tests: `be/test/friends.test.js` (binding, flags, re-bind, gone/changed,
  legacy strictness, cap), `client/test/friends.test.js` (SDK round-trip,
  sys broadcast carries the key, multi-device convergence, re-registration),
  `client/test/identity.test.js` (safety number format + vector).
- App layer (mirror, pins, UI) has no DOM tests — the guard is
  `graph.test.js` plus manual QA: add/remove between two browsers, close and
  reopen (reconcile), delete an account (ghost state), re-register a username
  (auto-untrust), safety number panel.
