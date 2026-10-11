import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { rateLimit } from '../../lib/rateLimit.js';
import { limited } from '../shared.js';
import { effectiveLimit } from '../../lib/limits.js';

// Public branding: the display name of the app. Editable in the admin panel
// (persisted in the `settings` collection, `{_id:'branding', appName}`) and
// falling back to the APP_NAME env default. The FE fetches this on boot and
// rewrites every [data-app-name] element + document.title.
// Build identity straight from git: '<sha> (<iso date>)'. With deploy == git
// pull, the commit IS the version — nothing to maintain by hand. Cached with
// a short TTL: deploys move HEAD without necessarily restarting this process
// (file-watch only sees code changes), and a 10ms git call every 30s is cheap.
// Alongside it, a plain NUMBER (`git rev-list --count HEAD`): every deploy
// bumps it, so the FE can show `v123` and ring "update available" without
// asking a human to read hashes. Null when git cannot answer (src checkout,
// weird containers) — the FE then falls back to the version string.
const VERSION_TTL_MS = 30_000;
const REPO_DIR = () => path.resolve(import.meta.dirname, '..', '..', '..', '..');
const git = (args) => execFileSync('git', ['-C', REPO_DIR(), ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let cachedVersion = null;
let cachedBuild = null;
let cachedAt = 0;
function refreshIdentity() {
  if (cachedVersion && Date.now() - cachedAt < VERSION_TTL_MS) return;
  try {
    cachedVersion = git(['log', '-1', '--format=%h (%cI)']) || 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  try {
    cachedBuild = Number(git(['rev-list', '--count', 'HEAD'])) || null;
  } catch {
    cachedBuild = null;
  }
  cachedAt = Date.now();
}
export function resolveVersion() {
  refreshIdentity();
  return cachedVersion;
}
export function resolveBuild() {
  refreshIdentity();
  return cachedBuild;
}

export async function resolveAppName(settings, config) {
  const doc = await settings.findOne({ _id: 'branding' });
  return doc?.appName || config.appName;
}

export default async function appInfoRoutes(app, { redis, config, settings }) {
  // Tiny static-ish payload, but rate limit lightly: anonymous Mongo reads
  // should not become a free amplification vector.
  app.get('/api/app-info', async (request, reply) => {
    const lim = await effectiveLimit(settings, config, 'appinfo');
    const rl = await rateLimit(redis, `rl:appinfo:${request.ip}`, lim.limit, lim.windowSec);
    if (!rl.ok) return limited(reply, rl);
    return {
      name: await resolveAppName(settings, config),
      vapidPublicKey: config.vapidPublicKey || null,
      version: resolveVersion(),
      build: resolveBuild(),
    };
  });
}
