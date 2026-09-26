import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { seedUsers, SESSION_COOKIE } from '../src/auth.js';
import { buildServer } from '../src/server.js';

const ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
  AGENT_TOKEN: 'test-agent-token-0123456789abcdef',
  USER1_EMAIL: 'philipp@example.com',
  USER1_NAME: 'Philipp',
  USER1_PASSWORD: 'correct horse battery staple',
  USER2_EMAIL: 'abigail@example.com',
  USER2_NAME: 'Abigail',
  USER2_PASSWORD: 'another long passphrase',
};

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-auth-'));
  return openDb(path.join(dir, 'villa.db'));
}

test('seedUsers creates both people and is idempotent', () => {
  const db = tmpDb();
  seedUsers(db, ENV);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  const before = db.prepare('SELECT * FROM users ORDER BY id').all();

  seedUsers(db, ENV);
  const after = db.prepare('SELECT * FROM users ORDER BY id').all();
  assert.equal(after.length, 2);
  assert.deepEqual(after.map((u) => u.id), before.map((u) => u.id));
  assert.deepEqual(after.map((u) => u.password_hash), before.map((u) => u.password_hash), 'unchanged password must not re-hash');
  assert.equal(after[0].name, 'Philipp');
  db.close();
});

test('seedUsers updates a changed name and throws when nothing is configured', () => {
  const db = tmpDb();
  seedUsers(db, ENV);
  seedUsers(db, { ...ENV, USER1_NAME: 'Philipp S' });
  assert.equal(db.prepare('SELECT name FROM users WHERE id = 1').get().name, 'Philipp S');
  assert.throws(() => seedUsers(db, {}), /No users configured/);
  db.close();
});

test('seedUsers skips a user whose vars are missing', () => {
  const db = tmpDb();
  seedUsers(db, { ...ENV, USER2_EMAIL: undefined, USER2_PASSWORD: undefined });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  db.close();
});

test('http: health, login, session, bearer token, logout', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const health = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200);
  assert.deepEqual({ ok: health.json().ok, db: health.json().db }, { ok: true, db: true });

  const anon = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(anon.statusCode, 401);
  assert.equal(anon.json().error, 'unauthenticated');

  const bad = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email: ENV.USER1_EMAIL, password: 'wrong' },
  });
  assert.equal(bad.statusCode, 401);
  assert.deepEqual(bad.json(), { error: 'invalid_credentials' });

  const unknown = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email: 'nobody@example.com', password: 'wrong' },
  });
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(unknown.json(), { error: 'invalid_credentials' }, 'no user enumeration');

  const good = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email: ENV.USER1_EMAIL, password: ENV.USER1_PASSWORD },
  });
  assert.equal(good.statusCode, 200);
  assert.deepEqual(good.json().user, { id: 1, email: ENV.USER1_EMAIL, name: 'Philipp', team_id: 1, role: 'owner' });
  const session = good.cookies.find((c) => c.name === SESSION_COOKIE);
  assert.ok(session, 'login sets the session cookie');
  assert.equal(session.httpOnly, true);
  assert.equal(session.sameSite?.toLowerCase(), 'lax');
  assert.equal(session.path, '/');
  assert.ok(session.maxAge >= 89 * 24 * 3600);

  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    cookies: { [SESSION_COOKIE]: session.value },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.email, ENV.USER1_EMAIL);

  const tampered = await app.inject({
    method: 'GET',
    url: '/api/me',
    cookies: { [SESSION_COOKIE]: '2.1758000000' },
  });
  assert.equal(tampered.statusCode, 401, 'an unsigned cookie value is rejected');

  const bearer = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { authorization: `Bearer ${ENV.ADMIN_TOKEN}` },
  });
  assert.equal(bearer.statusCode, 200);
  assert.equal(bearer.json().user.via, 'admin_token');
  assert.equal(bearer.json().user.id, 1);

  const wrongBearer = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { authorization: 'Bearer nope' },
  });
  assert.equal(wrongBearer.statusCode, 401);

  const out = await app.inject({
    method: 'POST',
    url: '/api/logout',
    cookies: { [SESSION_COOKIE]: session.value },
  });
  assert.equal(out.statusCode, 200);
  const cleared = out.cookies.find((c) => c.name === SESSION_COOKIE);
  assert.ok(cleared, 'logout sends a clearing cookie');
  assert.equal(cleared.value, '');
});

test('http: login is rate limited per IP', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const attempt = () =>
    app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { email: ENV.USER1_EMAIL, password: 'wrong' },
      remoteAddress: '203.0.113.9',
    });

  for (let i = 0; i < 10; i += 1) assert.equal((await attempt()).statusCode, 401);
  const blocked = await attempt();
  assert.equal(blocked.statusCode, 429);
  assert.deepEqual(blocked.json(), { error: 'too_many_attempts' });
});

test('http: static index and images mount', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const page = await app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Dream House/);

  const missingImage = await app.inject({ method: 'GET', url: '/images/does-not-exist.jpg' });
  assert.equal(missingImage.statusCode, 404, 'the images mount answers, it just has nothing yet');
});
