import { FakeUserType } from '../base.js';

// Diagnostics-heavy account: a stack of signed reports (SDK) plus a couple of
// anonymous ones — fills the admin Diagnostics page with realistic variety
// (long text, storage dumps, different user agents via the anonymous route).
export class Diagnostic extends FakeUserType {
  static id = 'diagnostic';
  static label = 'a pile of diagnostics reports (signed + anonymous)';

  async make(ctx, name, round) {
    const acct = await ctx.account(name);
    const bodies = [
      `fake-user diagnostics batch 1\nURL: ${ctx.baseUrl}\nUA: fake-users/1.0 (${name})\nview: conversations\nstorage: 3 stores, 412 messages decrypted\npush: granted, subscription ok\nws: open 01:23:45, reconnects 2`,
      `fake-user diagnostics batch 2 (long one — a real device dump would look like this: `.repeat(3)
        + `\nIndexedDB cocono-app:${acct.ul}: v5, messages 1043, friends 6, pins 6, peeravatars 6\nlocalStorage keys: cocono.theme, cocono.settings.tab\nserviceWorker: controlled, cache cocono-shell-v4\npushPermission: granted\nconnection: open`,
      `fake-user diagnostics batch 3\nproblem: message stuck in 'sending'\nretry queue: 2 envelopes, cid ${round}a1b2\nserver acks: none for last 4 sends\nws state: connecting → closed (1006)`,
    ];
    for (const report of bodies) {
      await acct.client.sendDiagnostics(report);
    }
    // one anonymous (pre-login style) report too
    await ctx.anonymousDiagnostics(`fake-user anonymous report from ${name} — never even got a token, origin ${ctx.baseUrl}`);
    return acct;
  }
}
