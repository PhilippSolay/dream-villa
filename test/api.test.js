// SPEC §4 — the app's HTTP API. One temp DB per test, a handful of seeded listings,
// and a single login whose cookie every request reuses.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import sharp from 'sharp';

import { openDb, nowIso } from '../src/db.js';
import { seedUsers, registerAuth } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { upsertProperty, rescoreAll } from '../src/scrape/store.js';
import { percentiles } from '../src/routes/market.js';
import adminRoutes from '../src/routes/admin.js';

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

// ---------------------------------------------------------------------------
// Seed data — six listings chosen so every filter has something to bite on.
// ---------------------------------------------------------------------------

const SEED = [
  {
    key: 'bhi:A', ref: 'RFA', source: 'bhi', url: 'https://bhi.test/a', title: 'Ocean View Villa in Cemagi',
    description: 'Bright open living with a pool', area: 'cemagi', sub_area: 'Beach Side',
    beach_km: 0.9, beach_source: 'computed', bedrooms: 2, extra_rooms: 0, price_month_idr: 40_000_000,
    term: 'monthly', furnished: 1, style: 'modern', pool: 1, garden: 1, view: 'ocean', joglo: 0,
    aircon: 1, kitchen_full: 1, living_open: 1, airy: 1, status: 'new', land_m2: 150, build_m2: 120,
    images: [{ src_url: 'https://bhi.test/a1.jpg' }], availability: 'available',
  },
  {
    key: 'bhi:B', ref: 'RFB', source: 'bhi', url: 'https://bhi.test/b', title: 'Quiet Family House Seseh',
    description: 'Simple house, unfurnished', area: 'seseh', sub_area: 'Residential Side',
    beach_km: null, bedrooms: 3, extra_rooms: 0, price_month_idr: 30_000_000,
    term: 'yearly', furnished: 0, pool: 0, garden: 0, status: 'new', availability: 'available',
  },
  {
    key: 'bhi:C', ref: 'RFC', source: 'bhi', url: 'https://bhi.test/c', title: 'Rejected Villa Pererenan',
    area: 'pererenan', beach_km: 3.5, bedrooms: 2, price_month_idr: 45_000_000, term: 'monthly',
    pool: 1, status: 'rejected', availability: 'available',
  },
  {
    key: 'bhi:D', ref: 'RFD', source: 'bhi', url: 'https://bhi.test/d', title: 'Big Cliff House Uluwatu',
    area: 'uluwatu', beach_km: 1.2, bedrooms: 4, price_month_idr: 60_000_000, term: 'monthly',
    pool: 1, status: 'new', availability: 'available', build_m2: 200,
  },
  {
    key: 'bhi:E', ref: 'RFE', source: 'bhi', url: 'https://bhi.test/e', title: 'Gone Cottage Munggu',
    area: 'munggu', beach_km: 2.0, bedrooms: 1, extra_rooms: 1, price_month_idr: 28_000_000,
    term: 'monthly', garden: 1, status: 'new', availability: 'gone',
  },
  {
    key: 'olx:F', ref: 'RFF', source: 'olx', url: 'https://olx.test/f', title: 'Joglo Villa Cemagi',
    description: 'A traditional joglo with a garden', area: 'cemagi', sub_area: 'Tumbak Bayuh',
    beach_km: 5.5, bedrooms: 2, price_month_idr: 35_000_000, term: 'both', joglo: 1, garden: 1,
    status: 'new', availability: 'available', hero_file: 'x/1.jpg',
  },
];

function seedProperties(db) {
  for (const row of SEED) upsertProperty(db, { ...row, first_seen: '2026-09-10T00:00:00.000Z' }, { now: '2026-09-10T00:00:00.000Z' });
  rescoreAll(db);
  const ids = {};
  for (const r of db.prepare('SELECT id, key FROM properties').all()) ids[r.key.split(':')[1]] = r.id;
  return ids;
}

async function setup(t, { seed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-api-'));
  const env = { ...ENV, IMAGES_DIR: path.join(dir, 'images') };
  const db = openDb(path.join(dir, 'villa.db'));
  seedUsers(db, env);
  const ids = seed ? seedProperties(db) : {};
  const app = await buildServer({ db, env });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const login = await app.inject({
    method: 'POST', url: '/api/login',
    payload: { email: env.USER1_EMAIL, password: env.USER1_PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw).split(';')[0];

  const call = (opts) => app.inject({ ...opts, headers: { cookie, ...(opts.headers || {}) } });
  return { db, app, env, dir, ids, cookie, call };
}

/** Hand-rolled multipart body — light-my-request takes a raw payload + content-type. */
function multipart(fields = {}, files = []) {
  const boundary = `----villa${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n` +
          'Content-Type: image/jpeg\r\n\r\n'
      )
    );
    chunks.push(f.buffer);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

let jpegCache = null;
async function tinyJpeg() {
  if (!jpegCache) {
    jpegCache = await sharp({ create: { width: 24, height: 16, channels: 3, background: { r: 200, g: 150, b: 60 } } })
      .jpeg()
      .toBuffer();
  }
  return jpegCache;
}

const keysOf = (rows) => rows.map((r) => r.key).sort();

// ---------------------------------------------------------------------------
// GET /api/properties — filters and sort
// ---------------------------------------------------------------------------

test('list: defaults to in_filter, hides rejected and gone', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/properties' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(keysOf(res.json()), ['bhi:A', 'bhi:B', 'olx:F']);
});

test('list: scope=all&status=all&hide_gone=0 returns everything', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/properties?scope=all&status=all&hide_gone=0' });
  assert.equal(res.json().length, SEED.length);
});

test('list: X-Total-Count is the full match count, limit/offset page through it', async (t) => {
  const { call } = await setup(t);
  const base = '/api/properties?scope=all&status=all&hide_gone=0&sort=new';
  const all = await call({ method: 'GET', url: base });
  assert.equal(all.headers['x-total-count'], String(SEED.length));

  const first = await call({ method: 'GET', url: `${base}&limit=4` });
  assert.equal(first.json().length, 4);
  assert.equal(first.headers['x-total-count'], String(SEED.length), 'total ignores the page size');

  const rest = await call({ method: 'GET', url: `${base}&limit=4&offset=4` });
  assert.equal(rest.json().length, SEED.length - 4);
  assert.deepEqual([...keysOf(first.json()), ...keysOf(rest.json())].sort(), keysOf(all.json()).sort());

  const filtered = await call({ method: 'GET', url: '/api/properties?area=cemagi' });
  assert.equal(filtered.headers['x-total-count'], String(filtered.json().length), 'total follows the filters');
});

test('list: sort=size puts the biggest build first, unmeasured last', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/properties?scope=all&status=all&hide_gone=0&sort=size' });
  const keys = res.json().map((r) => r.key); // in API order — keysOf() sorts
  assert.deepEqual(keys.slice(0, 2), ['bhi:D', 'bhi:A'], '200 m² then 120 m²');
  assert.equal(keys.length, SEED.length);
});

test('status: gone is a person-set end state, hidden like rejected, shown with removed=', async (t) => {
  const { call, ids } = await setup(t);
  const set = await call({ method: 'POST', url: `/api/properties/${ids.A}/status`, payload: { status: 'gone' } });
  assert.equal(set.statusCode, 200);
  assert.equal(set.json().status, 'gone');
  assert.equal(set.json().flagged, 0, 'a gone listing is never a featured pick');
  assert.ok(set.json().removed_at, 'carries the moment it was marked');

  const dflt = keysOf((await call({ method: 'GET', url: '/api/properties?scope=all' })).json());
  assert.ok(!dflt.includes('bhi:A'), 'hidden from the default list');

  const only = keysOf((await call({ method: 'GET', url: '/api/properties?scope=all&status=all&removed=only' })).json());
  assert.deepEqual(only, ['bhi:A', 'bhi:E'], 'removed=only lists it beside the scraper-detected gone');

  const byStatus = keysOf((await call({ method: 'GET', url: '/api/properties?scope=all&status=gone&removed=show' })).json());
  assert.deepEqual(byStatus, ['bhi:A']);
});

test('list: scope=market shows only out-of-filter rows', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/properties?scope=market' });
  assert.deepEqual(keysOf(res.json()), ['bhi:D']);
});

test('list: rows carry hero_url, reasons, contacts and counts', async (t) => {
  const { call } = await setup(t);
  const rows = (await call({ method: 'GET', url: '/api/properties' })).json();
  const a = rows.find((r) => r.key === 'bhi:A');
  const f = rows.find((r) => r.key === 'olx:F');
  assert.equal(a.hero_url, 'https://bhi.test/a1.jpg', 'no local file yet → the source URL');
  assert.equal(f.hero_url, '/images/x/1.jpg', 'hero_file wins');
  assert.ok(a.reasons.includes('Cemagi'));
  assert.deepEqual(a.contacts, []);
  assert.deepEqual(a.counts, { viewings: 0, ratings: 0, feedback: 0 });
  assert.equal('raw' in a, false, 'raw is debug-only and stays out of the list');
});

test('list: area filter', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/properties?area=seseh' });
  assert.deepEqual(keysOf(res.json()), ['bhi:B']);
});

test('list: area accepts a comma list and rejects an unknown area', async (t) => {
  const { call } = await setup(t);
  const ok = await call({ method: 'GET', url: '/api/properties?area=seseh,cemagi' });
  assert.deepEqual(keysOf(ok.json()), ['bhi:A', 'bhi:B', 'olx:F']);
  const bad = await call({ method: 'GET', url: '/api/properties?area=narnia' });
  assert.equal(bad.statusCode, 400);
});

test('list: bedrooms filter', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/properties?bedrooms=2' });
  assert.deepEqual(keysOf(res.json()), ['bhi:A', 'olx:F']);
});

test('list: features=pool keeps only truthy rows', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/properties?features=pool' });
  assert.deepEqual(keysOf(res.json()), ['bhi:A']);
});

test('list: features=garden,view combines and an unknown feature is a 400', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/properties?features=garden,view' });
  assert.deepEqual(keysOf(res.json()), ['bhi:A']);
  const bad = await call({ method: 'GET', url: '/api/properties?features=jacuzzi' });
  assert.equal(bad.statusCode, 400);
});

test('list: beach is soft — rows with an unknown distance stay in', async (t) => {
  const { call } = await setup(t);
  const rows = (await call({ method: 'GET', url: '/api/properties?beach=1' })).json();
  assert.deepEqual(keysOf(rows), ['bhi:A', 'bhi:B']);
  assert.equal(rows.find((r) => r.key === 'bhi:B').beach_km, null);
});

test('list: min/max price', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/properties?min=32000000&max=41000000' });
  assert.deepEqual(keysOf(res.json()), ['bhi:A', 'olx:F']);
});

test('list: land_min excludes a smaller row and keeps rows with no land recorded', async (t) => {
  const { call } = await setup(t);
  // bhi:A has land_m2=150; bhi:B and olx:F have no land_m2 (NULL passes, like beach).
  const res = await call({ method: 'GET', url: '/api/properties?land_min=200' });
  assert.deepEqual(keysOf(res.json()), ['bhi:B', 'olx:F']);
});

test('list: build_max excludes a bigger row', async (t) => {
  const { call } = await setup(t);
  // bhi:D has build_m2=200; every other row has no build_m2 (NULL passes).
  const res = await call({ method: 'GET', url: '/api/properties?scope=all&status=all&hide_gone=0&build_max=150' });
  assert.deepEqual(keysOf(res.json()), ['bhi:A', 'bhi:B', 'bhi:C', 'bhi:E', 'olx:F']);
});

test('list: land/build filters reject non-integer or negative values with a 400', async (t) => {
  const { call } = await setup(t);
  const bad = await Promise.all([
    call({ method: 'GET', url: '/api/properties?land_min=abc' }),
    call({ method: 'GET', url: '/api/properties?land_max=-5' }),
    call({ method: 'GET', url: '/api/properties?build_min=abc' }),
    call({ method: 'GET', url: '/api/properties?build_max=-5' }),
  ]);
  for (const res of bad) assert.equal(res.statusCode, 400);
});

test('list: q matches title, description and sub_area', async (t) => {
  const { call } = await setup(t);
  assert.deepEqual(keysOf((await call({ method: 'GET', url: '/api/properties?q=joglo' })).json()), ['olx:F']);
  assert.deepEqual(keysOf((await call({ method: 'GET', url: '/api/properties?q=unfurnished' })).json()), ['bhi:B']);
  assert.deepEqual(keysOf((await call({ method: 'GET', url: '/api/properties?q=Tumbak' })).json()), ['olx:F']);
});

test('list: term, furnished and source filters', async (t) => {
  const { call } = await setup(t);
  // 'both' satisfies a yearly request as well as a monthly one.
  assert.deepEqual(keysOf((await call({ method: 'GET', url: '/api/properties?term=yearly' })).json()), ['bhi:B', 'olx:F']);
  assert.deepEqual(keysOf((await call({ method: 'GET', url: '/api/properties?term=monthly' })).json()), ['bhi:A', 'olx:F']);
  assert.deepEqual(keysOf((await call({ method: 'GET', url: '/api/properties?furnished=0' })).json()), ['bhi:B']);
  assert.deepEqual(keysOf((await call({ method: 'GET', url: '/api/properties?source=olx' })).json()), ['olx:F']);
});

test('list: status=rejected shows the rejected row', async (t) => {
  const { call } = await setup(t);
  assert.deepEqual(keysOf((await call({ method: 'GET', url: '/api/properties?status=rejected' })).json()), ['bhi:C']);
  const bad = await call({ method: 'GET', url: '/api/properties?status=nope' });
  assert.equal(bad.statusCode, 400);
});

test('list: flagged=1 and assessed filters', async (t) => {
  const { call } = await setup(t);
  const flagged = (await call({ method: 'GET', url: '/api/properties?flagged=1' })).json();
  assert.deepEqual(keysOf(flagged), ['bhi:A']);
  const notYet = (await call({ method: 'GET', url: '/api/properties?assessed=not_yet' })).json();
  assert.equal(notYet.length, 3);
});

test('list: sort=price is ascending, sort=beach puts unknowns last', async (t) => {
  const { call } = await setup(t);
  const prices = (await call({ method: 'GET', url: '/api/properties?scope=all&status=all&hide_gone=0&sort=price' }))
    .json()
    .map((r) => r.price_month_idr);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  assert.equal(prices[0], 28_000_000);

  const beach = (await call({ method: 'GET', url: '/api/properties?sort=beach' })).json().map((r) => r.beach_km);
  assert.deepEqual(beach, [0.9, 5.5, null]);
});

test('list: limit/offset page through the result', async (t) => {
  const { call } = await setup(t);
  const page = (await call({ method: 'GET', url: '/api/properties?sort=price&limit=1&offset=1' })).json();
  assert.equal(page.length, 1);
  assert.equal(page[0].key, 'olx:F');
  const tooBig = await call({ method: 'GET', url: '/api/properties?limit=5000' });
  assert.equal(tooBig.statusCode, 400);
});

// ---------------------------------------------------------------------------
// GET /api/properties — age of post, removed listings
// ---------------------------------------------------------------------------

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Adds an old row, a yesterday row, and an `unlisted` row (SEED's bhi:E is `gone`). */
async function setupAgeAndRemoved(t) {
  const ctx = await setup(t);
  upsertProperty(
    ctx.db,
    {
      key: 'bhi:OLD', ref: 'RFOLD', source: 'bhi', url: 'https://bhi.test/old', title: 'Old Listing Cemagi',
      area: 'cemagi', bedrooms: 2, price_month_idr: 40_000_000, term: 'monthly', status: 'new',
      availability: 'available', first_seen: isoDaysAgo(30),
    },
    { now: isoDaysAgo(30) }
  );
  upsertProperty(
    ctx.db,
    {
      key: 'bhi:NEW', ref: 'RFNEW', source: 'bhi', url: 'https://bhi.test/new', title: 'New Listing Cemagi',
      area: 'cemagi', bedrooms: 2, price_month_idr: 40_000_000, term: 'monthly', status: 'new',
      availability: 'available', first_seen: isoDaysAgo(1),
    },
    { now: isoDaysAgo(1) }
  );
  upsertProperty(
    ctx.db,
    {
      key: 'bhi:UNLISTED', ref: 'RFUNL', source: 'bhi', url: 'https://bhi.test/unlisted', title: 'Unlisted Villa Cemagi',
      area: 'cemagi', bedrooms: 2, price_month_idr: 40_000_000, term: 'monthly', status: 'new',
      availability: 'unlisted', first_seen: isoDaysAgo(20),
    },
    { now: isoDaysAgo(5) }
  );
  return ctx;
}

test('list: max_age_days=7 excludes a row first seen 30 days ago and keeps one from yesterday', async (t) => {
  const { call } = await setupAgeAndRemoved(t);
  const keys = keysOf(
    (await call({ method: 'GET', url: '/api/properties?scope=all&status=all&max_age_days=7' })).json()
  );
  assert.ok(keys.includes('bhi:NEW'), 'a row from yesterday stays in');
  assert.ok(!keys.includes('bhi:OLD'), 'a row from 30 days ago is excluded');
});

test('list: max_age_days=0 is a 400', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/properties?max_age_days=0' });
  assert.equal(res.statusCode, 400);
});

test('list: removed=only returns only gone/unlisted rows', async (t) => {
  const { call } = await setupAgeAndRemoved(t);
  const keys = keysOf(
    (await call({ method: 'GET', url: '/api/properties?scope=all&status=all&removed=only' })).json()
  );
  assert.deepEqual(keys, ['bhi:E', 'bhi:UNLISTED']);
});

test('list: removed=show includes gone/unlisted rows, sorted after live ones', async (t) => {
  const { call } = await setupAgeAndRemoved(t);
  const rows = (await call({ method: 'GET', url: '/api/properties?scope=all&status=all&removed=show' })).json();
  assert.equal(rows.length, SEED.length + 3);
  const removedFlags = rows.map((r) => r.availability === 'gone' || r.availability === 'unlisted');
  const firstRemoved = removedFlags.indexOf(true);
  assert.ok(firstRemoved > -1, 'at least one removed row is present');
  assert.ok(removedFlags.slice(firstRemoved).every(Boolean), 'every row after the first removed one is also removed');
  const removedAt = rows.find((r) => r.key === 'bhi:E').removed_at;
  assert.ok(removedAt, 'a removed row carries a computed removed_at');
});

test('list: hide_gone=0 still works and returns everything', async (t) => {
  const { call } = await setupAgeAndRemoved(t);
  const rows = (await call({ method: 'GET', url: '/api/properties?scope=all&status=all&hide_gone=0' })).json();
  assert.equal(rows.length, SEED.length + 3);
});

test('list: hide_gone=1 (default) still hides gone and unlisted rows', async (t) => {
  const { call } = await setupAgeAndRemoved(t);
  const keys = keysOf((await call({ method: 'GET', url: '/api/properties?scope=all&status=all' })).json());
  assert.ok(!keys.includes('bhi:E'));
  assert.ok(!keys.includes('bhi:UNLISTED'));
});

// ---------------------------------------------------------------------------
// GET /api/properties/:id
// ---------------------------------------------------------------------------

test('detail: returns the row plus its child collections', async (t) => {
  const { call, ids } = await setup(t);
  const res = await call({ method: 'GET', url: `/api/properties/${ids.A}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.key, 'bhi:A');
  assert.deepEqual(body.image_urls, ['https://bhi.test/a1.jpg']);
  assert.deepEqual(body.contacts, []);
  assert.deepEqual(body.agent_info, []);
  assert.deepEqual(body.viewings, []);
  assert.deepEqual(body.ratings, []);
  assert.deepEqual(body.feedback, []);
  assert.ok(Array.isArray(body.price_history));
  assert.ok(Array.isArray(body.reasons));
});

test('detail: unknown id is 404 not_found', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/properties/99999' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { error: 'not_found' });
});

// ---------------------------------------------------------------------------
// PATCH /api/properties/:id
// ---------------------------------------------------------------------------

test('patch: an unknown field is a 400', async (t) => {
  const { call, ids } = await setup(t);
  const res = await call({ method: 'PATCH', url: `/api/properties/${ids.B}`, payload: { price_month_idr: 1 } });
  assert.equal(res.statusCode, 400);
});

test('patch: living_open moves the fit score', async (t) => {
  const { call, ids } = await setup(t);
  const before = (await call({ method: 'GET', url: `/api/properties/${ids.B}` })).json().fit_score;
  const res = await call({ method: 'PATCH', url: `/api/properties/${ids.B}`, payload: { living_open: 1 } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().living_open, 1);
  assert.ok(res.json().fit_score > before, `${res.json().fit_score} > ${before}`);
});

test('patch: notes and assessed round-trip', async (t) => {
  const { call, ids } = await setup(t);
  const res = await call({ method: 'PATCH', url: `/api/properties/${ids.A}`, payload: { notes: 'call the owner', assessed: 'partly' } });
  assert.equal(res.json().notes, 'call the owner');
  assert.equal(res.json().assessed, 'partly');
});

test('patch: lat/lng set pin_source=agent, recompute map_url and beach', async (t) => {
  const { call, ids } = await setup(t);
  const res = await call({ method: 'PATCH', url: `/api/properties/${ids.B}`, payload: { lat: -8.6315, lng: 115.0975 } });
  const row = res.json();
  assert.equal(row.pin_source, 'agent');
  assert.equal(row.map_url, 'https://www.google.com/maps?q=-8.6315,115.0975');
  assert.equal(row.beach_source, 'computed');
  assert.ok(row.beach_km >= 0 && row.beach_km < 0.5);
});

test('patch: a hand-set beach_km wins and is marked beach_source=person', async (t) => {
  const { call, ids } = await setup(t);
  const res = await call({ method: 'PATCH', url: `/api/properties/${ids.A}`, payload: { beach_km: 2.4 } });
  assert.equal(res.json().beach_km, 2.4);
  assert.equal(res.json().beach_source, 'person');
});

test('patch: red_flags drop the flag', async (t) => {
  const { call, ids } = await setup(t);
  const res = await call({ method: 'PATCH', url: `/api/properties/${ids.A}`, payload: { red_flags: ['main_road'] } });
  assert.deepEqual(res.json().red_flags, ['main_road']);
  assert.equal(res.json().flagged, 0);
});

// ---------------------------------------------------------------------------
// Status, ratings, feedback, agent info
// ---------------------------------------------------------------------------

test('status: rejected drops flagged and records who and when', async (t) => {
  const { call, db, ids } = await setup(t);
  const res = await call({ method: 'POST', url: `/api/properties/${ids.A}/status`, payload: { status: 'rejected' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'rejected');
  assert.equal(res.json().flagged, 0);
  const row = db.prepare('SELECT status_by, status_at FROM properties WHERE id = ?').get(ids.A);
  assert.equal(row.status_by, 1);
  assert.match(row.status_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test('status: an unknown status is a 400', async (t) => {
  const { call, ids } = await setup(t);
  const res = await call({ method: 'POST', url: `/api/properties/${ids.A}/status`, payload: { status: 'maybe' } });
  assert.equal(res.statusCode, 400);
});

test('ratings: quiet=2 adds quiet_low and unflags the villa', async (t) => {
  const { call, ids } = await setup(t);
  const before = (await call({ method: 'GET', url: `/api/properties/${ids.A}` })).json();
  assert.equal(before.flagged, 1);

  const res = await call({ method: 'POST', url: `/api/properties/${ids.A}/ratings`, payload: { feature: 'quiet', score: 2, comment: 'dogs' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().by, 1);
  assert.equal(res.json().by_name, 'Philipp');
  assert.match(res.json().created_at, /Z$/);

  const after = (await call({ method: 'GET', url: `/api/properties/${ids.A}` })).json();
  assert.deepEqual(after.red_flags, ['quiet_low']);
  assert.equal(after.flagged, 0);
  assert.equal(after.ratings.length, 1);
});

test('ratings: a good score leaves the flags alone; a bad score is a 400', async (t) => {
  const { call, ids } = await setup(t);
  await call({ method: 'POST', url: `/api/properties/${ids.A}/ratings`, payload: { feature: 'overall', score: 5 } });
  const style = await call({ method: 'POST', url: `/api/properties/${ids.A}/ratings`, payload: { feature: 'style', score: 4 } });
  assert.equal(style.statusCode, 200, 'style is a rating feature');
  const after = (await call({ method: 'GET', url: `/api/properties/${ids.A}` })).json();
  assert.deepEqual(after.red_flags, []);
  assert.equal(after.flagged, 1);
  const bad = await call({ method: 'POST', url: `/api/properties/${ids.A}/ratings`, payload: { feature: 'overall', score: 9 } });
  assert.equal(bad.statusCode, 400);
});

test('feedback: stored unapplied, then marked applied with a note', async (t) => {
  const { call, ids } = await setup(t);
  const created = await call({ method: 'POST', url: `/api/properties/${ids.A}/feedback`, payload: { text: 'too noisy at night' } });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().applied, 0);
  assert.equal(created.json().by, 1);

  const applied = await call({ method: 'POST', url: `/api/feedback/${created.json().id}/applied`, payload: { note: 'quiet +2' } });
  assert.equal(applied.json().applied, 1);
  assert.equal(applied.json().applied_note, 'quiet +2');

  const missing = await call({ method: 'POST', url: '/api/feedback/9999/applied', payload: { note: 'x' } });
  assert.equal(missing.statusCode, 404);
});

test('agent-info: stores the answers and JSON-encodes `included`', async (t) => {
  const { call, ids } = await setup(t);
  const res = await call({
    method: 'POST', url: `/api/properties/${ids.A}/agent-info`,
    payload: { date: '2026-09-18', lease_terms: '12 months', included: { electricity: false, pool: true }, water_power: 'PDAM' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().included, { electricity: false, pool: true });
  assert.equal(res.json().by_name, 'Philipp');

  const detail = (await call({ method: 'GET', url: `/api/properties/${ids.A}` })).json();
  assert.equal(detail.agent_info.length, 1);
  assert.deepEqual(detail.agent_info[0].included, { electricity: false, pool: true });
});

test('agent-info: construction in planned_builds raises the red flag', async (t) => {
  const { call, ids } = await setup(t);
  const res = await call({
    method: 'POST', url: `/api/properties/${ids.A}/agent-info`,
    payload: { planned_builds: 'A construction site is starting next door in November' },
  });
  assert.equal(res.statusCode, 200);
  const after = (await call({ method: 'GET', url: `/api/properties/${ids.A}` })).json();
  assert.deepEqual(after.red_flags, ['construction']);
  assert.equal(after.scope, 'in_filter', 'construction stopped excluding on 2026-09-22 (SPEC §2)');
  assert.equal(after.flagged, 0);
});

// ---------------------------------------------------------------------------
// Viewings
// ---------------------------------------------------------------------------

test('viewings: JSON with a verdict sets assessed=done', async (t) => {
  const { call, ids } = await setup(t);
  const res = await call({
    method: 'POST', url: `/api/properties/${ids.A}/viewings`,
    payload: { date: '2026-09-18', time_of_day: 'morning', quiet: 4, privacy: 4, light: 5, beach_minutes: 7, verdict: 'yes', notes: 'lovely' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().verdict, 'yes');
  assert.equal(res.json().by_name, 'Philipp');
  assert.deepEqual(res.json().photos, []);

  const after = (await call({ method: 'GET', url: `/api/properties/${ids.A}` })).json();
  assert.equal(after.assessed, 'done');
  assert.equal(after.viewings.length, 1);
  assert.equal(after.flagged, 1, 'a good visit keeps the flag');
});

test('viewings: no verdict leaves assessed=partly', async (t) => {
  const { call, ids } = await setup(t);
  await call({ method: 'POST', url: `/api/properties/${ids.B}/viewings`, payload: { notes: 'drive-by' } });
  const after = (await call({ method: 'GET', url: `/api/properties/${ids.B}` })).json();
  assert.equal(after.assessed, 'partly');
});

test('viewings: quiet<=2, privacy<=2 and construction_nearby>=4 raise red flags', async (t) => {
  const { call, ids } = await setup(t);
  await call({
    method: 'POST', url: `/api/properties/${ids.A}/viewings`,
    payload: { quiet: 2, privacy: 1, construction_nearby: 5, verdict: 'no' },
  });
  const after = (await call({ method: 'GET', url: `/api/properties/${ids.A}` })).json();
  assert.deepEqual([...after.red_flags].sort(), ['construction', 'privacy_low', 'quiet_low']);
  assert.equal(after.flagged, 0);
});

test('viewings: bad scale values and unknown fields are 400s', async (t) => {
  const { call, ids } = await setup(t);
  const bad = await call({ method: 'POST', url: `/api/properties/${ids.A}/viewings`, payload: { quiet: 9 } });
  assert.equal(bad.statusCode, 400);
  const unknown = await call({ method: 'POST', url: `/api/properties/${ids.A}/viewings`, payload: { mood: 'good' } });
  assert.equal(unknown.statusCode, 400);
  const missing = await call({ method: 'POST', url: '/api/properties/9999/viewings', payload: { quiet: 3 } });
  assert.equal(missing.statusCode, 404);
});

test('viewings: multipart with photos writes files under the images dir', async (t) => {
  const { call, env, ids } = await setup(t);
  const jpeg = await tinyJpeg();
  const body = multipart(
    { date: '2026-09-18', quiet: '5', verdict: 'maybe', notes: 'from the phone' },
    [{ name: 'photos', filename: 'a.jpg', buffer: jpeg }, { name: 'photos', filename: 'b.jpg', buffer: jpeg }]
  );
  const res = await call({ method: 'POST', url: `/api/properties/${ids.A}/viewings`, ...body });
  assert.equal(res.statusCode, 200);
  const viewing = res.json();
  assert.equal(viewing.quiet, 5);
  assert.equal(viewing.notes, 'from the phone');
  assert.equal(viewing.photos.length, 2);
  assert.deepEqual(viewing.photo_urls, viewing.photos.map((f) => `/images/${f}`));
  for (const file of viewing.photos) {
    assert.match(file, new RegExp(`^${ids.A}/v${viewing.id}-\\d\\.jpg$`));
    assert.ok(fs.existsSync(path.join(env.IMAGES_DIR, file)));
  }
});

// ---------------------------------------------------------------------------
// Contacts and image upload
// ---------------------------------------------------------------------------

test('contacts: created, normalised and linked; the same number is reused', async (t) => {
  const { call, ids } = await setup(t);
  const first = await call({
    method: 'POST', url: `/api/properties/${ids.A}/contacts`,
    payload: { name: 'Wayan', role: 'agent', whatsapp: '+62 812-345-6789', agency: 'BHI' },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().whatsapp, '+628123456789');

  const second = await call({
    method: 'POST', url: `/api/properties/${ids.B}/contacts`,
    payload: { name: 'Wayan again', whatsapp: '+62 (812) 345 6789' },
  });
  assert.equal(second.json().id, first.json().id, 'same number → same contact row');

  const listed = (await call({ method: 'GET', url: '/api/contacts' })).json();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].properties.map((p) => p.id).sort((a, b) => a - b), [ids.A, ids.B].sort((a, b) => a - b));
});

test('contacts: a contact without whatsapp is always a new row, and PATCH edits it', async (t) => {
  const { call, ids } = await setup(t);
  const a = await call({ method: 'POST', url: `/api/properties/${ids.A}/contacts`, payload: { name: 'Owner A' } });
  const b = await call({ method: 'POST', url: `/api/properties/${ids.A}/contacts`, payload: { name: 'Owner B' } });
  assert.notEqual(a.json().id, b.json().id);

  const patched = await call({ method: 'PATCH', url: `/api/contacts/${a.json().id}`, payload: { responsiveness: 4, notes: 'fast' } });
  assert.equal(patched.json().responsiveness, 4);
  assert.equal(patched.json().notes, 'fast');

  const bad = await call({ method: 'PATCH', url: `/api/contacts/${a.json().id}`, payload: { id: 7 } });
  assert.equal(bad.statusCode, 400);
  const missing = await call({ method: 'PATCH', url: '/api/contacts/9999', payload: { notes: 'x' } });
  assert.equal(missing.statusCode, 404);
});

test('images: multipart upload appends to images and sets the hero', async (t) => {
  const { call, env, ids } = await setup(t);
  const jpeg = await tinyJpeg();
  const body = multipart({}, [{ name: 'files', filename: 'phone.jpg', buffer: jpeg }]);
  const res = await call({ method: 'POST', url: `/api/properties/${ids.B}/images`, ...body });
  assert.equal(res.statusCode, 200);

  const { images, hero_url } = res.json();
  assert.equal(images.length, 1);
  assert.equal(images[0].src_url, null);
  assert.equal(images[0].file, `${ids.B}/u1.jpg`);
  assert.equal(images[0].by, 1);
  assert.ok(images[0].w > 0 && images[0].h > 0);
  assert.equal(hero_url, `/images/${ids.B}/u1.jpg`);
  assert.ok(fs.existsSync(path.join(env.IMAGES_DIR, images[0].file)));

  const noFiles = await call({ method: 'POST', url: `/api/properties/${ids.B}/images`, ...multipart({}, []) });
  assert.equal(noFiles.statusCode, 400);
});

// ---------------------------------------------------------------------------
// POST /api/properties — inbox queue and manual add
// ---------------------------------------------------------------------------

test('create: {url} queues the inbox and is idempotent', async (t) => {
  const { call, db } = await setup(t);
  const res = await call({ method: 'POST', url: '/api/properties', payload: { url: 'https://example.test/villa-1', note: 'from Abi' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().queued, true);
  const id = res.json().inbox_id;

  const again = await call({ method: 'POST', url: '/api/properties', payload: { url: 'https://example.test/villa-1' } });
  assert.equal(again.json().inbox_id, id);

  const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(id);
  assert.equal(row.by, 'Philipp');
  assert.equal(row.status, 'pending');
  assert.match(row.created_at, /Z$/);
});

test('create: a full object is stored under a manual: key and scored', async (t) => {
  const { call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/properties',
    payload: {
      url: 'https://wa.me/listing-9', title: 'Whatsapp Find in Seseh', area: 'seseh',
      bedrooms: 2, price_month_idr: 38_000_000, pool: 1, garden: 1, living_open: 1, airy: 1, term: 'monthly',
    },
  });
  assert.equal(res.statusCode, 200);
  const row = res.json();
  assert.match(row.key, /^manual:[0-9a-f]{40}$/);
  assert.equal(row.source, 'manual');
  assert.equal(row.scope, 'in_filter');
  assert.ok(row.fit_score > 0);
  assert.equal(row.pin_source, 'centroid', 'placePins fills the area centroid');

  const listed = (await call({ method: 'GET', url: '/api/properties?q=Whatsapp' })).json();
  assert.equal(listed.length, 1);
});

test('create: a yearly-only price normalises to a monthly equivalent', async (t) => {
  const { call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/properties',
    payload: { url: 'https://wa.me/listing-10', title: 'Yearly Deal Cemagi', area: 'cemagi', bedrooms: 2, price_year_idr: 480_000_000, term: 'yearly' },
  });
  assert.equal(res.json().price_month_idr, 40_000_000);
  const bad = await call({ method: 'POST', url: '/api/properties', payload: { url: 'https://x.test/y', nonsense: 1 } });
  assert.equal(bad.statusCode, 400);
});

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

test('percentiles: nearest rank, and empty input', async () => {
  assert.deepEqual(percentiles([]), { n: 0, p25: null, median: null, p75: null });
  assert.deepEqual(percentiles([1, 2, 3, 4]), { n: 4, p25: 1, median: 2, p75: 3 });
  assert.deepEqual(percentiles([5]), { n: 1, p25: 5, median: 5, p75: 5 });
  assert.deepEqual(percentiles([10, 20, 30, 40, 50]), { n: 5, p25: 20, median: 30, p75: 40 });
  assert.deepEqual(percentiles([3, 1, 2, null, undefined]), { n: 3, p25: 1, median: 2, p75: 3 });
});

test('market: per-area percentiles, feature premium and shortlist deltas', async (t) => {
  const { call, ids } = await setup(t);
  await call({ method: 'POST', url: `/api/properties/${ids.A}/status`, payload: { status: 'shortlist' } });

  const res = await call({ method: 'GET', url: '/api/market' });
  assert.equal(res.statusCode, 200);
  const m = res.json();

  const cemagi = m.by_area.find((a) => a.area === 'cemagi');
  assert.deepEqual(cemagi, { area: 'cemagi', n: 2, p25: 35_000_000, median: 35_000_000, p75: 40_000_000, n_in_filter: 2 });
  assert.equal(m.by_area[0].n, 2, 'sorted by count, descending');
  assert.equal(m.by_area.some((a) => a.area === 'munggu'), false, 'gone rows are excluded');

  const bed2 = m.by_bedrooms.find((b) => b.bedrooms === 2);
  assert.equal(bed2.n, 3);
  assert.deepEqual(m.by_bedrooms.map((b) => b.bedrooms), [2, 3, 4]);

  const pool = m.feature_premium.find((f) => f.feature === 'pool');
  assert.equal(pool.n_with, 3);
  assert.equal(pool.n_without, 2);
  assert.equal(pool.median_with, 45_000_000);
  assert.equal(pool.median_without, 30_000_000);

  assert.equal(m.shortlist_vs_median.length, 1);
  const s = m.shortlist_vs_median[0];
  assert.equal(s.property_id, ids.A);
  assert.equal(s.ref, 'RFA');
  assert.equal(s.area_median, 35_000_000);
  assert.ok(Math.abs(s.delta_pct - 14.3) < 0.1, `delta ${s.delta_pct}`);

  assert.deepEqual(m.counts, { in_filter: 5, market: 1, flagged: 1, shortlist: 1, gone: 1 });
});

// ---------------------------------------------------------------------------
// Config, runs, notes, inbox, scrape
// ---------------------------------------------------------------------------

test('config: GET returns the whole brief', async (t) => {
  const { call } = await setup(t);
  const cfg = (await call({ method: 'GET', url: '/api/config' })).json();
  assert.equal(cfg.flag_threshold, 65);
  assert.equal(cfg.weights.living_open, 15);
  assert.equal(cfg.budget_min, 20_000_000);
  assert.equal(cfg.beach_km_max, 4);
  assert.ok(Array.isArray(cfg.areas));
  assert.equal(cfg.last_digest_at, null);
});

test('config: PATCH weights rescores and logs a learn run', async (t) => {
  const { call, ids } = await setup(t);
  const before = (await call({ method: 'GET', url: `/api/properties/${ids.A}` })).json().fit_score;

  const res = await call({ method: 'PATCH', url: '/api/config', payload: { weights: { pool: 20 } } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().weights.pool, 20);
  assert.equal(res.json().weights.living_open, 15, 'untouched weights stay');
  assert.deepEqual(res.json().weight_changes, [{ feature: 'pool', from: 12, to: 20, because: 'edited by Philipp' }]);

  const after = (await call({ method: 'GET', url: `/api/properties/${ids.A}` })).json().fit_score;
  assert.notEqual(after, before, 'every row is rescored');

  const runs = (await call({ method: 'GET', url: '/api/runs' })).json();
  assert.equal(runs[0].kind, 'learn');
  assert.deepEqual(runs[0].weight_changes[0].feature, 'pool');
  assert.ok(Array.isArray(runs[0].notes));
  assert.ok(runs[0].finished_at);
});

test('config: PATCH flag_threshold changes who is flagged', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'PATCH', url: '/api/config', payload: { flag_threshold: 95 } });
  assert.equal(res.json().flag_threshold, 95);
  const flagged = (await call({ method: 'GET', url: '/api/properties?flagged=1' })).json();
  assert.equal(flagged.length, 0);
});

test('config: PATCH rejects bad weights and an empty body', async (t) => {
  const { call } = await setup(t);
  for (const payload of [{ weights: { pool: 99 } }, { weights: { jacuzzi: 5 } }, { weights: { pool: 1.5 } }, { flag_threshold: 500 }, {}]) {
    const res = await call({ method: 'PATCH', url: '/api/config', payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test('runs and notes: newest first, JSON columns parsed, limit honoured', async (t) => {
  const { call, db } = await setup(t);
  db.prepare('INSERT INTO runs (started_at, finished_at, kind, sources, notes, errors) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nowIso(), nowIso(), 'scrape', JSON.stringify(['bhi']), JSON.stringify(['ok']), JSON.stringify([]));
  db.prepare('INSERT INTO agent_notes (date, text, created_at) VALUES (?, ?, ?)').run('2026-09-17', 'first', nowIso());
  db.prepare('INSERT INTO agent_notes (date, text, created_at) VALUES (?, ?, ?)').run('2026-09-18', 'second', nowIso());

  const runs = (await call({ method: 'GET', url: '/api/runs?limit=5' })).json();
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].sources, ['bhi']);
  assert.deepEqual(runs[0].notes, ['ok']);

  const notes = (await call({ method: 'GET', url: '/api/notes' })).json();
  assert.deepEqual(notes.map((n) => n.text), ['second', 'first']);
  assert.equal((await call({ method: 'GET', url: '/api/notes?limit=1' })).json().length, 1);
  assert.equal((await call({ method: 'GET', url: '/api/notes?limit=0' })).statusCode, 400);
});

test('inbox: POST records the person, GET lists pending', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'POST', url: '/api/inbox', payload: { url: 'https://ig.test/villa', note: 'DM from an agent' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);

  const again = await call({ method: 'POST', url: '/api/inbox', payload: { url: 'https://ig.test/villa' } });
  assert.equal(again.json().id, res.json().id);

  const pending = (await call({ method: 'GET', url: '/api/inbox?status=pending' })).json();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].by, 'Philipp');
  assert.equal((await call({ method: 'GET', url: '/api/inbox' })).json().length, 1);
  assert.equal((await call({ method: 'GET', url: '/api/inbox?status=nope' })).statusCode, 400);
});

/**
 * POST /api/scrape is tested against a stub injected through the plugin's own options —
 * cleaner than an env switch, and it lets the 409 lock be exercised for real.
 */
async function adminApp(t, { runScrape }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-scrape-'));
  const db = openDb(path.join(dir, 'villa.db'));
  seedUsers(db, ENV);
  const app = Fastify();
  await registerAuth(app, db, ENV);
  await app.register(adminRoutes, { db, env: ENV, runScrape });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = (opts) => app.inject({ ...opts, headers: { authorization: `Bearer ${ENV.ADMIN_TOKEN}`, ...(opts.headers || {}) } });
  return { app, db, call };
}

test('scrape: returns 202 and starts the run once', async (t) => {
  const calls = [];
  const { call } = await adminApp(t, { runScrape: async (args) => { calls.push(args); } });

  const res = await call({ method: 'POST', url: '/api/scrape', payload: { source: 'bhi' } });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.json(), { started: true, source: 'bhi' });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].sources, ['bhi']);
});

test('scrape: a second request while one is running is a 409', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { call } = await adminApp(t, { runScrape: () => gate });

  const first = await call({ method: 'POST', url: '/api/scrape', payload: {} });
  assert.equal(first.statusCode, 202);
  const second = await call({ method: 'POST', url: '/api/scrape', payload: {} });
  assert.equal(second.statusCode, 409);
  assert.deepEqual(second.json(), { error: 'already_running' });

  release();
  await new Promise((r) => setImmediate(r));
  const third = await call({ method: 'POST', url: '/api/scrape', payload: {} });
  assert.equal(third.statusCode, 202);
  release();
  await new Promise((r) => setImmediate(r)); // let the lock clear before the next test
});

test('list: an unknown query parameter is ignored, not fatal', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/properties?utm_source=whatsapp' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().length, 3);
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test('every route needs a logged-in user', async (t) => {
  const { app, ids } = await setup(t);
  const routes = [
    ['GET', '/api/properties'],
    ['GET', `/api/properties/${ids.A}`],
    ['POST', '/api/properties'],
    ['PATCH', `/api/properties/${ids.A}`],
    ['POST', `/api/properties/${ids.A}/status`],
    ['POST', `/api/properties/${ids.A}/ratings`],
    ['POST', `/api/properties/${ids.A}/viewings`],
    ['GET', '/api/contacts'],
    ['GET', '/api/market'],
    ['GET', '/api/config'],
    ['PATCH', '/api/config'],
    ['GET', '/api/runs'],
    ['GET', '/api/notes'],
    ['POST', '/api/scrape'],
    ['POST', '/api/inbox'],
    ['GET', '/api/inbox'],
  ];
  for (const [method, url] of routes) {
    const res = await app.inject({ method, url, payload: {} });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
    assert.deepEqual(res.json(), { error: 'unauthenticated' });
  }
});

test('the admin bearer token works everywhere the cookie does', async (t) => {
  const { app, ids } = await setup(t);
  const res = await app.inject({
    method: 'GET', url: `/api/properties/${ids.A}`,
    headers: { authorization: `Bearer ${ENV.ADMIN_TOKEN}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().key, 'bhi:A');
});
