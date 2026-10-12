// GROUPS — P1 UI MOCK (docs/features/groups.md). NO store, NO network: one
// fixed fake dataset renders the sidebar tabs + group/room list + the room
// chat, so the UI can be reviewed and settled BEFORE the wire format exists
// (P4 builds the API, P5 swaps FAKE_GROUPS for server data behind these
// same render functions). Every affordance that needs the API toasts its
// phase honestly — nothing here pretends to be live.
//
// What the mock MUST show (review checklist lives in the doc):
//   * 3 sidebar tabs above the username search; the sidebar BODY slides
//     (header + filter bar + version foot never move — reqs 2 & 15);
//   * group rows with MY role icon (req 18), rooms under them, hide/show
//     toggle, per-room star (starred rooms survive a collapse — req 13),
//     read-only locks (req 11);
//   * a room chat whose messages carry the SENDER as the single-line
//     component — trust icon + worn badge, viewer-side state (req 19);
//   * the conversation tab strip (req 16) and a working echo composer.

import { $, toast } from '../ui.js';
import { iconEl } from '../icons.js';
import { mountLine } from './userline.js';
import { PS } from './peername.js';
import { nameChipEl } from '../badges.js';
import { tagIconEl, TAG_LABELS, TAG_IDS, currentFilter } from '../tags.js';
import { allMessages, isUnread } from '../store.js';

// ---------------------------------------------------------------- fixtures

// How fake people render for the VIEWER (req 19): state = this device's
// ladder position, badge = the chip they wear, gone = deleted account. The
// mix covers every rung so the icons can be reviewed in one screen.
const PEOPLE = {
  sofie: { state: PS.TRUSTED, badge: null },
  mads: { state: PS.VERIFIED, badge: 'mail' },
  karl: { state: PS.UNVERIFIED, badge: null, unverified: true },
  jens: { state: PS.STRANGER, badge: null },
  marlene: { state: PS.TRUSTED, badge: 'premium' },
  petter: { state: PS.GONE, badge: null },
  ida: { state: PS.TRUSTED, badge: 'og' },
};

// 10 groups (req: names are NOT unique — suffixes are decoration, not keys).
// role = MY pass level (reqs 6/18). ro = read-only for me (req 11).
// starred rooms stay visible when the group is collapsed (req 13).
const FAKE_GROUPS = [
  {
    name: 'Mortensen Family', role: 'owner', open: true,
    rooms: [
      { name: 'general', starred: true, msgs: [
        { from: 'sofie', text: 'Sunday dinner at ours? @marlene bring the guitar!', t: '09:12' },
        { from: 'marlene', text: 'Always. I found a new example.com/jambook to work through.', t: '09:20' },
        { from: 'mads', text: 'Can I bring the kids? No homework room this weekend.', t: '09:31' },
      ] },
      { name: 'weekend-house', unread: 2, tags: ['family'], msgs: [
        { from: 'ida', text: 'The roof patch held through the storm. Firewood stacked.', t: '08:02' },
        { from: 'karl', text: 'Taking the dog up Saturday — anyone around?', t: '08:40' },
      ] },
      { name: 'adults-only', ro: true, tags: ['family'], msgs: [
        { from: 'sofie', text: 'Gift list for mom’s 70th — kids, you cannot see this room. (This is the pass demo.)', t: 'Yest' },
      ] },
    ],
  },
  {
    name: 'Team Aurora', role: 'admin', open: true,
    rooms: [
      { name: 'general', starred: true, tags: ['work'], msgs: [
        { from: 'jens', text: 'Deploy window moved to Thursday. @karl owns the runbook.', t: '10:15' },
        { from: 'karl', text: 'Acknowledged. Staging is green: aurora.example.com/status', t: '10:22' },
      ] },
      { name: 'design', tags: ['work'], msgs: [
        { from: 'ida', text: 'New spacing scale is in the mock — one rhythm, every surface.', t: 'Mon' },
      ] },
      { name: 'ops-alerts', ro: true, unread: 5, tags: ['work'], msgs: [
        { from: 'mads', text: 'CPU spike on node-3, self-healed. Journal clean.', t: '07:55' },
      ] },
    ],
  },
  {
    name: 'Hikers Trail', role: 'member',
    rooms: [
      { name: 'general', msgs: [
        { from: 'petter', text: 'See you all at the trailhead 7am…', t: 'June' },
        { from: 'sofie', text: 'RIP the boots I ruined for that ridge photo.', t: '06:45' },
      ] },
      { name: 'gear-talk', starred: true, tags: ['personal'], msgs: [
        { from: 'mads', text: 'The new ultralight tent is example.com/tent-x — worth it.', t: 'Tues' },
      ] },
    ],
  },
  { name: 'Chess Club', role: 'member', rooms: [
    { name: 'general', msgs: [{ from: 'jens', text: 'Thursday blitz cancelled — hall booked for the exam.', t: 'Wed' }] },
    { name: 'tournament', ro: true, msgs: [{ from: 'ida', text: 'Pairings are up. Read-only for non-players (pass demo).', t: 'Yest' }] },
  ] },
  { name: 'Block Watch', role: 'admin', rooms: [
    { name: 'general', msgs: [{ from: 'karl', text: 'Gate code reminder: it changed Monday, see the notice board.', t: '17:03' }] },
    { name: 'alerts', ro: true, unread: 1, tags: ['personal'], msgs: [{ from: 'marlene', text: 'Tool van on Birch St — logged, no action needed.', t: '21:41' }] },
  ] },
  { name: 'Old Jazz Vinyl', role: 'member', rooms: [
    { name: 'general', starred: true, msgs: [{ from: 'petter', text: 'Blue Note reissue pressing question…', t: 'May' }] },
    { name: 'marketplace', msgs: [{ from: 'sofie', text: 'Selling my duplicate Kind of Blue — DM me.', t: 'Sun' }] },
  ] },
  { name: 'Ghibli Fans', role: 'member', rooms: [
    { name: 'general', msgs: [{ from: 'ida', text: 'Marshi watch-along Saturday, bring snacks.', t: '8:14' }] },
  ] },
  { name: 'Night-Shift Nurses', role: 'admin', rooms: [
    { name: 'general', msgs: [{ from: 'mads', text: 'Ward 4 short-staffed tomorrow — anyone swap?', t: '23:50' }] },
    { name: 'handover', ro: true, unread: 3, tags: ['work'], msgs: [{ from: 'karl', text: 'Handover log template updated. Read-only for students.', t: '22:07' }] },
  ] },
  { name: 'Code Guild', role: 'owner', rooms: [
    { name: 'general', msgs: [{ from: 'jens', text: 'Monthly challenge: build a GC. Submissions due the 28th.', t: '09:00' }] },
    { name: 'code-review', ro: true, msgs: [{ from: 'sofie', text: 'PR #412 needs eyes — diff only here (pass demo).', t: '13:31' }] },
  ] },
  { name: 'Weekend Woodworkers', role: 'member', rooms: [
    { name: 'general', msgs: [{ from: 'marlene', text: 'Dovetail jig finally behaves. Photo proof in the drive.', t: '11:20' }] },
    { name: 'show-and-tell', ro: true, msgs: [{ from: 'ida', text: 'Q3 show pieces thread — post finished work only.', t: 'Yest' }] },
  ] },
];

// ---------------------------------------------------------------- helpers

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const ROLE_ICON = { owner: ['crown', 'You are an OWNER of this group'], admin: ['groupAdmin', 'You are an ADMIN of this group'], member: ['groupMember', 'You are a MEMBER of this group'] };

// The single-line component for a fake sender lives in appendMessage:
// trust icon + name + worn badge (+ red identity mark where the fixture
// wears one) — req 19.

const stub = (what) => toast(`${what} arrives with the group API (P4/P5).`);

// ---------------------------------------------------------------- sidebar

let track = null;
let listHost = null; // #group-list
let chatBadge = null; // unread messages behind the chats tab
let groupBadge = null; // unread mock rooms behind the groups tab
const TABS = ['chats', 'groups', 'search'];

// The tab bar shows the NUMBER OF UNREAD MESSAGES waiting behind each
// tab — the chats tab counts real DM unreads from the local store (every
// 'in' message past the read marker, exactly what dots the sidebar rows),
// the groups tab sums the mock rooms' unread fixtures. 0 shows as '0':
// a silent tab says so, it is not missing.
async function updateTabBadges() {
  let chats = 0;
  try {
    for (const m of await allMessages()) {
      if (m.dir === 'in' && isUnread(m.peer, m.ts)) chats += 1;
    }
  } catch { /* store not open (boot/offline): the count reads 0 */ }
  let rooms = 0;
  for (const g of FAKE_GROUPS) for (const r of g.rooms) rooms += r.unread ?? 0;
  if (chatBadge) chatBadge.textContent = String(chats);
  if (groupBadge) groupBadge.textContent = String(rooms);
}

function buildTabBar(sidebar, anchorAfter) {
  const nav = el('nav', 'side-tabs');
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', 'Chat list');
  const labels = { chats: ['userSolid', 'Chats', 'Single-user chats'], groups: ['users', 'Groups', 'Group rooms'], search: ['tabSearch', 'Search', 'Search — coming soon'] };
  for (const [i, key] of TABS.entries()) {
    const [icon, label, title] = labels[key];
    const b = el('button', `side-tab${i === 0 ? ' active' : ''}`);
    b.type = 'button';
    b.dataset.tab = key;
    b.title = title;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === 0));
    b.append(iconEl(icon), el('span', 'side-tab-label', label));
    b.append(iconEl(icon), el('span', 'side-tab-label', label));
    if (key === 'chats' || key === 'groups') {
      const badge = el('span', 'tab-badge', '0');
      badge.title = key === 'chats' ? 'Unread messages in your chats' : 'Unread messages in your group rooms';
      b.append(badge);
      if (key === 'chats') chatBadge = badge;
      else groupBadge = badge;
    }
    b.addEventListener('click', () => setTab(i));
    nav.append(b);
  }
  anchorAfter.after(nav);
  return nav;
}

function setTab(i) {
  const side = document.querySelector('.sidebar');
  side.querySelectorAll('.side-tab').forEach((b, k) => {
    b.classList.toggle('active', k === i);
    b.setAttribute('aria-selected', String(k === i));
  });
  track.style.transform = `translateX(${-i * (100 / TABS.length)}%)`;
}

// The slider: EXISTING sidebar nodes (username search, status, convo list)
// move into pane 0 untouched — ids/refs keep working. The tab bar, the tag
// filter, the install nudge and the version foot NEVER slide (reqs 2 & 15).
function buildPanes(sidebar) {
  const head = sidebar.querySelector('.side-head');
  const newChat = sidebar.querySelector('.new-chat');
  const status = $('home-status');
  const wrap = sidebar.querySelector('.convo-wrap');

  buildTabBar(sidebar, head);

  track = el('div', 'side-pane-track');
  const panes = el('div', 'side-panes');

  const p0 = el('div', 'side-pane pane-chats');
  p0.append(newChat, status, wrap);
  const p1 = el('div', 'side-pane pane-groups');
  listHost = el('ul', 'group-list');
  listHost.id = 'group-list';
  p1.append(listHost);
  const p2 = el('div', 'side-pane pane-search');
  const note = el('p', 'search-soon', 'Search — coming soon. It will find users, groups and messages, with the tag filter already pinned under the sliders.');
  p2.append(note);

  track.append(p0, p1, p2);
  panes.append(track);
  track.style.width = `${TABS.length * 100}%`;
  for (const p of [p0, p1, p2]) p.style.width = `${100 / TABS.length}%`;
  const tabs = sidebar.querySelector('.side-tabs');
  tabs.after(panes);
}

// The pinned sidebar tag filter drives the group list too (req 15) — the
// SAME shared state the DM list filters by (tags.js currentFilter), so the
// two panes can never disagree. 'starred' rides the room star itself.
function roomMatches(r) {
  const f = currentFilter();
  if (f === 'all') return true;
  if (f === 'starred') return !!r.starred;
  return (r.tags ?? []).includes(f);
}

function renderGroups() {
  listHost.replaceChildren();
  for (const g of FAKE_GROUPS) {
    if (!g.rooms.some(roomMatches)) continue; // filtered out entirely
    const li = el('li', 'group-item');
    li.append(groupRow(g));
    const rooms = el('ul', 'room-list');
    li.append(rooms);
    // paintRooms owns host.hidden: a COLLAPSED group still shows its
    // STARRED rooms (req 13 — the hidden flag and the star filter must
    // never disagree, which is exactly how starring looked broken)
    paintRooms(li, rooms, g);
    listHost.append(li);
  }
  updateTabBadges(); // room unread fixtures changed (or the store did)
}

function groupRow(g) {
  const row = el('div', 'group-row');
  const chev = el('button', 'grp-btn grp-toggle');
  chev.type = 'button';
  chev.title = g.open ? 'Hide rooms' : 'Show rooms';
  chev.append(iconEl('viewMore', g.open ? 'chev-up' : ''));
  chev.setAttribute('aria-expanded', String(!!g.open));
  const roleMeta = ROLE_ICON[g.role];
  const role = iconEl(roleMeta[0], `grp-role role-${g.role}`);
  role.title = roleMeta[1];
  const nameBtn = el('button', 'grp-name');
  nameBtn.type = 'button';
  nameBtn.textContent = g.name;
  nameBtn.title = g.open ? `Collapse ${g.name}` : `Expand ${g.name}`;
  const members = el('button', 'grp-btn');
  members.type = 'button';
  members.title = 'Room members (P2)';
  members.append(iconEl('users'));
  const settings = el('button', 'grp-btn');
  settings.type = 'button';
  settings.title = 'Group settings (P2)';
  settings.append(iconEl('settings'));
  row.append(chev, role, nameBtn, members, settings);

  // The name TOGGLES the group like the chevron — opening a room happens
  // on the ROOM rows, never on the group itself (P1 review feedback).
  // MY role icon LEADS the row: crown owner / shield admin / user member.
  const toggle = () => {
    g.open = !g.open;
    chev.title = g.open ? 'Hide rooms' : 'Show rooms';
    chev.replaceChildren(iconEl('viewMore', g.open ? 'chev-up' : ''));
    chev.setAttribute('aria-expanded', String(!!g.open));
    nameBtn.title = g.open ? `Collapse ${g.name}` : `Expand ${g.name}`;
    const li = row.closest('.group-item');
    const rooms = li.querySelector('.room-list');
    paintRooms(li, rooms, g); // also decides visibility (stars stay)
  };
  chev.addEventListener('click', toggle);
  nameBtn.addEventListener('click', toggle);
  members.addEventListener('click', () => toast('Room member lists are part of P2 — see docs/features/groups.md'));
  settings.addEventListener('click', () => toast('Group settings are P2 — see docs/features/groups.md'));
  return row;
}

function paintRooms(li, host, g) {
  host.replaceChildren();
  // collapsed: only STARRED rooms stay (req 13); the tag filter narrows
  // every state further (req 15)
  for (const r of g.rooms) {
    if (!roomMatches(r)) continue;
    if (!g.open && !r.starred) continue;
    const rr = el('li', 'room-row');
    const star = el('button', 'room-star');
    star.type = 'button';
    star.title = r.starred ? 'Un-star room' : 'Star room — it stays visible when the group is collapsed';
    star.append(iconEl(r.starred ? 'tagStar' : 'starRegular', r.starred ? 'star-on' : ''));
    star.addEventListener('click', () => { r.starred = !r.starred; paintRooms(li, host, g); });
    const open = el('button', 'room-open');
    open.type = 'button';
    // READ-ONLY rooms carry NO padlock: the name itself shows inside
    // (…) — italic by CSS — and the header spells it out in words
    const nm = el('span', r.ro ? 'room-name ro' : 'room-name', r.ro ? `(#${r.name})` : `#${r.name}`);
    if (r.ro) nm.title = 'Read-only for you with your current passes';
    open.append(nm);
    // the room's OWN tags (req 15) — quiet glyphs, same family as the
    // chat tag strip; they are what the sidebar filter matches on
    for (const t of r.tags ?? []) {
      const ic = tagIconEl(t);
      ic.classList.add('room-tag-ic');
      ic.title = `${TAG_LABELS[t] ?? t} room`;
      open.append(ic);
    }
    if (r.unread) open.append(el('span', 'room-unread', String(r.unread)));
    open.addEventListener('click', () => openRoom(g, r));
    // mute/unmute (the DM tagbar speaker's sibling): a quiet grey glyph
    // that turns red while MUTED — same alarm rule as #btn-chat-mute
    const mute = el('button', `room-star room-mute${r.muted ? ' muted-on' : ''}`);
    mute.type = 'button';
    mute.title = r.muted ? `Unmute #${r.name}` : `Mute #${r.name} (mock — alerts hush, the room stays listed)`;
    mute.append(iconEl(r.muted ? 'volumeXmark' : 'volume'));
    mute.addEventListener('click', () => {
      r.muted = !r.muted;
      paintRooms(li, host, g);
      paintHeadMute(); // the open room's header mirrors the state
    });
    rr.append(star, open, mute);
    host.append(rr);
  }
  // visible whenever anything would render: open rooms OR kept stars
  host.hidden = host.children.length === 0;
}

// ---------------------------------------------------------------- the room chat view

let view = null;
let msgHost = null;
let headName = null;
let headRoom = null;
let headMuteBtn = null;
let tabPanel = null;
let tagbar = null;
let tagIcons = null;
let activeCtx = null; // { g, r } of the open room (header mute mirrors it)
let chatRef = null;   // the DM chat component (mutual-close, see openRoom)
const TAB_NAMES = ['chat', 'images', 'videos', 'files', 'links'];

const reducedMotion = () => !window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches;

// Open hop: class-driven with a forced-reflow restart — the playChatEnter
// mechanism, so SWITCHING rooms (pane already visible) re-animates too.
function playEnter(v) {
  if (reducedMotion()) return;
  v.classList.remove('entering');
  void v.offsetWidth;
  v.classList.add('entering');
  v.addEventListener('animationend', () => v.classList.remove('entering'), { once: true });
}

// The room's OWN tag strip: same TAG_IDS, same .tag-btn skin and purple
// ON state as the DM chat head; edits write straight to the fixture (the
// sidebar list + filter repaint through it).
function paintRoomTags() {
  if (!tagbar) return;
  const r = activeCtx?.r;
  tagbar.hidden = !r;
  if (!r) return;
  const label = el('span', 'tagbar-label', 'Tag:');
  tagIcons.replaceChildren(label, ...TAG_IDS.map((t) => {
    const on = (r.tags ?? []).includes(t);
    const b = el('button', `tag-btn${on ? ' tag-on' : ''}`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? `Remove the ${TAG_LABELS[t]} tag` : `Tag #${r.name} ${TAG_LABELS[t]}`;
    b.append(tagIconEl(t));
    b.addEventListener('click', () => {
      r.tags = on ? (r.tags ?? []).filter((x) => x !== t) : [...(r.tags ?? []), t];
      paintRoomTags();
      renderGroups(); // the sidebar rows + the pinned filter see it immediately
    });
    return b;
  }));
}

function paintHeadMute() {
  if (!headMuteBtn) return;
  const r = activeCtx?.r;
  headMuteBtn.hidden = !r;
  if (!r) return;
  headMuteBtn.classList.toggle('muted-on', !!r.muted);
  headMuteBtn.title = r.muted ? `Unmute #${r.name}` : `Mute #${r.name} (mock — alerts hush, the room stays listed)`;
  headMuteBtn.replaceChildren(iconEl(r.muted ? 'volumeXmark' : 'volume'));
}

function buildGroupView(client) {
  const main = document.querySelector('main.chat-pane');
  view = el('section', 'group-view');
  view.id = 'group-view';
  view.hidden = true;

  const head = el('header', 'group-head');
  const back = el('button', 'icon-btn group-back');
  back.type = 'button';
  back.title = 'Back to chats';
  back.append(iconEl('back'));
  headName = el('span', 'group-head-name');
  headRoom = el('span', 'group-head-room');
  head.append(back, headName, headRoom);
  // the room's speaker, hugging the header's right edge — the DM chat
  // header's mute button in a different dress (same glyphs, same red
  // muted alarm)
  headMuteBtn = el('button', 'icon-btn group-head-mute');
  headMuteBtn.type = 'button';
  headMuteBtn.hidden = true;
  headMuteBtn.addEventListener('click', () => {
    if (!activeCtx) return;
    activeCtx.r.muted = !activeCtx.r.muted;
    paintHeadMute();
    renderGroups(); // the sidebar row mirrors it
  });
  head.append(headMuteBtn);
  const msg = document.createElement('p');
  msg.className = 'group-head-note muted small';
  msg.textContent = 'Mock data — the room list, roles and messages are fixtures (docs/features/groups.md, P1).';
  view.append(head, msg);

  // EVERY GROUP CHAT CARRIES ITS TAGS (P1 review): the DM tag strip's own
  // skin (.chat-tagbar/.tag-btn) under the header — tapping toggles the
  // room's tag, which the pinned sidebar filter matches on live.
  tagbar = el('div', 'chat-tagbar group-tagbar');
  tagbar.hidden = true;
  tagbar.setAttribute('role', 'group');
  tagbar.setAttribute('aria-label', 'Room tags');
  tagIcons = el('span', 'tagbar-icons');
  tagbar.append(tagIcons);
  view.append(tagbar);

  msgHost = el('ul', 'messages group-messages');
  tabPanel = el('div', 'chat-tabpanel group-tabpanel');
  tabPanel.hidden = true;
  view.append(msgHost, tabPanel);

  const foot = el('footer', 'composer');
  const input = el('textarea', 'group-composer-input');
  input.rows = 1;
  input.placeholder = 'Message this room (mock — nothing is sent anywhere)';
  input.maxLength = 4096;
  const send = el('button', 'btn btn-accent round');
  send.type = 'button';
  send.title = 'Send';
  send.append(iconEl('send'));
  foot.append(input, send);
  const doSend = () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    appendMessage({ me: String(client.username ?? 'me').toLowerCase(), text, t: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  };
  send.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  view.append(foot);

  const tabs = el('nav', 'chat-tabs group-tabs');
  tabs.setAttribute('role', 'tablist');
  const iconKeys = { chat: 'tabChat', images: 'tabImages', videos: 'tabVideos', files: 'tabFiles', links: 'tabLinks' };
  for (const [i, name] of TAB_NAMES.entries()) {
    const b = el('button', `chat-tab${i === 0 ? ' active' : ''}`);
    b.type = 'button';
    b.title = name.charAt(0).toUpperCase() + name.slice(1);
    b.append(iconEl(iconKeys[name]));
    b.addEventListener('click', () => {
      [...tabs.children].forEach((x, k) => x.classList.toggle('active', k === i));
      if (name === 'chat') {
        msgHost.hidden = false;
        tabPanel.hidden = true;
      } else {
        msgHost.hidden = true;
        tabPanel.hidden = false;
        // req 16 lives here: the strip is the DM's strip; the media LIFECYCLE
        // (member-aware acks/pruning) is P4/P5 work
        tabPanel.replaceChildren(el('p', 'media-empty', `Room ${name} — the DM tab strip reused for group rooms (member-aware media arrives with the API, P4/P5).`));
      }
    });
    tabs.append(b);
  }
  view.append(tabs);

  back.addEventListener('click', closeRoom);
  main.append(view);
}

function bubble(msgs) {
  msgHost.replaceChildren();
  for (const m of msgs) appendMessage(m);
  msgHost.scrollTop = msgHost.scrollHeight;
}

function appendMessage(m) {
  const li = el('li', `msg ${m.me ? 'out' : 'in'}`);
  const who = m.me ?? m.from;
  const chipRow = el('div', 'gr-sender-row');
  const chipBtn = el('button', 'msg-mention gr-sender');
  chipBtn.type = 'button';
  chipBtn.title = `View ${who}'s profile (live with the API)`;
  if (m.me) {
    chipBtn.append(mountLine(document.createElement('span'), { peer: who, state: PS.SELF }));
  } else {
    const p = PEOPLE[who] ?? { state: PS.STRANGER };
    const chip = nameChipEl(p.badge ?? null);
    if (chip) chip.classList.add('name-chip-inline');
    chipBtn.append(mountLine(document.createElement('span'), {
      peer: who, state: p.state, chipEl: chip, unverified: p.unverified ?? null, gone: p.state === PS.GONE,
    }));
  }
  chipBtn.addEventListener('click', () => stub('Profile sheets from group messages'));
  const body = el('span', 'gr-body', m.text);
  const meta = el('span', 'meta', m.t ?? '');
  li.append(chipRow, body, meta);
  chipRow.append(chipBtn);
  msgHost.append(li);
}

function openRoom(g, r) {
  // MUTUAL CLOSE (P1 review — this is what looked like "duplicated tabs"):
  // a DM stayed open UNDER a room, two panes, two strips. Opening a room
  // closes the user chat exactly like switching to another user chat; the
  // body-class observer below closes the room when a user chat opens.
  if (document.body.classList.contains('chat-open')) chatRef?.closeChat?.();
  r.unread = 0; // the mock marks read on open
  renderGroups();
  activeCtx = { g, r };
  paintRoomTags();
  headName.replaceChildren(iconEl('users', 'gh-ic'), el('span', 'gh-group', g.name));
  headRoom.textContent = `#${r.name}${r.ro ? ' (read only)' : ''}`;
  paintHeadMute();
  msgHost.hidden = false;
  tabPanel.hidden = true;
  view.hidden = false;
  document.body.classList.add('group-open');
  playEnter(view); // the chat pane's slide in/out, settings-matched pacing
  bubble(r.msgs ?? []);
}

function closeRoom() {
  activeCtx = null;
  paintRoomTags(); // hides the room's tag strip with the room
  if (reducedMotion() || view.hidden) {
    view.hidden = true;
    document.body.classList.remove('group-open');
    return;
  }
  // exit hop, then hide — the closeChatPane discipline: body class and
  // hidden flip ONLY when the animation settles (a failsafe timer covers
  // hidden-tab animation stalls)
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    view.hidden = true;
    view.classList.remove('closing');
    document.body.classList.remove('group-open');
  };
  view.addEventListener('animationend', done, { once: true });
  setTimeout(done, 300);
  view.classList.add('closing');
}

// ---------------------------------------------------------------- mount

export function mountGroups({ client, chat = null }) {
  chatRef = chat;
  const sidebar = document.querySelector('.sidebar');
  // idempotent on BOTH evidence — the tab bar itself AND the list host:
  // a double mount can never build a second tab bar
  if (!sidebar || sidebar.querySelector('.side-tabs') || $('group-list')) return { updateTabBadges() {} };
  buildPanes(sidebar);
  renderGroups();
  buildGroupView(client);
  setTab(0);
  // the pinned tag filter also drives the group pane (req 15). home.js's
  // wireFilterBar handler runs FIRST (wired before this mount) and updates
  // the shared state — here we only RE-PAINT from it, so one click filters
  // both panes and the buttons' aria stays exactly as tags.js set it.
  sidebar.querySelector('.convo-filter')?.addEventListener('click', () => renderGroups());
  updateTabBadges();
  // THE REVERSE CLOSE (P1 review): opening a user chat while a room is
  // open shuts the room — watching body's class is how chat-open lands
  // from EVERY path (sidebar row, share link, notification click) without
  // touching home.js or chat.js.
  new MutationObserver(() => {
    if (document.body.classList.contains('chat-open') && view && !view.hidden) closeRoom();
  }).observe(document.body, { attributeFilter: ['class'] });
  // main.js calls this whenever the DM list repaints (open/read/send), so
  // the chats-tab number tracks the same truth the rows dot from
  return { updateTabBadges, render: renderGroups };
}
