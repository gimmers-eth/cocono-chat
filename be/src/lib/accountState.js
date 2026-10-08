import { createNotifier } from './notify.js';

// Server-side account teardown, shared by the admin routes and the
// self-service device detach (removing the LAST device deletes the account).

// L9 fix: removing an account should also sweep its Redis state (login
// nonces, pending/approved enrollments, per-account rate-limit counters)
// instead of leaving it to TTL expiry.
export async function cleanupAccountState(redis, ul) {
  await redis.del(`rl:verify:${ul}`, `rl:dapprove:${ul}`, `rl:dpending:${ul}`);

  for await (const batch of redis.scanIterator({ MATCH: `denroll:c:${ul}:*`, COUNT: 100 })) {
    for (const key of batch) {
      const raw = await redis.getDel(key);
      try {
        const { enrollId } = JSON.parse(raw);
        await redis.del(`denroll:p:${enrollId}`, `denroll:ok:${enrollId}`);
      } catch {
        // Not a enrollment record — ignore.
      }
    }
  }

  // Login nonces are keyed by the nonce itself; inspect the bound account.
  for await (const batch of redis.scanIterator({ MATCH: 'auth:nonce:*', COUNT: 100 })) {
    for (const key of batch) {
      try {
        const bound = JSON.parse(await redis.get(key));
        if (bound?.ul === ul) await redis.del(key);
      } catch {
        // ignore
      }
    }
  }
}

// Purge a deleted username from every OTHER account's friends list.
// Trust in a dead account is meaningless — and if the username is later
// re-registered, a stale entry would silently point at whoever grabbed it.
// (Clients ALSO mark/clean via gone/changed flags: this sweep is the
// defense-in-depth, so even a reconcile-time GET can't resurrect the ghost.)
export async function purgeFriendReferences(users, deletedUl, redis) {
  // Nudge the holders BEFORE erasing the references (the reverse scan needs
  // them). 'gone' — not 'friends' — because the entry vanishes for a real
  // reason the holder must be able to tell apart from an unfriend: the
  // account CEASED TO EXIST. Clients render the deleted icon + timeline
  // warning pill for this; a plain disappear would show 'stranger'.
  if (redis) await createNotifier({ redis, users }).notifyPeers(deletedUl, 'gone');
  // bound {u, p} entries
  await users.updateMany(
    { ul: { $ne: deletedUl }, friends: { $elemMatch: { u: deletedUl } } },
    { $pull: { friends: { u: deletedUl } } },
  );
  // legacy plain-string entries
  await users.updateMany(
    { ul: { $ne: deletedUl }, friends: deletedUl },
    { $pull: { friends: deletedUl } },
  );
}
