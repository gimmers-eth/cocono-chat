# fe — technical overview

Plain JavaScript PWA. No frameworks, no bundler, no build step — ES modules loaded with
`<script type="module">`, served as static files by the backend. Any change is live on
reload.

## Layout

The UI is split into small components — one module per view plus shared helpers, and
each view's markup lives in its own HTML fragment. No framework; each component is a
plain ES module that owns a `<section>` loaded from `views/`.

```
index.html            thin shell: head + <main><div id="views"></div>, loads js/main.js
views/                per-view markup fragments (plain <section>s, no scripts)
  auth.html           #view-auth
  home.html           #view-home
  blocked.html        #view-blocked
style.css             minimal dark styling, no framework
manifest.webmanifest  PWA manifest (icons/service worker come with milestone 6)
js/
  main.js             bootstrap: loadViews() then wire components + view state machine
  views.js            fetches views/*.html and injects them into #views at startup
  ui.js               $ / show / setStatus / setBusy / fmtAgo helpers
  session.js          JWT get/set (sessionStorage, per-tab)
  api.js              fetch wrappers for the REST API (+ ApiError)
  crypto.js           WebCrypto helpers: Ed25519, AES-GCM/HMAC, signing
  db.js               IndexedDB identity store
  util.js             base64url, UTF-8, canonical JSON
  components/
    auth.js           #view-auth: signup + add-device enroll + login
    home.js           #view-home: device list + approve + logout + forget
    blocked.js        #view-blocked: single-tab guard
```

View markup is fetched and injected at startup (`views.js`) rather than inlined in
`index.html`, so each view's HTML stays in its own file as the app grows. Because the
fragments are injected *after* modules load, `ui.js` looks view elements up lazily (no
top-level DOM capture). `main.js` wires the components and decides which view is visible;
each component exposes a small API (`wireAuth`, `wireHome`, `enterHome`, `resetView`,
`applyIdentity`, `stopPolling`, `startSingleTabGuard`) and calls back into `main.js` on
transitions (`onLoggedIn`, `onLogout`, `onReset`). No component imports another
component, so there are no import cycles.

## Crypto model

- **Ed25519** key pair per device via `crypto.subtle.generateKey({ name: 'Ed25519' },
  extractable = false, ...)`. The private key is non-exportable and never leaves the
  device; the public key is exported as **raw 32 bytes, base64url**.
- **AES-GCM 256** transport key generated exportable, sent to the server in the signed
  signup payload, then **re-imported as non-exportable** — twice:
  - `aesEnc` — AES-GCM `['encrypt', 'decrypt']` (transport encryption)
  - `aesMac` — HMAC-SHA256 `['sign', 'verify']` (integrity for the future message
    envelope `h` field)

  Both come from the same raw bytes, per DESIGN.md's single-AES-key model. The raw bytes
  are discarded afterwards — the CryptoKey handles are the only copies (they are NOT
  written to IndexedDB).
- **Signing:** signup/enroll sign `canonical({ a, d, p, t, u })` where `t` is the
  current epoch-seconds timestamp (freshness + replay protection server-side); login
  signs the nonce string.

### Server-contract sync

`js/util.js` (base64url + canonical JSON) mirrors `be/src/lib/b64u.js` and
`be/src/lib/canon.js` byte-for-byte. If either changes, change both — the integration
tests in `be/test/` pin the expected shapes.

## Identity storage (IndexedDB)

Database `cocono`, object store `identity`, single key `me`:

```javascript
{
  username,      // display username
  deviceId,      // crypto.randomUUID(), registered with the server
  priv,          // CryptoKey — Ed25519 private key (non-exportable)
  pubRaw,        // base64url raw public key
  aesEnc,        // CryptoKey — AES-GCM, non-exportable
  aesMac,        // CryptoKey — HMAC-SHA256, non-exportable
}
```

CryptoKey handles are structured-cloneable, so they persist across sessions. Clearing
site data deletes the identity — account access is lost (by design until backups exist).

## Flows

- **init** — load identity from IndexedDB: none → signup form; present → "Log in as
  @user" button, or straight to home when a valid session token exists.
- **signup** — generate keys → sign canonical payload → `POST /api/signup` → re-import
  AES non-exportable → save identity → immediate login.
- **login** — `POST /api/auth/challenge` → sign nonce with the stored private key →
  `POST /api/auth/verify` → store JWT in **sessionStorage** → `GET /api/me` → home view.
- **logout** — drops the session token only; identity stays on device.
- **forget device** — deletes the IndexedDB identity (with confirmation); account access
  is gone unless another device holds it.
- **add device (milestone 2)** — "Add this device to an existing account": generate
  keys → enroll → show the 6-digit pairing code → poll the status endpoint every 2s →
  on approval save identity and log in automatically.
- **approve device** — from the home view: enter the code → the app fetches the pending
  request's device id + time (`POST /api/devices/pending`) and asks for explicit
  confirmation before approving.

Tokens live in sessionStorage (per-tab), identities in IndexedDB (per-device).

## Single-tab guard

"One active tab per device" (DESIGN.md): on load the tab pings over a
`BroadcastChannel('cocono-tab')`; an existing tab answers with pong, and the newcomer
shows the blocked view. Simple first implementation — a proper leader election can
replace it if needed.

## Browser support

WebCrypto Ed25519 required: Chrome ~113+, Safari 17+, Firefox 130+. No fallback library
yet (decision: modern browsers only for MVP).

## PWA status

Manifest is present; service worker, offline caching and Web Push (VAPID) arrive in
milestone 6. Offline visibility of already-pulled messages comes with messaging itself.
