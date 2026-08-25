// Home view: signed-in device list, approve new devices, log out, and forget
// this device. Owns the #view-home section. Calls opts.onLogout() on logout.
import { $, show, setStatus, fmtAgo } from '../ui.js';
import { getToken, setToken } from '../session.js';
import { api, ApiError } from '../api.js';
import { clearIdentity } from '../db.js';

let onLogout = null; // () => void

// Enter the home view for an authenticated session.
export async function enterHome(token, username) {
  setToken(token);
  const me = await api.me(token);
  $('home-user').textContent = `@${me.u}`;
  $('home-device').textContent = `device ${me.d.slice(0, 8)}…`;
  show('home');
  renderDevices(token).catch(() => {});
}

async function renderDevices(token) {
  const { devices, maxDevices } = await api.devices(token);
  $('device-count').textContent = `${devices.length}/${maxDevices}`;
  const list = $('device-list');
  list.textContent = '';
  for (const dev of devices) {
    const li = document.createElement('li');
    li.textContent =
      `${dev.id.slice(0, 8)}…` +
      (dev.main ? ' · main' : '') +
      (dev.current ? ' · this device' : '') +
      ` · seen ${fmtAgo(dev.lastSeenAt)}`;
    list.appendChild(li);
  }
}

// L6 fix: show WHAT is being approved (device id + request time) and require
// explicit confirmation — a bare code entry is a social-engineering surface.
async function handleApprove() {
  const code = $('approve-code').value.trim();
  const status = $('approve-status');
  if (!/^\d{6}$/.test(code)) {
    return setStatus(status, 'Enter the 6-digit code shown on the new device.', true);
  }

  $('btn-approve').disabled = true;
  setStatus(status, 'Looking up the request…');
  try {
    const pending = await api.pendingEnrollment(getToken(), code);
    const when = pending.requestedAt ? new Date(pending.requestedAt).toLocaleString() : 'unknown time';
    const sure = confirm(
      `A device asked to join your account.\n\n` +
        `Device: ${pending.d.slice(0, 8)}…\nRequested: ${when}\n\n` +
        `Only approve if YOU just started adding a device. Approve?`,
    );
    if (!sure) {
      setStatus(status, 'Not approved.');
      return;
    }

    setStatus(status, 'Approving…');
    await api.approveDevice(getToken(), code);
    setStatus(status, 'Device approved.');
    $('approve-code').value = '';
    await renderDevices(getToken());
  } catch (err) {
    setStatus(status, err instanceof ApiError ? err.message : String(err), true);
  } finally {
    $('btn-approve').disabled = false;
  }
}

async function handleForget() {
  const sure = confirm(
    'Forget this device? This deletes your keys from this browser — without a backup you lose access to the account.',
  );
  if (!sure) return;
  await clearIdentity();
  setToken(null);
  location.reload();
}

// --- wiring ---

export function wireHome(opts) {
  onLogout = opts.onLogout;
  $('btn-approve').addEventListener('click', handleApprove);
  $('approve-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-approve').click();
  });
  $('btn-logout').addEventListener('click', () => onLogout());
  $('btn-forget').addEventListener('click', handleForget);
}
