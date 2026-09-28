// Teams (SPEC §17): the migration that puts today's two people in the home team, the
// per-team overlay over `properties`, and the account rules friends brought with them —
// disabled logins, voided sessions, owner-only routes, a roster scoped to the team.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { openDb, MIGRATIONS } from '../src/db.js';
import { seedUsers, createUser, voidSessions } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { upsertProperty, rescoreAll } from '../src/scrape/store.js';
import {
  HOME_TEAM_ID, createTeam, getListing, listingsSql, writeListingState, teamRoster, isHome, isOwner,
} from '../src/teams.js';

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

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-teams-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A listing that passes every hard filter and scores well: Featured for the home team. */
function strongRow(key) {
  return {
    key: `bhi:${key}`, ref: key, source: 'bhi', url: `https://bhi.test/${key}`, title: `Villa ${key}`,
    area: 'cemagi', beach_km: 0.8, bedrooms: 2, price_month_idr: 40_000_000, term: 'monthly',
    pool: 1, garden: 1, view: 'ocean', living_open: 1, airy: 1, kitchen_full: 1, aircon: 1,
    workspace: 1, joglo: 1, style: 'joglo', furnished: 1, furniture_quality: 4, land_m2: 600,
    availability: 'available',
  };
}

function setupDb(t) {
  const dir = tempDir(t);
  const db = openDb(path.join(dir, 'villa.db'));
  t.after(() => db.close());
  seedUsers(db, ENV);
  upsertProperty(db, strongRow('A'), { now: '2026-09-20T00:00:00.000Z' });
  upsertProperty(db, strongRow('B'), { now: '2026-09-20T00:00:00.000Z' });
  rescoreAll(db);
  const id = (k) => db.prepare('SELECT id FROM properties WHERE key = ?').get(`bhi:${k}`).id;
  const marinaTeam = createTeam(db, 'Marina');
  const pairTeam = createTeam(db, 'Ronnie & Janel');
  const marina = { id: createUser(db, { email: 'Marina@Example.com', name: 'Marina', password: 'dreamvilla-test-1', team_id: marinaTeam }), team_id: marinaTeam, role: 'member' };
  const ronnie = { id: createUser(db, { email: 'ronnie@example.com', name: 'Ronnie', password: 'dreamvilla-test-2', team_id: pairTeam }), team_id: pairTeam, role: 'member' };
  const janel = { id: createUser(db, { email: 'janel@example.com', name: 'Janel', password: 'dreamvilla-test-3', team_id: pairTeam }), team_id: pairTeam, role: 'member' };
  const philipp = { id: 1, team_id: HOME_TEAM_ID, role: 'owner' };
  return { db, dir, id, marina, ronnie, janel, philipp, marinaTeam, pairTeam };
}

test('migration 010: the people who exist become owners of the home team, named after them', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'villa.db');
  // A database from before teams: every migration up to 009, two people in it.
  const raw = new Database(file);
  raw.exec('CREATE TABLE migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((m) => m.name < '010')) {
    m.up(raw);
    raw.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(m.name, '2026-09-20T00:00:00.000Z');
  }
  raw.prepare("INSERT INTO users (email, name, password_hash, created_at) VALUES ('p@x.com', 'Philipp', 'h', 'now')").run();
  raw.prepare("INSERT INTO users (email, name, password_hash, created_at) VALUES ('a@x.com', 'Abigaïl', 'h', 'now')").run();
  raw.close();

  const db = openDb(file);
  t.after(() => db.close());
  // 011 rides along on a pre-teams database: its target list is still the one 009 left.
  // 012 (for_sale) is a plain column add and 013 re-reads Facebook rents, so they ride along too.
  assert.deepEqual(db.migrationsApplied, ['010_teams', '011_ubud_surrounds', '012_for_sale', '013_reprice_posts']);
  assert.deepEqual(db.prepare('SELECT id, name FROM teams').all(), [{ id: 1, name: 'Philipp & Abigaïl' }]);
  assert.deepEqual(
    db.prepare('SELECT team_id, role, disabled_at FROM users ORDER BY id').all(),
    [{ team_id: 1, role: 'owner', disabled_at: null }, { team_id: 1, role: 'owner', disabled_at: null }]
  );
});

test('seedUsers: env people are owners of the home team on a fresh database, and stay so', (t) => {
  const { db } = setupDb(t);
  assert.equal(db.prepare('SELECT name FROM teams WHERE id = 1').get().name, 'Philipp & Abigail');
  // Someone moved an owner by hand — the next boot puts them back.
  db.prepare("UPDATE users SET team_id = 2, role = 'member', disabled_at = 'x' WHERE id = 2").run();
  seedUsers(db, ENV);
  assert.deepEqual(db.prepare('SELECT team_id, role, disabled_at FROM users WHERE id = 2').get(), { team_id: 1, role: 'owner', disabled_at: null });
});

test('createUser stores the email trimmed and lower-cased', (t) => {
  const { db, marina } = setupDb(t);
  assert.equal(db.prepare('SELECT email FROM users WHERE id = ?').get(marina.id).email, 'marina@example.com');
});

test('listingsSql: home reads properties itself; another team sees its own pipeline over the same facts', (t) => {
  const { db, id, marina, philipp } = setupDb(t);
  assert.equal(listingsSql(db, philipp), 'properties');
  assert.equal(listingsSql(db, null), 'properties', 'no user (scraper, scripts) reads as home');

  db.prepare("UPDATE properties SET status = 'contacted', status_by = 1, notes = 'owner said 45 M', assessed = 'partly' WHERE id = ?").run(id('A'));
  const home = getListing(db, philipp, id('A'));
  const friend = getListing(db, marina, id('A'));
  assert.equal(home.status, 'contacted');
  assert.equal(friend.status, 'new');
  assert.equal(friend.notes, null);
  assert.equal(friend.assessed, 'not_yet');
  assert.equal(friend.status_by, null);
  assert.equal(friend.title, home.title, 'facts pass through');
  assert.equal(friend.fit_score, home.fit_score);
  assert.deepEqual(Object.keys(friend).sort(), Object.keys(home).sort(), 'same columns either way');
});

test('writeListingState: a friend writes team_listings and never properties; home writes properties', (t) => {
  const { db, id, marina, ronnie, janel, philipp } = setupDb(t);
  const before = db.prepare('SELECT * FROM properties WHERE id = ?').get(id('A'));

  writeListingState(db, marina, id('A'), { status: 'shortlist', status_by: marina.id, status_at: '2026-09-26T00:00:00.000Z', notes: 'love the garden' });
  assert.deepEqual(db.prepare('SELECT * FROM properties WHERE id = ?').get(id('A')), before, 'properties untouched');
  assert.equal(getListing(db, marina, id('A')).status, 'shortlist');
  assert.equal(getListing(db, marina, id('A')).notes, 'love the garden');
  assert.equal(getListing(db, ronnie, id('A')).status, 'new', 'another team does not see it');
  assert.equal(getListing(db, philipp, id('A')).status, 'new');

  // A partial write keeps the rest of the team's row.
  writeListingState(db, marina, id('A'), { assessed: 'partly' });
  assert.equal(getListing(db, marina, id('A')).notes, 'love the garden');
  assert.equal(getListing(db, marina, id('A')).assessed, 'partly');

  // Teammates share one row.
  writeListingState(db, ronnie, id('B'), { status: 'viewed', status_by: ronnie.id });
  assert.equal(getListing(db, janel, id('B')).status, 'viewed');

  writeListingState(db, philipp, id('B'), { status: 'offer', status_by: 1 });
  assert.equal(db.prepare('SELECT status FROM properties WHERE id = ?').get(id('B')).status, 'offer');
  assert.equal(getListing(db, janel, id('B')).status, 'viewed');
  writeListingState(db, marina, id('B'), { bogus: 1 }); // ignored, no throw
});

test('flagged is per team: a Reject un-features only for the team that rejected', (t) => {
  const { db, id, marina, philipp } = setupDb(t);
  assert.equal(getListing(db, philipp, id('A')).flagged, 1, 'the fixture is Featured');
  assert.equal(getListing(db, marina, id('A')).flagged, 1, 'the overlay agrees with scoreRow');

  writeListingState(db, marina, id('A'), { status: 'rejected' });
  assert.equal(getListing(db, marina, id('A')).flagged, 0);
  assert.equal(getListing(db, philipp, id('A')).flagged, 1);

  db.prepare("UPDATE properties SET status = 'rejected' WHERE id = ?").run(id('B'));
  rescoreAll(db);
  assert.equal(getListing(db, philipp, id('B')).flagged, 0);
  assert.equal(getListing(db, marina, id('B')).flagged, 1, "the owners' Reject is theirs");

  // Red flags and scraper removals are facts: they un-feature for everyone.
  db.prepare("UPDATE properties SET red_flags = '[\"main_road\"]' WHERE id = ?").run(id('A'));
  writeListingState(db, marina, id('A'), { status: 'new' });
  assert.equal(getListing(db, marina, id('A')).flagged, 0);
});

test("removal: a friend's Gone is theirs; the home team's 'taken' is a fact for everyone", (t) => {
  const { db, id, marina, ronnie } = setupDb(t);
  writeListingState(db, marina, id('A'), { status: 'gone', status_at: '2026-09-25T00:00:00.000Z' });
  const mine = getListing(db, marina, id('A'));
  assert.equal(mine.removed_reason, 'taken');
  assert.equal(mine.removed_at, '2026-09-25T00:00:00.000Z');
  assert.equal(getListing(db, ronnie, id('A')).removed_at, null);

  db.prepare("UPDATE properties SET status = 'gone', status_by = 1, removed_at = '2026-09-24T00:00:00.000Z', removed_reason = 'taken' WHERE id = ?").run(id('B'));
  const theirs = getListing(db, ronnie, id('B'));
  assert.equal(theirs.status, 'gone');
  assert.equal(theirs.removed_reason, 'taken');
  assert.equal(theirs.status_by, null, 'no name from outside the team');
  assert.equal(theirs.flagged, 0);
});

test('teamRoster: active teammates only; isHome / isOwner', (t) => {
  const { db, marina, ronnie, janel, philipp } = setupDb(t);
  assert.deepEqual(teamRoster(db, philipp).map((u) => u.name), ['Philipp', 'Abigail']);
  assert.deepEqual(teamRoster(db, marina).map((u) => u.name), ['Marina']);
  assert.deepEqual(teamRoster(db, ronnie).map((u) => u.name), ['Ronnie', 'Janel']);
  db.prepare("UPDATE users SET disabled_at = 'x' WHERE id = ?").run(janel.id);
  assert.deepEqual(teamRoster(db, ronnie).map((u) => u.name), ['Ronnie']);
  assert.equal(isHome(philipp), true);
  assert.equal(isHome(marina), false);
  assert.equal(isOwner(philipp), true);
  assert.equal(isOwner(marina), false);
});

async function server(t) {
  const ctx = setupDb(t);
  const env = { ...ENV, IMAGES_DIR: path.join(ctx.dir, 'images') };
  const app = await buildServer({ db: ctx.db, env });
  t.after(() => app.close());
  const login = (email, password) => app.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
  const cookieOf = (res) => {
    const raw = res.headers['set-cookie'];
    return (Array.isArray(raw) ? raw[0] : raw).split(';')[0];
  };
  const me = (cookie) => app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { ...ctx, app, login, cookieOf, me };
}

test('/api/me: the roster is the team; a team of one is solo', async (t) => {
  const { login, cookieOf, me } = await server(t);
  const philipp = (await me(cookieOf(await login(ENV.USER1_EMAIL, ENV.USER1_PASSWORD))) ).json();
  assert.deepEqual(philipp.users.map((u) => u.name), ['Philipp', 'Abigail']);
  assert.deepEqual(philipp.team, { id: 1, name: 'Philipp & Abigail', solo: false });
  assert.equal(philipp.user.role, 'owner');

  const marina = (await me(cookieOf(await login('marina@example.com', 'dreamvilla-test-1')))).json();
  assert.deepEqual(marina.users.map((u) => u.name), ['Marina']);
  assert.equal(marina.team.solo, true);
  assert.equal(marina.user.role, 'member');

  const ronnie = (await me(cookieOf(await login('RONNIE@example.com ', 'dreamvilla-test-2')))).json();
  assert.deepEqual(ronnie.users.map((u) => u.name), ['Ronnie', 'Janel']);
  assert.equal(ronnie.team.solo, false);
});

test('a disabled person cannot log in, and their open session dies', async (t) => {
  const { db, marina, login, cookieOf, me } = await server(t);
  const cookie = cookieOf(await login('marina@example.com', 'dreamvilla-test-1'));
  assert.equal((await me(cookie)).statusCode, 200);
  db.prepare("UPDATE users SET disabled_at = '2026-09-26T00:00:00.000Z' WHERE id = ?").run(marina.id);
  assert.equal((await me(cookie)).statusCode, 401);
  const res = await login('marina@example.com', 'dreamvilla-test-1');
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: 'invalid_credentials' }, 'no hint that the account exists');
});

test('a cookie from before teams (issue time in seconds) still signs in, and a reset still voids it', async (t) => {
  const { db, app, me } = await server(t);
  const legacy = (secondsAgo) => `villa_session=${app.signCookie(`1.${Math.floor(Date.now() / 1000) - secondsAgo}`)}`;
  assert.equal((await me(legacy(60))).statusCode, 200, 'the owners stay signed in across the deploy');
  voidSessions(db, 1);
  assert.equal((await me(legacy(60))).statusCode, 401);
});

// --- hardening from the security review (2026-09-26) ------------------------------

test('seedUsers: env emails are stored lower-case and matched whatever their case', (t) => {
  const { db } = setupDb(t);
  const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  seedUsers(db, { ...ENV, USER1_EMAIL: 'Philipp@Example.COM' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before, 'no second Philipp');
  assert.equal(db.prepare('SELECT email FROM users WHERE id = 1').get().email, 'philipp@example.com');
});

test('seedUsers: a rotated owner password ends the old sessions', async (t) => {
  const { db, login, cookieOf, me } = await server(t);
  const cookie = cookieOf(await login(ENV.USER2_EMAIL, ENV.USER2_PASSWORD));
  seedUsers(db, ENV); // same password: nothing changes
  assert.equal((await me(cookie)).statusCode, 200);
  seedUsers(db, { ...ENV, USER2_PASSWORD: 'a brand new passphrase' });
  assert.equal((await me(cookie)).statusCode, 401);
});

test('seedUsers: an owner the env no longer names is demoted, disabled and signed out', async (t) => {
  const { db, login, cookieOf, me } = await server(t);
  const cookie = cookieOf(await login(ENV.USER2_EMAIL, ENV.USER2_PASSWORD));
  seedUsers(db, { ...ENV, USER2_EMAIL: 'abigail.new@example.com' });
  const old = db.prepare('SELECT role, disabled_at, team_id FROM users WHERE id = 2').get();
  assert.equal(old.role, 'member');
  assert.ok(old.disabled_at);
  assert.equal(old.team_id, HOME_TEAM_ID, 'their rows stay with the home team');
  assert.equal((await me(cookie)).statusCode, 401);
  assert.equal((await login(ENV.USER2_EMAIL, ENV.USER2_PASSWORD)).statusCode, 401);
});

test('createUser refuses a person without a team (no team would read as home)', (t) => {
  const { db } = setupDb(t);
  assert.throws(() => createUser(db, { email: 'x@example.com', name: 'X', password: 'long enough pw' }), /team_id/);
});

test('login: ten failures lock that account for the window, whatever the IP', async (t) => {
  const { app } = await server(t);
  const attempt = (ip, password) =>
    app.inject({ method: 'POST', url: '/api/login', remoteAddress: ip, payload: { email: 'marina@example.com', password } });
  for (let i = 0; i < 10; i++) assert.equal((await attempt(`10.0.0.${i}`, 'wrong password')).statusCode, 401);
  const locked = await attempt('10.0.1.1', 'dreamvilla-test-1');
  assert.equal(locked.statusCode, 429, 'even the right password waits out the window');
  // Another account is untouched.
  const ronnie = await app.inject({ method: 'POST', url: '/api/login', remoteAddress: '10.0.1.2', payload: { email: 'ronnie@example.com', password: 'dreamvilla-test-2' } });
  assert.equal(ronnie.statusCode, 200);
});

test("viewing photos: only the visit's team loads them, never cached publicly", async (t) => {
  const { db, dir, id, app, login, cookieOf } = await server(t);
  const pid = id('A');
  const vid = Number(db.prepare("INSERT INTO viewings (property_id, by, date, created_at) VALUES (?, 1, '2026-09-25', 'now')").run(pid).lastInsertRowid);
  fs.mkdirSync(path.join(dir, 'images', String(pid)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'images', String(pid), `v${vid}-1.jpg`), 'jpeg bytes');
  fs.writeFileSync(path.join(dir, 'images', String(pid), '1.jpg'), 'listing photo');
  const get = (url, cookie) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const abigail = cookieOf(await login(ENV.USER2_EMAIL, ENV.USER2_PASSWORD));
  const marina = cookieOf(await login('marina@example.com', 'dreamvilla-test-1'));
  const url = `/images/${pid}/v${vid}-1.jpg`;

  const ok = await get(url, abigail);
  assert.equal(ok.statusCode, 200, 'a teammate of the visitor');
  assert.equal(ok.headers['cache-control'], 'private, no-store');
  assert.equal((await get(url, marina)).statusCode, 404, 'another team');
  assert.equal((await get(url)).statusCode, 404, 'nobody signed in');
  assert.equal((await get(`/images/${pid}/%76${vid}-1.jpg`, marina)).statusCode, 404, 'an encoded v');
  assert.equal((await get(`/images/${pid}/./v${vid}-1.jpg`, marina)).statusCode, 404, 'a ./ in the path');
  assert.equal((await get(`/images/${pid}/1.jpg`)).statusCode, 200, 'listing photos stay public');
});

test("contacts: friends see who to call, not the owners' notes on them", async (t) => {
  const { db, id, app, login, cookieOf } = await server(t);
  const cid = Number(db.prepare("INSERT INTO contacts (name, whatsapp, notes, responsiveness, created_at) VALUES ('Made', '+628111', 'pushy, offered 42 M', 2, 'now')").run().lastInsertRowid);
  db.prepare('INSERT INTO property_contacts (property_id, contact_id) VALUES (?, ?)').run(id('A'), cid);
  const marina = cookieOf(await login('marina@example.com', 'dreamvilla-test-1'));
  const philipp = cookieOf(await login(ENV.USER1_EMAIL, ENV.USER1_PASSWORD));
  const get = async (url, cookie) => (await app.inject({ method: 'GET', url, headers: { cookie } })).json();

  const book = await get('/api/contacts', marina);
  assert.equal(book[0].whatsapp, '+628111');
  assert.equal(book[0].notes, null);
  assert.equal(book[0].responsiveness, null);
  const detail = await get(`/api/properties/${id('A')}`, marina);
  assert.equal(detail.contacts[0].notes, null);
  const list = await get('/api/properties?scope=all&status=all', marina);
  assert.equal(list.find((r) => r.id === id('A')).contacts[0].notes, null);
  assert.equal((await get('/api/contacts', philipp))[0].notes, 'pushy, offered 42 M');
});

test('people: a friend can never be put in the home team', async (t) => {
  const { app, login, cookieOf, marina } = await server(t);
  const philipp = cookieOf(await login(ENV.USER1_EMAIL, ENV.USER1_PASSWORD));
  const call = (method, url, payload) => app.inject({ method, url, payload, headers: { cookie: philipp } });
  const add = await call('POST', '/api/people', { name: 'Ronnie 2', email: 'r2@example.com', password: 'long enough pw', team_id: HOME_TEAM_ID });
  assert.equal(add.statusCode, 400);
  const move = await call('PATCH', `/api/people/${marina.id}`, { team_id: HOME_TEAM_ID });
  assert.equal(move.statusCode, 400);
  const bad = await call('POST', '/api/people', { name: 'Typo', email: 'not an email', password: 'long enough pw' });
  assert.equal(bad.statusCode, 400);
  const dupe = await call('POST', '/api/people', { name: 'P', email: 'PHILIPP@example.com', password: 'long enough pw' });
  assert.equal(dupe.statusCode, 409, 'case-insensitive against the owners too');
});

test('feedback: marking one applied only reaches the caller team', async (t) => {
  const { db, id, app, login, cookieOf, marina } = await server(t);
  const fid = Number(db.prepare("INSERT INTO feedback (property_id, by, text, created_at) VALUES (?, ?, 'marina private', 'now')").run(id('A'), marina.id).lastInsertRowid);
  const philipp = cookieOf(await login(ENV.USER1_EMAIL, ENV.USER1_PASSWORD));
  const res = await app.inject({ method: 'POST', url: `/api/feedback/${fid}/applied`, payload: { note: 'x' }, headers: { cookie: philipp } });
  assert.equal(res.statusCode, 404);
  const agent = await app.inject({ method: 'GET', url: `/api/agent/feedback-applied?token=${ENV.AGENT_TOKEN}&id=${fid}&note=x` });
  assert.equal(agent.statusCode, 404);
  assert.equal(db.prepare('SELECT applied FROM feedback WHERE id = ?').get(fid).applied, 0);
});

test('voidSessions kills cookies issued before it, not the next login', async (t) => {
  const { db, marina, login, cookieOf, me } = await server(t);
  const old = cookieOf(await login('marina@example.com', 'dreamvilla-test-1'));
  // No waiting: cookies carry milliseconds, so the same second does not save the old one.
  voidSessions(db, marina.id);
  assert.equal((await me(old)).statusCode, 401);
  const fresh = cookieOf(await login('marina@example.com', 'dreamvilla-test-1'));
  assert.equal((await me(fresh)).statusCode, 200);
});
