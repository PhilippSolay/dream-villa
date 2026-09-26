// Teams (SPEC §17): nobody's taps move what another team sees. Three teams on one temp DB:
// the home team (Philipp + Abigail, owners), Marina (a team of one) and Ronnie + Janel.
// Verdicts, pipeline status, notes, assessed, visits, ratings, feedback, agent info and
// places stay inside the team; listing facts are shared and only the owners edit them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { createUser, seedUsers } from '../src/auth.js';
import { createTeam } from '../src/teams.js';
import { buildServer } from '../src/server.js';
import { upsertProperty, rescoreAll } from '../src/scrape/store.js';

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

const FRIENDS = {
  marina: { email: 'marina@example.com', name: 'Marina', password: 'marina has a long passphrase' },
  ronnie: { email: 'ronnie@example.com', name: 'Ronnie', password: 'ronnie has a long passphrase' },
  janel: { email: 'janel@example.com', name: 'Janel', password: 'janel has a long passphrase' },
};

// A and D are featured picks (in filter, well scored, no red flags); B and C are plain
// in-filter listings. Every one has a pin so anchors have something to measure.
const base = (k, extra) => ({
  key: `bhi:${k}`, ref: `RF${k}`, source: 'bhi', url: `https://bhi.test/${k}`, title: `Villa ${k}`,
  area: 'cemagi', beach_km: 1, bedrooms: 2, price_month_idr: 40_000_000, term: 'monthly', pool: 1,
  status: 'new', availability: 'available', lat: -8.64, lng: 115.12, ...extra,
});
const featured = {
  beach_km: 0.9, furnished: 1, style: 'modern', garden: 1, view: 'ocean', aircon: 1, kitchen_full: 1,
  living_open: 1, airy: 1, land_m2: 150, build_m2: 120,
};
const SEED = [
  base('A', featured),
  base('B', { beach_km: 3 }),
  base('C', { beach_km: 4 }),
  base('D', { ...featured, lat: -8.61, lng: 115.15 }),
];

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-teams-'));
  const env = { ...ENV, IMAGES_DIR: path.join(dir, 'images') };
  const db = openDb(path.join(dir, 'villa.db'));
  seedUsers(db, env);
  for (const row of SEED) upsertProperty(db, { ...row, first_seen: '2026-09-10T00:00:00.000Z' }, { now: '2026-09-10T00:00:00.000Z' });
  rescoreAll(db);
  const ids = {};
  for (const r of db.prepare('SELECT id, key FROM properties').all()) ids[r.key.split(':')[1]] = r.id;

  const marinaTeam = createTeam(db, 'Marina');
  const rjTeam = createTeam(db, 'Ronnie & Janel');
  const userIds = {
    marina: createUser(db, { ...FRIENDS.marina, team_id: marinaTeam }),
    ronnie: createUser(db, { ...FRIENDS.ronnie, team_id: rjTeam }),
    janel: createUser(db, { ...FRIENDS.janel, team_id: rjTeam }),
  };

  const app = await buildServer({ db, env });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function loginAs(email, password) {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
    assert.equal(res.statusCode, 200, `login ${email}`);
    const raw = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw).split(';')[0];
    return (opts) => app.inject({ ...opts, headers: { cookie, ...(opts.headers || {}) } });
  }
  const as = {
    philipp: await loginAs(env.USER1_EMAIL, env.USER1_PASSWORD),
    abigail: await loginAs(env.USER2_EMAIL, env.USER2_PASSWORD),
    marina: await loginAs(FRIENDS.marina.email, FRIENDS.marina.password),
    ronnie: await loginAs(FRIENDS.ronnie.email, FRIENDS.ronnie.password),
    janel: await loginAs(FRIENDS.janel.email, FRIENDS.janel.password),
  };

  const ok = async (promise) => {
    const res = await promise;
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  const vote = (who, id, verdict) => ok(who({ method: 'POST', url: `/api/properties/${id}/verdict`, payload: { verdict } }));
  const setStatus = (who, id, status) => ok(who({ method: 'POST', url: `/api/properties/${id}/status`, payload: { status } }));
  const detail = (who, id) => ok(who({ method: 'GET', url: `/api/properties/${id}` }));
  const list = (who, params = '') => ok(who({ method: 'GET', url: `/api/properties?${params}` }));
  const all = (who, params = '') => list(who, `scope=all&status=all&${params}`);
  const keysOf = (rows) => rows.map((r) => r.key.split(':')[1]).sort();
  const byKey = (rows, k) => rows.find((r) => r.key === `bhi:${k}`);
  const stored = (id) => db.prepare('SELECT * FROM properties WHERE id = ?').get(id);

  return { db, app, ids, userIds, as, ok, vote, setStatus, detail, list, all, keysOf, byKey, stored };
}

test("Marina's calls, notes, visits, ratings and places are invisible to Philipp and to Ronnie", async (t) => {
  const { db, ids, as, ok, vote, setStatus, detail, list, all, keysOf, byKey, stored } = await setup(t);
  const { marina, philipp, ronnie } = as;
  const untouched = stored(ids.A);

  await vote(marina, ids.A, 'yes');
  await setStatus(marina, ids.B, 'rejected');
  await ok(marina({ method: 'PATCH', url: `/api/properties/${ids.A}`, payload: { notes: 'Marina likes the garden', assessed: 'partly' } }));
  await ok(marina({ method: 'POST', url: `/api/properties/${ids.A}/viewings`, payload: { quiet: 4, verdict: 'yes', notes: 'Marina visit' } }));
  await ok(marina({ method: 'POST', url: `/api/properties/${ids.A}/ratings`, payload: { feature: 'overall', score: 5 } }));
  await ok(marina({ method: 'POST', url: `/api/properties/${ids.A}/feedback`, payload: { text: 'Marina feedback' } }));
  await ok(marina({ method: 'POST', url: `/api/properties/${ids.A}/agent-info`, payload: { lease_terms: 'Marina lease' } }));
  const place = await ok(marina({ method: 'POST', url: '/api/anchors', payload: { name: 'Marina gym', location: '-8.64, 115.12' } }));

  // Marina sees all of it: her Yes shortlisted A for her team, her Reject hides B.
  const hers = await detail(marina, ids.A);
  assert.equal(hers.status, 'shortlist');
  assert.equal(hers.status_by_name, 'Marina');
  assert.equal(hers.notes, 'Marina likes the garden');
  assert.equal(hers.assessed, 'done', 'a visit with a verdict completes the assessment');
  assert.deepEqual(hers.verdicts.map((v) => [v.by_name, v.verdict]), [['Marina', 'yes']]);
  assert.equal(hers.viewings.length, 1);
  assert.equal(hers.ratings.length, 1);
  assert.equal(hers.feedback.length, 1);
  assert.equal(hers.agent_info.length, 1);
  assert.deepEqual(hers.anchors.map((a) => [a.name, a.km]), [['Marina gym', 0]]);
  assert.deepEqual(keysOf(await list(marina)), ['A', 'C', 'D'], 'her Reject hides B for her');
  assert.deepEqual(byKey(await list(marina), 'A').counts, { viewings: 1, ratings: 1, feedback: 1 });

  for (const [name, who] of [['Philipp', philipp], ['Ronnie', ronnie]]) {
    const row = await detail(who, ids.A);
    assert.equal(row.status, 'new', `${name}: Marina's Yes does not shortlist for anyone else`);
    assert.equal(row.status_by, null);
    assert.equal(row.notes, null, `${name}: notes are the team's`);
    assert.equal(row.assessed, 'not_yet', `${name}: assessed is the team's`);
    assert.deepEqual(row.verdicts, [], `${name}: verdicts are the team's`);
    assert.deepEqual([row.viewings, row.ratings, row.feedback, row.agent_info], [[], [], [], []], `${name}: visits and notes are the team's`);
    assert.deepEqual(row.anchors, [], `${name}: places are the team's`);

    const rows = await list(who);
    assert.deepEqual(keysOf(rows), ['A', 'B', 'C', 'D'], `${name}: Marina's Reject hides nothing here`);
    assert.deepEqual(byKey(rows, 'A').counts, { viewings: 0, ratings: 0, feedback: 0 });
    assert.deepEqual(await ok(who({ method: 'GET', url: '/api/anchors' })), []);
    assert.equal((await all(who, 'verdict=yes')).length, 0, `${name}: Marina's Yes is nobody else's`);
    assert.equal((await all(who, 'assessed=done')).length, 0);
    assert.equal((await who({ method: 'GET', url: `/api/properties?anchor=${place.id}&anchor_km=5` })).statusCode, 404,
      `${name}: another team's place cannot be filtered by`);
  }

  // Nothing of it landed on the shared row.
  const after = stored(ids.A);
  for (const col of ['status', 'status_by', 'status_at', 'notes', 'assessed', 'red_flags', 'flagged', 'fit_score']) {
    assert.deepEqual(after[col], untouched[col], `properties.${col} unchanged`);
  }
  assert.equal(stored(ids.B).status, 'new');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM team_listings').get().n, 2, 'her pipeline lives in team_listings');
});

test("Ronnie's Yes shortlists for Janel, not for Philipp; each team sees its own verdicts", async (t) => {
  const { ids, as, vote, detail, all, byKey, stored } = await setup(t);
  const { philipp, ronnie, janel } = as;

  await vote(philipp, ids.A, 'yes');
  await vote(ronnie, ids.A, 'yes');
  await vote(janel, ids.B, 'maybe');
  await vote(philipp, ids.B, 'no');

  const forJanel = await detail(janel, ids.A);
  assert.equal(forJanel.status, 'shortlist');
  assert.equal(forJanel.status_by_name, 'Ronnie');
  assert.deepEqual(forJanel.verdicts.map((v) => [v.by_name, v.verdict]), [['Ronnie', 'yes']]);

  const forPhilipp = await detail(philipp, ids.A);
  assert.equal(forPhilipp.status, 'shortlist', 'his own Yes shortlisted it for the home team');
  assert.equal(forPhilipp.status_by_name, 'Philipp');
  assert.deepEqual(forPhilipp.verdicts.map((v) => v.by_name), ['Philipp']);

  const rows = await all(ronnie);
  assert.deepEqual(byKey(rows, 'A').verdicts.map((v) => v.by_name), ['Ronnie']);
  assert.deepEqual(byKey(rows, 'B').verdicts.map((v) => [v.by_name, v.verdict]), [['Janel', 'maybe']], "Janel's, never Philipp's");

  // Ronnie takes his Yes back: no teammate's Yes is left, so A goes back to new for his
  // team — Philipp's Yes does not hold it there, and the home team's shortlist stands.
  await vote(ronnie, ids.A, null);
  assert.equal((await detail(janel, ids.A)).status, 'new');
  assert.equal((await detail(philipp, ids.A)).status, 'shortlist');
  assert.equal(stored(ids.A).status, 'shortlist');

  // And the other way round: a Yes from Ronnie on a listing the home team has not
  // touched leaves the owners' row alone.
  await vote(ronnie, ids.C, 'yes');
  assert.equal(stored(ids.C).status, 'new');
  assert.equal((await detail(philipp, ids.C)).status, 'new');
  assert.equal((await detail(janel, ids.C)).status, 'shortlist');
});

test('Shared filters: "other" means my teammates, never another team', async (t) => {
  const { ids, as, vote, all, keysOf } = await setup(t);
  const { philipp, abigail, marina, ronnie, janel } = as;

  await vote(philipp, ids.A, 'yes');
  await vote(philipp, ids.B, 'yes');
  await vote(ronnie, ids.C, 'yes');
  await vote(marina, ids.D, 'yes');

  assert.deepEqual(keysOf(await all(janel, 'verdict=waiting_me')), ['C'], "Janel waits on Ronnie's call only");
  assert.deepEqual(keysOf(await all(janel, 'verdict=unvoted')), ['A', 'B', 'D'], 'nobody on her team has called these');
  assert.deepEqual(keysOf(await all(janel, 'verdict=yes')), ['C']);
  assert.deepEqual(keysOf(await all(ronnie, 'verdict=waiting_other')), ['C']);

  assert.deepEqual(keysOf(await all(abigail, 'verdict=waiting_me')), ['A', 'B'], "Abigail waits on Philipp's calls only");
  assert.deepEqual(keysOf(await all(philipp, 'verdict=waiting_me')), [], "Ronnie's and Marina's calls are not Philipp's to answer");
  assert.deepEqual(keysOf(await all(philipp, 'verdict=unvoted')), ['C', 'D']);

  await vote(abigail, ids.A, 'yes');
  await vote(janel, ids.A, 'yes');
  assert.deepEqual(keysOf(await all(philipp, 'verdict=match')), ['A']);
  assert.deepEqual(keysOf(await all(ronnie, 'verdict=match')), [], "Janel's Yes on A matches nobody: Ronnie has not called it");
  assert.deepEqual(keysOf(await all(ronnie, 'verdict=waiting_me')), ['A']);

  assert.deepEqual(keysOf(await all(marina, 'verdict=waiting_me')), [], 'a team of one is never waited on');
  assert.deepEqual(keysOf(await all(marina, 'verdict=match')), []);
  assert.deepEqual(keysOf(await all(marina, 'my_verdict=yes')), ['D']);
});

test('flagged is per team: a Reject un-features a listing for its own team only', async (t) => {
  const { ids, as, setStatus, list, keysOf, stored } = await setup(t);
  const { philipp, marina } = as;

  assert.deepEqual(keysOf(await list(philipp, 'flagged=1')), ['A', 'D']);
  assert.deepEqual(keysOf(await list(marina, 'flagged=1')), ['A', 'D'], 'the flag rule is the same for everyone');

  const rejected = await setStatus(marina, ids.A, 'rejected');
  assert.equal(rejected.flagged, 0, 'the response is her view');
  assert.deepEqual(keysOf(await list(marina, 'flagged=1&status=all')), ['D']);
  assert.deepEqual(keysOf(await list(philipp, 'flagged=1')), ['A', 'D'], "Marina's Reject does not un-feature A for Philipp");
  assert.equal(stored(ids.A).flagged, 1);

  await setStatus(philipp, ids.D, 'rejected');
  assert.equal(stored(ids.D).flagged, 0, 'the home team keeps its stored flag');
  assert.deepEqual(keysOf(await list(philipp, 'flagged=1&status=all')), ['A']);
  assert.deepEqual(keysOf(await list(marina, 'flagged=1')), ['D'], "Philipp's Reject does not un-feature D for Marina");
});

test("Gone: the home team's is a fact for everyone; another team's is its own", async (t) => {
  const { ids, as, setStatus, detail, list, keysOf, stored } = await setup(t);
  const { philipp, abigail, marina } = as;

  await setStatus(philipp, ids.B, 'gone');
  const forMarina = await detail(marina, ids.B);
  assert.equal(forMarina.status, 'gone', 'the agent said it is let: that holds for everyone');
  assert.equal(forMarina.removed_reason, 'taken');
  assert.ok(forMarina.removed_at);
  assert.deepEqual(keysOf(await list(marina)), ['A', 'C', 'D']);
  assert.deepEqual(keysOf(await list(marina, 'removed=only&status=all')), ['B']);

  await setStatus(marina, ids.C, 'gone');
  const hers = await detail(marina, ids.C);
  assert.equal(hers.status, 'gone');
  assert.equal(hers.removed_reason, 'taken');
  assert.ok(hers.removed_at);
  assert.equal(stored(ids.C).removed_at, null, "her Gone never stamps the shared row");
  const his = await detail(philipp, ids.C);
  assert.equal(his.status, 'new');
  assert.equal(his.removed_at, null);
  assert.deepEqual(keysOf(await list(abigail)), ['A', 'C', 'D'], 'the home team still sees C');

  // Moving her status back off Gone brings it back for her alone.
  await setStatus(marina, ids.C, 'shortlist');
  const back = await detail(marina, ids.C);
  assert.equal(back.status, 'shortlist');
  assert.equal(back.removed_at, null);
});

test("PATCH: a member edits the team's notes and assessed; facts are the owners'", async (t) => {
  const { db, ids, as, ok, detail, stored } = await setup(t);
  const { philipp, ronnie, janel } = as;
  const before = stored(ids.A);

  let res = await ronnie({ method: 'PATCH', url: `/api/properties/${ids.A}`, payload: { living_open: 0 } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'owners_only');

  res = await ronnie({ method: 'PATCH', url: `/api/properties/${ids.A}`, payload: { notes: 'sneaky', lat: -8.7, lng: 115.2 } });
  assert.equal(res.statusCode, 403, 'one fact field refuses the whole PATCH');
  assert.deepEqual(stored(ids.A), before, 'nothing was written');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM team_listings').get().n, 0, 'not even the notes');

  const patched = await ok(ronnie({ method: 'PATCH', url: `/api/properties/${ids.A}`, payload: { notes: 'call the agent', assessed: 'partly' } }));
  assert.equal(patched.notes, 'call the agent');
  assert.equal(patched.assessed, 'partly');
  assert.equal((await detail(janel, ids.A)).notes, 'call the agent', 'the team shares its notes');
  assert.equal((await detail(philipp, ids.A)).notes, null);
  assert.deepEqual(stored(ids.A), before, 'the shared row is untouched');

  // Owners: facts and the home team's notes land on `properties`, as before teams.
  const owned = await ok(philipp({ method: 'PATCH', url: `/api/properties/${ids.A}`, payload: { style: 'joglo', notes: 'ours' } }));
  assert.equal(owned.style, 'joglo');
  assert.equal(owned.notes, 'ours');
  assert.equal(stored(ids.A).style, 'joglo');
  assert.equal(stored(ids.A).notes, 'ours');
  assert.equal((await detail(janel, ids.A)).style, 'joglo', 'a corrected fact is corrected for everyone');
  assert.equal((await detail(janel, ids.A)).notes, 'call the agent', 'but the notes stay each team\'s');
});

test('owner-only routes refuse a member; contacts stay readable', async (t) => {
  const { ids, as, ok } = await setup(t);
  const { philipp, ronnie, marina } = as;

  const contact = await ok(philipp({ method: 'POST', url: `/api/properties/${ids.A}/contacts`, payload: { name: 'Wayan', whatsapp: '+62 812 1' } }));

  const refused = [
    { method: 'POST', url: '/api/properties', payload: { url: 'https://bhi.test/new' } },
    { method: 'POST', url: '/api/properties', payload: { url: 'https://bhi.test/new2', title: 'Manual', area: 'cemagi' } },
    { method: 'POST', url: `/api/properties/${ids.A}/images`, payload: {} },
    { method: 'POST', url: `/api/properties/${ids.A}/contacts`, payload: { name: 'Made' } },
    { method: 'PATCH', url: `/api/contacts/${contact.id}`, payload: { name: 'Not Wayan' } },
  ];
  for (const who of [ronnie, marina]) {
    for (const req of refused) {
      const res = await who(req);
      assert.equal(res.statusCode, 403, `${req.method} ${req.url}`);
      assert.equal(res.json().error, 'owners_only');
    }
  }

  const book = await ok(ronnie({ method: 'GET', url: '/api/contacts' }));
  assert.deepEqual(book.map((c) => c.name), ['Wayan'], 'the name was not changed');
  assert.deepEqual(book[0].properties.map((p) => p.id), [ids.A]);
  assert.equal((await ok(ronnie({ method: 'GET', url: `/api/properties/${ids.A}` }))).contacts.length, 1);

  // The owners keep every one of them.
  assert.equal((await ok(philipp({ method: 'POST', url: '/api/properties', payload: { url: 'https://bhi.test/new' } }))).queued, true);
  assert.equal((await ok(philipp({ method: 'PATCH', url: `/api/contacts/${contact.id}`, payload: { responsiveness: 4 } }))).responsiveness, 4);
});

test("a member's visit, rating and agent info set no red flag on the shared row", async (t) => {
  const { ids, as, ok, detail, stored } = await setup(t);
  const { philipp, abigail, ronnie, janel } = as;
  const before = stored(ids.A);

  const visit = await ok(ronnie({
    method: 'POST', url: `/api/properties/${ids.A}/viewings`,
    payload: { quiet: 1, privacy: 1, construction_nearby: 5, notes: 'loud' },
  }));
  assert.equal(visit.by_name, 'Ronnie');
  await ok(ronnie({ method: 'POST', url: `/api/properties/${ids.A}/ratings`, payload: { feature: 'quiet', score: 1 } }));
  await ok(ronnie({ method: 'POST', url: `/api/properties/${ids.A}/agent-info`, payload: { planned_builds: 'construction next door' } }));

  const after = stored(ids.A);
  assert.equal(after.red_flags, before.red_flags);
  assert.equal(after.flagged, 1);
  assert.equal(after.assessed, 'not_yet');

  const forJanel = await detail(janel, ids.A);
  assert.equal(forJanel.assessed, 'partly', 'the visit assessed it for the team');
  assert.equal(forJanel.viewings.length, 1);
  assert.equal(forJanel.ratings.length, 1);
  assert.equal(forJanel.agent_info.length, 1);

  const forPhilipp = await detail(philipp, ids.A);
  assert.deepEqual(forPhilipp.red_flags, []);
  assert.equal(forPhilipp.flagged, 1);
  assert.deepEqual(forPhilipp.viewings, []);

  // The home team's visit still raises the flags, and Philipp sees Abigail's visit.
  await ok(abigail({ method: 'POST', url: `/api/properties/${ids.A}/viewings`, payload: { quiet: 1 } }));
  const home = await detail(philipp, ids.A);
  assert.deepEqual(home.red_flags, ['quiet_low']);
  assert.equal(home.flagged, 0);
  assert.equal(home.assessed, 'partly');
  assert.deepEqual(home.viewings.map((v) => v.by_name), ['Abigail']);
  assert.deepEqual((await detail(janel, ids.A)).red_flags, ['quiet_low'], 'a red flag is a shared fact once the owners raise it');
});

test('anchors: each team lists, filters by and deletes only its own', async (t) => {
  const { db, ids, as, ok, all, keysOf, byKey } = await setup(t);
  const { philipp, abigail, marina, ronnie, janel } = as;

  const home = await ok(philipp({ method: 'POST', url: '/api/anchors', payload: { name: 'Home gym', location: '-8.64, 115.12' } }));
  const rj = await ok(ronnie({ method: 'POST', url: '/api/anchors', payload: { name: 'RJ school', location: '-8.61, 115.15' } }));
  assert.equal(rj.by_name, 'Ronnie');

  assert.deepEqual((await ok(abigail({ method: 'GET', url: '/api/anchors' }))).map((a) => a.name), ['Home gym'], 'teammates share places');
  assert.deepEqual((await ok(janel({ method: 'GET', url: '/api/anchors' }))).map((a) => [a.name, a.by_name]), [['RJ school', 'Ronnie']]);
  assert.deepEqual(await ok(marina({ method: 'GET', url: '/api/anchors' })), []);

  const rows = await all(janel);
  assert.deepEqual(byKey(rows, 'D').anchors.map((a) => [a.name, a.km]), [['RJ school', 0]]);
  assert.deepEqual(keysOf(await all(janel, `anchor=${rj.id}&anchor_km=1`)), ['D']);
  assert.deepEqual(keysOf(await all(abigail, `anchor=${home.id}&anchor_km=1`)), ['A', 'B', 'C']);
  assert.equal((await janel({ method: 'GET', url: `/api/properties?anchor=${home.id}&anchor_km=5` })).statusCode, 404);
  assert.deepEqual((await ok(janel({ method: 'GET', url: `/api/properties/${ids.A}` }))).anchors.map((a) => a.name), ['RJ school']);

  assert.equal((await philipp({ method: 'DELETE', url: `/api/anchors/${rj.id}` })).statusCode, 404, "another team's place reads as missing");
  assert.equal((await marina({ method: 'DELETE', url: `/api/anchors/${home.id}` })).statusCode, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM anchors').get().n, 2, 'both still there');

  assert.equal((await janel({ method: 'DELETE', url: `/api/anchors/${rj.id}` })).statusCode, 200, "a teammate may delete Ronnie's place");
  assert.equal((await abigail({ method: 'DELETE', url: `/api/anchors/${home.id}` })).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM anchors').get().n, 0);
});

test('home team unchanged: owners share status, notes, verdicts and visits on `properties`', async (t) => {
  const { db, ids, as, ok, vote, setStatus, detail, all, byKey, stored } = await setup(t);
  const { philipp, abigail } = as;

  await setStatus(abigail, ids.C, 'contacted');
  await ok(abigail({ method: 'PATCH', url: `/api/properties/${ids.C}`, payload: { notes: 'Abigail called', assessed: 'partly' } }));
  await ok(abigail({ method: 'POST', url: `/api/properties/${ids.C}/ratings`, payload: { feature: 'light', score: 4 } }));
  await vote(abigail, ids.C, 'maybe');

  const row = await detail(philipp, ids.C);
  assert.equal(row.status, 'contacted');
  assert.equal(row.status_by_name, 'Abigail');
  assert.equal(row.notes, 'Abigail called');
  assert.equal(row.assessed, 'partly');
  assert.deepEqual(row.ratings.map((r) => r.by_name), ['Abigail']);
  assert.deepEqual(row.verdicts.map((v) => [v.by_name, v.verdict]), [['Abigail', 'maybe']]);
  assert.deepEqual(byKey(await all(philipp), 'C').counts, { viewings: 0, ratings: 1, feedback: 0 });

  const c = stored(ids.C);
  assert.deepEqual([c.status, c.notes, c.assessed], ['contacted', 'Abigail called', 'partly'], 'the home pipeline lives on properties');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM team_listings').get().n, 0, 'the home team never writes team_listings');

  // The ADMIN_TOKEN bearer is Philipp: an owner of the home team.
  const res = await as.philipp({ method: 'GET', url: `/api/properties/${ids.C}`, headers: { cookie: '', authorization: `Bearer ${ENV.ADMIN_TOKEN}` } });
  assert.equal(res.json().notes, 'Abigail called');
});
