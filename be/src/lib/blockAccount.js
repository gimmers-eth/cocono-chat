// Shared BLOCK application — one implementation for the block route
// (friends.js) and the report flow's optional auto-block (reports.js).
// Semantics (see friends.js header for the full contract): the block
// SEVERS the relation both ways, records the blocker's stated reason
// (account data, never shown to the blocked party), and nudges caches.
// Returns false when the target account does not exist.

const normalize = (list) => (list ?? []).map((f) => (
  typeof f === 'string'
    ? { u: f, p: null, v: false, t: false }
    : { u: String(f.u ?? '').toLowerCase(), p: f.p ?? null, v: f.v === true, t: f.t === true }
)).filter((f) => f.u);

/**
 * @param {{ users, notifyAccount }} deps  collection + notify fn
 * @param {string} ul        blocker's account (lowercased)
 * @param {string} target    blocked account (lowercased)
 * @param {string} reason    one of the enforced block-reason ids
 */
export async function applyBlock({ users, notifyAccount }, ul, target, reason) {
  const tDoc = await users.findOne({ ul: target }, { projection: { _id: 1, friends: 1 } });
  if (!tDoc) return false;

  await users.updateOne({ ul }, {
    $addToSet: { blocked: target },
    $set: { [`blockReasons.${target}`]: { r: reason, at: new Date() } },
  });

  // sever BOTH ways (stronger than un-add: their entry on me goes too,
  // and my flags on them die with it — no half-trust may persist)
  const user = await users.findOne({ ul }, { projection: { friends: 1 } });
  const kept = normalize(user?.friends).filter((f) => f.u !== target);
  await users.updateOne({ ul }, { $set: { friends: kept.sort((a, b) => a.u.localeCompare(b.u)) } });
  const theirKept = normalize(tDoc.friends).filter((f) => f.u !== ul);
  if (theirKept.length !== normalize(tDoc.friends).length) {
    await users.updateOne({ ul: target }, { $set: { friends: theirKept.sort((a, b) => a.u.localeCompare(b.u)) } });
    // their view of the relation moved completely — nudge (they learn the
    // severing via their own re-pull, never that they are blocked)
    await notifyAccount(target, 'friends');
  }
  // my other devices: the entry left MY list too
  await notifyAccount(ul, 'friends');
  return true;
}
