import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rateLimit } from '../../lib/rateLimit.js';
import { limited, fail } from '../shared.js';

const pexecFile = promisify(execFile);

// Ops panel backend: exposes the backup/deploy status the shell scripts
// write to ~/backups/status/*.json, lets the admin trigger backup/drill runs
// and (with a typed confirmation) a production restore. Everything here is
// protected twice: the admin scope's token gate (H1) and the scripts' shared
// flock — this API only ADDS a fast busy-check so the UI gets a clean 409
// instead of a job that silently de-bounces.
// be/src/routes/admin-routes -> repo root is FOUR levels up (routes->src->be->root).
const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const OPS = path.join(REPO, 'ops');
const BACKUP_DIR = path.join(process.env.HOME ?? '/root', 'backups');
const LOCK = path.join(BACKUP_DIR, '.ops.lock');
const STATUS_DIR = path.join(BACKUP_DIR, 'status');
const JOBS = {
  hourly: ['backup.sh', ['hourly']],
  daily: ['backup.sh', ['daily']],
  drill: ['backup-drill.sh', []],
};
// backup.sh stamp: 20261007T070743Z
const ARCHIVE_RE = /^cocono-hourly-\d{8}T\d{6}Z\.tar\.age$/;

async function readStatus(name) {
  try {
    return JSON.parse(await fs.readFile(path.join(STATUS_DIR, `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function listArchives(dir, filter) {
  try {
    const names = await fs.readdir(path.join(BACKUP_DIR, dir));
    const out = [];
    for (const name of names) {
      if (!filter(name)) continue;
      const s = await fs.stat(path.join(BACKUP_DIR, dir, name));
      out.push({ name, bytes: s.size, mtime: s.mtime.toISOString() });
    }
    return out.sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, 30);
  } catch {
    return [];
  }
}

export default async function adminOpsRoutes(app, { redis }) {
  const gate = async (request, reply, name, limit) => {
    const rl = await rateLimit(redis, `rl:adminops:${name}:${request.ip}`, limit, 3600);
    return rl.ok ? null : limited(reply, rl);
  };

  // Is an ops script holding the lock right now? (flock -n exits 1 if busy)
  const lockBusy = async () => {
    try {
      await pexecFile('flock', ['-n', LOCK, 'true']);
      return false;
    } catch {
      return true;
    }
  };

  app.get('/api/admin/ops', async (request, reply) => {
    const denied = await gate(request, reply, 'list', 1200);
    if (denied) return denied;
    const [hourly, daily, drill, restore, update] = await Promise.all(
      ['hourly', 'daily', 'drill', 'restore', 'update'].map(readStatus),
    );
    let running = null;
    try {
      running = (await fs.readFile(path.join(BACKUP_DIR, '.ops.pid'), 'utf8')).trim();
    } catch { /* not running */ }
    let logs = [];
    try {
      logs = (await fs.readFile(path.join(BACKUP_DIR, 'backup.log'), 'utf8')).split('\n').filter(Boolean).slice(-40);
    } catch { /* no log yet */ }
    return {
      running: Boolean(running) || (await lockBusy()),
      pidInfo: running,
      statuses: { hourly, daily, drill, restore, update },
      logs,
      hourlyArchives: await listArchives('hourly', (n) => ARCHIVE_RE.test(n)),
      dailyArchives: await listArchives('daily', (n) => n.endsWith('.tar.age')),
    };
  });

  app.post('/api/admin/ops/run', async (request, reply) => {
    const denied = await gate(request, reply, 'run', 60);
    if (denied) return denied;
    const job = request.body?.job;
    if (!JOBS[job]) return fail(reply, 'bad_job', 'unknown job (hourly|daily|drill)', 400);
    if (await lockBusy()) return fail(reply, 'busy', 'another ops run is active', 409);
    const args = [...JOBS[job][1]];
    // The drill tests a SPECIFIC archive when one is selected (validated to
    // our hourly naming + existence); with none, backup-drill.sh takes the
    // newest hourly by itself.
    if (job === 'drill' && request.body?.archive) {
      const name = String(request.body.archive);
      if (!ARCHIVE_RE.test(name)) return fail(reply, 'bad_archive', 'not a valid hourly archive name', 400);
      try {
        await fs.stat(path.join(BACKUP_DIR, 'hourly', name));
      } catch {
        return fail(reply, 'unknown_archive', 'archive not found in ~/backups/hourly', 404);
      }
      args.push(path.join(BACKUP_DIR, 'hourly', name));
    }
    const child = spawn('bash', [path.join(OPS, JOBS[job][0]), ...args], {
      cwd: REPO, stdio: 'ignore', detached: true,
    });
    child.on('error', () => { /* surfaces as a missing status file next refresh */ });
    child.unref(); // fire-and-forget: drills can outlive any single request
    return { started: job };
  });

  app.post('/api/admin/ops/restore', async (request, reply) => {
    const denied = await gate(request, reply, 'restore', 10);
    if (denied) return denied;
    const { archive, confirm } = request.body ?? {};
    if (typeof archive !== 'string' || !ARCHIVE_RE.test(archive)) {
      return fail(reply, 'bad_archive', 'not a valid hourly archive name', 400);
    }
    if (confirm !== 'RESTORE') {
      return fail(reply, 'confirmation_required', "type RESTORE in the confirm field", 400);
    }
    if (await lockBusy()) return fail(reply, 'busy', 'another ops run is active', 409);
    try {
      await fs.stat(path.join(BACKUP_DIR, 'hourly', archive));
    } catch {
      return fail(reply, 'unknown_archive', 'archive not found in ~/backups/hourly', 404);
    }
    const child = spawn('bash', [path.join(OPS, 'restore.sh'), path.join(BACKUP_DIR, 'hourly', archive), '--yes'], {
      cwd: REPO, stdio: 'ignore', detached: true,
    });
    child.on('error', () => {});
    child.unref();
    return { restoring: archive, note: 'services bounce; watch status/restore.json' };
  });
}
