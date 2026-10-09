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

const avatarUrls = new Map(); // ul -> live object URL (revoked on re-fill)

async function fillAvatarThumbs(users) {
  for (const u of users) {
    if (!u.hasAvatar) continue;
    const img = document.querySelector(`img[data-avatar-for="${CSS.escape(u.ul)}"]`);
    if (!img || img.src) continue; // absent (panel closed) or already showing
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(u.ul)}/avatar`, {
        headers: { 'x-admin-token': tokenInput.value.trim() },
      });
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const prev = avatarUrls.get(u.ul);
      if (prev) URL.revokeObjectURL(prev);
      avatarUrls.set(u.ul, url);
      img.src = url;
    } catch { /* offline/none: stays empty */ }
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
        <td><strong>@${esc(u.u)}</strong>${u.premium ? ' <span class="badge gold-badge" title="premium">★ premium</span>' : ''}<br /><span class="dim mono">${esc(u.ul)}</span></td>
        <td>${fmtDate(u.createdAt)}</td>
        <td>${u.verified
          ? '<span class="badge ok-badge">verified</span>'
          : '<span class="badge no-badge">not verified</span>'}</td>
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
  $('user-panel-body').hidden = tab === 'relations' || tab === 'blockers';
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
  renderPanel();
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
          <thead><tr><th>User</th><th>Added&nbsp;them</th><th>They&nbsp;added</th><th>Verified</th><th>Trusted</th><th>Blocked&nbsp;them</th><th>Blocked&nbsp;by</th></tr></thead>
          <tbody>${relationships.map((r) => `<tr class="${r.blocks || r.blockedBy ? 'rel-blocked' : ''}">
            <td><button class="linkish" data-view-user="${esc(r.ul)}">@${esc(r.ul)}</button>${r.premium ? ' <span class="badge gold-badge">★</span>' : ''}</td>
            <td>${mark(r.added)}</td><td>${mark(r.theyAddedMe)}</td><td>${mark(r.verified)}</td><td>${mark(r.trust)}</td>
            <td>${r.blocks ? '<span class="rel-block" title="blocked by this account">⛔</span> ' + reasonChip(r.blockReason) : '<span class="dim">—</span>'}</td>
            <td>${r.blockedBy ? '<span class="rel-block" title="this account is walled off here">⛔</span>' : '<span class="dim">—</span>'}</td>
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
            <td><button class="linkish" data-view-user="${esc(r.ul)}">@${esc(r.ul)}</button>${r.premium ? ' <span class="badge gold-badge">★</span>' : ''}</td>
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
  if (kept) {
    const img = document.querySelector(`img[data-avatar-for="${CSS.escape(u.ul)}"]`);
    if (img && !img.src) img.src = kept;
  }
}

const accountHead = (u) => `
  <div class="sec">
    <div class="pu-id"><strong>@${esc(u.u)}</strong>${u.premium ? ' <span class="badge gold-badge">★ premium</span>' : ''} <span class="dim mono">${esc(u.ul)}</span></div>
    ${(u.badges ?? []).length ? `<div class="badge-row">${u.badges.map((b) => `<button class="badge-info" data-badge-info="${esc(b.id)}" title="badge details">${badgeArt(b.id, 20)} <span>${esc(badgeDef(b.id)?.label ?? b.id)}</span></button>`).join('')}</div>` : ''}
    <div class="dim">created ${fmtDate(u.createdAt)}</div>
  </div>`;

const PANEL_SECTIONS = {
  // What the world (well — mutual friends) sees: the client's public profile.
  details: (u) => `${accountHead(u)}
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
      ${u.devices
        .map((d) => `<div class="device">
          ${d.name ? `<strong>${esc(d.name)}</strong> <span class="dim">·</span> ` : ''}<span class="mono" title="${esc(d.id)}">${esc(d.id.slice(0, 8))}…</span>
          <span class="dim">created ${fmtDate(d.createdAt)}</span>
          <span class="dim">seen ${fmtAgo(d.lastSeenAt)}</span>
          ${d.lastIp ? `<span class="dim mono">${esc(d.lastIp)}</span>` : ''}
          <button class="danger tiny" data-del-device="${esc(u.ul)}" data-device="${esc(d.id)}">remove</button>
        </div>`)
        .join('') || '<span class="dim">none</span>'}
      <p class="dim small-note">removing the LAST device deletes the account outright</p>
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
            <td><button class="badge-info" data-badge-info="${esc(d.id)}" title="badge details">${badgeArt(d.id, 26)} <span><strong>${esc(d.label)}</strong><br /><span class="dim mono">${esc(d.id)}</span></span></button></td>
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
const BADGE_ART = {
  og: (px) => `<svg viewBox="0 0 100 100" width="${px}" height="${px}"><defs><linearGradient id="ogGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8f7ff0"/><stop offset="1" stop-color="#4b3fa8"/></linearGradient></defs><rect x="4" y="4" width="92" height="92" rx="24" fill="url(#ogGrad)"/><g fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"><path d="M 51 36 A 15 15 0 1 0 51 62"/><path d="M 73 36 A 15 15 0 1 1 73 62"/></g><text x="50" y="88" text-anchor="middle" fill="#ffe9a8" font-size="20" font-weight="800" font-family="system-ui, sans-serif">OG</text></svg>`,
  earlybird: (px) => `<svg viewBox="0 0 100 100" width="${px}" height="${px}"><rect x="4" y="4" width="92" height="92" rx="24" fill="#243a4d"/><path d="M18 62 L52 48 L84 24 L60 52 L88 60 L44 70 Z" fill="#7fd4ff"/><circle cx="74" cy="70" r="7" fill="#ffd76a"/></svg>`,
  premium: (px) => `<svg viewBox="0 0 100 100" width="${px}" height="${px}"><rect x="4" y="4" width="92" height="92" rx="24" fill="#3a2f14"/><circle cx="50" cy="42" r="26" fill="#f0c04a"/><path d="M50 26 L54 36 L65 36 L56 42 L59 50 L50 45 L41 50 L44 42 L35 36 L46 36 Z" fill="#3a2f14"/><path d="M38 62 L32 88 L50 76 L68 88 L62 62" fill="#c79a2e"/></svg>`,
  teacherspet: (px) => `<svg viewBox="0 0 100 100" width="${px}" height="${px}"><rect x="4" y="4" width="92" height="92" rx="24" fill="#2c3324"/><path d="M50 40 C64 30 82 40 80 58 C78 74 64 84 50 78 C36 84 22 74 20 58 C18 40 36 30 50 40 Z" fill="#d05252"/><path d="M52 36 C56 24 68 22 74 24 C70 34 60 38 52 36 Z" fill="#4c8a4f"/><path d="M50 8 L54 18 L64 18 L56 24 L59 34 L50 28 L41 34 L44 24 L36 18 L46 18 Z" fill="#f0c04a"/></svg>`,
};
const badgeArt = (id, px) => (BADGE_ART[id] ? BADGE_ART[id](px) : `<span class="dim">?</span>`);
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
    const [users, limitsCfg, badgeDefs, diags, branding, ops] = await Promise.all([
      api('/api/admin/users'),
      api('/api/admin/limits'),
      api('/api/admin/badges'),
      api('/api/admin/diagnostics'),
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
    renderDiags(diags);
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
    <div class="badge-hero-art">${badgeArt(id, 84)}</div>
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

// ---- pages ----
// Left-nav switches one section at a time; the URL hash carries the page so
// a reload (or a shared link) lands where you left it. Data keeps refreshing
// every 10s regardless of the visible page — hidden sections re-render
// cheaply and the side panel lives outside the pager.
const PAGES = ['users', 'app', 'traffic', 'diagnostics', 'ops'];
// set by the user panel's "search rate limits" button: the subjects to load
// into the traffic page when it opens (cleared on use)
let pendingTrafficSearch = null;
function showPage(page) {
  const want = PAGES.includes(page) ? page : 'users';
  for (const sec of document.querySelectorAll('.page')) sec.hidden = sec.dataset.page !== want;
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.setAttribute('aria-current', btn.dataset.page === want ? 'page' : 'false');
  }
  if (want === 'traffic' && pendingTrafficSearch !== null) {
    showTrafficSub('search');
    $('rl-search').value = pendingTrafficSearch;
    pendingTrafficSearch = null;
    searchRateLimits();
  }
}
window.addEventListener('hashchange', () => showPage(location.hash.replace(/^#/, '')));
for (const btn of document.querySelectorAll('.nav-item')) {
  btn.addEventListener('click', () => { location.hash = btn.dataset.page; });
}
showPage(location.hash.replace(/^#/, ''));

refresh();
setInterval(refresh, 10000);
