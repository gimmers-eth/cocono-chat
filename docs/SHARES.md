# Share links, referral attribution & the God View

How the app's share button turns into server-side knowledge about *who brought
whom here* — and how the admin panel draws it.

The share button (chat drawer → **Share my chat link**) hands out a deep link:

```
https://<host>/?chat=<my-username>
```

Opening it does two things: the client parks the name and opens that
conversation once a session exists (`client/app/js/main.js`
`captureSharedChat`/`takeSharedChat`), **and** it records the click on the
server so the operator can see how the network is actually growing.

---

## 1. The two facts worth keeping

| Fact | Recorded when | Where | Graph edge |
|---|---|---|---|
| **CREATED** — an account came into existence *because of* someone's link | `POST /api/signup` with `r=<owner>` | `users.ref = { by, at }` + a `shares` pair doc with `created` set | solid **brand purple** `owner → child` |
| **SEEN** — an account that *already existed* opened someone's link | `POST /api/share/hit` (authed) | a `shares` pair doc (`n`, `firstAt`, `lastAt`) | dotted **dark purple** `owner → viewer` |
| **MESSAGED** — A has sent B at least one message | every accepted ws send | a `contacts` pair doc | dashed **teal** `sender → recipient` |

An anonymous visitor who clicks a link and never signs up leaves **no record**.
That is deliberate: the two facts above are relations between *accounts*, and
an unauthenticated write-anywhere endpoint would be a free graph spoofer plus
an unbounded collection. If that visitor signs up later, the CREATED edge
covers them.

### Trust level (read this before building anything on top)

Attribution rides **unsigned** fields — `r` on the signup body, `o` on the
share-hit report. The signup signature still covers identity, keys, device and
freshness (`canonical({a,d,p,t,u,x})`); widening it would break every shipped
client for a field that **buys nothing**: no reward, no score, no badge, no
capability. The worst a lying client can do is mislabel *its own* origin in an
admin view. Consequences that follow from that:

- Never gate a reward, a badge or a limit on `users.ref`.
- The God View is an *operator's map*, not evidence about a user.
- A deleted referrer is not resurrected: the child keeps `ref.by` (its own
  origin story) and the graph draws the missing parent as a **ghost node**.

---

## 2. Data model

`be/src/lib/shares.js` is the single source of truth for the shape and the
helpers (`recordShareHit`, `recordReferral`, `recordContactEdge`,
`shareStory`).

### `shares` — one doc per (link owner → account that followed it)

```js
{ o: 'alice',          // whose link it was
  viewer: 'bobby',     // who followed it
  n: 3,                // clicks, EXCLUDING the creation itself
  firstAt: Date, lastAt: Date,
  created: Date }      // set only when `viewer` was CREATED from o's link
```

Unique index `{o, viewer}`; secondary `{viewer}` for the reverse read. The
pair *is* the identity, so the collection is bounded by real relationships —
a user hammering one link bumps a counter instead of adding rows.

A created pair also collects later clicks in the same row (`n`), which is why
"created from your link" and "links you clicked" can never disagree: they are
two reads of one document.

### `contacts` — one doc per (sender → recipient)

```js
{ from: 'alice', to: 'bobby', n: 12, firstAt: Date, lastAt: Date }
```

Unique index `{from, to}`. **Why it exists:** the message queue is
store-and-forward — copies expire out of `messages` once pulled — so without
this the graph would only ever show messages *in flight*. It holds addressing
metadata the server already saw (who, how often, when); never content, never
an envelope. Self-sends are skipped. Written concurrently with the existing
sent-counter upsert, so it adds no latency to a send, and a failure can never
fail a delivery.

### `graph` — one snapshot doc, `_id: 'godview'`

`{ generatedAt, stats, nodes[], edges[], layout, layoutSavedAt }`. Derived
data: `POST /api/admin/graph` replaces it, `PUT /api/admin/graph/layout`
stores the panel's laid-out positions so reopening shows the same picture
without re-simulating. `ops/wipe-data.sh` drops it with everything else
(auto-discovered collection, nothing to add to `KEEP`).

### On deletion

`deleteAccountFully` (lib/accountState.js) removes `shares` rows **both
directions** and `contacts` rows both directions — referral/click metadata is
data *about* the account, so it goes with it. `users.ref` on a *child* is the
child's own record and survives; that is what makes the ghost node possible.

---

## 3. Client flow

`client/app/js/shares.js` owns the browser half. The link is parked in
`localStorage['cocono.shared.link']` as `{o, at}` because the URL is rewritten
at boot and a signup may happen much later:

```
boot with ?chat=alice
  ├─ main.js captureSharedChat()  → parks the chat to open (existing behaviour)
  └─ noteShareLink('alice')       → parks {o:'alice', at:now} for attribution

…visitor has an account, logs in…
  enterApp() → reportShareHit(client, {fresh: signedUp})
     fresh=false → POST /api/share/hit {o:'alice'}   → SEEN edge, link consumed
     fresh=true  → signup already carried r='alice'   → link consumed silently
     offline     → left parked for the next entry

…visitor has no account, signs up…
  auth.js → client.register(name, { referrer: referrerForSignup(name) })
     → POST /api/signup {…, r:'alice'}               → CREATED edge + users.ref
```

`referrerForSignup()` refuses a stale link (older than 30 days — a shared
browser profile is not the same person six months later) and refuses
self-referral. The server repeats both checks; nothing here is trusted.

SDK surface (see [CLIENT_SDK.md](./CLIENT_SDK.md)):
`client.register(username, { referrer })`, `client.reportShareHit(owner)`
(best-effort: returns `{ok, recorded}` instead of throwing into a boot path),
`client.myShareLink()` → `{ path, created, clicked }` — counts only, never who.

> **Deliberate gap:** `myShareLink()` exists in the SDK and the API but the
> shipped app shows it nowhere. Telling a user *"N people joined from your
> link"* is a growth incentive, and this app's whole posture is anti-spam /
> reputation-first — that is a product decision, not a wiring oversight. The
> server side is ready when someone makes it.

---

## 4. Admin panel

### Users → *view more* → **Shares** tab

Four blocks, in the order that tells the story:

1. **Created from @user's link** — accounts born from this link (newest first).
2. **Opened the link (already had an account)** — the SEEN list, with click
   counts and first/last click.
3. **Links @user clicked** — the reverse read, including the link this account
   was born from (flagged in place).
4. **This account came from** — the parent, or "no share link".

Every name is a link into that account's own panel, and every face is fetched
through the shared avatar cache. The **Details** tab shows the same parent line
(`users.ref`), because "who created this account" is a detail, not just a tab.

### **God View** (`#godview`, admin nav)

The whole graph, generated **on demand** and stored server-side — opening the
page never rebuilds it (a rebuild reads every account).

| Element | Meaning |
|---|---|
| solid brand-purple line | CREATED: the arrow points from the link's owner to the account it created |
| dotted dark-purple line | SEEN: an existing account opened that link |
| dashed teal line | MESSAGED: sender → recipient |
| card | profile photo (or initial), app-trust icon (green shield = ID verified, red alert = unverified), `@username`, worn badge artwork, CoCo score + a green dot when Social: Trusted, generation `g<n>` |
| dashed card + ghost icon | a deleted parent that a live account still names |
| green/red leading edge | app-trust state, so a zoomed-out map still reads as a trust heatmap |
| purple dot on a card | that node was dragged and pinned |

Every card carries three icon links under the name: open the **profile** panel,
its **Shares** tab, its **Relationships** tab. Clicking the card itself opens
the inspector (facts, parent, and Open profile / Shares / Centre / Pin / Hide).

Controls: `Regenerate` (with *keep layout* for the positions of nodes that
survive), `Save layout`, edge-kind filters, *hide loners*, a *max nodes* cap
(the most connected accounts win), search (`Enter` centres the first match),
zoom `−/+`, `fit`, and a freeze button for the physics.

Interaction: drag the backdrop to pan, scroll (or ctrl-scroll) to zoom at the
cursor, drag a card to move and pin it, double-click to release, `f` to fit,
`Esc` to close the inspector. The camera persists in `localStorage`; the
settled layout autosaves to the snapshot.

Rendering is split on purpose: **edges on one `<canvas>`** (thousands of
dashed, glowing, directed curves stay cheap, and every length is divided by
the zoom so line weight, dashes and arrowheads never fatten up), **cards as
HTML** inside a CSS-transformed layer (real photos, the shared badge-art
module, crisp text, working buttons), **physics from vendored d3-force**
(`be/admin/vendor/d3/README.md` — four UMD files, ISC, loaded as classic
scripts before the modules; the panel's CSP is `script-src 'self'`, so a CDN
tag was never an option).

One subtle trap worth knowing before editing this file: the stage takes
`setPointerCapture` while dragging, and **capture retargets the `click` that
follows `pointerup` to the stage** — so any real button inside the stage must
be excluded from the drag path (`NO_DRAG` in `admin/godview.js`) or its click
silently goes nowhere.

### API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/share/hit` | authed; `{o}` → SEEN edge; `{recorded:false}` for your own link, 404 for a deleted owner |
| `GET` | `/api/me/share-link` | authed; your link path + created/clicked counts |
| `POST` | `/api/signup` | `r` (optional, unsigned) → CREATED edge + `users.ref` |
| `GET` | `/api/admin/users/:ul/shares` | the Shares tab: `{ref, created[], seen[], clicked[]}` |
| `GET` | `/api/admin/graph` | the **stored** snapshot (`{snapshot:null}` before the first build) |
| `POST` | `/api/admin/graph` | regenerate; `{keepLayout:true}` keeps surviving positions |
| `PUT` | `/api/admin/graph/layout` | `{positions:{ul:[x,y]}}`, or `{positions:null}` to clear |

Rate limiting: `sharehit` in the limits catalog (per account, default 60/hour,
tunable in Traffic → Tune like every other limiter).

---

## 5. Honest limits

- **Attribution is client-claimed** (see §1). Treat growth numbers as a map,
  not as proof.
- **One parent per account**, recorded once at signup and never rewritten —
  re-registering a name starts a new account with no parent unless the new
  signup follows a link.
- **`contacts` grows with distinct pairs**, not messages: two accounts that
  exchange a million messages are still one row. It is never pruned while both
  accounts live, which is the point (it is the only durable record that the
  conversation happened).
- **Message edges are directional and asymmetric by design** — A messaging B
  says nothing about B replying. The graph draws both when both exist, bowed
  apart so the two arrowheads never overlap.
- **The snapshot is a snapshot.** It does not refresh on a timer; the panel
  shows when it was generated so a stale map can never pass for a live one.
