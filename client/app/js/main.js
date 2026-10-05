// App bootstrap: theme → SDK client → auth gate → app shell. No app data is
// fetched or encrypted outside the SDK ('/sdk/index.js' is @cocono/client,
// served by the backend from client/src).

import { CoconoClient, IdbStorage, CoconoApiError } from '/sdk/index.js';
import { $, showView, setStatus } from './ui.js';
import { initTheme } from './theme.js';
import { startSingleTabGuard } from './components/blocked.js';
import { createAuth } from './components/auth.js';
import { createHome } from './components/home.js';
import { createChat } from './components/chat.js';
import { setScope } from './store.js';
import { mountDiagnostics } from './diag.js';

// Debug console logging: flip localStorage.setItem('cocono.debug','1') or use
// ?debug=1 before load.
const logging =
  new URL(location.href).searchParams.has('debug') || localStorage.getItem('cocono.debug') === '1';

export const client = new CoconoClient({
  baseUrl: '', // same origin; the SDK derives ws(s):// from it
  storage: new IdbStorage(),
  logging,
});

const chat = createChat({ client, onHomeRefresh: () => home.renderConversationList() });
const home = createHome({ client, chat, onLogout: () => showAuth() });
const auth = createAuth({ client, onLoggedIn: () => enterApp() });

async function enterApp() {
  // Durability: ask the browser to keep our IndexedDB (identity + message
  // store) out of eviction under storage pressure. Best-effort: Chrome/
  // Android honours it (reported as persistent=true in Storage
  // diagnostics); iOS Safari has no persist() and this is a silent no-op.
  navigator.storage?.persist?.().then(
    (granted) => client.logger.debug(`storage.persist(): ${granted ? 'granted' : 'not granted'}`),
    () => {},
  );

  // Decrypt-history store and read markers are per-account: scope them to
  // the logged-in username before anything reads or writes them.
  setScope(client.username);
  showView('app');
  home.paintMe(client.username);
  home.paintConnection(client.connectionState);
  client.connect();
  await home.renderConversationList();
}

async function showAuth() {
  showView('auth');
  let identity = null;
  let loadError = null;
  try {
    identity = await client.storage.loadIdentity();
  } catch (err) {
    // e.g. IndexedDB present but the record unreadable (dropped CryptoKeys).
    loadError = err;
  }
  auth.applyIdentity(identity);
  if (!identity) auth.showMode('signup');
  if (loadError) {
    setStatus(
      $('auth-status'),
      `Saved identity could not be read (${loadError.name}: ${loadError.message}). `
        + 'The browser may have dropped its stored keys or database.',
      true,
    );
  }
}

// Boot — wire every component exactly once, then route.
startSingleTabGuard();
await initTheme(); // dark fallback already linked in index.html
mountDiagnostics({ client });

// Branding: the admin-configurable app name (see /api/app-info) fills every
// [data-app-name] slot and the document title. The baked-in defaults keep
// the page correct even if this fetch never lands.
fetch('/api/app-info')
  .then((r) => (r.ok ? r.json() : null))
  .then((info) => {
    if (!info?.name) return;
    document.title = info.name;
    for (const el of document.querySelectorAll('[data-app-name]')) el.textContent = info.name;
  })
  .catch(() => {});
chat.wire();
chat.connectEvents();
home.wire();
auth.wire();
client.on('state', ({ state }) => home.paintConnection(state));

try {
  let identity = await client.storage.loadIdentity();
  if (!identity && client.storage.listIdentities) {
    // Self-heal: the 'current' pointer was lost but a stored identity
    // survived (browser glitch / partial eviction) — re-point to it.
    const all = await client.storage.listIdentities();
    if (all.length === 1) {
      await client.storage.saveIdentity(all[0]);
      identity = all[0];
      setStatus($('auth-status'), 'Recovered the stored identity after a lost pointer.');
    }
  }
  if (identity && identity.format !== 3) {
    // Silent resume: challenge/response with the stored (non-extractable) keys.
    await client.login();
    await enterApp();
  } else {
    // No identity, or a passkey-sealed one: unsealing needs a user gesture,
    // so show the auth view (“Unlock with passkey” button).
    await showAuth();
  }
} catch (err) {
  await showAuth();
  if (err instanceof CoconoApiError) {
    setStatus(
      $('auth-status'),
      err.code === 'bad_signature'
        ? 'Stored keys are not recognised for that account — usually a URL change '
          + '(localhost vs 127.0.0.1 vs LAN IP keeps separate identities). Use the '
          + 'original URL, or "Forget this device" and pair again.'
        : err.message,
      true,
    );
  } else if (err) {
    setStatus(
      $('auth-status'),
      `Could not resume the session: ${err.message ?? String(err)} — use "Log in" to retry.`,
      true,
    );
  }
}
