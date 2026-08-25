// App bootstrap: loads the view markup, wires the view components together,
// and runs the top-level view state machine (auth <-> home <-> chat) plus the
// single-tab guard. No DOM view logic lives here — each component owns its
// own section.
import { $, show, setStatus } from './ui.js';
import { getToken, setToken } from './session.js';
import { getIdentity } from './db.js';
import { loadViews } from './views.js';
import { startSingleTabGuard } from './components/blocked.js';
import { wireAuth, resetView, applyIdentity, stopPolling } from './components/auth.js';
import { wireHome, enterHome } from './components/home.js';
import { createChat } from './components/chat.js';

const chat = createChat({
  getToken,
  getIdentity,
  onHomeRefresh: () => chat.renderConversationList(),
});

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
      chat.connect();
      await chat.renderConversationList();
      return;
    } catch {
      setToken(null);
    }
  }
}

function onLoggedIn(token, username) {
  enterHome(token, username).then(() => {
    chat.connect();
    chat.renderConversationList();
  });
}

function onLogout() {
  setToken(null);
  showAuthView();
}

function wireNewChat() {
  const open = async () => {
    const input = $('chat-peer-name');
    const username = input.value.trim();
    const status = $('home-status');
    if (username.length < 5) {
      return setStatus(status, 'Username must be at least 5 characters.', true);
    }
    setStatus(status, '');
    await chat.openChat(username);
    input.value = '';
  };
  $('btn-new-chat').addEventListener('click', open);
  $('chat-peer-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') open();
  });
}

// Markup must exist before anything touches the DOM.
await loadViews();
startSingleTabGuard();
wireAuth({ onLoggedIn, onReset: showAuthView });
wireHome({ onLogout });
wireNewChat();
chat.wire();
showAuthView();
