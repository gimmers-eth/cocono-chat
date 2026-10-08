#!/usr/bin/env node
// cocono-chat devbox: generate FAKE USERS with realistic state for the admin
// panel and the traffic views — via the REAL SDK/API (legit E2EE accounts,
// friendships, messages, diagnostics), keys in memory only, gone on exit.
//
//   ./ops/fake-users.sh [--count N] [--types a,b] [--fresh] [--keep-limits]
//                       [--url https://dev.co.co.no] [--admin http://127.0.0.1:3001]
//
//   --count N    users per scenario (default 3; friendly rounds = ceil(N/2) pairs)
//   --types      comma list of scenario ids to run (default: all, ≥1 of each)
//   --fresh      delete existing fake accounts (prefix-N) before generating
//   --keep-limits  do not touch the server-wide kill switch (NOT recommended
//                  while blasting bulk traffic — the guards will bite)
//
// Unless --keep-limits, the run flips the server-wide rate-limit kill switch
// OFF for its duration and back ON afterwards (settings {_id:'traffic'} via
// the admin API), so bulk traffic can't trip the very limits we're demoing.
// Every scenario type lives in types/<id>.js extending FakeUserType — add one
// there + TYPES below.

import { config } from '../../be/src/config.js';
import { connectMongo, connectRedis } from '../../be/src/db.js';
import { makeCtx } from './helpers.mjs';
import { Normal } from './types/normal.js';
import { Verified } from './types/verified.js';
import { Diagnostic } from './types/diagnostic.js';
import { Ratelimited } from './types/ratelimited.js';
import { IPRatelimited } from './types/ipratelimited.js';
import { IpFlapper } from './types/ipflapper.js';
import { Friendly } from './types/friendly.js';
import { Premium } from './types/premium.js';

const TYPES = [Normal, Verified, Premium, Friendly, Diagnostic, Ratelimited, IPRatelimited, IpFlapper];

function parseArgs(argv) {
  const args = { count: 3, types: null, fresh: false, keepLimits: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--count') args.count = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === '--types') args.types = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--fresh') args.fresh = true;
    else if (a === '--keep-limits') args.keepLimits = true;
    else if (a === '--url') args.baseUrl = argv[++i];
    else if (a === '--admin') args.adminUrl = argv[++i];
    else if (a === '--list') { args.list = true; }
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.list) {
  console.log('scenarios (id — what it generates):');
  for (const T of TYPES) console.log(`  ${new T().id.padEnd(14)} ${new T().label}`);
  process.exit(0);
}

const baseUrl = args.baseUrl ?? 'https://dev.co.co.no';
const adminUrl = args.adminUrl ?? `http://127.0.0.1:${config.adminPort ?? 3001}`;
const adminToken = config.adminToken ?? process.env.ADMIN_TOKEN ?? '';
if (!adminToken && !args.keepLimits) {
  console.error('ADMIN_TOKEN not found (be/.env) — cannot manage the kill switch. Pass --keep-limits to proceed anyway.');
  process.exit(2);
}

const selected = TYPES
  .map((T) => new T())
  .filter((t) => !args.types || args.types.includes(t.id));
if (!selected.length) {
  console.error(`no scenarios matched --types ${args.types.join(',')}; see --list`);
  process.exit(2);
}

const mongoConn = await connectMongo(config.mongoUrl);
const redis = await connectRedis(config.redisUrl);
const ctx = makeCtx({
  baseUrl, adminUrl, adminToken,
  mongo: mongoConn.db, redis, config,
});

const die = async (code, msg) => { if (msg) console.error(msg); try { await redis.quit(); await mongoConn.client.close(); } catch { /* bye */ } process.exit(code); };

let switchOff = false;
const stamp = () => new Date().toISOString().slice(11, 19);

try {
  if (!args.keepLimits) {
    await ctx.admin('PUT', '/api/admin/rate-limits/state', { disabled: true });
    switchOff = true;
    ctx.warn('server-wide rate limits DISABLED for this run (restored at exit)');
  }

  if (args.fresh) {
    const prefixes = [...new Set(selected.map((t) => t.prefix))].join('|');
    const doomed = await mongoConn.db.collection('users')
      .find({ ul: { $regex: `^(${prefixes})-[0-9]+$` } }, { projection: { ul: 1 } })
      .toArray();
    for (const { ul } of doomed) {
      await mongoConn.db.collection('users').deleteOne({ ul });
      await mongoConn.db.collection('messages').deleteMany({ $or: [{ 'from.ul': ul }, { 'to.ul': ul }] });
      await mongoConn.db.collection('diagnostics').deleteMany({ account: ul });
      for await (const batch of redis.scanIterator({ MATCH: `rl:*:${ul}`, COUNT: 100 })) {
        for (const k of batch) await redis.del(k);
      }
      for await (const batch of redis.scanIterator({ MATCH: `rl:*:${ul}:*`, COUNT: 100 })) {
        for (const k of batch) await redis.del(k);
      }
      for await (const batch of redis.scanIterator({ MATCH: `devip:${ul}:*`, COUNT: 100 })) {
        for (const k of batch) await redis.del(k);
      }
    }
    if (doomed.length) ctx.log(`--fresh: removed ${doomed.length} existing fake account(s)`);
  }

  ctx.log(`generating fake users → ${baseUrl} (--count ${args.count} users/type, min 1 each; friendly rounds = ceil(N/2) pairs)`);
  for (const t of selected) await t.run(ctx, args.count);
  // honest recount from the DB (scale math is per-type; let the source speak)
  const total = await mongoConn.db.collection('users').countDocuments({});
  const msgs = await mongoConn.db.collection('messages').countDocuments({});
  const diags = await mongoConn.db.collection('diagnostics').countDocuments({});
  let rlKeys = 0;
  for await (const batch of redis.scanIterator({ MATCH: 'rl:*', COUNT: 200 })) rlKeys += batch.length;

  ctx.log(`\ndone in ${stamp()} — accounts in db: ${total}, queued/saved messages: ${msgs}, diagnostics: ${diags}, live limiter keys: ${rlKeys}`);
  ctx.log(`open the admin panel: ${adminUrl} (Users to browse, Traffic → Search '${selected[0].prefix}-1, ip' to poke the limits)`);
  var failed = false;
} catch (err) {
  failed = true;
  console.error('fake-users run failed:', err?.stack ?? err);
} finally {
  if (switchOff) {
    try {
      await ctx.admin('PUT', '/api/admin/rate-limits/state', { disabled: false });
      ctx.warn('server-wide rate limits re-enabled');
    } catch (err) {
      console.error('!! could not re-enable rate limits — do it manually:', err.message);
      console.error('   PUT /api/admin/rate-limits/state {"disabled": false} (or the Traffic page toggle)');
    }
  }
  await die(failed ? 1 : 0);
}
