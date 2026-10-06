import { rateLimit } from '../../lib/rateLimit.js';
import { limited } from '../shared.js';

// Public branding: the display name of the app. Editable in the admin panel
// (persisted in the `settings` collection, `{_id:'branding', appName}`) and
// falling back to the APP_NAME env default. The FE fetches this on boot and
// rewrites every [data-app-name] element + document.title.
export async function resolveAppName(settings, config) {
  const doc = await settings.findOne({ _id: 'branding' });
  return doc?.appName || config.appName;
}

export default async function appInfoRoutes(app, { redis, config, settings }) {
  // Tiny static-ish payload, but rate limit lightly: anonymous Mongo reads
  // should not become a free amplification vector.
  app.get('/api/app-info', async (request, reply) => {
    const rl = await rateLimit(redis, `rl:appinfo:${request.ip}`, 120, 600);
    if (!rl.ok) return limited(reply, rl);
    return { name: await resolveAppName(settings, config), vapidPublicKey: config.vapidPublicKey || null };
  });
}
