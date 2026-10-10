// Auth view: create account, log in with the on-device identity, or pair this
// device into an existing account. All actions go through the SDK.

import { $, showView, setStatus, confirmModal } from '../ui.js';
import { deleteAccountData } from '../store.js';
import { referrerForSignup } from '../shares.js';

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
    if (identity) els.btnLogin.textContent = `Log in as ${identity.username.toLowerCase()}`;
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
      who.append(document.createTextNode(`${a.username}`));
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
      // vs LAN IP) — each origin has its own IndexedDB identity — OR this
      // device was removed from the account (detach/last-device deletion).
      if (err?.code === 'bad_signature') {
        setStatus(
          els.status,
          'These browser keys are not recognised for that account. Either the URL changed '
            + '(each of localhost / 127.0.0.1 / the LAN IP keeps its own keys — use the '
            + 'original URL), or this device has been REMOVED from the account. If another '
            + 'device remains, re-pair with a code; otherwise "Forget this device" and sign up afresh.',
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
        if (username.length < 4) throw new Error('Username must be at least 4 characters.');
        setStatus(els.status, 'Creating account and keys on this device…');
        // If this signup followed someone's /?chat= link, the server records
        // that account as this one's parent (admin Shares tab + God View).
        // Unsigned, unrewarded, best-effort — never able to fail the signup.
        const res = await client.register(username, { referrer: referrerForSignup(username) });
        // FRESH identity: a brand-new keypair/device — main.js purges any
        // local data this username's PREVIOUS owner left behind (see
        // store.ensureScoped). signedUp marks the ACCOUNT as new too (pairing
        // is also 'fresh' but joins an existing account, which must not
        // suppress that link's 'seen' report).
        await onLoggedIn({ ...res, fresh: true, signedUp: true });
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
        if (username.length < 4) throw new Error('Username must be at least 4 characters.');
        const { code } = await client.beginPairing(username);
        $('pair-code').textContent = code;
        $('pair-hint').textContent = 'Waiting for approval…';
        els.signup.hidden = true;
        els.pair.hidden = true;
        els.waiting.hidden = false;

        // Resolves once an existing device approves the code.
        const res = await client.completePairing({ pollIntervalMs: 2000 });
        await onLoggedIn({ ...res, fresh: true }); // new device identity too
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
        return guard(async () => await removeWithWarning(removeName));
      }
    });
  }

  // Probe an account's device roster: switch to it (if needed) and log in,
  // KEEPING the session so a confirmed removal can detach this device on the
  // server right away. count=null => account unreachable (deleted
  // server-side: a local zombie record). Caller must logOutRestore regardless.
  async function probeAccount(username) {
    const accounts = await client.storedAccounts();
    const prev = accounts.find((a) => a.current)?.username ?? null;
    try {
      if (prev !== username) await client.useStoredAccount(username);
      await client.login();
      const { devices } = await client.devices();
      return { count: devices.length, prev };
    } catch {
      return { count: null, prev };
    }
  }

  async function logOutRestore(prev) {
    client.logout();
    if (prev) {
      try { await client.useStoredAccount(prev); } catch { /* ignore */ }
    }
  }

  async function removeWithWarning(removeName) {
    const { count, prev } = await probeAccount(removeName);
    let title = `Remove ${removeName}?`;
    let body;
    let okLabel = 'Remove';
    let danger = false;
    if (count === 1) {
      // Only device: detaching it server-side leaves the account ORPHANED —
      // username still reserved, but no device can sign in or approve
      // pairing, and there is no recovery yet.
      title = `Delete ${removeName}?`;
      body = 'This browser holds @' + removeName + "'s ONLY device. Removing it deletes the "
        + 'account on the server as well (accounts with no devices are not kept): every message '
        + 'is gone and the username becomes free to register again.';
      okLabel = 'Remove and delete the account';
      danger = true;
    } else if (count === null) {
      body = `Could not reach ${removeName}'s account (it may already be deleted on the server). `
        + 'Its keys and local messages will be erased from this browser only.';
      danger = true;
    } else {
      body = 'This browser will be REMOVED as a device of @' + removeName + ' (server-side, '
        + 'effective immediately) and forgotten here. The account stays usable on its other '
        + (count - 1) + ' device(s).';
      okLabel = 'Remove this device';
    }
    if (!(await confirmModal({ title, body, okLabel, danger }))) {
      await logOutRestore(prev);
      applyIdentity(await client.storage.loadIdentity());
      return;
    }
    if (count !== null) {
      try {
        await client.detachCurrentDevice();
      } catch (err) {
        setStatus(els.status, `Removed locally, but the server detach failed: ${err?.message ?? err} `
          + '\u2014 the device stays listed until removed from another device\u2019s Settings.');
      }
    }
    await client.removeStoredAccount(removeName);
    await deleteAccountData(removeName);
    await logOutRestore(prev === removeName ? null : prev);
    const next = await client.storage.loadIdentity();
    applyIdentity(next);
    if (!next) {
      showMode('signup');
      if (!els.status.textContent) {
        setStatus(els.status, `${removeName} removed from this browser`
          + (count === 1 ? ' and its account deleted on the server.' : '.'));
      }
    }
  }

  return { wire, applyIdentity, showMode };
}
