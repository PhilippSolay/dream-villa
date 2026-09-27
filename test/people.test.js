// The owners' mini CMS (SPEC §17): people and teams. Two owners seeded from env, as in
// test/verdicts.test.js; everyone else is added through this API.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { seedUsers, SESSION_COOKIE } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { upsertProperty } from '../src/scrape/store.js';

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

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-people-'));
  const env = { ...ENV, IMAGES_DIR: path.join(dir, 'images') };
  const db = openDb(path.join(dir, 'villa.db'));
  seedUsers(db, env);
  const app = await buildServer({ db, env });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function loginAs(email, password) {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
    if (res.statusCode !== 200) return null;
    const raw = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw).split(';')[0];
    const as = (opts) => app.inject({ ...opts, headers: { cookie, ...(opts.headers || {}) } });
    as.cookie = cookie;
    return as;
  }

  const owner = await loginAs(env.USER1_EMAIL, env.USER1_PASSWORD);

  return { db, app, env, owner, loginAs };
}

// Small wrappers so every test reads as "verb the resource", not raw app.inject calls.
const getPeople = (as) => as({ method: 'GET', url: '/api/people' });
const addPerson = (as, body) => as({ method: 'POST', url: '/api/people', payload: body });
const patchPerson = (as, id, body) => as({ method: 'PATCH', url: `/api/people/${id}`, payload: body });
const addTeam = (as, name) => as({ method: 'POST', url: '/api/teams', payload: { name } });
const patchTeam = (as, id, name) => as({ method: 'PATCH', url: `/api/teams/${id}`, payload: { name } });
const deleteTeam = (as, id) => as({ method: 'DELETE', url: `/api/teams/${id}` });

test('GET /api/people: the home team exists with both owners, home first', async (t) => {
  const { owner } = await setup(t);
  const res = await getPeople(owner);
  assert.equal(res.statusCode, 200);
  const { teams } = res.json();
  assert.equal(teams.length, 1);
  assert.equal(teams[0].home, true);
  assert.deepEqual(teams[0].members.map((m) => [m.name, m.role]).sort(), [['Abigail', 'owner'], ['Philipp', 'owner']]);
  for (const m of teams[0].members) assert.equal('password_hash' in m, false);
});

test('GET /api/people: each person carries how many Yes, Maybe and No calls they made', async (t) => {
  const { db, owner } = await setup(t);
  const philipp = db.prepare('SELECT id FROM users WHERE email = ?').get(ENV.USER1_EMAIL).id;
  const now = '2026-09-20T00:00:00.000Z';
  const vote = db.prepare('INSERT INTO verdicts (property_id, by, verdict) VALUES (?, ?, ?)');
  for (const [i, verdict] of ['yes', 'yes', 'maybe', 'no', 'no', 'no'].entries()) {
    upsertProperty(db, { key: `t:${i}`, source: 'test', url: `https://t.test/${i}`, title: 'Villa', area: 'cemagi' }, { now });
    vote.run(db.prepare('SELECT id FROM properties WHERE key = ?').get(`t:${i}`).id, philipp, verdict);
  }
  const members = (await getPeople(owner)).json().teams[0].members;
  assert.deepEqual(members.find((m) => m.id === philipp).verdicts, { yes: 2, maybe: 1, no: 3 });
  assert.deepEqual(members.find((m) => m.id !== philipp).verdicts, { yes: 0, maybe: 0, no: 0 }, 'no calls yet reads as zeros');
});

test('POST /api/people with neither team_id nor team_name creates a solo team named after the person', async (t) => {
  const { owner } = await setup(t);
  const res = await addPerson(owner, { name: 'Marina', email: 'Marina@Example.com ', password: 'marina-pass' });
  assert.equal(res.statusCode, 201);
  const person = res.json();
  assert.equal(person.name, 'Marina');
  assert.equal(person.email, 'marina@example.com', 'trimmed and lower-cased');
  assert.equal(person.role, 'member');
  assert.equal('password_hash' in person, false);

  const { teams } = (await getPeople(owner)).json();
  const solo = teams.find((tm) => tm.id === person.team_id);
  assert.ok(solo);
  assert.equal(solo.home, false);
  assert.equal(solo.name, 'Marina', 'the solo team is named after the person');
  assert.deepEqual(solo.members.map((m) => m.name), ['Marina']);
});

test('POST /api/people with team_name creates a shared team; a second person joins it via team_id', async (t) => {
  const { owner } = await setup(t);
  const ronnie = (await addPerson(owner, { name: 'Ronnie', email: 'ronnie@example.com', password: 'ronnie-pass', team_name: 'Ronnie & Janel' })).json();

  const janel = await addPerson(owner, { name: 'Janel', email: 'janel@example.com', password: 'janel-pass', team_id: ronnie.team_id });
  assert.equal(janel.statusCode, 201);
  assert.equal(janel.json().team_id, ronnie.team_id);

  const { teams } = (await getPeople(owner)).json();
  const shared = teams.find((tm) => tm.id === ronnie.team_id);
  assert.equal(shared.name, 'Ronnie & Janel');
  assert.deepEqual(shared.members.map((m) => m.name).sort(), ['Janel', 'Ronnie']);
});

test('POST /api/people: an unknown team_id 400s; team_id and team_name together 400', async (t) => {
  const { owner } = await setup(t);
  let res = await addPerson(owner, { name: 'X', email: 'x@example.com', password: 'password1', team_id: 999 });
  assert.equal(res.statusCode, 400);

  res = await addPerson(owner, { name: 'Y', email: 'y@example.com', password: 'password1', team_id: 1, team_name: 'Both' });
  assert.equal(res.statusCode, 400);
});

test('POST /api/people: duplicate email is 409 email_taken, no orphan team left behind', async (t) => {
  const { owner, db } = await setup(t);
  await addPerson(owner, { name: 'Marina', email: 'marina@example.com', password: 'marina-pass' });
  const before = db.prepare('SELECT COUNT(*) AS n FROM teams').get().n;

  const res = await addPerson(owner, { name: 'Marina Two', email: 'marina@example.com', password: 'another-pass' });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: 'email_taken' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM teams').get().n, before, 'no solo team created for the failed signup');
});

test('POST /api/people: password must be at least 8 characters', async (t) => {
  const { owner } = await setup(t);
  const res = await addPerson(owner, { name: 'Short', email: 'short@example.com', password: 'short' });
  assert.equal(res.statusCode, 400);
});

test('a member gets 403 on every /api/people and /api/teams route', async (t) => {
  const { owner, loginAs, env } = await setup(t);
  const marina = (await addPerson(owner, { name: 'Marina', email: 'marina@example.com', password: 'marina-pass' })).json();
  const member = await loginAs('marina@example.com', 'marina-pass');
  assert.ok(member, 'the new person can log in');

  const calls = [
    () => getPeople(member),
    () => addPerson(member, { name: 'Nope', email: 'nope@example.com', password: 'password1' }),
    () => patchPerson(member, marina.id, { name: 'Renamed' }),
    () => addTeam(member, 'New team'),
    () => patchTeam(member, marina.team_id, 'Renamed team'),
    () => deleteTeam(member, marina.team_id),
  ];
  for (const call of calls) {
    const res = await call();
    assert.equal(res.statusCode, 403, res.request?.url);
    assert.deepEqual(res.json(), { error: 'owners_only' });
  }
  void env;
});

test('PATCH /api/people/:id on an owner row is 400: owners are managed in .env', async (t) => {
  const { owner } = await setup(t);
  const res = await patchPerson(owner, 1, { name: 'Renamed Owner' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'bad_request', detail: 'owners are managed in .env' });
});

test('PATCH /api/people/:id: unknown id is 404', async (t) => {
  const { owner } = await setup(t);
  const res = await patchPerson(owner, 999_999, { name: 'Nobody' });
  assert.equal(res.statusCode, 404);
});

test('PATCH password reset voids the old cookie; the new password logs in', async (t) => {
  const { owner, loginAs } = await setup(t);
  const marina = (await addPerson(owner, { name: 'Marina', email: 'marina@example.com', password: 'marina-pass' })).json();
  const oldSession = await loginAs('marina@example.com', 'marina-pass');

  const res = await patchPerson(owner, marina.id, { password: 'brand-new-pass' });
  assert.equal(res.statusCode, 200);
  assert.equal('password_hash' in res.json(), false);

  const stale = await oldSession({ method: 'GET', url: '/api/me' });
  assert.equal(stale.statusCode, 401, 'the old cookie died with the password');

  const oldPassword = await app_login(owner, 'marina@example.com', 'marina-pass');
  assert.equal(oldPassword, 401, 'the old password no longer works');

  const relogged = await loginAs('marina@example.com', 'brand-new-pass');
  assert.ok(relogged, 'the new password logs in');
});

// A bare login attempt, for asserting a password no longer works without minting a cookie.
async function app_login(as, email, password) {
  const res = await as({ method: 'POST', url: '/api/login', payload: { email, password } });
  return res.statusCode;
}

test('PATCH disabled:true blocks login and kills the old cookie; disabled:false restores it', async (t) => {
  const { owner, loginAs } = await setup(t);
  const marina = (await addPerson(owner, { name: 'Marina', email: 'marina@example.com', password: 'marina-pass' })).json();
  const session = await loginAs('marina@example.com', 'marina-pass');

  let res = await patchPerson(owner, marina.id, { disabled: true });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().disabled_at, 'disabled_at is set');

  assert.equal(await app_login(owner, 'marina@example.com', 'marina-pass'), 401, 'login fails while disabled');
  const stale = await session({ method: 'GET', url: '/api/me' });
  assert.equal(stale.statusCode, 401, 'the cookie issued before the disable is dead');

  res = await patchPerson(owner, marina.id, { disabled: false });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().disabled_at, null);

  const relogged = await loginAs('marina@example.com', 'marina-pass');
  assert.ok(relogged, 'enabling restores login');
});

test('PATCH /api/people/:id moves a person between teams', async (t) => {
  const { owner } = await setup(t);
  const marina = (await addPerson(owner, { name: 'Marina', email: 'marina@example.com', password: 'marina-pass' })).json();
  const shared = (await addTeam(owner, 'Ronnie & Janel')).json();

  const res = await patchPerson(owner, marina.id, { team_id: shared.id });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().team_id, shared.id);

  const res2 = await patchPerson(owner, marina.id, { team_id: 999_999 });
  assert.equal(res2.statusCode, 400, 'an unknown team_id 400s');
});

test('teams: create, rename (home team included), delete only when empty, home undeletable', async (t) => {
  const { owner } = await setup(t);

  const created = await addTeam(owner, 'Ronnie & Janel');
  assert.equal(created.statusCode, 201);
  const team = created.json();
  assert.equal(team.name, 'Ronnie & Janel');

  const renamed = await patchTeam(owner, team.id, 'Ronnie & Janel Renamed');
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().name, 'Ronnie & Janel Renamed');

  const renameHome = await patchTeam(owner, 1, 'The Home Team');
  assert.equal(renameHome.statusCode, 200, 'the home team can be renamed');

  const homeDelete = await deleteTeam(owner, 1);
  assert.equal(homeDelete.statusCode, 400, 'the home team can never be deleted');

  const marina = (await addPerson(owner, { name: 'Marina', email: 'marina@example.com', password: 'marina-pass', team_id: team.id })).json();
  const notEmpty = await deleteTeam(owner, team.id);
  assert.equal(notEmpty.statusCode, 409, 'a team with someone in it cannot be deleted');

  await patchPerson(owner, marina.id, { disabled: true });
  const stillNotEmpty = await deleteTeam(owner, team.id);
  assert.equal(stillNotEmpty.statusCode, 409, 'a disabled member still counts as occupying the team');

  // Friends never move into the home team (SPEC §17), so empty this one into another.
  const other = (await addTeam(owner, 'Marina on her own')).json();
  await patchPerson(owner, marina.id, { team_id: other.id });
  const emptied = await deleteTeam(owner, team.id);
  assert.equal(emptied.statusCode, 200);

  const missing = await deleteTeam(owner, team.id);
  assert.equal(missing.statusCode, 404, 'deleting it again is a 404');
});

test('no response from /api/people or /api/teams ever carries password_hash', async (t) => {
  const { owner } = await setup(t);
  const created = (await addPerson(owner, { name: 'Marina', email: 'marina@example.com', password: 'marina-pass' })).json();
  const patched = (await patchPerson(owner, created.id, { name: 'Marina S' })).json();
  const { teams } = (await getPeople(owner)).json();

  for (const obj of [created, patched, ...teams.flatMap((tm) => tm.members)]) {
    assert.equal('password_hash' in obj, false);
    assert.equal('session_epoch' in obj, false);
  }
});
