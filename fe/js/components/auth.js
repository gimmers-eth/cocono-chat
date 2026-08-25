// Auth view: create an account, add this device to an existing account, or log
// in with the identity already stored on this device. Owns the #view-auth
// section. Calls opts.onLoggedIn(token, username) on any successful login.
import { $, setStatus, setBusy } from '../ui.js';
import { api, ApiError } from '../api.js';
import * as cryptoLib from '../crypto.js';
import { getIdentity, saveIdentity } from '../db.js';
import { canonical } from '../util.js';

let onLoggedIn = null; // (token, username) => void
let onReset = null; // () => Promise<void> — return to the default auth view

let pollTimer = null;
let signingUp = false;
let enrolling = false;
let enrollInFlight = false;

// --- view state ---

// Restore the default (signup) layout.
export function resetView() {
  $('auth-hint').hidden = false;
  $('signup-row').hidden = false;
  $('add-device-section').hidden = false;
  $('add-device-row').hidden = true;
  $('enroll-waiting').hidden = true;
  $('enroll-status-line').textContent = 'Waiting for approval…';
}

// Configure the view for "identity present" (login) vs "no identity" (signup).
export function applyIdentity(identity) {
  const status = $('auth-status');
  if (identity) {
    $('auth-hint').hidden = true;
    $('signup-row').hidden = true;
    $('add-device-section').hidden = true;
    setStatus(status, `Keys found for @${identity.username}.`);
    $('btn-login').hidden = false;
    $('btn-login').textContent = `Log in as @${identity.username}`;
  } else {
    $('btn-login').hidden = true;
    setStatus(status, '');
  }
}

export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// --- flows ---

// Challenge-response login; returns the JWT without navigating.
async function login(identity) {
  const { n } = await api.challenge({ u: identity.username, d: identity.deviceId });
  const s = await cryptoLib.sign(identity.priv, n);
  const { token } = await api.verify({ u: identity.username, d: identity.deviceId, n, s });
  return token;
}

async function signup(username) {
  const keyPair = await cryptoLib.generateIdentityKeyPair();
  const pubRaw = await cryptoLib.exportRawPublicKey(keyPair);
  const aesExportable = await cryptoLib.generateAesKey();
  const aesRaw = await cryptoLib.exportRawAesKey(aesExportable);
  const deviceId = cryptoLib.newDeviceId();

  const t = Math.floor(Date.now() / 1000);
  const s = await cryptoLib.sign(keyPair.privateKey, canonical({ a: aesRaw, d: deviceId, p: pubRaw, t, u: username }));
  await api.signup({ u: username, p: pubRaw, a: aesRaw, d: deviceId, t, s });

  // Server has the AES key: re-import it as non-exportable and keep only the
  // CryptoKey handles — the raw bytes are discarded (M3 fix).
  const { aesEnc, aesMac } = await cryptoLib.importAesKeys(aesRaw);
  await saveIdentity({ username, deviceId, priv: keyPair.privateKey, pubRaw, aesEnc, aesMac });

  const token = await login({ username, deviceId, priv: keyPair.privateKey });
  onLoggedIn(token, username);
}

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

async function handleLogin() {
  const status = $('auth-status');
  setBusy(true);
  setStatus(status, 'Logging in…');
  try {
    const identity = await getIdentity();
    const token = await login(identity);
    onLoggedIn(token, identity.username);
  } catch (err) {
    setStatus(status, err instanceof ApiError ? err.message : String(err), true);
  } finally {
    setBusy(false);
  }
}

// --- add this device to an existing account (milestone 2) ---

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

    const t = Math.floor(Date.now() / 1000);
    const s = await cryptoLib.sign(keyPair.privateKey, canonical({ a: aesRaw, d: deviceId, p: pubRaw, t, u: username }));
    const { code, enrollId, expiresInSec } = await api.enrollDevice({ u: username, p: pubRaw, a: aesRaw, d: deviceId, t, s });

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

        stopPolling();
        $('enroll-status-line').textContent = 'Approved — logging in…';
        const { aesEnc, aesMac } = await cryptoLib.importAesKeys(aesRaw);
        await saveIdentity({ username, deviceId, priv: keyPair.privateKey, pubRaw, aesEnc, aesMac });
        const token = await login({ username, deviceId, priv: keyPair.privateKey });
        onLoggedIn(token, username);
      } catch (err) {
        stopPolling();
        const message = err instanceof ApiError ? err.message : String(err);
        await onReset().catch(() => {});
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

// --- wiring ---

export function wireAuth(opts) {
  onLoggedIn = opts.onLoggedIn;
  onReset = opts.onReset;

  $('btn-signup').addEventListener('click', submitSignup);
  $('username').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitSignup();
  });
  $('btn-login').addEventListener('click', handleLogin);

  $('btn-show-add').addEventListener('click', () => {
    $('signup-row').hidden = true;
    $('add-device-section').hidden = true;
    $('add-device-row').hidden = false;
    $('add-username').focus();
  });
  $('btn-enroll-cancel').addEventListener('click', () => onReset());
  $('btn-enroll').addEventListener('click', startEnroll);
  $('add-username').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startEnroll();
  });
}
