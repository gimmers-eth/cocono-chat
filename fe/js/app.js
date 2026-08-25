import { api, ApiError } from './api.js';
import * as cryptoLib from './crypto.js';
import { clearIdentity, getIdentity, saveIdentity } from './db.js';
import { canonical } from './util.js';

const $ = (id) => document.getElementById(id);

const views = { auth: $('view-auth'), home: $('view-home'), blocked: $('view-blocked') };
function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

function setStatus(el, message, isError = false) {
  el.textContent = message ?? '';
  el.classList.toggle('error', isError);
}

function setBusy(busy) {
  for (const btn of document.querySelectorAll('button')) btn.disabled = busy;
}

// Only one active tab per device: first tab to answer a ping wins.
(function guardSingleTab() {
  const channel = new BroadcastChannel('cocono-tab');
  let claimed = false;
  channel.onmessage = (e) => {
    if (e.data === 'ping') channel.postMessage('pong');
    if (e.data === 'pong' && !claimed) show('blocked');
  };
  channel.postMessage('ping');
  setTimeout(() => {
    claimed = true;
  }, 250);
})();

function setToken(token) {
  if (token) sessionStorage.setItem('cocono.token', token);
  else sessionStorage.removeItem('cocono.token');
}
const getToken = () => sessionStorage.getItem('cocono.token');

async function enterHome(token, username) {
  setToken(token);
  const me = await api.me(token);
  $('home-user').textContent = `@${me.u}`;
  $('home-device').textContent = `device ${me.d.slice(0, 8)}…`;
  show('home');
  renderDevices(token).catch(() => {});
}

function fmtAgo(v) {
  if (!v) return 'never';
  const sec = Math.max(0, (Date.now() - new Date(v).getTime()) / 1000);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
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

async function login(identity) {
  const { n } = await api.challenge({ u: identity.username, d: identity.deviceId });
  const s = await cryptoLib.sign(identity.priv, n);
  const { token } = await api.verify({ u: identity.username, d: identity.deviceId, n, s });
  await enterHome(token, identity.username);
}

async function signup(username) {
  const keyPair = await cryptoLib.generateIdentityKeyPair();
  const pubRaw = await cryptoLib.exportRawPublicKey(keyPair);
  const aesExportable = await cryptoLib.generateAesKey();
  const aesRaw = await cryptoLib.exportRawAesKey(aesExportable);
  const deviceId = cryptoLib.newDeviceId();

  const s = await cryptoLib.sign(keyPair.privateKey, canonical({ a: aesRaw, d: deviceId, p: pubRaw, u: username }));
  await api.signup({ u: username, p: pubRaw, a: aesRaw, d: deviceId, s });

  // Server has the AES key: re-import it as non-exportable and keep it.
  const { aesEnc, aesMac } = await cryptoLib.importAesKeys(aesRaw);
  await saveIdentity({
    username,
    deviceId,
    priv: keyPair.privateKey,
    pubRaw,
    aesRaw,
    aesEnc,
    aesMac,
  });

  await login({ username, deviceId, priv: keyPair.privateKey });
}

let pollTimer = null;
function stopEnrollPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function init() {
  stopEnrollPolling();
  const identity = await getIdentity();
  const status = $('auth-status');
  show('auth');

  // Reset the auth view to its default (signup) layout.
  $('auth-hint').hidden = false;
  $('signup-row').hidden = false;
  $('add-device-section').hidden = false;
  $('add-device-row').hidden = true;
  $('enroll-waiting').hidden = true;
  $('enroll-status-line').textContent = 'Waiting for approval…';

  if (identity) {
    $('auth-hint').hidden = true;
    $('signup-row').hidden = true;
    $('add-device-section').hidden = true;
    setStatus(status, `Keys found for @${identity.username}.`);
    $('btn-login').hidden = false;
    $('btn-login').textContent = `Log in as @${identity.username}`;

    // Existing session? Reuse it.
    if (getToken()) {
      try {
        await enterHome(getToken(), identity.username);
        return;
      } catch {
        setToken(null);
      }
    }
  } else {
    $('btn-login').hidden = true;
    setStatus(status, '');
  }
}

let signingUp = false;
async function submitSignup() {
  if (signingUp) return;

  const username = $('username').value.trim();
  const status = $('auth-status');
  if (username.length < 5) return setStatus(status, 'Username must be at least 5 characters.', true);

  signingUp = true;
  setBusy(true);
  setStatus(status, 'Creating account…');
  try {
    await signup(username);
  } catch (err) {
    setStatus(status, err instanceof ApiError ? err.message : String(err), true);
  } finally {
    signingUp = false;
    setBusy(false);
  }
}

$('btn-signup').addEventListener('click', submitSignup);
$('username').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitSignup();
});

$('btn-login').addEventListener('click', async () => {
  const status = $('auth-status');
  setBusy(true);
  setStatus(status, 'Logging in…');
  try {
    await login(await getIdentity());
  } catch (err) {
    setStatus(status, err instanceof ApiError ? err.message : String(err), true);
  } finally {
    setBusy(false);
  }
});

$('btn-logout').addEventListener('click', () => {
  setToken(null);
  init();
});

$('btn-forget').addEventListener('click', async () => {
  const sure = confirm(
    'Forget this device? This deletes your keys from this browser — without a backup you lose access to the account.',
  );
  if (!sure) return;
  await clearIdentity();
  setToken(null);
  location.reload();
});

// --- Adding this device to an existing account (milestone 2) ---

$('btn-show-add').addEventListener('click', () => {
  $('signup-row').hidden = true;
  $('add-device-section').hidden = true;
  $('add-device-row').hidden = false;
  $('add-username').focus();
});

$('btn-enroll-cancel').addEventListener('click', () => init());

let enrolling = false;
let enrollInFlight = false;

async function startEnroll() {
  if (enrolling) return;

  const username = $('add-username').value.trim();
  const status = $('auth-status');
  if (username.length < 5) return setStatus(status, 'Username must be at least 5 characters.', true);

  enrolling = true;
  $('btn-enroll').disabled = true;
  setStatus(status, 'Requesting pairing code…');
  try {
    const keyPair = await cryptoLib.generateIdentityKeyPair();
    const pubRaw = await cryptoLib.exportRawPublicKey(keyPair);
    const aesExportable = await cryptoLib.generateAesKey();
    const aesRaw = await cryptoLib.exportRawAesKey(aesExportable);
    const deviceId = cryptoLib.newDeviceId();

    const s = await cryptoLib.sign(
      keyPair.privateKey,
      canonical({ a: aesRaw, d: deviceId, p: pubRaw, u: username }),
    );
    const { code, enrollId, expiresInSec } = await api.enrollDevice({
      u: username, p: pubRaw, a: aesRaw, d: deviceId, s,
    });

    $('add-device-row').hidden = true;
    $('enroll-waiting').hidden = false;
    $('enroll-code').textContent = code;
    setStatus(status, '');

    const deadline = Date.now() + expiresInSec * 1000;
    pollTimer = setInterval(async () => {
      if (enrollInFlight) return;
      enrollInFlight = true;
      try {
        if (Date.now() > deadline) {
          throw new ApiError(410, { message: 'Pairing code expired — try again.' });
        }
        const st = await api.enrollStatus(enrollId);
        if (!st.approved) return;

        stopEnrollPolling();
        $('enroll-status-line').textContent = 'Approved — logging in…';
        const { aesEnc, aesMac } = await cryptoLib.importAesKeys(aesRaw);
        await saveIdentity({
          username, deviceId, priv: keyPair.privateKey, pubRaw, aesRaw, aesEnc, aesMac,
        });
        await login({ username, deviceId, priv: keyPair.privateKey });
      } catch (err) {
        stopEnrollPolling();
        const message = err instanceof ApiError ? err.message : String(err);
        await init().catch(() => {});
        setStatus($('auth-status'), message, true);
      } finally {
        enrollInFlight = false;
      }
    }, 2000);
  } catch (err) {
    setStatus(status, err instanceof ApiError ? err.message : String(err), true);
  } finally {
    enrolling = false;
    $('btn-enroll').disabled = false;
  }
}

$('btn-enroll').addEventListener('click', startEnroll);
$('add-username').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startEnroll();
});

// --- Approving a new device from this (existing) device ---

$('btn-approve').addEventListener('click', async () => {
  const code = $('approve-code').value.trim();
  const status = $('approve-status');
  if (!/^\d{6}$/.test(code)) {
    return setStatus(status, 'Enter the 6-digit code shown on the new device.', true);
  }

  $('btn-approve').disabled = true;
  setStatus(status, 'Approving…');
  try {
    await api.approveDevice(getToken(), code);
    setStatus(status, 'Device approved.');
    $('approve-code').value = '';
    await renderDevices(getToken());
  } catch (err) {
    setStatus(status, err instanceof ApiError ? err.message : String(err), true);
  } finally {
    $('btn-approve').disabled = false;
  }
});

$('approve-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-approve').click();
});

init();
