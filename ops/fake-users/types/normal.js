import { FakeUserType } from '../base.js';

// A plain account: registered, a bio, some self-chat history. The control
// group — everything that is NOT a special scenario should look like this.
export class Normal extends FakeUserType {
  static id = 'normal';
  static label = 'everyday account, bio + a few self-chat messages';

  async make(ctx, name) {
    const acct = await ctx.account(name);
    await acct.client.setProfile({ bio: `Just here chatting — ${name}` });
    await acct.client.connect();
    await ctx.open(acct.client);
    await acct.client.sendMessage(acct.ul, `first note to self for ${name}`);
    await acct.client.sendMessage(acct.ul, 'reminder: verify a friend’s safety number sometime');
    await new Promise((r) => setTimeout(r, 250)); // let acks land before exit
    ctx.goodbye(acct.client);
    return acct;
  }
}
