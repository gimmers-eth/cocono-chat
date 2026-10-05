// Chat pane: conversation rendering + composer. All networking and crypto go
// through the SDK; this component only moves between store <-> DOM. Renders
// are atomic (DocumentFragment + replaceChildren) so concurrent events can
// never interleave a clear/append and double-paint bubbles.

import { $, setStatus, setChatOpen, fmtTime } from '../ui.js';
import { saveMessage, updateMessage, messagesWith, markRead } from '../store.js';

const STATE_MARK = { sending: '⏳', sent: '✓', delivered: '✓✓', failed: '!' };

// 'Read' means the user actually LOOKED at the conversation: the tab is
// visible AND the window has focus (WhatsApp Web semantics). Background
// messages keep their unread dot until the user comes back.
function windowActive() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function createChat({ client, onHomeRefresh }) {
  let currentPeer = null; // display-cased

  // --- SDK event wiring (once) ---

  function connectEvents() {
    client.on('message', async (m) => {
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
    } catch (err) {
      setStatus($('chat-status'), err.message ?? String(err), true);
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
      const body = document.createElement('span');
      body.textContent = m.text;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = fmtTime(m.ts) + (m.dir === 'out' ? ` ${STATE_MARK[m.state] ?? ''}` : '');
      li.append(body, meta);
      frag.appendChild(li);
    }
    list.replaceChildren(frag);
    list.scrollTop = list.scrollHeight;
    return msgs[msgs.length - 1]; // newest displayed message, for the read marker
  }

  // --- opening ---

  async function openChat(username) {
    const status = $('home-status');
    try {
      const peer = await client.peerKeys(username); // validates existence, caches
      currentPeer = peer.u;
      $('chat-peer').textContent = `@${peer.u}`;
      $('chat-sub').textContent = `${peer.devices.length} device${peer.devices.length === 1 ? '' : 's'}`;
      setStatus($('chat-status'), '');
      $('chat-empty').hidden = true;
      $('chat-view').hidden = false;
      setChatOpen(true);
      const last = await render();
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
    $('btn-send').addEventListener('click', sendCurrent);
    $('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendCurrent();
    });
    $('btn-chat-back').addEventListener('click', () => {
      currentPeer = null;
      setChatOpen(false);
      $('chat-view').hidden = true;
      $('chat-empty').hidden = false;
      onHomeRefresh?.();
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
