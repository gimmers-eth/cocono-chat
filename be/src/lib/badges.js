// ---- Badge engine -------------------------------------------------------
// Every badge is its OWN class (cap, score, eligibility rules live together)
// registered in BADGES. Awards live on the user doc as
//   awards: { og: <ISO date>, earlybird: <ISO date> }   (capped badges only)
//   displayBadge: 'og' | 'earlybird' | 'premium' | null  (name chip choice)
// The PREMIUM badge is derived from the account flag (users.premium) — it is
// never written to awards; badgesFor() stitches it in so every surface (app,
// admin, scores) sees ONE list with award timestamps.
//
// Capped badges are granted through a serial in-process QUEUE: eligibility
// is evaluated one user at a time, and the holder-count check happens inside
// the same queue step, so two near-simultaneous signups can never both take
// the 10th OG slot. Awards happen AFTER signup (the user signs up, logs in,
// then their client's badge poll picks the award up).
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
  // 'auto'    — queued eligibility (signup/login/poll)
  // 'admin'   — awardable ONLY from the admin panel (Teacher's Pet)
  // 'derived' — never stored; read off an account flag (premium)
  mode = 'auto';
  /** @param {object} user @param {{users: import('mongodb').Collection, config: object}} ctx */
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

// Premium is a badge now — derived from the admin flag, carrying the flat
// CoCo bonus the flag already granted (one source for both).
class PremiumBadge extends Badge {
  id = 'premium';
  mode = 'derived';
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
}

export const BADGES = [new OgBadge(), new EarlyBirdBadge(), new PremiumBadge(), new TeachersPetBadge()];
export const badgeById = new Map(BADGES.map((b) => [b.id, b]));

/** The unified held list, award dates included. Pure — no ctx needed. */
/**
 * The unified held list, grant-unique. Awards are stored as
 *   awards.<badgeId> = { at, gid }        (gid = unique per grant)
 * with legacy bare ISO strings normalized on read (gid = `${id}:${at}`).
 * Premium is derived from its flag. The gid is what the client's seen-ack
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
  if (user.premium === true) {
    const at = user.premiumAt ?? null;
    out.push({ id: 'premium', at, gid: `premium:${at ?? 'now'}` });
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
let chain = Promise.resolve();

/**
 * Fire-and-forget: evaluate every capped badge for this account and award
 * what's earned. Returns the chain handle for tests.
 */
export function evaluateBadges(users, config, ul) {
  chain = chain
    .then(async () => {
      const user = await users.findOne({ ul });
      if (!user) return;
      for (const badge of BADGES) {
        if (badge.mode !== 'auto') continue; // derived (premium) & admin-only badges never auto-award
        if (user.awards?.[badge.id]) continue; // already held
        if (!(await badge.eligible(user, { users, config }))) continue;
        const holders = await users.countDocuments({ [`awards.${badge.id}`]: { $exists: true } });
        if (holders >= badge.capOf(config)) continue; // hard cap (belt to eligible's braces)
        const now = new Date().toISOString();
        // award = unique GRANT (gid): revoking and re-awarding later must
        // re-dispatch, so seen-acks key on gid, not badge id
        await users.updateOne({ ul }, { $set: { [`awards.${badge.id}`]: { at: now, gid: randomUUID() } } });
        user.awards = { ...(user.awards ?? {}), [badge.id]: now };
      }
    })
    .catch((err) => console.error('[badges] evaluation failed:', err?.message ?? err));
  return chain;
}

// Shared admin snapshot: definitions + live holders per badge.
export async function badgeOverview(users, config) {
  const rows = [];
  for (const badge of BADGES) {
    const cap = badge.capOf(config);
    const holders = badge.mode === 'derived'
      ? await users.countDocuments({ premium: true })
      : await users.countDocuments({ [`awards.${badge.id}`]: { $exists: true } });
    rows.push({
      id: badge.id,
      label: badge.label,
      blurb: badge.blurb,
      score: badge.scoreOf(config),
      cap,
      holders,
      full: cap !== null && holders >= cap,
      mode: badge.mode,
      awardable: badge.mode !== 'derived',
      auto: badge.mode === 'auto',
    });
  }
  return rows;
}
