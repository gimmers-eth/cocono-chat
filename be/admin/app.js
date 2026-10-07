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

async function fillAvatarThumbs(users) {
  for (const u of users) {
    if (!u.hasAvatar) continue;
    const img = document.querySelector(`img[data-avatar-for="${CSS.escape(u.ul)}"]`);
    if (!img) continue;
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(u.ul)}/avatar`, {
        headers: { 'x-admin-token': tokenInput.value.trim() },
      });
      if (!res.ok) throw new Error(String(res.status));
      img.src = URL.createObjectURL(await res.blob());
    } catch { /* offline/none: stays empty */ }
  }
}

function renderUsers(users) {
  lastUsers = users;
  const body = $('users-body');
  $('users-empty').hidden = users.length > 0;
  body.innerHTML = users
    .map(
      (u) => `<tr>
        <td><strong>@${esc(u.u)}</strong><br /><span class="dim mono">${esc(u.ul)}</span></td>
        <td>${fmtDate(u.createdAt)}</td>
        <td><input type="checkbox" class="verify-toggle" data-verify="${esc(u.ul)}" ${u.verified ? 'checked' : ''} title="${u.verified && u.verifiedAt ? 'verified ' + esc(fmtDate(u.verifiedAt)) : 'not verified'}" /></td>
        <td>${u.hasAvatar
          ? `<img class="avatar-thumb" data-avatar-for="${esc(u.ul)}" alt="profile photo" title="Click to enlarge" />`
          : '<span class="dim">no photo</span>'}</td>
        <td>${u.idDoc
          ? `<span class="dim">${esc(u.idDoc.contentType.replace('image/', ''))} · ${fmtDate(u.idDoc.uploadedAt)}</span><br />
             <button class="tiny" data-view-id="${esc(u.ul)}">view</button>
             <button class="danger tiny" data-del-id="${esc(u.ul)}">delete photo</button>`
          : '<span class="dim">none</span>'}</td>
        <td>
          <input type="number" min="1" max="1000" value="${u.maxDevices}" class="max-devices" data-max-for="${esc(u.ul)}" />
          <button class="tiny" data-set-max="${esc(u.ul)}">set</button>
        </td>
        <td>${u.devices
          .map(
            (d) => `<div class="device">
              <span class="mono">${esc(d.id.slice(0, 8))}…</span>
              <span class="dim">seen ${fmtAgo(d.lastSeenAt)}</span>
              <button class="danger tiny" data-del-device="${esc(u.ul)}" data-device="${esc(d.id)}">remove</button>
            </div>`,
          )
          .join('')}</td>
        <td><button class="danger tiny" data-del-user="${esc(u.ul)}">delete user</button></td>
      </tr>`,
    )
    .join('');
  fillAvatarThumbs(users).catch(() => {});
}

let lastDiags = [];
let lastUsers = [];

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
  const name = b.appName ?? b.defaultName ?? 'co.co.no';
  document.title = `${name} admin`;
  const title = $('admin-title');
  if (title) title.textContent = `${name} — internal admin`;
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
    const [users, limits, diags, branding, ops] = await Promise.all([
      api('/api/admin/users'),
      api('/api/admin/rate-limits'),
      api('/api/admin/diagnostics'),
      api('/api/admin/branding'),
      api('/api/admin/ops'),
    ]);
    // Don't clobber the row being edited: skip the users table re-render
    // while a max-devices input has focus.
    if (!document.activeElement?.classList?.contains('max-devices')) {
      renderUsers(users);
    }
    renderLimits(limits);
    renderDiags(diags);
    renderBranding(branding);
    renderOps(ops);
    $('updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
    setStatus('');
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

$('btn-clear-ip').addEventListener('click', () => {
  const ip = $('clear-ip').value.trim();
  if (!ip) return setStatus('Enter an IP address first', 'error');
  run(`Cleared rate limits for ${ip}`, () =>
    api('/api/admin/rate-limits/clear', { method: 'POST', body: JSON.stringify({ ip }) }));
  $('clear-ip').value = '';
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

document.addEventListener('click', (e) => {
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
document.addEventListener('change', (e) => {
  const ul = e.target.closest?.('.verify-toggle')?.dataset.verify;
  if (!ul) return;
  const on = e.target.checked === true;
  run(`@${ul} ${on ? 'marked verified' : 'verification revoked'}`, () =>
    api(`/api/admin/users/${encodeURIComponent(ul)}/verified`, {
      method: 'PUT', body: JSON.stringify({ verified: on }),
    }));
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

refresh();
setInterval(refresh, 10000);
