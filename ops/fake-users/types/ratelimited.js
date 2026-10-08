import { FakeUserType } from '../base.js';

// Account-scoped limiters already blown: the counters are seeded to (and
// past) their caps with live TTLs, so the NEXT real action from this account
// genuinely 429s — and the admin traffic search shows honest numbers.
export class Ratelimited extends FakeUserType {
  static id = 'ratelimited';
  static label = 'account-scoped rate limits exhausted (msg/diag/verify)';

  async make(ctx, name) {
    const acct = await ctx.account(name);
    const c = ctx.config;
    await ctx.seedRl(`rl:msg:${acct.ul}`, c.msgAccountLimit + 3, 220);
    await ctx.seedRl(`rl:diagacct:${acct.ul}`, c.diagAccountLimit, 80_000);
    await ctx.seedRl(`rl:verify:${acct.ul}`, c.verifyAccountLimit - 1, 380);
    await ctx.seedRl(`rl:profile:${acct.ul}`, c.profileEditAccountLimit, 2000);
    return acct;
  }
}
