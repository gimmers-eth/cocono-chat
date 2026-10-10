// God View (the social graph page) is its own module; everything else in the
// panel lives here. Imports are hoisted, so the graph can use the helpers
// defined below at call time (initGodView is invoked at the bottom).
import { initGodView } from './godview.js';

const $ = (id) => document.getElementById(id);

const tokenInput = $('token');
tokenInput.value = localStorage.getItem('cocono.admin.token') ?? '';
tokenInput.addEventListener('change', () => {
  localStorage.setItem('cocono.admin.token', tokenInput.value.trim());
});

function setStatus(message, kind = '') {
  const el = $('status');
  el.textContent = message ?? '';
  el.className = kind;
}

async function api(path, options = {}) {
  // Fastify rejects an empty body with content-type application/json,
  // so only set the header when there actually is a body.
  const headers = { 'x-admin-token': tokenInput.value.trim(), ...(options.headers ?? {}) };
  if (options.body) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(Array.isArray(data) ? `HTTP ${res.status}` : data.message ?? `HTTP ${res.status}`);
  return data;
}

const fmtDate = (v) => (v ? new Date(v).toLocaleString() : '—');
const fmtAgo = (v) => {
  if (!v) return 'never';
  const sec = Math.max(0, (Date.now() - new Date(v).getTime()) / 1000);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
};
const fmtDuration = (sec) => {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
};
// Remaining TIME of a staff timeout — reads like a countdown, not a
// duration: days first, then h/m. Admin-only data (the users listing carries
// timeoutRemainingSec; app routes never expose the clock).
const fmtRemaining = (sec) => {
  if (!sec || sec <= 0) return 'expired';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};
// ---- STAFF MODERATION (timeout + ban) — server lib/moderation.js ----
// The timeout presets the Reports page and the user panel offer. 36500d is
// the "100 years" permanent-grade mark. The effect summary lives in the
// confirm text — an operator must see what they are about to do before
// clicking.
const TIMEOUT_PRESETS = [[1, '1d'], [7, '7d'], [30, '30d'], [36500, '100y']];
const MOD_TIMEOUT_TEXT = (ul, label, days) => `Timeout @${ul} for ${label}?\n\n`
  + 'The account will ACT LIKE AN UNVERIFIED ONE while the clock runs: '
  + 'every user sees the DANGER icon and the "identified as malicious by '
  + 'CoCoNo staff" warning, it takes -1000 CoCo, and it may only message '
  + 'people who ADDED it (the cold-send gate — no reply-back door either).'
  + (days >= 36500 ? '\n\n100 YEARS ≈ PERMANENT (only clearing it by hand lifts it).' : '');
const MOD_BAN_TEXT = (ul, on) => on
  ? `BAN @${ul}?\n\nThe account can NO LONGER USE the platform (login, API, WS all refused) — every byte of its data stays intact and an unban resumes exactly where it stopped.`
  : `Lift the BAN on @${ul}? The account may use the platform again immediately.`;
// the one PUT both surfaces share (timeoutDays and/or banned)
const moderationPut = (ul, body) => api(`/api/admin/users/${encodeURIComponent(ul)}/moderation`, {
  method: 'PUT', body: JSON.stringify(body),
});
// a timed-out/banned account is a MARKED account everywhere the panel names
// it: the danger chip rides the user list and the reports' Against column
const modChip = (u) => {
  if (!u) return '';
  if (u.banned) return ' <span class="badge mod-danger" title="BANNED by staff — platform use refused, data intact">banned</span>';
  if (u.malicious) return ` <span class="badge mod-danger" title="TIMED OUT by staff — acts unverified, danger icon for everyone">malicious ${esc(fmtRemaining(u.timeoutRemainingSec))}</span>`;
  return '';
};
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// mirrors the client's block-reason enum (ids enforced by the server).
// Glyphs mirror the client's FA choices (message / circle-question /
// warning-triangle); the panel carries no font dependency, so they are
// inline SVG.
const BLOCK_REASON_META = {
  nospeak: { text: 'does not want to speak to them', cls: 'reason-nospeak', icon:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="reason-icon" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.9-.38-4.11-1.05L3 20l1.05-5.39A8.5 8.5 0 1 1 21 11.5Z"/></svg>' },
  unknown: { text: 'does not know them', cls: 'reason-unknown', icon:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="reason-icon" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' },
  scam: { text: 'reports a scam attempt', cls: 'reason-scam', icon:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="reason-icon" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' },
};
// icon + text as one inline-flex chip; unknown ids degrade to the raw id
function reasonChip(id) {
  const m = BLOCK_REASON_META[id];
  if (!m) return `<span class="reason-chip dim" title="this wall predates the reason field — re-block to state one">${esc(id ?? 'no reason stored')}</span>`;
  return `<span class="reason-chip ${m.cls}" title="${esc(m.text)}">${m.icon}${esc(m.text)}</span>`;
}

// Peer TAGS (client/app/js/tags.js mirrors this id set + order). The account
// owner's own private labels — never shown to the tagged party, surfaced
// here only for operator context. The panel carries no font dependency, so
// glyphs are inline SVG mirroring the client's FA picks (star/house/user/
// briefcase). ORDER here is the display order in the relationships cell.
const TAG_META = [
  ['starred', 'Starred', '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18.9 6.1 20.5l1.2-6.5L2.5 9.4 9.1 8.5 12 2.5Z"/>'],
  ['family', 'Family', '<path d="M3 11.5 12 4l9 7.5"/><path d="M6 10.5V20h12v-9.5"/>'],
  ['personal', 'Personal', '<circle cx="12" cy="8" r="3.4"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>'],
  ['work', 'Work', '<rect x="3" y="7.5" width="18" height="12" rx="2"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5"/><path d="M3 13h18"/>'],
];
const TAG_LABEL = Object.fromEntries(TAG_META.map(([id, label]) => [id, label]));
// the row's tags rendered as the full four-icon set: PURPLE when set, grey
// when not — an operator reads the whole label at a glance, both states.
function tagsCell(tags) {
  const on = new Set(tags ?? []);
  return `<span class="tags">${TAG_META.map(([id, label, d]) => `<span class="tag-glyph ${on.has(id) ? 'tag-on' : 'tag-off'}" title="${esc(label)}${on.has(id) ? ' — set by this account' : ' — not tagged'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg></span>`).join('')}</span>`;
}

// THE username component for the admin panel, mirroring the client's
// js/components/userline.js grammar: single line = name + markers with the
// same .3em rhythm; double line = name line over a dim detail line (the
// tables compose it themselves: unameHtml + <br> + .dim).
function unameHtml(ul, { premium = false, title = '' } = {}) {
  return `<span class="uname"${title ? ` title="${esc(title)}"` : ''}><span class="uname-text">@${esc(String(ul ?? '').toLowerCase())}</span>${premium ? ' <span class="badge gold-badge" title="premium">★</span>' : ''}</span>`;
}

function renderLimits(limits) {
  const body = $('limits-body');
  $('limits-empty').hidden = limits.length > 0;
  body.innerHTML = limits
    .map(
      (l) => `<tr>
        <td>${esc(l.name)}</td>
        <td>${esc(l.scope)}</td>
        <td class="mono">${esc(l.subject)}</td>
        <td>${l.count} / ${l.limit}</td>
        <td>${fmtDuration(l.windowSec)}</td>
        <td>${l.ttlSec >= 0 ? fmtDuration(l.ttlSec) : '—'}</td>
        <td><button class="danger tiny" data-clear-key="${esc(l.key)}">clear</button></td>
      </tr>`,
    )
    .join('');
}

const avatarUrls = new Map(); // ul -> { url } on success, { failedAt } on a miss
const AVATAR_RETRY_MS = 30_000;

// ONE cached fetch per account, shared by every surface that shows a photo
// (users table, side panel, God View cards). The endpoint is token-gated, so
// a plain <img src> would 401: fetch as a blob, hand out an object URL.
// Successes are cached for the session; a FAILURE is only cached briefly, so a
// network blip (or a photo uploaded after the panel loaded) still recovers
// instead of leaving the account faceless until a reload.
async function avatarUrl(ul) {
  if (!ul) return null;
  const cached = avatarUrls.get(ul);
  if (cached?.url) return cached.url;
  if (cached?.failedAt && Date.now() - cached.failedAt < AVATAR_RETRY_MS) return null;
  try {
    const res = await fetch(`/api/admin/users/${encodeURIComponent(ul)}/avatar`, {
      headers: { 'x-admin-token': tokenInput.value.trim() },
    });
    if (!res.ok) throw new Error(String(res.status));
    const prev = avatarUrls.get(ul)?.url;
    const url = URL.createObjectURL(await res.blob());
    if (prev && prev !== url) URL.revokeObjectURL(prev);
    avatarUrls.set(ul, { url });
    return url;
  } catch {
    avatarUrls.set(ul, { failedAt: Date.now() });
    return null;
  }
}

async function fillAvatarThumbs(users) {
  for (const u of users) {
    if (!u.hasAvatar) continue;
    const img = document.querySelector(`img[data-avatar-for="${CSS.escape(u.ul)}"]`);
    if (!img || img.src) continue; // absent (panel closed) or already showing
    const url = await avatarUrl(u.ul);
    if (url) img.src = url;
  }
}

// ---- users list (slim) + detail side panel ----
// The list shows WHO exists (user, created, verified, max devices); every
// detail and action lives in the side panel, keyed by selectedUl. All the
// panel's buttons reuse the existing delegated handlers (data-verify /
// data-view-id / data-del-id / data-set-max / data-del-device / data-del-user),
// so actions keep working unchanged — only the layout moved.
let selectedUl = null;

// Users page: client-side search (comma terms, substring on the lowercase
// handle) + 10-per-page pagination. The list is already fully in memory
// (the side panel needs it), so no server round-trips were added.
const USERS_PAGE_SIZE = 10;
let usersPage = 1;

function renderUsers(users) {
  lastUsers = users;
  const terms = $('users-search').value.trim().toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const matched = terms.length
    ? users.filter((u) => terms.some((t) => u.ul.includes(t) || u.u.toLowerCase().includes(t)))
    : users;
  const pages = Math.max(1, Math.ceil(matched.length / USERS_PAGE_SIZE));
  if (usersPage > pages) usersPage = pages;
  const start = (usersPage - 1) * USERS_PAGE_SIZE;
  const view = matched.slice(start, start + USERS_PAGE_SIZE);

  $('users-count').textContent = `${matched.length} user${matched.length === 1 ? '' : 's'}${terms.length ? ` matching “${terms.join(', ')}”` : ''}`;
  $('users-page-label').textContent = `page ${usersPage} / ${pages}`;
  $('btn-users-prev').disabled = usersPage <= 1;
  $('btn-users-next').disabled = usersPage >= pages;

  const emptyEl = $('users-empty');
  emptyEl.textContent = terms.length ? 'No users match that search.' : 'No users yet.';
  emptyEl.hidden = matched.length > 0;
  const body = $('users-body');
  body.innerHTML = view
    .map(
      (u) => `<tr>
        <td>${unameHtml(u.u, { premium: u.premium, title: u.premium ? 'premium — gold certificate' : '' })}<br /><span class="dim mono">${esc(u.ul)}</span></td>
        <td>${fmtDate(u.createdAt)}</td>
        <td>${u.verified
          ? '<span class="badge ok-badge">verified</span>'
          : '<span class="badge no-badge">not verified</span>'}${modChip(u)}${u.verified && u.malicious
          ? '<br /><span class="dim small-note">treated as unverified while the timeout runs</span>' : ''}</td>
        <td class="mono">${u.maxDevices}</td>
        <td><button class="tiny" data-view-user="${esc(u.ul)}">view more</button></td>
      </tr>`,
    )
    .join('');
  renderPanel();
  // thumbs: visible page + (search may have paged it away) the panel's user
  const thumbs = [...view];
  if (selectedUl && !view.some((u) => u.ul === selectedUl)) {
    const su = users.find((x) => x.ul === selectedUl);
    if (su) thumbs.push(su);
  }
  fillAvatarThumbs(thumbs).catch(() => {});
}

let userTab = 'details';

function showUserTab(tab) {
  userTab = tab;
  for (const t of document.querySelectorAll('.uptab')) {
    const on = t.dataset.uptab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  }
  // the three lazy tabs own their own containers (a server round-trip each)
  $('user-panel-body').hidden = ['relations', 'blockers', 'shares'].includes(tab);
  $('user-shares').hidden = tab !== 'shares';
  $('user-relations').hidden = tab !== 'relations';
  $('user-blockers').hidden = tab !== 'blockers';
  if (tab === 'relations') {
    loadRelations();
    return; // the sections dispatcher doesn't own these tabs
  }
  if (tab === 'blockers') {
    loadBlockers();
    return;
  }
  if (tab === 'shares') {
    loadShares();
    return;
  }
  renderPanel();
}

// Open the user side panel straight onto a tab (the God View's card icons and
// the Shares tab's own links both use it).
function openUser(ul, tab = 'details') {
  if (!ul) return;
  openPanel(ul);
  if (tab !== 'details') showUserTab(tab);
}

function openPanel(ul) {
  selectedUl = ul;
  $('user-panel').hidden = false;
  $('user-overlay').hidden = false;
  showUserTab('details'); // a new user is always config-first; relations is opt-in
  fillAvatarThumbs(lastUsers).catch(() => {});
}

// Relationships: who added whom, who this account verified/trusted — the
// SAME mutuality-gated truth the app enforces (server computes it). Any row
// opens THAT user's config.
async function loadRelations() {
  const el = $('user-relations');
  if (!selectedUl) return;
  const ul = selectedUl;
  try {
    const { relationships } = await api(`/api/admin/users/${encodeURIComponent(ul)}/relationships`);
    if (ul !== selectedUl || userTab !== 'relations') return; // stale response guard
    const mark = (on) => on ? '<span class="rel-yes">✓</span>' : '<span class="dim">—</span>';
    el.innerHTML = relationships.length
      ? `<table class="rel-table">
          <thead><tr><th>User</th><th>Added&nbsp;them</th><th>They&nbsp;added</th><th>Verified</th><th>Trusted</th><th>Tags&nbsp;(mine)</th><th>Blocked&nbsp;them</th><th>Blocked&nbsp;by</th></tr></thead>
          <tbody>${relationships.map((r) => `<tr class="${r.blocks || r.blockedBy ? 'rel-blocked' : ''}">
            <td><button class="linkish" data-view-user="${esc(r.ul)}">${unameHtml(r.ul, { premium: r.premium })}</button></td>
            <td>${mark(r.added)}</td><td>${mark(r.theyAddedMe)}</td><td>${mark(r.verified)}</td><td>${mark(r.trust)}</td>
            <td>${tagsCell(r.tags)}</td>
            <td>${r.blocks ? '<span class="rel-block" title="blocked by this account">⛔</span> ' + reasonChip(r.blockReason) : '<span class="dim">—</span>'}</td>
            <td>${r.blockedBy ? '<span class="rel-block" title="this account is walled off here">⛔</span> ' + reasonChip(r.blockedByReason) : '<span class="dim">—</span>'}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : '<p class="dim">No relationships yet — this account has added nobody, and nobody has added it.</p>';
  } catch (err) {
    el.innerHTML = `<p class="dim">Relationships failed: ${esc(err.message)}</p>`;
  }
}

// "Blocked by": every account that walled this one off, with the reason the
// blocker chose at block time (stored on THEIR doc) and when. Reasons are
// the blocker's stated opinion — shown as said, verdicts belong to the
// operator; scam claims are highlighted.
async function loadBlockers() {
  const el = $('user-blockers');
  if (!selectedUl) return;
  const ul = selectedUl;
  try {
    const { blockers } = await api(`/api/admin/users/${encodeURIComponent(ul)}/blockers`);
    if (ul !== selectedUl || userTab !== 'blockers') return; // stale response guard
    const when = (v) => (v ? new Date(v).toLocaleDateString() : '—');
    el.innerHTML = blockers.length
      ? `<table class="rel-table">
          <thead><tr><th>Blocked by</th><th>Reason (the blocker’s words)</th><th>When</th></tr></thead>
          <tbody>${blockers.map((r) => `<tr class="${r.reason === 'scam' ? 'rel-blocked' : ''}">
            <td><button class="linkish" data-view-user="${esc(r.ul)}">${unameHtml(r.ul, { premium: r.premium })}</button></td>
            <td>${r.reason ? reasonChip(r.reason) : '<span class="dim" title="this wall predates the reason field — re-block to state one">no reason stored</span>'}</td>
            <td class="dim">${esc(when(r.at))}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : `<p class="dim">Nobody has blocked @${esc(ul)}.</p>`;
  } catch (err) {
    el.innerHTML = `<p class="dim">Blockers failed: ${esc(err.message)}</p>`;
  }
}

function closePanel() {
  selectedUl = null;
  $('user-panel').hidden = true;
  $('user-overlay').hidden = true;
}

// ---- Shares tab -----------------------------------------------------------
// The share-link story of ONE account, straight from the server's two facts
// (users.ref + the `shares` pair docs — see be/src/lib/shares.js). Order
// tells the growth story: who you brought in, who already had an account and
// opened your link, which links you opened, and where YOU came from.
const shareRow = (r, { created = false } = {}) => `
  <tr class="${r.gone ? 'sh-gone' : ''}">
    <td><span class="sh-who">
      <span class="sh-av" data-sh-av="${esc(r.ul)}">${esc(r.ul.slice(0, 1))}</span>
      <button class="linkish" data-view-user="${esc(r.ul)}">${unameHtml(r.ul, { premium: r.premium })}</button>
      ${r.gone ? '<span class="badge orphan" title="this account no longer exists">deleted</span>' : ''}
    </span></td>
    <td class="dim">${created ? esc(fmtDate(r.at)) : esc(fmtAgo(r.at))}${
      r.firstAt && r.lastAt && String(r.firstAt) !== String(r.lastAt)
        ? `<br /><span class="small-note">first ${esc(fmtAgo(r.firstAt))}</span>`
        : ''
    }</td>
    <td class="mono">${r.clicks ?? 0}</td>
  </tr>`;

const shareTable = (rows, { created = false, empty, clicksLabel = 'Clicks' }) => (rows.length
  ? `<table class="rel-table sh-table">
      <thead><tr><th>User</th><th>${created ? 'Created' : 'Last click'}</th><th>${clicksLabel}</th></tr></thead>
      <tbody>${rows.map((r) => shareRow(r, { created })).join('')}</tbody>
    </table>`
  : `<p class="dim small-note">${esc(empty)}</p>`);

async function loadShares() {
  const el = $('user-shares');
  if (!selectedUl) return;
  const ul = selectedUl;
  el.innerHTML = '<p class="dim">Loading shares…</p>';
  try {
    const data = await api(`/api/admin/users/${encodeURIComponent(ul)}/shares`);
    if (ul !== selectedUl || userTab !== 'shares') return; // stale response guard
    const { ref, created, seen, clicked } = data;
    const stat = (n, label) => `<span class="sh-stat"><b>${n}</b><span>${esc(label)}</span></span>`;
    el.innerHTML = `
      <div class="sec">
        <div class="sh-stats">
          ${stat(created.length, 'created from this link')}
          ${stat(seen.length, 'opened it with an account')}
          ${stat(clicked.length, 'links this user opened')}
        </div>
      </div>
      <div class="sec">
        <h3>Created from @${esc(ul)}’s link</h3>
        <p class="dim small-note">accounts that came into existence because of this user’s <span class="mono">/?chat=${esc(ul)}</span> link — the solid purple lines in the God View.</p>
        ${shareTable(created, { created: true, clicksLabel: 'Clicks since', empty: 'Nobody has created an account from this link yet.' })}
      </div>
      <div class="sec">
        <h3>Opened the link (already had an account)</h3>
        <p class="dim small-note">existing accounts that clicked through — the dotted dark-purple “seen” lines. Repeats bump the click count instead of adding rows.</p>
        ${shareTable(seen, { empty: 'No existing account has opened this link (or none has reported it yet — clicks are recorded once the opener has a session).' })}
      </div>
      <div class="sec">
        <h3>Links @${esc(ul)} clicked</h3>
        ${shareTable(clicked, { empty: 'This account has not opened anyone’s share link.' })}
      </div>
      <div class="sec">
        <h3>This account came from</h3>
        ${ref
          ? `<p class="sh-parent">${svgShareIcon()} created from
              <button class="linkish" data-view-user="${esc(ref.ul)}">${unameHtml(ref.ul, { premium: ref.premium })}</button>
              ${ref.gone ? '<span class="badge orphan" title="the parent account no longer exists">deleted</span>' : ''}
              <span class="dim">${esc(fmtDate(ref.at))}</span></p>`
          : '<p class="dim small-note">No share link — this account was created without one (organic, or predates attribution).</p>'}
      </div>`;
    paintShareAvatars(el, [...created, ...seen, ...clicked, ...(ref ? [ref] : [])]);
  } catch (err) {
    el.innerHTML = `<p class="dim">Shares failed: ${esc(err.message)}</p>`;
  }
}

// small share glyph for the tab's origin line (the panel carries no icon font)
const svgShareIcon = () => '<svg class="reason-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5.6" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="18.4" r="2.6"/><path d="m8.3 10.8 7.4-3.9M8.3 13.2l7.4 3.9"/></svg>';

// Every named account in the tab gets its photo (one cached fetch each) —
// the tab is a face list, so faces matter.
async function paintShareAvatars(root, rows) {
  for (const r of rows) {
    if (r.gone) continue;
    const u = lastUsers.find((x) => x.ul === r.ul);
    if (u && !u.hasAvatar) continue;
    const slots = root.querySelectorAll(`[data-sh-av="${CSS.escape(r.ul)}"]`);
    if (!slots.length) continue;
    const url = await avatarUrl(r.ul);
    if (!url) continue;
    for (const slot of slots) { slot.style.backgroundImage = `url("${url}")`; slot.textContent = ''; }
  }
}

// The panel is tabbed like the client's settings drawer: each tab renders
// only its own sections; relations lazy-loads into its own container.
function renderPanel() {
  const panel = $('user-panel');
  if (!selectedUl) { if (!panel.hidden) closePanel(); return; }
  const u = lastUsers.find((x) => x.ul === selectedUl);
  if (!u) { closePanel(); return; } // account deleted / no longer visible
  // don't clobber the active tab while a number input in it has focus — the
  // 10s refresh would reset a half-typed value
  if (['max-devices', 'lu-limit', 'flap-cap'].includes(document.activeElement?.className)) return;
  $('user-panel-title').textContent = `@${u.ul}`;
  $('user-panel-body').innerHTML = (PANEL_SECTIONS[userTab] ?? (() => ''))(u);
  // repaint kept the DOM fresh — reuse the blob URL we already have so the
  // 10s refresh cycle never refetches the avatar
  const kept = avatarUrls.get(u.ul);
  if (kept?.url) {
    const img = document.querySelector(`img[data-avatar-for="${CSS.escape(u.ul)}"]`);
    if (img && !img.src) img.src = kept.url;
  }
}

const accountHead = (u) => `
  <div class="sec">
    <div class="pu-id">${unameHtml(u.u, { premium: u.premium })} <span class="dim mono">${esc(u.ul)}</span></div>
    ${(u.badges ?? []).length ? `<div class="badge-row">${u.badges.map((b) => `<button class="badge-info" data-badge-info="${esc(b.id)}" title="badge details"><span class="badge-art" data-art="${esc(b.id)}" data-px="20"></span> <span>${esc(badgeDef(b.id)?.label ?? b.id)}</span></button>`).join('')}</div>` : ''}
    <div class="dim">created ${fmtDate(u.createdAt)}</div>
  </div>`;

// ---- Staff moderation block for the user panel (the details tab IS the
// user details view): timeout state + REMAINING TIME (admin-only — the app
// routes expose the malicious/banned flags but never the clock), the same
// preset buttons as the Reports page, and the ban switch. The 10s poll
// re-renders this, so the countdown is always live.
const moderationSection = (u) => `
    <div class="sec">
      <h3>Staff moderation</h3>
      ${u.banned
        ? `<p><span class="badge mod-danger">banned</span> <span class="dim small-note">since ${esc(fmtDate(u.bannedAt))} — platform use refused, ALL data intact; unban resumes as it was</span></p>`
        : u.malicious
          ? `<p><span class="badge mod-danger">timed out — treated as malicious</span><br />
             <span class="dim small-note">until ${esc(fmtDate(u.timeoutUntil))} · <strong class="mod-remaining">${esc(fmtRemaining(u.timeoutRemainingSec))}</strong> remaining</span><br />
             <span class="dim small-note">acts like an UNVERIFIED user everywhere (danger icon + staff warning + −1000 CoCo + no cold messaging)${u.verified ? ' — stored verification returns when the clock runs out' : ''}</span></p>`
          : '<p class="dim small-note">no active timeout or ban</p>'}
      <div class="row mod-actions">
        ${TIMEOUT_PRESETS.map(([days, label]) => `<button class="tiny${u.malicious && !u.banned ? ' mod-live' : ''}"
          data-timeout="${esc(u.ul)}" data-days="${days}" title="${esc(MOD_TIMEOUT_TEXT(u.ul, label, days).replaceAll('\n', ' '))}">${label}</button>`).join('')}
        ${u.malicious ? `<button class="linkish" data-timeout="${esc(u.ul)}" data-days="0">clear timeout</button>` : ''}
        ${u.banned
          ? `<button class="tiny mod-live" data-ban="${esc(u.ul)}" data-on="0">unban</button>`
          : '<button class="danger tiny" data-ban="' + esc(u.ul) + '" data-on="1">ban</button>'}
      </div>
    </div>`;

const PANEL_SECTIONS = {
  // What the world (well — mutual friends) sees: the client's public profile.
  details: (u) => `${accountHead(u)}
    ${moderationSection(u)}
    <div class="sec">
      <h3>Origin</h3>
      ${u.ref
        ? `<p class="sh-parent">${svgShareIcon()} created from
            <button class="linkish" data-view-user="${esc(u.ref.by)}">@${esc(u.ref.by)}</button>
            <span class="dim">${esc(fmtDate(u.ref.at))}</span>
            <button class="tiny" data-view-shares="${esc(u.ul)}">shares →</button></p>`
        : '<p class="dim small-note">no parent — this account was not created from a share link</p>'}
    </div>
    <div class="sec">
      <h3>Profile photo</h3>
      ${u.hasAvatar
        ? `<img class="avatar-thumb" data-avatar-for="${esc(u.ul)}" alt="profile photo" title="Click to enlarge" />`
          + '<p class="dim small-note">only ever shown to mutual friends; click to enlarge</p>'
        : '<span class="dim">no photo</span>'}
    </div>
    <div class="sec">
      <h3>Bio</h3>
      <p class="pu-bio">${u.bio ? esc(u.bio) : '<span class="dim">no bio</span>'}</p>
    </div>`,

  verification: (u) => `${accountHead(u)}
    <div class="sec">
      <h3>Identity verification</h3>
      <label class="toggle-row">
        <input type="checkbox" class="verify-toggle" data-verify="${esc(u.ul)}" ${u.verified ? 'checked' : ''} />
        <span>${u.verified && u.verifiedAt ? 'verified ' + esc(fmtDate(u.verifiedAt)) : 'not verified'}</span>
      </label>
      <label class="toggle-row">
        <input type="checkbox" class="premium-toggle" data-premium="${esc(u.ul)}" ${u.premium ? 'checked' : ''} />
        <span><span class="badge gold-badge">★</span> PREMIUM — gold certificate, 5-device cap</span>
      </label>
      <p class="dim small-note">unverified accounts carry a red notice to their contacts</p>
    </div>
    <div class="sec">
      <h3>ID document</h3>
      ${u.idDoc
        ? `<span class="dim">${esc(u.idDoc.contentType.replace('image/', ''))} · uploaded ${fmtDate(u.idDoc.uploadedAt)}</span>
           <div class="row">
             <button class="tiny" data-view-id="${esc(u.ul)}">view</button>
             <button class="danger tiny" data-del-id="${esc(u.ul)}">delete photo</button>
           </div>`
        : '<span class="dim">none uploaded</span>'}
    </div>`,

  devices: (u) => `${accountHead(u)}
    <div class="sec">
      <h3>Max devices</h3>
      <div class="row">
        <input type="number" min="1" max="1000" value="${u.maxDevicesOverride ?? ''}" class="max-devices" data-max-for="${esc(u.ul)}" placeholder="auto" />
        <button class="tiny" data-set-max="${esc(u.ul)}">set</button>
        ${u.maxDevicesOverride != null ? `<button class="danger tiny" data-max-auto="${esc(u.ul)}">auto</button>` : ''}
      </div>
      <p class="dim small-note">currently ${u.maxDevices} — policy: 1 unverified · 2 verified · 5 premium; a set number OVERRIDES the policy, “auto” restores it</p>
    </div>
    <div class="sec">
      <h3>Devices <span class="dim">(${u.devices.length})</span></h3>
      ${u.devices.length ? `<table class="rel-table device-table">
        <thead><tr><th>Device</th><th>Created</th><th>Seen</th><th>Last&nbsp;IP</th><th>App</th><th></th></tr></thead>
        <tbody>${u.devices
          .map((d) => `<tr>
            <td>${d.name ? `<strong>${esc(d.name)}</strong><br />` : ''}<span class="mono" title="${esc(d.id)}">${esc(d.id.slice(0, 8))}…</span></td>
            <td class="dim">${fmtDate(d.createdAt)}</td>
            <td class="dim">${fmtAgo(d.lastSeenAt)}</td>
            <td class="dim mono">${esc(d.lastIp ?? '—')}</td>
            <td>${deviceInstallMark(d)}</td>
            <td><button class="danger tiny" data-del-device="${esc(u.ul)}" data-device="${esc(d.id)}">remove</button></td>
          </tr>`)
          .join('')}</tbody>
      </table>` : '<span class="dim">none</span>'}
      <p class="dim small-note">removing the LAST device deletes the account outright · App: ✓ installed PWA, ✕ browser tab, — never reported (self-reports arrive on each session open)</p>
    </div>`,

  traffic: (u) => `${accountHead(u)}
    <div class="sec">
      <h3>Per-device IP-change budgets</h3>
      <p class="dim small-note">${(u.ips ?? []).length
        ? `latest egress IP per device: ${esc(u.ips.join(', '))}`
        : 'no IPs recorded yet'} · meters link into a Traffic search for that exact subject</p>
      ${u.devices
        .map((d) => {
          const f = d.flap ?? {};
          const blocked = f.count != null && f.limit != null && f.count > f.limit;
          const mins = f.ttlSec > 0 ? ` · resets ${Math.ceil(f.ttlSec / 60)}m` : '';
          return `<div class="device" data-flap-dv="${esc(d.id)}">
            ${d.name ? `<strong>${esc(d.name)}</strong> ` : ''}<span class="mono">${esc(d.id.slice(0, 8))}…</span>
            <button class="flap-meter${blocked ? ' flap-blocked' : ''}" data-rl-for="${esc(u.ul)}:${esc(d.id)}"
                    title="open Traffic search for this device">IP changes ${f.count ?? 0}/${f.limit ?? '—'}${mins}${blocked ? ' — BLOCKED' : ''}</button>
            <input class="flap-cap" type="number" min="1" placeholder="cap" aria-label="IP-change budget for this device"
                   value="${f.override ? (f.limit ?? '') : ''}" />
            <button class="tiny" data-flap-set="${esc(d.id)}">set</button>
            ${f.override ? `<button class="danger tiny" data-flap-reset="${esc(d.id)}">reset</button>` : ''}
          </div>`;
        })
        .join('') || '<span class="dim">no devices</span>'}
    </div>
    <div class="sec">
      <h3>Account limits</h3>
      <p class="dim small-note">per-account overrides beat the app-wide tuning; reset falls back. First four are the verify/trust budgets.</p>
      <button class="tiny" data-rl-for="${esc(u.ul)}">search rate limits →</button>
      <table class="limits-table">
        <thead><tr><th>Limit</th><th>Def</th><th>App</th><th>User</th><th></th></tr></thead>
        <tbody>${panelLimitsRows(u.ul)}</tbody>
      </table>
    </div>`,

  badges: (u) => `${accountHead(u)}
    <div class="sec">
      <h3>Badges</h3>
      <p class="dim small-note">every badge carries CoCo points; capped badges are checked against live holder counts before any award (the server queues them serially).</p>
      <table class="rel-table">
        <thead><tr><th>Badge</th><th>CoCo</th><th>Holders</th><th>This user</th><th></th></tr></thead>
        <tbody>${(lastBadgeDefs ?? []).map((d) => {
          const held = (u.badges ?? []).find((b) => b.id === d.id);
          const awardable = d.awardable !== false && !held;
          return `<tr>
            <td><button class="badge-info" data-badge-info="${esc(d.id)}" title="badge details"><span class="badge-art" data-art="${esc(d.id)}" data-px="26"></span> <span><strong>${esc(d.label)}</strong><br /><span class="dim mono">${esc(d.id)}</span></span></button></td>
            <td class="mono">+${d.score}</td>
            <td class="mono">${d.holders}${d.cap != null ? ` / ${d.cap}` : ''}${d.full ? ' <span class="badge no-badge">full</span>' : ''}</td>
            <td>${held ? `<span class="rel-yes">✓</span> <span class="dim">${esc(held.at ? new Date(held.at).toLocaleDateString() : '')}</span>` : '<span class="dim">—</span>'}</td>
            <td>${awardable ? `<button class="tiny" data-award-badge="${esc(d.id)}" data-award-ul="${esc(u.ul)}" ${d.full ? 'disabled title="all seats taken"' : ''}>award</button>` : ''}${held && d.id !== 'premium' ? ` <button class="danger tiny" data-revoke-badge="${esc(d.id)}" data-revoke-ul="${esc(u.ul)}" title="revoke (worn badge is cleared too)">revoke</button>` : ''}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
      <p class="dim small-note">Premium is a badge too — toggled on the Verification tab. Teacher's Pet is awardable ONLY here (never earned automatically). Wearing a badge is always the user's own choice, and only VERIFIED accounts show it.</p>
    </div>`,

  relations: () => '',
  blockers: () => '',
  shares: () => '',
};

// Account-scoped limiters for the user panel's limits table (IP-subject
// limiters are app-wide only — the API rejects them per user). The verify/
// trust budgets lead: they're the ones a reviewer actually adjusts.
const PANEL_LIMIT_ORDER = ['fvday', 'fvweek', 'ftday', 'ftweek'];
function panelLimitsRows(ul) {
  const cfg = lastLimitsCfg;
  const rows = (cfg.limiters ?? [])
    .filter((l) => l.scope === 'account' && !l.device)
    .sort((a, b) => {
      const ai = PANEL_LIMIT_ORDER.indexOf(a.name);
      const bi = PANEL_LIMIT_ORDER.indexOf(b.name);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    })
    .map((l) => {
      const own = (cfg.userOverrides ?? []).find((o) => o.ul === ul && o.name === l.name);
      return `<tr>
        <td>${esc(l.label.replace(/ \(per account\)| \(acct\)/, ''))}<br /><span class="dim mono">${esc(l.name)}</span></td>
        <td class="mono">${l.defaultLimit}</td>
        <td class="mono dim">${l.override?.limit ?? '—'}</td>
        <td><input class="lu-limit" type="number" min="1" placeholder="—"
             value="${own?.limit ?? ''}" data-lu-name="${esc(l.name)}" /></td>
        <td>
          <button class="tiny" data-lu-set="${esc(l.name)}" data-lu-user="${esc(ul)}">set</button>
          ${own ? `<button class="danger tiny" data-lu-clear="${esc(l.name)}" data-lu-user="${esc(ul)}">reset</button>` : ''}
        </td>
      </tr>`;
    })
    .join('');
  return rows || '<tr><td colspan="5" class="dim">none applicable</td></tr>';
}

// ---- badge artwork for the admin panel ----
// Mirrors client/app/js/badges.js (SVGs as strings since admin renders via
// innerHTML). Labels/blurbs/scores/caps come from the SERVER catalog
// (GET /api/admin/badges) — art is the only duplication, by design.
// Badge artwork comes from THE shared module (client/app/js/badges-art.js,
// served by admin.js at /badges-art.js and loaded as a module script in
// index.html — it self-registers window.badgeArtSvg). Templates place a
// .badge-art slot; the observer hydrates every slot with the real SVG the
// moment it enters the DOM. One artwork source, no drift.
function hydrateBadgeArt() {
  if (!window.badgeArtSvg) { setTimeout(hydrateBadgeArt, 60); return; }
  for (const slot of document.querySelectorAll('.badge-art[data-art]:not([data-done])')) {
    slot.replaceChildren(window.badgeArtSvg(slot.dataset.art, Number(slot.dataset.px) || 20));
    slot.dataset.done = '1';
  }
}
new MutationObserver(hydrateBadgeArt).observe(document.documentElement, { childList: true, subtree: true });
const badgeDef = (id) => (lastBadgeDefs ?? []).find((d) => d.id === id);

let lastDiags = [];
let lastUsers = [];
let lastLimitsCfg = { limiters: [], userOverrides: [] };
let lastBadgeDefs = [];

function renderLimitsConfig(cfg) {
  lastLimitsCfg = cfg;
  // don't rebuild the app-wide table while a value is being typed into it
  if (['lc-limit', 'lc-window'].includes(document.activeElement?.className)) return;
  const rows = (cfg.limiters ?? [])
    .map(
      (l) => `<tr>
        <td>${esc(l.label)}<br /><span class="dim mono">${esc(l.name)}</span></td>
        <td>${l.device ? 'device' : l.scope}</td>
        <td class="mono">${l.defaultLimit} / ${l.defaultWindowSec}s</td>
        <td><input class="lc-limit" data-lc-name="${esc(l.name)}" type="number" min="1"
             value="${l.override?.limit ?? ''}" placeholder="—" /></td>
        <td><input class="lc-window" data-lc-name="${esc(l.name)}" type="number" min="1"
             value="${l.override?.windowSec ?? ''}" placeholder="—" /></td>
        <td class="dim mono">now ${l.effective.limit} / ${l.effective.windowSec}s</td>
        <td>
          <button class="tiny" data-lc-set="${esc(l.name)}">set</button>
          <button class="danger tiny" data-lc-clear="${esc(l.name)}">reset</button>
        </td>
      </tr>`,
    )
    .join('');
  $('limits-config-body').innerHTML = rows;
}

// PWA install state per device (PUT /api/devices/self, sent by the SDK when
// a session opens): tick installed, cross tab-mode, dash = never reported —
// a non-browser device MUST NOT be shown as "not installed".
const deviceInstallMark = (d) => (d.installed === true
  ? '<span class="rel-yes" title="installed as an app (device-reported)">✓</span>'
  : d.installed === false
    ? '<span class="rel-no" title="running as a browser tab">✕</span>'
    : '<span class="dim" title="no self-report received yet">—</span>');

// Warning appended to the device-remove confirm when the account would be
// left with zero devices (username stays reserved, account inaccessible).
function orphanNote(ul) {
  const u = lastUsers.find((x) => x.ul === ul);
  return u && u.devices.length <= 1
    ? '\n\n⚠ This is the ONLY device — removing it DELETES the account (@' + ul + ') outright: all messages gone, username becomes free again.'
    : '';
}

function renderDiags(diags) {
  lastDiags = diags;
  $('diags-empty').hidden = diags.length > 0;
  $('diags-list').innerHTML = diags
    .map(
      (d) => `<details class="diag">
      <summary>
        <span class="mono">${fmtDate(d.ts)}</span>
        <strong>@${esc(d.account ?? 'anonymous')}</strong>
        <span class="dim mono">${esc(d.ip ?? '')}</span>
        <span class="dim">${esc(String(d.ua ?? '').slice(0, 60))}</span>
        <button class="tiny" data-copy-diag="${esc(d.id)}">copy</button>
        ${d.ip ? `<button class="tiny" data-clear-ip-of="${esc(d.ip)}" title="Clear all IP-scoped rate limits for this device">un-limit IP</button>` : ''}
        <button class="danger tiny" data-del-diag="${esc(d.id)}">delete</button>
      </summary>
      <pre class="diag-report">${esc(d.report ?? '')}</pre>
    </details>`,
    )
    .join('');
}

// Reports mirror the client's REPORT_REASONS (client/app/js/reports.js):
// reason id -> label. Keep the two in step when the menu changes.
const REPORT_REASON_LABELS = {
  scamming: 'Scamming',
  harassment: 'Harassment or hate speech',
  graphic: 'Unsolicited graphic material',
  other: 'Other',
};

function renderReports(reports) {
  $('reports-empty').hidden = reports.length > 0;
  if (!reports.length) { $('reports-list').innerHTML = ''; return; }
  // one row per report; the shared transcript is long, so it folds into an
  // expandable cell under its own "n messages" toggle rather than a column
  const transcriptCell = (r) => (r.messages ?? []).length
    ? `<details class="report-toggle">
        <summary>${(r.messages ?? []).length} message${(r.messages ?? []).length === 1 ? '' : 's'} <span class="dim">(unencrypted)</span></summary>
        <div class="report-transcript">
          ${(r.messages ?? [])
            .map((m) => `<div class="report-msg"><span class="mono dim">${fmtDate(m.ts)}</span> <strong>@${esc(m.from ?? '?')}</strong> <span>${esc(m.text ?? '')}</span></div>`)
            .join('')}
        </div>
      </details>`
    : '<span class="dim">none shared</span>';
  // the staff-action column: timeout presets (the account then ACTS
  // UNVERIFIED, carries the danger mark + staff warning everywhere and
  // takes -1000 CoCo) and the BAN (platform use refused, data intact).
  // State chips read from lastUsers — renderUsers runs before this in
  // refresh(), and the 10s poll keeps remaining time live.
  const actionCell = (r) => {
    const peer = String(r.peer ?? '').toLowerCase();
    if (!peer) return '<span class="dim">—</span>';
    const u = lastUsers.find((x) => x.ul === peer);
    const presets = TIMEOUT_PRESETS
      .map(([days, label]) => `<button class="tiny${u?.malicious && !u.banned ? ' mod-live' : ''}"
        data-timeout="${esc(peer)}" data-days="${days}" title="${esc(MOD_TIMEOUT_TEXT(peer, label, days).replaceAll('\n', ' '))}">${label}</button>`)
      .join('');
    const banBtn = u?.banned
      ? `<button class="tiny mod-live" data-ban="${esc(peer)}" data-on="0">unban</button>`
      : '<button class="danger tiny" data-ban="' + esc(peer) + '" data-on="1">ban</button>';
    const live = (u?.malicious || u?.banned)
      ? `<div class="small-note">${modChip(u)}${u.malicious ? ` <button class="linkish" data-timeout="${esc(peer)}" data-days="0">clear timeout</button>` : ''}</div>`
      : '';
    return `<div class="row mod-actions">${presets}${banBtn}</div>${live}`;
  };
  $('reports-list').innerHTML = `<table class="rel-table reports-table">
    <thead><tr>
      <th>When</th><th>Reporter</th><th>Against</th><th>Reason</th><th>Description</th><th>Chat history</th><th>Outcome</th><th>Staff action</th><th></th>
    </tr></thead>
    <tbody>${reports.map((r) => `<tr>
      <td class="mono dim">${fmtDate(r.ts)}<br />${esc(r.ip ?? '')}</td>
      <td><button class="linkish" data-view-user="${esc(r.account ?? '')}">@${esc(r.account ?? '?')}</button></td>
      <td><button class="linkish" data-view-user="${esc(r.peer ?? '')}">@${esc(r.peer ?? '?')}</button>${modChip(lastUsers.find((x) => x.ul === String(r.peer ?? '').toLowerCase()))}</td>
      <td><span class="badge report-reason">${esc(REPORT_REASON_LABELS[r.reason] ?? r.reason)}</span></td>
      <td class="report-desc">${esc(r.description ?? '')}</td>
      <td>${transcriptCell(r)}</td>
      <td>${r.blocked
        ? '<span class="badge report-blocked">blocked</span>'
        : '<span class="dim">report only</span>'}</td>
      <td>${actionCell(r)}</td>
      <td><button class="danger tiny" data-del-report="${esc(r.id)}">delete</button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function renderBranding(b) {
  const name = b.appName ?? b.defaultName ?? 'CoCoNo';
  document.title = `${name} admin`;
  const title = $('admin-title');
  if (title) title.textContent = name;
  // Don't clobber a name mid-edit.
  const input = $('branding-name');
  if (input && document.activeElement !== input) input.value = b.appName ?? '';
}

function renderOps(o) {
  $('ops-running').hidden = !o.running;
  const rows = [];
  const LABELS = { update: 'Deploy/tests (update.sh)', hourly: 'Hourly data backup', daily: 'Daily box bundle', drill: 'Restore drill', restore: 'PROD RESTORE' };
  for (const [name, st] of Object.entries(o.statuses)) {
    if (!st) continue;
    const ok = st.code === 0;
    rows.push(`<tr>
      <td>${esc(LABELS[name] ?? name)}</td>
      <td class="${ok ? 'ok' : 'error'}">${ok ? '✅ ok' : `❌ exit ${st.code}`}</td>
      <td>${fmtDate(st.startedAt)} <span class="dim">(${fmtAgo(st.startedAt)})</span></td>
      <td>${st.durationSec ?? '—'}s</td>
      <td class="mono">${esc(String(st.detail ?? ''))}</td>
    </tr>`);
  }
  $('ops-status-body').innerHTML = rows.join('');
  $('ops-empty').hidden = rows.length > 0;

  const sel = $('restore-archive');
  const keep = sel.value;
  sel.innerHTML = (o.hourlyArchives ?? [])
    .map((a) => `<option value="${esc(a.name)}">${esc(a.name)} (${(a.bytes / 1024).toFixed(0)} KiB)</option>`)
    .join('');
  if (keep) sel.value = keep;

  const log = $('ops-log');
  log.hidden = !(o.logs ?? []).length;
  log.textContent = (o.logs ?? []).join('\n');
  log.scrollTop = log.scrollHeight;
}

async function refresh() {
  try {
    const [users, limitsCfg, badgeDefs, diags, reports, branding, ops] = await Promise.all([
      api('/api/admin/users'),
      api('/api/admin/limits'),
      api('/api/admin/badges'),
      api('/api/admin/diagnostics'),
      api('/api/admin/reports'),
      api('/api/admin/branding'),
      api('/api/admin/ops'),
    ]);
    // limits data FIRST: renderUsers → renderPanel reads lastLimitsCfg for
    // the panel's account-limits table
    renderLimitsConfig(limitsCfg);
    renderTrafficState(limitsCfg);
    lastBadgeDefs = badgeDefs.badges ?? [];
    renderUsers(users);
    if (!$('user-panel').hidden && userTab === 'relations') loadRelations();
    if (!$('user-panel').hidden && userTab === 'blockers') loadBlockers();
    if (!$('user-panel').hidden && userTab === 'shares') loadShares();
    renderDiags(diags);
    renderReports(reports);
    renderBranding(branding);
    renderOps(ops);
    $('updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
    setStatus('');
    // the counter table is search-scoped now (no full sweep on the page);
    // an active query just stays live
    if ($('rl-search').value.trim()) searchRateLimits({ silent: true });
  } catch (err) {
    setStatus(String(err.message), 'error');
  }
}

async function run(description, fn) {
  try {
    await fn();
    setStatus(`${description} — done`, 'ok');
  } catch (err) {
    setStatus(`${description} failed: ${err.message}`, 'error');
  }
  await refresh();
}

$('btn-refresh').addEventListener('click', refresh);

// ---- badge info modal (art + server-catalog facts + held context) ----
function openBadgeInfo(id) {
  const def = badgeDef(id);
  const u = lastUsers.find((x) => x.ul === selectedUl);
  const held = (u?.badges ?? []).find((b) => b.id === id);
  $('badge-modal-title').textContent = def?.label ?? id;
  const seat = def
    ? (def.cap != null ? `${def.holders} of ${def.cap} seats taken`
      : def.mode === 'derived' ? 'Follows the premium flag'
      : 'Uncapped')
    : '';
  $('badge-modal-body').innerHTML = `
    <div class="badge-hero-art badge-art" data-art="${esc(id)}" data-px="84"></div>
    <p class="badge-modal-blurb">${esc(def?.blurb ?? 'No description available.')}</p>
    <p class="row badge-modal-facts">
      ${def ? `<span class="badge gold-badge">+${def.score} CoCo</span>` : ''}
      <span class="dim">${esc(seat)}</span>
    </p>
    <p class="dim small-text">${def?.auto ? 'Earned automatically when eligible — or granted from here.' : def && def.mode !== 'derived' ? 'Admin-granted only; never awarded automatically.' : ''}</p>
    ${held ? `<p class="dim small-text">Awarded to @${esc(selectedUl)} on ${esc(new Date(held.at).toLocaleDateString())}</p>` : `<p class="dim small-text">@${esc(selectedUl ?? '')} does not hold this badge.</p>`}`;
  $('badge-overlay').hidden = false;
  $('badge-modal').hidden = false;
}
function closeBadgeInfo() {
  $('badge-modal').hidden = true;
  $('badge-overlay').hidden = true;
}
$('btn-badge-modal-close').addEventListener('click', closeBadgeInfo);
$('badge-overlay').addEventListener('click', closeBadgeInfo);

// ---- users page: search + pager ----
$('users-search').addEventListener('input', () => {
  usersPage = 1;
  renderUsers(lastUsers);
});
$('btn-users-prev').addEventListener('click', () => {
  usersPage = Math.max(1, usersPage - 1);
  renderUsers(lastUsers);
});
$('btn-users-next').addEventListener('click', () => {
  usersPage += 1; // renderUsers clamps to the real page count
  renderUsers(lastUsers);
});

// ---- traffic page: kill-switch state + toggle ----
let rlOff = false;
function renderTrafficState(cfg) {
  rlOff = cfg.rateLimitsDisabled === true;
  const st = $('rl-state');
  st.textContent = rlOff ? 'OFF (kill switch engaged)' : 'on';
  st.className = rlOff ? 'rl-off' : 'rl-on';
  $('btn-rl-toggle').textContent = rlOff ? 'turn on' : 'turn off';
  $('rl-banner').hidden = !rlOff;
}
$('btn-rl-toggle').addEventListener('click', async () => {
  const disable = !rlOff;
  if (disable && !confirm('Disable ALL server-wide rate limiting? The app becomes unthrottled until you turn it back on.')) return;
  try {
    await api('/api/admin/rate-limits/state', { method: 'PUT', body: JSON.stringify({ disabled: disable }) });
    setStatus(disable ? 'Rate limits OFF server-wide' : 'Rate limits back ON', 'ok');
  } catch (err) {
    setStatus(`Toggle failed: ${err.message}`, 'error');
  }
  await refresh();
});

// ---- traffic: Search / Tune sub-tabs ----

function showTrafficSub(sub) {
  for (const t of document.querySelectorAll('.subtab')) {
    const on = t.dataset.sub === sub;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  }
  $('sub-search').hidden = sub !== 'search';
  $('sub-tune').hidden = sub !== 'tune';
}
for (const t of document.querySelectorAll('.subtab')) {
  t.addEventListener('click', () => showTrafficSub(t.dataset.sub));
}

// Scoped counter search — comma-separated IPs/usernames, resolved by
// server-side subject SCANs (the full counter space is never listed).
async function searchRateLimits({ silent = false } = {}) {
  const raw = $('rl-search').value.trim();
  const emptyEl = $('limits-empty');
  if (!raw) {
    renderLimits([]);
    emptyEl.textContent = 'Enter IPs or usernames (comma separated) to look up their counters.';
    emptyEl.hidden = false;
    return;
  }
  try {
    const rows = await api(`/api/admin/rate-limits?subjects=${encodeURIComponent(raw)}`);
    renderLimits(rows);
    if (!rows.length) {
      emptyEl.textContent = `No counters found for: ${raw}`;
      emptyEl.hidden = false;
    }
  } catch (err) {
    if (!silent) setStatus(`Rate-limit search failed: ${err.message}`, 'error');
  }
}
$('btn-rl-search').addEventListener('click', () => searchRateLimits());
$('rl-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchRateLimits();
});

$('btn-purge-diags').addEventListener('click', () => {
  if (!confirm('Delete ALL diagnostics reports?')) return;
  run('Purged diagnostics reports', () => api('/api/admin/diagnostics', { method: 'DELETE' }));
});

$('btn-purge-reports').addEventListener('click', () => {
  if (!confirm('Delete ALL abuse reports?')) return;
  run('Purged abuse reports', () => api('/api/admin/reports', { method: 'DELETE' }));
});

// ---- Backup & Ops ----
const opsRun = (job, label, extra = {}) => run(`${label} started`, () =>
  api('/api/admin/ops/run', { method: 'POST', body: JSON.stringify({ job, ...extra }) }));
$('btn-ops-hourly').addEventListener('click', () => opsRun('hourly', 'Hourly backup'));
$('btn-ops-daily').addEventListener('click', () => opsRun('daily', 'Box bundle'));
// The drill tests the archive selected in the dropdown (top = newest by
// default); empty selection falls back to newest server-side via the script.
$('btn-ops-drill').addEventListener('click', () => {
  const archive = $('restore-archive').value || undefined;
  opsRun('drill', archive ? `Restore drill on ${archive}` : 'Restore drill (newest)', { archive });
});
$('btn-ops-restore').addEventListener('click', () => {
  const archive = $('restore-archive').value;
  if (!archive) return setStatus('No hourly backup available', 'error');
  if ($('restore-confirm').value.trim() !== 'RESTORE') {
    return setStatus('Type RESTORE to confirm a production restore', 'error');
  }
  if (!confirm(`Restore PRODUCTION from ${archive}? Everything newer is destroyed.`)) return;
  run(`Restoring from ${archive}`, () =>
    api('/api/admin/ops/restore', { method: 'POST', body: JSON.stringify({ archive, confirm: 'RESTORE' }) }));
  $('restore-confirm').value = '';
});

$('btn-set-branding').addEventListener('click', () => {
  const name = $('branding-name').value.trim();
  run(name ? `App name set to “${name}”` : 'App name reset to default', () =>
    api('/api/admin/branding', { method: 'PATCH', body: JSON.stringify({ appName: name }) }));
  $('branding-name').blur();
});

// ---- limit tuning ----
async function patchLimits(body) {
  try {
    const data = await api('/api/admin/limits', { method: 'PATCH', body: JSON.stringify(body) });
    setStatus(`${body.name} → ${data.effective.limit} / ${data.effective.windowSec}s${body.user ? ` (user @${body.user})` : ''} — done`, 'ok');
  } catch (err) {
    setStatus(`Setting ${body.name} failed: ${err.message}`, 'error');
  }
  await refresh();
}

const intOr0 = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n >= 1 ? n : 0; };

document.addEventListener('click', (e) => {
  const setBtn = e.target.closest?.('[data-lc-set]');
  if (setBtn) {
    const row = setBtn.closest('tr');
    const value = {};
    const limit = intOr0(row.querySelector('.lc-limit')?.value);
    const windowSec = intOr0(row.querySelector('.lc-window')?.value);
    if (limit) value.limit = limit;
    if (windowSec) value.windowSec = windowSec;
    if (!Object.keys(value).length) return setStatus('Enter a limit and/or window (seconds) to override', 'error');
    return patchLimits({ name: setBtn.dataset.lcSet, value });
  }
  const clearBtn = e.target.closest?.('[data-lc-clear]')?.dataset.lcClear;
  if (clearBtn) return patchLimits({ name: clearBtn, value: null });
  // per-user overrides: edited from the USER PANEL (view more → Account limits)
  const luSet = e.target.closest?.('[data-lu-set]');
  if (luSet) {
    const limit = intOr0(luSet.closest('tr')?.querySelector('.lu-limit')?.value);
    if (!limit) return setStatus('Enter a limit of at least 1', 'error');
    return patchLimits({ name: luSet.dataset.luSet, user: luSet.dataset.luUser, value: { limit } });
  }
  const award = e.target.closest?.('[data-award-badge]');
  if (award) {
    const { awardBadge, awardUl } = award.dataset;
    return run(`Awarded ${awardBadge} to @${awardUl}`, () =>
      api(`/api/admin/users/${encodeURIComponent(awardUl)}/badge`, { method: 'PUT', body: JSON.stringify({ id: awardBadge }) }));
  }
  const revoke = e.target.closest?.('[data-revoke-badge]');
  if (revoke) {
    const { revokeBadge, revokeUl } = revoke.dataset;
    return run(`Revoked ${revokeBadge} from @${revokeUl}`, () =>
      api(`/api/admin/users/${encodeURIComponent(revokeUl)}/badge/${encodeURIComponent(revokeBadge)}`, { method: 'DELETE' }));
  }
  const luClear = e.target.closest?.('[data-lu-clear]');
  if (luClear) {
    return patchLimits({ name: luClear.dataset.luClear, user: luClear.dataset.luUser, value: null });
  }
  const flapSet = e.target.closest?.('[data-flap-set]');
  if (flapSet) {
    const row = flapSet.closest('[data-flap-dv]');
    const dv = row?.dataset.flapDv;
    const limit = intOr0(row?.querySelector('.flap-cap')?.value);
    if (!dv || !limit) return setStatus('Enter a device IP-change cap of at least 1', 'error');
    return patchLimits({ name: 'ipflap', user: `${selectedUl}:${dv}`, value: { limit } });
  }
  const flapReset = e.target.closest?.('[data-flap-reset]')?.dataset.flapReset;
  if (flapReset) return patchLimits({ name: 'ipflap', user: `${selectedUl}:${flapReset}`, value: null });
});

document.addEventListener('click', (e) => {
  // slim list → detail panel
  const viewUser = e.target.closest?.('[data-view-user]')?.dataset.viewUser;
  if (viewUser) {
    openPanel(viewUser);
    return;
  }
  // Details tab → this user's Shares tab (parent link)
  const viewShares = e.target.closest?.('[data-view-shares]')?.dataset.viewShares;
  if (viewShares) {
    openUser(viewShares, 'shares');
    return;
  }

  // panel → traffic page: search this user + their known IPs
  const rlFor = e.target.closest?.('[data-rl-for]')?.dataset.rlFor;
  if (rlFor) {
    if (rlFor.includes(':')) {
      pendingTrafficSearch = rlFor; // device flap meter: exact subject
    } else {
      const su = lastUsers.find((x) => x.ul === rlFor);
      pendingTrafficSearch = [rlFor, ...(su?.ips ?? [])].join(', ');
    }
    location.hash = 'traffic'; // hashchange routes; same-page case handled below
    showPage('traffic');
    return;
  }

  const copyDiag = e.target.closest('[data-copy-diag]')?.dataset.copyDiag;
  if (copyDiag) {
    const report = lastDiags.find((d) => d.id === copyDiag)?.report ?? '';
    navigator.clipboard.writeText(report).then(
      () => setStatus('Report copied to clipboard', 'ok'),
      () => setStatus('Clipboard unavailable in this context', 'error'),
    );
    return;
  }

  const unIp = e.target.closest('[data-clear-ip-of]')?.dataset.clearIpOf;
  if (unIp) {
    return run(`Cleared all rate limits for ${unIp}`, () =>
      api('/api/admin/rate-limits/clear', { method: 'POST', body: JSON.stringify({ ip: unIp }) }));
  }

  const delDiag = e.target.closest('[data-del-diag]')?.dataset.delDiag;
  if (delDiag) {
    return run(`Deleted diagnostics report`, () =>
      api(`/api/admin/diagnostics/${encodeURIComponent(delDiag)}`, { method: 'DELETE' }));
  }

  // ---- STAFF MODERATION: timeout presets + ban (server lib/moderation.js)
  const timeoutBtn = e.target.closest?.('[data-timeout]');
  if (timeoutBtn) {
    const ul = timeoutBtn.dataset.timeout;
    const days = Number(timeoutBtn.dataset.days);
    if (!days) {
      if (!confirm(`Clear the timeout on @${ul}? The account returns to its stored verification state and the danger marks disappear.`)) return;
      return run(`Cleared timeout on @${ul}`, () => moderationPut(ul, { timeoutDays: null }));
    }
    const label = TIMEOUT_PRESETS.find(([d]) => d === days)?.[1] ?? `${days}d`;
    if (!confirm(MOD_TIMEOUT_TEXT(ul, label, days))) return;
    return run(`Timed out @${ul} for ${label}`, () => moderationPut(ul, { timeoutDays: days }));
  }
  const banBtn = e.target.closest?.('[data-ban]');
  if (banBtn) {
    const ul = banBtn.dataset.ban;
    const on = banBtn.dataset.on === '1';
    if (!confirm(MOD_BAN_TEXT(ul, on))) return;
    return run(`${on ? 'Banned' : 'Unbanned'} @${ul}`, () => moderationPut(ul, { banned: on }));
  }

  const delReport = e.target.closest('[data-del-report]')?.dataset.delReport;
  if (delReport) {
    return run(`Deleted abuse report`, () =>
      api(`/api/admin/reports/${encodeURIComponent(delReport)}`, { method: 'DELETE' }));
  }

  const clearKey = e.target.closest('[data-clear-key]')?.dataset.clearKey;
  if (clearKey) {
    return run(`Cleared ${clearKey}`, () =>
      api('/api/admin/rate-limits/clear', { method: 'POST', body: JSON.stringify({ key: clearKey }) }));
  }

  const setMaxBtn = e.target.closest('[data-set-max]');
  if (setMaxBtn) {
    const ul = setMaxBtn.dataset.setMax;
    const input = document.querySelector(`input[data-max-for="${ul}"]`);
    const value = Number(input?.value);
    if (!Number.isInteger(value) || value < 1) {
      return setStatus('Max devices must be a whole number of at least 1', 'error');
    }
    input.blur(); // let the follow-up refresh re-render the row with the new value
    return run(`Set @${ul} max devices to ${value}`, () =>
      api(`/api/admin/users/${encodeURIComponent(ul)}/max-devices`, {
        method: 'PATCH',
        body: JSON.stringify({ maxDevices: value }),
      }));
  }

  const delUser = e.target.closest('[data-del-user]')?.dataset.delUser;
  if (delUser) {
    if (!confirm(`Delete user @${delUser}? Their devices lose access permanently.`)) return;
    return run(`Deleted @${delUser}`, () =>
      api(`/api/admin/users/${encodeURIComponent(delUser)}`, { method: 'DELETE' }));
  }

  const delDeviceBtn = e.target.closest('[data-del-device]');
  if (delDeviceBtn) {
    const { delDevice: ul, device } = delDeviceBtn.dataset;
    if (!confirm(`Remove device ${device.slice(0, 8)}… from @${ul}?` + orphanNote(ul))) return;
    return run(`Removed device from @${ul}`, () =>
      api(`/api/admin/users/${encodeURIComponent(ul)}/devices/${encodeURIComponent(device)}`, { method: 'DELETE' }));
  }
});

// ---- identity verification controls ----
document.addEventListener('click', (e) => {
  const info = e.target.closest?.('[data-badge-info]')?.dataset.badgeInfo;
  if (info) { openBadgeInfo(info); return; }
  const tab = e.target.closest?.('[data-uptab]')?.dataset.uptab;
  if (tab) { showUserTab(tab); return; }
  // 'auto' clears the override → cap returns to the premium/verified policy
  const auto = e.target.closest?.('[data-max-auto]')?.dataset.maxAuto;
  if (auto) {
    return run(`@${auto} device cap back to policy`, () =>
      api(`/api/admin/users/${encodeURIComponent(auto)}/max-devices`, { method: 'PATCH', body: JSON.stringify({ maxDevices: null }) }));
  }
});

document.addEventListener('change', (e) => {
  const premUl = e.target.closest?.('.premium-toggle')?.dataset.premium;
  if (premUl) {
    const on = e.target.checked === true;
    run(`@${premUl} ${on ? 'PREMIUM on' : 'premium off'}`, () =>
      api(`/api/admin/users/${encodeURIComponent(premUl)}/premium`, { method: 'PUT', body: JSON.stringify({ premium: on }) }));
    return;
  }
  const ul = e.target.closest?.('.verify-toggle')?.dataset.verify;
  if (!ul) return;
  const on = e.target.checked === true;
  run(`@${ul} ${on ? 'marked verified' : 'verification revoked'}`, () =>
    api(`/api/admin/users/${encodeURIComponent(ul)}/verified`, {
      method: 'PUT', body: JSON.stringify({ verified: on }),
    }));
});

// ---- user detail side panel: close affordances ----
$('btn-user-close').addEventListener('click', closePanel);
$('user-overlay').addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('badge-modal').hidden) { closeBadgeInfo(); return; }
  if (!$('user-panel').hidden) closePanel();
});

// ---- photo lightbox (click a profile thumbnail to enlarge) ----
{
  const box = $('lightbox');
  const big = $('lightbox-img');
  document.addEventListener('click', (e) => {
    const thumb = e.target.closest?.('img.avatar-thumb');
    if (!thumb?.src) return; // thumbnail not loaded yet — nothing to show
    big.src = thumb.src;
    box.hidden = false;
  });
  box.addEventListener('click', () => {
    box.hidden = true;
    big.removeAttribute('src');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !box.hidden) {
      box.hidden = true;
      big.removeAttribute('src');
    }
  });
}

document.addEventListener('click', async (e) => {
  const viewUl = e.target.closest?.('[data-view-id]')?.dataset.viewId;
  if (viewUl) {
    // token-gated image: fetch as blob, open in a new tab
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(viewUl)}/id-doc`, {
        headers: { 'x-admin-token': tokenInput.value.trim() },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setStatus(`Viewing ID failed: ${err.message}`, 'error');
    }
    return;
  }
  const delUl = e.target.closest?.('[data-del-id]')?.dataset.delId;
  if (delUl) {
    if (!confirm(`Delete the ID photo for @${delUl}? Verification state is kept.`)) return;
    run('ID photo deleted', () =>
      api(`/api/admin/users/${encodeURIComponent(delUl)}/id-doc`, { method: 'DELETE' }));
  }
});

// ---- God View (social graph) ----
// Lives in its own module (admin/godview.js) because it is a self-contained
// canvas + force-layout app; it gets the panel's shared plumbing from here
// (token-gated api(), the avatar cache, the user side panel) instead of
// duplicating any of it.
const godView = initGodView({
  api,
  esc,
  fmtDate,
  fmtAgo,
  avatarUrl,
  openUser,
  setStatus,
});

// ---- pages ----
// Left-nav switches one section at a time; the URL hash carries the page so
// a reload (or a shared link) lands where you left it. Data keeps refreshing
// every 10s regardless of the visible page — hidden sections re-render
// cheaply and the side panel lives outside the pager.
// God View is the exception: its snapshot is fetched when the page opens and
// rebuilt ONLY on demand, so the 10s refresh never touches it.
const PAGES = ['users', 'godview', 'app', 'traffic', 'reports', 'diagnostics', 'ops'];
// set by the user panel's "search rate limits" button: the subjects to load
// into the traffic page when it opens (cleared on use)
let pendingTrafficSearch = null;
// set by '#godview/<username>' links: the node to centre once the page is up
let pendingGodFocus = null;
function showPage(page) {
  const want = PAGES.includes(page) ? page : 'users';
  for (const sec of document.querySelectorAll('.page')) sec.hidden = sec.dataset.page !== want;
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.setAttribute('aria-current', btn.dataset.page === want ? 'page' : 'false');
  }
  // the graph wants the whole window; every other page keeps the reading width
  document.querySelector('.admin-main').classList.toggle('wide', want === 'godview');
  if (want === 'traffic' && pendingTrafficSearch !== null) {
    showTrafficSub('search');
    $('rl-search').value = pendingTrafficSearch;
    pendingTrafficSearch = null;
    searchRateLimits();
  }
  if (want === 'godview') {
    godView.onShow().then(() => {
      const ul = pendingGodFocus;
      pendingGodFocus = null;
      if (ul && !godView.focusUser(ul)) setStatus(`@${ul} is not in the saved snapshot — regenerate the graph`, 'error');
    }).catch((err) => setStatus(`God View failed: ${err.message}`, 'error'));
  }
}
window.addEventListener('hashchange', () => showPage(pageFromHash()));
for (const btn of document.querySelectorAll('.nav-item')) {
  btn.addEventListener('click', () => { location.hash = btn.dataset.page; });
}
// '#godview/<username>' deep-links a single node (the Shares tab and the user
// panel both offer it) — the page reads the target once it is up.
function pageFromHash() {
  const raw = location.hash.replace(/^#/, '');
  const [page, target] = raw.split('/');
  if (page === 'godview' && target) pendingGodFocus = decodeURIComponent(target).toLowerCase();
  return page;
}
showPage(pageFromHash());

refresh();
setInterval(refresh, 10000);
