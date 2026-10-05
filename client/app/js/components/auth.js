// Auth view: create account, log in with the on-device identity, or pair this
// device into an existing account. All actions go through the SDK.

import { $, showView, setStatus } from '../ui.js';

export function createAuth({ client, onLoggedIn }) {
  const els = {
    login: $('auth-login'),
    signup: $('auth-signup'),
    pair: $('auth-pair'),
    waiting: $('pair-waiting'),
    status: $('auth-status'),
    btnLogin: $('btn-login'),
  };

  function applyIdentity(identity) {
    els.login.hidden = !identity;
    els.signup.hidden = Boolean(identity);
    els.pair.hidden = Boolean(identity);
    els.waiting.hidden = true;
    $('btn-show-pair').hidden = Boolean(identity);
    $('btn-show-signup').hidden = Boolean(identity);
    if (identity) els.btnLogin.textContent = `Log in as @${identity.username}`;
    setStatus(els.status, '');
  }

  function showMode(mode) {
    els.signup.hidden = mode !== 'signup';
    els.pair.hidden = mode !== 'pair';
    setStatus(els.status, '');
  }

  async function guard(fn) {
    setStatus(els.status, '');
    try {
      await fn();
    } catch (err) {
      // The BE intentionally answers 'Nonce signature does not verify' for
      // both forged and unknown-device logins (enumeration protection). On a
      // browser this usually means: you switched URL (localhost vs 127.0.0.1
      // vs LAN IP) — each origin has its own IndexedDB identity.
      if (err?.code === 'bad_signature') {
        setStatus(
          els.status,
          'These browser keys are not recognised for that account. Did you change the URL '
            + '(localhost vs 127.0.0.1 vs the LAN IP)? Each URL keeps its own keys — use the '
            + 'original URL, or "Forget this device" and pair again.',
          true,
        );
        return;
      }
      setStatus(els.status, err?.message ?? String(err), true);
    }
  }

  function wire() {
    $('btn-show-signup').addEventListener('click', () => showMode('signup'));
    $('btn-show-pair').addEventListener('click', () => showMode('pair'));

    $('btn-signup').addEventListener('click', () =>
      guard(async () => {
        const username = $('signup-username').value.trim();
        if (username.length < 5) throw new Error('Username must be at least 5 characters.');
        setStatus(els.status, 'Creating account and keys on this device…');
        const res = await client.register(username);
        await onLoggedIn(res);
      }),
    );

    els.btnLogin.addEventListener('click', () =>
      guard(async () => {
        setStatus(els.status, 'Signing in…');
        const token = await client.login();
        await onLoggedIn({ token });
      }),
    );

    $('btn-pair-start').addEventListener('click', () =>
      guard(async () => {
        const username = $('pair-username').value.trim();
        if (username.length < 5) throw new Error('Username must be at least 5 characters.');
        const { code } = await client.beginPairing(username);
        $('pair-code').textContent = code;
        $('pair-hint').textContent = 'Waiting for approval…';
        els.signup.hidden = true;
        els.pair.hidden = true;
        els.waiting.hidden = false;

        // Resolves once an existing device approves the code.
        const res = await client.completePairing({ pollIntervalMs: 2000 });
        await onLoggedIn(res);
      }).catch(() => {}),
    );

    $('btn-pair-cancel').addEventListener('click', () => {
      client.cancelPairing();
      els.waiting.hidden = true;
      showMode('pair');
    });

    $('btn-forget').addEventListener('click', async () => {
      await client.forget();
      applyIdentity(null);
      showMode('signup');
      setStatus(els.status, 'This device forgot its keys.');
    });
  }

  return { wire, applyIdentity, showMode };
}
