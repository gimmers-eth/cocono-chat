# Questions for Developing cocono-chat

Open questions derived from `DESIGN.md` and `README.md`, organised so each can be answered
inline. Sections 1–2 should be resolved first — they change the shape of everything else.

---

## 1. Contradictions & Ambiguities in DESIGN.md

These look like errors or unclear wording in the current design doc and need resolution
before implementation.

1. **Private key location.** The design says "The private key is never exposed to the FE
   app," but it is also generated client-side with `window.crypto.subtle.generateKey(...)`.
   Did you mean the private key is never exposed to the **server/network**? If it must truly
   never touch the FE, the whole key model needs rethinking.
2. **Redis vs MongoDB boundary.** MongoDB is described as "persistent data storage" while
   Redis stores "session information including chat history etc." Which is the source of
   truth for messages? What is the split (e.g. Redis = hot/recent + sessions, MongoDB =
   durable archive)? What TTLs apply to Redis data?
3. **`h` vs `s` in the message envelope.** `m.h` is described as "HMAC generated using the
   above message and the private key", while `s` is an Ed25519 signature. Ed25519 keys do
   not do HMAC (and WebCrypto has no HMAC-with-Ed25519). What is `h` actually meant to be —
   an HMAC keyed with the AES-GCM key, a second signature, or redundant with `s`?
4. **"HTTP-based WebSocket client".** The BE section says "a simple HTTP-based WebSocket
   client in the FE app is used to send/receive text messages." WebSockets aren't HTTP
   polling — clarify the intent. Is the plan: REST API for account/management operations,
   WebSocket for real-time messages?
5. **TypeScript or plain JS?** The reconnect snippet uses TypeScript syntax
   (`attempt: number`) but the FE is "no frameworks at all". Is TypeScript in scope (with a
   build step), or is everything vanilla JS? Same question for the Node BE.
6. **Audio/video "messages" vs calls.** The FE section says WebRTC sends "audio and video
   messages"; the BE section says WebRTC is for "transmissions between the two parties".
   Is this live 1:1 calls, recorded A/V messages sent into a chat, or both?

## 2. Product Scope & MVP

1. What is the MVP cut? (Suggested candidate: accounts, 1:1 text messaging, groups, PWA
   install — with A/V, subgroups, and tags deferred.)
2. Message features in scope, now or later: attachments/images/files? Edit after send?
   Delete/unsend? Reactions? Read receipts? Typing indicators? Presence (online/last seen)?
3. Target scale: how many concurrent connections and messages/sec should the design
   support before re-architecting?
4. Who is the intended audience/deployment — self-hosted, or a hosted service you run?

## 3. Accounts, Devices & Recovery

1. **Authentication:** there is no password in the design. How does a user prove ownership
   of an account when adding their *first* device vs a *new* device? Is possession of an
   existing device the only credential?
2. **Account recovery:** private keys are non-exportable and live on devices. If a user
   loses all devices, is the account unrecoverable by design? Is that acceptable, or is a
   recovery mechanism (recovery key, backup codes) needed?
3. **Usernames:** case-sensitive or case-insensitive uniqueness? Any reserved names
   (`server`, `admin`)? Is there a separate display name, or is the username the only
   identity shown?
4. **New-device flow details:**
   - How long is the 6-digit code valid, and how many attempts are allowed?
   - What is transferred to the new device once confirmed — chat history, group
     memberships, anything else?
   - How is an existing device asked to approve (push/in-app prompt)?
   - Can devices be named, listed, and remotely revoked? What does revoking do to keys?
5. Is there a maximum number of devices per account?
6. How does a user delete their account, and what happens to their messages when they do?

## 4. Encryption & Security Model

1. **Trust model (big one):** the AES-GCM key is sent to the server, so the server can
   decrypt every message. Is that intentional (server-trusted, encrypted-at-rest style),
   or is end-to-end encryption (server never sees plaintext) the actual goal? This changes
   nearly every other decision.
2. If E2EE is the goal: how are keys shared for groups — per-recipient key wrapping, sender
   keys, or a group key distributed to members?
3. What exactly is encrypted end-to-end vs visible to the server (recipient `u`, timestamp
   `t`, group membership, message sizes)?
4. **Key rotation:** when does a user change their AES key, how do their other devices and
   the server learn the new key, and what happens to in-flight messages during rotation?
5. **Browser support:** WebCrypto Ed25519 is only available in recent browsers
   (Chrome ~113+, Safari 17+, Firefox 130+). Is a fallback (e.g. a JS library like
   `@noble/ed25519`) acceptable, or do we simply require modern browsers?
6. Where are non-exportable CryptoKeys persisted across sessions on the client (IndexedDB
   of CryptoKey handles)? What is the story if storage is cleared?
7. Rate limiting and abuse: how do we stop spam/flood on the WS and signup endpoints?
8. Data retention & privacy: how long does the server keep messages? Must we support full
   deletion on request (GDPR-style)?

## 5. Messaging & Delivery Guarantees

1. **Offline delivery:** Redis pub/sub is fire-and-forget — if the recipient is offline,
   the message is dropped. What is the persistence path (per-user inbox queue in
   MongoDB/Redis, store-and-forward)? This is the biggest gap in the current flow.
2. How does a client catch up on messages missed while disconnected (sequence numbers /
   last-ack cursor / inbox pull on reconnect)?
3. Message IDs and deduplication: are IDs client-generated (for idempotent retries) or
   server-assigned?
4. Ordering: client-provided timestamps can't be trusted for ordering. Does the server
   assign sequence numbers/order on receipt?
5. Delivery/read acknowledgements — are they in scope, and how would they flow?
6. Heartbeat specifics: interval, timeout before a connection is dropped, and does the
   client or server initiate?
7. Reconnect: the backoff caps at 30s — anything else needed (e.g. visibilitychange
   handling, `navigator.onLine` hooks)?
8. Max group size, and does fan-out to large groups need special handling?

## 6. Message Organisation (Groups, Subgroups, Tags)

1. **Group admin model:** who can create groups, add/remove members, promote admins, and
   delete a group? What happens to history when a group is deleted or a member leaves?
2. **Subgroups from a message:** does the sub-group link back to the originating message?
   Who picks the initial members — the creator only?
3. **Opt-in subgroups:** when members "CHOOSE to join", do they see the sub-group name,
   description, and member list before joining? Are non-joiners aware it exists?
4. **Special subgroups:** who is allowed to add members directly (the "kids" example)?
   What permissions do these members have compared to main-group members?
5. **Message tags:** are tagged collections strictly private to the tagging user? Do tags
   store references (pointers) or copies of messages? What happens to a tag entry if the
   original message is deleted? Do tags sync across a user's devices?
6. Can a user mute/leave subgroups independently of the parent group?

## 7. PWA / Front End

1. Build tooling: no framework — but is a bundler (esbuild/Vite) acceptable for modules,
   minification, and service-worker generation, or strictly zero build?
2. Service worker strategy: what should work offline (app shell only? reading cached
   history? composing drafts that sync later)?
3. **Notifications:** PWAs need Web Push (VAPID, service worker) to notify users of new
   messages when the app is closed. Is that in scope? Note iOS PWA push only works from
   the home screen on recent iOS.
4. How should media (images/audio/video) be handled in the PWA — lazy loading, caching,
   storage quota management?
5. Multi-tab behaviour: if the app is open in two tabs, do both get live WS connections,
   or should one lead (e.g. via BroadcastChannel)?

## 8. Back End Architecture & Operations

1. Node BE specifics: TypeScript? A web framework (Fastify/Express) or bare `http` + `ws`?
2. "Workers should be used to reduce latency spikes" — `worker_threads`, child processes,
   or a queue (e.g. BullMQ on Redis)? What work moves to workers (persistence, fan-out,
   crypto verification)?
3. REST API surface: which endpoints exist (signup is via WS message — why not REST?), and
   how is REST authenticated (JWT, session cookie, signed request)?
4. WS auth: is the first signed message the handshake, or is identity passed in
   headers/query at upgrade time?
5. Multi-instance deployment: Redis pub/sub covers fan-out across nodes, but do we need
   sticky sessions, and where does per-node `localClients` state live if a node dies?
6. Deployment target: Docker? Which host/cloud? (The `ulimit` notes suggest Linux —
   confirm.) Who terminates TLS/WSS (nginx/Caddy/LB)?
7. Ops: logging, metrics, alerting, and backup strategy for MongoDB and Redis?
8. Environments: local dev setup — docker-compose for Mongo + Redis?

## 9. WebRTC & Media

1. Signalling: do offer/answer/ICE candidates flow over the existing WebSocket (and are
   they encrypted/signed like other messages)?
2. STUN/TURN: use public STUN only, or self-host STUN/TURN? TURN is required to work
   reliably across symmetric NATs — who operates/pays for it?
3. If recorded A/V messages are in scope: where are blobs stored (MongoDB GridFS, S3-style
   object storage), what are the size limits, and are they encrypted like text messages?
4. Are group audio/video calls ever in scope, or strictly 1:1?
5. Call UX basics: ring/alert mechanism, decline, busy handling, call history?

## 10. Delivery, Milestones & Repo

1. What is the definition of done for a first usable version, and roughly when?
2. Preferred milestone order — suggest: (1) account + single-device auth, (2) 1:1 text
   with persistence + offline delivery, (3) groups, (4) multi-device, (5) PWA polish/push,
   (6) subgroups/tags, (7) WebRTC. Agree/change?
3. Testing strategy: unit tests, integration tests against real Mongo/Redis, load tests
   for the WS layer (which also validates the file-descriptor tuning)?
4. Repo layout: monorepo with `fe/` and `be/` directories, or separate repos?
