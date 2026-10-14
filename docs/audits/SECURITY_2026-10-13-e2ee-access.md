# Security audit — 2026-10-13 — "who else can read my messages/files?"

Scope requested: **confidentiality of message content, media and files** —
could anyone other than sender and recipient (including the platform itself:
server code, admin panel, logs, push, redis, backups) obtain plaintext?
Method: every path content or bytes can travel — storage, delivery, media,
push, admin surfaces, auth, headers, logs — was read in code, not assumed.

Verdict: **the E2EE contract holds.** No path was found where a third
party — including an authenticated admin or the server process itself —
can read message text or attachment bytes. Two minor housekeeping findings
and a set of honest, by-design metadata exposures are listed after the
walk-through.

---

## 1. Message content — verified device-to-device only

* **Keys.** Each device holds an X25519 pair; private keys are imported /
  generated **non-extractable** (`client/src/crypto.js`) and never leave
  the device. The server stores only public material. A message copy is
  encrypted with a per-(peer,device) conversation key derived via
  `X25519 → HKDF-SHA256 → AES-GCM-256` (`deriveConversationKey`,
  `client.js#sendMessage`), so **every recipient device gets its own
  ciphertext** and the server holds none of the agreeing private keys.
* **What the server stores** (`ws-routes/handlers.js` doc): routing
  metadata (`to.ul/dv`, `from`, `cid`, `ts`), the opaque envelope `d`
  (iv‖ct‖tag), and `att` — the ONE plaintext field (blob id/kind/size),
  deliberately readable for lifecycle bookkeeping and HMAC'd so a sender
  cannot forge references to other people's blobs (owner check on send).
* **The transport AES key is NOT an encryption key.** The server verifies
  the envelope HMAC with `senderDevice.aes`; the same raw key's AES-GCM
  half exists only in `localseal.js` — at-rest sealing **on the device**.
  Grepping `aesEnc` confirms no client send path ever encrypts message or
  media content with it. (This was the one architecture question that
  could have broken the whole promise; it checks out.)
* **Sync copies** (`m.sync === 1`) are structurally gated to the sender's
  OWN account (checked against the authenticated identity before storage),
  still encrypted per target device.
* **Delivery scoping.** Drain and resync query `{'to.ul': ul, 'to.dv': dv}`
  from the socket's authenticated identity — a device can only ever pull
  copies addressed to itself; `pulled` confirmations are scoped the same
  way. Copies stored before a block are filtered at delivery AND resync
  (`blockedSet` checks) — a blocked sender cannot refill an inbox.

## 2. Media / files / video

* Every blob is encrypted with a **fresh random file key**
  (`generateFileKey`); that key travels to recipients *inside their
  encrypted envelopes* — the server stores opaque GridFS bytes (blob AND
  thumbnail) and never sees a key.
* `GET /api/media/:id` (and `:part`, range, ack): requires JWT **and**
  `owner+device` or a device registered by the recipient's own message
  envelope; unknown and unauthorized are the SAME 404 (no oracle); ids
  are UUIDs; sha256 of ciphertext is enforced; `cache-control: no-store`;
  two-layer rate limits (IP + account).
* Streaming `PUT /api/media/:id/:part` is owner+device bound and
  single-write (`already_uploaded` 409).

## 3. Push notifications

* Payloads are **blind**: event type + padding only (web-push itself
  encrypts payload to the device anyway). The sender username never
  reaches the push service — it is **hashed into the RFC 8030 topic**
  (`topicFor` sha256). Mute and presence gates run server-side; dead
  subscriptions are cleared, nothing else.
* The service worker's "peek" decrypts queued copies **locally** (sw-lib,
  device keys) — the notification content never transits any server.

## 4. Admin panel & staff

* Admin API: `x-admin-token` compared **hash-then-timingSafeEqual**; the
  server refuses non-loopback binds without a token; CSP `frame-ancestors
  'none'`, `nosniff`, `no-referrer`.
* What staff CAN see: accounts, device lists, relationship/contact edges,
  CoCo score, reports (incl. **user-submitted evidence**), diagnostics,
  IP metadata, badge/moderation state. What they cannot: any message text
  or attachment bytes — the panel has no decryption path; `GET
  /api/admin/reports/:id/media/:index` serves only the PLAINTEXT copies a
  reporter explicitly attached (see §6), content-sniffed against an
  allowlist so a hostile "report" cannot execute on the admin origin.
* God View snapshot: usernames + edges + hasAvatar FLAG — metadata only.

## 5. Auth, transport, storage hygiene

* JWT: HS256-only (header equality kills alg-confusion), `iss`/`aud`
  pinned, `exp` enforced, **timingSafeEqual** signature compare, 24 h
  expiry AND a live device-registry + BAN re-check on EVERY request and
  on WS upgrade — a removed device stops at once for new HTTP and new
  sends to it are refused.
* Logs: the request serializer emits method/redacted-url/ids only — no
  headers, no bodies; `/ws?token=` and enroll-status ids are redacted.
* No CORS is configured anywhere; both apps are strictly same-origin.
* Mongo + Redis bind loopback; pub/sub carries only envelopes; backups are
  age-encrypted (drilled weekly).
* Signup/enroll payloads are signed + timestamped + replay-deduped; the
  unauthenticated `enroll-status` is gated by a 192-bit capability + IP
  limiter; pairing codes are single-use and rate-limited.

## 6. Honest by-design exposures (not bugs — the platform's threat model)

1. **Metadata**: who↔whom (contact edges), message sizes/timing, per-device
   IPs (flap budget), media kind/size/id and WHO DOWNLOADED (ack ledger),
   usernames everywhere. E2EE seals content, not shape.
2. **User-initiated disclosure**: a REPORT ships this device's decrypted
   transcript slice (+ up to 3 decrypted attachments) to the platform —
   the modal previews exactly that and upload requires explicit Send.
   Diagnostics reports carry device state (codes, inventories), never
   conversation text, and expire (30 d TTL).
3. **Local root is in the TCB**: a root/local-user on the box can read
   Redis/Mongo (ciphertext + metadata) and serve the apps — but not
   plaintext. Device compromise is, as ever, device compromise.

## 7. Findings

| # | Severity | Finding | Action |
|---|---|---|---|
| 1 | **Low** | `client/app/414` — a stray debug artifact (ASCII note) shipped in the app root, served at `/414` | deleted in this audit |
| 2 | **Low** | spec drift caught by this audit: `/api/me/pending-adds` documented a `note?` field the code never stores (entries are `{by, at}`) | corrected in the P4 openapi work |
| 3 | **Info** | A device removed mid-session keeps its OPEN websocket until its next handshake (new sends to it are already refused; drain is connect-time only). Code comments acknowledge the window | optional hardening: periodic registry re-check on live sockets (e.g. every 5 min) — decide with groups (a removed member's socket must die too) |
| 4 | **Info** | `JWT_SECRET` has an insecure default, loudly flagged at boot (`jwtSecretInsecure`) | launch runbook already covers rotation; keep out of any prod boot with the default |
| 5 | **Info** | Redis has no AUTH (loopback-only by design) — a local process could inject pub/sub frames carrying *ciphertext* to devices or reset limiter counters | acceptable on the dev box; production topology note |

## 8. What this audit does NOT cover

The groups feature (P4) will add the largest new confidentiality surface —
room fan-out and key rotation. The rules it must not break, restated for
implementation review: room keys wrap per-DEVICE like DM copies; rotation
on join/leave/pass-change/freeze; a member without a room's key must not
be able to obtain it even from history; media acks become per-room-member
without leaking membership beyond the entitled set.
