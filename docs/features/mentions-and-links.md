# Mentions & Links — the composer's rich text

What typing `@` in the chat composer does, how names and URLs render in the
transcript, and the rules the RECEIVER applies to text it did not write.
All of it is CLIENT-side: the wire format stays a plain encrypted string; the
server never learns that a message mentions anybody.

Related: [../FRIENDS.md](../FRIENDS.md) (the trust ladder a mention renders) ·
[../MESSAGES.md](../MESSAGES.md) (delivery of the plain text) ·
[images-and-files.md](./images-and-files.md) (the conversation tabs)

## 1. The wire format

A hand-typed mention is **plain text**: `"@username "` — an ASCII username
(server rules, 4–64 chars) glued to a space. Nothing else; the receiver
detects it at render time and it only becomes a chip for devices that
already KNOW that name.

**Picked mentions carry metadata.** When the sender SELECTS a user from the
@-search, the composer marks that name as picked and the send wraps the
message in an envelope:

```json
{"men":["bob-3"],"text":"hi @bob-3, see example.com/x"}
```

`{"men":…,"text":…}` is the same in-plaintext-JSON trick the `{"media":…}
descriptor uses (and it nests cleanly inside the E2EE envelope — only the two
parties ever see it). The receiver unwraps it at arrival: the transcript
stores the plain `text` plus a `men` field of the ASSERTED names, and those
names render as user chips **even when the receiver has never seen that
user** — the sender vouched for the name by picking it. The assertion is
render-only: it can mark a chip purple, it can NEVER fake a trust icon —
the icon always comes from the receiver's own mirrors (an asserted stranger
wears the red not-added mark, honestly).

Envelopes are validated on arrival (legal usernames only, deduped, capped
at 20, unparsable JSON passes through untouched), senders without picks send
plain text, and media/sys payloads are never wrapped. Forwarding rebuilds
the envelope from the stored `men` ∩ the names still present in the text.

## 2. One parser: `js/rich.js` (pure)

`splitRich(text, isKnown)` scans mentions, `http(s)://` URLs and **bare
hosts** (`example.com/x` — a scheme is NOT required; a KNOWN-TLD allowlist
keeps `photo.jpg`, `v1.2` and `e.g.` out of the links) into ordered runs.
`extractLinks` is the same scanner filtered to links — `media.js` re-exports
it, so the Links tab and the bubble painter can never disagree about what a
link is. `mentionCandidates` orders the @-search. All pure: the suite pins
the rules in `client/test/rich.test.js`.

## 3. Rendering: what a NAME means is the viewer's business

A recognized mention renders as a **chip** (the `.badge-chip` skin) in brand
purple — a purple name is a PERSON, not prose — holding the single-line
component (`components/userline.js` mountLine): trust icon + name + worn
badge, with the trust state resolved from **this device's** mirrors. The
`@` sigil is parsing furniture: it lives in the wire text, never in the
display. Consequences:

* A mention of MY OWN name renders as the SELF component wearing MY badge:
  the worn chip and premium come from `identity()` (loaded once per session,
  refreshed on `cocono:badges-changed`) — the PEERS mirror caches only
  record other people.
* A user you have NOT added renders as a mention only for the people who
  HAVE added them (the receiver's known-users match) — you see plain text.
* Names unknown to this device stay plain text, never a component: an
  unknown @token is not a person record here, and inventing one would fake
  the icon.

Clicking a rendered mention opens that user's **profile sheet** — the sheet
(`openProfileFor`) renders for ANY subject, not just the open chat, from the
same mirrors plus live keys/profile/stats lookups; the chat icon on the right
of the sheet's hero (`profile-id profile-hero`) starts/switches to the
conversation with that user. Links render as `<a>` (https is added for bare
hosts) and open in a new tab; bubble taps that land on a link or a mention
never pop the message modal.

## 4. The composer @-search

Typing `@` at a word boundary opens a popover **above the composer** (the
attach-menu's layer, z-5): the current chat's peer FIRST, then the other
known users (friends mirror, gone accounts excluded) alphabetically,
substring match on what you type, **hard cap 3 rows**. Rows are the same
single-line component. Tap, Enter or Tab inserts `"@username "`; arrows move
the highlight; Escape (or caret leaving the token) closes.

## 5. The composer box

`#chat-input` is a **textarea**: one line at rest (a pill, matching the foot
bar), auto-grows with the typed text up to **5 lines**, then scrolls. While
multi-line the sides go STRAIGHT and only the corners round (the `.multiline`
class — a pill radius on a tall box bows the whole edge). `autosizeComposer`
measures the element's own line-height — the cap lives in one place.
Enter sends, Shift+Enter is a newline (the mention popup owns Enter while it
is open).

## 6. The Links tab

Nothing new on the wire: `tabBuckets` re-scans every text message with the
shared `extractLinks` (now including scheme-less hosts) and the tab lists
them newest-first. The row's `href` carries the normalised https form while
the displayed text stays what the sender typed.
