// SPEC §17 "Friends join" — cross-cutting isolation guards outside the properties/
// anchors routes (those are covered by their own owning agent's tests):
//  - every owner-only route in admin.js/duplicates.js/import.js/import-listings.js
//    403s a member (and the bearer ADMIN_TOKEN, resolving to user 1, still passes);
//  - the Agent page's reads answer a member (they see it read-only), with their own
//    team's flag and status — all but the agent's notes;
//  - a member's PATCH /api/config is a no-op;
//  - stats.js counts each team's own pipeline/activity, never another's;
//  - the owners' agent digest (src/routes/agent.js) never surfaces a friend's
//    feedback/viewing;
//  - the learning pass (src/scrape/learn.js) only mines home-team rows.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, nowIso, getConfig } from '../src/db.js';
import { seedUsers, createUser } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { createTeam, writeListingState, HOME_TEAM_ID } from '../src/teams.js';
import { runLearn } from '../src/scrape/learn.js';

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

const MEMBER_PASSWORD = 'friend-password-0123456789ab';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-teams-guards-'));
  return { db: openDb(path.join(dir, 'villa.db')), dir };
}

let seq = 0;
function insertListing(db, overrides = {}) {
  seq += 1;
  const now = nowIso();
  const row = {
    key: `test:${seq}`, ref: `RF${1000 + seq}`, source: 'bhi', url: `https://bhi.test/${seq}`,
    title: `Test Villa ${seq}`, area: 'cemagi', bedrooms: 2, price_month_idr: 30_000_000, term: 'monthly',
    scope: 'in_filter', fit_score: 70, flagged: 0, red_flags: '[]',
    availability: 'available', status: 'new', first_seen: now, last_seen: now,
    ...overrides,
  };
  const cols = Object.keys(row);
  const info = db
    .prepare(`INSERT INTO properties (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c]));
  return Number(info.lastInsertRowid);
}

function insertRating(db, { propertyId, by, feature = 'quiet', score = 4, createdAt = nowIso() }) {
  db.prepare('INSERT INTO ratings (property_id, by, feature, score, created_at) VALUES (?, ?, ?, ?, ?)').run(
    propertyId, by, feature, score, createdAt
  );
}

function insertViewing(db, { propertyId, by, date = '2026-09-20', createdAt = nowIso() }) {
  db.prepare('INSERT INTO viewings (property_id, by, date, created_at) VALUES (?, ?, ?, ?)').run(propertyId, by, date, createdAt);
}

function insertFeedback(db, { propertyId = null, by, text, createdAt = nowIso() }) {
  const info = db
    .prepare('INSERT INTO feedback (property_id, by, text, created_at) VALUES (?, ?, ?, ?)')
    .run(propertyId, by, text, createdAt);
  return Number(info.lastInsertRowid);
}

async function setup(t) {
  const { db, dir } = tmpDb();
  seedUsers(db, ENV);

  const philippId = db.prepare('SELECT id FROM users WHERE email = ?').get(ENV.USER1_EMAIL).id;
  const abigailId = db.prepare('SELECT id FROM users WHERE email = ?').get(ENV.USER2_EMAIL).id;

  // A solo team (Marina) and a two-member team (Ronnie + Janel) — the two shapes SPEC
  // §17 calls out.
  const marinaTeamId = createTeam(db, 'Marina');
  const marinaId = createUser(db, {
    email: 'marina@example.com', name: 'Marina', password: MEMBER_PASSWORD, team_id: marinaTeamId, role: 'member',
  });
  const friendsTeamId = createTeam(db, 'Ronnie & Janel');
  const ronnieId = createUser(db, {
    email: 'ronnie@example.com', name: 'Ronnie', password: MEMBER_PASSWORD, team_id: friendsTeamId, role: 'member',
  });
  const janelId = createUser(db, {
    email: 'janel@example.com', name: 'Janel', password: MEMBER_PASSWORD, team_id: friendsTeamId, role: 'member',
  });

  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function loginCall(email, password) {
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
    assert.equal(login.statusCode, 200, `login ${email}`);
    const raw = login.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw).split(';')[0];
    return (opts) => app.inject({ ...opts, headers: { cookie, ...(opts.headers || {}) } });
  }

  const philippCall = await loginCall(ENV.USER1_EMAIL, ENV.USER1_PASSWORD);
  const marinaCall = await loginCall('marina@example.com', MEMBER_PASSWORD);
  const ronnieCall = await loginCall('ronnie@example.com', MEMBER_PASSWORD);
  const bearerCall = (opts) =>
    app.inject({ ...opts, headers: { authorization: `Bearer ${ENV.ADMIN_TOKEN}`, ...(opts.headers || {}) } });

  return {
    app,
    db,
    ids: { philippId, abigailId, marinaId, ronnieId, janelId, marinaTeamId, friendsTeamId },
    philippCall,
    marinaCall,
    ronnieCall,
    bearerCall,
  };
}

// ---------------------------------------------------------------------------
// 1. Owner guards — admin.js, duplicates.js, import.js, import-listings.js
// ---------------------------------------------------------------------------

const OWNER_ONLY_ROUTES = [
  ['PATCH', '/api/config', { flag_threshold: 70 }],
  ['POST', '/api/scrape', {}],
  ['POST', '/api/inbox', { url: 'https://example.test/member-guard' }],
  ['GET', '/api/notes', undefined],
  ['POST', '/api/sources', { kind: 'agent', name: 'Member source attempt' }],
  ['PATCH', '/api/sources/nonexistent', { enabled: false }],
  ['PATCH', '/api/sources/bhi', { enabled: false }],
  ['POST', '/api/feedback/1/applied', { note: 'x' }],
  ['GET', '/api/properties/1/duplicates', undefined],
  ['POST', '/api/duplicates/merge', { keep_id: 1, merge_id: 2 }],
  ['POST', '/api/duplicates/auto', undefined],
  ['POST', '/api/duplicates/dismiss', { a: 1, b: 2 }],
  ['POST', '/api/duplicates/undismiss', { a: 1, b: 2 }],
  ['POST', '/api/import/posts', {}],
  ['GET', '/api/import/status', undefined],
  ['POST', '/api/import/listings', {}],
  ['GET', '/api/import/listings/status?source=bhi', undefined],
];

test('member: 403 owners_only on every owner-only admin/duplicates/import route', async (t) => {
  const { marinaCall } = await setup(t);
  for (const [method, url, payload] of OWNER_ONLY_ROUTES) {
    const res = await marinaCall({ method, url, payload });
    assert.equal(res.statusCode, 403, `${method} ${url} should 403 for a member`);
    assert.deepEqual(res.json(), { error: 'owners_only' }, `${method} ${url}`);
  }
});

// Friends see the Agent page read-only: every read it makes (views/agent.js mountAgent)
// answers them; every write it makes is in OWNER_ONLY_ROUTES above.
const AGENT_PAGE_READS = [
  '/api/runs?limit=14',
  '/api/config',
  '/api/inbox?status=pending',
  '/api/sources',
  '/api/contacts',
  '/api/duplicates?limit=30',
];

test('member: the Agent page reads answer 200, all but the agent notes', async (t) => {
  const { philippCall, marinaCall } = await setup(t);
  const queued = await philippCall({ method: 'POST', url: '/api/inbox', payload: { url: 'https://example.test/queued' } });
  assert.equal(queued.statusCode, 200);

  for (const url of AGENT_PAGE_READS) {
    const res = await marinaCall({ method: 'GET', url });
    assert.equal(res.statusCode, 200, `GET ${url} should answer a member`);
  }
  const inbox = (await marinaCall({ method: 'GET', url: '/api/inbox?status=pending' })).json();
  assert.deepEqual(inbox.map((i) => i.url), ['https://example.test/queued']);

  // The morning session writes its notes from the home team's feedback and viewings.
  const notes = await marinaCall({ method: 'GET', url: '/api/notes?limit=14' });
  assert.equal(notes.statusCode, 403);
  assert.deepEqual(notes.json(), { error: 'owners_only' });
});

test("member: the Agent page's sources and duplicates carry the member team's flag and status", async (t) => {
  const { db, philippCall, marinaCall } = await setup(t);
  // Two listings of one villa (same photo, same WhatsApp, same price), both flagged; the
  // home team rejects the first, which un-features it for the home team only.
  const images = JSON.stringify([{ src_url: 'https://cdn.test/twin.jpg' }]);
  const a = insertListing(db, { source: 'bhi', title: 'Villa Anggrek', images, fit_score: 90, flagged: 1 });
  const b = insertListing(db, { source: 'fb', title: 'Disewakan villa 2 kamar Cemagi', images, fit_score: 90, flagged: 1 });
  const contact = Number(
    db.prepare("INSERT INTO contacts (name, whatsapp, created_at) VALUES ('Wayan', '+6283333333333', ?)").run(nowIso()).lastInsertRowid
  );
  for (const id of [a, b]) db.prepare('INSERT INTO property_contacts (property_id, contact_id) VALUES (?, ?)').run(id, contact);
  db.prepare("UPDATE properties SET status = 'rejected', flagged = 0 WHERE id = ?").run(a);

  const flaggedFrom = async (call, source) =>
    (await call({ method: 'GET', url: '/api/sources' })).json().sources.find((s) => s.id === source).stats.flagged;
  assert.equal(await flaggedFrom(philippCall, 'bhi'), 0, 'the home team rejected it');
  assert.equal(await flaggedFrom(marinaCall, 'bhi'), 1, "a home Reject does not un-feature it for Marina's team");

  const sideA = async (call) => {
    const { pairs } = (await call({ method: 'GET', url: '/api/duplicates?limit=30' })).json();
    const pair = pairs.find((p) => [p.a.id, p.b.id].includes(a) && [p.a.id, p.b.id].includes(b));
    assert.ok(pair, 'the pair is listed');
    return pair.a.id === a ? pair.a : pair.b;
  };
  assert.equal((await sideA(philippCall)).status, 'rejected');
  assert.equal((await sideA(marinaCall)).status, 'new', "Marina never reads the home team's pipeline status");
});

test("member: /api/runs says when the last run was, not what it found or changed", async (t) => {
  const { db, marinaCall, philippCall } = await setup(t);
  db.prepare(
    `INSERT INTO runs (started_at, finished_at, kind, notes, weight_changes, errors)
     VALUES ('2026-09-26T06:00:00.000Z', '2026-09-26T06:12:00.000Z', 'learn', '["edited by Philipp"]', '[]', '[]')`
  ).run();
  const res = await marinaCall({ method: 'GET', url: '/api/runs?limit=1' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.json()[0]).sort(), ['finished_at', 'id', 'kind', 'started_at']);
  const full = (await philippCall({ method: 'GET', url: '/api/runs?limit=1' })).json()[0];
  assert.ok('notes' in full, 'owners still get the whole run');
});

test('the admin bearer token (user 1, an owner) still passes the owner guard', async (t) => {
  const { bearerCall } = await setup(t);
  const reads = [
    ['GET', '/api/runs'],
    ['GET', '/api/notes'],
    ['GET', '/api/duplicates'],
    ['GET', '/api/import/status'],
  ];
  for (const [method, url] of reads) {
    const res = await bearerCall({ method, url });
    assert.equal(res.statusCode, 200, `${method} ${url} should pass for the bearer token`);
  }
});

test("a member's PATCH /api/config changes nothing", async (t) => {
  const { philippCall, marinaCall } = await setup(t);
  const before = (await philippCall({ method: 'GET', url: '/api/config' })).json();

  const res = await marinaCall({
    method: 'PATCH', url: '/api/config', payload: { flag_threshold: (before.flag_threshold || 65) + 5 },
  });
  assert.equal(res.statusCode, 403);

  const after = (await philippCall({ method: 'GET', url: '/api/config' })).json();
  assert.deepEqual(after, before, "a rejected member PATCH must not touch the shared brief");
});

// ---------------------------------------------------------------------------
// 2. stats.js — each team's own pipeline/activity, never another's
// ---------------------------------------------------------------------------

test("stats: a member's team counts only its own pipeline/activity; Philipp's numbers never move", async (t) => {
  const { db, ids, philippCall, marinaCall } = await setup(t);
  const propertyId = insertListing(db, { area: 'cemagi' });

  // Philipp (home team) shortlists it and rates it — writes straight to `properties`.
  writeListingState(db, { id: ids.philippId, team_id: HOME_TEAM_ID, role: 'owner' }, propertyId, { status: 'shortlist' });
  insertRating(db, { propertyId, by: ids.philippId, feature: 'quiet', score: 5 });

  const philippBefore = (await philippCall({ method: 'GET', url: '/api/stats' })).json();

  // Marina's team has never touched this listing: her overlay reads it as `new`, and
  // Philipp's rating (a different team) never appears in her activity.
  const marinaBefore = (await marinaCall({ method: 'GET', url: '/api/stats' })).json();
  const marinaPipelineBefore = Object.fromEntries(marinaBefore.pipeline.map((p) => [p.status, p.n]));
  assert.equal(marinaPipelineBefore.new, 1, "a team that never touched the listing sees it as 'new'");
  assert.equal(marinaPipelineBefore.shortlist, 0, "Philipp's shortlist never appears in Marina's pipeline");
  assert.equal(marinaBefore.activity.ratings, 0, "Philipp's rating never appears in Marina's activity");

  // Marina now shortlists and rates it herself — her own team_listings row / rating.
  writeListingState(db, { id: ids.marinaId, team_id: ids.marinaTeamId, role: 'member' }, propertyId, { status: 'shortlist' });
  insertRating(db, { propertyId, by: ids.marinaId, feature: 'quiet', score: 1 });

  const marinaAfter = (await marinaCall({ method: 'GET', url: '/api/stats' })).json();
  const marinaPipelineAfter = Object.fromEntries(marinaAfter.pipeline.map((p) => [p.status, p.n]));
  assert.equal(marinaPipelineAfter.shortlist, 1);
  assert.equal(marinaAfter.activity.ratings, 1);
  const marinaByUser = Object.fromEntries(marinaAfter.activity.by_user.map((u) => [u.name, u]));
  assert.deepEqual(Object.keys(marinaByUser), ['Marina'], "a solo team's by_user is just that person");
  assert.equal(marinaByUser.Marina.ratings, 1);

  // Nothing Marina did touched `properties` or the home team's rows, so Philipp's own
  // stats read back byte-for-byte the same.
  const philippAfter = (await philippCall({ method: 'GET', url: '/api/stats' })).json();
  assert.deepEqual(philippAfter.pipeline, philippBefore.pipeline, "a member's tap never moves Philipp's pipeline");
  assert.deepEqual(philippAfter.activity, philippBefore.activity, "a member's tap never moves Philipp's activity");
});

// ---------------------------------------------------------------------------
// 3. agent.js — the owners' morning digest is home-team only
// ---------------------------------------------------------------------------

test('agent digest excludes a member team’s feedback and viewings', async (t) => {
  const { app, db, ids } = await setup(t);
  const propertyId = insertListing(db, { area: 'seseh' });

  insertFeedback(db, { propertyId, by: ids.philippId, text: 'home team feedback, keep this' });
  insertFeedback(db, { propertyId, by: ids.marinaId, text: 'a friend’s feedback that must not leak' });
  insertViewing(db, { propertyId, by: ids.abigailId });
  insertViewing(db, { propertyId, by: ids.ronnieId });

  const res = await app.inject({ method: 'GET', url: `/api/agent/digest?token=${ENV.AGENT_TOKEN}` });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);

  assert.ok(body.feedback.some((f) => f.text === 'home team feedback, keep this'), 'home team feedback is present');
  assert.ok(!body.feedback.some((f) => f.text.includes('must not leak')), "a friend's feedback never reaches the digest");

  assert.ok(body.viewings.some((v) => v.by_name === ENV.USER2_NAME), 'home team viewing is present');
  assert.ok(!body.viewings.some((v) => v.by_name === 'Ronnie'), "a friend's viewing never reaches the digest");
});

// ---------------------------------------------------------------------------
// 4. learn.js — only home-team feedback is mined
// ---------------------------------------------------------------------------

test("learn: mines only home-team feedback; a member's feedback stays unapplied and untouched", async (t) => {
  const { db, ids } = await setup(t);
  const propertyId = insertListing(db, { area: 'munggu' });

  const homeFeedbackId = insertFeedback(db, { propertyId, by: ids.philippId, text: 'loved the garden' });
  const memberFeedbackId = insertFeedback(db, { propertyId, by: ids.marinaId, text: 'loved the garden' });

  const gardenBefore = getConfig(db).weights.garden;
  const result = await runLearn(db);

  assert.equal(result.feedback_applied, 1, "only the home team's feedback row was mined");
  assert.equal(getConfig(db).weights.garden, gardenBefore + 1, "the home row's reason still nudges the weight");

  const homeRow = db.prepare('SELECT applied FROM feedback WHERE id = ?').get(homeFeedbackId);
  const memberRow = db.prepare('SELECT applied FROM feedback WHERE id = ?').get(memberFeedbackId);
  assert.equal(homeRow.applied, 1);
  assert.equal(memberRow.applied, 0, "a member's feedback stays unapplied and untouched");
});
