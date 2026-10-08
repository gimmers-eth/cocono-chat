import { FakeUserType } from '../base.js';

// Premium account: admin-flagged, gold-certificated everywhere (client
// sidebar, chat head, profile, admin panel) and entitled to 5 devices.
// Carries a bio so the profile surfaces have something to render around
// the badge.
export class Premium extends FakeUserType {
  static id = 'premium';
  static label = 'premium account (gold certificate, 5-device cap)';

  async make(ctx, name) {
    const acct = await ctx.account(name);
    await acct.client.setProfile({ bio: 'Supporting the platform ♥ — premium' });
    await ctx.admin('PUT', `/api/admin/users/${acct.ul}/premium`, { premium: true });
    return acct;
  }
}
