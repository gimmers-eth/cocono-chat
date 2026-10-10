// ---- Share-link attribution: who grew the network, and how --------------
// The app's share button hands out `/?chat=<my-username>` deep links. Two
// facts about those links are worth keeping server-side (admin Shares tab +
// God View graph):
//
//   CREATED  an account came into existence BECAUSE of someone's link
//            (recorded at signup, on the new user's own doc as `ref`)
//   SEEN     an account that ALREADY existed opened someone's link
//            (reported by the client once it has a session)
//
// Both live in ONE collection (`shares`) as a single doc per
// (owner -> viewer) pair, so the data is bounded by real relationships and
// repeated clicks just bump a counter:
//
//   { o, viewer, n, firstAt, lastAt, created }
//     o        username whose link was followed (the referrer)
//     viewer   username that followed it
//     n        click count EXCLUDING the creation itself
//     created  Date when `viewer` was created from `o`'s link (else absent)
//
// `contacts` is the sibling collection for the graph's third edge kind —
// "A has messaged B". The message queue is store-and-forward (copies expire
// out of `messages` once pulled), so without this the graph would only ever
// show messages in flight. It holds NO content: sender, recipient, count and
// timestamps — facts the server already knows from addressing.
//
//   { from, to, n, firstAt, lastAt }
//
// Trust level (deliberate): attribution rides UNSIGNED fields — `r` on the
// signup body and `o` on the share-hit report. It buys nothing (no rewards,
// no score, no badge), so a client lying about it can only mislabel its own
// origin in an admin view. The signature still covers identity, keys and
// freshness; widening it would break every shipped client for no gain.

import { USERNAME_RE } from './username.js';

export const normUl = (v) => String(v ?? '').trim().toLowerCase();

/** A usable username for attribution (never throws on junk input). */
export function shareableName(v) {
  const ul = normUl(v);
  return USERNAME_RE.test(ul) ? ul : null;
}

/**
 * Record that `viewer` opened `owner`'s share link while ALREADY having an
 * account (the graph's "seen" edge). Idempotent per pair: the first click
 * stamps firstAt, later ones bump n/lastAt. Self-clicks are ignored — the
 * client does not report them either, and a self-edge is noise in a graph.
 * @returns {Promise<boolean>} true when a row was written
 */
export async function recordShareHit(shares, { owner, viewer, now = new Date() }) {
  const o = shareableName(owner);
  const v = shareableName(viewer);
  if (!shares || !o || !v || o === v) return false;
  await shares.updateOne(
    { o, viewer: v },
    {
      $inc: { n: 1 },
      $set: { lastAt: now },
      $setOnInsert: { o, viewer: v, firstAt: now },
    },
    { upsert: true },
  );
  return true;
}

/**
 * Record that `viewer` was CREATED from `owner`'s link. Written at signup,
 * before the account's first session, so it never collides with a later
 * share-hit report from the same pair (that one only bumps `n`).
 * Does NOT bump n: creation is not a "click" on top of itself.
 */
export async function recordReferral(shares, { owner, viewer, now = new Date() }) {
  const o = shareableName(owner);
  const v = shareableName(viewer);
  if (!shares || !o || !v || o === v) return false;
  await shares.updateOne(
    { o, viewer: v },
    {
      $set: { created: now, lastAt: now },
      $setOnInsert: { o, viewer: v, firstAt: now, n: 0 },
    },
    { upsert: true },
  );
  return true;
}

/**
 * Durable "has messaged" edge, upserted on every ACCEPTED send (self-sends
 * excluded — the graph is about relationships between different people).
 * Fire-and-forget at the call site: a bookkeeping write must never fail a
 * message the server already queued.
 */
export async function recordContactEdge(contacts, { from, to, now = new Date() }) {
  const f = shareableName(from);
  const t = shareableName(to);
  if (!contacts || !f || !t || f === t) return false;
  await contacts.updateOne(
    { from: f, to: t },
    {
      $inc: { n: 1 },
      $set: { lastAt: now },
      $setOnInsert: { from: f, to: t, firstAt: now },
    },
    { upsert: true },
  );
  return true;
}

/**
 * Everything the admin Shares tab needs about ONE account, in the order the
 * tab tells the story:
 *   ref      the link THIS account was created from (its parent), if any
 *   created  accounts created from this account's link (newest first)
 *   seen     existing accounts that opened this account's link
 *   clicked  the links this account opened (incl. the one it was born from)
 * Rows carry `gone` when the counterpart username no longer exists, so a
 * deleted parent/referrer is still shown as the fact it is.
 */
export async function shareStory(shares, users, ul) {
  const me = normUl(ul);
  const owned = await shares.find({ o: me }).toArray();
  const mine = await shares.find({ viewer: me }).toArray();
  const doc = await users.findOne({ ul: me }, { projection: { ref: 1 } });

  const names = new Set();
  for (const r of [...owned, ...mine]) { names.add(r.o); names.add(r.viewer); }
  if (doc?.ref?.by) names.add(normUl(doc.ref.by));
  names.delete(me);
  // ONE lookup for every counterpart: liveness, premium star and join date
  const peers = new Map(
    (await users.find({ ul: { $in: [...names] } }, { projection: { ul: 1, premium: 1, createdAt: 1 } }).toArray())
      .map((u) => [u.ul, u]),
  );

  const who = (name) => ({
    ul: name,
    premium: peers.get(name)?.premium === true,
    gone: !peers.has(name),
    createdAt: peers.get(name)?.createdAt ?? null,
  });

  const byNewest = (a, b) => (new Date(b.at ?? 0) - new Date(a.at ?? 0)) || a.ul.localeCompare(b.ul);

  const created = owned
    .filter((r) => r.created)
    .map((r) => ({ ...who(r.viewer), at: r.created, clicks: r.n ?? 0, firstAt: r.firstAt ?? null, lastAt: r.lastAt ?? null }))
    .sort(byNewest);
  const seen = owned
    .filter((r) => !r.created)
    .map((r) => ({ ...who(r.viewer), at: r.lastAt ?? r.firstAt ?? null, clicks: r.n ?? 0, firstAt: r.firstAt ?? null, lastAt: r.lastAt ?? null }))
    .sort((a, b) => (new Date(b.lastAt ?? b.firstAt ?? 0) - new Date(a.lastAt ?? a.firstAt ?? 0)) || a.ul.localeCompare(b.ul));
  const clicked = mine
    .map((r) => ({
      ...who(r.o),
      at: r.lastAt ?? r.firstAt ?? null,
      clicks: r.n ?? 0,
      firstAt: r.firstAt ?? null,
      lastAt: r.lastAt ?? null,
      // the link this account was BORN from is flagged in-place, so the
      // "links you clicked" list and the parent row never disagree
      createdMe: !!r.created,
    }))
    .sort((a, b) => (new Date(b.lastAt ?? b.firstAt ?? 0) - new Date(a.lastAt ?? a.firstAt ?? 0)) || a.ul.localeCompare(b.ul));

  const refBy = doc?.ref?.by ? normUl(doc.ref.by) : null;
  return {
    ul: me,
    ref: refBy ? { ...who(refBy), at: doc.ref.at ?? null } : null,
    created,
    seen,
    clicked,
  };
}
