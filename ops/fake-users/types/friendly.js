import { FakeUserType } from '../base.js';

// Social scenarios: a PAIR of accounts that really bond — mutual adds over
// the API, the verify/trust stages, and live E2EE messages over the socket.
// Each round consumes two --count units (scale 2) and rotates through the
// trust-ladder rungs so the sidebar/traffic views show every state:
//   round %3 == 1 → fully bonded: mutual add + verify + trust
//   round %3 == 2 → verified, not trusted
//   round %3 == 0 → mutual add only (the unverified orange tier)
export class Friendly extends FakeUserType {
  static id = 'friendly';
  static prefix = 'friendly';
  static label = 'pairs that add / verify / trust each other with real chat traffic';
  static scale = 2;

  async make(ctx, _name, round) {
    const a = await ctx.account(this.name(2 * round - 1));
    const b = await ctx.account(this.name(2 * round));
    const rung = round % 3;
    await ctx.bond(a, b, {
      verify: rung !== 0,
      trust: rung === 1,
      messages: 3,
    });
    ctx.goodbye(a.client, b.client);
    return [a, b];
  }
}
