import { FakeUserType } from '../base.js';

// The IP-FLAPPING device persona from the egress-IP tracker: its per-device
// flap budget (rl:ipflap:<ul>:<dv>) is nearly/fully spent and a latest IP is
// recorded — exactly what a roaming device looks like on the traffic page.
export class IpFlapper extends FakeUserType {
  static id = 'ipflapper';
  static label = 'device burning its IP-flap budget (per-device ip-change limiter)';

  async make(ctx, name, round) {
    const acct = await ctx.account(name);
    const ip = `198.51.100.${100 + round}`; // TEST-NET-2
    await ctx.deviceIp(acct.ul, acct.deviceId, ip);
    // spent to the limit: the next genuine IP change gets throttled
    await ctx.seedRl(
      `rl:ipflap:${acct.ul}:${acct.deviceId}`,
      ctx.config.deviceIpFlapLimit,
      260,
    );
    return acct;
  }
}
