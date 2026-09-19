// Anchors: the two people's own places (gym, school, co-working) with a distance on every
// listing and a "within X km of" filter. Plus the style filter on the list.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { upsertProperty, rescoreAll } from '../src/scrape/store.js';
import { haversineKm, parseLocation } from '../src/routes/anchors.js';

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

const base = (k, extra) => ({
  key: `bhi:${k}`, ref: `RF${k}`, source: 'bhi', url: `https://bhi.test/${k}`, title: `Villa ${k}`,
  area: 'cemagi', beach_km: 1, bedrooms: 2, price_month_idr: 40_000_000, term: 'monthly', pool: 1,
  status: 'new', availability: 'available', ...extra,
});

// Pererenan Beach is at -8.6475, 115.1185. A sits ~1 km north, B ~5 km north-east, C has no pin.
const SEED = [
  base('A', { lat: -8.638, lng: 115.1185, style: 'modern' }),
  base('B', { lat: -8.61, lng: 115.15, style: 'joglo' }),
  base('C', { lat: null, lng: null, style: 'tropical' }),
  base('D', { lat: -8.64, lng: 115.12, style: null }),
];

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-anchors-'));
  const env = { ...ENV, IMAGES_DIR: path.join(dir, 'images') };
  const db = openDb(path.join(dir, 'villa.db'));
  seedUsers(db, env);
  for (const row of SEED) upsertProperty(db, { ...row, first_seen: '2026-09-10T00:00:00.000Z' }, { now: '2026-09-10T00:00:00.000Z' });
  rescoreAll(db);
  const app = await buildServer({ db, env });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email: env.USER1_EMAIL, password: env.USER1_PASSWORD } });
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw).split(';')[0];
  const call = (opts) => app.inject({ ...opts, headers: { cookie, ...(opts.headers || {}) } });
  const list = async (params) => (await call({ method: 'GET', url: `/api/properties?scope=all&status=all&${params}` })).json();
  const keysOf = (rows) => rows.map((r) => r.key).sort();
  return { app, db, call, list, keysOf };
}

test('haversineKm and parseLocation: pure helpers', () => {
  assert.equal(Math.round(haversineKm(-8.6475, 115.1185, -8.638, 115.1185) * 10) / 10, 1.1, 'one degree of latitude is ~111 km');
  assert.equal(haversineKm(0, 0, 0, 0), 0);
  assert.deepEqual(parseLocation('-8.6475, 115.1185'), { lat: -8.6475, lng: 115.1185 });
  assert.deepEqual(parseLocation('https://www.google.com/maps/place/Finns/@-8.6475,115.1185,17z/data=!3m1'), { lat: -8.6475, lng: 115.1185 });
  assert.deepEqual(parseLocation('https://maps.google.com/?q=-8.65,115.13'), { lat: -8.65, lng: 115.13 });
  assert.deepEqual(parseLocation('https://www.google.com/maps/search/?api=1&query=-8.65%2C115.13'), { lat: -8.65, lng: 115.13 });
  assert.equal(parseLocation('somewhere nice'), null);
  assert.equal(parseLocation('95, 200'), null, 'out of range is not a location');
});

test('anchors: create, list, delete; attributed; validated', async (t) => {
  const { call } = await setup(t);
  let res = await call({ method: 'POST', url: '/api/anchors', payload: { name: 'Pererenan Beach', location: '-8.6475, 115.1185' } });
  assert.equal(res.statusCode, 200);
  const anchor = res.json();
  assert.equal(anchor.name, 'Pererenan Beach');
  assert.equal(anchor.lat, -8.6475);
  assert.equal(anchor.by_name, 'Philipp');

  res = await call({ method: 'POST', url: '/api/anchors', payload: { name: 'Nowhere', location: 'not a place' } });
  assert.equal(res.statusCode, 400);
  res = await call({ method: 'POST', url: '/api/anchors', payload: { name: '', location: '-8.6, 115.1' } });
  assert.equal(res.statusCode, 400);

  const listed = (await call({ method: 'GET', url: '/api/anchors' })).json();
  assert.equal(listed.length, 1);

  res = await call({ method: 'DELETE', url: `/api/anchors/${anchor.id}` });
  assert.equal(res.statusCode, 200);
  assert.equal((await call({ method: 'GET', url: '/api/anchors' })).json().length, 0);
  res = await call({ method: 'DELETE', url: `/api/anchors/${anchor.id}` });
  assert.equal(res.statusCode, 404);
});

test('rows carry a distance to every anchor; the anchor filter narrows by km', async (t) => {
  const { call, list, keysOf } = await setup(t);
  const beach = (await call({ method: 'POST', url: '/api/anchors', payload: { name: 'Beach', location: '-8.6475, 115.1185' } })).json();
  await call({ method: 'POST', url: '/api/anchors', payload: { name: 'Gym', location: '-8.61, 115.15' } });

  const rows = await list('sort=new');
  const a = rows.find((r) => r.key === 'bhi:A');
  assert.deepEqual(a.anchors.map((x) => x.name), ['Beach', 'Gym']);
  assert.equal(a.anchors[0].km, 1.1);
  assert.equal(rows.find((r) => r.key === 'bhi:B').anchors[1].km, 0, 'B sits on the gym');
  assert.deepEqual(rows.find((r) => r.key === 'bhi:C').anchors.map((x) => x.km), [null, null], 'no pin, no distance');

  assert.deepEqual(keysOf(await list(`anchor=${beach.id}&anchor_km=2`)), ['bhi:A', 'bhi:D']);
  assert.deepEqual(keysOf(await list(`anchor=${beach.id}&anchor_km=10`)), ['bhi:A', 'bhi:B', 'bhi:D'], 'C has no pin and never matches a distance filter');
  assert.equal((await call({ method: 'GET', url: '/api/properties?anchor=999999&anchor_km=2' })).statusCode, 404);
  assert.equal((await call({ method: 'GET', url: `/api/properties?anchor=${beach.id}` })).statusCode, 400, 'anchor without a radius is meaningless');

  const detail = (await call({ method: 'GET', url: `/api/properties/${a.id}` })).json();
  assert.equal(detail.anchors[0].km, 1.1);
});

test('style filter: comma list, validated', async (t) => {
  const { list, keysOf, call } = await setup(t);
  assert.deepEqual(keysOf(await list('style=modern')), ['bhi:A']);
  assert.deepEqual(keysOf(await list('style=modern,joglo')), ['bhi:A', 'bhi:B']);
  assert.equal((await call({ method: 'GET', url: '/api/properties?style=brutalist' })).statusCode, 400);
});
