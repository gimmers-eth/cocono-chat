// ---- Badge engine -------------------------------------------------------
// ONE award route: grantBadge() is the ONLY code that writes awards.<id>
// anywhere. evaluateBadges() walks the classes and calls it for every
// ELIGIBLE badge it finds; admin actions set state (flags) and then call
// the same evaluation. Premium is a normal award whose ELIGIBILITY is the
// admin flag; Teacher's Pet is a normal award whose eligibility is the
// admin-set grant flag. There are no side channels — so every badge, from
// every trigger, lands in the awards map with a fresh gid and goes through
// ONE dispatch: poll → unseen → modal + notification + ack.
//
// Modes:
//   'auto'  — eligibility evaluated on every normal trigger (signup, login,
//             the client's badge poll)
//   'admin' — eligibility comes from an admin-set flag (users.adminAwards);
//             still awarded by the SAME evaluation loop
//
// Awards live on the user doc as
//   awards: { <id>: { at: <ISO>, gid: <uuid> } }   (legacy bare ISO strings
// are normalized on read, gid = `${id}:${at}`)
//   displayBadge: the WEARING choice — never touched by awarding.
// Capped badges are granted through a serial in-process QUEUE: eligibility
// is evaluated one user at a time, holder counts checked inside the same
// queue step, so two near-simultaneous signups can never both take the
// final slot.
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

export class Badge {
  id = null;
  label = null;
  // score/cap are METHODS taking the request-time config: routes are built
  // with a merged config object (test/ops overrides), so the badge engine
  // must never read the module singleton directly.
  scoreOf(_config) { return 0; }
  capOf(_config) { return null; } // null = uncapped
  blurb = null; // the story the modals tell — one source for admin + app
  // 'auto'  — queued eligibility (signup/login/poll)
  // 'admin' — eligibility set by an admin flag (users.adminAwards.<id>)
  mode = 'auto';
  /** @param {object} user @param {{users, counters, config}} ctx */
  async eligible(_user, _ctx) { return false; } // eslint-disable-line no-unused-vars
}

// The first ten accounts on the platform, forever. Rank is evaluated by
// createdAt; the live holder count is the hard gate (queue-serialised).
export class OgBadge extends Badge {
  id = 'og';
  mode = 'auto';
  label = 'OG';
  blurb = 'One of the first ten accounts on CoCoNo.';
  scoreOf() { return 10; }
  capOf(cfg) { return cfg.ogBadgeCap ?? 10; }
  async eligible(user, ctx) {
    const cap = this.capOf(ctx.config);
    const rank = await ctx.users.countDocuments({ 'awards.og': { $exists: true } }) + 1;
    if (rank > cap) return false;
    // must be among the ten earliest accounts ever created
    const earlier = await ctx.users.countDocuments({ createdAt: { $lt: user.createdAt } });
    return earlier < cap;
  }
}

// Everyone who joined before the clock ran out on 2026 — first 1000 only.
export class EarlyBirdBadge extends Badge {
  id = 'earlybird';
  mode = 'auto';
  label = 'Early Bird';
  blurb = 'Joined CoCoNo before the end of 2026 — one of the first 1,000 accounts to get the word out.';
  scoreOf() { return 3; }
  capOf(cfg) { return cfg.earlyBirdCap ?? 1000; }
  async eligible(user, ctx) {
    if (new Date(user.createdAt).getTime() >= new Date(ctx.config.earlyBirdDeadline).getTime()) return false;
    const held = await ctx.users.countDocuments({ 'awards.earlybird': { $exists: true } });
    return held < this.capOf(ctx.config);
  }
}

// Premium: the flat CoCo bonus the flag already grants, now a REAL award —
// eligibility is the admin premium flag, the award itself goes through the
// one route (so it dispatches its modal like everything else).
class PremiumBadge extends Badge {
  id = 'premium';
  label = 'Premium';
  blurb = 'A premium subscriber. The gold certificate funds the platform and lifts CoCo reputation.';
  scoreOf(cfg) { return cfg.cocoPremiumBonus ?? 5; }
  async eligible(user) { return user.premium === true; }
}

// Teacher's Pet — the staff favourite: +1 CoCo, awarded ONLY from the admin
// panel (never auto-eligible), uncapped by default.
class TeachersPetBadge extends Badge {
  id = 'teacherspet';
  label = "Teacher's Pet";
  scoreOf() { return 1; }
  mode = 'admin';
  blurb = "Hand-picked by the platform staff — a small apple for the teacher's pet.";
  // the admin panel sets users.adminAwards.teacherspet; the SHARED
  // evaluation then awards (and re-awards after a revoke) like any other
  async eligible(user) { return user.adminAwards?.teacherspet === true; }
}

// "You've got mail" — your first messages actually went out. The counter
// lives in the `counters` collection keyed by USERNAME (kept OUTSIDE the
// account doc so a deleted-and-re-registered user keeps their progress —
// and deleteAccountFully deliberately never touches counters).
class MailBadge extends Badge {
  id = 'mail';
  label = "You've got mail";
  blurb = 'Your first five messages went out into the world. The mailbox only fills up from here.';
  scoreOf() { return 2; }
  async eligible(user, ctx) {
    const target = ctx.config.mailBadgeCount ?? 5;
    if (!ctx.counters) return false;
    const c = await ctx.counters.findOne({ _id: `sent:${user.ul}` });
    return (c?.n ?? 0) >= target;
  }
}

export const BADGES = [new OgBadge(), new EarlyBirdBadge(), new PremiumBadge(), new TeachersPetBadge(), new MailBadge()];
export const badgeById = new Map(BADGES.map((b) => [b.id, b]));

/** The unified held list, award dates included. Pure — no ctx needed. */
/**
 * The unified held list, grant-unique. Awards are stored as
 *   awards.<badgeId> = { at, gid }        (gid = unique per grant)
 * with legacy bare ISO strings normalized on read (gid = `${id}:${at}`).
 * The gid is what the client's seen-ack
 * records — so a REVOKED-then-RE-AWARDED badge is a brand-new grant, gets a
 * new gid, and dispatches a fresh modal/notification (the bug this fixes).
 */
export function badgesFor(user) {
  const out = [];
  for (const [id, grant] of Object.entries(user.awards ?? {})) {
    if (!badgeById.has(id)) continue;
    if (typeof grant === 'string') out.push({ id, at: grant, gid: `${id}:${grant}` });
    else if (grant) out.push({ id, at: grant.at ?? null, gid: grant.gid || `${id}:${grant.at ?? ''}` });
  }
  return out.sort((a, b) => (badgeById.get(b.id).score - badgeById.get(a.id).score) || a.id.localeCompare(b.id));
}

/** Total CoCo score contribution of a held-badge list. */
export function badgeScore(badges, config) {
  return (badges ?? []).reduce((sum, b) => sum + (badgeById.get(b.id)?.scoreOf(config) ?? 0), 0);
}

/** What may sit next to the name: an owned badge id, or null (auto). */
/**
 * The badge a NAME may show: only admin-VERIFIED accounts display one, and
 * only what they explicitly chose. '' / undefined / unverified → none.
 */
export function visibleDisplayBadge(user) {
  if (user?.verified !== true) return null;
  const d = user.displayBadge;
  return d && d !== '' ? d : null;
}

export function validDisplayBadge(user, wanted) {
  if (wanted === null || wanted === '') return true; // explicitly none
  return badgesFor(user).some((b) => b.id === wanted);
}
export function defaultDisplayBadge(user) {
  const held = badgesFor(user);
  if (!held.length) return null;
  // badgesFor is already sorted best-first; the best badge is the default
  return held[0].id;
}

// ---- serial award queue --------------------------------------------------
// One promise chain; each evaluation runs alone, so the count-check-then-award
// inside is race-free (single process per environment; the queue is the only
// award path — admin awards funnel through it too).
// The serial queue EVERY award WRITE goes through. One in-process chain
// means cap checks and spends happen atomically relative to each other —
// near-simultaneous signups cannot both take the last slot.
//
// RE-ENTRANCY (a flag-based "run inline when held" scheme deadlocked the
// suite: a concurrent reset let a nested grant chain BEHIND its own waiting
// task — self-await forever). The honest design instead: doGrant() is the
// raw body; grantBadge() wraps it in the queue; evaluateBadges() runs as a
// queue task and calls doGrant() DIRECTLY (it already holds serialization).
// No flags, no re-entrant paths, no races.
let chain = Promise.resolve();
function enqueue(task) {
  const run = chain.then(task, task); // a failed neighbour must not poison the queue
  chain = run.catch((err) => console.error('[badges] queue task failed:', err?.message ?? err));
  return run;
}

/** The award write itself — ONLY call while holding the queue (enqueue). */
async function doGrant(users, { id, ul, config }) {
  const badge = badgeById.get(id);
  if (!badge) throw new Error(`unknown badge ${id}`);
  const user = await users.findOne({ ul });
  if (!user) return null;
  if (user.awards?.[id]) return { held: true };
  const cap = badge.capOf(config);
  if (cap !== null) {
    const holders = await users.countDocuments({ [`awards.${id}`]: { $exists: true } });
    if (holders >= cap) return { full: true };
  }
  const now = new Date().toISOString();
  const gid = randomUUID();
  // awarding never auto-wears — wearing is the user's own choice
  await users.updateOne({ ul }, { $set: { [`awards.${id}`]: { at: now, gid } } });
  return { at: now, gid };
}

/**
 * Fire-and-forget: evaluate every capped badge for this account and award
 * what's earned. Returns the chain handle for tests.
 */
/**
 * THE SINGLE AWARD ROUTE. Nothing else may write awards.<id>. Grants a
 * badge that is not yet held, serialised through the shared queue so caps
 * are checked the same moment they are spent. cap=null means uncapped.
 * Returns the grant ({at,gid}) or {held:true} when already owned.
 */
export async function grantBadge(users, opts) {
  return enqueue(() => doGrant(users, opts));
}

/** THE revoke primitive: drop the award and its seen-ack, so a re-grant is
 *  a brand-new dispatch (modal + notification). Also strips the badge if it
 *  was being worn. */
export async function revokeBadge(users, { id, ul }) {
  const user = await users.findOne({ ul });
  const grant = user?.awards?.[id];
  const gids = [grant?.gid || `${id}:${grant?.at ?? ''}`, id]; // + legacy bare-id ack
  const set = {};
  if (user?.displayBadge === id) set.displayBadge = null;
  await users.updateOne({ ul }, {
    $unset: { [`awards.${id}`]: '', ...(Object.keys(set).length ? set : {}) },
    $pull: { badgesSeen: { $in: gids } },
  });
  return { revoked: true, id };
}

/**
 * The evaluation loop — the only CALLER shape of grantBadge for automatic
 * triggers. Walks every class; 'auto' badges are eligibility-checked,
 * 'admin' badges only fire once an admin set their flag. Every award, from
 * every path, lands in the awards map with a fresh gid — one dispatch
 * pipeline for modals and notifications.
 * ctx: { users, config, counters? } (counters missing = counter badges
 * simply not eligible on this trigger; the client poll always supplies it).
 */
export function evaluateBadges(users, config, ul, counters = null) {
  const ctx = { users, config, counters };
  // ONE queue task walks the whole list; grants call doGrant directly
  // because this body IS the held queue (see the re-entrancy note above)
  return enqueue(async () => {
    const user = await users.findOne({ ul });
    if (!user) return;
    for (const badge of BADGES) {
      if (badge.mode !== 'auto' && badge.mode !== 'admin') continue;
      if (user.awards?.[badge.id]) continue; // already held (grant is idempotent anyway)
      if (!(await badge.eligible(user, ctx))) continue;
      await doGrant(users, { id: badge.id, ul, config });
      user.awards = { ...(user.awards ?? {}), [badge.id]: true };
    }
  });
}

// Shared admin snapshot: definitions + live holders per badge.
export async function badgeOverview(users, config) {
  const rows = [];
  for (const badge of BADGES) {
    const cap = badge.capOf(config);
    const holders = await users.countDocuments({ [`awards.${badge.id}`]: { $exists: true } });
    rows.push({
      id: badge.id,
      label: badge.label,
      blurb: badge.blurb,
      score: badge.scoreOf(config),
      cap,
      holders,
      full: cap !== null && holders >= cap,
      mode: badge.mode,
      // premium is the FLAG toggle's business — the badge award route
      // refuses it; this flag must mirror that guard, not the mode
      awardable: badge.id !== 'premium',
      auto: badge.mode === 'auto',
    });
  }
  return rows;
}
