import { FakeUserType } from '../base.js';

// Identity-verified via the ADMIN toggle (the flag users wait on), with the
// verifiedAt stamp — exercises the verified badge paths everywhere it shows.
export class Verified extends FakeUserType {
  static id = 'verified';
  static label = 'admin identity-verified account (verified flag + verifiedAt)';

  async make(ctx, name) {
    const acct = await ctx.account(name);
    await acct.client.setProfile({ bio: 'ID checked by the admin ✓' });
    await ctx.admin('PUT', `/api/admin/users/${acct.ul}/verified`, { verified: true });
    return acct;
  }
}
