import { fail } from '../shared.js';

// Branding: read/write the app's display name. Empty/absent override falls
// back to the APP_NAME env default; PATCH with appName:'' clears the
// override (reset to default).
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;

export default async function brandingRoutes(app, { config, settings }) {
  app.get('/api/admin/branding', async () => {
    const doc = await settings.findOne({ _id: 'branding' });
    return { appName: doc?.appName ?? null, defaultName: config.appName };
  });

  app.patch('/api/admin/branding', async (request, reply) => {
    const raw = typeof request.body?.appName === 'string' ? request.body.appName.trim() : '';
    if (raw && !NAME_RE.test(raw)) {
      return fail(reply, 'invalid_name', 'App name must be 1-40 chars: letters, digits, space, . _ -', 400);
    }
    if (raw) {
      await settings.updateOne(
        { _id: 'branding' },
        { $set: { appName: raw, updatedAt: new Date() } },
        { upsert: true },
      );
    } else {
      await settings.deleteOne({ _id: 'branding' });
    }
    return { appName: raw || null, effective: raw || config.appName };
  });
}
