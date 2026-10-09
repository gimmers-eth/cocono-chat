// Home: sidebar chrome (identity, connection state, log out), conversation
// list, new-chat launcher and the devices panel (list + approve pairing +
// theme picker).

import { $, setStatus, fmtTime, confirmModal, openLightbox, toast, animateSheetClose } from '../ui.js';
import { humanError } from '../errors.js';
import { createPeerSuggestions, makeTrustDecorator } from './peers.js';
import { iconEl } from '../icons.js';
import { allMessages, isUnread, loadFriends, loadPins, clearLocalTrustData, clearAllMessages, loadPeerVerifications, loadPeerPremiums, loadPeerAvatars, rememberPeerAvatar, rememberPeerVerified, rememberPeerChip, loadPeerChips, AVATARS_EVENT, FRIENDS_EVENT, loadPeerBlocked, saveBlockedSet } from '../store.js';
import { blockUserWithConfirm, unblockUser, blockReasonLabel, blockReasonIcon } from '../blocks.js';
import { mountLine, avatarStack, setAvatar, verifiedSubEl, doubleLine } from './userline.js';
import { PS, resolvePeerState, peerStateIcon, unverifiedBadgeEl } from './peername.js';
import { guessDeviceName, humanPlatform } from '../devices.js';
import { BADGE_UI, nameChipEl } from '../badges.js';
import { refreshSettingsUI } from '../install.js';
import { loadRegistry, applyTheme, savedTheme, wireThemeSelect } from '../theme.js';

const MSG_STATE_ICON = { sending: 'stateSending', sent: 'stateSent', delivered: 'stateDelivered', failed: 'stateFailed' };

export function createHome({ client, chat, onLogout }) {
  let settingsOpen = false;

  // ---- settings drawer tabs ----
  const SETTINGS_TABS = ['profile', 'verify', 'devices', 'limits', 'relationships', 'general', 'diagnostics'];
  let settingsTab = 'devices';
  try { settingsTab = localStorage.getItem('cocono.settings.tab') || 'devices'; } catch { /* private mode */ }
  if (!SETTINGS_TABS.includes(settingsTab)) settingsTab = 'devices';
  // our own identity-verification state (null = unknown/offline); while
  // false, opening settings ALWAYS lands on the Verify tab
  let myVerified = null;
  let myPremium = false; // premium gold cert for MY OWN name (side-head + own profile tab)
  let myBadges = [];     // held badges [{id, at}] from /api/me
  let myDisplay = null;  // chosen name badge ('' = explicitly none)

  function showSettingsTab() {
    for (const t of SETTINGS_TABS) {
      const panel = $(`tabpanel-${t}`);
    if (t === 'relationships') renderRelationships(); // fresh pull on entry
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

  // Settings > General > Usage: the account's verify/trust stage budgets.
  // Same numbers the server enforcement runs on (GET /api/me/stage-limits),
  // so the user can always see limit + spend + reset before they hit a cap.
  const durShort = (sec) => (sec >= 86400 ? `${Math.floor(sec / 86400)}d ${Math.ceil((sec % 86400) / 3600)}h`
    : sec >= 3600 ? `${Math.ceil(sec / 3600)}h`
      : `${Math.max(1, Math.ceil(sec / 60))}m`);

  // Settings > Limits: a small table of the vouching budgets plus a reset
  // note line. Cells show what is LEFT (that's what a user is asking when
  // they open this); an exhausted cell flips red. Offline -> note + dashes.
  // ---- name-badge surface (mine) ----
  function myChipId() {
    // visibility gate: unverified accounts show NO badge name-side, whatever
    // they have chosen; '' is the explicit "none"
    if (!myVerified || !myDisplay) return null;
    return myDisplay === '' ? null : myDisplay;
  }


  // Settings > Profile badges card: a table — Badge · Received · Select.
  // Wearing a badge is a click on its row; the worn row is marked.
  function renderOwnBadges() {
    const host = $('own-badges');
    if (!host) return;
    host.replaceChildren();
    const held = (myBadges ?? []).filter((b) => BADGE_UI.has(b.id));
    const none = $('own-badges-none');
    if (none) none.hidden = held.length > 0;
    if (!held.length) return;
    const table = document.createElement('table');
    table.className = 'badge-table';
    const thead = document.createElement('tr');
    for (const t of ['Badge', 'Received', '']) {
      const th = document.createElement('th');
      th.textContent = t;
      thead.append(th);
    }
    const theadEl = document.createElement('thead');
    theadEl.append(thead);
    const tbody = document.createElement('tbody');
    table.append(theadEl, tbody);
    const current = myChipId();
    for (const b of held) {
      const def = BADGE_UI.get(b.id);
      const tr = document.createElement('tr');
      const cName = document.createElement('td');
      cName.append(def.icon(18));
      const lab = document.createElement('span');
      lab.textContent = ` ${def.label}`;
      cName.append(lab);
      const cWhen = document.createElement('td');
      cWhen.className = 'dim';
      cWhen.textContent = b.at ? new Date(b.at).toLocaleDateString() : '—';
      const cSel = document.createElement('td');
      const btn = document.createElement('button');
      btn.className = `btn btn-small${current === b.id ? ' btn-accent' : ''}`;
      btn.textContent = current === b.id ? 'Worn' : 'Wear';
      btn.addEventListener('click', async () => {
        try {
          await client.setProfile({ displayBadge: b.id });
          myDisplay = b.id;
          paintMyLine();
          paintOwnHero(); // the WORN chip changes live, not on next entry
        } catch (err) {
          // rapid badge toggling trips the stage guards — say so plainly
          // (a silent swallow made 429s look like dead buttons)
          toast(humanError(err), 'error');
        }
        renderOwnBadges();
      });
      cSel.append(btn);
      tr.append(cName, cWhen, cSel);
      tbody.append(tr);
    }
    host.append(table);
  }

  async function renderUsage() {
    const line = $('usage-line');
    const cells = USAGE_CELLS.map((id) => $(id));
    if (!line || cells.some((c) => !c)) return;
    const clear = (msg) => {
      for (const el of cells) { el.textContent = '—'; el.classList.remove('usage-spent'); }
      line.textContent = msg;
    };
    try {
      const u = await client.stageLimits();
      const set = (el, s) => {
        const left = s.limit - s.used;
        el.textContent = left <= 0 ? 'all used' : `${left} of ${s.limit}`;
        el.classList.toggle('usage-spent', left <= 0);
      };
      set($('usage-vd'), u.verifyDaily);
      set($('usage-vw'), u.verifyWeekly);
      set($('usage-td'), u.trustDaily);
      set($('usage-tw'), u.trustWeekly);
      const resets = [];
      if (u.verifyDaily.used > 0 && u.verifyDaily.resetInSec > 0) resets.push(`daily resets in ${durShort(u.verifyDaily.resetInSec)}`);
      if (u.verifyWeekly.used > 0 && u.verifyWeekly.resetInSec > 0) resets.push(`weekly resets in ${durShort(u.verifyWeekly.resetInSec)}`);
      line.textContent = resets.join(' · ');
    } catch {
      clear('Usage unavailable offline.');
    }
  }

  function openSettings(tab) {
    // explicit tab wins; otherwise routing by verification state:
    // unverified → Verify (nag) · verified → Profile (the unlocked tab)
    const want = tab || (myVerified === false ? 'verify' : myVerified === true ? 'profile' : null);
    if (settingsOpen && want) selectSettingsTab(want);
    if (!settingsOpen) {
      settingsOpen = true;
      for (const el of [$('drawer-overlay'), $('settings-drawer')]) el.classList.remove('closing');
      $('drawer-overlay').hidden = false;
      $('settings-drawer').hidden = false;
      renderDevices();
      renderUsage();
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
    settingsOpen = false; // state flips now; the paint waits for the exit
    animateSheetClose($('settings-drawer'), $('drawer-overlay'), {
      reopenCheck: () => settingsOpen,
    });
  }

  function paintMe(username) {
    username = username.toLowerCase(); // display is always lowercase
    paintMyLine();
    paintOwnHeadAvatar();
    renderIdentity();
  }

  // THE component for my own sidebar head: solid-user trust icon + name +
  // worn badge chip (+ the red unverified mark while myVerified is false),
  // and once identity-verified a GREEN shield-person "Verified" line UNDER
  // the name — same visual grammar every other name surface uses.
  function paintMyLine() {
    const username = String(client.username ?? '').toLowerCase();
    if (!username) return;
    const chip = nameChipEl(myVerified ? myChipId() : null);
    if (chip) chip.classList.add('name-chip-inline');
    mountLine($('me-name'), {
      peer: username,
      state: PS.SELF,
      premium: false, // gold rides the worn chip; identity is the sub line
      chipEl: chip,
      unverified: myVerified === false,
    });
    const sub = $('me-verified-sub');
    sub.hidden = !myVerified;
    if (myVerified) sub.replaceChildren(verifiedSubEl());
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
    myPremium = me ? !!me.premium : false;
    if (me) { myBadges = me.badges ?? myBadges; myDisplay = me.displayBadge ?? myDisplay; }
    paintMyLine();
    renderOwnBadges();
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
    paintMyLine(); // in-line red mark (unverified) / green Verified sub
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

  // Settings > My profile hero — THE double-line component, same grammar as
  // the sidebar head (avatar + trust line + worn chip + red-unverified mark)
  // plus the green "Verified" sub line once identity lands. Zoom ON: this is
  // a profile surface (lightbox delegation already covers #tabpanel-profile).
  let ownHeroAvatar = null; // b64 photo | null
  function paintOwnHero() {
    const host = $('profile-own-hero');
    if (!host) return;
    const ul = String(client.username ?? '');
    const chip = nameChipEl(myChipId());
    if (chip) chip.classList.add('name-chip-inline');
    host.replaceChildren(doubleLine({
      peer: ul,
      avatar: avatarStack(ul, {
        src: ownHeroAvatar ? `data:image/jpeg;base64,${ownHeroAvatar}` : '',
        zoom: true,
        sizeClass: 'own-avatar',
      }),
      line: { state: PS.SELF, chipEl: chip, unverified: myVerified === false },
      sub: myVerified ? verifiedSubEl() : null,
    }));
    $('btn-profile-avatar-clear').hidden = !ownHeroAvatar;
  }

  function paintOwnAvatar(b64) {
    ownHeroAvatar = b64 ?? null;
    paintOwnHero();
  }

  async function renderProfileTab() {
    try {
      const me = await client.profile();
      paintOwnHero(); // repainted again below once the photo arrives
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

  // NUDGE RESPONDERS (main.js 'notice' router, taxonomy in lib/notify.js):
  // both just re-run the normal authoritative reads — a 'profile' nudge
  // means there IS fresh news, so the priming cooldown is dropped once.
  function refreshPeerProfiles() {
    avatarPriming.clear();
    primeProfiles(lastPeers); // also re-primes SELF (adds itself inside)
    renderConversationList().catch(() => {});
    paintOwnHeadAvatar().catch(() => {});
  }

  // ---- avatar plumbing: cached (mutual-add) photos everywhere ----
  const avatarPriming = new Map(); // peer -> last attempt ts (failure cooldown)
  let lastPeers = []; // current sidebar peers — remembered for profile-nudge re-priming
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
        .then((prof) => {
          rememberPeerAvatar(peer, prof.avatar);
          if (peer !== selfUl) {
            rememberPeerVerified(peer, undefined, prof.premium);
            rememberPeerChip(peer, prof.displayBadge || null);
          } else {
            myBadges = prof.badges ?? myBadges;
            myDisplay = prof.displayBadge ?? myDisplay;
            renderOwnBadges();
          }
        })
        .catch(() => avatarPriming.delete(peer)); // retry after cooldown
    }
  }

  async function paintOwnHeadAvatar() {
    const avatars = await loadPeerAvatars();
    const selfUl = String(client.username ?? '').toLowerCase();
    const rec = avatars.get(selfUl);
    setAvatar($('me-avatar-mount'), selfUl, {
      src: rec?.avatar ? `data:image/jpeg;base64,${rec.avatar}` : '',
      zoom: false, // sidebar head: the photo is decoration, not content
    });
  }

  async function renderConversationList() {
    const list = $('conversation-list');
    const [all, friends, pins, peerVerified, avatars, peerPremium, peerChips, peerBlocked] = await Promise.all(
      [allMessages(), loadFriends(), loadPins(), loadPeerVerifications(), loadPeerAvatars(), loadPeerPremiums(), loadPeerChips(), loadPeerBlocked()],
    );
    const latestByPeer = new Map();
    for (const m of all) {
      const cur = latestByPeer.get(m.peer);
      if (!cur || m.ts > cur.ts) latestByPeer.set(m.peer, m);
    }
    // Friends are REAL entries even with zero messages: clearing a chat (or
    // never having written one) must never drop them from the menu.
    for (const f of friends) if (!latestByPeer.has(f.peer)) latestByPeer.set(f.peer, null);
    // Recency = last message OR last friend-state action (add / verify /
    // trust stamps `at` on the mirror — freshly-acted peers float up even
    // with zero messages). Peers with no activity at all sink alphabetically.
    const friendBy = new Map(friends.map((f) => [f.peer, f]));
    const recency = (peer, last) => Math.max(last?.ts ?? 0, friendBy.get(peer)?.at ?? 0);
    const entries = [...latestByPeer.entries()].sort((a, b) => {
      const ka = recency(a[0], a[1]);
      const kb = recency(b[0], b[1]);
      return ka !== kb ? kb - ka : a[0].localeCompare(b[0]);
    });
    lastPeers = entries.map(([peer]) => peer);
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
      const ent = friendBy.get(peer);
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
      // red circle for accounts WITHOUT admin identity verification;
      // only when we actually looked the peer up (Map value false, not undefined)
      const chip = nameChipEl(peerChips.get(peer));
      if (chip) chip.classList.add('name-chip-inline');
      name.className = 'convo-name uname';
      mountLine(name, {
        peer,
        state: peerBlocked.get(peer) ? PS.BLOCKED : state,
        chipEl: chip,
        unverified: peerVerified.get(peer) === false,
      });
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
      // toggle: tapping the row of the ALREADY OPEN chat closes the pane
      // (mobile: the only way back to the list is this or the swipe/arrow)
      btn.addEventListener('click', () => {
        if (chat.isOpenFor?.(peer)) chat.closeChat?.();
        else chat.openChat(peer).catch(() => {});
      });
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
        li.dataset.deviceRow = dev.id;
        const name = document.createElement('span');
        name.className = 'device-name';
        // named beats guessed beats placeholder; the UA heuristic only
        // applies to THIS device (we cannot see another device's UA from
        // here — remote labels come from approval time or a rename)
        const guessed = !dev.name && dev.current ? guessDeviceName() : '';
        name.textContent = dev.name || guessed || 'unnamed device';
        if (!dev.name) name.classList.add('dim');
        const id = document.createElement('span');
        id.className = 'dim mono';
        id.textContent = dev.id.slice(0, 8) + '…';
        li.append(name, id);
        if (dev.current) {
          const tag = document.createElement('span');
          tag.className = 'dim';
          tag.textContent = 'this device';
          li.append(tag);
        }
        const ren = document.createElement('button');
        ren.className = 'linkish';
        ren.textContent = 'rename';
        ren.dataset.renameDevice = dev.id;
        li.append(ren);
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
  // The REVIEW step is a modal: which device is knocking (its own UA, relayed
  // by the server), a name for it (prefilled with that platform guess), and
  // the warning that only your OWN devices ever belong on your account.
  // Inline device rename: swap the row's label for an input. Enter saves,
  // Escape cancels, blur saves. Re-renders either way.
  function startDeviceRename(devId) {
    const list = $('device-list');
    const row = [...list.querySelectorAll('li')].find((li) => li.dataset.deviceRow === devId);
    if (!row) return;
    const nameEl = row.querySelector('.device-name');
    if (!nameEl || row.querySelector('.device-rename-input')) return;
    const current = nameEl.textContent;
    const input = document.createElement('input');
    input.className = 'device-rename-input';
    input.type = 'text';
    input.maxLength = 40;
    input.value = current;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let settled = false;
    const settle = async (save) => {
      if (settled) return;
      settled = true;
      const name = input.value.trim();
      if (save && name && name !== current) {
        try {
          await client.nameDevice(devId, name);
        } catch (err) {
          setStatus($('drawer-status'), `Rename failed: ${err?.message ?? err}`, true);
        }
      }
      renderDevices().catch(() => {});
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); settle(true); }
      else if (e.key === 'Escape') { e.stopPropagation(); settle(false); }
    });
    input.addEventListener('blur', () => settle(true));
  }

  function closePairModal() {
    $('pair-modal').hidden = true;
    $('pair-overlay').hidden = true;
  }

  function wireApproveCode() {
    const input = $('approve-input');
    const reviewBtn = $('btn-approve');
    const approveBtn = $('btn-pair-approve');
    // Pairing-code feedback belongs in the drawer, not the hidden sidebar.
    const status = $('drawer-status');
    let codeInReview = null;

    async function review() {
      const code = input.value.trim();
      if (!/^\d{6}$/.test(code)) return setStatus(status, 'Pairing codes are 6 digits.', true);
      try {
        const p = await client.pendingPairing(code);
        codeInReview = code;
        const who = humanPlatform(p.agent);
        $('pair-platform').textContent = who || 'Unknown device';
        const when = p.requestedAt ?? p.requestAt;
        const whenTxt = when && !Number.isNaN(Date.parse(when)) ? new Date(when).toLocaleString() : '—';
        $('pair-meta').textContent = `id ${String(p.d ?? '').slice(0, 8)}… · requested ${whenTxt}`;
        $('pair-name').value = who; // approver confirms or overwrites the guess
        $('pair-status').textContent = '';
        $('pair-overlay').hidden = false;
        $('pair-modal').hidden = false;
        $('pair-name').focus?.();
        $('pair-name').select?.();
        setStatus(status, '');
      } catch (err) {
        codeInReview = null;
        setStatus(status, err.message ?? String(err), true);
      }
    }

    reviewBtn.addEventListener('click', review);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && review());

    $('btn-pair-cancel').addEventListener('click', closePairModal);
    $('pair-overlay').addEventListener('click', closePairModal);
    approveBtn.addEventListener('click', async () => {
      if (!codeInReview) return closePairModal();
      approveBtn.disabled = true;
      try {
        await client.approvePairing(codeInReview, $('pair-name').value.trim() || undefined);
        setStatus(status, 'Device approved — it will log in any moment.');
        input.value = '';
        codeInReview = null;
        closePairModal();
        renderDevices();
      } catch (err) {
        setStatus($('pair-status'), err.message ?? String(err), true);
      } finally {
        approveBtn.disabled = false;
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
    const newChat = createPeerSuggestions($('chat-peer-suggestions'), {
      max: 3, floating: true, decorate: makeTrustDecorator(), // trust icon + badge per name
    });
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
    // friend add/verify/trust stamps the mirror — repaint immediately so the
    // acted-upon peer floats up the moment the chip changes, not at next boot
    window.addEventListener(FRIENDS_EVENT, () => {
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
      closeSettings(); // logout now lives INSIDE the drawer — don't leave it hanging
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
      if (e.key !== 'Escape') return;
      // layering: the pairing review modal sits ABOVE the drawer
      if (!$('pair-modal').hidden) { closePairModal(); return; }
      closeSettings();
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

    // Detach another device (lost phone, old laptop) or rename any device
    // (inline editor; Enter saves, Escape cancels).
    $('device-list').addEventListener('click', async (e) => {
      const renameId = e.target.closest('[data-rename-device]')?.dataset.renameDevice;
      if (renameId) {
        startDeviceRename(renameId);
        return;
      }
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

    $('btn-badge-none')?.addEventListener('click', async () => {
      try { await client.setProfile({ displayBadge: '' }); myDisplay = ''; }
      catch (err) { toast(humanError(err), 'error'); }
      paintMyLine();
      paintOwnHero();
      renderOwnBadges();
    });
    // a fresh award landed (main.js poll) or a wear choice was made from the
    // badge modal: own tab + head chip re-read
    for (const ev of ['cocono:newbadges', 'cocono:badges-changed']) {
      window.addEventListener(ev, () => {
        renderIdentity().catch(() => {});
        paintOwnHero(); // worn chip follows the badge state from ANY surface
      });
    }
    wireApproveCode();
  }

  // ---- Settings > Relationships: every added or blocked user, searchable,
  // with per-filter toggles and the full trust picture. Server is source of
  // truth (fresh pull on tab entry); actions re-pull after success. ----
  const relState = { q: '', added: true, blocked: true, rows: null };

  async function renderRelationships() {
    const ul = $('rel-list');
    const empty = $('rel-empty');
    if (!ul) return;
    try {
      relState.rows = await client.relationships();
    } catch {
      empty.hidden = false;
      empty.textContent = 'Could not load relationships (offline?).';
      ul.replaceChildren();
      return;
    }
    // keep the sidebar badges honest with the same pull
    saveBlockedSet((relState.rows.blocked ?? []).map((b) => b.peer)).then(() => {});
    const q = relState.q.trim().toLowerCase();
    const rows = [];
    if (relState.added) {
      for (const a of relState.rows.added ?? []) {
        if (q && !a.u.includes(q)) continue;
        rows.push({ peer: a.u, entry: a, blocked: false });
      }
    }
    if (relState.blocked) {
      for (const b of relState.rows.blocked ?? []) {
        if (q && !b.peer.includes(q)) continue;
        // a blocked peer can ALSO still be in added? no — block severs both
        // ways; the two sets are disjoint by construction. Dedup is free.
        rows.push({ peer: b.peer, entry: b, blocked: true });
      }
    }
    rows.sort((x, y) => x.peer.localeCompare(y.peer));
    empty.hidden = rows.length > 0;
    empty.textContent = 'No matches — or nothing to show for the current filters.';
    const pill = (text, cls) => {
      const p = document.createElement('span');
      p.className = `rel-pill ${cls ?? ''}`;
      p.textContent = text;
      return p;
    };
    const action = (label, fn, danger = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `linkish rel-action${danger ? ' danger' : ''}`;
      b.textContent = label;
      b.addEventListener('click', () => { b.disabled = true; fn().finally(() => { b.disabled = false; }); });
      return b;
    };
    ul.replaceChildren();
    for (const r of rows) {
      const li = document.createElement('li');
      li.className = r.blocked ? 'rel-row rel-row-blocked' : 'rel-row';
      const name = document.createElement('span');
      name.className = 'rel-name';
      name.textContent = `@${r.peer}`;
      const info = document.createElement('span');
      info.className = 'rel-info';
      if (r.blocked) {
        info.append(pill('Blocked', 'blocked'));
        if (r.entry.reason) { const rp = pill(blockReasonLabel(r.entry.reason, r.peer), 'reason'); rp.prepend(blockReasonIcon(r.entry.reason)); info.append(rp); }
        if (r.entry.addedBack) info.append(pill('they added you back', 'dim'));
        info.append(action('Unblock', async () => {
          if (await unblockUser(client, r.peer)) { await renderRelationships(); renderConversationList().catch(() => {}); }
        }));
      } else {
        if (r.entry.addedBack) info.append(pill('added back', 'ok'));
        if (r.entry.verified) info.append(pill('verified', 'ok'));
        if (r.entry.trust) info.append(pill('trusted', 'ok'));
        if (r.entry.gone) info.append(pill('account deleted', 'bad'));
        else if (r.entry.changed) info.append(pill('key changed', 'bad'));
        else if (!r.entry.verified) info.append(pill(r.entry.addedBack ? 'not verified' : 'waiting for them to add back', 'warn'));
        info.append(action('Block', async () => {
          if (await blockUserWithConfirm(client, r.peer)) { await renderRelationships(); renderConversationList().catch(() => {}); }
        }, true));
      }
      li.append(name, info);
      ul.append(li);
    }
  }

  function wireRelationships() {
    const search = $('rel-search');
    search?.addEventListener('input', () => { relState.q = search.value ?? ''; renderRelationships().catch(() => {}); });
    const toggle = (id, key) => {
      const btn = $(id);
      btn?.addEventListener('click', () => {
        relState[key] = !relState[key];
        btn.setAttribute('aria-pressed', String(relState[key]));
        btn.classList.toggle('off', !relState[key]);
        renderRelationships().catch(() => {});
      });
    };
    toggle('rel-toggle-added', 'added');
    toggle('rel-toggle-blocked', 'blocked');
  }
  wireRelationships();

  /** Re-sync the blocked mirror from the server (login + friends nudges). */
  async function refreshBlocked() {
    const rel = await client.relationships();
    await saveBlockedSet((rel.blocked ?? []).map((b) => b.peer));
    renderConversationList().catch(() => {});
  }

  return { wire, refreshBlocked, paintMe, renderConversationList, renderDevices, refreshIdentity: renderIdentity, refreshPeerProfiles };
}
