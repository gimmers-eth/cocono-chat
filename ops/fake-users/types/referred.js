import { FakeUserType } from '../base.js';

// Referral scenarios — the data the admin God View graph draws.
//
// Each round adds ONE account that arrived through an EARLIER account's share
// link (`/?chat=<name>`), so the run grows a real created-from tree instead of
// a flat pile: round 1 is the root (organic), every later round picks a parent
// from the pool, biasing toward the earlier generations so the tree gets
// depth (generations 0/1/2/…) rather than one flat star.
//
// On top of the created edges every child also:
//   • opens ANOTHER member's link with an account that already exists →
//     the dotted "seen" edge, and
//   • exchanges a couple of live E2EE messages with its parent →
//     the dashed "messaged" edge.
//
// All three are produced through the real SDK/API, so the graph you look at
// afterwards is made of exactly the records production would have written.
export class Referred extends FakeUserType {
  static id = 'referred';
  static label = 'a share-link referral tree: created-from + seen + messaged edges (God View)';

  constructor() {
    super();
    this.pool = []; // accounts created so far, oldest first
  }

  /** Pick a parent: 60% from the first half of the pool (depth), else random. */
  pickParent() {
    const n = this.pool.length;
    if (!n) return null;
    if (n === 1) return this.pool[0];
    const biased = Math.random() < 0.6;
    const from = biased ? this.pool.slice(0, Math.max(1, Math.ceil(n / 2))) : this.pool;
    return from[Math.floor(Math.random() * from.length)];
  }

  async make(ctx, name, round) {
    const parent = round === 1 ? null : this.pickParent();
    const acct = await ctx.account(name, { referrer: parent?.ul ?? null });
    this.pool.push(acct);
    // bios are public to mutual friends; the referral is the interesting bit
    await acct.client
      .setProfile({ bio: `${name} — joined${parent ? ` from @${parent.ul}’s link` : ' first'}` })
      .catch((err) => ctx.warn(`  ${this.id}: bio for ${name} failed (${err?.message ?? err})`));

    // a SEEN edge: an existing account opening somebody else's link. Reported
    // through the SDK exactly like the app does after a session opens.
    const others = this.pool.filter((p) => p.ul !== acct.ul);
    if (others.length) {
      const target = others[Math.floor(Math.random() * others.length)];
      const res = await acct.client.reportShareHit(target.ul);
      if (!res.ok) ctx.warn(`  ${this.id}: seen edge to @${target.ul} not recorded (${res.error})`);
    }

    // a MESSEDGED edge: real E2EE traffic between the child and its parent
    if (parent) {
      await ctx.bond(acct, parent, { verify: round % 2 === 0, messages: 2 });
    } else {
      await acct.client.connect();
      await ctx.open(acct.client);
      await acct.client.sendMessage(acct.ul, `${name}: first note to self`);
    }
    ctx.goodbye(acct.client);
    return acct;
  }

  // The pool is per-run state: a second run in the same process (or a
  // --fresh re-run) must not hand out parents from a previous tree.
  async run(ctx, count) {
    this.pool = [];
    return super.run(ctx, count);
  }
}
