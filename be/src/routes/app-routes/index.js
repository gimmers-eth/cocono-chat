import signup from './signup.js';
import auth from './auth.js';
import me from './me.js';

// All public app routes. ctx = { users, redis, config }, passed through
// from buildApp().
export default async function appRoutes(app, ctx) {
  await app.register(signup, ctx);
  await app.register(auth, ctx);
  await app.register(me, ctx);
}
