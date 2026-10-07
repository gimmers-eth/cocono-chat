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

import { $, setStatus, setChatOpen, fmtTime, confirmModal } from '../ui.js';
import { createPeerSuggestions } from './peers.js';
import { iconEl } from '../icons.js';
import {
  saveMessage, updateMessage, messagesWith, markRead, allMessages,
  getMessage, deleteMessage, clearMessages,
  loadFriends, friendAdd, friendDel, FRIENDS_EVENT,
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
      body: `@${peer}: ${snippet || '(message)'}`,
      tag: 'cocono-activity',
      data: { type: 'msg', peer },
    })?.catch?.(() => {});
  }).catch(() => {});
}

export function createChat({ client, onHomeRefresh }) {
  let currentPeer = null; // display-cased

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
      // System messages (friend events) ride the normal E2EE path from OUR
      // OWN account: apply to the local friend mirror, NEVER the transcript.
      // Only this account can produce them (relay HMAC is keyed with the
      // sender's transport key), so the payload is trusted once decrypted —
      // but still parsed defensively.
      const selfUl = String(client.username ?? '').toLowerCase();
      if (m.peer.toLowerCase() === selfUl && /^\{"sys":"friend[-+]"/.test(m.text)) {
        try {
          const p = JSON.parse(m.text);
          if (p.sys === 'friend+') await friendAdd(p.ul);
          else if (p.sys === 'friend-') await friendDel(p.ul);
          await updateTrustUI();
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
        showBanner(`@${m.peer}: ${snippet || '(message)'}`, m.peer);
      } else if (!windowActive()) {
        notifyOS(m.peer, m.text);
      }
    });

    client.on('peerIdentityChanged', ({ peer }) => {
      showBanner(`@${peer}: key material refreshed (account re-created or device re-paired)`, peer);
    });

    client.on('ack', async ({ localId, ok, error }) => {
      if (!localId) return;
      const rec = await updateMessage(`out:${localId}`, { state: ok ? 'sent' : 'failed' });
      if (!ok) setStatus($('chat-status'), `Send rejected: ${error ?? 'unknown'}`, true);
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

    client.on('error', ({ error }) => setStatus($('chat-status'), error?.message ?? String(error), true));
  }

  // --- sending ---

  async function sendCurrent() {
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text || !currentPeer) return;
    input.value = '';
    setStatus($('chat-status'), '');
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
      setStatus(
        $('chat-status'),
        navigator.onLine === false
          ? 'Offline — messages cannot be sent yet. They stay unsent until you reconnect.'
          : err.message ?? String(err),
        true,
      );
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
    $('msg-modal-time').textContent = `@${rec.peer} · ${new Date(rec.ts).toLocaleString()}`;
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

  // --- trust UI: friends = one-way trust; strangers show a chat warning ---

  async function isCurrentPeerFriend() {
    if (!currentPeer) return false;
    const friends = await loadFriends();
    return friends.some((f) => f.peer === currentPeer);
  }

  async function updateTrustUI() {
    const warn = $('chat-warn');
    if (!warn) return;
    if (!currentPeer) { warn.hidden = true; return; }
    const friend = await isCurrentPeerFriend();
    warn.hidden = friend;
    if (!friend) {
      warn.replaceChildren(
        iconEl('notFriend', 'icon-danger'),
        document.createTextNode(` @${currentPeer} is not on your friends list — messages are `
          + 'end-to-end encrypted, but you have not marked this account as trusted.'),
      );
    }
  }

  function friendMenuLabel(isFriend, peer) {
    const btn = $('btn-chat-friend');
    const status = $('friend-status');
    // status column: the red person-with-an-x (stranger) vs green check-user
    status.replaceChildren(iconEl(isFriend ? 'friend' : 'notFriend', isFriend ? 'icon-friend' : 'icon-danger'));
    btn.replaceChildren(
      iconEl(isFriend ? 'friendRemove' : 'friendAdd'),
      document.createTextNode(isFriend ? ` Remove @${peer} as friend` : ` Add @${peer} as friend`),
    );
    btn.classList.toggle('danger', isFriend);
  }

  async function toggleFriend() {
    if (!currentPeer) return;
    const wasFriend = await isCurrentPeerFriend();
    try {
      if (wasFriend) {
        await client.removeFriend(currentPeer);
        await friendDel(currentPeer);
      } else {
        await client.addFriend(currentPeer);
        await friendAdd(currentPeer);
      }
      setStatus($('chat-status'), wasFriend
        ? `@${currentPeer} removed from friends`
        : `@${currentPeer} added as friend`);
      await updateTrustUI();
      onHomeRefresh?.();
    } catch (err) {
      setStatus($('chat-status'), err.message ?? String(err), true);
    }
  }

  // --- chat options modal (header ⋮): friend toggle + clear chat today;
  //     report/block land here later. Modal (not dropdown) on purpose: an
  //     early in-bubble actions design was killed by the click-triggered
  //     catchUp re-render wiping the focus state mid-gesture — overlay DOM
  //     survives render(). ---

  async function openChatOpts() {
    if (!currentPeer) return;
    $('chatopts-title').textContent = `Chat options — @${currentPeer}`;
    friendMenuLabel(await isCurrentPeerFriend(), currentPeer);
    $('chatopts-overlay').hidden = false;
    $('chatopts-modal').hidden = false;
    $('btn-chatopts-close').focus?.();
  }

  function closeChatOpts() {
    $('chatopts-overlay').hidden = true;
    $('chatopts-modal').hidden = true;
  }

  // --- forward dialog ---

  let forwardId = null;
  const forwardSuggestions = createPeerSuggestions($('forward-peers'));

  async function openForward(id, text) {
    forwardId = id;
    $('forward-preview').textContent = text;
    setStatus($('forward-status'), '');
    $('forward-username').value = '';
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
      setStatus($('chat-status'), `Forwarded to @${target}`);
      onHomeRefresh?.();
      if (currentPeer === target) await render();
    } catch (err) {
      setStatus(status, err.message ?? String(err), true);
    } finally {
      btn.disabled = false;
    }
  }

  // --- opening ---

  async function openChat(username) {
    const status = $('home-status');
    try {
      let peer = null;
      try {
        peer = await client.peerKeys(username); // validates existence, caches
      } catch (err) {
        // Offline read-only mode (no session): fall back to the local store.
        if (navigator.onLine === false && !client.token) peer = null;
        else throw err;
      }
      currentPeer = (peer?.u ?? username).toLowerCase();
      $('chat-peer').textContent = `@${currentPeer}`;
      $('chat-sub').textContent = peer
        ? `${peer.devices.length} device${peer.devices.length === 1 ? '' : 's'}`
        : 'Offline — stored messages only';
      setStatus($('chat-status'), '');
      $('chat-empty').hidden = true;
      $('chat-view').hidden = false;
      setChatOpen(true);
      const last = await render();
      await updateTrustUI();
      // Read up to the newest DISPLAYED message (server-assigned ts): marking
      // with the local clock could miss messages the server stamped a few ms
      // 'ahead', which would leave the unread dot stubbornly on.
      markRead(currentPeer, last?.ts ?? Date.now());
      onHomeRefresh?.(); // repaint the list NOW: the dot must go with it
      $('chat-input').focus();
    } catch (err) {
      setStatus(status, err.message ?? String(err), true);
    }
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
      if (forwardOpen()) { closeForward(); return; }
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

    // Chat options modal.
    $('btn-chat-menu').addEventListener('click', openChatOpts);
    $('btn-chatopts-close').addEventListener('click', closeChatOpts);
    $('chatopts-overlay').addEventListener('click', closeChatOpts);
    $('btn-chat-friend').addEventListener('click', () => {
      closeChatOpts();
      toggleFriend();
    });
    window.addEventListener(FRIENDS_EVENT, () => { updateTrustUI(); });
    $('btn-chat-clear').addEventListener('click', async () => {
      closeChatOpts();
      if (!currentPeer) return;
      const ok = await confirmModal({
        title: 'Clear messages',
        body: `Delete all messages with @${currentPeer} on this device? Other devices and the other user keep their copies.`,
        okLabel: 'Clear', danger: true,
      });
      if (!ok || !currentPeer) return;
      const n = await clearMessages(currentPeer);
      await render();
      onHomeRefresh?.();
      setStatus($('chat-status'), n ? `Cleared ${n} message${n === 1 ? '' : 's'} on this device` : '');
    });

    // Forward dialog. NB: reference forwardCurrentMsg/sendForward at CALL
    // time (not wire time) — a const binding defined further down the
    // closure would sit in the TDZ and throw during boot.
    forwardSuggestions.wireInput($('forward-username'), (p) => sendForward(p));
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

  return { wire, connectEvents, openChat, render };
}
