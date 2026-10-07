// Chat pane: conversation rendering + composer. All networking and crypto go
// through the SDK; this component only moves between store <-> DOM. Renders
// are atomic (DocumentFragment + replaceChildren) so concurrent events can
// never interleave a clear/append and double-paint bubbles.
//
// Message interactions are MODAL-BASED on purpose: tapping a bubble opens a
// message modal (scrollable text + fixed actions), and the header ⋮ opens a
// chat-options modal. Modal state lives in overlay DOM that render() never
// touches — unlike the earlier "focus class on a bubble" attempt, which the
// click-triggered catchUp re-render wiped within the same gesture.

import { $, setStatus, setChatOpen, fmtTime, confirmModal, toast } from '../ui.js';
import { createPeerSuggestions } from './peers.js';
import { iconEl } from '../icons.js';
import { PS, resolvePeerState, peerStateIcon, unverifiedBadgeEl } from './peername.js';
import { safetyNumber } from '../identity.js';
import { errorText, humanError } from '../errors.js';
import {
  saveMessage, updateMessage, messagesWith, markRead, allMessages,
  getMessage, deleteMessage, clearMessages,
  loadPeerAvatars, rememberPeerAvatar, AVATARS_EVENT,
  loadFriends, friendAdd, friendDel, friendMarkFlags, FRIENDS_EVENT,
  getPin, recordPinSeen, markPeerGone, rememberPeerVerified,
} from '../store.js';

// In-app banner (visible-but-other-chat) + OS notification (app hidden or
// unfocused) for LIVE messages. Push covers closed-app devices server-side;
// this covers the open-but-not-looking case, mutually exclusive by focus.
let bannerTimer = null;

function showBanner(text, peer) {
  const el = document.getElementById('notif-banner');
  if (!el) return;
  el.textContent = text;
  el.dataset.peer = peer || '';
  el.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

const STATE_MARK = { sending: 'stateSending', sent: 'stateSent', delivered: 'stateDelivered', failed: 'stateFailed' };

// Timeline notices: when a security heads-up happens it must not be a
// fleeting toast — it lands in the conversation timeline (dir:'sys') AND
// syncs to every device of this account (live via self-broadcast, offline
// via the normal store-and-forward queue). Keep codes/texts here.
// Account age stage shown in Safety: New (<30d, red) · Newish (30–149d,
// orange) · Established (>=150d, green) — age is its own trust signal,
// separate from App verification and Social vouches.
const ACCOUNT_STAGES = [
  [150, 'ok', 'Account: Established'],
  [30, 'warn', 'Account: Newish'],
  [0, 'bad', 'Account: New'],
];
function renderAccountStage(createdMs) {
  const state = $('profile-account-state');
  const joined = $('profile-joined');
  if (!state || !joined) return;
  if (!createdMs) { state.hidden = joined.hidden = true; return; }
  const days = (Date.now() - createdMs) / 86_400_000;
  const [, cls, title] = ACCOUNT_STAGES.find(([min]) => days >= min);
  state.hidden = joined.hidden = false;
  state.textContent = title;
  state.className = `profile-id-state ${cls}`;
  joined.textContent = `Joined — ${new Date(createdMs).toLocaleDateString()}`;
}

const NOTICE_TEXT = {
  'trust-revoked': (peer) => `Heads up: trust in ${peer} was revoked — the account behind this username changed its identity key (possibly re-registered by someone else). Verify the safety number again before trusting new messages.`,
  'account-deleted': (peer) => `Heads up: the ${peer} account was deleted. This conversation is read-only now; your saved messages remain here.`,
  'user-gone': (peer) => `Heads up: ${peer} doesn’t exist — no account with this name was found, so nothing was delivered.`,
};

// 'Read' means the user actually LOOKED at the conversation: the tab is
// visible AND the window has focus (WhatsApp Web semantics). Background
// messages keep their unread dot until the user comes back.
function windowActive() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

// OS notification FROM THE PAGE (open-but-unfocused case): the page owns
// the content the moment it pulls the message, and the worker deliberately
// stays quiet when the queue comes back empty (see sw.js). Same tag as the
// worker's notifications -> a burst replaces into the latest one.
function notifyOS(peer, text) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const snippet = (text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  navigator.serviceWorker?.getRegistration?.()?.then((reg) => {
    reg?.showNotification?.(document.title || 'co.co.no', {
      body: `${peer}: ${snippet || '(message)'}`,
      tag: 'cocono-activity',
      data: { type: 'msg', peer },
    })?.catch?.(() => {});
  }).catch(() => {});
}

export function createChat({ client, onHomeRefresh }) {
  let currentPeer = null; // display-cased
  // true when the peer's account has been deleted server-side: the local
  // transcript stays readable, but sending is disabled (no keys to encrypt
  // to — the account is gone forever).
  let peerGone = false;
  // whether a transcript existed WHEN THE CHAT OPENED — decides whether a
  // vanished peer is “account deleted” (we had history) or simply “user does
  // not exist” (a cold name). Fresh failed sends must not fake history.
  let peerHadHistory = false;
  // TOFU pin state for the open chat: 'new' | 'ok' | 'changed' (from
  // recordPinSeen) and the live identity key seen from peerKeys
  let pinState = 'ok';
  let peerIdentity = null;
  // admin-checked real-person flag of the open peer; KNOWN only when a
  // key lookup actually succeeded (offline/ghost chats show no badge)
  let peerIdentityVerified = false;
  let peerJoinedAt = null; // "joined" date from the live key lookup
  let peerIdentityKnown = false;

  // red circle for unverified peers, clean for verified — never pass null
  // into replaceChildren (it stringifies to a literal "null" text node)
  function renderIdentityBadge(badgeEl) {
    badgeEl.replaceChildren(...(peerIdentityKnown && !peerIdentityVerified ? [unverifiedBadgeEl()] : []));
  }

  // chat-head avatar from the mutual-add cache (sidebar renders the same map)
  async function renderChatAvatar() {
    if (!currentPeer) return;
    const avatars = await loadPeerAvatars();
    const rec = avatars.get(currentPeer);
    const img = $('chat-peer-avatar');
    if (rec?.avatar) {
      img.src = `data:image/jpeg;base64,${rec.avatar}`;
      img.hidden = false;
    } else {
      img.hidden = true;
    }
  }

  // Nodes for the chat-head sub line: red "Unverified user"/"Account
  // deleted" flag first, device/offline info after — built from elements
  // (no innerHTML, no null-string coercion).
  function chatSubNodes(peer) {
    const parts = [];
    if (peerGone) {
      parts.push([peerHadHistory ? 'Account deleted — history only' : 'User does not exist', 'sub-flag']);
    } else {
      if (peerIdentityKnown && !peerIdentityVerified) parts.push(['Unverified user', 'sub-flag']);
      parts.push([peer
        ? `${peer.devices.length} device${peer.devices.length === 1 ? '' : 's'}`
        : 'Offline — stored messages only', '']);
    }
    const nodes = [];
    parts.forEach(([txt, cls], i) => {
      if (i) nodes.push(document.createTextNode(' · '));
      const s = document.createElement('span');
      if (cls) s.className = cls;
      s.textContent = txt;
      nodes.push(s);
    });
    return nodes;
  }

  // --- SDK event wiring (once) ---

  function connectEvents() {
    // Retention/resync: when the socket opens and this device's local
    // message store is empty (e.g. the browser evicted it while the identity
    // survived), ask the server to replay our still-retained copies.
    // Dedup is inherent: message ids are server-assigned mids.
    let resynced = false;
    let lastOpenAt = 0; // banner-suppression anchor: the drain right after
    // 'open' is CATCH-UP (queued backlog), not live arrivals — no per-message pills
    client.on('state', async ({ state }) => {
      if (state === 'open') lastOpenAt = Date.now();
      if (state !== 'open' || resynced) return;
      resynced = true;
      if ((await allMessages()).length === 0) client.requestResync();
    });

    client.on('message', async (m) => {
      // System messages (friend events + timeline notices) ride the normal
      // E2EE path from OUR OWN account — only this account can produce them
      // (relay HMAC), so the payload is trusted once decrypted, but still
      // parsed defensively. Notices DO enter timelines (as dir:'sys' rows);
      // friend events only update the mirror.
      const selfUl = String(client.username ?? '').toLowerCase();
      if (m.peer.toLowerCase() === selfUl && /^\{"sys":/.test(m.text)) {
        try {
          const p = JSON.parse(m.text);
          if (p.sys === 'friend+') await friendAdd(p.ul, p.p || '');
          else if (p.sys === 'friend-') await friendDel(p.ul);
          else if (p.sys === 'friend-v') await friendMarkFlags(p.ul, { verified: !!p.v });
          else if (p.sys === 'friend-t') await friendMarkFlags(p.ul, { trust: !!p.t });
          else if (p.sys === 'notice' && p.id && NOTICE_TEXT[p.code] && String(p.peer)) {
            // cross-device copy of a security heads-up: land it in the
            // referenced chat's timeline (dedup on the stable notice id)
            const nid = `sys:${p.id}`;
            if (!(await getMessage(nid))) {
              await saveMessage({ id: nid, peer: String(p.peer).toLowerCase(), dir: 'sys', text: NOTICE_TEXT[p.code](p.peer), ts: p.ts || Date.now() });
            }
          } else throw new Error('unknown sys');
          await updateTrustUI();
          if (currentPeer) await render();
          onHomeRefresh?.();
        } catch { /* unparsable system payload: ignore */ }
        return;
      }
      await saveMessage({
        id: `in:${m.mid}`,
        peer: m.peer,
        dir: 'in',
        text: m.text,
        ts: m.ts,
        fromDeviceId: m.fromDeviceId,
      });
      // prime profile for new/unknown peers, but only when our cache is
      // missing or older than a day (busy chats must not hammer the server)
      loadPeerAvatars().then((avatars) => {
        const rec = avatars.get(m.peer.toLowerCase());
        if (rec && Date.now() - (rec.ts ?? 0) < 86_400_000) return;
        return client.viewProfile(m.peer).then((prof) => rememberPeerAvatar(m.peer, prof.avatar));
      }).catch(() => {});
      if (currentPeer && currentPeer.toLowerCase() === m.peer.toLowerCase()) {
        await render();
        if (windowActive()) markRead(m.peer, m.ts);
      }
      onHomeRefresh?.();

      // Where the notification comes from depends on ATTENTION, and every
      // case now shows CONTENT:
      //  - focused app, other chat -> in-app pill (the OS level is ours);
      //  - app open but NOT focused/visible -> OS notification from THIS
      //    page (we just pulled the copy; the worker's push peek will come
      //    back empty and stays silent by design);
      //  - app closed -> server push, worker peeks the still-queued copy
      //    and shows the rich notification.
      const viewingThis = currentPeer && currentPeer.toLowerCase() === m.peer.toLowerCase();
      const catchUp = Date.now() - lastOpenAt < 3000;
      if (windowActive() && !viewingThis && !catchUp) {
        const snippet = (m.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        showBanner(`${m.peer}: ${snippet || '(message)'}`, m.peer);
      } else if (!windowActive()) {
        notifyOS(m.peer, m.text);
      }
    });

    client.on('peerIdentityChanged', ({ peer }) => {
      showBanner(`${peer}: key material refreshed (account re-created or device re-paired)`, peer);
    });

    client.on('ack', async ({ localId, ok, error }) => {
      if (!localId) return;
      const rec = await updateMessage(`out:${localId}`, { state: ok ? 'sent' : 'failed' });
      if (!ok) {
        toast(errorText(error, () => `Message not sent (${error ?? 'unknown'}).`), 'error');
        // unknown_recipient on a chat that opened fine means our cached view
        // is stale — almost always: their account was deleted while we sat
        // here. Re-resolve and let the icons/ghost state catch up.
        if (error === 'unknown_recipient') {
          // AWAITED: the optimistic head/composer flip must settle before
          // the re-check's verdict can walk it back (unawaited, its
          // continuation could land AFTER the walk-back and re-apply gone)
          await applyGoneState(); // instant icon/composer reaction…
          recheckPeerAfterSend(); // …then confirm & word the notice
        }
      }
      if (rec) {
        await render();
        onHomeRefresh?.();
      }
    });

    client.on('delivered', async ({ localId }) => {
      if (!localId) return;
      const rec = await updateMessage(`out:${localId}`, { state: 'delivered' });
      if (rec) {
        await render();
        onHomeRefresh?.();
      }
    });

    client.on('error', ({ error }) => toast(humanError(error), 'error'));
  }

  // --- sending ---

  async function sendCurrent() {
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text || !currentPeer || peerGone) return;
    input.value = '';
    try {
      const { localId } = await client.sendMessage(currentPeer, text);
      await saveMessage({ id: `out:${localId}`, peer: currentPeer, dir: 'out', text, ts: Date.now(), state: 'sending' });
      // Replying is proof of engagement: whatever of this peer's messages is
      // on screen counts as seen now.
      markRead(currentPeer, Date.now());
      await render();
      onHomeRefresh?.();
      // Multi-message sessions: keep typing — re-claim focus (belt and
      // braces for the send button, which must not steal it; see wire()).
      input.focus({ preventScroll: true });
    } catch (err) {
      // Peer account died between opening the chat and sending: learn the
      // gone fact right here so the sidebar + strip flip to deleted-state.
      if (err?.code === 'unknown_account' || err?.status === 404) {
        peerGone = true;
        markPeerGone(currentPeer, true).catch(() => {});
        updateTrustUI().catch(() => {});
        onHomeRefresh?.();
      }
      toast(navigator.onLine === false
        ? 'Offline — messages cannot be sent yet. They stay unsent until you reconnect.'
        : humanError(err), 'error');
    }
  }

  // --- rendering ---

  async function render() {
    const list = $('chat-messages');
    if (!list || !currentPeer) return;
    const msgs = (await messagesWith(currentPeer)).sort((a, b) => a.ts - b.ts);
    const frag = document.createDocumentFragment();
    for (const m of msgs) {
      const li = document.createElement('li');
      // security/system notices: centred pill, no actions, no sender tint
      if (m.dir === 'sys') {
        li.className = 'msg-sys';
        const note = document.createElement('span');
        note.textContent = m.text;
        li.append(note);
        frag.appendChild(li);
        continue;
      }
      li.className = `msg ${m.dir}`;
      li.dataset.id = m.id; // tap -> openMsgModal (delegated listener)
      const body = document.createElement('span');
      body.textContent = m.text;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = fmtTime(m.ts);
      if (m.dir === 'out') {
        meta.appendChild(iconEl(STATE_MARK[m.state] ?? 'stateSending', m.state === 'failed' ? 'icon-danger' : ''));
      }
      li.append(body, meta);
      frag.appendChild(li);
    }
    list.replaceChildren(frag);
    list.scrollTop = list.scrollHeight;
    return msgs[msgs.length - 1]; // newest displayed message, for the read marker
  }

  // --- message modal (tap a bubble): readable scrollable text + fixed actions ---

  let msgId = null; // message currently shown in the modal

  function openMsgModal(rec) {
    msgId = rec.id;
    $('msg-modal-title').textContent = rec.dir === 'out' ? 'Sent message' : 'Message';
    $('msg-modal-time').textContent = `${rec.peer} · ${new Date(rec.ts).toLocaleString()}`;
    const textEl = $('msg-modal-text');
    textEl.textContent = rec.text;
    textEl.scrollTop = 0;
    setStatus($('msg-modal-status'), '');
    $('msg-overlay').hidden = false;
    $('msg-modal').hidden = false;
    $('btn-msg-close').focus?.();
  }

  function msgModalOpen() {
    return !$('msg-modal').hidden;
  }

  function closeMsgModal() {
    msgId = null;
    $('msg-overlay').hidden = true;
    $('msg-modal').hidden = true;
  }

  async function copyMessageText() {
    const text = $('msg-modal-text').textContent ?? '';
    let ok = false;
    try {
      await navigator.clipboard.writeText(text); // standard path (secure context)
      ok = true;
    } catch {
      // Fallback (denied / older engine): off-screen textarea + execCommand.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'copy-helper';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    setStatus(
      $('msg-modal-status'),
      ok ? 'Copied ✓' : 'Copy failed — select the text and copy manually.',
      !ok,
    );
  }

  async function deleteCurrentMsg() {
    if (!msgId) return;
    await deleteMessage(msgId);
    closeMsgModal();
    await render();
    onHomeRefresh?.();
  }

  function forwardCurrentMsg() {
    if (!msgId) return;
    const id = msgId; // capture BEFORE close: closeMsgModal() nulls the state
    const text = $('msg-modal-text').textContent ?? '';
    closeMsgModal();
    openForward(id, text);
  }

  // --- chat-options modal (header ⋮): clear chat today; report/block land
  //     here later. Modal (not dropdown) so it survives any re-render and
  //     needs no outside-click machinery. ---

  // --- trust UI: friends = IDENTITY-BOUND one-way trust. Anything short of
  //     a live-matching binding (stranger, legacy/unbound, changed, gone)
  //     shows the stranger/gone marks — strict by policy (option B) ---

  async function friendEntryFor(peer) {
    if (!peer) return undefined;
    return (await loadFriends()).find((f) => f.peer === peer);
  }

  // "is friend" helper retired — trustState()/friendEntryFor() drive all
  // menu and strip decisions now.

  // One place that turns (mirror entry, local pin, chat state) into the
  // shared peername trust state — red / orange / green ladder.
  function trustState(ent, pin) {
    return resolvePeerState({
      gone: peerGone || !!ent?.gone,
      bound: !!ent?.trusted && pinState !== 'changed',
      verified: !!ent?.verified,
      trusted: !!ent?.trust,
      conflict: !!pin && !!ent?.pub && pin.p !== ent.pub,
    });
  }

  async function updateTrustUI() {
    const warn = $('chat-warn');
    const headStatus = $('chat-peer-status');
    if (!currentPeer) {
      if (warn) warn.hidden = true;
      headStatus?.replaceChildren();
      return;
    }
    const ent = await friendEntryFor(currentPeer);
    const pin = await getPin(currentPeer);
    const state = trustState(ent, pin);
    const gone = state === PS.GONE;

    headStatus.replaceChildren(peerStateIcon(state));
    $('chat-peer').parentElement.classList.toggle('gone', gone);

    // plain-language strips, tiered: red (danger) / orange (warn).
    // No strip once TRUSTED (or when the chat is self/unknown state).
    const MSG = {
      [PS.GONE]: ['danger', 'userGone', peerHadHistory
        ? 'This account was deleted. Your saved messages stay readable, but you can’t send new ones.'
        : `${currentPeer} doesn’t exist — no account with this name was found.`],
      [PS.STRANGER]: ['danger', 'notFriend', `You haven’t added ${currentPeer} yet. Messages are private, but anyone can sign up with a name — add them, then verify, to be sure it’s really them.`],
      [PS.UNVERIFIED]: ['warn', 'friend', `You’ve added ${currentPeer}, but haven’t verified them. Read the safety number aloud together (a call works) — when both screens match, nobody is in between. Open ⋮ and tap “Verify user”.`],
      [PS.VERIFIED]: ['warn', 'friendVerified', `You’ve verified ${currentPeer}’s key, but haven’t trusted them yet. Only trust accounts you actually know in person — open ⋮ and tap “Trust user” when you’re sure.`],
    };
    let tier;
    let text;
    if (conflictAlert(ent, pin)) {
      tier = 'danger';
      text = `Heads up: the key this device remembers for ${currentPeer} doesn’t match the server’s. Until you’ve checked the number together, treat this chat with suspicion.`;
    } else if (pinState === 'changed' && !gone) {
      tier = 'danger';
      text = `Heads up: ${currentPeer}’s identity key changed on this device. If they reinstalled or re-created their account that can be normal — but verify them again before trusting new messages.`;
    } else {
      [tier, , text] = MSG[state] ?? [];
    }
    warn.classList.toggle('danger', tier === 'danger');
    warn.classList.toggle('warn', tier === 'warn');
    warn.hidden = !text;
    if (text) {
      warn.replaceChildren(
        iconEl(MSG[state]?.[1] ?? 'notFriend', tier === 'danger' ? 'icon-danger' : 'icon-warn'),
        document.createTextNode(` ${text}`),
      );
    }
  }

  // local-pin disagreement with the server binding (the loud case)
  function conflictAlert(ent, pin) {
    return !!pin && !!ent?.pub && pin.p !== ent.pub && pinState !== 'changed';
  }

  // Menu primary row is the NEXT STEP of the ladder: Add user → Verify
  // user → Trust user → (trusted) Safety number. Remove is its own row.
  function menuActionLabel(state, peer) {
    const btn = $('btn-chat-friend');
    const LABELS = {
      [PS.STRANGER]: ['userAdd', '', `Add ${peer}`],
      [PS.UNVERIFIED]: ['friendVerify', 'icon-warn', 'Verify user'],
      [PS.VERIFIED]: ['friendVerified', 'icon-friend', 'Trust user'],
      [PS.TRUSTED]: ['identity', 'icon-friend', 'Safety number'],
      [PS.GONE]: ['userGone', 'icon-danger', 'User deleted'],
      [PS.SELF]: ['userSolid', '', 'This is you'],
    };
    const [icon, cls, label] = LABELS[state] ?? LABELS[PS.STRANGER];
    btn.replaceChildren(iconEl(icon, cls), document.createTextNode(` ${label}`));
    btn.disabled = state === PS.GONE || state === PS.SELF;
    $('btn-chat-remove').closest('.menu-row').hidden = !(state === PS.UNVERIFIED || state === PS.VERIFIED || state === PS.TRUSTED);
  }

  // Menu primary row dispatch: the next step of the ladder. VERIFY/VIEW
  // swap the side menu IN PLACE (the panel lives inside it — closing first
  // would hide what we just showed); ADD/TRUST end with a result (status
  // line / confirm modal above the scrim) so those dismiss the menu.
  async function primaryAction() {
    if (!currentPeer) return;
    const ent = await friendEntryFor(currentPeer);
    const pin = await getPin(currentPeer);
    const state = trustState(ent, pin);
    if (state === PS.UNVERIFIED || state === PS.TRUSTED) {
      await showIdentityView();
      return;
    }
    closeChatOpts();
    if (state === PS.STRANGER) await addUser();
    else if (state === PS.VERIFIED) await confirmTrust();
  }

  async function addUser() {
    try {
      const entries = await client.addFriend(currentPeer);
      const entry = entries.find((f) => f.u === currentPeer);
      // The server-stamped binding MUST match the key WE pinned from our
      // own lookups. A disagreement is a fact no server opinion can
      // explain away: refuse the bind and warn (possible hostile or
      // inconsistent server, or an unconfirmed key change).
      const pin = await getPin(currentPeer);
      if (pin && entry?.p && entry.p !== pin.p) {
        await client.removeFriend(currentPeer).catch(() => {});
        toast(`Couldn’t add ${currentPeer}: the key we remember on this device doesn’t match what the server says. Open the safety number and check it together before trusting this name.`, 'error');
        await updateTrustUI();
        return;
      }
      await friendAdd(currentPeer, entry?.p ?? '');
      if (entry?.p) await recordPinSeen(currentPeer, entry.p);
      toast(`${currentPeer} added — now verify the safety number to be sure it’s really them.`);
      await updateTrustUI();
      onHomeRefresh?.();
    } catch (err) {
      toast(humanError(err), 'error');
    }
  }

  async function removeUser() {
    const ok = await confirmModal({
      title: 'Remove user?',
      body: `You’ll stop trusting ${currentPeer}. Chat history stays on this device.`,
      okLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    try {
      await client.removeFriend(currentPeer);
      await friendDel(currentPeer);
      toast(`${currentPeer} removed.`);
      await updateTrustUI();
      onHomeRefresh?.();
    } catch (err) {
      toast(humanError(err), 'error');
    }
  }

  // Third stage behind a deliberate warning (the server also requires the
  // verify stage — a key never confirmed can’t be "trusted").
  async function confirmTrust() {
    // informed vouching: show the account's App status + Social reputation
    // (live from the stats endpoint) right where the decision is made
    let stats = null;
    try { stats = await client.userStats(currentPeer); } catch { /* offline: unknown */ }
    const app = !peerIdentityKnown ? 'App: unknown'
      : peerIdentityVerified ? 'App: Verified' : 'App: UNVERIFIED';
    const social = stats ? (stats.socialTrusted ? 'Social: Trusted' : 'Social: Untrusted') : 'Social: unknown';
    const ok = await confirmModal({
      title: `Trust ${currentPeer}?`,
      subline: `${app} · ${social}${stats ? ` · CoCo: ${stats.coco}` : ''}`,
      body: 'Trusting someone is also vouching for them on this platform — your '
        + 'vouch counts toward this profile’s reputation. Only trust people you '
        + 'actually know, after comparing safety numbers.',
      warning: 'Only trust people you know. Trusting scammers can get YOU banned.',
      okLabel: 'I know and trust them', danger: true,
    });
    if (!ok) return;
    try {
      await client.setFriendTrusted(currentPeer, true);
      await friendMarkFlags(currentPeer, { trust: true });
      toast(`${currentPeer} trusted.`);
      await updateTrustUI();
      onHomeRefresh?.();
    } catch (err) {
      toast(humanError(err), 'error');
    }
  }

  // "bound" for menu purposes = the key binding itself is valid

  // --- chat options side menu (header ⋮): the next-step action + remove +
  //     clear; report/block land here later. Modal (not dropdown) on
  //     purpose: an early in-bubble actions design was killed by the
  //     click-triggered catchUp re-render wiping the focus state mid-gesture
  //     — overlay DOM survives render(). ---

  async function openChatOpts() {
    if (!currentPeer) return;
    $('chatopts-title').textContent = currentPeer;
    renderIdentityBadge($('chatopts-badge'));
    const ent = await friendEntryFor(currentPeer);
    const pin = await getPin(currentPeer);
    const state = trustState(ent, pin);
    menuActionLabel(state, currentPeer);
    $('chatopts-peer-status').replaceChildren(peerStateIcon(state));
    $('chatopts-menu-view').hidden = false;
    $('chatopts-identity-view').hidden = true;
    $('chatopts-overlay').hidden = false;
    $('chatopts-modal').hidden = false;
    setMenuBtnOpen(true);
    $('chatopts-modal').focus?.();
  }

  // --- safety-number view (inside the chat-options side menu) ---

  // ---- profile: TOP sheet (separate from the chat menu), opened by the
  // chat-head name or the menu row. Colour-coded identity + trust stage. ----



  // Profile "Safety" section: three labelled verdicts — App (platform ID
  // verification), Social (how the network vouches: counts + CoCo score,
  // see docs/COCO_SCORE.md) and You (where THIS user stands on the ladder).
  const YOU_STAGES = {
    [PS.STRANGER]: ['bad', 'You: Not added', 'You haven’t added this account. Anyone can register a name — add them, then compare safety numbers.'],
    [PS.UNVERIFIED]: ['warn', 'You: Added', 'Added, but the safety number isn’t confirmed. Read it together (chat menu → “Verify user”) to rule out an interceptor.'],
    [PS.VERIFIED]: ['warn', 'You: Verified', 'You confirmed the safety number, but haven’t trusted them yet. Trusting vouches for them on the platform.'],
    [PS.TRUSTED]: ['ok', 'You: Trusted', 'You verified the number and trust this account — that trust counts as a public vouch in their reputation.'],
  };

  async function renderProfileView() {
    if (!currentPeer) return;
    $('profile-name').textContent = currentPeer;
    $('profile-avatar').textContent = currentPeer.slice(0, 1);
    const ent = await friendEntryFor(currentPeer);
    const pin = await getPin(currentPeer);
    const state = trustState(ent, pin);
    $('profile-status-icon').replaceChildren(peerStateIcon(state));
    renderAccountStage(peerJoinedAt ? new Date(peerJoinedAt).getTime() : null);

    // peer profile (bio public; avatar ONLY on mutual add — server rule):
    // show photo when present, else the initial circle
    const avatarEl = $('profile-avatar-img');
    const initialEl = $('profile-avatar');
    const bioEl = $('profile-bio');
    avatarEl.hidden = true;
    initialEl.hidden = false;
    bioEl.hidden = true;
    try {
      const prof = await client.viewProfile(currentPeer);
      if (prof.bio) { bioEl.textContent = prof.bio; bioEl.hidden = false; }
      rememberPeerAvatar(currentPeer, prof.avatar).catch(() => {});
      if (prof.avatar) {
        avatarEl.src = `data:${prof.avatarType || 'image/jpeg'};base64,${prof.avatar}`;
        avatarEl.hidden = false;
        initialEl.hidden = true;
      }
    } catch { /* offline / deleted: initials + no bio */ }

    const appState = $('profile-app-state');
    const appNote = $('profile-app-note');
    const socialState = $('profile-social-state');
    const socialNote = $('profile-social-note');
    const youState = $('profile-you-state');
    const youNote = $('profile-you-note');
    const rep = $('profile-reputation');
    const coco = $('profile-coco');
    rep.hidden = true;
    coco.hidden = true;

    const setRow = (stateEl, noteEl, cls, title, note) => {
      stateEl.textContent = title;
      stateEl.className = `profile-id-state ${cls}`;
      noteEl.textContent = note ?? '';
    };

    // vanished peers: ONE verdict, nothing else
    if (peerGone || ent?.gone) {
      setRow(appState, appNote, 'bad',
        peerHadHistory ? 'Account deleted' : 'User not found',
        peerHadHistory
          ? 'This account no longer exists. Your saved messages stay readable, but nothing new can be sent.'
          : 'No account with this name exists — nothing you send can be delivered.');
      [socialState, socialNote, youState, youNote].forEach((el) => { el.hidden = true; });
      $('profile-account-state').hidden = true;
      $('profile-joined').hidden = true;
      $('profile-coco').hidden = true;
      return;
    }
    [socialState, socialNote, youState, youNote].forEach((el) => { el.hidden = false; });

    // App
    if (peerIdentityKnown && peerIdentityVerified) {
      setRow(appState, appNote, 'ok', 'App: Verified',
        'This account handed an ID document to a human reviewer — the person behind it has been checked.');
    } else if (peerIdentityKnown) {
      setRow(appState, appNote, 'bad', 'App: Unverified',
        'No ID has been checked for this account. Scammers typically use unverified accounts — they are cheap to set up and throw away.');
    } else {
      setRow(appState, appNote, '', 'App: Unknown', 'Open this chat while online to check the account status.');
    }

    // Social + counts + CoCo (fetched once; hidden when offline)
    let stats = null;
    try { stats = await client.userStats(currentPeer); } catch { /* offline */ }
    if (stats) {
      const trusted = stats.socialTrusted === true;
      setRow(socialState, socialNote, trusted ? 'ok' : 'bad',
        trusted ? 'Social: Trusted' : 'Social: Untrusted',
        trusted
          ? 'Other people vouch for this account. Every vouch is a risk for the voucher — scammer contacts get their trustors reported and removed.'
          : 'Nobody vouches for this account yet. Be extra careful: trust must be earned here, not assumed.');
      rep.textContent = `Vouched by ${stats.addedBy} added · ${stats.verifiedBy} verified · ${stats.trustedBy} trusted`;
      rep.hidden = false;
      coco.textContent = `CoCo: ${stats.coco} — Social Score`;
      coco.hidden = false;
    } else {
      setRow(socialState, socialNote, '', 'Social: Unknown', 'Reputation counts need a connection.');
    }

    // You (the local ladder)
    const [cls, title, desc] = YOU_STAGES[state] ?? YOU_STAGES[PS.STRANGER];
    setRow(youState, youNote, `trust ${cls}`, title, desc);
  }

  async function openProfileView() {
    if (!currentPeer) return;
    closeChatOpts(); // the sheet replaces the menu, never stacks on it
    await renderProfileView();
    $('profile-overlay').hidden = false;
    $('profile-modal').hidden = false;
    $('profile-modal').focus?.();
  }

  // Self preview: same sheet, fed by our own public data — exactly what a
  // mutually-added contact sees (App verdict, Social reputation, CoCo).
  async function openSelfProfile() {
    const meUl = String(client.username ?? '').toLowerCase();
    if (!meUl) return;
    let me = null, prof = null, stats = null;
    try { me = await client.identity(); } catch { /* offline */ }
    try { prof = await client.viewProfile(meUl); } catch { /* offline */ }
    try { stats = await client.userStats(meUl); } catch { /* offline */ }
    $('profile-name').textContent = meUl;
    const avatarImg = $('profile-avatar-img');
    const initial = $('profile-avatar');
    if (prof?.avatar) {
      avatarImg.src = `data:image/jpeg;base64,${prof.avatar}`;
      avatarImg.hidden = false;
      initial.hidden = true;
    } else {
      avatarImg.hidden = true;
      initial.hidden = false;
      initial.textContent = meUl.slice(0, 1);
    }
    const bioEl = $('profile-bio');
    bioEl.hidden = !prof?.bio;
    if (prof?.bio) bioEl.textContent = prof.bio;
    $('profile-status-icon').replaceChildren(peerStateIcon(PS.TRUSTED));
    renderAccountStage(me?.createdAt ? new Date(me.createdAt).getTime() : null);

    const setRow = (s, n, cls, title, note) => {
      s.textContent = title;
      s.className = `profile-id-state ${cls}`;
      n.textContent = note ?? '';
    };
    if (me?.verified) {
      setRow($('profile-app-state'), $('profile-app-note'), 'ok', 'App: Verified',
        'A human reviewer checked your ID — contacts see the green mark.');
    } else {
      setRow($('profile-app-state'), $('profile-app-note'), 'bad', 'App: Unverified',
        me?.idDoc ? 'Your ID photo is submitted and waiting for review.'
                  : 'Upload an ID photo in settings to earn the green mark (or be vouched for and verified directly).');
    }
    if (stats) {
      setRow($('profile-social-state'), $('profile-social-note'),
        stats.socialTrusted ? 'ok' : 'bad',
        stats.socialTrusted ? 'Social: Trusted' : 'Social: Untrusted',
        'Reputation grows when contacts verify and trust you.');
      $('profile-reputation').textContent =
        `Vouched by ${stats.addedBy} added · ${stats.verifiedBy} verified · ${stats.trustedBy} trusted`;
      $('profile-reputation').hidden = false;
      $('profile-coco').textContent = `CoCo: ${stats.coco} — Social Score`;
      $('profile-coco').hidden = false;
    } else {
      setRow($('profile-social-state'), $('profile-social-note'), '', 'Social: unknown',
        'Reputation needs a connection.');
      $('profile-reputation').hidden = true;
      $('profile-coco').hidden = true;
    }
    setRow($('profile-you-state'), $('profile-you-note'), 'trust ok', 'You: Trusted',
      'This is your public profile — exactly what mutually-added contacts see.');

    $('profile-overlay').hidden = false;
    $('profile-modal').hidden = false;
    $('profile-modal').focus?.();
  }

  function closeProfileView() {
    $('profile-overlay').hidden = true;
    $('profile-modal').hidden = true;
  }

  // Shared "back to menu": re-render the ladder row (it may have advanced
  // while another view was open) and return to the menu panel.
  async function showChatOptsMenu() {
    $('chatopts-identity-view').hidden = true;
    $('chatopts-menu-view').hidden = false;
    if (currentPeer) {
      const ent = await friendEntryFor(currentPeer);
      const pin = await getPin(currentPeer);
      menuActionLabel(trustState(ent, pin), currentPeer);
    }
  }

  async function showIdentityView() {
    if (!currentPeer) return;
    $('chatopts-menu-view').hidden = true;
    $('chatopts-identity-view').hidden = false;
    $('identity-peer').textContent = currentPeer;
    const pin = await getPin(currentPeer);
    const peerKey = pin?.p ?? peerIdentity;
    // OUR side of the pair: the account identity key (same value on every
    // one of our devices — the server stores it; own lookup is allowed).
    let myKey = null;
    try {
      myKey = (await client.peerKeys(client.username))?.id ?? null;
    } catch { /* offline / lookup failed: handled as 'not available' */ }
    const statusIcon = $('identity-status-icon');
    const numEl = $('identity-number-text');
    const box = $('identity-number');
    box.classList.remove('copied');
    $('identity-copy-label').textContent = 'Copy';
    if (!peerKey || !myKey) {
      statusIcon.replaceChildren(iconEl('notFriend', 'icon-danger'));
      numEl.textContent = 'Safety number not available yet.';
      $('identity-since').textContent = peerKey
        ? 'Open a chat with yourself once while online (fetches your account identity).'
        : 'Open a chat with this user first.';
      $('btn-identity-verify').disabled = true;
      return;
    }
    numEl.textContent = await safetyNumber(myKey, peerKey);
    const ent = await friendEntryFor(currentPeer);
    const verified = !!ent?.verified;
    statusIcon.replaceChildren(peerStateIcon(trustState(ent, pin)));
    $('identity-since').textContent = pin
      ? `Key remembered on this device since ${new Date(pin.firstSeenAt).toLocaleString()}`
        + (pin.changedAt ? ` — it changed ${new Date(pin.changedAt).toLocaleString()}, verification was reset` : '')
      : 'This device has not seen the key directly yet.';
    const vb = $('btn-identity-verify');
    vb.disabled = !ent?.trusted; // verification needs a live binding
    vb.replaceChildren(
      iconEl(verified ? 'friendRemove' : 'friendVerify'),
      document.createTextNode(verified ? ' Undo verification' : ' We compared — mark verified'),
    );
    vb.classList.toggle('danger', verified);
  }

  // Tap the number box anywhere: copy, highlight (.copied until next
  // render), label confirms and reverts — tapping again re-copies.
  let copyFlashTimer = null;
  async function copySafetyNumber() {
    const text = $('identity-number-text').textContent ?? '';
    if (!text || text.startsWith('Safety number not available')) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text); // secure-context path
      ok = true;
    } catch {
      const ta = document.createElement('textarea'); // fallback (denied/old)
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'copy-helper';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    const box = $('identity-number');
    box.classList.toggle('copied', ok);
    $('identity-copy-label').textContent = ok ? 'Copied ✓' : 'Copy failed';
    clearTimeout(copyFlashTimer);
    if (ok) copyFlashTimer = setTimeout(() => { $('identity-copy-label').textContent = 'Copy'; }, 1800);
  }

  async function toggleVerified() {
    if (!currentPeer) return;
    const ent = await friendEntryFor(currentPeer);
    if (!ent?.trusted) return;
    try {
      await client.setFriendVerified(currentPeer, !ent.verified);
      await friendMarkFlags(currentPeer, { verified: !ent.verified, trust: false });
      toast(ent.verified ? 'Verification undone.' : 'Verified ✓ — now trust them if you know this person.');
      await showIdentityView();
      await updateTrustUI();
      onHomeRefresh?.();
    } catch (err) {
      toast(humanError(err), 'error');
    }
  }

  function closeChatOpts() {
    $('chatopts-overlay').hidden = true;
    $('chatopts-modal').hidden = true;
    setMenuBtnOpen(false);
  }

  function toggleChatOpts() {
    if ($('chatopts-modal').hidden) openChatOpts();
    else closeChatOpts();
  }

  // Header button morphs ⋮ <-> ✕ as the side menu opens/closes (FA Free has
  // no true morph; swap + keyframe spin-in reads as one). The open button
  // lifts above the scrim so tapping it closes the menu.
  function setMenuBtnOpen(open) {
    const btn = $('btn-chat-menu');
    const i = btn.querySelector('i');
    btn.classList.toggle('menu-open', open);
    if (i) i.className = `fa-solid ${open ? 'fa-xmark' : 'fa-ellipsis-vertical'}`;
    btn.title = open ? 'Close chat options' : 'Chat options';
  }

  // --- forward dialog ---

  let forwardId = null;
  const forwardSuggestions = createPeerSuggestions($('forward-peers'));

  async function openForward(id, text) {
    forwardId = id;
    $('forward-preview').textContent = text;
    setStatus($('forward-status'), '');
    $('forward-username').value = '';
    $('btn-forward-send').classList.remove('ready');
    $('forward-overlay').hidden = false;
    $('forward-modal').hidden = false;
    await forwardSuggestions.refresh(); // local users, filtered as you type
    $('forward-username').focus?.();
  }

  function closeForward() {
    forwardId = null;
    $('forward-overlay').hidden = true;
    $('forward-modal').hidden = true;
  }

  function forwardOpen() {
    return !$('forward-modal').hidden;
  }

  async function sendForward(targetArg) {
    const status = $('forward-status');
    const target = String(targetArg ?? $('forward-username').value).trim().toLowerCase();
    if (!target) { setStatus(status, 'Enter a username to forward to.', true); return; }
    const rec = forwardId && (await getMessage(forwardId));
    if (!rec) { closeForward(); return; }
    const btn = $('btn-forward-send');
    btn.disabled = true;
    try {
      const { localId } = await client.sendMessage(target, rec.text);
      await saveMessage({ id: `out:${localId}`, peer: target, dir: 'out', text: rec.text, ts: Date.now(), state: 'sending' });
      closeForward();
      toast(`Forwarded to ${target}`);
      onHomeRefresh?.();
      if (currentPeer === target) await render();
    } catch (err) {
      setStatus(status, humanError(err), true);
    } finally {
      btn.disabled = false;
    }
  }

  // --- opening ---

  // Peer facts from a keys lookup, applied wherever they surface (openChat
  // and post-send re-checks): identity anchors, chat-head badge + sub line,
  // and the verified-flag cache the sidebar renders from.
  async function applyPeerFacts(peer) {
    peerIdentity = peer?.id ?? null;
    peerIdentityKnown = !!peer;
    peerJoinedAt = peer?.joinedAt ?? null;
    peerIdentityVerified = !!peer?.verified;
    $('chat-sub').replaceChildren(...chatSubNodes(peer));
    renderIdentityBadge($('chat-peer-badge'));
    if (peer) await rememberPeerVerified(currentPeer, peerIdentityVerified);
  }

  // Record a security heads-up in the timeline + sync it to all our devices.
  async function announceNotice(peer, code) {
    const text = NOTICE_TEXT[code]?.(peer);
    if (!text || !peer) return;
    const id = crypto.randomUUID();
    await saveMessage({ id: `sys:${id}`, peer, dir: 'sys', text, ts: Date.now() });
    client.sendNotice?.(id, peer, code); // best-effort; queue covers offline
    await render();
    onHomeRefresh?.();
  }

  // ---- vanished-peer state machine (unknown_recipient acks) ----
  // The ack itself is AUTHORITATIVE for "this recipient could not be
  // resolved" — flip the UI into the deleted/gone state IMMEDIATELY
  // (optimistic), then re-resolve in the background to (a) confirm and emit
  // the timeline notice + toast wording, or (b) walk it back when the
  // account actually exists and only the addressed device was stale.
  let rechecking = false;
  let goneApplied = false;   // state flip done for this chat session
  let goneAnnounced = false; // notice+toast emitted for this chat session

  async function applyGoneState() {
    if (goneApplied) return;
    goneApplied = true;
    peerGone = true;
    await applyPeerFacts(null);
    await markPeerGone(currentPeer, true);
    await friendMarkFlags(currentPeer, { gone: true });
    setComposerEnabled(false);
    await updateTrustUI();
    onHomeRefresh?.();
  }

  async function finishGoneVerdict() {
    if (goneAnnounced) return;
    goneAnnounced = true;
    await applyGoneState();
    // chat-head is ground truth again after the verdict (sub-line + ladder
    // icon), regardless of what rendered while the re-check was in flight
    await applyPeerFacts(null);
    await updateTrustUI();
    await announceNotice(currentPeer, peerHadHistory ? 'account-deleted' : 'user-gone');
    toast(peerHadHistory
      ? `${currentPeer}'s account was deleted — history is read-only now.`
      : `${currentPeer} doesn’t exist — nothing was delivered.`, 'error');
  }

  async function recheckPeerAfterSend() {
    if (!currentPeer || rechecking) return;
    rechecking = true;
    try {
      const fresh = await client.peerKeys(currentPeer, { refresh: true });
      // account EXISTS — the unknown_recipient was about a stale DEVICE,
      // not a deleted account: walk the optimistic state back
      peerGone = false;
      goneApplied = false;
      await applyPeerFacts(fresh);
      await markPeerGone(currentPeer, false);
      setComposerEnabled(true);
      await updateTrustUI();
      onHomeRefresh?.();
    } catch (err) {
      if (err?.code === 'unknown_account' || err?.status === 404) {
        await finishGoneVerdict();
      }
      // any other error (offline, transient): keep the optimistic gone
      // state — the ack was real (it arrived over the live socket)
    } finally {
      rechecking = false;
    }
  }

  async function openChat(username) {
    const status = $('home-status');
    try {
      let peer = null;
      peerGone = false;
      goneApplied = false;
      goneAnnounced = false;
      try {
        peer = await client.peerKeys(username); // validates existence, caches
      } catch (err) {
        // Deleted account (last device removed => account deleted):
        // enter read-only ghost mode over the local transcript instead of
        // throwing — the user must still be able to READ the history.
        if (err?.code === 'unknown_account' || err?.status === 404) peerGone = true;
        // Offline read-only mode (no session): fall back to the local store.
        else if (navigator.onLine === false && !client.token) peer = null;
        else throw err;
      }
      currentPeer = (peer?.u ?? username).toLowerCase();
      $('chat-peer').textContent = `${currentPeer}`;
      await applyPeerFacts(peer);
      setComposerEnabled(!peerGone);
      $('chat-empty').hidden = true;
      $('chat-view').hidden = false;
      setChatOpen(true);
      const last = await render();
      // history = a real conversation existed at open: something received,
      // or something sent that the server accepted (sent/delivered). A
      // failed 'sending'/'failed' out-copy does NOT count — it would fake
      // the "account deleted" obituary for a peer we never actually talked to.
      renderChatAvatar().catch(() => {});
      client.viewProfile(currentPeer)
        .then((prof) => rememberPeerAvatar(currentPeer, prof.avatar))
        .catch(() => {});
      peerHadHistory = (await messagesWith(currentPeer)).some((m) =>
        m.dir === 'in' || (m.dir === 'out' && (m.state === 'sent' || m.state === 'delivered')));
      // Identity verification: compare the stored friend binding against the
      // LIVE account key from this very lookup. Mismatch (or server-flagged
      // 'changed') = the username was re-registered: drop trust on EVERY
      // device of ours — server delete + our own sys broadcast converge the
      // mirrors; the warning strip then shows the stranger state.
      // Persist "this account is gone / is back" for the sidebar: it only
      // learns from the local mirror, and the server purges dead names from
      // friends lists. Skipped in pure-offline mode (no facts learned).
      if (peerGone) { goneApplied = true; goneAnnounced = true; await markPeerGone(currentPeer, true); }
      else if (peer) await markPeerGone(currentPeer, false);
      pinState = peerIdentity ? await recordPinSeen(currentPeer, peerIdentity) : 'ok';
      if (pinState === 'changed') {
        // OUR pin — not the server's opinion — says the key moved. Same
        // convergence treatment as a stale binding.
        client.removeFriend(currentPeer).catch(() => {});
        await friendDel(currentPeer);
        await announceNotice(currentPeer, 'trust-revoked');
      }
      const ent = await friendEntryFor(currentPeer);
      if (peer && ent && (ent.changed || (peer.id && ent.pub && ent.pub !== peer.id))) {
        client.removeFriend(currentPeer).catch(() => {});
        await friendDel(currentPeer);
        toast(`Trust removed — ${currentPeer}'s account identity changed (username re-registered). Re-add to re-bind.`, 'error');
        await announceNotice(currentPeer, 'trust-revoked');
      }
      await updateTrustUI();
      // Read up to the newest DISPLAYED message (server-assigned ts): marking
      // with the local clock could miss messages the server stamped a few ms
      // 'ahead', which would leave the unread dot stubbornly on.
      markRead(currentPeer, last?.ts ?? Date.now());
      onHomeRefresh?.(); // repaint the list NOW: the dot must go with it
      if (!peerGone) $('chat-input').focus();
    } catch (err) {
      setStatus(status, humanError(err), true);
    }
  }

  // Composer lock for deleted-account ghost chats: input + send disabled
  // (sendCurrent also guards, so Enter can't bypass the dead button).
  function setComposerEnabled(enabled) {
    const input = $('chat-input');
    const btn = $('btn-send');
    input.disabled = !enabled;
    btn.disabled = !enabled;
    input.placeholder = enabled ? 'Type a message' : `${currentPeer ?? 'This user'} no longer exists`;
  }

  function wire() {
    const sendBtn = $('btn-send');
    // Mobile: a button tap normally moves focus off the input, tearing the
    // soft keyboard down after every send. Suppressing the pointerdown
    // DEFAULT keeps focus on the input (click still fires) — send therefore
    // does NOT hide the keyboard; tapping elsewhere/chat chrome still does.
    sendBtn.addEventListener('pointerdown', (e) => e.preventDefault());
    sendBtn.addEventListener('click', sendCurrent);
    $('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendCurrent();
    });
    document.getElementById('notif-banner')?.addEventListener('click', (e) => {
      const peer = e.target.dataset?.peer;
      e.target.hidden = true;
      if (peer) openChat(peer);
    });

    const closeChatPane = () => {
      currentPeer = null;
      closeProfileView();
      setChatOpen(false);
      $('chat-view').hidden = true;
      $('chat-empty').hidden = false;
      closeMsgModal();
      closeChatOpts();
      closeForward();
      onHomeRefresh?.();
    };
    $('btn-chat-back').addEventListener('click', closeChatPane);
    // Escape: dismiss the top-most layer first (forward > message > options
    // > conversation). Desktop "close" gesture otherwise.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('lightbox-overlay')?.hidden) { closeLightbox(); return; }
      if (forwardOpen()) { closeForward(); return; }
      if (!$('profile-modal')?.hidden) { closeProfileView(); return; }
      if (msgModalOpen()) { closeMsgModal(); return; }
      if (!$('chatopts-modal').hidden) { closeChatOpts(); return; }
      if (document.body.classList.contains('chat-open')) closeChatPane();
    });

    // Tap/click a bubble -> message modal (delegated: bubbles re-render
    // atomically, so the listener lives on the list itself).
    $('chat-messages').addEventListener('click', (e) => {
      const li = e.target.closest('li.msg');
      if (!li) return;
      getMessage(li.dataset.id).then((rec) => {
        if (rec && rec.id === li.dataset.id) openMsgModal(rec);
      });
    });

    // Message modal controls.
    $('btn-msg-close').addEventListener('click', closeMsgModal);
    $('msg-overlay').addEventListener('click', closeMsgModal);
    $('btn-msg-copy').addEventListener('click', copyMessageText);
    $('btn-msg-fwd').addEventListener('click', forwardCurrentMsg);
    $('btn-msg-del').addEventListener('click', deleteCurrentMsg);

    // Chat options side menu: primary = next ladder step (add/verify/trust/
    // view number); remove is its own row.
    $('btn-chat-menu').addEventListener('click', toggleChatOpts);
    // chat-head name opens the profile view directly
    $('btn-peer-profile').addEventListener('click', openProfileView);
    $('btn-chat-profile').addEventListener('click', openProfileView);
    $('chatopts-overlay').addEventListener('click', closeChatOpts);
    $('btn-chat-friend').addEventListener('click', () => {
      primaryAction(); // decides itself whether to stay open (panel) or close
    });
    $('btn-chat-remove').addEventListener('click', () => {
      closeChatOpts();
      removeUser();
    });
    $('btn-identity-back').addEventListener('click', showChatOptsMenu);
    $('identity-number').addEventListener('click', copySafetyNumber);
    $('identity-number').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copySafetyNumber(); }
    });
    $('btn-identity-verify').addEventListener('click', toggleVerified);
    $('profile-avatar-img').addEventListener('click', (e) => { if (!e.target.hidden) openLightbox(e.target.src); });
    $('btn-profile-close').addEventListener('click', closeProfileView);
    $('profile-overlay').addEventListener('click', closeProfileView);
    window.addEventListener(FRIENDS_EVENT, () => { updateTrustUI(); });
    window.addEventListener(AVATARS_EVENT, () => { renderChatAvatar(); });
    $('btn-chat-clear').addEventListener('click', async () => {
      closeChatOpts();
      if (!currentPeer) return;
      const ok = await confirmModal({
        title: 'Clear messages',
        body: `Delete all messages with ${currentPeer} on this device? Other devices and the other user keep their copies.`,
        okLabel: 'Clear', danger: true,
      });
      if (!ok || !currentPeer) return;
      const n = await clearMessages(currentPeer);
      await render();
      onHomeRefresh?.();
      toast(n ? `Cleared ${n} message${n === 1 ? '' : 's'} on this device` : '');
    });

    // Forward dialog. NB: reference forwardCurrentMsg/sendForward at CALL
    // time (not wire time) — a const binding defined further down the
    // closure would sit in the TDZ and throw during boot.
    // Fat-finger save: tapping a suggestion SELECTS (fills the field, the
    // list filters to show the pick) — sending requires the explicit Send
    // button / Enter, so there is a beat to check and cancel.
    forwardSuggestions.wireInput($('forward-username'), (p) => {
      const input = $('forward-username');
      if (input.value.trim().toLowerCase() === p) {
        input.value = ''; // tapping the already-selected name un-selects
      } else {
        input.value = p;
      }
      forwardSuggestions.paint();
      $('btn-forward-send').classList.toggle('ready', !!input.value.trim());
      input.focus?.();
    });
    $('btn-forward-cancel').addEventListener('click', closeForward);
    $('forward-overlay').addEventListener('click', closeForward);
    $('btn-forward-send').addEventListener('click', () => sendForward());
    $('forward-username').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendForward();
    });

    // Catch up on attention: when the window becomes visible/focused (or the
    // user clicks into the conversation/input) with a chat open, the messages
    // on screen are now seen — clear the dot for THIS peer only.
    const catchUp = () => {
      if (!currentPeer || !windowActive()) return;
      render().then((last) => {
        markRead(currentPeer, last?.ts ?? Date.now());
        onHomeRefresh?.();
      });
    };
    document.addEventListener('visibilitychange', catchUp);
    window.addEventListener('focus', catchUp);
    $('chat-input').addEventListener('click', catchUp);
    $('chat-messages').addEventListener('click', catchUp);
  }

  return { wire, connectEvents, openChat, render, openSelfProfile };
}
