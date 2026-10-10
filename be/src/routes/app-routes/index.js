import signup from './signup.js';
import auth from './auth.js';
import me from './me.js';
import friends from './friends.js';
import devices from './devices.js';
import userKeys from './userKeys.js';
import userStats from './userStats.js';
import profile from './profile.js';
import diagnostics from './diagnostics.js';
import reports from './reports.js';
import appInfo from './appInfo.js';
import shares from './shares.js';

// All public app routes. ctx = { users, redis, config, diagnostics, reports,
// settings }, passed through from buildApp().
export default async function appRoutes(app, ctx) {
  await app.register(signup, ctx);
  await app.register(auth, ctx);
  await app.register(me, ctx);
  await app.register(friends, ctx);
  await app.register(devices, ctx);
  await app.register(userKeys, ctx);
  await app.register(userStats, ctx);
  await app.register(profile, ctx);
  await app.register(diagnostics, ctx);
  await app.register(reports, ctx);
  await app.register(shares, ctx);
  await app.register(appInfo, ctx);
}
