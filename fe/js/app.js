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

async function init() {
  const identity = await getIdentity();
  const status = $('auth-status');
  show('auth');

  if (identity) {
    $('auth-hint').hidden = true;
    $('signup-row').hidden = true;
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

init();
