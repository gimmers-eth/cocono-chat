// Home: sidebar chrome (identity, connection state, log out), conversation
// list, new-chat launcher and the devices panel (list + approve pairing +
// theme picker).

import { $, setStatus, fmtTime, confirmModal, openLightbox } from '../ui.js';
import { humanError } from '../errors.js';
import { createPeerSuggestions } from './peers.js';
import { iconEl } from '../icons.js';
import { allMessages, isUnread, loadFriends, loadPins, clearLocalTrustData, clearAllMessages, loadPeerVerifications, loadPeerAvatars, rememberPeerAvatar, AVATARS_EVENT } from '../store.js';
import { PS, resolvePeerState, peerStateIcon, unverifiedBadgeEl } from './peername.js';
import { refreshSettingsUI } from '../install.js';
import { loadRegistry, applyTheme, savedTheme, wireThemeSelect } from '../theme.js';

const MSG_STATE_ICON = { sending: 'stateSending', sent: 'stateSent', delivered: 'stateDelivered', failed: 'stateFailed' };

export function createHome({ client, chat, onLogout }) {
  let settingsOpen = false;

  // ---- settings drawer tabs ----
  const SETTINGS_TABS = ['profile', 'verify', 'devices', 'general', 'diagnostics'];
  let settingsTab = 'devices';
  try { settingsTab = localStorage.getItem('cocono.settings.tab') || 'devices'; } catch { /* private mode */ }
  if (!SETTINGS_TABS.includes(settingsTab)) settingsTab = 'devices';
  // our own identity-verification state (null = unknown/offline); while
  // false, opening settings ALWAYS lands on the Verify tab
  let myVerified = null;

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
    if (settingsTab === 'profile' && myVerified === true) renderProfileTab();
  }

  function selectSettingsTab(tab) {
    settingsTab = SETTINGS_TABS.includes(tab) ? tab : 'devices';
    try { localStorage.setItem('cocono.settings.tab', settingsTab); } catch { /* private mode */ }
    showSettingsTab();
    updateTabFades();
  }

  // Tab-bar overflow fades: shown only while tabs are actually clipped on
  // that side (re-measured on scroll / open / resize).
  function updateTabFades() {
    const tabs = document.querySelector('.drawer-tabs');
    const wrap = $('drawer-tabs-wrap');
    if (!tabs || !wrap) return;
    const overflow = tabs.scrollWidth - tabs.clientWidth;
    const sl = tabs.scrollLeft;
    wrap.classList.toggle('fade-left', sl > 2);
    wrap.classList.toggle('fade-right', sl < overflow - 2);
  }

  function openSettings(tab) {
    // explicit tab wins; otherwise routing by verification state:
    // unverified → Verify (nag) · verified → Profile (the unlocked tab)
    const want = tab || (myVerified === false ? 'verify' : myVerified === true ? 'profile' : null);
    if (settingsOpen && want) selectSettingsTab(want);
    if (!settingsOpen) {
      settingsOpen = true;
      $('drawer-overlay').hidden = false;
      $('settings-drawer').hidden = false;
      renderDevices();
      refreshSettingsUI();
      wireThemePicker();
      $('btn-settings-close').focus?.();
      if (want) selectSettingsTab(want); else showSettingsTab();
    }
    showSettingsTab();
    // measure after layout settles (drawer was hidden until this frame)
    requestAnimationFrame(updateTabFades);
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
    paintOwnHeadAvatar();
    renderIdentity();
  }

  // --- identity verification (admin-checked real person; red notice until done) ---
  // Entry points: the "Get verified" link next to our own name, and the
  // settings drawer section. Unverified is the DEFAULT. (The admin can also
  // verify an account directly — internal ops capability, not advertised
  // in user-facing copy.)
  async function renderIdentity() {
    const state = $('idverify-state');
    const note = $('idverify-note');
    const btn = $('btn-id-doc');
    const link = $('btn-self-verify');
    let me = null;
    try { me = await client.identity(); } catch { /* offline/no session */ }
    myVerified = me ? !!me.verified : null;
    const show = (txt, cls, noteTxt) => {
      if (!state) return;
      state.textContent = txt;
      state.className = `idverify-state ${cls}`;
      if (note) {
        note.hidden = !noteTxt;
        note.textContent = noteTxt ?? '';
      }
    };
    if (!me) {
      // no facts fetched: hide all affordances, assume nothing
      link.hidden = true; btn.hidden = true; return;
    }
    $('me-verify-badge').replaceChildren(...(me.verified ? [] : [unverifiedBadgeEl()]));
    const profileTabBtn = $('tabbtn-profile');
    if (profileTabBtn) profileTabBtn.hidden = !me.verified;
    if (me.verified && settingsOpen && settingsTab === 'profile') renderProfileTab();
    // our own name carries the same red mark contacts see — until verified
    link.hidden = !!me.verified; // the top-left entry only while unverified
    if (me.verified) {
      btn.hidden = true;
      show('Verified', 'ok', null);
      return;
    }
    if (btn) btn.disabled = me.canUploadId === false;
    if (me.canUploadId === false) {
      btn.hidden = false;
      if (state) state.textContent = 'Not verified — ID upload unlocks once a verified user trusts you.';
      return;
    }
    btn.hidden = false;
    if (me.idDoc) {
      // re-upload allowed before review
      show('Not Verified', 'bad', `ID photo submitted ${new Date(me.idDoc.uploadedAt).toLocaleDateString()} — waiting for review.`);
      return;
    }
    show('Not Verified', 'bad', null);
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

  // ---- my-profile tab (bio + tiny avatar; avatar resized ON-DEVICE) ----
  let pendingAvatar = null; // 'clear' | base64 jpeg | null (nothing pending)
  let pendingBioSaved = null; // last bio confirmed on the server

  function paintOwnAvatar(b64) {
    const img = $('profile-own-avatar');
    const initial = $('profile-own-initial');
    // keep the fallback letter ready + centred (.avatar grid handles it;
    // no display overrides here)
    initial.textContent = String(client.username ?? '?').slice(0, 1).toUpperCase();
    if (b64) {
      img.src = `data:image/jpeg;base64,${b64}`;
      img.hidden = false;
      initial.hidden = true;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
      initial.hidden = false;
    }
    $('btn-profile-avatar-clear').hidden = !b64;
  }

  async function renderProfileTab() {
    try {
      const me = await client.profile();
      $('profile-own-name').textContent = client.username ?? '';
      $('profile-own-initial').textContent = String(client.username ?? '?').slice(0, 1);
      const bio = me.bio ?? '';
      const field = $('profile-bio');
      if (document.activeElement !== field || bio === (pendingBioSaved ?? field.value)) {
        field.value = bio;
      }
      pendingBioSaved = pendingBioSaved ?? bio;
      $('profile-bio-count').textContent = String(field.value.length);
      // the owner fetch is the freshest source there is — push it into the
      // shared cache so side-head + sidebar + preview all agree immediately
      const selfUl = String(client.username ?? '').toLowerCase();
      if (selfUl) rememberPeerAvatar(selfUl, me.avatar ?? null);
      pendingAvatar = null;
      paintOwnAvatar(me.avatar);
    } catch (err) {
      setStatus($('drawer-status'), humanError(err), true);
    }
  }

  // 128px centre-crop JPEG on canvas: a phone photo (MBs) becomes ~5–10 KB
  // before it ever touches the network. Server re-validates size + magic.
  async function resizeAvatar(file) {
    if (!file) return null;
    if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Pick a PNG or JPEG photo.');
    const bmp = await createImageBitmap(file);
    const size = 384; // ×3 budget: crisper avatars, still tiny after JPEG
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const side = Math.min(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
    let quality = 0.82;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length * 0.75 > 288 * 1024 && quality > 0.4) {
      quality -= 0.12;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }
    bmp.close?.();
    return dataUrl.split(',')[1];
  }

  // ---- auto-save with visual feedback ----
  let bioTimer = null;
  let savingChain = Promise.resolve(); // serialise: last change wins, no overlap
  function setSaveChip(state) {
    const el = $('profile-save-state');
    if (!el) return;
    el.hidden = state === 'idle';
    el.textContent = state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved ✓' : 'Failed';
    el.classList.toggle('bad', state === 'error');
    if (state === 'saved') {
      setTimeout(() => { if (el.textContent === 'Saved ✓') { el.hidden = true; el.classList.remove('bad'); } }, 1800);
    }
  }
  function persistProfile(patch, { flash = true } = {}) {
    setSaveChip('saving');
    savingChain = savingChain
      .then(async () => {
        await client.setProfile(patch);
        if (patch.bio !== undefined) pendingBioSaved = patch.bio;
        if (patch.avatar !== undefined || patch.clearAvatar) {
          pendingAvatar = null;
          await renderProfileTab(); // authoritative re-sync of the preview
        }
        if (flash) setSaveChip('saved');
      })
      .catch((err) => {
        setSaveChip('error');
        setStatus($('drawer-status'), humanError(err), true);
      });
    return savingChain;
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

  // ---- avatar plumbing: cached (mutual-add) photos everywhere ----
  const avatarPriming = new Map(); // peer -> last attempt ts (failure cooldown)
  function peerAvatarEl(peer, avatars, cls = '') {
    const rec = avatars.get(peer);
    if (rec && rec.avatar) {
      const img = document.createElement('img');
      img.className = `avatar avatar-img ${cls}`.trim();
      img.alt = '';
      img.src = `data:image/jpeg;base64,${rec.avatar}`;
      return img;
    }
    const span = document.createElement('span');
    span.className = `avatar ${cls}`.trim();
    span.setAttribute('aria-hidden', 'true');
    span.textContent = peer.slice(0, 1);
    return span;
  }

  // One profile fetch per peer per day: the server hands out the avatar
  // ONLY when the add is mutual, so null results are cached too and simply
  // render as initials.
  function primeProfiles(peers) {
    const selfUl = String(client.username ?? '').toLowerCase();
    for (const peer of new Set([...peers, selfUl])) {
      if (!peer) continue;
      const last = avatarPriming.get(peer) ?? 0;
      if (Date.now() - last < 5 * 60_000) continue;
      avatarPriming.set(peer, Date.now());
      client.viewProfile(peer)
        .then((prof) => rememberPeerAvatar(peer, prof.avatar))
        .catch(() => avatarPriming.delete(peer)); // retry after cooldown
    }
  }

  async function paintOwnHeadAvatar() {
    const avatars = await loadPeerAvatars();
    const selfUl = String(client.username ?? '').toLowerCase();
    const rec = avatars.get(selfUl);
    const img = $('me-avatar-img');
    const initial = $('me-avatar');
    if (rec?.avatar) {
      img.src = `data:image/jpeg;base64,${rec.avatar}`;
      img.hidden = false;
      initial.hidden = true;
    } else {
      img.hidden = true;
      initial.hidden = false;
    }
  }

  async function renderConversationList() {
    const list = $('conversation-list');
    const [all, friends, pins, peerVerified, avatars] = await Promise.all(
      [allMessages(), loadFriends(), loadPins(), loadPeerVerifications(), loadPeerAvatars()],
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
      const av = peerAvatarEl(peer, avatars);
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
    primeProfiles(entries.map(([peer]) => peer));
  }

  async function renderDevices() {
    const list = $('device-list');
    // Drawer actions report INSIDE the drawer — #home-status is behind the scrim.
    const status = $('drawer-status');
    try {
      const { devices, maxDevices } = await client.devices();
      // The budget is per-ACCOUNT: it rides on the section header, not on
      // every device row (it was 'N max' × devices before — noise).
      const maxEl = $('device-max');
      if (maxEl) maxEl.textContent = `${maxDevices} max`;
      const frag = document.createDocumentFragment();
      for (const dev of devices) {
        const li = document.createElement('li');
        const id = document.createElement('span');
        id.textContent = dev.id.slice(0, 8) + '…';
        const tag = document.createElement('span');
        tag.className = 'dim';
        tag.textContent = dev.current ? 'this device' : '';
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
    document.querySelector('.drawer-tabs')?.addEventListener('scroll', updateTabFades, { passive: true });
    // Desktop drag-scroll for the tab bar: touch already gets native swipe
    // from overflow-x, but a mouse user needs click-and-drag. A drag must
    // not end as a tab switch, so the trailing click gets eaten once.
    {
      const tabsEl = document.querySelector('.drawer-tabs');
      if (tabsEl) {
        let drag = null;
        let suppressTabClick = false;
        tabsEl.addEventListener('pointerdown', (e) => {
          if (e.pointerType !== 'mouse') return; // touch: native swipe rules
          drag = { x: e.clientX, left: tabsEl.scrollLeft, moved: false };
        });
        tabsEl.addEventListener('pointermove', (e) => {
          if (!drag) return;
          const dx = e.clientX - drag.x;
          if (!drag.moved && Math.abs(dx) > 5) {
            drag.moved = true;
            tabsEl.classList.add('dragging');
            tabsEl.setPointerCapture?.(e.pointerId);
          }
          if (drag.moved) tabsEl.scrollLeft = drag.left - dx;
        });
        const endDrag = () => {
          if (drag?.moved) suppressTabClick = true;
          drag = null;
          tabsEl.classList.remove('dragging');
        };
        tabsEl.addEventListener('pointerup', endDrag);
        tabsEl.addEventListener('pointercancel', endDrag);
        tabsEl.addEventListener('pointerleave', endDrag);
        tabsEl.addEventListener('click', (e) => {
          if (!suppressTabClick) return;
          suppressTabClick = false;
          e.stopPropagation();
          e.preventDefault();
        }, true);
      }
    }
    window.addEventListener('resize', updateTabFades);
    window.addEventListener(AVATARS_EVENT, () => {
      paintOwnHeadAvatar();
      renderConversationList().catch(() => {});
    });
    $('btn-self-verify').addEventListener('click', (e) => { e.stopPropagation(); openSettings('verify'); });
    // the whole identity block opens settings (verified → Profile tab,
    // unverified → Verify tab; handled inside openSettings)
    $('btn-my-settings').addEventListener('click', () => openSettings());
    $('btn-my-settings').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSettings(); }
    });

    $('btn-profile-avatar').addEventListener('click', () => $('profile-avatar-input').click());
    $('profile-own-avatar').addEventListener('click', (e) => { if (!e.target.hidden) openLightbox(e.target.src); });
    $('btn-profile-preview').addEventListener('click', () => {
      closeSettings();
      chat.openSelfProfile?.();
    });
    // photo: resize + save immediately (it was an explicit action)
    $('profile-avatar-input').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        pendingAvatar = await resizeAvatar(file);
        paintOwnAvatar(pendingAvatar);
        persistProfile({ avatar: pendingAvatar });
      } catch (err) {
        setStatus($('drawer-status'), err.message ?? String(err), true);
      }
    });
    $('btn-profile-avatar-clear').addEventListener('click', () => {
      paintOwnAvatar(null);
      persistProfile({ clearAvatar: true });
    });
    // typing: debounce 1.2 s, then auto-save
    $('profile-bio').addEventListener('input', (e) => {
      $('profile-bio-count').textContent = String(e.target.value.length);
      clearTimeout(bioTimer);
      const value = e.target.value;
      if (value === pendingBioSaved) return; // unchanged vs last saved
      bioTimer = setTimeout(() => persistProfile({ bio: value }, { flash: true }), 1200);
    });
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

    // Share MY chat link: OS share sheet (Web Share API) with a
    // /?chat=<my-username> deep link — the recipient opens a conversation
    // with ME, whoever is viewing. The receiving side parks the link until
    // an account exists (main.js captureSharedChat/takeSharedChat), so a
    // logged-out opener lands in exactly that chat right after signup.
    $('btn-share-chat')?.addEventListener('click', async () => {
      const status = $('home-status');
      const me = String(client.username ?? '').toLowerCase();
      if (!me) return setStatus(status, 'No active session — there is nothing to share yet.', true);
      const url = `${location.origin}/?chat=${encodeURIComponent(me)}`;
      const name = document.querySelector('[data-app-name]')?.textContent || 'CoCoNo';
      const copyFallback = () => {
        navigator.clipboard?.writeText(url).then(
          () => setStatus(status, 'Your chat link was copied to clipboard.'),
          () => setStatus(status, url),
        );
      };
      if (navigator.share) {
        try {
          await navigator.share({
            title: `Message me on ${name}`,
            text: `Chat with me (@${me}) on ${name}:`,
            url,
          });
        } catch (err) {
          if (err?.name !== 'AbortError') copyFallback(); // cancelled = silence
        }
      } else copyFallback(); // desktop Chrome/Firefox without Web Share
    });

    // Settings → General: wipe the ENTIRE local transcript (per-device,
    // same contract as clearing a single chat — friends stay friends).
    $('btn-clear-all-msgs')?.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Are you sure?',
        body: 'Clear ALL messages on this device?',
        warning: 'Every conversation disappears from THIS device only — your other devices and your contacts keep their copies. This cannot be undone.',
        okLabel: 'Clear all messages',
        danger: true,
      });
      if (!ok) return;
      try {
        const n = await clearAllMessages();
        await chat.render(); // open conversation (if any) repaints empty
        await renderConversationList(); // message-less friends survive
        setStatus(
          $('drawer-status'),
          n ? `Cleared ${n} message${n === 1 ? '' : 's'} from this device.` : 'Nothing to clear.',
        );
      } catch (err) {
        setStatus($('drawer-status'), humanError(err), true);
      }
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
