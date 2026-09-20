// GET /api/market/metrics — the thirteen market metrics. Rows are seeded with plain
// SQL (like test/stats.test.js) so each metric's inputs are exactly what the test
// says they are, plus one row through upsertProperty to prove the real write path
// lands in the same aggregation.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, nowIso } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { upsertProperty } from '../src/scrape/store.js';
import {
  monthKey,
  isoWeek,
  priceBand,
  beachBand,
  brGroup,
  inclusionsFlags,
  negotiableRe,
  availabilityBucket,
  lastMonths,
  lastWeeks,
  makassarDay,
} from '../src/routes/market-metrics.js';

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

const M = 1_000_000;
const TODAY = makassarDay(nowIso());

/** `n` days before today (negative = future), as YYYY-MM-DD Makassar-local. */
function dayOffset(n) {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}
/** An ISO UTC timestamp that lands on Makassar-local `dateStr`. */
function at(dateStr, hh = '04:00:00.000') {
  return `${dateStr}T${hh}Z`;
}
const ago = (n) => at(dayOffset(n));

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-mm-'));
  return { db: openDb(path.join(dir, 'villa.db')), dir };
}

let seq = 0;
function insertListing(db, overrides = {}) {
  seq += 1;
  const row = {
    key: `mm:${seq}`,
    ref: `RF${2000 + seq}`,
    source: 'bhi',
    url: `https://example.test/listing-${seq}`,
    title: `Villa ${['Anyar', 'Beji', 'Cahaya', 'Dewi', 'Embun', 'Fajar', 'Gita', 'Hening', 'Indah', 'Jati', 'Kirana', 'Lestari', 'Mekar', 'Nadi', 'Ombak'][seq % 15]} ${seq}`,
    area: 'cemagi',
    bedrooms: 2,
    price_month_idr: 30 * M,
    term: 'monthly',
    scope: 'market',
    fit_score: 50,
    flagged: 0,
    red_flags: '[]',
    availability: 'available',
    status: 'new',
    first_seen: ago(5),
    last_seen: ago(0),
    ...overrides,
  };
  const cols = Object.keys(row);
  const info = db
    .prepare(`INSERT INTO properties (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c]));
  return Number(info.lastInsertRowid);
}

const INCLUDED = JSON.stringify({ 'Monthly cost included': 'Yes partly', Electricity: 'Included', 'Cleaning Service': 'Included' });
const NOT_INCLUDED = JSON.stringify({ 'Monthly cost included': 'No', Electricity: 'Not included', 'Cleaning Service': 'Not included' });

function seedAll(db) {
  const ids = {};

  // cemagi — the per-m², yearly-discount and price-drop corner
  ids.p1 = insertListing(db, {
    area: 'cemagi', source: 'bhi', bedrooms: 2, price_month_idr: 30 * M, build_m2: 100, beach_km: 0.5,
    term: 'both', price_year_idr: 316_800_000, inclusions: INCLUDED, scope: 'in_filter',
    first_seen: ago(5),
    price_history: JSON.stringify([
      { date: dayOffset(60), price_month_idr: 40 * M },
      { date: dayOffset(30), price_month_idr: 35 * M },
      { date: dayOffset(5), price_month_idr: 30 * M },
    ]),
  });
  ids.p2 = insertListing(db, {
    area: 'cemagi', source: 'bhi', bedrooms: 2, price_month_idr: 40 * M, build_m2: 200, beach_km: 1.5,
    term: 'both', price_year_idr: 480_000_000, first_seen: ago(40),
    price_history: JSON.stringify([
      { date: dayOffset(40), price_month_idr: 38 * M },
      { date: dayOffset(10), price_month_idr: 40 * M },
    ]),
  });
  ids.p3 = insertListing(db, {
    area: 'cemagi', source: 'olx', bedrooms: 3, price_month_idr: 50 * M, build_m2: 250, beach_km: 2.5,
    inclusions: NOT_INCLUDED, first_seen: ago(70),
  });

  // seseh — the two removed rows (time on market)
  ids.p4 = insertListing(db, {
    area: 'seseh', source: 'olx', bedrooms: 2, price_month_idr: 28 * M, beach_km: 1.0,
    availability: 'gone', first_seen: ago(60), last_seen: ago(40),
  });
  ids.p5 = insertListing(db, {
    area: 'seseh', source: 'kibarer', bedrooms: 3, price_month_idr: 45 * M, beach_km: 3.0,
    availability: 'unlisted', first_seen: ago(50), last_seen: ago(20),
  });

  // pererenan / uluwatu / ungasan — availability lead, negotiable, an out-of-window row
  ids.p6 = insertListing(db, {
    area: 'pererenan', source: 'kibarer', bedrooms: 1, price_month_idr: 20 * M, build_m2: 60,
    first_seen: ago(10), available_from: dayOffset(-10),
  });
  ids.p7 = insertListing(db, {
    area: 'pererenan', source: 'bhi', bedrooms: 4, price_month_idr: 65 * M, build_m2: 300, beach_km: 5.0,
    first_seen: ago(200),
    price_history: JSON.stringify([
      { date: dayOffset(200), price_month_idr: 70 * M },
      { date: dayOffset(150), price_month_idr: 65 * M },
    ]),
  });
  ids.p8 = insertListing(db, {
    area: 'uluwatu', source: 'bhi', bedrooms: 3, price_month_idr: 35 * M, build_m2: 150, beach_km: 0.8,
    scope: 'in_filter', first_seen: ago(15), available_from: dayOffset(-60),
    description: 'Quiet compound, price negotiable for a long lease.',
  });
  ids.p9 = insertListing(db, {
    area: 'uluwatu', source: 'olx', bedrooms: 2, price_month_idr: 32 * M, build_m2: 120, beach_km: 1.2,
    scope: 'in_filter', first_seen: ago(3), available_from: dayOffset(-200),
  });
  ids.p10 = insertListing(db, {
    area: 'ungasan', source: 'bhi', bedrooms: 2, price_month_idr: 27 * M, build_m2: 90, beach_km: 2.2,
    first_seen: ago(25), available_from: 'ask the agent',
  });

  // munggu — the merged pair (same villa, two sources, two prices)
  ids.keep = insertListing(db, {
    area: 'munggu', source: 'bhi', bedrooms: 2, price_month_idr: 40 * M, beach_km: 0.9, first_seen: ago(8),
    title: 'Ocean Breeze Villa Munggu',
  });
  ids.merged = insertListing(db, {
    area: 'munggu', source: 'fb', bedrooms: 2, price_month_idr: 44 * M, beach_km: 0.9,
    availability: 'gone', first_seen: ago(6), last_seen: ago(1),
    title: 'Ocean Breeze Villa Munggu',
    raw: JSON.stringify({ merged_into: ids.keep, merged_reason: 'photo shared' }),
  });

  // excluded on purpose: out of band, and no price at all
  ids.outOfBand = insertListing(db, { area: 'cemagi', source: 'manual', bedrooms: 2, price_month_idr: 85 * M, first_seen: ago(4) });
  ids.noPrice = insertListing(db, { area: 'seseh', source: 'bhi', bedrooms: 2, price_month_idr: null, first_seen: ago(4) });

  // one row through the real write path
  const up = upsertProperty(
    db,
    {
      key: 'olx:mm-upsert', ref: 'MM-UPSERT', source: 'olx', url: 'https://example.test/upsert',
      title: 'Rice Field House Pererenan', area: 'pererenan', bedrooms: 2, price_month_idr: 38 * M,
      term: 'monthly', availability: 'available', scope: 'market',
    },
    { now: ago(3) }
  );
  ids.p15 = up.id;

  return ids;
}

async function setup(t) {
  const { db, dir } = tmpDb();
  seedUsers(db, ENV);
  const ids = seedAll(db);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email: ENV.USER1_EMAIL, password: ENV.USER1_PASSWORD } });
  assert.equal(login.statusCode, 200);
  const rawCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie).split(';')[0];
  const call = (opts) => app.inject({ ...opts, headers: { cookie, ...(opts.headers || {}) } });
  return { app, db, ids, call };
}

async function metrics(t, query = '') {
  const ctx = await setup(t);
  const res = await ctx.call({ method: 'GET', url: `/api/market/metrics${query}` });
  assert.equal(res.statusCode, 200);
  return { ...ctx, body: res.json() };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('monthKey / isoWeek are Makassar-local', () => {
  assert.equal(monthKey('2026-09-30T17:00:00.000Z'), '2026-10'); // 01:00 on the 1st in Makassar
  assert.equal(monthKey('2026-09-19T04:00:00.000Z'), '2026-09');
  assert.equal(monthKey(null), null);

  assert.equal(isoWeek('2026-09-19T04:00:00.000Z'), '2026-W38');
  assert.equal(isoWeek('2026-01-01T04:00:00.000Z'), '2026-W01');
  assert.equal(isoWeek('2027-01-01T04:00:00.000Z'), '2026-W53'); // ISO week-year rollover
  assert.equal(isoWeek(null), null);
});

test('lastMonths / lastWeeks end at today and count back', () => {
  assert.deepEqual(lastMonths(4, '2026-09-19'), ['2026-06', '2026-07', '2026-08', '2026-09']);
  assert.deepEqual(lastMonths(3, '2026-01-15'), ['2025-11', '2025-12', '2026-01']);
  const weeks = lastWeeks(13, '2026-09-19');
  assert.equal(weeks.length, 13);
  assert.equal(weeks[12], '2026-W38');
  assert.equal(new Set(weeks).size, 13);
});

test('priceBand / beachBand / brGroup', () => {
  assert.equal(priceBand(29_999_999), '<30');
  assert.equal(priceBand(30 * M), '30-40');
  assert.equal(priceBand(45 * M), '40-50');
  assert.equal(priceBand(50 * M), '50+');
  assert.equal(priceBand(null), null);

  assert.equal(beachBand(0.4), '0-1');
  assert.equal(beachBand(1), '1-2');
  assert.equal(beachBand(2), '2-4');
  assert.equal(beachBand(9), '4+');
  assert.equal(beachBand(null), 'unknown');

  assert.equal(brGroup(1), '1');
  assert.equal(brGroup(3), '3');
  assert.equal(brGroup(6), '4+');
  assert.equal(brGroup(0), null);
  assert.equal(brGroup(null), null);
});

test('inclusionsFlags reads the Bali Home Immo cost table', () => {
  assert.deepEqual(inclusionsFlags(INCLUDED), { electricity_included: true, staff_included: true });
  assert.deepEqual(inclusionsFlags(NOT_INCLUDED), { electricity_included: false, staff_included: false });
  assert.deepEqual(inclusionsFlags(JSON.stringify({ 'Housekeeping (3x/week)': 'Included' })), {
    electricity_included: null, staff_included: true,
  });
  assert.deepEqual(inclusionsFlags(null), { electricity_included: null, staff_included: null });
  assert.deepEqual(inclusionsFlags('not json'), { electricity_included: null, staff_included: null });
});

test('negotiableRe matches the phrasings that actually appear', () => {
  assert.ok(negotiableRe.test('Price negotiable for 12 months'));
  assert.ok(negotiableRe.test('harga nego'));
  assert.ok(negotiableRe.test('bisa nego sedikit'));
  assert.ok(!negotiableRe.test('non-negotiat')); // guard against a loose stem
  assert.ok(!negotiableRe.test('quiet villa with a pool'));
});

test('availabilityBucket is tolerant about how a date is written', () => {
  const today = '2026-09-19';
  assert.equal(availabilityBucket(null, today), 'now');
  assert.equal(availabilityBucket('available', today), 'now');
  assert.equal(availabilityBucket('2026-09-01', today), 'now');
  assert.equal(availabilityBucket('from:2026-10-01', today), 'within_1m');
  assert.equal(availabilityBucket('01/11/2026', today), 'in_1_3m');
  assert.equal(availabilityBucket('2027-06-01', today), 'later');
  assert.equal(availabilityBucket('ask the agent', today), 'unknown');
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

test('GET /api/market/metrics requires a session', async (t) => {
  const { db, dir } = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const res = await app.inject({ method: 'GET', url: '/api/market/metrics' });
  assert.equal(res.statusCode, 401);
});

test('the response carries all thirteen groups, the window and the notes', async (t) => {
  const { body } = await metrics(t);
  for (const key of [
    'price_trend', 'supply_flow', 'time_on_market', 'price_drops', 'per_m2', 'yearly_discount',
    'beach_premium', 'inclusions_premium', 'cross_source_gaps', 'source_share', 'budget_bands',
    'availability_lead', 'negotiable_share',
  ]) {
    assert.ok(body[key] != null, `missing ${key}`);
  }
  assert.equal(body.days, 90);
  assert.ok(body.generated_at);
  assert.ok(typeof body.notes === 'object' && /last_seen/.test(body.notes.removed));
  // 15 seeded rows − 1 merged − 1 out of band − 1 without a price
  assert.equal(body.n_rows, 12);
});

test('days is honoured and validated', async (t) => {
  const { body } = await metrics(t, '?days=7');
  assert.equal(body.days, 7);
  assert.equal(body.price_drops.count, 1); // only the drop 5 days ago is inside 7 days

  const ctx = await setup(t);
  const bad = await ctx.call({ method: 'GET', url: '/api/market/metrics?days=0' });
  assert.equal(bad.statusCode, 400);
});

test('price_trend: six Makassar months, per area and an all-areas aggregate', async (t) => {
  const { body } = await metrics(t);
  const trend = body.price_trend;
  assert.equal(trend.months.length, 6);
  assert.equal(trend.months[5], monthKey(nowIso()));

  for (const row of trend.rows) {
    assert.deepEqual(Object.keys(row).sort(), ['area', 'br', 'median', 'month', 'n', 'p25', 'p75'].sort());
    assert.ok(['1', '2', '3', '4+'].includes(row.br));
  }

  // p1: cemagi, 2 BR, 30 M, first seen 5 days ago
  const month = monthKey(ago(5));
  const cemagi = trend.rows.find((r) => r.month === month && r.area === 'cemagi' && r.br === '2');
  assert.ok(cemagi && cemagi.n >= 1);
  assert.equal(cemagi.median, 30 * M);

  // the 'all' aggregate for a month+br equals the sum of its per-area rows
  for (const month2 of trend.months) {
    for (const br of ['1', '2', '3', '4+']) {
      const all = trend.rows.find((r) => r.month === month2 && r.area === 'all' && r.br === br);
      const parts = trend.rows.filter((r) => r.month === month2 && r.area !== 'all' && r.br === br);
      assert.equal(all ? all.n : 0, parts.reduce((a, r) => a + r.n, 0));
    }
  }
});

test('supply_flow: 13 ISO weeks, new up / removed down, plus an all-areas row', async (t) => {
  const { body } = await metrics(t);
  const flow = body.supply_flow;
  assert.equal(flow.weeks.length, 13);
  assert.equal(flow.areas[0], 'all');
  assert.equal(flow.rows.length, flow.weeks.length * flow.areas.length);

  const all = flow.rows.filter((r) => r.area === 'all');
  // 11 of the 12 base rows were first seen inside 13 weeks (p7 is 200 days old)
  assert.equal(all.reduce((a, r) => a + r.new, 0), 11);
  assert.equal(all.reduce((a, r) => a + r.removed, 0), 2);
  for (const r of all) assert.equal(r.net, r.new - r.removed);

  const goneWeek = flow.rows.find((r) => r.area === 'seseh' && r.week === isoWeek(ago(40)));
  assert.equal(goneWeek.removed, 1);
});

test('time_on_market: days between first_seen and last_seen for removed rows', async (t) => {
  const { body } = await metrics(t);
  const tom = body.time_on_market;

  const seseh = tom.by_area.find((r) => r.area === 'seseh');
  assert.equal(seseh.n, 2);
  assert.equal(seseh.median_days, 20); // 20 (gone) and 30 (unlisted), nearest-rank
  assert.equal(seseh.p75, 30);

  const bands = Object.fromEntries(tom.by_price_band.map((b) => [b.band, b]));
  assert.deepEqual(Object.keys(bands), ['<30', '30-40', '40-50', '50+']);
  assert.equal(bands['<30'].n, 1);
  assert.equal(bands['<30'].median_days, 20);
  assert.equal(bands['40-50'].median_days, 30);
  assert.equal(bands['30-40'].n, 0);

  assert.deepEqual(tom.stale_share, { n_live: 10, n_live_over_30d: 3, share: 0.3 });
});

test('price_drops: decreases inside the window, newest first', async (t) => {
  const { body } = await metrics(t);
  const drops = body.price_drops;
  assert.equal(drops.count, 2); // p1 drops twice; p2 rises; p7 dropped 150 days ago
  assert.equal(drops.avg_pct, 13.4); // (12.5 + 14.3) / 2

  assert.equal(drops.latest.length, 2);
  const newest = drops.latest[0];
  assert.ok(Number.isInteger(newest.id) && typeof newest.ref === 'string');
  assert.equal(newest.from, 35 * M);
  assert.equal(newest.to, 30 * M);
  assert.equal(newest.pct, 14.3);
  assert.equal(newest.area, 'cemagi');
  assert.equal(newest.date, dayOffset(5));
  assert.equal(drops.latest[1].pct, 12.5);
});

test('per_m2: build_m2 > 20 only, by area and overall', async (t) => {
  const { body } = await metrics(t);
  const cemagi = body.per_m2.by_area.find((r) => r.area === 'cemagi');
  assert.equal(cemagi.n, 3); // 100, 200, 250 m² (the 85 M row is outside the band)
  assert.equal(cemagi.median_per_build_m2, 200_000); // 300k, 200k, 200k → 200k
  assert.equal(cemagi.median_per_bedroom, 16_666_667); // 15 M, 20 M, 16.67 M
  assert.equal(cemagi.median_price, 40 * M);
  assert.equal(body.per_m2.all.area, 'all');
  assert.ok(body.per_m2.all.n >= cemagi.n);
});

test("yearly_discount: term='both' rows only, as a percentage cheaper per month", async (t) => {
  const { body } = await metrics(t);
  const yd = body.yearly_discount;
  assert.equal(yd.n, 2); // p1 (316.8 M/yr vs 30 M/mo) and p2 (480 M/yr vs 40 M/mo)
  assert.equal(yd.median_discount_pct, 12);
  const cemagi = yd.by_area.find((r) => r.area === 'cemagi');
  assert.equal(cemagi.n, 2);
  assert.equal(cemagi.median_discount_pct, 12);
});

test('beach_premium: bedrooms group × beach band', async (t) => {
  const { body } = await metrics(t);
  const near2br = body.beach_premium.find((r) => r.br === '2' && r.band === '0-1');
  assert.equal(near2br.n, 2); // 0.5 km @ 30 M and 0.9 km @ 40 M
  assert.equal(near2br.median, 30 * M);
  const unknown = body.beach_premium.find((r) => r.band === 'unknown');
  assert.ok(unknown && unknown.n >= 1); // the upserted row has no beach distance
});

test('inclusions_premium: with vs without, electricity and staff', async (t) => {
  const { body } = await metrics(t);
  const { electricity, staff } = body.inclusions_premium;
  assert.equal(electricity.n_with, 1);
  assert.equal(electricity.median_with, 30 * M);
  assert.equal(electricity.n_without, 1);
  assert.equal(electricity.median_without, 50 * M);
  assert.equal(staff.n_with, 1);
  assert.equal(staff.n_without, 1);
});

test('cross_source_gaps: the merged pair shows up with its price gap', async (t) => {
  const { body, ids } = await metrics(t);
  const gaps = body.cross_source_gaps;
  const merged = gaps.pairs.find((p) => p.kind === 'merged');
  assert.ok(merged, 'expected the merged pair');
  assert.equal(merged.a.id, ids.keep);
  assert.equal(merged.b.id, ids.merged);
  assert.equal(merged.a.source, 'bhi');
  assert.equal(merged.b.source, 'fb');
  assert.equal(merged.gap_pct, 10); // 40 M vs 44 M
  assert.ok(gaps.summary.n_pairs >= 1);
  assert.ok(gaps.summary.median_gap_pct >= 0);
  assert.ok(gaps.pairs.length <= 30);
});

test('source_share: listings, in-filter and flagged split per source', async (t) => {
  const { body } = await metrics(t);
  const bySource = Object.fromEntries(body.source_share.map((r) => [r.source, r]));
  assert.equal(bySource.bhi.listings, 6);
  assert.equal(bySource.olx.listings, 4);
  assert.equal(bySource.kibarer.listings, 2);
  assert.equal(bySource.bhi.in_filter, 2); // p1 and p8
  assert.equal(bySource.olx.in_filter, 1); // p9
  assert.equal(bySource.bhi.share_in_filter_pct, 66.7);
  assert.equal(bySource.olx.share_in_filter_pct, 33.3);
});

test('budget_bands: live 1–3 BR rows counted per area and band', async (t) => {
  const { body } = await metrics(t);
  const bb = body.budget_bands;
  // 10 M steps across the 20–80 M budget, plus the 80–90 M stretch
  assert.deepEqual(bb.bands, ['20-30', '30-40', '40-50', '50-60', '60-70', '70-80', '80-90']);
  assert.equal(bb.stretch_band, '80-90');
  const zero = Object.fromEntries(bb.bands.map((b) => [b, 0]));
  const cemagi = bb.by_area.find((r) => r.area === 'cemagi');
  // cemagi live 1-3 BR: 30 M, 40 M, 50 M (the 85 M row is outside the aggregation band, so not in base)
  assert.deepEqual(cemagi.counts, { ...zero, '30-40': 1, '40-50': 1, '50-60': 1 });
  assert.equal(cemagi.n, 3);
  const ungasan = bb.by_area.find((r) => r.area === 'ungasan');
  assert.deepEqual(ungasan.counts, { ...zero, '20-30': 1 });
  const pererenan = bb.by_area.find((r) => r.area === 'pererenan');
  assert.equal(pererenan.counts['30-40'], 1); // the 38 M upserted row
  assert.equal(pererenan.counts['20-30'], 1); // the 20 M 1-BR row; the 65 M row is 4 BR and stays out
});

test('availability_lead: now / ≤1 month / 1–3 months / later / unknown', async (t) => {
  const { body } = await metrics(t);
  const lead = body.availability_lead;
  assert.equal(lead.now, 6);
  assert.equal(lead.within_1m, 1);
  assert.equal(lead.in_1_3m, 1);
  assert.equal(lead.later, 1);
  assert.equal(lead.unknown, 1);
  const uluwatu = lead.by_area.find((r) => r.area === 'uluwatu');
  assert.equal(uluwatu.in_1_3m, 1);
  assert.equal(uluwatu.later, 1);
});

test('negotiable_share: share of live rows that say so', async (t) => {
  const { body } = await metrics(t);
  const uluwatu = body.negotiable_share.find((r) => r.area === 'uluwatu');
  assert.equal(uluwatu.n_live, 2);
  assert.equal(uluwatu.n_negotiable, 1);
  assert.equal(uluwatu.share_pct, 50);
  const cemagi = body.negotiable_share.find((r) => r.area === 'cemagi');
  assert.equal(cemagi.n_negotiable, 0);
});
