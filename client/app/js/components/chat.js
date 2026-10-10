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

import { $, setStatus, setChatOpen, fmtTime, confirmModal, toast, animateSheetClose, openLightbox, closeLightbox } from '../ui.js';

import { iconEl } from '../icons.js';
import { PS, resolvePeerState, peerStateIcon, unverifiedBadgeEl, premiumBadgeEl, moderationOf } from './peername.js';
import { safetyNumber } from '../identity.js';
import { BADGE_UI, nameChipEl } from '../badges.js';
import { blockUserWithConfirm, unblockUser } from '../blocks.js';
import { reportUserWithConfirm } from '../reports.js';
import { TAG_IDS, TAG_LABELS, tagIconEl, togglePeerTag } from '../tags.js';
import { mountLine, setAvatar } from './userline.js';
import { errorText, humanError } from '../errors.js';
import {
  saveMessage, updateMessage, messagesWith, markRead, allMessages, isUnread,
  getMessage, deleteMessage, clearMessages,
  saveMedia, getMedia, updateMedia, mediaWith, deleteMedia, clearMediaWith,
  loadPeerAvatars, rememberPeerAvatar, AVATARS_EVENT,
  loadFriends, friendAdd, friendDel, friendMarkFlags, setFriends, FRIENDS_EVENT, loadPeerBlocked, loadPeerMuted, rememberPeerMuted, loadPeerChips,
  loadPeerTags,
  getPin, recordPinSeen, markPeerGone, rememberPeerVerified,
  rememberPeerModeration, loadPeerModeration,
} from '../store.js';
// M4 media: prep/policy/lifecycle in ../media.js, painting in the two
// components beside this file. chat.js stays the ORCHESTRATOR — it owns
// render(), the composer and the modal lifecycle; media owns what media looks
// like and what its buttons do.
import {
  prepareMedia, mediaRow, mediaLabel, parseMediaPayload, applyArrivalPolicy,
  retryFailedDownloads, pruneLocalMedia, releaseScope,
} from '../media.js';
import { bubbleNodes } from './mediabubble.js';
import {
  buildTabStrip, paintTabActive, paintTabPanel, mediaAction, openViewer,
} from './mediaview.js';

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
    reg?.showNotification?.(document.title || 'CoCoNo', {
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
  let peerIdentityPremium = false; // gold certificate tier of the open peer
  let peerDisplay = null;        // peer's chosen name badge (from keys/profile)
  let profileSubject = null;       // ul whose profile sheet is currently open
  let profileBadges = [];          // held badges [{id, at}] of the sheet owner
  let profileDisplay = null;       // their chosen name badge
  let sheetPremium = false;        // premium flag of the sheet owner (fallback chip)
  const badgeModalQueue = [];      // new-award modals waiting their turn
  let badgeModalOpen = null;       // badge id currently shown
  let peerJoinedAt = null; // "joined" date from the live key lookup
  let peerIdentityKnown = false;
  // staff moderation on the CURRENT peer ('malicious' | 'banned' | null),
  // learned from keys/profile/stats reads — outranks the whole trust ladder
  // for the icon (server lib/moderation.js)
  let peerModeration = null;

  // (the red unverified mark now rides the name line via mountLine options —
  // no per-slot painter needed)

  // Refresh a peer's public data (avatar + PREMIUM). Unthrottled on purpose:
  // opening a chat and opening the profile sheet both demand the freshest
  // certificate — @premium-1's status must not hide behind a 5-minute cache.
  // The avatar write fires AVATARS_EVENT, which repaints the sidebar's badges.
  function primePeerProfile(peer) {
    if (!peer) return;
    client.viewProfile(peer)
      .then((prof) => {
        rememberPeerAvatar(peer, prof.avatar);
        rememberPeerVerified(peer, undefined, prof.premium);
        // staff moderation travels on the profile read too — keep the
        // sidebar cache honest even without a keys round trip
        rememberPeerModeration(peer, { malicious: prof.malicious, banned: prof.banned });
        if (peer === currentPeer) {
          peerIdentityPremium = !!prof.premium;
          peerDisplay = prof.displayBadge ?? null;
          const mod = moderationOf(prof);
          if (mod !== peerModeration) {
            peerModeration = mod;
            updateTrustUI().catch(() => {}); // danger icon replaces the ladder
          }
          // chip state refreshed by the next updateTrustUI/openChat paint
        }
      })
      .catch(() => {});
  }


  // Chat-head + open-sheet name chips follow the display badge together.
  // The worn-badge chip for a peer's name LINE (component option). '' is
  // the explicit "no badge" choice; the premium flag is the legacy fallback
  // for views that predate displayBadge.
  function chipFor(displayId, premium) {
    const id = displayId === '' ? null : (displayId || (premium ? 'premium' : null));
    const chip = nameChipEl(id);
    if (chip) chip.classList.add('name-chip-inline');
    return chip;
  }

  // chat-head avatar from the mutual-add cache (sidebar renders the same map)
  async function renderChatAvatar() {
    if (!currentPeer) return;
    const avatars = await loadPeerAvatars();
    const rec = avatars.get(currentPeer);
    setAvatar($('chat-peer-av'), currentPeer, {
      src: rec?.avatar ? `data:image/jpeg;base64,${rec.avatar}` : '',
      sizeClass: 'chat-avatar', // NO zoom: the chat top shows decoration, not content
    });
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
      if (state === 'open') {
        lastOpenAt = Date.now();
        // the retry queue (plan §6.6): downloads that FAILED (offline blip, a
        // limiter kick) come back on the next open — a small batch, because
        // hammering the download endpoint is exactly how you trip the limiter
        // again. 'expired' (the blob is gone) is final and never retried.
        retryFailedDownloads(client)
          .then((n) => { if (n && currentPeer) render().catch(() => {}); })
          .catch(() => {});
      }
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
          if (p.sys === 'friend+') { await friendAdd(p.ul, p.p || ''); primePeerProfile(p.ul); }
          else if (p.sys === 'friend-') { await friendDel(p.ul); rememberPeerAvatar(p.ul, null); }
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
      // M4 MEDIA (plan §6.6): a {"media":…} payload is recognised right here,
      // AFTER the self-sent sys check and BEFORE anything treats the text as a
      // sentence. The transcript stores a human LABEL (never raw JSON — the
      // sidebar, a notification and a report transcript all read that field),
      // and the descriptor itself goes into the media row.
      const media = parseMediaPayload(m.text);
      const displayText = media ? mediaLabel(media.kind, media.name) : m.text;
      await saveMessage({
        id: `in:${m.mid}`,
        peer: m.peer,
        dir: 'in',
        text: displayText,
        ts: m.ts,
        fromDeviceId: m.fromDeviceId,
        ...(media ? { kind: media.kind, mediaId: media.id } : {}),
      });
      if (media) await adoptIncomingMedia(`in:${m.mid}`, m.peer, 'in', media, m.ts);
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
      // MUTE closes the THIRD path: server pushes are gated (ws handler) and
      // offline devices are covered — but an open-but-backgrounded app
      // notifies from THIS page (banner or notifyOS), and that path must
      // respect the account's mute list too. Unread dots still count; only
      // the alert hushes.
      const mutedNow = (await loadPeerMuted().catch(() => new Map())).get(String(m.peer).toLowerCase());
      if (mutedNow) {
        // silent: no banner, no OS notice
      } else if (windowActive() && !viewingThis && !catchUp) {
        // the LABEL, not the descriptor: an unverified sender's photo must not
        // read as {"media":{"id":… (emitter #2 of the three)
        const snippet = (displayText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        showBanner(`${m.peer}: ${snippet || '(message)'}`, m.peer);
      } else if (!windowActive()) {
        notifyOS(m.peer, displayText);
      }
    });

    // Outgoing SYNC copies from our OWN other devices (SDK 'sync' event —
    // never 'message', so no pill/OS notice ever fires for them): store as
    // the outgoing record under the ORIGINAL id (dedupes replays and the
    // originating-device record), then repaint quietly. No read-marking and
    // no delivery ticks — status lives on the device that sent it.
    client.on('sync', async (m) => {
      const id = `out:${m.id}`;
      if (await getMessage(id)) return;
      const peer = String(m.peer ?? '').toLowerCase();
      if (!peer) return;
      const ts = m.ts || Date.now();
      if (m.media) {
        // An outgoing MEDIA send mirrored from another of my devices: store it
        // under the same id, and let THIS device join the blob lifecycle like
        // any recipient (download + ack) — that is what keeps the server from
        // deleting the bytes before my phone has them (req 8).
        await saveMessage({ id, peer, dir: 'out', text: mediaLabel(m.media.kind, m.media.name), ts, state: 'synced', kind: m.media.kind, mediaId: m.media.id });
        await adoptIncomingMedia(id, peer, 'out', m.media, ts);
      } else {
        await saveMessage({ id, peer, dir: 'out', text: m.text, ts, state: 'synced' });
      }
      // Our OWN send, mirrored from another device: it reorders the sidebar
      // like any last message but must never raise an unread dot here —
      // advance the read marker (forward-only via the isUnread guard, so a
      // late-arriving sync can't un-read newer incoming mail).
      if (isUnread(peer, ts)) markRead(peer, ts);
      if (currentPeer && currentPeer.toLowerCase() === peer) await render();
      onHomeRefresh?.();
    });

  // ---- media arrivals (plan §6.6) ----
  // One row per blob per device, then THE POLICY: an image downloads by
  // itself, a video pulls only its POSTER (a 10 MB wait belongs behind a
  // button), a file waits for the user. Nothing here is awaited by the message
  // handler — a slow download must never hold up delivery, the repaint happens
  // when the bytes land.
  async function adoptIncomingMedia(msgId, peer, dir, media, ts) {
    if (!media?.id) return;
    if (await getMedia(media.id)) return; // replay/resync: keep the stored bytes
    const row = mediaRow({ key: media.id, peer, dir, kind: media.kind, media, msgId, ts });
    if (dir === 'out') row.state = 'synced';
    await saveMedia(row);
    applyArrivalPolicy(client, row)
      .then(() => {
        if (currentPeer && currentPeer.toLowerCase() === String(peer).toLowerCase()) render().catch(() => {});
      })
      .catch(() => { /* failed/expired states already landed on the record */ });
  }

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

  // ---- SENDING MEDIA (plan §6.3 / req 4) ----
  // The order is the feature: write the sender's OWN copy (transcript row +
  // decrypted bytes) BEFORE anything leaves the device, so a failed upload
  // still leaves the user with their photo in the chat — and only then hand
  // the bytes to the SDK, which encrypts, uploads and fans out. `localId` is
  // generated HERE for the same reason: the record's id must exist first, and
  // the ack/delivered events come back keyed to it.
  async function sendMediaTo(peer, prepared) {
    const localId = crypto.randomUUID();
    const id = `out:${localId}`;
    const ts = Date.now();
    const size = prepared.bytes?.length ?? prepared.bytes?.size ?? 0;
    const row = mediaRow({
      key: id, blobId: null, peer, dir: 'out', kind: prepared.kind,
      media: { name: prepared.name, mime: prepared.mime, size },
      msgId: id, ts,
    });
    row.state = 'stored';          // we hold these bytes already — they came from this device
    row.blurred = false;           // req 7: a sent image is never blurred
    row.data = prepared.bytes instanceof Blob ? prepared.bytes : new Blob([prepared.bytes], { type: prepared.mime || 'application/octet-stream' });
    row.thumb = prepared.thumb ?? null;
    await saveMessage({ id, peer, dir: 'out', text: mediaLabel(prepared.kind, prepared.name), ts, state: 'sending', kind: prepared.kind, mediaId: id });
    await saveMedia(row);
    markRead(peer, ts);
    await render();
    onHomeRefresh?.();
    try {
      const { media } = await client.sendMedia(peer, {
        kind: prepared.kind, bytes: prepared.bytes, thumb: prepared.thumb ?? null,
        name: prepared.name, mime: prepared.mime,
        w: prepared.w ?? null, h: prepared.h ?? null, dur: prepared.dur ?? null,
        animated: prepared.animated === true,
      }, { localId });
      // the blob id exists only now: repoint the row's wire identity (and keep
      // the crypto fields so this device could re-verify/re-download its own
      // copy — the record is what a report hands the server, too)
      await updateMedia(id, {
        blobId: media.id, key: media.key, iv: media.iv,
        thumbIv: media.thumbIv ?? null, sha256: media.sha256,
      });
      // A SELF-CHAT send routes a copy to this very device, which therefore
      // lands in the blob's `pending` list. We ARE the copy — the bytes came
      // from us — so settle the debt immediately, or the blob would sit on the
      // server until the retention sweep for no reason (req 8).
      if (String(peer).toLowerCase() === String(client.username ?? '').toLowerCase()) {
        client.ackMedia(media.id, true).catch(() => {});
      }
    } catch (err) {
      // upload failed → nothing was ever sent (the SDK throws BEFORE any
      // envelope). The local copy above is what the user keeps.
      await updateMessage(id, { state: 'failed' });
      toast(humanError(err), 'error');
      await render();
      throw err;
    }
  }

  async function pickAndSend(file) {
    if (!currentPeer || peerGone) return;
    let prepared;
    try {
      prepared = await prepareMedia(file);
    } catch (err) {
      // a plain sentence from the prep layer (too big, SVG, unreadable image)
      toast(err?.message ?? 'That file could not be sent.', 'error');
      return;
    }
    try {
      await sendMediaTo(currentPeer, prepared);
    } catch { /* reported already: the bubble shows failed, the toast said why */ }
  }

  // --- rendering ---

  // The open-time pin can be undone by chrome that lands a few frames
  // LATER (updateTrustUI's warn strip, the head avatar/line, safe-area
  // settling): the flex column redistributes, .messages loses a few px,
  // and the newest bubble slips under the fold ("scroll down slightly to
  // see it"). Re-pin for a short settle window after every full render —
  // cancelled the instant the user touches/wheels the list, so it can
  // never fight a deliberate scroll.
  let settleRaf = 0;
  let settleCancel = null;
  function settleAtBottom(list) {
    settleCancel?.();
    const cancel = () => {
      cancelAnimationFrame(settleRaf);
      list.removeEventListener('touchstart', cancel);
      list.removeEventListener('wheel', cancel);
      if (settleCancel === cancel) settleCancel = null;
    };
    settleCancel = cancel;
    list.addEventListener('touchstart', cancel, { passive: true });
    list.addEventListener('wheel', cancel, { passive: true });
    const until = performance.now() + 600;
    const step = () => {
      if (list.scrollHeight - list.scrollTop - list.clientHeight > 1) {
        list.scrollTop = list.scrollHeight;
      }
      if (performance.now() < until) settleRaf = requestAnimationFrame(step);
      else cancel();
    };
    settleRaf = requestAnimationFrame(step);
  }

  async function render() {
    const list = $('chat-messages');
    if (!list || !currentPeer) return;
    const msgs = (await messagesWith(currentPeer)).sort((a, b) => a.ts - b.ts);
    // One read for the conversation's media rows, then bubble painting stays
    // synchronous. Object URLs from the previous paint go FIRST: bubbles are
    // rebuilt on every event and each unreleased URL pins its decrypted bytes
    // for the life of the tab.
    const rows = await mediaWith(currentPeer);
    const mediaById = new Map(rows.map((r) => [r.id, r]));
    releaseScope('bubbles');
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
      li.className = `msg ${m.dir}${m.kind && m.kind !== 'text' ? ' msg-media' : ''}`;
      li.dataset.id = m.id; // tap -> openMsgModal (delegated listener)
      const body = document.createElement('span');
      if (m.kind && m.kind !== 'text') {
        // a media message paints its preview/status/actions; `m.text` is the
        // human label ("Photo", "File: spec.pdf") the sidebar and a
        // notification show, never the raw descriptor
        body.className = 'media-body';
        body.append(...bubbleNodes(m, mediaById.get(m.mediaId), { verified: peerIdentityVerified }));
      } else {
        body.textContent = m.text;
      }
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = fmtTime(m.ts);
      if (m.dir === 'out' && m.state !== 'synced') {
        // 'synced' records came from another of our own devices — delivery
        // status belongs to the originating device, so they render quiet.
        meta.appendChild(iconEl(STATE_MARK[m.state] ?? 'stateSending', m.state === 'failed' ? 'icon-danger' : ''));
      }
      li.append(body, meta);
      frag.appendChild(li);
    }
    list.replaceChildren(frag);
    list.scrollTop = list.scrollHeight;
    settleAtBottom(list); // hold the pin through the late-landing chrome
    // The tab strip swaps the CONTENT area only — the composer stays put in
    // every tab, because an attachment belongs to the conversation.
    await paintTab();
    return msgs[msgs.length - 1]; // newest displayed message, for the read marker
  }

  // ---- conversation tabs (req 1/4): chat · images · videos · files · links --
  // Per-open-chat UI state, deliberately NOT persisted (plan §6.1).
  let activeTab = 'chat';
  let tabQuery = '';

  async function setTab(tab) {
    const strip = $('chat-tabs');
    if (!strip) return;
    activeTab = tab;
    tabQuery = '';
    paintTabActive(strip, tab);
    await render();
  }

  async function paintTab() {
    const list = $('chat-messages');
    const panel = $('chat-tabpanel');
    if (!panel) return;
    const isChat = activeTab === 'chat';
    if (list) list.hidden = !isChat;
    panel.hidden = isChat;
    if (isChat) return;
    await paintTabPanel(panel, {
      peer: currentPeer, tab: activeTab, query: tabQuery,
      verified: peerIdentityVerified,
      onOpen: openMediaFromTab,
      onAction: runMediaAction,
    });
  }

  // A tile/row opens the SAME modal a bubble does — one viewer, one set of
  // controls, whichever way you got there.
  async function openMediaFromTab(row) {
    const rec = row?.msgId ? await getMessage(row.msgId) : null;
    if (rec) await openMsgModal(rec);
  }

  // A bubble's Download/Delete press: the message id on the <li> is the only
  // handle the DOM carries, so resolve it to the row and let the shared
  // action do the work (the Files tab calls the same function).
  async function runBubbleAction(messageId, action) {
    const rec = messageId ? await getMessage(messageId) : null;
    const row = rec?.mediaId ? await getMedia(rec.mediaId) : null;
    if (!row) return;
    await mediaAction(client, row, action, { onDone: () => render().catch(() => {}) });
  }

  async function runMediaAction(row, action) {
    if (action === 'download') await mediaAction(client, row, 'download', { onDone: () => render().catch(() => {}) });
    else if (action === 'decline') await mediaAction(client, row, 'decline', { onDone: () => render().catch(() => {}) });
  }

  // --- message modal (tap a bubble): readable scrollable text + fixed actions ---

  let msgId = null; // message currently shown in the modal
  // the viewer's teardown (revokes the full-size Blob URLs). Kept here because
  // closeMsgModal — not the media module — is what the Escape chain, the scrim
  // tap, the chat close and a re-open all funnel through.
  let viewerCleanup = null;

  async function openMsgModal(rec) {
    msgId = rec.id;
    $('msg-modal-title').textContent = rec.dir === 'out' ? 'Sent message' : 'Message';
    $('msg-modal-time').textContent = `${rec.peer} · ${new Date(rec.ts).toLocaleString()}`;
    setStatus($('msg-modal-status'), '');
    const textEl = $('msg-modal-text');
    const pane = $('msg-media');
    viewerCleanup?.();
    viewerCleanup = null;
    const row = rec.mediaId ? await getMedia(rec.mediaId) : null;
    if (row) {
      // MEDIA: the scrollable text area is REPLACED by the media pane (plan
      // §6.4) and Copy goes — there is no text to copy. Forward stays: it
      // re-sends the stored plaintext through a fresh key + upload.
      textEl.hidden = true;
      textEl.textContent = '';
      if (pane) {
        pane.hidden = false;
        viewerCleanup = openViewer(pane, {
          client,
          msg: rec,
          row,
          verified: peerIdentityVerified,
          // a blur/keep toggle or a finished download repaints the transcript
          // underneath AND the modal title row stays honest
          onChange: (next) => { render().catch(() => {}); },
          onStatus: (text, isError) => setStatus($('msg-modal-status'), text, isError),
        });
      }
    } else {
      textEl.hidden = false;
      textEl.textContent = rec.text;
      textEl.scrollTop = 0;
      if (pane) { pane.hidden = true; pane.replaceChildren(); }
    }
    $('btn-msg-copy').hidden = !!row;
    $('btn-msg-fwd').disabled = false;
    $('msg-overlay').hidden = false;
    $('msg-modal').hidden = false;
    $('btn-msg-close').focus?.();
  }

  function msgModalOpen() {
    return !$('msg-modal').hidden;
  }

  function closeMsgModal() {
    viewerCleanup?.();
    viewerCleanup = null;
    const pane = $('msg-media');
    if (pane) { pane.hidden = true; pane.replaceChildren(); }
    msgId = null;
    forwardId = null;
    $('msg-panes').classList.remove('showing-fwd'); // always reopen on pane A
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
    // Local delete only, for BOTH halves: the transcript row and the decrypted
    // bytes it points at. The server's copy is the ack/sweeper's business
    // (plan §6.4) and the peer keeps theirs — but leaving megabytes behind
    // after a user deletes their own message would make "Deleted" a lie.
    const rec = await getMessage(msgId);
    if (rec?.mediaId) await deleteMedia(rec.mediaId);
    await deleteMessage(msgId);
    closeMsgModal();
    await render();
    onHomeRefresh?.();
  }

  function forwardCurrentMsg() {
    if (!msgId) return;
    // the OLD forward was a second modal, so this closed the message modal
    // first. Forwarding is now the panel's SECOND CAROUSEL SLIDE: the panel
    // stays open and the track slides — closing it here hid everything.
    openForward(msgId, $('msg-modal-text').textContent ?? '');
  }

  // --- chat-options modal (header ⋮): profile, trust ladder, mute, clear
  //     chat, and report/block (each collecting a required reason). Modal
  //     (not dropdown) so it survives any re-render and needs no
  //     outside-click machinery. ---

  // --- trust UI: friends = IDENTITY-BOUND one-way trust. Anything short of
  //     a live-matching binding (stranger, legacy/unbound, changed, gone)
  //     shows the stranger/gone marks — strict by policy (option B) ---

  // One budget cell of GET /api/me/stage-limits → 'X of Y' LEFT (the same
  // 'what remains' question the Settings > Limits table answers). spent
  // reuses the table's .usage-spent red — one vocabulary for 'cap reached'.
  function budgetCell(s) {
    const left = s ? Math.max(0, s.limit - s.used) : null;
    return { text: left === null ? '—' : left <= 0 ? 'all used' : `${left} of ${s.limit}`, spent: left === 0 };
  }

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
      moderation: peerModeration,
    });
  }

  // --- chat TAG row (below the head): tap a tag to add/remove it on this
  //     peer; grey vs purple, toast feedback, hidden for self-chat. Tags are
  //     the user's OWN labels (server-stored, invisible to the peer), so
  //     they paint for ANY peer — blocked and gone ones too (they are still
  //     family; the wall changes messaging, not your address book).
  //     The row ONLY rebuilds its #chat-tag-icons span: the mute button is a
  //     static sibling of the strip (paintMuteBtn owns it) and destroying it
  //     here would silently kill its wired click handler.
  async function paintTagBar(peer) {
    const bar = $('chat-tagbar');
    const iconsHost = $('chat-tag-icons');
    if (!bar || !iconsHost) return;
    const selfUl = String(client.username ?? '').toLowerCase();
    if (!peer || String(peer).toLowerCase() === selfUl) {
      bar.hidden = true;
      iconsHost.replaceChildren();
      return;
    }
    bar.hidden = false;
    // the row announces itself — a quiet 'Tag:' lead-in so the four glyphs
    // read as labels to apply, not as random header chrome
    const label = document.createElement('span');
    label.className = 'tagbar-label';
    label.textContent = 'Tag:';
    let mine = [];
    try { mine = (await loadPeerTags()).get(String(peer).toLowerCase()) ?? []; } catch { /* offline: none shown, server still true */ }
    iconsHost.replaceChildren(label, ...TAG_IDS.map((id) => {
      const on = mine.includes(id);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tag-btn${on ? ' tag-on' : ''}`;
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? `Remove the ${TAG_LABELS[id]} tag` : `Tag @${peer} as ${TAG_LABELS[id]}`;
      b.append(tagIconEl(id));
      b.addEventListener('click', async () => {
        b.disabled = true; // one write in flight per row; the toast is the feedback
        try {
          const next = await togglePeerTag(client, peer, id);
          if (next) { await paintTagBar(peer); onHomeRefresh?.(); }
        } finally { b.disabled = false; }
      });
      return b;
    }));
  }

  async function updateTrustUI() {
    const warn = $('chat-warn');
    if (!currentPeer) {
      if (warn) warn.hidden = true;
      paintMuteBtn(null);
      paintTagBar(null);
      $('chat-peer-line')?.replaceChildren();
      return;
    }
    paintTagBar(currentPeer);
    const ent = await friendEntryFor(currentPeer);
    const pin = await getPin(currentPeer);
    const state = trustState(ent, pin);
    const gone = state === PS.GONE;

    // MY OWN BLOCK wins the display: the relation is severed and inbound is
    // gated server-side, so the bar says what is true and offers the only
    // two honest actions (unblock / look them up). Checked first because a
    // blocked peer has NO friend entry — the cascade would call them a
    // stranger, which is not the whole story.
    paintMuteBtn(currentPeer, (await loadPeerMuted()).get(currentPeer));
    const blockedMap = await loadPeerBlocked();
    const blockedByMe = blockedMap.get(currentPeer);
    if (blockedByMe) {
      mountLine($('chat-peer-line'), {
        // a staff mark OUTRANKS even my own block wall (peername.js)
        peer: currentPeer, state: peerModeration ?? PS.BLOCKED,
        chipEl: chipFor(peerDisplay, peerIdentityPremium),
        unverified: peerIdentityKnown && !peerIdentityVerified,
      });
      warn.classList.toggle('danger', true);
      warn.classList.toggle('warn', false);
      warn.hidden = false;
      const actions = document.createElement('span');
      actions.className = 'warn-actions';
      const mkBtn = (label, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'warn-action';
        b.textContent = label;
        b.addEventListener('click', () => { b.disabled = true; Promise.resolve(fn()).finally(() => { b.disabled = false; }); });
        return b;
      };
      actions.append(mkBtn('Unblock', async () => {
        if (await unblockUser(client, currentPeer)) { await updateTrustUI(); onHomeRefresh?.(); }
      }));
      actions.append(mkBtn('View profile', openProfileView));
      warn.replaceChildren(
        iconEl('ban', 'icon-danger'),
        document.createTextNode(` You have blocked ${currentPeer}. They cannot message you, and you cannot message them.`),
        actions,
      );
      return;
    }

    mountLine($('chat-peer-line'), {
      peer: currentPeer, state,
      chipEl: chipFor(peerDisplay, peerIdentityPremium),
      unverified: peerIdentityKnown && !peerIdentityVerified,
    });

    // plain-language strips, tiered: red (danger) / orange (warn).
    // No strip once TRUSTED (or when the chat is self/unknown state).
    const MSG = {
      [PS.GONE]: ['danger', 'userGone', peerHadHistory
        ? 'This account was deleted. Your saved messages stay readable, but you can’t send new ones.'
        : `${currentPeer} doesn’t exist — no account with this name was found.`],
      [PS.STRANGER]: ['danger', 'notFriend', `You haven’t added ${currentPeer} yet. Messages are private, but anyone can sign up with a name. Trust only people you know.`],
      [PS.UNVERIFIED]: ['warn', 'friend', `You’ve added ${currentPeer}, but haven’t verified them. Read the safety number aloud together (a call works) — when both screens match, nobody is in between. Open ⋮ and tap “Verify user”.`],
      [PS.VERIFIED]: ['warn', 'friendVerified', `You’ve verified ${currentPeer}, but haven’t trusted them yet.`],
    };
    // one-sided add: verification is a MUTUAL relation, so the plain ladder
    // copy would promise a step that cannot happen — say what actually
    // unlocks it: THEM adding YOU.
    const WAITING_BACK = ['warn', 'friend', `You’ve added ${currentPeer}, but they haven’t added you back — verification only unlocks once both of you have added each other. Ask them to add you, then compare the safety number in ⋮ → “Verify user”.`];
    let tier;
    let iconKey;
    let text;
    // staff moderation OUTRANKS every local signal: a staff TIMEOUT or BAN
    // is the platform's own verdict — say it first, in red, whatever the
    // local ladder thinks (server lib/moderation.js)
    if (peerModeration === 'banned') {
      tier = 'danger';
      iconKey = 'ban';
      text = `${currentPeer} was BANNED by CoCoNo staff — the account may not use the platform.`;
    } else if (peerModeration === 'malicious') {
      tier = 'danger';
      iconKey = 'identityAlert';
      text = 'WARNING! This user has been identified as malicious by CoCoNo staff.';
    } else if (conflictAlert(ent, pin)) {
      tier = 'danger';
      iconKey = 'notFriend';
      text = `Heads up: the key this device remembers for ${currentPeer} doesn’t match the server’s. Until you’ve checked the number together, treat this chat with suspicion.`;
    } else if (pinState === 'changed' && !gone) {
      tier = 'danger';
      iconKey = 'identityAlert';
      text = `Heads up: ${currentPeer}’s identity key changed on this device. If they reinstalled or re-created their account that can be normal — but verify them again before trusting new messages.`;
    } else if (state === PS.UNVERIFIED && !ent?.addedBack) {
      [tier, iconKey, text] = WAITING_BACK;
    } else {
      [tier, iconKey, text] = MSG[state] ?? [];
    }
    warn.classList.toggle('danger', tier === 'danger');
    warn.classList.toggle('warn', tier === 'warn');
    warn.hidden = !text;
    if (text) {
      const kids = [
        iconEl(iconKey ?? 'notFriend', tier === 'danger' ? 'icon-danger' : 'icon-warn'),
        document.createTextNode(` ${text}`),
      ];
      // STRANGER bar carries its own actions on a NEW centered line:
      // look them up before deciding ("View profile") and the bar's whole
      // point ("Add X"). The Add pill is suppressed while a key
      // conflict/change alert is on screen — never fast-track a user past a
      // live security warning; viewing the profile stays honest either way.
      if (state === PS.STRANGER) {
        const actions = document.createElement('span');
        actions.className = 'warn-actions';
        const mk = (label, fn, disabled = false) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'warn-action';
          btn.textContent = label;
          btn.disabled = disabled;
          btn.addEventListener('click', () => { btn.disabled = true; Promise.resolve(fn()).finally(() => { btn.disabled = false; }); });
          return btn;
        };
        actions.append(mk('View profile', openProfileView));
        if (!conflictAlert(ent, pin) && pinState !== 'changed') actions.append(mk(`Add ${currentPeer}`, addUser));
        // Block is offered BEFORE any relation exists — a stranger is
        // exactly who a block is for (harassment arrives from strangers).
        actions.append(mk(`Block ${currentPeer}`, () => blockUserWithConfirm(client, currentPeer).then(async (did) => {
          if (did) { await updateTrustUI(); onHomeRefresh?.(); }
        })));
        kids.push(actions);
      }
      warn.replaceChildren(...kids);
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
    // Block: any real peer except yourself (and already-blocked peers have
    // their own bar state — the menu row would be redundant noise there)
    const blockBtn = $('btn-chat-block');
    if (blockBtn) {
      blockBtn.closest('.menu-row').hidden = state === PS.SELF;
      blockBtn.disabled = state === PS.SELF;
    }
    // Report: same reach as block — anyone but yourself (a blocked peer can
    // still be reported afterwards: the abuse you saw is already history)
    const reportBtn = $('btn-chat-report');
    if (reportBtn) {
      reportBtn.closest('.menu-row').hidden = state === PS.SELF;
      reportBtn.disabled = state === PS.SELF;
    }
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
      await friendAdd(currentPeer, entry?.p ?? '', { addedBack: !!entry?.addedBack });
      if (entry?.p) await recordPinSeen(currentPeer, entry.p);
      primePeerProfile(currentPeer); // photo eligibility just changed — refresh now
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
      rememberPeerAvatar(currentPeer, null).catch(() => {}); // photo vanishes immediately
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
    // and MY spend on it: the trust budget the server will actually charge
    // this tap against (same resolver as enforcement, incl. per-account
    // overrides) — a vouch is scarce, say so where it's spent
    let budget = null;
    try { budget = await client.stageLimits(); } catch { /* offline: unknown */ }
    // Facts table (green/red pills, at a glance) instead of the old dot-line:
    // this is the evidence for a trust DECISION, it should read like one.
    const fact = (label, value, cls) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = label;
      const td = document.createElement('td');
      const v = document.createElement('span');
      v.className = `tf-val ${cls}`;
      v.textContent = value;
      td.append(v);
      tr.append(th, td);
      return tr;
    };
    const facts = document.createElement('table');
    facts.className = 'trust-facts';
    facts.append(
      fact('App', peerIdentityKnown ? (peerIdentityVerified ? '✓ Verified' : '✗ Unverified') : '· Unknown',
        !peerIdentityKnown ? 'dim' : peerIdentityVerified ? 'ok' : 'bad'),
      fact('Social', stats ? (stats.socialTrusted ? '✓ Trusted' : '✗ Not yet trusted') : '· Unknown',
        stats ? (stats.socialTrusted ? 'ok' : 'bad') : 'dim'),
      fact('CoCo', stats ? String(stats.coco) : '—', stats ? 'num' : 'dim'),
    );
    const bodyP = document.createElement('p');
    bodyP.className = 'muted';
    bodyP.textContent = 'Trusting someone is also vouching for them on this platform — your '
      + 'vouch counts toward this profile’s reputation. Only trust people you '
      + 'actually know, after comparing safety numbers.';
    const wrap = document.createElement('div');
    // the explanation reads first, the evidence below it — then what the
    // evidence MEANS: CoCo demystified right where it's shown
    const cocoNote = document.createElement('p');
    cocoNote.className = 'muted small coco-note';
    cocoNote.textContent = 'CoCo is this account\u2019s social trust score — earned by '
      + 'getting badges and by other people vouching for it (verifying and trusting '
      + 'it). A score of 100 or more is usually really good.';
    wrap.append(bodyP, facts, cocoNote);
    if (budget) {
      const d = budgetCell(budget.trustDaily);
      const w = budgetCell(budget.trustWeekly);
      const budgetP = document.createElement('p');
      budgetP.className = 'budget-note';
      budgetP.replaceChildren(
        iconEl('tabLimits', 'reason-icon'),
        document.createTextNode(` Trusts left today ${d.text} · this week ${w.text}`),
      );
      budgetP.classList.toggle('usage-spent', d.spent && w.spent);
      wrap.append(budgetP);
    }
    // the consequence sits BELOW the button, in a box: read it last, right
    // where the commitment happens
    const box = document.createElement('div');
    box.className = 'tf-consequence';
    box.textContent = 'Only trust people you know. Trusting scammers can get YOU banned.';
    const ok = await confirmModal({
      title: `Trust ${currentPeer}?`,
      bodyEl: wrap,
      footerEl: box,
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
    const ent = await friendEntryFor(currentPeer);
    const pin = await getPin(currentPeer);
    const state = trustState(ent, pin);
    menuActionLabel(state, currentPeer);
    const optsBlocked = (await loadPeerBlocked()).get(currentPeer);
    mountLine($('chatopts-line'), {
      peer: currentPeer, state: peerModeration ?? (optsBlocked ? PS.BLOCKED : state),
      chipEl: chipFor(peerDisplay, peerIdentityPremium),
      unverified: peerIdentityKnown && !peerIdentityVerified,
    });
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

  function renderProfileBadges() {
    const row = $('profile-badges');
    const none = $('profile-badges-none');
    if (!row) return;
    row.replaceChildren();
    const held = (profileBadges ?? []).filter((b) => BADGE_UI.has(b.id));
    if (none) none.hidden = held.length > 0;
    row.hidden = held.length === 0;
    for (const b of held) {
      const chip = BADGE_UI.get(b.id).chip();
      chip.dataset.owner = profileSubject ?? currentPeer ?? '';
      row.append(chip);
    }
    // the awarded DATE lives in the badge modal only — the row is pure chips
  }

  // The profile sheet's TOP notice: the staff verdict, in red, when the
  // peer is timed out ('malicious') or banned. Filled from the moderation
  // fact cached by the keys/profile reads (peerModeration) — the same
  // flags that replace the trust icon with the danger mark.
  function renderModerationNotice() {
    const el = $('profile-moderation');
    if (!el) return;
    el.replaceChildren();
    el.hidden = !peerModeration;
    if (!peerModeration) return;
    el.append(iconEl(peerModeration === 'banned' ? 'ban' : 'identityAlert', 'icon-danger'));
    const span = document.createElement('span');
    span.textContent = peerModeration === 'banned'
      ? 'This user was banned by CoCoNo staff. The account is locked out of the platform; its data is preserved.'
      : 'WARNING! This user has been identified as malicious by CoCoNo staff';
    el.append(span);
  }

  async function renderProfileView() {
    if (!currentPeer) return;
    const ent = await friendEntryFor(currentPeer);
    const pin = await getPin(currentPeer);
    const state = trustState(ent, pin);
    const profileBlocked = (await loadPeerBlocked()).get(currentPeer);
    renderModerationNotice(); // the TOP notice paints before anything else
    mountLine($('profile-line'), {
      peer: currentPeer, state: peerModeration ?? (profileBlocked ? PS.BLOCKED : state),
      chipEl: chipFor(profileDisplay, sheetPremium),
      unverified: peerIdentityKnown && !peerIdentityVerified,
    });
    renderAccountStage(peerJoinedAt ? new Date(peerJoinedAt).getTime() : null);

    // peer profile (bio public; avatar ONLY on mutual add — server rule):
    // show photo when present, else the initial circle
    const bioSec = $('profile-bio-section');
    const bioEl = $('profile-peer-bio');
    setAvatar($('profile-av'), currentPeer, { src: '', sizeClass: 'profile-avatar' });
    bioSec.hidden = true;
    try {
      const prof = await client.viewProfile(currentPeer);
      // descriptions surface only for ID-verified accounts (an unverified
      // stranger gets no broadcast channel for their text)
      if (prof.bio && peerIdentityVerified) { bioEl.textContent = prof.bio; bioSec.hidden = false; }
      rememberPeerAvatar(currentPeer, prof.avatar).catch(() => {});
      if (prof.avatar) {
        setAvatar($('profile-av'), currentPeer, {
          src: `data:${prof.avatarType || 'image/jpeg'};base64,${prof.avatar}`,
          sizeClass: 'profile-avatar',
          zoom: true, // photo set → lightbox + magnifier hint (delegation: #profile-modal)
        });
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
      $('profile-bio-section').hidden = true;
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
      // the stats read carries the same moderation flags — they are the
      // FRESHEST staff verdict; keep banner + ladder + sidebar honest
      const sm = moderationOf(stats);
      if (sm !== peerModeration) {
        peerModeration = sm;
        renderModerationNotice();
        rememberPeerModeration(currentPeer, { malicious: stats.malicious, banned: stats.banned }).catch(() => {});
      }
      const trusted = stats.socialTrusted === true;
      setRow(socialState, socialNote, trusted ? 'ok' : 'bad',
        trusted ? 'Social: Trusted' : 'Social: Not yet trusted',
        trusted
          ? 'Other people vouch for this account. Every vouch is a risk for the voucher — scammer contacts get their trustors reported and removed.'
          : 'This user has not gained enough social trust just yet. Be extra careful: trust is earned, not assumed.');
      rep.textContent = `Vouched by ${stats.addedBy} added · ${stats.verifiedBy} verified · ${stats.trustedBy} trusted`;
      rep.hidden = false;
      coco.textContent = `CoCo: ${stats.coco}`;
      coco.hidden = false;
    } else {
      setRow(socialState, socialNote, '', 'Social: Unknown', 'Reputation counts need a connection.');
    }

    // You (the local ladder) — MY OWN BLOCK outranks the ladder: the
    // relation is severed, so "Not added" alone would be a half-truth
    const YOU_BLOCKED = ['bad', 'You: Blocked', 'You have blocked this account. They cannot message you, and you cannot message them. Unblock from the chat to rebuild the relation.'];
    const [cls, title, desc] = profileBlocked ? YOU_BLOCKED : (YOU_STAGES[state] ?? YOU_STAGES[PS.STRANGER]);
    setRow(youState, youNote, `trust ${cls}`, title, desc);
  }

  async function openProfileView() {
    if (!currentPeer) return;
    closeChatOpts(); // the sheet replaces the menu, never stacks on it
    profileSubject = currentPeer;
    // one authoritative fetch for the sheet: photo policy, bio, badges, name
    // chip — all fresh, exactly as this viewer is allowed to see them
    try {
      const prof = await client.viewProfile(currentPeer);
      profileBadges = prof?.badges ?? [];
      profileDisplay = prof?.displayBadge ?? null;
      sheetPremium = !!prof?.premium;
      // the sheet's TOP notice: the staff verdict rides the profile read
      peerModeration = moderationOf(prof);
    } catch { profileBadges = []; }
    primePeerProfile(currentPeer); // avatar/premium cache update stays
    await renderProfileView();
    profileSheetOpen = true;
    $('profile-modal').classList.remove('closing');
    $('profile-overlay').classList.remove('closing');
    $('profile-overlay').hidden = false;
    $('profile-modal').hidden = false;
    // chips/badges draw AFTER the sheet is visible (name-line component)
    // guards on visibility, so calling it earlier silently skipped the top
    // name badge (the bug: selected badge missing on the profile header)
    renderProfileBadges();
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
    if (prof) Promise.resolve(rememberPeerAvatar(meUl, prof.avatar ?? null)).catch(() => {});
    try { stats = await client.userStats(meUl); } catch { /* offline */ }
    profileSubject = meUl;
    profileBadges = prof?.badges ?? (me?.premium ? [{ id: 'premium', at: me?.premiumAt ?? null }] : []);
    profileDisplay = prof?.displayBadge ?? me?.displayBadge ?? null;
    sheetPremium = !!prof?.premium || !!me?.premium;
    renderProfileBadges();
    // the sheet is fed ENTIRELY from own data here — never through
    // renderProfileView (that renders currentPeer and would leave the last
    // viewed profile on screen)
    mountLine($('profile-line'), {
      peer: meUl,
      state: me?.verified ? PS.TRUSTED : PS.SELF, // green shield once identity-verified, like any verified account reads
      chipEl: chipFor(profileDisplay, sheetPremium),
      unverified: me ? !me.verified : null,
    });
    // No me.verified gate here: the profile endpoint already IS the policy
    // (owner always sees their own photo; others only on mutual+verified),
    // and stacking a second fetch's result over it made the photo vanish
    // whenever identity() was slow or failed.
    setAvatar($('profile-av'), meUl, {
      src: prof?.avatar ? `data:image/jpeg;base64,${prof.avatar}` : '',
      sizeClass: 'profile-avatar',
      zoom: true, // own preview zooms like any profile
    });
    const bioSec = $('profile-bio-section');
    const bioEl = $('profile-peer-bio');
    const bioOk = prof?.bio && (me ? me.verified : true); // identity unknown → don't hide it
    bioSec.hidden = !bioOk;
    if (bioOk) bioEl.textContent = prof.bio;
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
        stats.socialTrusted ? 'Social: Trusted' : 'Social: Not yet trusted',
        'Reputation grows when contacts verify and trust you.');
      $('profile-reputation').textContent =
        `Vouched by ${stats.addedBy} added · ${stats.verifiedBy} verified · ${stats.trustedBy} trusted`;
      $('profile-reputation').hidden = false;
      $('profile-coco').textContent = `CoCo: ${stats.coco}`;
      $('profile-coco').hidden = false;
    } else {
      setRow($('profile-social-state'), $('profile-social-note'), '', 'Social: unknown',
        'Reputation needs a connection.');
      $('profile-reputation').hidden = true;
      $('profile-coco').hidden = true;
    }
    setRow($('profile-you-state'), $('profile-you-note'), 'trust ok', 'You: Trusted',
      'This is your public profile — exactly what mutually-added contacts see.');

    profileSheetOpen = true;
    $('profile-modal').classList.remove('closing');
    $('profile-overlay').classList.remove('closing');
    $('profile-overlay').hidden = false;
    $('profile-modal').hidden = false;
    $('profile-modal').focus?.();
  }

  // Badge detail modal — the premium modal's layout, now for ANY badge:
  // big animated hero, the owner line, when it was awarded, and the CoCo
  // points. Queued: if a badge modal is already open (a burst of new awards
  // from one poll), the next shows once the current one is dismissed.
  function showBadgeModal(id, { at = null, owner = '', offerWear = false } = {}) {
    if (badgeModalOpen) { badgeModalQueue.push({ id, at, owner, offerWear }); return; }
    const def = BADGE_UI.get(id);
    const el = $('premium-modal');
    if (!def || !el) return;
    badgeModalOpen = id;
    // the badge's own glow colour drives the whole modal's shine (halo,
    // border, title gradient, points pill) through one custom property
    el.dataset.badge = id;
    el.style.setProperty('--badge-glow', def.glow ?? 'var(--accent)');
    $('premium-title').textContent = def.label;
    const hero = $('premium-modal-hero');
    hero.replaceChildren();
    const art = def.icon(96); // 96 = the full-detail artwork
    art.classList.add('badge-hero-art');
    const wrap = document.createElement('span');
    wrap.className = 'badge-hero';
    wrap.append(art);
    hero.append(wrap);
    // re-run the entrance + shine choreography on every open (the panel's
    // CSS animation otherwise played once, on first paint)
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    $('premium-modal-text').textContent = owner
      ? `@${owner} earned the ${def.label} badge.`
      : `You earned the ${def.label} badge!`;
    // date only, in the viewer's locale — the time was noise
    $('premium-modal-awarded').textContent = at ? `Awarded ${new Date(at).toLocaleDateString()}` : '';
    $('premium-modal-points').textContent = `+ ${def.points} CoCo`;
    const wearRow = $('badge-wear-row');
    if (wearRow) wearRow.hidden = !offerWear;
    $('premium-modal-desc') && ($('premium-modal-desc').textContent = def.blurb ?? '');
    $('premium-overlay').hidden = false;
    el.hidden = false;
  }

  function closeBadgeModal() {
    badgeModalOpen = null;
    $('premium-modal').hidden = true;
    $('premium-overlay').hidden = true;
    $('badge-wear-row')?.setAttribute('hidden', '');
    const next = badgeModalQueue.shift();
    if (next) showBadgeModal(next.id, next);
  }

  // the earned-badge modal doubles as the opt-in: "wear it next to my name"
  $('btn-badge-wear')?.addEventListener('click', async () => {
    const id = badgeModalOpen;
    closeBadgeModal();
    if (!id) return;
    try {
      await client.setProfile({ displayBadge: id });
      window.dispatchEvent(new CustomEvent('cocono:badges-changed'));
    } catch (err) {
      // 429 from rapid wearing / offline — the toast names it (silent
      // catches read as broken buttons)
      toast(humanError(err), 'error');
    }
  });
  $('btn-badge-nowear')?.addEventListener('click', closeBadgeModal);

  let profileSheetOpen = false; // sync state flag; the exit paint is deferred
  function closeProfileView() {
    if (!profileSheetOpen && $('profile-modal').hidden) return;
    profileSheetOpen = false;
    animateSheetClose($('profile-modal'), $('profile-overlay'), {
      reopenCheck: () => profileSheetOpen,
    });
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
    // fresh budget line for THIS peer's view: hidden until the live read
    // lands, so a stale number from the last peer never shows
    const budgetEl = $('identity-verify-budget');
    if (budgetEl) budgetEl.hidden = true;
    const pin = await getPin(currentPeer);
    const peerKey = pin?.p ?? peerIdentity;
    // OUR side of the pair: the account identity key (same value on every
    // one of our devices — the server stores it; own lookup is allowed).
    let myKey = null;
    try {
      myKey = (await client.peerKeys(client.username))?.id ?? null;
    } catch { /* offline / lookup failed: handled as 'not available' */ }
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
    const mutual = !!ent?.addedBack;
    // blocked peers sit OUTSIDE the ladder — the wall mark shows here too
    const safetyBlocked = (await loadPeerBlocked()).get(currentPeer);
    mountLine($('identity-line'), {
      peer: currentPeer, state: peerModeration ?? (safetyBlocked ? PS.BLOCKED : trustState(ent, pin)),
      chipEl: chipFor(peerDisplay, peerIdentityPremium),
      unverified: peerIdentityKnown && !peerIdentityVerified,
    });
    $('identity-since').textContent = pin
      ? `Key remembered on this device since ${new Date(pin.firstSeenAt).toLocaleString()}`
        + (pin.changedAt ? ` — it changed ${new Date(pin.changedAt).toLocaleString()}, verification was reset` : '')
      : 'This device has not seen the key directly yet.';
    const vb = $('btn-identity-verify');
    // verification is a MUTUAL relation: it only unlocks once both sides
    // have added each other (undo stays possible)
    vb.disabled = !ent?.trusted || (!mutual && !verified);
    const mutualNote = $('identity-mutual-note');
    if (mutualNote) {
      const blocked = !mutual && ent?.trusted && !verified;
      mutualNote.hidden = !blocked;
      if (blocked) {
        mutualNote.replaceChildren(
          iconEl('friend', 'icon-warn'),
          document.createTextNode(` ${currentPeer} has not added you back yet — you can only verify each other once BOTH of you have added one another. Ask them, then come back.`),
        );
      }
    }
    vb.replaceChildren(
      iconEl(verified ? 'friendRemove' : 'friendVerify'),
      document.createTextNode(verified ? ' Undo verification' : ' We compared — mark verified'),
    );
    vb.classList.toggle('danger', verified);
    // the verify budget UNDER the button — same counters the server
    // enforces on (ID-verified accounts automatically see their higher
    // daily limit; the endpoint resolves it, we never mirror the policy).
    // Offline / older server: the line stays hidden, the button still works
    // and the server stays the gatekeeper.
    if (budgetEl) {
      try {
        const u = await client.stageLimits();
        const d = budgetCell(u.verifyDaily);
        const w = budgetCell(u.verifyWeekly);
        budgetEl.replaceChildren(
          iconEl('tabLimits', 'reason-icon'),
          document.createTextNode(` Verifications left — today ${d.text} · this week ${w.text}`),
        );
        budgetEl.classList.toggle('usage-spent', d.spent && w.spent);
        budgetEl.hidden = false;
      } catch { budgetEl.hidden = true; }
    }
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
    // server enforces this too (409 not_mutual) — say it plainly BEFORE the
    // tap becomes an error toast, and never offer it on a one-sided add
    if (!ent.addedBack && !ent.verified) {
      return toast(`${currentPeer} has not added you back — you can only verify each other once both of you have added one another.`, 'error');
    }
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
  // Forward recipients: ONLY contacts on my list (server cold-send aside,
  // forwarding targets people you actually have). Blocked and deleted peers
  // never appear. Tapping a name LOCKS it (row with ✕); Send needs a lock.
  let fwdPeer = null;
  let fwdContacts = [];

  async function refreshFwdContacts() {
    const [friends, chips, blocked, avatars, moderation] = await Promise.all(
      [loadFriends(), loadPeerChips(), loadPeerBlocked(), loadPeerAvatars(), loadPeerModeration()],
    );
    fwdContacts = friends
      .filter((f) => !blocked.get(f.peer) && !f.gone)
      .map((f) => ({ ...f, chip: chips.get(f.peer) ?? null, avatar: avatars.get(f.peer)?.avatar ?? null, mod: moderationOf(moderation.get(f.peer)) }))
      .sort((a, b) => a.peer.localeCompare(b.peer));
  }

  function fwdLineOpts(c) {
    const state = resolvePeerState({
      gone: !!c.gone, bound: !!c.trusted, verified: !!c.verified, trusted: !!c.trust,
      moderation: c.mod ?? null,
    });
    const chip = nameChipEl(c.chip ?? null);
    if (chip) chip.classList.add('name-chip-inline');
    return { peer: c.peer, state, chipEl: chip };
  }

  function paintFwdList() {
    const ul = $('forward-peers');
    if (!ul) return;
    const q = $('forward-username').value.trim().toLowerCase();
    ul.replaceChildren();
    // exact matches stay visible, max 3 rows (the 3-name floor means the
    // action bar below never shifts no matter what matches)
    const matches = fwdContacts.filter((x) => !q || x.peer.includes(q)).slice(0, 3);
    if (q && !matches.length) {
      // forward-only empty state: the floor stays occupied, politely
      const li = document.createElement('li');
      const none = document.createElement('span');
      none.className = 'fwd-nomatches';
      none.textContent = 'No matches';
      li.append(none);
      ul.append(li);
    }
    for (const c of matches) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      let av;
      if (c.avatar) {
        av = document.createElement('img');
        av.className = 'avatar avatar-img';
        av.alt = '';
        av.src = `data:image/jpeg;base64,${c.avatar}`;
      } else {
        av = document.createElement('span');
        av.className = 'avatar';
        av.textContent = c.peer.slice(0, 1);
      }
      const nameEl = document.createElement('span');
      mountLine(nameEl, fwdLineOpts(c));
      btn.append(av, nameEl);
      btn.addEventListener('click', () => { fwdPeer = c.peer; renderFwdPane(); });
      li.append(btn);
      ul.append(li);
    }
  }

  function renderFwdPane() {
    const picked = $('fwd-picked');
    const search = $('fwd-search');
    const results = $('fwd-results');
    const send = $('btn-forward-send');
    const fst = $('forward-status');
    // an empty status line still reserves min-height — hide it for real
    setStatus(fst, '');
    fst.hidden = true;
    if (fwdPeer) {
      const c = fwdContacts.find((x) => x.peer === fwdPeer) ?? { peer: fwdPeer };
      const line = document.createElement('span');
      mountLine(line, fwdLineOpts(c));
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'linkish';
      x.title = 'Cancel selection';
      x.append(iconEl('close'));
      x.addEventListener('click', () => {
        fwdPeer = null;
        renderFwdPane();
        $('forward-username').focus?.();
      });
      picked.replaceChildren(line, x);
      if (c.avatar) {
        const img = document.createElement('img');
        img.className = 'avatar avatar-img';
        img.alt = '';
        img.src = `data:image/jpeg;base64,${c.avatar}`;
        picked.replaceChildren(img, line, x);
      }
      picked.hidden = false;
      search.hidden = true;
      results.hidden = true;
      send.disabled = false;
    } else {
      picked.hidden = true;
      picked.replaceChildren();
      search.hidden = false;
      results.hidden = false;
      send.disabled = true;
      paintFwdList();
    }
  }

  async function openForward(id, text) {
    forwardId = id;
    // no preview clone needed: the message text stays STATIONARY above the
    // sliding bottom section — the panel itself is the preview
    void text;
    fwdPeer = null;
    $('forward-username').value = '';
    $('msg-panes').classList.add('showing-fwd'); // pane slides LEFT, fwd enters right
    await refreshFwdContacts();
    renderFwdPane();
    // Autofocus on DESKTOP only. On a touch device it does nothing useful
    // (iOS raises no keyboard for programmatic focus — device trace proved
    // it) and it actively breaks the keyboard fit: the field is already
    // focused when the user taps it, so no focusin fires and the pre-flight
    // shrink that keeps the header pinned never runs.
    if (matchMedia('(pointer: fine)').matches) $('forward-username').focus?.();
  }

  function closeForward() {
    forwardId = null;
    fwdPeer = null;
    // cancel slides the forward pane back out to the RIGHT
    $('msg-panes').classList.remove('showing-fwd');
  }

  function forwardOpen() {
    return $('msg-panes')?.classList.contains('showing-fwd');
  }

  async function sendForward() {
    const status = $('forward-status');
    status.hidden = false;
    const target = fwdPeer; // LOCKED recipient only — free-text sending is gone
    if (!target) { setStatus(status, 'Pick a contact first.', true); return; }
    const rec = forwardId && (await getMessage(forwardId));
    if (!rec) { closeForward(); return; }
    const btn = $('btn-forward-send');
    btn.disabled = true;
    // MEDIA FORWARD (plan §6.4): a blob id is a pointer into SOMEONE ELSE's
    // lifecycle, so forwarding re-SENDS the bytes this device holds — a fresh
    // key and a fresh upload, with the sender's own copy as the source. No
    // local plaintext (never downloaded here): say so instead of failing vague.
    if (rec.mediaId) {
      const row = await getMedia(rec.mediaId);
      if (!row?.data) {
        setStatus(status, 'This attachment is not downloaded on this device — download it before forwarding.', true);
        btn.disabled = false;
        return;
      }
      try {
        await sendMediaTo(target, {
          kind: row.kind, bytes: row.data, thumb: row.thumb ?? null,
          name: row.name, mime: row.mime, w: row.w, h: row.h, dur: row.dur,
          animated: row.animated === true,
        });
        closeForward();
        toast(`Forwarded to ${target}`);
        onHomeRefresh?.();
        if (currentPeer === target) await render();
      } catch (err) {
        setStatus(status, humanError(err), true);
      } finally {
        btn.disabled = false;
      }
      return;
    }
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
    peerIdentityPremium = !!peer?.premium;
    peerDisplay = peer?.displayBadge ?? null;
    // staff TIMEOUT / BAN marks ride every directory read; the sidebar
    // cache gets them too (danger icon replaces any trust icon there)
    peerModeration = moderationOf(peer);
    $('chat-sub').replaceChildren(...chatSubNodes(peer));
    if (peer) {
      await rememberPeerVerified(currentPeer, peerIdentityVerified, peerIdentityPremium);
      await rememberPeerModeration(currentPeer, { malicious: peer?.malicious === true, banned: peer?.banned === true });
    }
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

  // A friend's ACCOUNT was deleted, learned from the server side: the
  // deletion purged our list entry and a 'gone' nudge landed (or an
  // entry-reconcile noticed the disappearance). Surface it the way the
  // discovery paths (chat-open 404, send rejection) do — deleted icon +
  // read-only chat + timeline pill — never the red 'stranger/not added'
  // icon, which would silently bury the trust warning. Deduped on the pin
  // record: whoever learns the fact first emits it once.
  async function handleGonePeer(ul) {
    const peer = String(ul ?? '').toLowerCase();
    if (!peer) return;
    const pin = await getPin(peer);
    if (pin?.gone) return;
    // The pill is PERMANENT — confirm before crying wolf. A vanished entry
    // that still resolves means the removal was benign (we unfriended them
    // from another device while this one slept and the friend- sys copy
    // raced the reconcile): drop quietly, no gone flag, no pill. A
    // transient lookup failure likewise waits — the next chat-open or
    // nudge re-runs the verdict.
    try {
      // refresh:true — the cached copy says 'alive' happily while the
      // account it remembers has already been deleted; the verdict needs
      // the live lookup.
      await client.peerKeys(peer, { refresh: true });
      return; // account alive — not a deletion
    } catch (err) {
      if (!(err?.code === 'unknown_account' || err?.status === 404)) return;
    }
    await markPeerGone(peer, true);
    const hadHistory = (await messagesWith(peer)).length > 0;
    if (peer === currentPeer) {
      peerGone = true;
      goneApplied = true;
      goneAnnounced = true; // this very path IS the announcement
      setComposerEnabled(false);
      await applyPeerFacts(null);
    }
    await announceNotice(peer, hadHistory ? 'account-deleted' : 'user-gone');
    if (peer === currentPeer) {
      toast(hadHistory
        ? `${peer}'s account was deleted — history is read-only now.`
        : `${peer} doesn’t exist anymore.`, 'error');
      await updateTrustUI();
    }
  }

  // ---- per-chat notification mute (speaker button, chat header) ----------
  // The mute itself is ACCOUNT data (users.muted) enforced at the push
  // seam; this button flips it and mirrors instantly via the PEERS store
  // + the 'muted' nudge reaches every other device.
  function paintMuteBtn(peer, muted) {
    const btn = $('btn-chat-mute');
    if (!btn) return;
    if (!peer) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.dataset.icon = muted ? 'volumeXmark' : 'volume';
    btn.title = muted
      ? `${peer} is muted — no notifications. Tap to unmute.`
      : `Mute notifications from ${peer} (messages still arrive).`;
    btn.classList.toggle('muted-on', !!muted);
    btn.replaceChildren(iconEl(muted ? 'volumeXmark' : 'volume'));
  }

  async function toggleChatMute() {
    if (!currentPeer) return;
    const muted = (await loadPeerMuted()).get(currentPeer);
    const btn = $('btn-chat-mute');
    btn.disabled = true;
    try {
      if (muted) { await client.unmuteUser(currentPeer); await rememberPeerMuted(currentPeer, false); toast(`${currentPeer} unmuted — notifications are on.`); }
      else { await client.muteUser(currentPeer); await rememberPeerMuted(currentPeer, true); toast(`${currentPeer} muted — no more notifications from them.`); }
      paintMuteBtn(currentPeer, !muted);
    } catch (err) {
      toast(humanError(err), 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // Opening a chat slides the pane in from the left (see .chat-view.entering
  // in base.css). CLASS-driven with a forced-reflow restart, so SWITCHING
  // chats — where the pane is never display-toggled — re-animates too.
  // (Component scope: both openChat and the wire() close path can see it.)
  function playChatEnter() {
    const view = $('chat-view');
    if (!window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches) return;
    view.classList.remove('entering');
    void view.offsetWidth; // restart the animation
    view.classList.add('entering');
    view.addEventListener('animationend', () => view.classList.remove('entering'), { once: true });
  }

  async function openChat(username) {
    const status = $('home-status');
    try {
      let peer = null;
      peerGone = false;
      goneApplied = false;
      goneAnnounced = false;
      try {
        peer = await client.peerKeys(username, { refresh: true }); // validates existence, refreshes the cached flags (premium!)
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
      // tabs are UI state for THIS conversation, never persisted: every chat
      // opens on the transcript, no matter where the last one left off
      activeTab = 'chat';
      tabQuery = '';
      paintTabActive($('chat-tabs'), 'chat');
      releaseScope('bubbles');   // the previous chat's previews are gone from the DOM
      $('chat-peer-line').replaceChildren(); // updateTrustUI paints the component line
      // The SERVER list is ground truth for flags that can move WITHOUT any
      // action of ours — a peer un-adding us breaks the verification on BOTH
      // sides, and nothing else refreshes our mirror mid-session. Reconcile
      // before anything below reads it.
      if (client.token && !peerGone) {
        try { await setFriends(await client.listFriends()); } catch { /* offline: keep the local mirror */ }
      }
      await applyPeerFacts(peer);
      setComposerEnabled(!peerGone);
      $('chat-empty').hidden = true;
      $('chat-view').hidden = false;
      $('chat-view').classList.remove('closing'); // opened mid-slide-out: cancel the leave
      // animate the (possibly already visible — chat SWITCH) pane entering.
      // class + forced reflow restarts it every time; display-toggling alone
      // would not fire when switching A -> B with the pane staying shown.
      playChatEnter();
      setChatOpen(true);
      const last = await render();
      // history = a real conversation existed at open: something received,
      // or something sent that the server accepted (sent/delivered). A
      // failed 'sending'/'failed' out-copy does NOT count — it would fake
      // the "account deleted" obituary for a peer we never actually talked to.
      renderChatAvatar().catch(() => {});
      primePeerProfile(currentPeer);
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
      // No autofocus on touch: iOS raises no keyboard for programmatic
      // focus, but the field being ALREADY focused means the user's tap
      // fires no focusin — and the keyboard pre-flight (which keeps the
      // header pinned) only runs for a tap-earned focus. Desktop keeps it.
      if (!peerGone && matchMedia('(pointer: fine)').matches) $('chat-input').focus();
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
    // an attachment is a message: a locked composer locks the + too (ghost
    // chats / blocked / deleted accounts must not be able to open a picker)
    const attach = $('btn-attach');
    if (attach) attach.disabled = !enabled;
    input.placeholder = enabled ? 'Type a message' : `${currentPeer ?? 'This user'} no longer exists`;
  }

  const paneClosing = () => $('chat-view').classList.contains('closing');
  const closeChatPane = () => {
    currentPeer = null;
    closeProfileView();
    setChatOpen(false);
    closeMsgModal();
    closeChatOpts();
    closeForward();
    const view = $('chat-view');
    const finish = () => {
      view.classList.remove('closing');
      // never stomp a chat opened while the slide-out was still running
      if (currentPeer) return;
      view.hidden = true;
      // the empty pane appears ONLY once the sliding pane is gone: it is a
      // flex sibling, so showing it during the slide split main() in two
      // and the chat pane visibly snapped narrower — the desktop "flicker"
      $('chat-empty').hidden = false;
    };
    if (window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches && !view.hidden) {
      let settled = false;
      const done = () => { if (!settled) { settled = true; finish(); } };
      view.addEventListener('animationend', done, { once: true });
      setTimeout(done, 240); // failsafe: tab-hidden animations can stall
      view.classList.add('closing');
    } else {
      finish();
    }
    onHomeRefresh?.();
  };

  // the close path now lives at COMPONENT scope (closeChatPane is
  // exposed on the return object so the sidebar row can TOGGLE the pane shut)
  // — same trap that once bit playChatEnter.

  function wire() {
    // the conversation tab strip — five icons, one row, under the composer
    buildTabStrip($('chat-tabs'), { onChange: (tab) => setTab(tab).catch(() => {}) });

    // LOCAL RETENTION (plan §4.5): decrypted bytes age out on this device
    // unless pinned with Keep; records and transcript rows always stay. Run at
    // boot and once a day while the tab lives — a device that is never opened
    // has nothing to prune anyway (and the server already swept its blobs).
    pruneLocalMedia().then((n) => { if (n && currentPeer) render().catch(() => {}); }).catch(() => {});
    setInterval(() => { pruneLocalMedia().catch(() => {}); }, 24 * 3600 * 1000);

    const sendBtn = $('btn-send');
    // Mobile: a button tap normally moves focus off the input, tearing the
    // soft keyboard down after every send. Suppressing the pointerdown
    // DEFAULT keeps focus on the input (click still fires) — send therefore
    // does NOT hide the keyboard; tapping elsewhere/chat chrome still does.
    sendBtn.addEventListener('pointerdown', (e) => e.preventDefault());
    sendBtn.addEventListener('click', () => {
      $('attach-menu') && ($('attach-menu').hidden = true); // sending closes the menu
      sendCurrent();
    });
    $('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendCurrent();
    });

    // ---- attach: + button, its menu, and the two pickers (req 2) ----
    // The menu items are built here (not in markup) so their glyphs come from
    // the ICONS map like every other icon in the app.
    const attachBtn = $('btn-attach');
    const attachMenu = $('attach-menu');
    const attachClose = () => {
      if (!attachMenu || attachMenu.hidden) return;
      attachMenu.hidden = true;
      attachBtn.setAttribute('aria-expanded', 'false');
    };
    $('btn-attach-photo')?.replaceChildren(iconEl('attachPhoto'), document.createTextNode(' Photo or video'));
    $('btn-attach-file')?.replaceChildren(iconEl('attachFile'), document.createTextNode(' File'));
    attachBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!attachMenu || attachBtn.disabled) return;
      const open = attachMenu.hidden;
      attachMenu.hidden = !open;
      attachBtn.setAttribute('aria-expanded', String(open));
      attachBtn.blur(); // the pressed look is not the open look
    });
    $('btn-attach-photo')?.addEventListener('click', () => {
      attachClose();
      const input = $('attach-photo-input');
      input.value = '';          // re-picking the SAME file must still fire
      input.click();
    });
    $('btn-attach-file')?.addEventListener('click', () => {
      attachClose();
      const input = $('attach-file-input');
      input.value = '';
      input.click();
    });
    for (const id of ['attach-photo-input', 'attach-file-input']) {
      const input = $(id);
      input?.addEventListener('change', () => {
        const file = input.files?.[0];
        input.value = '';
        if (file) pickAndSend(file);
      });
    }
    // dismiss: a tap anywhere outside the composer row (the menu is anchored
    // to it), like the chat-options menu but local to the composer
    document.addEventListener('click', (e) => {
      if (!attachMenu || attachMenu.hidden) return;
      if (e.target.closest('.composer')) return;
      attachClose();
    });
    document.getElementById('notif-banner')?.addEventListener('click', (e) => {
      const peer = e.target.dataset?.peer;
      e.target.hidden = true;
      if (peer) openChat(peer);
    });

    // Closing is animated (slide back out to the left, following the back
    // arrow) but the LOGIC is
    // immediate: currentPeer, body class and the modals drop synchronously,
    // only the pane's `hidden` waits for the animation. Guards therefore
    // test the .closing CLASS as well as hidden — the synthetic click a
    // swipe leaves behind lands inside this ~140ms window.
    $('btn-chat-back').addEventListener('click', closeChatPane);
    // Swipe closes the conversation (mobile): a deliberate LEFT drag (>72px,
    // clearly more horizontal than vertical) acts as the back button — right
    // swipes do nothing. Passive listeners; we never fight the vertical scroll.
    {
      const view = $('chat-view');
      let sw = null;
      view.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1 || !currentPeer) return;
        sw = { x: e.touches[0].clientX, y: e.touches[0].clientY, fired: false };
      }, { passive: true });
      view.addEventListener('touchmove', (e) => {
        if (!sw || sw.fired || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - sw.x;
        const dy = e.touches[0].clientY - sw.y;
        // LEFT swipes only close (matching the back arrow and the slide-out
        // direction); a right drag is never a close gesture
        if (dx < -72 && Math.abs(dx) > Math.abs(dy) * 1.6) sw.fired = true;
      }, { passive: true });
      view.addEventListener('touchend', () => {
        const fired = sw?.fired;
        sw = null;
        if (fired) closeChatPane();
      }, { passive: true });
      view.addEventListener('touchcancel', () => { sw = null; }, { passive: true });
    }
    // Escape: dismiss the top-most layer first (forward > message > options
    // > conversation). Desktop "close" gesture otherwise.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('attach-menu')?.hidden) { $('attach-menu').hidden = true; $('btn-attach')?.setAttribute('aria-expanded', 'false'); return; }
      if (!$('lightbox-overlay')?.hidden) { closeLightbox(); return; }
      if (forwardOpen()) { closeForward(); return; }
      if (!$('premium-modal')?.hidden) { closeBadgeModal(); return; }
      if (!$('profile-modal')?.hidden) { closeProfileView(); return; }
      if (msgModalOpen()) { closeMsgModal(); return; }
      if (!$('chatopts-modal').hidden) { closeChatOpts(); return; }
      if (document.body.classList.contains('chat-open')) closeChatPane();
    });

    // Tap/click a bubble -> message modal (delegated: bubbles re-render
    // atomically, so the listener lives on the list itself). Guard against
    // the synthetic click a swipe-close leaves behind: once the pane is
    // hidden, taps must not pop the modal over the empty sidebar.
    $('chat-messages').addEventListener('click', (e) => {
      if ($('chat-view').hidden || paneClosing()) return;
      const li = e.target.closest('li.msg');
      if (!li) return;
      // a bubble's own Download/Delete buttons are NOT a tap on the bubble:
      // they act and the modal stays shut (req 6 lives right here)
      const act = e.target.closest('.media-dl') ? 'download'
        : e.target.closest('.media-decline') ? 'decline' : null;
      if (act) {
        runBubbleAction(li.dataset.id, act)
          .catch(() => toast('That did not go through — try again.', 'error'));
        return;
      }
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
    $('btn-peer-profile')?.addEventListener('click', openProfileView);
    $('btn-chat-profile')?.addEventListener('click', openProfileView);
    $('chatopts-overlay').addEventListener('click', closeChatOpts);
    $('btn-chat-mute')?.addEventListener('click', toggleChatMute);
    $('btn-chat-block')?.addEventListener('click', async () => {
      closeChatOpts();
      if (!currentPeer) return;
      if (await blockUserWithConfirm(client, currentPeer)) {
        await updateTrustUI();
        onHomeRefresh?.();
      }
    });
    // Report user: modal collects reason + description (+ the optional
    // auto-block checkbox); a landed report-block flips the trust UI too
    $('btn-chat-report')?.addEventListener('click', async () => {
      closeChatOpts();
      if (!currentPeer) return;
      if (await reportUserWithConfirm(client, currentPeer)) {
        await updateTrustUI();
        onHomeRefresh?.();
      }
    });
    $('btn-chat-friend')?.addEventListener('click', () => {
      primaryAction(); // decides itself whether to stay open (panel) or close
    });
    $('btn-chat-remove')?.addEventListener('click', () => {
      closeChatOpts();
      removeUser();
    });
    $('btn-identity-back')?.addEventListener('click', showChatOptsMenu);
    $('identity-number')?.addEventListener('click', copySafetyNumber);
    $('identity-number')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copySafetyNumber(); }
    });
    $('btn-identity-verify')?.addEventListener('click', toggleVerified);
    // delegated lightbox: ANY rendered avatar photo zooms, whenever it exists
    document.addEventListener('click', (e) => {
      const el = e.target;
      if (el && el.tagName === 'IMG' && el.src && !el.hidden && el.closest('#profile-modal, #tabpanel-profile')) {
        openLightbox(el.src);
      }
    });
    $('btn-profile-close')?.addEventListener('click', closeProfileView);
    $('profile-overlay')?.addEventListener('click', closeProfileView);
    // clicking a name chip or any badge chip opens its detail modal
    // clicking the worn-badge chip INSIDE the profile name line opens its modal
    $('profile-line')?.addEventListener('click', (e) => {
      const chip = e.target.closest?.('.badge-name-chip');
      if (!chip) return;
      showBadgeModal(chip.dataset.badge, { owner: profileSubject ?? currentPeer ?? '' });
    });
    $('profile-badges')?.addEventListener('click', (e) => {
      const chip = e.target.closest?.('.badge-chip');
      if (!chip) return;
      const held = profileBadges.find((b) => b.id === chip.dataset.badge);
      showBadgeModal(chip.dataset.badge, { at: held?.at ?? null, owner: chip.dataset.owner || profileSubject || currentPeer || '' });
    });
    $('btn-premium-close')?.addEventListener('click', closeBadgeModal);
    $('premium-overlay')?.addEventListener('click', closeBadgeModal);
    // fresh awards from the main.js poll → one modal per badge, queued;
    // plus an OS notification (best-effort: permission/standalone dependent)
    // fresh awards (dispatched by js/notify.js) → one modal per badge,
    // queued. The OS-notification decision lives in notify.js now — one
    // brain, one dedup rule (visible app = modal only, no double-fire)
    window.addEventListener('cocono:newbadges', (e) => {
      const owner = String(client.username ?? '');
      for (const b of (e.detail ?? [])) showBadgeModal(b.id, { at: b.at, owner, offerWear: true });
    });
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
      // the media rows of this conversation go too — same device-local
      // contract, and decrypted bytes with no message left to show them are
      // invisible weight (and a privacy surprise)
      await clearMediaWith(currentPeer);
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
    $('forward-username').addEventListener('input', () => paintFwdList());
    $('forward-username').addEventListener('keydown', (e) => {
      // Enter locks the single visible/best match, like tapping it
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = $('forward-username').value.trim().toLowerCase();
      const hit = fwdContacts.find((c) => c.peer === q) ?? fwdContacts.find((c) => c.peer.includes(q));
      if (hit && !fwdPeer) { fwdPeer = hit.peer; renderFwdPane(); }
    });
    $('btn-forward-cancel').addEventListener('click', closeForward);
    $('btn-forward-send').addEventListener('click', () => sendForward());

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

  return { wire, connectEvents, openChat, render, openSelfProfile, handleGonePeer, openPeer: () => currentPeer,
    closeChat: closeChatPane, isOpenFor: (p) => !!currentPeer && String(p ?? '').toLowerCase() === currentPeer };
}
