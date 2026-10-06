// Auth view: create account, log in with the on-device identity, or pair this
// device into an existing account. All actions go through the SDK.

import { $, showView, setStatus } from '../ui.js';
import { deleteAccountData } from '../store.js';

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
    // Passkey-sealed identities need an explicit tap to unlock (WebAuthn
    // requires a user gesture); label the button accordingly.
    if (identity) {
      els.btnLogin.textContent = identity.format === 3
        ? 'Unlock with passkey'
        : `Log in as @${identity.username.toLowerCase()}`;
    }
    setStatus(els.status, '');
    renderAccounts();
  }

  // Accounts stored on THIS device: switch between them, or remove one
  // (identity + its local message data). Removal never touches the server —
  // the account survives on the other devices.
  async function renderAccounts() {
    const block = $('accounts-block');
    const list = $('account-list');
    if (!block || !list || !client.storedAccounts) return;
    let accounts = [];
    try {
      accounts = await client.storedAccounts();
    } catch { /* adapter without multi-account support */ }
    block.hidden = accounts.length === 0; // always show when anything is stored —
    // even a single (possibly server-deleted) account must be removable here.
    list.replaceChildren(...accounts.map((a) => {
      const row = document.createElement('li');
      const who = document.createElement('span');
      who.append(document.createTextNode(`@${a.username}`));
      const dev = document.createElement('span');
      dev.className = 'dim small';
      dev.textContent = ` ${String(a.deviceId).slice(0, 8)}…${a.current ? ' (active)' : ''}`;
      who.append(dev);
      const actions = document.createElement('span');
      actions.className = 'row-actions';
      if (!a.current) {
        const use = document.createElement('button');
        use.className = 'tiny';
        use.textContent = 'use';
        use.dataset.useAccount = a.username;
        actions.append(use);
      }
      const del = document.createElement('button');
      del.className = 'danger tiny';
      del.textContent = 'remove';
      del.dataset.removeAccount = a.username;
      actions.append(del);
      row.append(who, actions);
      return row;
    }));
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

    // Enter in the username field submits, like clicking the button.
    $('signup-username').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('btn-signup').click();
    });

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

    // Enter in the username field submits, like clicking the button.
    $('pair-username').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('btn-pair-start').click();
    });

    $('btn-pair-cancel').addEventListener('click', () => {
      client.cancelPairing();
      els.waiting.hidden = true;
      showMode('pair');
    });

    $('btn-forget').addEventListener('click', () =>
      guard(async () => {
        // "Clear this browser": remove EVERY account identity stored here
        // plus each account's local message data. Servers keep the accounts —
        // they can be paired/used from other devices again later.
        const accounts = await client.storedAccounts();
        for (const a of accounts) {
          await client.removeStoredAccount(a.username);
          await deleteAccountData(a.username);
        }
        applyIdentity(null);
        showMode('signup');
        setStatus(els.status, accounts.length
          ? `Removed ${accounts.length} stored account${accounts.length > 1 ? 's' : ''} and all local data from this browser.`
          : 'This browser is clean — nothing was stored.');
      }),
    );

    // Per-account use / remove (delegated; list re-renders after each action).
    $('account-list').addEventListener('click', (e) => {
      const useName = e.target.closest('[data-use-account]')?.dataset.useAccount;
      if (useName) {
        return guard(async () => {
          await client.useStoredAccount(useName);
          setStatus(els.status, 'Signing in…');
          const token = await client.login();
          await onLoggedIn({ token });
        });
      }
      const removeName = e.target.closest('[data-remove-account]')?.dataset.removeAccount;
      if (removeName) {
        return guard(async () => {
          await client.removeStoredAccount(removeName);
          await deleteAccountData(removeName);
          const next = await client.storage.loadIdentity();
          applyIdentity(next); // re-renders the list and the login button
          if (!next) { showMode('signup'); setStatus(els.status, `@${removeName} removed from this browser.`); }
        });
      }
    });
  }

  return { wire, applyIdentity, showMode };
}
