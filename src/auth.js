// Users, login, session cookie, admin-token bearer auth. SPEC §4 (Auth).

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import cookie from '@fastify/cookie';
import { nowIso } from './db.js';

const COOKIE_NAME = 'villa_session';
const MAX_AGE_DAYS = 90;
const MAX_AGE_SECONDS = MAX_AGE_DAYS * 24 * 60 * 60;
const BCRYPT_COST = 10;

// Login rate limit: 10 attempts per IP per 15 minutes.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

// Burned on unknown emails so a miss costs the same as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

/** Equal-cost string compare (hashes first so unequal lengths stay safe). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function publicUser(row, extra = {}) {
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, ...extra };
}

/**
 * Create or update the two people from the environment.
 * A user whose vars are missing is skipped; if neither is present we throw.
 */
export function seedUsers(db, env = process.env) {
  const wanted = [1, 2]
    .map((n) => ({
      email: env[`USER${n}_EMAIL`],
      name: env[`USER${n}_NAME`] || env[`USER${n}_EMAIL`],
      password: env[`USER${n}_PASSWORD`],
    }))
    .filter((u) => u.email && u.password);

  if (wanted.length === 0) {
    throw new Error('No users configured: set USER1_EMAIL and USER1_PASSWORD (and USER2_* for the second person).');
  }

  const find = db.prepare('SELECT * FROM users WHERE email = ?');
  const insert = db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)');
  const update = db.prepare('UPDATE users SET name = ?, password_hash = ? WHERE id = ?');

  const seeded = [];
  for (const u of wanted) {
    const existing = find.get(u.email);
    if (!existing) {
      const info = insert.run(u.email, u.name, bcrypt.hashSync(u.password, BCRYPT_COST), nowIso());
      seeded.push({ id: Number(info.lastInsertRowid), email: u.email, created: true });
      continue;
    }
    const passwordChanged = !bcrypt.compareSync(u.password, existing.password_hash);
    const nameChanged = existing.name !== u.name;
    if (passwordChanged || nameChanged) {
      update.run(u.name, passwordChanged ? bcrypt.hashSync(u.password, BCRYPT_COST) : existing.password_hash, existing.id);
    }
    seeded.push({ id: existing.id, email: u.email, created: false, updated: passwordChanged || nameChanged });
  }
  return seeded;
}

/**
 * Registers cookie support, the auth routes, and the `requireUser` preHandler.
 * Called on the root instance so the decorators are visible app-wide.
 */
export async function registerAuth(app, db, env = process.env) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is required');

  await app.register(cookie, { secret: env.SESSION_SECRET });

  const secure = env.NODE_ENV === 'production';
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    signed: true,
    maxAge: MAX_AGE_SECONDS,
  };

  const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const getUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const firstUser = () => db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get();

  const attempts = new Map(); // ip -> { count, resetAt }
  function rateLimited(ip) {
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.resetAt <= now) attempts.delete(key);
    const entry = attempts.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    entry.count += 1;
    attempts.set(ip, entry);
    return entry.count > RATE_LIMIT_MAX;
  }

  function userFromCookie(request) {
    const raw = request.cookies?.[COOKIE_NAME];
    if (!raw) return null;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return null;
    const [idPart, issuedPart] = String(unsigned.value).split('.');
    const id = Number(idPart);
    const issuedAt = Number(issuedPart);
    if (!Number.isInteger(id) || !Number.isFinite(issuedAt)) return null;
    if (Date.now() - issuedAt * 1000 > MAX_AGE_SECONDS * 1000) return null;
    return publicUser(getUser.get(id));
  }

  function userFromBearer(request) {
    const header = request.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    if (!env.ADMIN_TOKEN || !safeEqual(token, env.ADMIN_TOKEN)) return null;
    const row = getUser.get(1) || firstUser();
    return publicUser(row, { via: 'admin_token' });
  }

  /** Resolve request.user from the session cookie or an admin bearer token. */
  function resolveUser(request) {
    return userFromCookie(request) || userFromBearer(request);
  }
  app.decorate('resolveUser', resolveUser);

  app.decorate('requireUser', async function requireUser(request, reply) {
    const user = resolveUser(request);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    request.user = user;
  });

  function setSession(reply, userId) {
    const value = `${userId}.${Math.floor(Date.now() / 1000)}`;
    reply.setCookie(COOKIE_NAME, value, cookieOptions);
  }

  app.post('/api/login', async (request, reply) => {
    if (rateLimited(request.ip)) {
      return reply.code(429).send({ error: 'too_many_attempts' });
    }
    const { email, password } = request.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const row = getUserByEmail.get(email.trim().toLowerCase()) || getUserByEmail.get(email.trim());
    const ok = bcrypt.compareSync(password, row ? row.password_hash : DUMMY_HASH);
    if (!row || !ok) return reply.code(401).send({ error: 'invalid_credentials' });
    setSession(reply, row.id);
    return { user: publicUser(row) };
  });

  app.post('/api/logout', async (request, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax', secure });
    return { ok: true };
  });

  app.get('/api/me', async (request, reply) => {
    const user = resolveUser(request);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    // The roster (names only) lets the UI say "Waiting for Abigaïl" instead of "the other".
    const users = db.prepare('SELECT id, name FROM users ORDER BY id').all();
    return { user, users };
  });

  return app;
}

export const SESSION_COOKIE = COOKIE_NAME;
