import { FakeUserType } from '../base.js';

// The IP-FLAPPING device persona from the egress-IP tracker: its per-device
// flap budget (rl:ipflap:<ul>:<dv>) is BLOWN — seeded past the current cap
// (default 20 changes / 5 min, tunable in Traffic → Tune and per device in
// the user panel) — and a latest IP is recorded. The next genuine IP change
// from this device genuinely 429s, and the user panel's device row lights up
// the BLOCKED meter.
export class IpFlapper extends FakeUserType {
  static id = 'ipflapper';
  static label = 'device over its IP-change budget (blocked meter, live 429s)';

  async make(ctx, name, round) {
    const acct = await ctx.account(name);
    const ip = `198.51.100.${100 + round}`; // TEST-NET-2
    await ctx.deviceIp(acct.ul, acct.deviceId, ip);
    // over the cap (budget + 4): the sidebar meter reads e.g. '24/20 — BLOCKED'
    await ctx.seedRl(
      `rl:ipflap:${acct.ul}:${acct.deviceId}`,
      ctx.config.deviceIpFlapLimit + 4,
      260,
    );
    return acct;
  }
}
