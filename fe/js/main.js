// App bootstrap: loads the view markup, wires the view components together,
// and runs the top-level view state machine (auth <-> home) plus the
// single-tab guard. No DOM view logic lives here — each component owns its
// own section.
import { show } from './ui.js';
import { getToken, setToken } from './session.js';
import { getIdentity } from './db.js';
import { loadViews } from './views.js';
import { startSingleTabGuard } from './components/blocked.js';
import { wireAuth, resetView, applyIdentity, stopPolling } from './components/auth.js';
import { wireHome, enterHome } from './components/home.js';

// Show the auth view, configured for the current on-device identity. Reuses an
// existing session token when one is present.
async function showAuthView() {
  stopPolling();
  resetView();
  show('auth');
  const identity = await getIdentity();
  applyIdentity(identity);

  if (identity && getToken()) {
    try {
      await enterHome(getToken(), identity.username);
      return;
    } catch {
      setToken(null);
    }
  }
}

function onLoggedIn(token, username) {
  enterHome(token, username);
}

function onLogout() {
  setToken(null);
  showAuthView();
}

// Markup must exist before anything touches the DOM.
await loadViews();
startSingleTabGuard();
wireAuth({ onLoggedIn, onReset: showAuthView });
wireHome({ onLogout });
showAuthView();
