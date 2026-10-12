# Mentions & Links — the composer's rich text

What typing `@` in the chat composer does, how names and URLs render in the
transcript, and the rules the RECEIVER applies to text it did not write.
All of it is CLIENT-side: the wire format stays a plain encrypted string; the
server never learns that a message mentions anybody.

Related: [../FRIENDS.md](../FRIENDS.md) (the trust ladder a mention renders) ·
[../MESSAGES.md](../MESSAGES.md) (delivery of the plain text) ·
[images-and-files.md](./images-and-files.md) (the conversation tabs)

## 1. The wire format

A mention is **plain text**: the composer inserts `"@username "` — an ASCII
username (server rules, 4–64 chars) glued to a space, normally after a space
of its own. Nothing else; no markup, no metadata, no new frame kind. The
receiver re-detects it at render time.

## 2. One parser: `js/rich.js` (pure)

`splitRich(text, isKnown)` scans mentions, `http(s)://` URLs and **bare
hosts** (`example.com/x` — a scheme is NOT required; a KNOWN-TLD allowlist
keeps `photo.jpg`, `v1.2` and `e.g.` out of the links) into ordered runs.
`extractLinks` is the same scanner filtered to links — `media.js` re-exports
it, so the Links tab and the bubble painter can never disagree about what a
link is. `mentionCandidates` orders the @-search. All pure: the suite pins
the rules in `client/test/rich.test.js`.

## 3. Rendering: what a NAME means is the viewer's business

Both sides render a mention through the **single-line user component**
(`components/userline.js` mountLine): trust icon + name + worn badge — with
the trust state resolved from **this device's** mirrors. The sender sees
their ladder for that user, the receiver sees theirs. Consequences:

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

`#chat-input` is a **textarea**: one line at rest, auto-grows with the typed
text up to **5 lines**, then scrolls (`autosizeComposer` measures the
element's own line-height — the cap lives in one place). Enter sends,
Shift+Enter is a newline (the mention popup owns Enter while it is open).

## 6. The Links tab

Nothing new on the wire: `tabBuckets` re-scans every text message with the
shared `extractLinks` (now including scheme-less hosts) and the tab lists
them newest-first. The row's `href` carries the normalised https form while
the displayed text stays what the sender typed.
