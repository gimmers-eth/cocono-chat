# Groups — spec, design and phase tracker

Groups are multi-user conversations with **named rooms** inside them, access
controlled by **passes** an admin distributes. They ride the same E2EE
machinery as DMs (per-recipient encryption, store-and-forward) with a group
key layer modelled on WhatsApp: keys rotate whenever membership or passes
change, so a removed/limited user cannot read future room messages, and no
user can read rooms their passes do not cover.

STATUS: **P1 (UI mock) complete — awaiting review.**
Tracker table at the bottom; update it at every phase hand-off.

Related: [../MESSAGES.md](../MESSAGES.md) (DM wire protocol groups reuse) ·
[FRIENDS.md](./FRIENDS.md) (trust ladder rendered inside group messages) ·
[mentions-and-links.md](./mentions-and-links.md) (the composer/rich-text
surfaces group rooms reuse)

---

## 1. Requirements (as specified)

1. Sidebar gets 3 icon tabs ABOVE the username search: single-user chats
   (user icon), groups (users icon), search (search icon — "coming soon").
2. Clicking a tab SLIDES the sidebar content left/right (like the message
   modal's forward carousel). The header and the version foot never slide.
3. Group names are NOT unique app-wide. Anyone can create a group and name
   it anything. An admin (staff) can rename any group. A group's OWN admins
   rename it too (§9).
4. Groups contain ROOMS: individual named chats inside the group.
5. **Passes**: group admins create/edit pass types and give/revoke user
   passes. A pass grants access to specific rooms; example: a family group
   with a `family` pass (family rooms only — great for kids) and an `adult`
   pass (every room). Passes can grant READ-ONLY access to a room. Staff
   admins (the admin panel) can create and DISTRIBUTE group passes.
6. A new group starts with 3 built-in pass types: **Owner / Admin / Member**.
   * Owner: highest access, cannot be removed from the group, sees
     everything. May transfer ownership or relinquish it — but at least one
     owner must always exist, so the LAST owner may only transfer.
   * Admins cannot remove owners; owners see everything (including
     owner-only groups/rooms).
   * Admins see everything except owner-only content.
7. **Encryption**: WhatsApp-style. The group holds per-room key material;
   keys rotate when a user is added, removed, or their passes change. A
   user must never be able to decrypt messages of a room they lack access
   to (no read of history beyond their grant; rotation cuts it off going
   forward).
8. Groups have admin users; owners/admins can promote other members.
9. Admins can: rename the group, add/remove rooms, create/edit pass types,
   give/revoke user passes.
10. A user only sees a group in their list if they hold a pass; rooms
    their passes do not cover are not listed (not even by name) in the
    sidebar.
11. Every group always has a `general` room EVERYONE with any pass can
    see (it may still be read-only via passes).
12. A pass is SENT TO A USER via a chat message from the giving user: the
    message shows the pass details — only what the recipient GETS access
    to; rooms they do not get are never named in the card.
13. Sidebar: groups list like users. Each group row carries a hide/show
    toggle (collapse the rooms) and icons for room members & group
    settings. Rooms can be STARRED by a user; starred rooms stay visible
    under a collapsed group.
14. Pass types & inviting are managed via the group settings. Pass types
    as a list with an edit button per type; users on a separate tab of
    the settings panel.
15. Groups keep the user TAGS feature, and the tag filter bar stays
    pinned while the sidebar slides (and later applies inside search too).
16. Rooms keep the conversation tabs (chat · images · videos · files ·
    links). Media lifecycle is GROUP-MEMBER aware: the server must not
    prune a blob before its retention window OR before every entitled
    member has downloaded it (the DM ack model fans out per member).
17. Messages can be forwarded to a group room — from DMs or other rooms.
18. Sidebar groups show an icon for MY role in that group (owner / admin /
    member).
19. Group messages display the sender's name as the single-line component
    — trust icon + badges, per-SENDER, resolved by the VIEWER's mirrors
    (same rule as mention chips).
20. Users can leave a group (their key material is rotated out).
21. A user may hold MULTIPLE passes on the same group; room access is the
    UNION of their passes and passes can never REDUCE access (a read-only
    pass plus a write pass = write).
22. Admin panel: sees which groups a user is in, plus a Groups page —
    paginated list of all groups and their members.

## 2. Design notes (settled as of P1)

* **Room = the chat unit.** All existing DM machinery (composer, drafts,
  mentions/links, media lifecycle, tabs, notices) attaches to a room;
  group-level UI is just navigation + administration.
* **Identity**: `(groupUl-slug-like-name, roomName)` is NOT key-addressable
  (names aren't unique) — the server mints stable `gid`/`rid` ids; clients
  render names freely. Wire payloads carry ids, never names.
* **Keying sketch (P4)**: per-room group key `GK_r`; members hold GK_r
  copies wrapped via a sender-key/fan-out model (the existing per-device
  pairwise keys do the wrapping). Pass change ⇒ rotate GK_r, rewrap for the
  entitled set only. Read-only members get GK_r for decryption but not the
  signing/HMAC allowance to post — enforcement server-side like DM sends.
* **Pass card**: a sys-style in-chat message (trustworthy because it rides
  the E2EE channel from the giver): `{pass:'adult', rooms:[names the
  recipient GETS]}` — never the withheld room names (req 12).
* **Sidebar mechanics**: the slide is the `#msg-panes` carousel pattern;
  the tab bar, tag filter, header and version foot are OUTSIDE the sliding
  track (req 2, 15).
* **P1/P2 are mocks** (fixed fake data, no store, no network) deliberately:
  the UI is reviewed and settled before any wire format is frozen.

## 3. Phase tracker

| Phase | Scope | State |
|---|---|---|
| **P1** | Sidebar icon tabs + sliding panes + group/room list with roles, stars, hide/show, read-only locks + group ROOM chat UI (sender chips w/ trust + badges, composer, conversation tabs). Fake data (10 groups, mixed roles). FE only, no API. | ✅ **complete — awaiting review** (branch `groups-p1`) |
| **P2** | Group settings example UI: overview, pass types list + editor (read-only view), members tab (promote/revoke shown, not wired), rooms tab. FE only. | ⬜ next |
| **P3** | Admin panel UI example: Groups page (paginated list + members), user-panel groups section, pass create/distribute flow — mock data. | ⬜ |
| **P4** | Backend: collections (groups, rooms, passes, memberships, group key material), wire protocol (rooms fan-out, key rotation, ack-aware media lifecycle), pass cards as sys messages, admin APIs, unit + integration tests. | ⬜ |
| **P5** | Client: replace the mock with real data — group list from the server, room chats through the SDK, key rotation, forwarding to rooms, member-aware media pruning. | ⬜ |
| **P6** | Admin app wired to the real APIs. | ⬜ |

P1 review checklist for the dev box: tab bar slides the sidebar body
(chat/groups/search); group rows show MY role icon (crown/shield/user);
chevron hides/shows rooms; starred rooms stay when collapsed; locked rooms
are read-only; opening a room shows the chat with sender chips (trust icon
+ badge per sender, viewer-side state), conversation tab strip, and a
composer that echoes locally. Settings/members icons are honest stubs
(toasts) until their phases.
