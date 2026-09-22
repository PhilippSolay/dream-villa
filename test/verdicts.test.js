// Per-person verdicts (Yes / Maybe / No) and the shared-search filters built on them:
// match, waiting_other, waiting_me, disagree, unvoted. Two logins, one temp DB per test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
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

const SEED = ['A', 'B', 'C', 'D'].map((k, i) => ({
  key: `bhi:${k}`, ref: `RF${k}`, source: 'bhi', url: `https://bhi.test/${k}`, title: `Villa ${k}`,
  area: 'cemagi', beach_km: 1 + i, bedrooms: 2, price_month_idr: 40_000_000, term: 'monthly',
  pool: 1, status: 'new', availability: 'available',
}));

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-verdicts-'));
  const env = { ...ENV, IMAGES_DIR: path.join(dir, 'images') };
  const db = openDb(path.join(dir, 'villa.db'));
  seedUsers(db, env);
  for (const row of SEED) upsertProperty(db, { ...row, first_seen: '2026-09-10T00:00:00.000Z' }, { now: '2026-09-10T00:00:00.000Z' });
  rescoreAll(db);
  const ids = {};
  for (const r of db.prepare('SELECT id, key FROM properties').all()) ids[r.key.split(':')[1]] = r.id;
  const app = await buildServer({ db, env });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function loginAs(email, password) {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email, password } });
    assert.equal(res.statusCode, 200);
    const raw = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw).split(';')[0];
    return (opts) => app.inject({ ...opts, headers: { cookie, ...(opts.headers || {}) } });
  }
  const philipp = await loginAs(env.USER1_EMAIL, env.USER1_PASSWORD);
  const abigail = await loginAs(env.USER2_EMAIL, env.USER2_PASSWORD);
  const vote = (as, id, verdict) => as({ method: 'POST', url: `/api/properties/${id}/verdict`, payload: { verdict } });
  const list = async (as, params) => (await as({ method: 'GET', url: `/api/properties?scope=all&status=all&${params}` })).json();
  const keysOf = (rows) => rows.map((r) => r.key).sort();

  return { db, app, ids, philipp, abigail, vote, list, keysOf };
}

test('me: carries both people so the UI can name the other one', async (t) => {
  const { philipp } = await setup(t);
  const body = (await philipp({ method: 'GET', url: '/api/me' })).json();
  assert.equal(body.user.name, 'Philipp');
  assert.deepEqual(body.users.map((u) => u.name), ['Philipp', 'Abigail']);
  assert.equal(Object.keys(body.users[0]).sort().join(','), 'id,name', 'no emails in the roster');
});

test('verdict: upsert per person, replace on repeat, null removes', async (t) => {
  const { ids, philipp, abigail, vote } = await setup(t);

  let res = await vote(philipp, ids.A, 'maybe');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().verdicts.map((v) => [v.by_name, v.verdict]), [['Philipp', 'maybe']]);

  res = await vote(philipp, ids.A, 'yes');
  assert.deepEqual(res.json().verdicts.map((v) => [v.by_name, v.verdict]), [['Philipp', 'yes']], 'replaced, not appended');

  res = await vote(abigail, ids.A, 'no');
  assert.deepEqual(
    res.json().verdicts.map((v) => [v.by_name, v.verdict]).sort(),
    [['Abigail', 'no'], ['Philipp', 'yes']]
  );

  res = await vote(philipp, ids.A, null);
  assert.deepEqual(res.json().verdicts.map((v) => [v.by_name, v.verdict]), [['Abigail', 'no']], 'null clears mine only');

  res = await vote(philipp, ids.A, 'sure');
  assert.equal(res.statusCode, 400, 'only yes / maybe / no');
  res = await vote(philipp, 999_999, 'yes');
  assert.equal(res.statusCode, 404);
});

test('journey: a Yes shortlists a new listing, taking the last Yes back returns it to new', async (t) => {
  const { ids, philipp, abigail, vote } = await setup(t);
  const status = async (id) => (await philipp({ method: 'GET', url: `/api/properties/${id}` })).json();

  let row = (await vote(philipp, ids.A, 'yes')).json();
  assert.equal(row.status, 'shortlist', 'either person\'s Yes shortlists');
  assert.equal(row.status_by_name, 'Philipp');

  row = (await vote(abigail, ids.A, 'maybe')).json();
  assert.equal(row.status, 'shortlist', 'a Maybe from the other person leaves it shortlisted');

  row = (await vote(abigail, ids.A, 'yes')).json();
  row = (await vote(philipp, ids.A, null)).json();
  assert.equal(row.status, 'shortlist', 'her Yes still stands');

  row = (await vote(abigail, ids.A, 'no')).json();
  assert.equal(row.status, 'new', 'no Yes left: back to new');
  assert.equal(row.status_by_name, 'Abigail');

  // A No is a personal call: the status does not move.
  row = (await vote(philipp, ids.B, 'no')).json();
  assert.equal(row.status, 'new');
  row = (await vote(abigail, ids.B, 'no')).json();
  assert.equal(row.status, 'new', 'both No: still new, Reject stays a manual tap');

  // Further along the pipeline a Yes changes nothing.
  await philipp({ method: 'POST', url: `/api/properties/${ids.C}/status`, payload: { status: 'contacted' } });
  row = (await vote(abigail, ids.C, 'yes')).json();
  assert.equal(row.status, 'contacted');
  assert.equal((await status(ids.C)).status, 'contacted');
});

test('list and detail: rows carry verdicts and status_by_name', async (t) => {
  const { ids, philipp, abigail, vote, list } = await setup(t);
  await vote(abigail, ids.B, 'yes');
  await philipp({ method: 'POST', url: `/api/properties/${ids.B}/status`, payload: { status: 'shortlist' } });

  const rows = await list(philipp, 'sort=new');
  const b = rows.find((r) => r.key === 'bhi:B');
  assert.deepEqual(b.verdicts.map((v) => [v.by_name, v.verdict]), [['Abigail', 'yes']]);
  assert.equal(b.status_by_name, 'Philipp');
  const a = rows.find((r) => r.key === 'bhi:A');
  assert.deepEqual(a.verdicts, []);
  assert.equal(a.status_by_name, null);

  const detail = (await philipp({ method: 'GET', url: `/api/properties/${ids.B}` })).json();
  assert.deepEqual(detail.verdicts.map((v) => [v.by_name, v.verdict]), [['Abigail', 'yes']]);
  assert.equal(detail.status_by_name, 'Philipp');
});

test('list: verdict filters are relative to whoever is asking', async (t) => {
  const { ids, philipp, abigail, vote, list, keysOf } = await setup(t);
  // A: both yes (match). B: only Philipp voted. C: Philipp yes, Abigail no (disagree). D: nobody.
  await vote(philipp, ids.A, 'yes');
  await vote(abigail, ids.A, 'yes');
  await vote(philipp, ids.B, 'maybe');
  await vote(philipp, ids.C, 'yes');
  await vote(abigail, ids.C, 'no');

  assert.deepEqual(keysOf(await list(philipp, 'verdict=match')), ['bhi:A']);
  assert.deepEqual(keysOf(await list(abigail, 'verdict=match')), ['bhi:A']);

  assert.deepEqual(keysOf(await list(philipp, 'verdict=waiting_other')), ['bhi:B'], 'Philipp voted on B, Abigail has not');
  assert.deepEqual(keysOf(await list(abigail, 'verdict=waiting_me')), ['bhi:B'], "the same listing is Abigail's turn");
  assert.deepEqual(keysOf(await list(philipp, 'verdict=waiting_me')), []);
  assert.deepEqual(keysOf(await list(abigail, 'verdict=waiting_other')), []);

  assert.deepEqual(keysOf(await list(philipp, 'verdict=disagree')), ['bhi:C']);
  assert.deepEqual(keysOf(await list(abigail, 'verdict=disagree')), ['bhi:C']);

  assert.deepEqual(keysOf(await list(philipp, 'verdict=unvoted')), ['bhi:D']);

  // maybe: either person on the fence — B (Philipp's maybe) for both of them, never A, C or D.
  assert.deepEqual(keysOf(await list(philipp, 'verdict=maybe')), ['bhi:B']);
  assert.deepEqual(keysOf(await list(abigail, 'verdict=maybe')), ['bhi:B']);

  const bad = await philipp({ method: 'GET', url: '/api/properties?verdict=whatever' });
  assert.equal(bad.statusCode, 400);
});

test('list: waiting_other leaves out the listings the caller said No to', async (t) => {
  const { ids, philipp, abigail, vote, list, keysOf } = await setup(t);
  // Philipp alone has called A (yes), B (maybe) and C (no); D has no call at all.
  await vote(philipp, ids.A, 'yes');
  await vote(philipp, ids.B, 'maybe');
  await vote(philipp, ids.C, 'no');

  assert.deepEqual(keysOf(await list(philipp, 'verdict=waiting_other')), ['bhi:A', 'bhi:B'], 'a No is not something to wait on');
  assert.deepEqual(keysOf(await list(abigail, 'verdict=waiting_me')), ['bhi:A', 'bhi:B', 'bhi:C'], "Abigail's own turn still lists every call of his");
});

test('list: my_verdict filters on the caller\'s own call, none = not called yet', async (t) => {
  const { ids, philipp, abigail, vote, list, keysOf } = await setup(t);
  await vote(philipp, ids.A, 'yes');
  await vote(philipp, ids.B, 'maybe');
  await vote(philipp, ids.C, 'no');
  await vote(abigail, ids.D, 'yes');

  assert.deepEqual(keysOf(await list(philipp, 'my_verdict=yes')), ['bhi:A']);
  assert.deepEqual(keysOf(await list(philipp, 'my_verdict=maybe')), ['bhi:B']);
  assert.deepEqual(keysOf(await list(philipp, 'my_verdict=no')), ['bhi:C']);
  assert.deepEqual(keysOf(await list(philipp, 'my_verdict=none')), ['bhi:D'], "Abigail's yes on D is not Philipp's call");
  assert.deepEqual(keysOf(await list(abigail, 'my_verdict=yes')), ['bhi:D']);
  assert.deepEqual(keysOf(await list(abigail, 'my_verdict=none')), ['bhi:A', 'bhi:B', 'bhi:C']);

  // Combines with the shared filters: Philipp's yes that Abigail has not seen yet.
  assert.deepEqual(keysOf(await list(philipp, 'my_verdict=yes&verdict=waiting_other')), ['bhi:A']);

  const bad = await philipp({ method: 'GET', url: '/api/properties?my_verdict=sure' });
  assert.equal(bad.statusCode, 400);
});

test('list: shared yes and no mean either of you said it, unlike match', async (t) => {
  const { ids, philipp, abigail, vote, list, keysOf } = await setup(t);
  // A: both yes. B: Philipp maybe. C: Philipp yes, Abigail no. D: nobody.
  await vote(philipp, ids.A, 'yes');
  await vote(abigail, ids.A, 'yes');
  await vote(philipp, ids.B, 'maybe');
  await vote(philipp, ids.C, 'yes');
  await vote(abigail, ids.C, 'no');

  // yes: A (both) and C (Philipp's) — the same answer whoever asks.
  assert.deepEqual(keysOf(await list(philipp, 'verdict=yes')).sort(), ['bhi:A', 'bhi:C']);
  assert.deepEqual(keysOf(await list(abigail, 'verdict=yes')).sort(), ['bhi:A', 'bhi:C']);

  // no: only C, where Abigail said no.
  assert.deepEqual(keysOf(await list(philipp, 'verdict=no')), ['bhi:C']);
  assert.deepEqual(keysOf(await list(abigail, 'verdict=no')), ['bhi:C']);

  // match stays the stricter one: both said yes.
  assert.deepEqual(keysOf(await list(philipp, 'verdict=match')), ['bhi:A']);

  // my_verdict is the one that means only your own call: C is Philipp's yes, Abigail's no.
  assert.deepEqual(keysOf(await list(philipp, 'my_verdict=no')), []);
  assert.deepEqual(keysOf(await list(abigail, 'my_verdict=no')), ['bhi:C']);
});
