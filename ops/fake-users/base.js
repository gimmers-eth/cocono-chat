// FakeUserType — the base class every fake-user scenario extends.
//
// A type is a persona with a username prefix and a `make()` that produces
// ONE user of that persona (account + scenario-specific state). The base
// handles the mechanics: sequential names (`<prefix>-1`, `<prefix>-2`, …),
// per-user error isolation (one failed persona never aborts the run), and
// counting (`min` guarantees at least one of every scenario regardless of
// --count). Pairwise/social personas (friendly) override run() entirely.
//
// ctx services available to make():
//   ctx.account(name)      → { ul, client, deviceId }   real SDK signup
//   ctx.admin(method, path, body)                       admin API (token)
//   ctx.seedRl(key, count, ttlSec)                      plant a rate-limit counter
//   ctx.deviceIp(ul, dv, ip)                            latest-IP + devip keys
//   ctx.log / ctx.warn / ctx.fail                       output
//   ctx.msgsPerUser                                     1..N message budget hint
//
// To add a scenario: drop a class file in types/ and register it in
// index.mjs TYPES. Nothing else touches it.

export class FakeUserType {
  static id = null;     // subdir name / --types selector
  static prefix = null; // username prefix; defaults to id
  static label = null;  // human description for --list
  static min = 1;       // always generate at least this many (pairs count as one round)
  static scale = 1;     // users generated per --count unit (friendly = 2)

  get ctor() { return this.constructor; }
  get id() { return this.ctor.id; }
  get prefix() { return this.ctor.prefix ?? this.ctor.id; }
  get label() { return this.ctor.label ?? this.ctor.id; }
  get min() { return this.ctor.min; }
  get scale() { return this.ctor.scale; }

  name(round) { return `${this.prefix}-${round}`; }

  // One round of this persona. Override in the subclass.
  async make(_ctx, _name, _round) {
    throw new Error(`${this.id}: make() not implemented`);
  }

  // Rounds for a requested --count (users), respecting min + scale.
  rounds(count) {
    return Math.max(1, Math.ceil((count ?? 0) / this.scale), Math.ceil(this.min / this.scale));
  }

  // Generate every round; returns a summary. Subclasses may override (pairs).
  async run(ctx, count) {
    const total = this.rounds(count);
    const made = [];
    for (let i = 1; i <= total; i++) {
      const name = this.name(i * this.scale); // first member's name for the label
      try {
        const rec = await this.make(ctx, name, i);
        if (rec) made.push(rec);
        ctx.log(`  ${this.id.padEnd(14)} ${name} ✓`);
      } catch (err) {
        ctx.fail(`  ${this.id.padEnd(14)} ${name} ✗ ${err?.message ?? String(err)}`);
      }
    }
    return { type: this.id, made: made.length };
  }
}
