// Home: sidebar chrome (identity, connection state, log out), conversation
// list, new-chat launcher and the devices panel (list + approve pairing +
// theme picker).

import { $, setStatus, fmtTime, confirmModal } from '../ui.js';
import { createPeerSuggestions } from './peers.js';
import { iconEl } from '../icons.js';
import { allMessages, isUnread, loadFriends, loadPins, clearLocalTrustData, loadPeerVerifications } from '../store.js';
import { PS, resolvePeerState, peerStateIcon, unverifiedBadgeEl } from './peername.js';
import { refreshSettingsUI } from '../install.js';
import { loadRegistry, applyTheme, savedTheme, wireThemeSelect } from '../theme.js';

const MSG_STATE_ICON = { sending: 'stateSending', sent: 'stateSent', delivered: 'stateDelivered', failed: 'stateFailed' };

export function createHome({ client, chat, onLogout }) {
  let settingsOpen = false;

  // ---- settings drawer tabs ----
  const SETTINGS_TABS = ['devices', 'verify', 'general', 'diagnostics'];
  let settingsTab = 'devices';
  try { settingsTab = localStorage.getItem('cocono.settings.tab') || 'devices'; } catch { /* private mode */ }
  if (!SETTINGS_TABS.includes(settingsTab)) settingsTab = 'devices';

  function showSettingsTab() {
    for (const t of SETTINGS_TABS) {
      const panel = $(`tabpanel-${t}`);
      if (panel) panel.hidden = t !== settingsTab;
    }
    for (const btn of document.querySelectorAll('.drawer-tab')) {
      const on = btn.dataset.tab === settingsTab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
    }
  }

  function selectSettingsTab(tab) {
    settingsTab = SETTINGS_TABS.includes(tab) ? tab : 'devices';
    try { localStorage.setItem('cocono.settings.tab', settingsTab); } catch { /* private mode */ }
    showSettingsTab();
  }

  function openSettings(tab) {
    if (settingsOpen && tab) selectSettingsTab(tab); // deep-link while open
    if (!settingsOpen) {
      settingsOpen = true;
      $('drawer-overlay').hidden = false;
      $('settings-drawer').hidden = false;
      renderDevices();
      refreshSettingsUI();
      wireThemePicker();
      $('btn-settings-close').focus?.();
    }
    showSettingsTab();
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
    renderIdentity();
  }

  // --- identity verification (admin-checked real person; red notice until done) ---
  // Entry points: the "Get verified" link next to our own name, and the
  // settings drawer section. Unverified is the DEFAULT. (The admin can also
  // verify an account directly — internal ops capability, not advertised
  // in user-facing copy.)
  async function renderIdentity() {
    const state = $('idverify-state');
    const btn = $('btn-id-doc');
    const link = $('btn-self-verify');
    let me = null;
    try { me = await client.identity(); } catch { /* offline/no session */ }
    if (!me) {
      // no facts fetched: hide all affordances, assume nothing
      link.hidden = true; btn.hidden = true; return;
    }
    $('me-verify-badge').replaceChildren(); // no badge on our own name;
    // the "Get verified" link conveys the unverified state
    link.hidden = !!me.verified; // the top-left entry only while unverified
    if (me.verified) {
      btn.hidden = true;
      if (state) state.textContent = 'Verified — the red notice no longer appears next to your name.';
      return;
    }
    if (me.idDoc) {
      btn.hidden = false; // re-upload allowed before review
      if (state) state.textContent = `ID photo submitted ${new Date(me.idDoc.uploadedAt).toLocaleDateString()} — waiting for review.`;
      return;
    }
    btn.hidden = false;
    if (state) state.textContent = 'Not verified. Upload a photo of your ID so a human can confirm this account is really you.';
  }

  // magic-byte sniffing matches the server (PNG signature; JPEG SOI+EOI):
  // reject junk locally for instant feedback, but the server re-checks —
  // client checks are courtesy, never trust.
  async function sniffFile(file) {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
      && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) return 'image/png';
    if (file.size < 4) return null;
    const tail = new Uint8Array(await file.slice(-2).arrayBuffer());
    if (head[0] === 0xff && head[1] === 0xd8 && tail[0] === 0xff && tail[1] === 0xd9) return 'image/jpeg';
    return null;
  }

  async function uploadIdDoc(file) {
    const state = $('idverify-state');
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      return setStatus($('drawer-status'), 'ID photo must be a PNG or JPEG.', true);
    }
    if (file.size > 5 * 1024 * 1024) {
      return setStatus($('drawer-status'), 'ID photo must be 5 MB or smaller — retake it closer instead of zooming.', true);
    }
    if (file.size < 128) {
      return setStatus($('drawer-status'), 'That file is too small to be a readable ID photo.', true);
    }
    const sniffed = await sniffFile(file).catch(() => null);
    if (!sniffed) {
      return setStatus($('drawer-status'), 'That file is not a real PNG/JPEG image.', true);
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error ?? new Error('read failed'));
      fr.readAsDataURL(file);
    });
    const b64 = String(dataUrl).split(',')[1] ?? '';
    const b64u = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    try {
      setStatus(state, 'Uploading…');
      await client.submitIdDoc(file.type, b64u);
      setStatus($('drawer-status'), 'ID photo uploaded — the admin will review it.');
      await renderIdentity();
    } catch (err) {
      setStatus($('drawer-status'), err.message ?? String(err), true);
      await renderIdentity();
    }
  }

  function paintConnection(state) {
    const dot = $('ws-dot');
    dot.className = 'dot ' + (state === 'open' ? 'dot-on' : state === 'connecting' ? 'dot-busy' : 'dot-off');
    dot.title = state;
  }

  async function renderConversationList() {
    const list = $('conversation-list');
    const [all, friends, pins, peerVerified] = await Promise.all(
      [allMessages(), loadFriends(), loadPins(), loadPeerVerifications()],
    );
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
      // one shared ladder: red (not added/conflict) → orange (added) →
      // orange shield (verified) → green shield (trusted); deleted =
      // slash+italic from the LOCAL gone marker (the server purges dead
      // names from friends lists, so no mirror flag survives a deletion)
      const state = resolvePeerState({
        isSelf: peer === selfUl,
        gone: !!ent?.gone || !!pin?.gone,
        bound: !!ent?.trusted,
        verified: !!ent?.verified,
        trusted: !!ent?.trust,
        conflict: !!pin && !!ent?.pub && pin.p !== ent.pub,
      });
      name.replaceChildren(peerStateIcon(state));
      name.append(peer);
      // red circle for accounts WITHOUT admin identity verification;
      // only when we actually looked the peer up (Map value false, not undefined)
      if (peerVerified.get(peer) === false) name.append(unverifiedBadgeEl());
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

    // Identity verification: the top-left "Get verified" link deep-links
    // straight into the drawer's Verify tab; tabs persist across opens.
    document.querySelector('.drawer-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.drawer-tab');
      if (btn) selectSettingsTab(btn.dataset.tab);
    });
    $('btn-self-verify').addEventListener('click', () => openSettings('verify'));
    $('btn-id-doc').addEventListener('click', () => $('id-doc-input').click());
    $('id-doc-input').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // allow re-picking the same file
      uploadIdDoc(file);
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
