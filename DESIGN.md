# cocono-chat Overview

A web based messaging app built using Node.js and ws. The app is a PWA that is designed to
run on any system.

All open questions from `QUESTIONS.md` have been resolved via `ANSWERS.md`; those decisions
are incorporated below.

## Architecture

### Front end (FE)
FE is a PWA using **plain JavaScript only** — no frameworks and no bundler (plain ES
modules).

- Real-time text messaging over WebSockets (standard `WebSocket` API; the connection is
  established via an HTTP upgrade request).
- Media (voice messages, images, videos) is uploaded/downloaded as message attachments.
  Live WebRTC audio/video is **post-MVP** (see Media section).
- Only one active tab per device.
- Keys and pulled messages are stored locally in IndexedDB.

Reconnection logic with exponential backoff and jitter is used to stop thundering herd
issues. Reconnects should also be triggered on `visibilitychange` and `navigator.onLine`
events.

```javascript
function reconnect(attempt) {
  const base = 1000;
  const max = 30000;

  const delay = Math.min(base * 2 ** attempt, max);
  const jitter = Math.random() * 1000;

  setTimeout(connect, delay + jitter);
}
```

### Back end (BE)
Node.js, plain JavaScript, bare minimum dependencies. Fastify is allowed (including its
WebSocket plugin if it proves scalable); `ws` is used for the WebSocket server.

- **MongoDB** — long-term persistent storage.
- **Redis** — pub/sub fan-out and hot session/message data.
- **REST API (JWT auth)** — signup, account management, and heavy writes (user changes,
  new user creation, etc.) go over REST so the real-time WS loop is never lagged.
- WebSocket connections carry user identity in the headers/query at upgrade time.
- **Heartbeat is server-initiated** to keep sessions alive and drop dead connections.
- All work other than pub/sub (persistence, fan-out, crypto verification) runs in workers
  using `worker_threads` + Redis to reduce latency spikes in the main loop/thread.
- Designed to scale horizontally from the start: stateless REST API, per-node local client
  maps, Redis pub/sub for cross-node fan-out, and no sticky sessions required. Initial
  target: **10k users on basic hardware**.

REMEMBER to check file descriptors on OS
```bash
ulimit -n
```

Raise it:

```bash
ulimit -n 100000
```

Persist in /etc/security/limits.conf:
```
* soft nofile 100000
* hard nofile 100000
```

## Message Delivery & Retention

Store-and-forward model:

- Recipient online: message is published via Redis pub/sub.
- Recipient offline: message is queued in Redis, moved to MongoDB after X minutes (or
  written straight to MongoDB if the user is known to be offline), and deleted as
  undelivered after X days.
- Messages are only kept on the server until the user has downloaded them on their
  device(s).

Rules:

- Clients **pull** all pending messages on reconnect. Messages are encrypted per device;
  once pulled they are removed from the server.
- Message IDs and timestamps/ordering are **server-assigned** (client timestamps are not
  trusted for ordering).
- A non-main device that is inactive for **14 days** is removed, and its pending messages
  are deleted.
- Delivery/read awareness: if a message no longer exists on the server it has been pulled
  (read). The sending client keeps track of its sent messages so the sender can be shown
  when a message has been received.
- Rate limiting: per-account limits plus per-IP limits on the signup endpoints.

## Users & Encryption

### Accounts
Each user has an account that they can connect to using multiple devices.

- Username: at least five characters, alphanumeric, underscores (`_`) or dashes (`-`)
  only. **Case-insensitive uniqueness** (`aBc` is the same as `abc`). Reserved names are
  configurable.
- Usernames cannot be changed once set.
- **No passwords.** Account ownership is established by being first to register the
  username with a key pair.
- Max devices per account: configurable, **default 3**; per-account overrides are set by
  an admin in the admin app (`PATCH /api/admin/users/:username/max-devices`, 1–1000;
  raising lets a user enroll more devices — may become a premium feature later).
- Recovery (MVP): none. Losing all devices means messages are lost. Later: email-based
  recovery of the username and backup options.

### Key model
- On signup the device generates an **Ed25519** key pair using
  `window.crypto.subtle.generateKey(...)`. A JS fallback library is acceptable for
  browsers without WebCrypto Ed25519 support.
- The private key is **non-exportable and never exposed to the server/network**. It is
  stored in IndexedDB; if storage is cleared the user loses access (until a backup feature
  exists).
- An exportable **AES-GCM** key is generated and sent to the server inside a signed
  message (signed with the Ed25519 key). Once the server has received it, the client
  re-imports it as non-exportable. This key encrypts **client <-> server** transport only.
- Message content is **end-to-end encrypted**: every conversation (1:1 or group) has its
  own AES key (WhatsApp-style). Conversation keys are established using the users'
  public/private keys.
- Keys are rotated when a group's membership changes and when a new conversation is
  started.
- Server-visible metadata: recipient/group `u`, timestamp `t`, group membership, message
  sizes. Message content is never visible to the server.

### Account creation
Signup happens via the REST API (`POST /api/signup`). The creation data object is:

```
{
    u: string // username
    p: string // public key of user (raw Ed25519, base64url)
    a: string // AES key of user (raw AES-GCM, base64url)
    d: string // device id (client-generated UUID)
    t: number // client timestamp, epoch seconds, at signing time
    s: string // Ed25519 signature over the canonical JSON of { a, d, p, t, u }
}
```

JSON-encoded and sent to the server. Keys are base64url-encoded **raw** bytes. The
signature proves possession of the private key at signup. The first registered device is
the **main** device. `p`, `a` and usernames are validated server-side; usernames are
stored case-insensitively for uniqueness.

Freshness and replay protection: `t` must be within `SIGNED_PAYLOAD_MAX_AGE_SEC`
(default 5 minutes) of server time, and every accepted signature is de-duplicated in
Redis (`sigseen:<sha256>`), so a captured signup/enroll payload can never be replayed.
The same pattern applies to device enrollment and should be carried into every future
signed envelope.

### Authentication (challenge-response)
There are no passwords — login proves possession of a registered device's private key.
Implemented as a challenge-response flow over REST:

1. `POST /api/auth/challenge` with `{ u, d }` — the server returns a one-time nonce `n`
   (random 32 bytes, base64url), stored in Redis with a TTL (`NONCE_TTL_SEC`, default 5
   minutes) and keyed to that username + device. A nonce is issued for **any**
   username/device pair — unknown pairs get a nonce that simply never verifies, so the
   endpoint does not reveal which accounts exist.
2. The client signs the nonce with the device's Ed25519 key.
3. `POST /api/auth/verify` with `{ u, d, n, s }` — the server consumes the nonce FIRST
   (junk requests without a valid nonce never touch the account's rate-limit budget),
   verifies the signature against the stored public key, then issues a **JWT** (HS256
   with pinned `iss`/`aud`, `JWT_EXPIRES_IN_SEC`, default 24h). Nonces are single-use —
   verification consumes them, so replays are rejected.
4. The JWT is sent as `Authorization: Bearer <token>` on authenticated REST endpoints.
   Every authenticated request re-checks that the token's device is still registered —
   a device removed by an admin loses access immediately, not at token expiry.

Rate limiting: challenge and verify are limited per-IP, verify additionally per-account,
and signup per-IP (see `.env.example`).

The REST API uses JWT auth; the WebSocket layer (later milestone) will validate identity
supplied at upgrade time.

### Message envelope
A message sent to the server from a client looks as follows:

```
{
    m: {
        d: string // data/message being sent
        u: string // user/group this is for or "server" to send to the server
        t: string // timestamp of the message being sent
        h: string // HMAC keyed with the user's AES-GCM key, generated over the message
    }
    s: string // signature created using the ED25519 signing algorithm and message
}
```

Once a user has been created the message data (`m.d`) is encrypted with the user's AES key
for transport, with the content additionally encrypted end-to-end with the conversation
key. Depending on the message, the user may just encrypt the message without signing.

Messages that need signing (`s`):
- New user creation
- New device adding
- Changing AES keys
- Optionally any message

### New device adding
A user can add a new public and AES key to their account for a new device. Implemented
over REST (see `be/openapi.yaml`):

1. **Enroll** — the new device generates its own keys and posts the same payload shape
   as signup (including the freshness timestamp `t`) to `POST /api/devices/enroll`,
   signed with its own private key. The server checks the account exists and the device
   limit is not reached, then generates a **6 digit code** valid for **10 minutes**
   (`DEVICE_CODE_TTL_SEC`; allocated with SET-NX so concurrent enrollments can never
   clobber each other), and returns the code plus an unguessable `enrollId`.
2. **Approve** — the user enters the code on an existing, already-registered device.
   Before approving, the UI shows WHAT is being approved (`POST /api/devices/pending`
   returns the requesting device id + time) and asks for explicit confirmation — a bare
   code entry would be a social-engineering surface. Codes are scoped per account and
   single-use; the new device is added atomically subject to the account's device limit.
3. **Poll** — the new device polls `GET /api/devices/enroll-status/:enrollId` (the
   `enrollId` is an unguessable capability; the device has no JWT yet). On approval it
   saves its identity and logs in via the normal challenge-response flow.

All devices on an account authenticate independently, so several devices can be logged
in at the same time.

- Rate limiting: enroll per-IP, approve per-account.
- Once messaging exists, all data (chat history, groups, etc.) is passed to the new
  device **encrypted**.

## Message Flow on BE

Once the server receives a new message, it is added to a message queue using a sub/pub
pattern like the following:

```javascript
import { WebSocketServer } from 'ws';
import { createClient } from 'redis';

const wss = new WebSocketServer({ port: 3000 });

const pub = createClient({ url: process.env.REDIS_URL });
const sub = createClient({ url: process.env.REDIS_URL });

await pub.connect();
await sub.connect();

const localClients = new Map();

wss.on('connection', (ws, req) => {

  // identity is supplied in the headers/query at upgrade time — validate it there

  ws.on('message', async (msg) => {
    // decode message as JSON
    // check message.u exists
    // if msg.u === 'server' then publish to server queue
    // else...
    await pub.publish('msg', msg.toString());
  });

  ws.on('close', () => localClients.delete(ws));
});

await sub.subscribe('msg', (message) => {
    // get list of clients from msg.u (group or individual user)
    // check ready state before sending the message...
    // if (client.readyState === client.OPEN) {
    //   client.send(message);
    // }
});
```

In the real implementation, workers are used to keep everything except pub/sub off the
main loop/thread.

## Organisation of Messages

- **Users** — 1:1 conversations.
- **Groups** — max size **20** (larger groups considered later). When a member leaves
  there is no history to manage server-side: the leaving member keeps their local history
  on device but can no longer send to the group; the remaining members rotate the group
  key.
- **Subgroups** — can be created in a group from a message in the main group chat (the
  sub-group links back to that message), or just as a new sub-group. The creator picks the
  invited members; membership is a **choice** — invitees can see the sub-group and choose
  to join or not. Subgroups can be muted or left independently of the parent group.
- **Special subgroups** — subgroups where members can be added without being in the main
  group (i.e. kids can be added). These members have the same permissions as regular
  members.
- **Message tags** — a personal pseudo sub-group holding **pointers** to messages for
  future reference. Strictly private to the tagging user. Messages themselves are only
  ever stored on the client once pulled.

## Media

- MVP scope: text, voice messages, and image/video file uploads. Live WebRTC calls are
  post-MVP ("never say never" for group calls; 1:1 calls are in scope post-MVP, along
  with ringing/call UX).
- Media is stored on the device once the message is downloaded. By default media is
  deleted **24h** after download unless the user marks it to keep long term.
- Long-term server-side media storage may become a premium add-on later; storage backend
  undecided (likely S3-style). Post-MVP problem.
- STUN/TURN will be self-hosted when real-time media is needed.

## PWA

- Offline support: visibility of messages already pulled by the client, message tags and
  the like.
- Notifications via **Web Push with VAPID keys**.
- The app only works in one tab per device.

## Deployment & Operations

- Self-hosted initially (AWS possible later). OS: Ubuntu or Amazon Linux. Minimal CI
  infrastructure.
- **nginx** terminates TLS/WSS. Deployed with **pm2**, pulling code from GitHub.
  Kubernetes may come later.
- Daily backups initially. Redis runs as a replica set for high availability.
- Logging, alerting and metrics: something simple and low-resource — options to be
  explored.
- Dev: optionally connect to a local or remote/network dev server.

### Production checklist

1. **TLS everywhere** — the app speaks plaintext HTTP by design (nginx terminates TLS);
   tokens and signed payloads traverse the wire. Never expose without TLS. Add HSTS at
   the proxy.
2. **`JWT_SECRET`** — long random value (`openssl rand -base64 48`). The server refuses
   to boot with the dev default.
3. **`ADMIN_TOKEN`** — always set, even on "internal" hosts (mandatory for non-loopback
   binds). Keep the admin port on loopback where possible.
4. **MongoDB / Redis** — auth + TLS + bind to private interfaces. Redis additionally
   holds pending-enrollment AES keys and login nonces.
5. **`TRUST_PROXY`** — configure before deploying behind nginx so per-IP rate limits see
   real client IPs; verify nginx forwards `X-Forwarded-For`.
6. **`pnpm audit` in CI** — dependency advisories should not regress unnoticed.

## Testing

Unit tests, integration tests against real MongoDB/Redis, and load tests for the WebSocket
layer (which will also validate the file-descriptor tuning).

## Milestones (MVP order)

1. Accounts
2. Multi-device
3. 1:1 messages (text)
4. Files/media (images etc.)
5. Groups (with offline delivery)
6. PWA polish (push, offline)
7. Subgroups / tags

**Definition of done for v1:** users, multiple devices, encrypted messages, media sharing
and groups with offline delivery.

## Repo

Monorepo managed with pnpm workspaces:

- `be/` — Node.js backend (Fastify REST API; also serves the FE as static files).
  `pnpm dev` runs a persistent mongodb-memory-server (data in `be/.data/`) plus the
  server with auto-reload; `pnpm test` runs unit + integration tests (node:test).
- `fe/` — the PWA (plain JS ES modules, no build step).
