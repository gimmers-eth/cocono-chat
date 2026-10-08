// ---- CONTROL NUDGES: the server->device "re-pull what you cache" pattern.
//
// THE TWO SYNC CHANNELS (keep the split clean when adding features):
//
// 1. E2EE SYSTEM MESSAGES  (client SDK: #broadcastFlag / announceNotice,
//    handled in chat.js 'message' where peer === own username)
//    actor's device -> the SAME account's other devices. Encrypted,
//    store-and-forward (offline devices catch up on connect), can enter
//    the transcript as security notices. Carries FACTS of your own actions.
//
// 2. CONTROL NUDGES  (this file)
//    SERVER -> every device of accounts whose authoritative state MOVED
//    BECAUSE OF SOMEONE ELSE (peer added/removed me, admin reviewed me,
//    a followed peer edited their profile…). Frames are deliberately
//    CONTENT-FREE: { type: 'notice', what }. They say "your cached copy
//    of <what> may be stale — re-pull it AS YOURSELF". Nothing can leak:
//    the recipient only ever learns what its own authenticated reads
//    already show. Best-effort and live-only: offline devices miss the
//    nudge and reconcile at app entry (the server list is the source of
//    truth — that reconcile must stay correct on its own).
//
// Transport: the WS layer's own Redis pub/sub channels ('dm:<ul>:<dv>').
// Publishing there reaches the socket on whatever node it lives on; no WS
// code involved. Clients without a live socket simply never get the frame.
//
// THE 'what' TAXONOMY — add new values HERE, never invent inline:
//   'friends'  your friends/verification relation moved: someone added
//               you, removed you, or an un-add revoked your stages.
//               Client re-pulls GET /api/me/friends.
//   'gone'     a FRIEND'S ACCOUNT was deleted — the server purged it from
//               your list (see purgeFriendReferences). Client re-pulls AND
//               surfaces the vanished entry as deleted (icon + timeline
//               pill), not as a red 'stranger'.
//   'profile'  a peer who follows YOU edited bio/avatar: re-prime the
//               peer-profile cache (photos/bios of others).
//   'identity' YOUR account's identity-review state changed (admin
//               verified/unverified you): re-read GET /api/me.
export function createNotifier({ redis, users }) {
  async function publish(ul, dv, what) {
    try {
      await redis.publish(`dm:${ul}:${dv}`, JSON.stringify({ type: 'notice', what }));
    } catch { /* best-effort: a nudge must never fail a mutation */ }
  }

  /** Nudge every device of one account. */
  async function notify(ul, what) {
    try {
      const doc = await users.findOne({ ul }, { projection: { 'devices.id': 1 } });
      for (const dev of doc?.devices ?? []) await publish(ul, dev.id, what);
    } catch { /* best-effort */ }
  }

  /** Nudge every device of every account that lists ul as a friend.
      Run BEFORE any purge that removes those references — the reverse
      scan reads them. (Legacy string-only entries don't match $elemMatch
      {u}; they are untrusted by policy anyway.) */
  async function notifyPeers(ul, what) {
    try {
      for await (const doc of users.find(
        { ul: { $ne: ul }, friends: { $elemMatch: { u: ul } } },
        { projection: { ul: 1, devices: 1 } },
      )) {
        for (const dev of doc.devices ?? []) await publish(doc.ul, dev.id, what);
      }
    } catch { /* best-effort */ }
  }

  return { notify, notifyPeers };
}
