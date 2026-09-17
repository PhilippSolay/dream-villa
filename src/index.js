// Entry point: load .env, validate, open the db, seed users, listen.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { seedUsers } from './auth.js';
import { buildServer } from './server.js';

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

  const app = await buildServer({ db, env, logger: true });
  const port = Number(env.PORT || 8080);

  const close = async () => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);

  await app.listen({ host: '0.0.0.0', port });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
