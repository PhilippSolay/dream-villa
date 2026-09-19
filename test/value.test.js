// Value fields on every row: price per m² of house against the area's median, and the
// saving a yearly term offers over the monthly price. Pure derivations, computed server-side.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { upsertProperty, rescoreAll } from '../src/scrape/store.js';
import { valueFields } from '../src/routes/properties.js';

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
  area: 'cemagi', beach_km: 1, bedrooms: 2, pool: 1, status: 'new', availability: 'available', ...extra,
});

// Cemagi: three priced-per-m² houses → median 300k. Pererenan: one house, its own median.
const SEED = [
  base('A', { price_month_idr: 30_000_000, build_m2: 100, term: 'monthly' }), // 300k /m²
  base('B', { price_month_idr: 48_000_000, build_m2: 120, term: 'monthly' }), // 400k /m²
  base('C', { price_month_idr: 20_000_000, build_m2: 100, term: 'monthly' }), // 200k /m²
  base('D', { price_month_idr: 40_000_000, build_m2: null, term: 'monthly' }), // no size
  base('E', { price_month_idr: 50_000_000, price_year_idr: 480_000_000, term: 'both', build_m2: 200 }), // yearly = 40M/mo → 20 %
  base('F', { price_month_idr: 60_000_000, price_year_idr: 720_000_000, term: 'both', build_m2: 200 }), // no saving
  base('G', { price_year_idr: 360_000_000, term: 'yearly', build_m2: 150 }), // monthly is derived → no badge
  base('H', { area: 'pererenan', price_month_idr: 45_000_000, build_m2: 150, term: 'monthly' }),
  base('Z', { price_month_idr: 99_000_000, build_m2: 10, term: 'monthly', availability: 'gone' }), // gone: not in medians
];

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-value-'));
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
  const rows = (await call({ method: 'GET', url: '/api/properties?scope=all&status=all&removed=show&limit=100' })).json();
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  return { db, call, byKey };
}

test('valueFields: pure derivation', () => {
  assert.deepEqual(valueFields({ price_month_idr: 30_000_000, build_m2: 100, term: 'monthly' }, { cemagi: 300_000 }, 'cemagi'), {
    price_per_m2: 300_000, area_price_per_m2: 300_000, vs_area_pct: 0, yearly_saving_pct: null,
  });
  assert.equal(valueFields({ price_month_idr: 30_000_000, build_m2: 0 }, {}, 'cemagi').price_per_m2, null, 'zero size is no size');
  assert.equal(valueFields({ price_month_idr: null, build_m2: 100 }, {}, 'cemagi').price_per_m2, null);
  assert.equal(valueFields({ price_month_idr: 50_000_000, price_year_idr: 480_000_000, term: 'both' }, {}, 'x').yearly_saving_pct, 20);
  assert.equal(valueFields({ price_month_idr: 60_000_000, price_year_idr: 720_000_000, term: 'both' }, {}, 'x').yearly_saving_pct, null, 'no saving → no badge');
  assert.equal(valueFields({ price_month_idr: 30_000_000, price_year_idr: 360_000_000, term: 'yearly' }, {}, 'x').yearly_saving_pct, null, 'yearly only: monthly is derived');
});

test('list rows: price per m², area median gap and yearly saving', async (t) => {
  const { byKey } = await setup(t);
  const a = byKey['bhi:A'];
  assert.equal(a.price_per_m2, 300_000);
  // Live Cemagi houses per m²: A 300k, B 400k, C 200k, E 250k, F 300k → median 300k.
  // G is yearly-only with no monthly price at insert time, so it has no figure to contribute.
  assert.equal(a.area_price_per_m2, 300_000);
  assert.equal(a.vs_area_pct, 0);

  assert.equal(byKey['bhi:B'].vs_area_pct, 33, '400k against a 300k median');
  assert.equal(byKey['bhi:C'].vs_area_pct, -33);
  assert.equal(byKey['bhi:D'].price_per_m2, null);
  assert.equal(byKey['bhi:D'].vs_area_pct, null);

  assert.equal(byKey['bhi:E'].yearly_saving_pct, 20);
  assert.equal(byKey['bhi:F'].yearly_saving_pct, null);
  assert.equal(byKey['bhi:G'].yearly_saving_pct, null);

  assert.equal(byKey['bhi:H'].area_price_per_m2, 300_000, 'Pererenan has one live house: its own value');
  assert.equal(byKey['bhi:H'].vs_area_pct, 0);
  assert.equal(byKey['bhi:Z'].price_per_m2, 9_900_000, 'gone rows still get their own figure');
  assert.equal(byKey['bhi:Z'].area_price_per_m2, 300_000, 'but never move the median');
});

test('detail: carries the same value fields', async (t) => {
  const { call, byKey } = await setup(t);
  const detail = (await call({ method: 'GET', url: `/api/properties/${byKey['bhi:E'].id}` })).json();
  assert.equal(detail.price_per_m2, 250_000);
  assert.equal(detail.yearly_saving_pct, 20);
  assert.equal(typeof detail.area_price_per_m2, 'number');
});
