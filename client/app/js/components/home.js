// Home: sidebar chrome (identity, connection state, log out), conversation
// list, new-chat launcher and the devices panel (list + approve pairing +
// theme picker).

import { $, setStatus, fmtTime, confirmModal } from '../ui.js';
import { createPeerSuggestions } from './peers.js';
import { iconEl } from '../icons.js';
import { allMessages, isUnread, loadFriends, loadPins, clearLocalTrustData } from '../store.js';
import { PS, resolvePeerState, peerStateIcon } from './peername.js';
import { refreshSettingsUI } from '../install.js';
import { loadRegistry, applyTheme, savedTheme, wireThemeSelect } from '../theme.js';

const MSG_STATE_ICON = { sending: 'stateSending', sent: 'stateSent', delivered: 'stateDelivered', failed: 'stateFailed' };

export function createHome({ client, chat, onLogout }) {
  let settingsOpen = false;

  function openSettings() {
    if (settingsOpen) return;
    settingsOpen = true;
    $('drawer-overlay').hidden = false;
    $('settings-drawer').hidden = false;
    renderDevices();
    refreshSettingsUI();
    wireThemePicker();
    $('btn-settings-close').focus?.();
  }

  function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    $('settings-drawer').hidden = true;
    $('drawer-overlay').hidden = true;
  }

  function paintMe(username) {
    username = username.toLowerCase(); // display is always lowercase
    $('me-name').textContent = username;
    $('me-avatar').textContent = username.slice(0, 1);
  }

  function paintConnection(state) {
    const dot = $('ws-dot');
    dot.className = 'dot ' + (state === 'open' ? 'dot-on' : state === 'connecting' ? 'dot-busy' : 'dot-off');
    dot.title = state;
  }

  async function renderConversationList() {
    const list = $('conversation-list');
    const [all, friends, pins] = await Promise.all([allMessages(), loadFriends(), loadPins()]);
    const latestByPeer = new Map();
    for (const m of all) {
      const cur = latestByPeer.get(m.peer);
      if (!cur || m.ts > cur.ts) latestByPeer.set(m.peer, m);
    }
    // Friends are REAL entries even with zero messages: clearing a chat (or
    // never having written one) must never drop them from the menu.
    for (const f of friends) if (!latestByPeer.has(f.peer)) latestByPeer.set(f.peer, null);
    const entries = [...latestByPeer.entries()].sort((a, b) => {
      if (!a[1] && !b[1]) return a[0].localeCompare(b[0]);
      if (!a[1]) return 1; // message-less friends sit below the active list
      if (!b[1]) return -1;
      return b[1].ts - a[1].ts;
    });
    const frag = document.createDocumentFragment();
    for (const [peer, last] of entries) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = peer.slice(0, 1);
      const meta = document.createElement('span');
      meta.className = 'convo-meta';
      const name = document.createElement('span');
      name.className = 'convo-name';
      // header identity mark (sidebar): solid user = you; user-slash +
      // italic = deleted friend; green outlined user = trusted binding;
      // red person-with-an-x = everyone else (stranger/unbound/stale)
      const selfUl = String(client.username ?? '').toLowerCase();
      const ent = friends.find((f) => f.peer === peer);
      const pin = pins.find((p) => p.peer === peer);
      // one shared ladder: red (not added/conflict) → orange (added, not
      // verified) → green (verified) → blue (trusted); slash+italic = gone
      const state = resolvePeerState({
        isSelf: peer === selfUl,
        gone: !!ent?.gone,
        bound: !!ent?.trusted,
        verified: !!ent?.verified,
        trusted: !!ent?.trust,
        conflict: !!pin && !!ent?.pub && pin.p !== ent.pub,
      });
      name.replaceChildren(peerStateIcon(state));
      name.append(peer);
      name.classList.toggle('gone', state === PS.GONE);
      const preview = document.createElement('span');
      preview.className = 'convo-last';
      preview.textContent = '';
      if (last === null) {
        // message-less friend entry (or empty chat): plain italic placeholder
        preview.classList.add('empty');
        preview.textContent = 'No messages';
      } else {
        if (last.dir === 'out') {
          preview.append('You: ');
          preview.append(iconEl(MSG_STATE_ICON[last.state] ?? 'stateSending', last.state === 'failed' ? 'icon-danger' : ''));
          preview.append(' ');
        }
        preview.append(last.text ?? '');
      }
      meta.append(name, preview);
      const side = document.createElement('span');
      side.className = 'convo-side';
      const time = document.createElement('span');
      time.className = 'convo-time';
      time.textContent = last === null ? '—' : fmtTime(last.ts);
      side.appendChild(time);
      if (last !== null && isUnread(peer, last.ts)) {
        const dot = document.createElement('span');
        dot.className = 'unread';
        side.appendChild(dot);
      }
      btn.append(av, meta, side);
      btn.addEventListener('click', () => chat.openChat(peer));
      li.appendChild(btn);
      frag.appendChild(li);
    }
    list.replaceChildren(frag);
  }

  async function renderDevices() {
    const list = $('device-list');
    // Drawer actions report INSIDE the drawer — #home-status is behind the scrim.
    const status = $('drawer-status');
    try {
      const { devices, maxDevices } = await client.devices();
      const frag = document.createDocumentFragment();
      for (const dev of devices) {
        const li = document.createElement('li');
        const id = document.createElement('span');
        id.textContent = dev.id.slice(0, 8) + '…';
        const tag = document.createElement('span');
        tag.className = 'dim';
        tag.textContent = [dev.current && 'this device', dev.main && 'main', `${maxDevices} max`]
          .filter(Boolean)
          .join(' · ');
        li.append(id, tag);
        if (!dev.current) {
          // Self-removal lives on the login screen ("remove account from this
          // browser"); from settings you detach OTHER devices (e.g. lost phone).
          const btn = document.createElement('button');
          btn.className = 'btn btn-small';
          btn.textContent = 'remove';
          btn.dataset.removeDevice = dev.id;
          li.append(btn);
        }
        frag.appendChild(li);
      }
      list.replaceChildren(frag);
      setStatus(status, '');
    } catch (err) {
      setStatus(status, err.message ?? String(err), true);
    }
  }

  // --- approve a pairing code coming from a NEW device ---

  function wireApproveCode() {
    const input = $('approve-input');
    const reviewBtn = $('btn-approve');
    const confirmBtn = $('btn-approve-confirm');
    const preview = $('approve-preview');
    // Pairing-code feedback belongs in the drawer, not the hidden sidebar.
    const status = $('drawer-status');
    let codeInReview = null;

    async function review() {
      const code = input.value.trim();
      if (!/^\d{6}$/.test(code)) return setStatus(status, 'Pairing codes are 6 digits.', true);
      try {
        const p = await client.pendingPairing(code);
        codeInReview = code;
        preview.hidden = false;
        preview.textContent = `Device "${p.d.slice(0, 8)}…" requests access (requested ${p.requestAt ?? p.requestedAt}).`;
        confirmBtn.hidden = false;
        setStatus(status, '');
      } catch (err) {
        preview.hidden = true;
        confirmBtn.hidden = true;
        setStatus(status, err.message ?? String(err), true);
      }
    }

    reviewBtn.addEventListener('click', review);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && review());

    confirmBtn.addEventListener('click', async () => {
      if (!codeInReview) return;
      try {
        await client.approvePairing(codeInReview);
        setStatus(status, 'Device approved — it will log in any moment.');
        input.value = '';
        preview.hidden = true;
        confirmBtn.hidden = true;
        codeInReview = null;
        renderDevices();
      } catch (err) {
        setStatus(status, err.message ?? String(err), true);
      }
    });
  }

  async function wireThemePicker() {
    const select = $('theme-select');
    try {
      const registry = await loadRegistry();
      wireThemeSelect(select, registry, savedTheme() ?? registry.default, () => {});
    } catch {
      // The <link> fallback in index.html already applied a theme.
      select.hidden = true;
    }
  }

  function wire() {
    // 'New chat' shows the users known on this device, filtered by typing;
    // tapping one opens that conversation directly.
    const peerInput = $('chat-peer-name');
    const newChat = createPeerSuggestions($('chat-peer-suggestions'), { max: 3, floating: true });
    newChat.wireInput(peerInput, (p) => {
      peerInput.value = '';
      newChat.paint();
      chat.openChat(p);
    });

    $('btn-logout').addEventListener('click', () => {
      client.logout();
      // logout wipes device-local trust: friends mirror (refetched at next
      // login) + identity pins + verified flags (see store.clearLocalTrustData)
      clearLocalTrustData().catch(() => {});
      onLogout();
    });

    // Settings drawer: opens from the top over a click-to-dismiss scrim.
    $('btn-devices').addEventListener('click', openSettings);
    $('btn-settings-close').addEventListener('click', closeSettings);
    $('drawer-overlay').addEventListener('click', closeSettings);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSettings();
    });
  
    const openNew = async () => {
      const input = $('chat-peer-name');
      const username = input.value.trim();
      if (username.length < 4) return setStatus($('home-status'), 'Username must be at least 4 characters.', true);
      await chat.openChat(username);
      input.value = '';
      newChat.dismiss(); // Enter/button both collapse the dropdown
    };
    $('btn-new-chat').addEventListener('click', openNew);
    $('chat-peer-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openNew();
    });

    // Detach another device (lost phone, old laptop) from this account.
    $('device-list').addEventListener('click', async (e) => {
      const deviceId = e.target.closest('[data-remove-device]')?.dataset.removeDevice;
      if (!deviceId) return;
      const ok = await confirmModal({
        title: 'Remove this device?',
        body: `Device ${deviceId.slice(0, 8)}… will lose access to this account ` 
          + 'immediately (its sign-in stops working and queued messages for it are '
          + 'deleted). This cannot be undone from that device.',
        okLabel: 'Remove device',
        danger: true,
      });
      if (!ok) return;
      try {
        await client.removeDevice(deviceId);
        setStatus($('drawer-status'), `Device ${deviceId.slice(0, 8)}… removed.`);
      } catch (err) {
        setStatus($('drawer-status'), `Could not remove device: ${err?.message ?? err}`);
      }
      renderDevices();
    });

    wireApproveCode();
  }

  return { wire, paintMe, paintConnection, renderConversationList, renderDevices };
}
