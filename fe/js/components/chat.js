// Chat component (milestone 3): owns #view-chat plus the conversation list
// in the home view. Messages are E2EE (pairwise X25519 + HKDF conversation
// keys); the server only ever sees ciphertext, routing metadata and HMACs.
import { $, show, setStatus } from '../ui.js';
import { api, ApiError } from '../api.js';
import * as cryptoLib from '../crypto.js';
import { canonical } from '../util.js';
import { createChatSocket } from '../ws.js';
import {
  saveMessage,
  updateMessage,
  getMessage,
  messagesWith,
  allMessages,
} from '../db.js';

const MSG_STATE_MARK = { sending: '…', sent: '✓', delivered: '✓✓', failed: '✗' };

export function createChat({ getToken, getIdentity, onHomeRefresh }) {
  let socket = null;
  let currentPeer = null; // display-casing username
  const peerKeysCache = new Map(); // ul -> { u, devices: [{ d, p, x }] }
  const convKeyCache = new Map(); // `${theirUl}:${theirDv}` -> CryptoKey
  const cidToLocalId = new Map(); // outgoing cid -> local message id

  function ensureSocket(identity) {
    if (socket) return socket;
    socket = createChatSocket({
      getToken,
      onState: (state) => {
        const el = $('ws-state');
        if (el) el.textContent = state === 'open' ? 'online' : state;
      },
      onMessage: (msg) => {
        handleServerMessage(msg, identity).catch(() => {});
      },
    });
    return socket;
  }

  async function getPeerKeys(username) {
    const ul = username.toLowerCase();
    if (!peerKeysCache.has(ul)) {
      peerKeysCache.set(ul, await api.peerKeys(getToken(), username));
    }
    return peerKeysCache.get(ul);
  }

  async function getConvKey(identity, theirUl, theirDv, theirX) {
    const cacheKey = `${theirUl}:${theirDv}`;
    if (!convKeyCache.has(cacheKey)) {
      const info = cryptoLib.pairInfo(
        identity.username.toLowerCase(),
        identity.deviceId,
        theirUl,
        theirDv,
      );
      convKeyCache.set(
        cacheKey,
        await cryptoLib.deriveConversationKey(identity.xPriv, theirX, info),
      );
    }
    return convKeyCache.get(cacheKey);
  }

  // --- incoming server frames ---

  async function handleServerMessage(msg, identity) {
    if (msg.type === 'msg') {
      const m = msg.env?.m;
      if (!m) return;
      const senderUl = m.f.toLowerCase();
      // Self-chat: our own message echoes back to our device. We already have
      // it locally as outgoing — ack it so the server drops it, but don't
      // save it again as an incoming message.
      if (senderUl === identity.username.toLowerCase()) {
        socket.send({ type: 'pulled', ids: [msg.id] });
        return;
      }
      const peer = await getPeerKeys(senderUl);
      const senderDevice = peer.devices.find((dev) => dev.d === m.fd);
      if (!senderDevice) return; // message from a device we don't know — skip

      const key = await getConvKey(identity, senderUl, m.fd, senderDevice.x);
      const text = await cryptoLib.decryptFromConversation(key, m.d);
      await saveMessage({ id: msg.id, peer: peer.u, dir: 'in', text, ts: msg.ts });

      // Confirm the pull; the server then deletes its copy and notifies the
      // sender (delivery receipt).
      socket.send({ type: 'pulled', ids: [msg.id] });

      if (currentPeer && currentPeer.toLowerCase() === senderUl) renderConversation();
      onHomeRefresh?.();
      return;
    }

    if (msg.type === 'ack') {
      const localId = cidToLocalId.get(msg.cid);
      if (!localId) return;
      await updateMessage(localId, { state: msg.ok ? 'sent' : 'failed' });
      if (currentPeer) renderConversation();
      return;
    }

    if (msg.type === 'delivered') {
      const localId = cidToLocalId.get(msg.cid);
      if (!localId) return;
      const local = await getMessage(localId);
      if (local && local.state !== 'delivered') {
        await updateMessage(localId, { state: 'delivered' });
        if (currentPeer) renderConversation();
        onHomeRefresh?.();
      }
    }
  }

  // --- sending ---

  async function sendText(text) {
    const identity = await getIdentity();
    ensureSocket(identity);
    const peer = await getPeerKeys(currentPeer);
    const t = Math.floor(Date.now() / 1000);

    const localId = crypto.randomUUID();
    await saveMessage({ id: localId, peer: peer.u, dir: 'out', text, ts: Date.now(), state: 'sending' });
    await renderConversation();

    // One envelope per recipient device (pairwise E2EE keys are per device
    // pair). All copies share the local message; the first delivery receipt
    // marks it delivered.
    for (const dev of peer.devices) {
      const cid = crypto.randomUUID();
      cidToLocalId.set(cid, localId);
      const key = await getConvKey(identity, peer.u.toLowerCase(), dev.d, dev.x);
      const d = await cryptoLib.encryptForConversation(key, text);
      const m = { d, u: peer.u, dv: dev.d, f: identity.username, fd: identity.deviceId, cid, t };
      const h = await cryptoLib.hmac(identity.aesMac, canonical(m));
      socket.send({ type: 'msg', msg: { m: { ...m, h } } });
    }
  }

  async function sendCurrent() {
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text || !currentPeer) return;
    input.value = '';
    const status = $('chat-status');
    try {
      await sendText(text);
      setStatus(status, '');
    } catch (err) {
      setStatus(status, err instanceof ApiError ? err.message : String(err), true);
    }
  }

  // --- rendering ---

  async function renderConversation() {
    const list = $('chat-messages');
    if (!list || !currentPeer) return;
    list.textContent = '';
    const msgs = (await messagesWith(currentPeer)).sort((a, b) => a.ts - b.ts);
    for (const m of msgs) {
      const li = document.createElement('li');
      li.className = `msg ${m.dir}`;
      const body = document.createElement('span');
      body.textContent = m.text;
      li.appendChild(body);
      if (m.dir === 'out') {
        const mark = document.createElement('span');
        mark.className = 'dim msg-state';
        mark.textContent = MSG_STATE_MARK[m.state] ?? '';
        li.appendChild(mark);
      }
      list.appendChild(li);
    }
    list.scrollTop = list.scrollHeight;
  }

  async function renderConversationList() {
    const list = $('conversation-list');
    if (!list) return;
    list.textContent = '';
    const all = await allMessages();
    const latestByPeer = new Map();
    for (const m of all) {
      const cur = latestByPeer.get(m.peer);
      if (!cur || m.ts > cur.ts) latestByPeer.set(m.peer, m);
    }
    const entries = [...latestByPeer.entries()].sort((a, b) => b[1].ts - a[1].ts);
    for (const [peer, last] of entries) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'linkish';
      btn.textContent = `@${peer} — ${last.text.slice(0, 48)}`;
      btn.addEventListener('click', () => openChat(peer));
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  async function openChat(username) {
    const status = $('home-status');
    try {
      const identity = await getIdentity();
      if (!identity.xPriv) {
        setStatus(
          status,
          'This device was set up before encrypted messaging — forget this device and sign up again to chat.',
          true,
        );
        return;
      }
      const peer = await getPeerKeys(username); // also validates the user exists
      currentPeer = peer.u;
      ensureSocket(identity);
      $('chat-peer').textContent = `@${peer.u}`;
      setStatus($('chat-status'), '');
      show('chat');
      await renderConversation();
      $('chat-input').focus();
    } catch (err) {
      setStatus(status, err instanceof ApiError ? err.message : String(err), true);
    }
  }

  // Connect the socket as soon as the user is signed in so incoming messages
  // arrive in real time (and show up in the conversation list), not only when
  // a chat is opened.
  async function connect() {
    const identity = await getIdentity();
    if (identity?.xPriv) ensureSocket(identity);
  }

  // --- wiring ---

  function wire() {
    $('btn-send').addEventListener('click', sendCurrent);
    $('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendCurrent();
    });
    $('btn-chat-back').addEventListener('click', () => {
      currentPeer = null;
      show('home');
      renderConversationList();
      onHomeRefresh?.();
    });
  }

  return { wire, connect, openChat, renderConversationList };
}
