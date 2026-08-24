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

function renderUsers(users) {
  const body = $('users-body');
  $('users-empty').hidden = users.length > 0;
  body.innerHTML = users
    .map(
      (u) => `<tr>
        <td><strong>@${esc(u.u)}</strong><br /><span class="dim mono">${esc(u.ul)}</span></td>
        <td>${fmtDate(u.createdAt)}<br /><span class="dim">max ${u.maxDevices} devices</span></td>
        <td>${u.devices
          .map(
            (d) => `<div class="device">
              <span class="mono">${esc(d.id.slice(0, 8))}…</span>
              ${d.main ? '<span class="badge main">main</span>' : '<span class="badge">extra</span>'}
              <span class="dim">seen ${fmtAgo(d.lastSeenAt)}</span>
              <button class="danger tiny" data-del-device="${esc(u.ul)}" data-device="${esc(d.id)}">remove</button>
            </div>`,
          )
          .join('')}</td>
        <td><button class="danger tiny" data-del-user="${esc(u.ul)}">delete user</button></td>
      </tr>`,
    )
    .join('');
}

async function refresh() {
  try {
    const [users, limits] = await Promise.all([
      api('/api/admin/users'),
      api('/api/admin/rate-limits'),
    ]);
    renderUsers(users);
    renderLimits(limits);
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

document.addEventListener('click', (e) => {
  const clearKey = e.target.closest('[data-clear-key]')?.dataset.clearKey;
  if (clearKey) {
    return run(`Cleared ${clearKey}`, () =>
      api('/api/admin/rate-limits/clear', { method: 'POST', body: JSON.stringify({ key: clearKey }) }));
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
    if (!confirm(`Remove device ${device.slice(0, 8)}… from @${ul}?`)) return;
    return run(`Removed device from @${ul}`, () =>
      api(`/api/admin/users/${encodeURIComponent(ul)}/devices/${encodeURIComponent(device)}`, { method: 'DELETE' }));
  }
});

refresh();
setInterval(refresh, 10000);
