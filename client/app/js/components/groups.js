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
//     toggle, per-room PIN (pinned rooms survive a collapse — req 13; a pin
//     is NOT the 'starred' tag and never shows under that filter),
//     read-only locks (req 11);
//   * a room chat whose messages carry the SENDER as the single-line
//     component — trust icon + worn badge, viewer-side state (req 19);
//   * the conversation tab strip (req 16) and a working echo composer.

import { $, toast, animateSheetClose } from '../ui.js';
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
  stoyce: { state: PS.STRANGER, badge: null },
};

// 10 groups (req: names are NOT unique — suffixes are decoration, not keys).
// role = MY pass level (reqs 6/18). ro = read-only for me (req 11).
// pinned rooms stay visible when the group is collapsed (req 13) — the pin
// is a navigation state, NOT the 'starred' tag (they never mix).
const FAKE_GROUPS = [
  {
    name: 'Mortensen Family', role: 'owner', open: true,
    about: 'The whole tribe: house, holidays, and who is feeding the dog.',
    vis: 'private',
    passes: [
      { name: 'Family', rooms: ['general', 'weekend-house'], ro: ['weekend-house'] },
      { name: 'Adult', rooms: ['general', 'weekend-house', 'adults-only'], ro: [] },
    ],
    members: [
      { ul: 'sofie', pass: 'Adult', admin: true },
      { ul: 'marlene', pass: 'Adult' },
      { ul: 'mads', pass: 'Family' },
      { ul: 'karl', pass: 'Family' },
      { ul: 'stoyce', pass: 'Family' },
    ],
    rooms: [
      { name: 'general', pinned: true, tags: ['starred'], msgs: [
        { from: 'sofie', text: 'Sunday dinner at ours? @marlene bring the guitar!', t: '09:12' },
        { from: 'marlene', text: 'Always. I found a new example.com/jambook to work through.', t: '09:20' },
        { from: 'mads', text: 'Can I bring the kids? No homework room this weekend.', t: '09:31' },
        // BLOCKED-SENDER EXAMPLE (docs scope): a user the VIEWER blocked,
        // but we share this group — the message still arrives, rendered
        // RED ITALIC (never hidden: the group is their room too).
        { from: 'stoyce', text: 'Someone left bins by the gate again — was it you?', t: '09:47', blocked: true },
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
    about: 'Product crew for Aurora — deploys, designs, and the coffee log.',
    vis: 'link',
    members: [
      { ul: 'jens', pass: 'Member', admin: true },
      { ul: 'karl', pass: 'Member' },
      { ul: 'ida', pass: 'Member' },
      { ul: 'mads', pass: 'Member' },
    ],
    rooms: [
      { name: 'general', pinned: true, tags: ['work', 'starred'], msgs: [
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
    about: 'Trailheads, routes, and boot recommendations.', vis: 'searchable',
    rooms: [
      { name: 'general', msgs: [
        { from: 'petter', text: 'See you all at the trailhead 7am…', t: 'June' },
        { from: 'sofie', text: 'RIP the boots I ruined for that ridge photo.', t: '06:45' },
      ] },
      { name: 'gear-talk', pinned: true, tags: ['personal'], msgs: [
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
    { name: 'general', pinned: true, tags: ['personal'], msgs: [{ from: 'petter', text: 'Blue Note reissue pressing question…', t: 'May' }] },
    { name: 'marketplace', msgs: [{ from: 'sofie', text: 'Selling my duplicate Kind of Blue — DM me.', t: 'Sun' }] },
  ] },
  { name: 'Ghibli Fans', role: 'member', rooms: [
    { name: 'general', msgs: [{ from: 'ida', text: 'Marshi watch-along Saturday, bring snacks.', t: '8:14' }] },
  ] },
  { name: 'Night-Shift Nurses', role: 'admin',
    about: 'Ward 4 night crew. Handover is read-only for students.', vis: 'link',
    passes: [{ name: 'Student', rooms: ['general'], ro: ['handover'] }],
    members: [
      { ul: 'mads', pass: 'Member', admin: true },
      { ul: 'karl', pass: 'Student' },
      { ul: 'sofie', pass: 'Student' },
    ], rooms: [
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

const VIS_LABEL = { searchable: 'Publicly searchable', link: 'Invite link only', private: 'Private' };

// built-ins EVERY group carries (req 6): Owner / Admin / Member. Custom
// passes ride the fixture's `passes` list; groups without explicit rosters
// derive members from their senders (all plain Members).
function passesFor(g) {
  return [
    { name: 'Owner', builtin: true },
    { name: 'Admin', builtin: true },
    { name: 'Member', builtin: true, rooms: g.rooms.map((r) => r.name) },
    ...(g.passes ?? []),
  ];
}
function membersFor(g) {
  const me = String(clientRef?.username ?? 'me').toLowerCase();
  const own = { ul: me, pass: ROLE_PASS[g.role], me: true };
  const list = g.members ?? [...new Set(g.rooms.flatMap((r) => (r.msgs ?? []).map((m) => m.from)))]
    .filter((u) => u !== me)
    .map((ul) => ({ ul, pass: 'Member' }));
  return [own, ...list];
}
const ROLE_PASS = { owner: 'Owner', admin: 'Admin', member: 'Member' };
let clientRef = null;

const ROLE_ICON = { owner: ['crown', 'You are an OWNER of this group'], admin: ['groupAdmin', 'You are an ADMIN of this group'], member: ['groupMember', 'You are a MEMBER of this group'] };

// The single-line component for a fake sender lives in appendMessage:
// trust icon + name + worn badge (+ red identity mark where the fixture
// wears one) — req 19.

const stub = (what) => toast(`${what} arrives with the group API (P4/P5).`);

// ---------------------------------------------------------------- the sheet
// One right-slide sheet for EVERYTHING that opens 'like the settings drawer'
// (create group, discover, members lists): same .side-menu skin (in/out
// animations and scrim included), content swapped per call. P2 replaces the
// placeholders with the real settings panel on this same rail.
let sheet = null;
let sheetOverlay = null;
let sheetTitle = null;
let sheetBody = null;
let sheetIsOpen = false;

function ensureSheet() {
  if (sheet) return;
  sheetOverlay = el('div', 'overlay group-sheet-overlay');
  sheetOverlay.hidden = true;
  sheet = el('aside', 'side-menu group-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.hidden = true;
  sheet.tabIndex = -1;
  const head = el('header', 'drawer-head');
  sheetTitle = el('h2');
  const x = el('button', 'icon-btn');
  x.type = 'button';
  x.title = 'Close';
  x.append(iconEl('close'));
  x.addEventListener('click', closeSheet);
  head.append(sheetTitle, x);
  sheetBody = el('div', 'drawer-body group-sheet-body');
  sheet.append(head, sheetBody);
  sheetOverlay.addEventListener('click', closeSheet);
  document.body.append(sheetOverlay, sheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetIsOpen) closeSheet();
  });
}

function openSheet(title, kids) {
  ensureSheet();
  sheetTitle.textContent = title;
  sheetBody.replaceChildren(...kids);
  sheet.classList.remove('closing');
  sheetOverlay.classList.remove('closing');
  sheetIsOpen = true;
  sheetOverlay.hidden = false;
  sheet.hidden = false;
  sheet.focus?.();
}

function closeSheet() {
  if (!sheet || !sheetIsOpen) return;
  sheetIsOpen = false; // the FLAG is the truth; the sheet paints out (P1 review)
  animateSheetClose(sheet, sheetOverlay, { reopenCheck: () => sheetIsOpen });
}

const sheetField = (label, ...kids) => {
  const sec = el('div', 'sheet-field');
  sec.append(el('h3', 'sheet-field-label', label), ...kids);
  return sec;
};
const note = (t) => el('p', 'muted small', t);

function openCreateSheet() {
  const name = el('input');
  name.type = 'text';
  name.placeholder = 'Group name';
  name.maxLength = 64;
  const desc = el('textarea');
  desc.rows = 3;
  desc.placeholder = 'What is this group about?';
  const vis = el('div', 'sheet-vis');
  for (const [v, label] of [
    ['private', 'Private — visible only to members'],
    ['link', 'Public invite link only — found by the link'],
    ['searchable', 'Publicly searchable — anyone can find it'],
  ]) {
    const r = el('input');
    r.type = 'radio';
    r.name = 'grp-vis';
    r.value = v;
    // NEW GROUPS DEFAULT TO PRIVATE (P2 review): openness must be chosen
    r.checked = v === 'private';
    const row = el('label', 'vis-row');
    row.append(r, el('span', null, label));
    vis.append(row);
  }
  const btn = el('button', 'btn btn-accent sheet-go');
  btn.type = 'button';
  btn.textContent = 'Create group';
  btn.addEventListener('click', () => toast('Creating groups lands with the API (P4/P5) — this is the P1 placeholder'));
  openSheet('New group', [
    sheetField('Name', name),
    sheetField('Description', desc),
    sheetField('Visibility', vis),
    btn,
    note('Placeholder UI (P1) — fleshed out in P2, wired in P4/P5. New groups start with the Owner / Admin / Member passes and a #general room.'),
  ]);
}

function openDiscoverSheet() {
  const q = el('input');
  q.type = 'text';
  q.placeholder = 'Search public groups…';
  q.className = 'discover-q';
  const list = el('ul', 'member-list discover-list');
  for (const g of [
    { name: 'Run Club', about: 'Tuesday loop, 5k easy, coffee after', members: 12 },
    { name: 'Tool Library', about: 'Borrow the good saw back', members: 6 },
    { name: 'Stargazers', about: 'Dark-sky drives and telescopes', members: 21 },
  ]) {
    const li = el('li', 'member-row discover-row');
    const b = el('button', 'discover-btn');
    b.type = 'button';
    b.append(mountLine(document.createElement('span'), { peer: g.name.toLowerCase().replace(/\W+/g, '-'), state: PS.TRUSTED }),
      el('span', 'discover-meta', `${g.members} members · ${g.about}`));
    b.addEventListener('click', () => toast('Joining a group needs a pass — discover/search is P4/P5'));
    li.append(b);
    list.append(li);
  }
  openSheet('Discover groups', [sheetField('Search', q), list,
    note('Placeholder results (P1) — the real search reads public group listings in P5.')]);
}

function passGrants(ps, roomName) {
  if (ps.builtin && (ps.name === 'Owner' || ps.name === 'Admin')) return 'rw';
  const rooms = ps.rooms ?? [];
  if (!rooms.includes(roomName)) return null;
  return (ps.ro ?? []).includes(roomName) ? 'ro' : 'rw';
}

// ---------- GROUP MEMBERS DRAWER (P2, restructured in review) ----------
// MEMBERS lists the PASSES as sections with their holders UNDER each key
// set, and every section heads its list with an ADD MEMBER button that
// preselects that pass. Who holds what is managed here; passes and
// permissions themselves live in SETTINGS (the gear).
function openMembersDrawer(g) {
  const canManage = g.role === 'owner' || g.role === 'admin';
  const body = [];
  body.push(sheetField('About', el('p', 'gd-about', g.about ?? 'No description yet.')));
  const head = el('div', 'gd-head');
  const vis = el('span', 'gd-vis', VIS_LABEL[g.vis ?? 'private']);
  vis.title = 'Who can find this group — managed in settings';
  const role = el('span', 'gd-role', `You: ${g.role}`);
  role.title = 'Your pass in this group';
  head.append(vis, role);
  body.push(head);
  for (const ps of passesFor(g)) {
    const holders = membersFor(g).filter((m) => m.pass === ps.name);
    const sec = el('div', 'gd-sec');
    sec.append(el('h3', 'sheet-field-label', ps.name));
    if (canManage) {
      const add = el('button', 'btn btn-small gd-add');
      add.type = 'button';
      add.textContent = 'Add member';
      add.title = `Add a person with the ${ps.name} pass`;
      add.addEventListener('click', () => openAddPersonSheet(g, ps.name));
      sec.append(add);
    }
    body.push(sec);
    const list = el('ul', 'member-list gd-members');
    if (!holders.length) list.append(el('li', 'member-row gd-empty', 'No one holds this pass yet.'));
    for (const m of holders) list.append(memberToolRow(g, m, canManage));
    body.push(list);
  }
  body.push(note('Pass types and permissions are managed in the group SETTINGS (gear). Membership writes and key rotation arrive with the API (P4/P5).'));
  openSheet(`${g.name} — members`, body);
}

// ---------- GROUP SETTINGS DRAWER (P2, restructured in review) ----------
// SETTINGS owns the PASSES and PERMISSIONS: who can find the group
// (visibility radios) and the pass-type list with its editor. Members are
// listed and managed in the members drawer.
function openSettingsDrawer(g) {
  const canManage = g.role === 'owner' || g.role === 'admin';
  const body = [];
  body.push(sheetField('About', el('p', 'gd-about', g.about ?? 'No description yet.')));
  const visWrap = el('div', 'sheet-vis');
  for (const [v, label] of [
    ['private', 'Private — visible only to members'],
    ['link', 'Public invite link only — found by the link'],
    ['searchable', 'Publicly searchable — anyone can find it'],
  ]) {
    const r = el('input');
    r.type = 'radio';
    r.name = 'grp-vis-set';
    r.value = v;
    r.checked = (g.vis ?? 'private') === v;
    r.disabled = !canManage;
    r.addEventListener('change', () => {
      g.vis = v;
      toast('Visibility applies with the API (P4/P5) — mock updated');
    });
    const row = el('label', 'vis-row');
    row.append(r, el('span', null, label));
    visWrap.append(row);
  }
  body.push(sheetField('Permissions — who can find this group', visWrap));
  const pSec = el('div', 'gd-sec');
  pSec.append(el('h3', 'sheet-field-label', 'Pass types'));
  body.push(pSec);
  const plist = el('ul', 'member-list gd-passes');
  for (const ps of passesFor(g)) plist.append(passRow(g, ps, canManage));
  body.push(plist);
  body.push(note('Editing a pass rotates its rooms\u2019 keys (P4/P5). Who HOLDS each pass is listed in the members drawer.'));
  openSheet(`${g.name} — settings`, body);
}

function memberToolRow(g, m, canManage) {
  const li = el('li', 'member-row gd-member');
  li.append(mountLine(document.createElement('span'), memberOpts(m.ul)));
  if (m.me) li.append(el('span', 'member-pass', 'you'));
  if (canManage && !m.me) {
    const tools = el('span', 'member-tools');
    const key = el('button', 'member-tool');
    key.type = 'button';
    key.title = 'Give this person a different pass';
    key.append(iconEl('key'));
    key.addEventListener('click', () => openPassPicker(g, m));
    tools.append(key);
    if (g.role === 'owner') {
      const rm = el('button', 'member-tool member-tool-danger');
      rm.type = 'button';
      rm.title = 'Remove from group';
      rm.append(iconEl('userGone'));
      rm.addEventListener('click', () => {
        if (m.pass === 'Owner' && membersFor(g).filter((x) => x.pass === 'Owner').length <= 1) {
          toast('The LAST owner may only TRANSFER ownership — a group is never ownerless');
          return;
        }
        toast('Removing members rotates the room keys (P4/P5) — mock only removes here');
      });
      tools.append(rm);
    }
    li.append(tools);
  }
  return li;
}

function openPassPicker(g, m) {
  const list = el('ul', 'member-list');
  for (const ps of passesFor(g)) {
    const li = el('li', 'member-row');
    const b = el('button', 'discover-btn');
    b.type = 'button';
    b.append(el('span', 'pass-name', ps.name), el('span', 'discover-meta', passAccess(g, ps)));
    b.addEventListener('click', () => {
      m.pass = ps.name;
      toast('Pass changes rotate room keys (P4/P5) — mock updated');
      openMembersDrawer(g);
    });
    li.append(b);
    list.append(li);
  }
  openSheet(`Pass for ${m.ul}`, [list, note('The new pass takes effect immediately; the room keys rotate (req 7). Pass CARDS are delivered in chats (P4/P5).')]);
}

function passAccess(g, ps) {
  if (ps.builtin && (ps.name === 'Owner' || ps.name === 'Admin')) return 'every room · management';
  const rooms = (ps.rooms ?? g.rooms.map((r) => r.name));
  const ro = ps.ro?.length ? ` · read-only: ${ps.ro.join(', ')}` : '';
  return `rooms: ${rooms.join(', ') || 'general'}${ro}`;
}

function passRow(g, ps, canManage) {
  const li = el('li', 'member-row pass-row');
  li.append(el('span', 'pass-name', ps.name));
  if (ps.builtin) {
    const tag = el('span', 'pass-builtin', 'built-in');
    tag.title = 'Every group starts with Owner, Admin and Member';
    li.append(tag);
  }
  li.append(el('span', 'pass-rooms', passAccess(g, ps)));
  if (canManage) {
    const edit = el('button', 'member-tool');
    edit.type = 'button';
    edit.title = ps.builtin ? 'Built-in passes always exist; their room access is shown here' : 'Edit this pass';
    edit.append(iconEl('settings'));
    edit.addEventListener('click', () => openPassEditor(g, ps));
    li.append(edit);
  }
  return li;
}

function openPassEditor(g, ps) {
  const name = el('input');
  name.type = 'text';
  name.value = ps.name;
  name.maxLength = 32;
  name.disabled = !!ps.builtin;
  const rows = el('div', 'pass-rooms-grid');
  const wanted = new Set(ps.rooms ?? g.rooms.map((r) => r.name));
  const wantedRo = new Set(ps.ro ?? []);
  for (const r of g.rooms) {
    const row = el('label', 'pass-room-row');
    const a = el('input');
    a.type = 'checkbox';
    a.checked = wanted.has(r.name);
    a.disabled = !!ps.builtin;
    const o = el('input');
    o.type = 'checkbox';
    o.checked = wantedRo.has(r.name);
    o.disabled = !!ps.builtin;
    o.title = 'Read-only: holders can read, never post';
    row.append(a, el('span', 'pass-room-name', `#${r.name}`), el('span', 'pass-ro-label', 'read only'), o);
    rows.append(row);
  }
  const save = el('button', 'btn btn-accent sheet-go');
  save.type = 'button';
  save.textContent = ps.builtin ? 'Built-in passes are fixed — this is the view' : 'Save pass';
  save.disabled = !!ps.builtin;
  if (!ps.builtin) {
    save.addEventListener('click', () => {
      ps.name = name.value.trim() || ps.name;
      // rows were built in g.rooms ORDER, so positional reads are exact
      ps.rooms = g.rooms.filter((r, i) => [...rows.children][i].querySelector('input').checked).map((r) => r.name);
      ps.ro = g.rooms.filter((r, i) => [...rows.children][i].querySelectorAll('input')[1].checked).map((r) => r.name);
      toast('Saving a pass rotates its rooms\u2019 keys (P4/P5) — mock updated');
      openSettingsDrawer(g);
    });
  }
  openSheet(`${ps.builtin ? 'Pass' : 'Edit pass'}: ${ps.name}`, [
    sheetField('Name', name),
    sheetField('Rooms', rows),
    save,
    note('A room without a checkbox is INVISIBLE to holders (req 10); \u201cread only\u201d blocks posting (reqs 5/11). Access is the UNION of a holder\u2019s passes (req 21).'),
  ]);
}

function openAddPersonSheet(g, defaultPass = 'Member') {
  const user = el('input');
  user.type = 'text';
  user.placeholder = 'username';
  user.maxLength = 64;
  const go = el('button', 'btn btn-accent sheet-go');
  go.type = 'button';
  go.textContent = 'Give a pass';
  go.addEventListener('click', () => toast('Adding a person sends them a pass CARD in chat and rotates the keys (P4/P5)'));
  const wrap = el('div', 'sheet-vis');
  for (const ps of passesFor(g)) {
    const r = el('input');
    r.type = 'radio';
    r.name = 'pass-pick';
    r.checked = ps.name === defaultPass; // the section's pass arrives PRESELECTED
    const row = el('label', 'vis-row');
    row.append(r, el('span', null, `${ps.name} — ${passAccess(g, ps)}`));
    wrap.append(row);
  }
  openSheet(`Add member — ${defaultPass} pass`, [
    sheetField('Username', user),
    sheetField('Pass', wrap),
    go,
    note('The recipient sees ONLY what the pass grants — withheld rooms are never named (req 12).'),
  ]);
}

// ---------- ROOM MEMBERS (room header) ----------
// ONLY the people whose passes reach THIS room are listed (req 10); those
// whose pass marks the room read-only carry the marker.
function openRoomMembers(g, r) {
  const ul = el('ul', 'member-list');
  let n = 0;
  for (const m of membersFor(g)) {
    const ps = passesFor(g).find((x) => x.name === m.pass);
    const grant = ps ? passGrants(ps, r.name) : null;
    if (!grant) continue;
    n += 1;
    const li = el('li', 'member-row gd-member');
    li.append(mountLine(document.createElement('span'), memberOpts(m.ul)));
    if (grant === 'ro') {
      const ro = el('span', 'member-ro', 'read only');
      ro.title = 'Their pass reads this room but cannot post';
      li.append(ro);
    }
    ul.append(li);
  }
  if (!n) ul.append(el('li', 'member-row gd-empty', 'No one else\u2019s pass reaches this room yet.'));
  openSheet(`${g.name} — room members`, [
    el('p', 'gd-roomline', `#${r.name}`),
    ul,
    note('Only people whose passes reach this room are listed (req 10). Passes are managed in the group settings.'),
  ]);
}

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
  // CREATE + DISCOVER ride the bottom of the groups pane, pinned ABOVE the
  // tag filter (P1 review). Placeholders today; P2 fleshes create out, P4/P5
  // wire them.
  const gbar = el('div', 'group-actions');
  const act = (iconKey, label, title, fn) => {
    const b = el('button', 'group-action-btn');
    b.type = 'button';
    b.title = title;
    b.append(iconEl(iconKey), el('span', null, label));
    b.addEventListener('click', fn);
    return b;
  };
  gbar.append(
    act('grpCreate', 'Create', 'Create a new group', openCreateSheet),
    act('grpDiscover', 'Discover', 'Discover public groups', openDiscoverSheet),
  );
  p1.append(listHost, gbar);
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
// two panes can never disagree. 'starred' matches the TAG only — a PIN is
// navigation, not a tag (P1 review).
function roomMatches(r) {
  const f = currentFilter();
  if (f === 'all') return true;
  if (f === 'starred') return (r.tags ?? []).includes('starred');
  return (r.tags ?? []).includes(f);
}

function renderGroups() {
  listHost.replaceChildren();
  for (const g of FAKE_GROUPS) {
    if (!g.rooms.some(roomMatches)) continue; // filtered out entirely
    const li = el('li', 'group-item');
    li.classList.toggle('collapsed', !g.open);
    li.append(groupRow(g));
    const rooms = el('ul', 'room-list');
    rooms.classList.toggle('closed', !g.open);
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
  // collapsed groups carry ONE number: everything unread that the row is
  // NOT showing (pinned rooms keep their own pills, so the two numbers
  // never double-count the same message)
  let grpPill = null;
  if (!g.open) {
    const hidden = g.rooms.filter((r) => !r.pinned).reduce((n, r) => n + (r.unread ?? 0), 0);
    if (hidden > 0) {
      grpPill = el('span', 'grp-unread', String(hidden));
      grpPill.title = `${hidden} unread in the collapsed rooms`;
    }
  }
  const nameBtn = el('button', 'grp-name');
  nameBtn.type = 'button';
  nameBtn.textContent = g.name;
  nameBtn.title = g.open ? `Collapse ${g.name}` : `Expand ${g.name}`;
  const members = el('button', 'grp-btn');
  members.type = 'button';
  members.title = 'Group members';
  members.append(iconEl('users'));
  const settings = el('button', 'grp-btn');
  settings.type = 'button';
  settings.title = 'Group settings';
  settings.append(iconEl('settings'));
  row.append(chev, role, ...(grpPill ? [grpPill] : []), nameBtn, members, settings);

  // The name TOGGLES the group like the chevron — opening a room happens
  // on the ROOM rows, never on the group itself (P1 review feedback).
  // MY role icon LEADS the row: crown owner / shield admin / user member.
  // A full re-render keeps the collapsed unread SUM and the cards'
  // collapsed classes in step with g.open — no half-updated row states
  const toggle = () => { g.open = !g.open; renderGroups(); };
  chev.addEventListener('click', toggle);
  nameBtn.addEventListener('click', toggle);
  // (P1 review) the SIDEBAR's roster control is the GROUP's people —
  // labelled 'Group members'; the ROOM's members live in the room header
  members.addEventListener('click', () => openMembersDrawer(g));
  settings.addEventListener('click', () => openSettingsDrawer(g)); // settings owns passes & permissions (P2 review)
  return row;
}

function memberOpts(who) {
  const p = PEOPLE[who] ?? { state: PS.STRANGER };
  const chip = nameChipEl(p.badge ?? null);
  if (chip) chip.classList.add('name-chip-inline');
  return {
    peer: who, state: p.state, chipEl: chip,
    unverified: p.unverified ?? null, gone: p.state === PS.GONE,
  };
}

function paintRooms(li, host, g) {
  host.replaceChildren();
  // collapsed: only STARRED rooms stay (req 13); the tag filter narrows
  // every state further (req 15)
  for (const r of g.rooms) {
    if (!roomMatches(r)) continue;
    if (!g.open && !r.pinned) continue;
    const rr = el('li', 'room-row');
    const pin = el('button', `room-pin${r.pinned ? ' pin-on' : ''}`);
    pin.type = 'button';
    pin.title = r.pinned
      ? 'Un-pin room — it collapses with the group again'
      : 'Pin room — it stays open when the group is collapsed (a pin is NOT the starred tag)';
    pin.append(iconEl(r.pinned ? 'pin' : 'pinSlash'));
    pin.addEventListener('click', () => { r.pinned = !r.pinned; renderGroups(); });
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
    // TOGGLE (P1 review): clicking the room that is already open closes it
    // — same gesture the desktop user expects when a room overlays a chat
    open.addEventListener('click', () => {
      if (activeCtx && activeCtx.r === r && view && !view.hidden) closeRoom(); // a dismissal RIDES (instant is for switches)
      else openRoom(g, r);
    });
    // mute/unmute (the DM tagbar speaker's sibling): a quiet grey glyph
    // that turns red while MUTED — same alarm rule as #btn-chat-mute
    const mute = el('button', `room-star room-mute${r.muted ? ' muted-on' : ''}`);
    mute.type = 'button';
    mute.title = r.muted ? `Unmute #${r.name}` : `Mute #${r.name} (mock — alerts hush, the room stays listed)`;
    mute.append(iconEl(r.muted ? 'volumeXmark' : 'volume'));
    mute.addEventListener('click', () => {
      r.muted = !r.muted;
      renderGroups();
      paintHeadMute(); // the open room's tag strip mirrors the state
    });
    rr.append(pin, open, mute);
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
  headMuteBtn = el('button', 'icon-btn tagbar-mute group-head-mute');
  headMuteBtn.type = 'button';
  headMuteBtn.hidden = true;
  headMuteBtn.addEventListener('click', () => {
    if (!activeCtx) return;
    activeCtx.r.muted = !activeCtx.r.muted;
    paintHeadMute();
    renderGroups(); // the sidebar row mirrors it
  });
  // ROOM members, right edge of the header (P1 review) — the sheet animates
  // like the settings drawer
  const headMembers = el('button', 'icon-btn group-head-members');
  headMembers.type = 'button';
  headMembers.title = 'Room members';
  headMembers.append(iconEl('users'));
  headMembers.addEventListener('click', () => {
    if (!activeCtx) return;
    openRoomMembers(activeCtx.g, activeCtx.r);
  });
  head.append(headMembers);
  // (no 'Mock data' strip: it was noise over the UI under review — the
  // fixtures are documented here and in docs/features/groups.md)
  view.append(head);

  // EVERY GROUP CHAT CARRIES ITS TAGS (P1 review): the DM tag strip's own
  // skin (.chat-tagbar/.tag-btn) under the header — tapping toggles the
  // room's tag, which the pinned sidebar filter matches on live.
  tagbar = el('div', 'chat-tagbar group-tagbar');
  tagbar.hidden = true;
  tagbar.setAttribute('role', 'group');
  tagbar.setAttribute('aria-label', 'Room tags');
  tagIcons = el('span', 'tagbar-icons');
  // the mute lives IN the tag area (P1 review) — exactly where the DM chat
  // head carries #btn-chat-mute: icons left, speaker pushed right
  tagbar.append(tagIcons, headMuteBtn);
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
  if (m.blocked) {
    li.classList.add('msg-blocked');
    body.title = 'You blocked this user — group messages from them are still delivered (docs scope note)';
  }
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
  // Mobile: the class alone rides the pane in FROM THE RIGHT (the menu
  // recedes left) — the .entering hop below is desktop chrome (CSS disables
  // it on phones).
  playEnter(view);
  bubble(r.msgs ?? []);
}

function closeRoom(opts = {}) {
  activeCtx = null;
  // the tag strip is NOT repainted here: it belongs to the pane and rides
  // out WITH it. Hiding it eagerly made the tags visibly vanish a beat
  // before the room itself left (P1 review). Re-opening repaints.
  // MOBILE CAROUSEL EXIT: dropping group-open IS the ride — the pane
  // travels back out to the right and the menu returns from the left
  // (CSS visibility delay keeps it painted for the trip; only the hidden
  // flip waits for the transition to end)
  if (!reducedMotion() && window.matchMedia?.('(max-width: 899px)').matches && !view.hidden) {
    document.body.classList.remove('group-open');
    setTimeout(() => { view.hidden = true; }, 300);
    return;
  }
  if (opts.instant || reducedMotion() || view.hidden) {
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
  clientRef = client;
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
    // Switching room -> user chat must FEEL like a chat swap: the room
    // vanishes at once (no exit ride under the arriving chat) exactly like
    // switching from one user chat to another
    if (document.body.classList.contains('chat-open') && view && !view.hidden) closeRoom({ instant: true });
  }).observe(document.body, { attributeFilter: ['class'] });
  // main.js calls this whenever the DM list repaints (open/read/send), so
  // the chats-tab number tracks the same truth the rows dot from
  return { updateTabBadges, render: renderGroups };
}
