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
  showView('app');
  home.paintMe(client.username);
  home.paintConnection(client.connectionState);
  client.connect();
  await home.renderConversationList();
}

async function showAuth() {
  showView('auth');
  const identity = await client.storage.loadIdentity();
  auth.applyIdentity(identity);
  if (!identity) auth.showMode('signup');
}

// Boot — wire every component exactly once, then route.
startSingleTabGuard();
await initTheme(); // dark fallback already linked in index.html
chat.wire();
chat.connectEvents();
home.wire();
auth.wire();
client.on('state', ({ state }) => home.paintConnection(state));

try {
  const identity = await client.storage.loadIdentity();
  if (identity) {
    // Silent resume: challenge/response with the stored (non-extractable) keys.
    await client.login();
    await enterApp();
  } else {
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
  }
}
