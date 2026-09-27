// Entry point: load .env, validate, open the db, seed users, listen.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { seedUsers } from './auth.js';
import { buildServer } from './server.js';
import { scheduleScrape } from './scrape/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_ENV = ['SESSION_SECRET', 'ADMIN_TOKEN', 'AGENT_TOKEN', 'USER1_EMAIL', 'USER1_PASSWORD'];

/** Minimal .env reader: KEY=value, # comments, optional quotes. Never overrides a real env var. */
export function loadEnvFile(file = path.join(ROOT, '.env'), env = process.env) {
  if (!fs.existsSync(file)) return env;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

export function assertEnv(env = process.env) {
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill them in (openssl rand -hex 32 for the secrets).'
    );
  }
}

export async function main() {
  loadEnvFile();
  try {
    assertEnv();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const env = process.env;
  const db = openDb(env.DB_PATH || path.join(ROOT, 'data/villa.db'));
  seedUsers(db, env);

  // Scrape, import and backup jobs each run in a child process of their own (src/jobs).
  const app = await buildServer({ db, env, logger: true, jobs: { mode: 'fork' } });
  const port = Number(env.PORT || 8080);

  let task = null;
  const close = async () => {
    if (task) await task.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);

  await app.listen({ host: '0.0.0.0', port });

  // A migration that moves the brief leaves every scope and fit_score stale (db.js). The
  // rescore runs in a worker once the port is open, instead of holding it shut.
  if (db.migrationsApplied?.length) {
    app.jobs
      .run('rescore')
      .then((n) =>
        app.log.info(
          `migrations ${db.migrationsApplied.join(', ')} — rescored ${n.total}: ${n.in_filter} in filter, ${n.flagged} flagged`
        )
      )
      .catch((err) => app.log.error({ err }, 'post-migration rescore failed'));
  }

  // SPEC §6 (06:00 Asia/Makassar scrape) + §9 (nightly backup, same tick).
  task = scheduleScrape(db, {
    jobs: app.jobs,
    cron: env.SCRAPE_CRON || undefined,
    tz: env.TZ || undefined,
    backupDir: env.BACKUP_DIR || path.join(ROOT, 'data/backups'),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
