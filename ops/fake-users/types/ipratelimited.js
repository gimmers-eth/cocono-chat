import { FakeUserType } from '../base.js';

// IP-scoped limits blown for the account's CURRENT egress IP: the user record
// + redis know their latest IP (as the auth hook would have written it), and
// that IP carries exhausted counters (signup/verify/diag/message-send). The
// user panel's "search rate limits" link lands straight on these rows.
export class IPRatelimited extends FakeUserType {
  static id = 'ipratelimited';
  static label = 'their IP is rate limited (TEST-NET address, live counters seeded)';

  async make(ctx, name, round) {
    const acct = await ctx.account(name);
    // 203.0.113.0/24 is a documentation range — safe to fabricate freely
    const ip = `203.0.113.${100 + round}`;
    await ctx.deviceIp(acct.ul, acct.deviceId, ip);
    const c = ctx.config;
    await ctx.seedRl(`rl:signup:${ip}`, c.signupIpLimit + 5, 140);
    await ctx.seedRl(`rl:verifyip:${ip}`, c.verifyIpLimit, 260);
    await ctx.seedRl(`rl:diag:${ip}`, c.diagIpLimit + 2, 120);
    await ctx.seedRl(`rl:msgip:${ip}`, c.msgIpLimit, 60);
    return acct;
  }
}
