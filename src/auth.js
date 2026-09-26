// Users, login, session cookie, admin-token bearer auth. SPEC §4 (Auth).

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import cookie from '@fastify/cookie';
import { nowIso } from './db.js';
import { HOME_TEAM_ID, ensureHomeTeam, isOwner, teamOf, teamRoster } from './teams.js';

const COOKIE_NAME = 'villa_session';
const MAX_AGE_DAYS = 90;
const MAX_AGE_SECONDS = MAX_AGE_DAYS * 24 * 60 * 60;
const BCRYPT_COST = 10;
// An issue time below this is a pre-2026-09-26 cookie in whole seconds (1e11 s is the
// year 5138; 1e11 ms was 1973), so both formats stay readable.
const LEGACY_SECONDS_BELOW = 1e11;

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
  return {
    id: row.id, email: row.email, name: row.name,
    team_id: row.team_id ?? HOME_TEAM_ID, role: row.role || 'member',
    ...extra,
  };
}

export function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_COST);
}

/**
 * Adds one person (the People page, tests). Emails are stored trimmed and lower-cased,
 * the form login looks up first. Throws on a duplicate email (UNIQUE). Returns the id.
 */
export function createUser(db, { email, name, password, team_id, role = 'member' }) {
  // No team would read as the home team (teams.js `teamIdOf`): never create one that way.
  if (!Number.isInteger(team_id)) throw new Error('createUser needs an integer team_id');
  const info = db
    .prepare('INSERT INTO users (email, name, password_hash, created_at, team_id, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(email).trim().toLowerCase(), String(name).trim(), hashPassword(password), nowIso(), team_id, role);
  return Number(info.lastInsertRowid);
}

/** Every session cookie issued for this person before now stops working. */
export function voidSessions(db, userId) {
  db.prepare('UPDATE users SET session_epoch = ? WHERE id = ?').run(nowIso(), userId);
}

/**
 * Create or update the two owners from the environment (SPEC §17: everyone else is
 * added from the People page). Both are owners of the home team, every boot. The env is
 * the only source of owner power: a rotated password ends the old sessions, and an owner
 * row whose email has left the env is demoted, disabled and signed out.
 * A user whose vars are missing is skipped; if neither is present we throw.
 */
export function seedUsers(db, env = process.env) {
  const wanted = [1, 2]
    .map((n) => ({
      // Stored lower-case, the way login and the People page look emails up.
      email: env[`USER${n}_EMAIL`] ? String(env[`USER${n}_EMAIL`]).trim().toLowerCase() : '',
      name: env[`USER${n}_NAME`] || env[`USER${n}_EMAIL`],
      password: env[`USER${n}_PASSWORD`],
    }))
    .filter((u) => u.email && u.password);

  if (wanted.length === 0) {
    throw new Error('No users configured: set USER1_EMAIL and USER1_PASSWORD (and USER2_* for the second person).');
  }

  ensureHomeTeam(db, wanted.map((u) => u.name).join(' & '));
  const find = db.prepare('SELECT * FROM users WHERE lower(email) = ?');
  const insert = db.prepare(
    "INSERT INTO users (email, name, password_hash, created_at, team_id, role) VALUES (?, ?, ?, ?, ?, 'owner')"
  );
  const update = db.prepare('UPDATE users SET email = ?, name = ?, password_hash = ? WHERE id = ?');
  const makeOwner = db.prepare("UPDATE users SET team_id = ?, role = 'owner', disabled_at = NULL WHERE id = ?");

  const seeded = [];
  for (const u of wanted) {
    const existing = find.get(u.email);
    if (!existing) {
      const info = insert.run(u.email, u.name, hashPassword(u.password), nowIso(), HOME_TEAM_ID);
      seeded.push({ id: Number(info.lastInsertRowid), email: u.email, created: true });
      continue;
    }
    if (existing.team_id !== HOME_TEAM_ID || existing.role !== 'owner' || existing.disabled_at) makeOwner.run(HOME_TEAM_ID, existing.id);
    const passwordChanged = !bcrypt.compareSync(u.password, existing.password_hash);
    const changed = passwordChanged || existing.name !== u.name || existing.email !== u.email;
    if (changed) {
      update.run(u.email, u.name, passwordChanged ? hashPassword(u.password) : existing.password_hash, existing.id);
    }
    if (passwordChanged) voidSessions(db, existing.id);
    seeded.push({ id: existing.id, email: u.email, created: false, updated: changed });
  }

  // An owner the env no longer names keeps their rows (they carry `by`) but loses the
  // power: member, disabled, every cookie void.
  const keep = seeded.map((s) => s.id);
  const stale = db
    .prepare(`SELECT id FROM users WHERE role = 'owner' AND id NOT IN (${keep.map(() => '?').join(', ')})`)
    .all(...keep);
  for (const { id } of stale) {
    db.prepare("UPDATE users SET role = 'member', disabled_at = COALESCE(disabled_at, ?) WHERE id = ?").run(nowIso(), id);
    voidSessions(db, id);
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
  const getUserByEmail = db.prepare('SELECT * FROM users WHERE lower(email) = ?');
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

  // Failed logins per account as well: behind Cloudflare + Traefik the client IP is only
  // as good as the forwarded header, and friends' passwords are short. A success clears it.
  const failures = new Map(); // lower-cased email -> { count, resetAt }
  function accountLocked(email) {
    const entry = failures.get(email);
    if (entry && entry.resetAt <= Date.now()) failures.delete(email);
    return (failures.get(email)?.count || 0) >= RATE_LIMIT_MAX;
  }
  function recordFailure(email) {
    const entry = failures.get(email) || { count: 0, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS };
    entry.count += 1;
    failures.set(email, entry);
  }

  function userFromCookie(request) {
    const raw = request.cookies?.[COOKIE_NAME];
    if (!raw) return null;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return null;
    const [idPart, issuedPart] = String(unsigned.value).split('.');
    const id = Number(idPart);
    const issued = Number(issuedPart);
    if (!Number.isInteger(id) || !Number.isFinite(issued)) return null;
    // Cookies carry milliseconds since 2026-09-26; ones issued before that carry seconds.
    const issuedMs = issued > LEGACY_SECONDS_BELOW ? issued : issued * 1000;
    if (Date.now() - issuedMs > MAX_AGE_SECONDS * 1000) return null;
    const row = getUser.get(id);
    if (!row || row.disabled_at) return null;
    // A password reset or a disable voids every cookie issued before it — a tie too; a
    // real login after a reset is tens of ms later (bcrypt runs before the cookie is set).
    if (row.session_epoch && issuedMs <= Date.parse(row.session_epoch)) return null;
    return publicUser(row);
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

  // SPEC §17: running the scraper, importing, merging, editing the brief or a listing's
  // facts and managing people are the owners' — a friend's tap never moves what the
  // owners (or another team) see.
  app.decorate('requireOwner', async function requireOwner(request, reply) {
    const user = resolveUser(request);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    if (!isOwner(user)) return reply.code(403).send({ error: 'owners_only' });
    request.user = user;
  });

  function setSession(reply, userId) {
    // Milliseconds, so a password reset voids a cookie issued in the same second before it.
    const value = `${userId}.${Date.now()}`;
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
    const normEmail = email.trim().toLowerCase();
    if (accountLocked(normEmail)) return reply.code(429).send({ error: 'too_many_attempts' });
    const row = getUserByEmail.get(normEmail);
    const ok = bcrypt.compareSync(password, row ? row.password_hash : DUMMY_HASH);
    if (!row || !ok || row.disabled_at) {
      recordFailure(normEmail);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    failures.delete(normEmail);
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
    // The roster (names only, the caller's team) lets the UI say "Waiting for Abigaïl"
    // instead of "the other". A team of one is `solo`: the UI hides everything shared.
    const users = teamRoster(db, user);
    const team = teamOf(db, user);
    return { user, users, team: { ...team, solo: users.length <= 1 } };
  });

  return app;
}

export const SESSION_COOKIE = COOKIE_NAME;
