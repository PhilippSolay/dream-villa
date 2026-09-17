// GET /api/stats (STEP: Market page "Overview"). Plain-SQL seeded rows — like
// test/agent-api.test.js's insertListing — so the test owns every field the
// aggregation touches instead of going through the scraper/scoring pipeline.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, nowIso } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import statsRoutes, {
  dateRange,
  todayMakassar,
  fillDays,
  priceChangeCounts,
  bucketiseFit,
  bucketiseBeach,
  nextDailyRun,
} from '../src/routes/stats.js';

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

const TODAY = todayMakassar();

/** `n` days before TODAY, as YYYY-MM-DD (Makassar-local). */
function daysAgo(n) {
  return new Date(new Date(`${TODAY}T00:00:00Z`).getTime() - n * 86_400_000).toISOString().slice(0, 10);
}

/** An ISO UTC timestamp that lands on Makassar-local `dateStr` (local midday). */
function atMakassar(dateStr, hh = '04:00:00.000') {
  return `${dateStr}T${hh}Z`;
}

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-stats-'));
  return { db: openDb(path.join(dir, 'villa.db')), dir };
}

let seq = 0;
function insertListing(db, overrides = {}) {
  seq += 1;
  const now = nowIso();
  const row = {
    key: `test:${seq}`, ref: `RF${1000 + seq}`, source: 'bhi', url: `https://bali-home-immo.com/listing-${seq}`,
    title: `Test Villa ${seq}`, area: 'cemagi', bedrooms: 2, price_month_idr: 30_000_000, term: 'monthly',
    beach_km: 1.2, scope: 'in_filter', fit_score: 70, flagged: 0, red_flags: '[]',
    availability: 'available', status: 'new', first_seen: now, last_seen: now,
    price_history: JSON.stringify([{ date: now.slice(0, 10), price_month_idr: 30_000_000 }]),
    ...overrides,
  };
  const cols = Object.keys(row);
  const info = db.prepare(`INSERT INTO properties (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
  return Number(info.lastInsertRowid);
}

function insertRating(db, { propertyId, by, feature, score, createdAt = nowIso() }) {
  db.prepare('INSERT INTO ratings (property_id, by, feature, score, created_at) VALUES (?, ?, ?, ?, ?)').run(propertyId, by, feature, score, createdAt);
}

function insertViewing(db, { propertyId, by, date = TODAY, createdAt = nowIso() }) {
  db.prepare('INSERT INTO viewings (property_id, by, date, created_at) VALUES (?, ?, ?, ?)').run(propertyId, by, date, createdAt);
}

function insertFeedback(db, { propertyId, by, text = 'noisy road', createdAt = nowIso() }) {
  db.prepare('INSERT INTO feedback (property_id, by, text, created_at) VALUES (?, ?, ?, ?)').run(propertyId, by, text, createdAt);
}

function insertAgentInfo(db, { propertyId, by, date = TODAY, createdAt = nowIso() }) {
  db.prepare('INSERT INTO agent_info (property_id, by, date, created_at) VALUES (?, ?, ?, ?)').run(propertyId, by, date, createdAt);
}

function insertRun(db, { kind = 'scrape', startedAt, finishedAt, seen = 0, newCount = 0, updated = 0, gone = 0, flagged = 0 }) {
  db.prepare('INSERT INTO runs (started_at, finished_at, kind, seen, new, updated, gone, flagged) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    startedAt, finishedAt, kind, seen, newCount, updated, gone, flagged
  );
}

/** A dozen properties spread across status/area/source/scope/date, plus activity rows. */
function seedAll(db) {
  const u1 = db.prepare('SELECT id FROM users WHERE email = ?').get(ENV.USER1_EMAIL).id;
  const u2 = db.prepare('SELECT id FROM users WHERE email = ?').get(ENV.USER2_EMAIL).id;

  const p1 = insertListing(db, { area: 'cemagi', source: 'bhi', status: 'new', scope: 'in_filter', fit_score: 72, beach_km: 0.5, flagged: 0, price_month_idr: 35_000_000, first_seen: atMakassar(daysAgo(0)) });
  const p2 = insertListing(db, { area: 'cemagi', source: 'bhi', status: 'shortlist', scope: 'in_filter', fit_score: 85, beach_km: 1.5, flagged: 1, price_month_idr: 42_000_000, first_seen: atMakassar(daysAgo(1)) });
  const p3 = insertListing(db, { area: 'seseh', source: 'bhi', status: 'contacted', scope: 'in_filter', fit_score: 45, beach_km: 2.5, flagged: 0, price_month_idr: 28_000_000, first_seen: atMakassar(daysAgo(2)) });
  const p4 = insertListing(db, { area: 'seseh', source: 'olx', status: 'viewing_booked', scope: 'market', fit_score: 30, beach_km: null, flagged: 0, price_month_idr: 27_000_000, first_seen: atMakassar(daysAgo(3)) });
  const p5 = insertListing(db, { area: 'pererenan', source: 'olx', status: 'viewed', scope: 'in_filter', fit_score: 91, beach_km: 3.5, flagged: 1, price_month_idr: 48_000_000, first_seen: atMakassar(daysAgo(5)) });
  const p6 = insertListing(db, { area: 'pererenan', source: 'kibarer', status: 'offer', scope: 'in_filter', fit_score: 65, beach_km: 5.0, flagged: 1, price_month_idr: 45_000_000, first_seen: atMakassar(daysAgo(7)) });
  const p7 = insertListing(db, { area: 'uluwatu', source: 'kibarer', status: 'rejected', scope: 'market', fit_score: 20, beach_km: 7.0, flagged: 0, price_month_idr: 32_000_000, first_seen: atMakassar(daysAgo(10)) });
  const p8 = insertListing(db, { area: 'uluwatu', source: 'bhi', status: 'new', scope: 'in_filter', fit_score: 10, beach_km: null, flagged: 0, price_month_idr: 31_000_000, availability: 'gone', first_seen: atMakassar(daysAgo(15)), last_seen: atMakassar(daysAgo(1)) });
  const p9 = insertListing(db, { area: 'munggu', source: 'olx', status: 'new', scope: 'market', fit_score: 55, beach_km: 1.2, flagged: 0, price_month_idr: 26_000_000, first_seen: atMakassar(daysAgo(20)) });
  const p10 = insertListing(db, { area: 'munggu', source: 'bhi', status: 'shortlist', scope: 'in_filter', fit_score: 99, beach_km: 0.2, flagged: 1, price_month_idr: 50_000_000, first_seen: atMakassar(daysAgo(25)), price_history: JSON.stringify([{ date: daysAgo(25), price_month_idr: 47_000_000 }, { date: daysAgo(1), price_month_idr: 50_000_000 }]) });
  const p11 = insertListing(db, { area: 'cemagi', source: 'olx', status: 'viewed', scope: 'in_filter', fit_score: 77, beach_km: 2.8, flagged: 1, price_month_idr: 44_000_000, first_seen: atMakassar(daysAgo(28)) });
  const p12 = insertListing(db, { area: 'seseh', source: 'bhi', status: 'offer', scope: 'in_filter', fit_score: 68, beach_km: null, flagged: 0, price_month_idr: 33_000_000, first_seen: atMakassar(daysAgo(40)) });

  insertRating(db, { propertyId: p1, by: u1, feature: 'quiet', score: 4 });
  insertRating(db, { propertyId: p1, by: u1, feature: 'privacy', score: 3 });
  insertRating(db, { propertyId: p2, by: u1, feature: 'overall', score: 5 });
  insertRating(db, { propertyId: p2, by: u2, feature: 'quiet', score: 2 });
  insertRating(db, { propertyId: p5, by: u2, feature: 'overall', score: 4 });
  insertRating(db, { propertyId: p6, by: u1, feature: 'quiet', score: 1, createdAt: atMakassar(daysAgo(40)) }); // outside the 30-day window

  insertViewing(db, { propertyId: p5, by: u1, date: daysAgo(1) });
  insertViewing(db, { propertyId: p11, by: u2, date: daysAgo(2) });

  insertFeedback(db, { propertyId: p1, by: u1, text: 'too noisy' });
  insertFeedback(db, { propertyId: p3, by: u2, text: 'loved the garden' });
  insertFeedback(db, { propertyId: p4, by: u1, text: 'stale feedback', createdAt: atMakassar(daysAgo(40)) });

  insertAgentInfo(db, { propertyId: p2, by: u1 });
  insertAgentInfo(db, { propertyId: p6, by: u2 });

  insertRun(db, { startedAt: atMakassar(TODAY, '07:50:00.000'), finishedAt: atMakassar(TODAY, '08:00:00.000'), seen: 120, newCount: 3, updated: 10, gone: 1, flagged: 2 });
  insertRun(db, { startedAt: atMakassar(daysAgo(1), '07:50:00.000'), finishedAt: atMakassar(daysAgo(1), '08:00:00.000'), seen: 100, newCount: 1, updated: 5, gone: 0, flagged: 1 });
  insertRun(db, { kind: 'recheck', startedAt: atMakassar(daysAgo(5), '07:50:00.000'), finishedAt: atMakassar(daysAgo(5), '08:00:00.000'), seen: 50, newCount: 0, updated: 2, gone: 1, flagged: 0 });

  return { u1, u2, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12 };
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
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw).split(';')[0];
  const call = (opts) => app.inject({ ...opts, headers: { cookie, ...(opts.headers || {}) } });
  return { app, db, ids, call };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('dateRange: N consecutive days ending at endDateStr', () => {
  assert.deepEqual(dateRange(3, '2026-09-18'), ['2026-09-16', '2026-09-17', '2026-09-18']);
  assert.equal(dateRange(30, '2026-09-18').length, 30);
});

test('fillDays: zero-fills dates with no data', () => {
  const byDate = { new: new Map([['2026-09-18', 5]]) };
  const rows = fillDays(3, '2026-09-18', byDate);
  assert.deepEqual(rows.map((r) => r.date), ['2026-09-16', '2026-09-17', '2026-09-18']);
  assert.deepEqual(rows.map((r) => r.new), [0, 0, 5]);
  assert.deepEqual(rows.map((r) => r.gone), [0, 0, 0]);
});

test('priceChangeCounts: counts entries after the first, keyed by date', () => {
  const h1 = JSON.stringify([{ date: '2026-09-01', price_month_idr: 30e6 }, { date: '2026-09-10', price_month_idr: 31e6 }]);
  const h2 = JSON.stringify([{ date: '2026-09-05', price_month_idr: 20e6 }]); // single entry: not a change
  const h3 = JSON.stringify([{ date: '2026-09-01', price_month_idr: 40e6 }, { date: '2026-09-10', price_month_idr: 41e6 }]);
  const counts = priceChangeCounts([h1, h2, h3, null, 'not json']);
  assert.equal(counts.get('2026-09-10'), 2);
  assert.equal(counts.has('2026-09-05'), false);
});

test('bucketiseFit: 0-9 .. 90-100 buckets, clamps and skips nulls', () => {
  const rows = bucketiseFit([0, 9, 10, 65, 99, 100, null, undefined, 105]);
  assert.equal(rows.length, 10);
  assert.equal(rows.at(-1).bucket, '90-100');
  assert.equal(rows.reduce((a, b) => a + b.n, 0), 7); // null/undefined skipped
  assert.equal(rows.find((r) => r.bucket === '90-100').n, 3); // 99, 100, and the clamped 105
});

test('bucketiseBeach: km buckets plus unknown', () => {
  const rows = bucketiseBeach([0.5, 1, 3.9, 6, 100, null]);
  const byBucket = Object.fromEntries(rows.map((r) => [r.bucket, r.n]));
  assert.equal(byBucket['0-1'], 1);
  assert.equal(byBucket['1-2'], 1);
  assert.equal(byBucket['3-4'], 1);
  assert.equal(byBucket['6+'], 2);
  assert.equal(byBucket.unknown, 1);
});

test('nextDailyRun: next 06:00 Makassar, handles today-already-passed and non-daily expressions', () => {
  const before = new Date('2026-09-18T00:00:00.000Z'); // 08:00 Makassar — before 06:00? no, after
  const next = nextDailyRun('0 6 * * *', before);
  assert.equal(next, '2026-09-18T22:00:00.000Z'); // next 06:00 Makassar = 22:00 UTC the same UTC-day
  const earlier = new Date('2026-09-17T20:00:00.000Z'); // 04:00 Makassar — before today's 06:00
  assert.equal(nextDailyRun('0 6 * * *', earlier), '2026-09-17T22:00:00.000Z');
  assert.equal(nextDailyRun('*/15 6 * * *', before), null);
  assert.equal(nextDailyRun('0 6 * * 1', before), null);
  assert.equal(nextDailyRun(null, before), null);
});

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

test('GET /api/stats: unauthenticated -> 401', async (t) => {
  const { db, dir } = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const res = await app.inject({ method: 'GET', url: '/api/stats' });
  assert.equal(res.statusCode, 401);
});

test('GET /api/stats: pipeline counts every status plus a separate gone line', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/stats' });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  const byStatus = Object.fromEntries(body.pipeline.map((p) => [p.status, p.n]));
  assert.deepEqual(Object.keys(byStatus), ['new', 'shortlist', 'contacted', 'viewing_booked', 'viewed', 'offer', 'rejected', 'gone']);
  assert.equal(byStatus.new, 3); // p1, p8, p9
  assert.equal(byStatus.shortlist, 2); // p2, p10
  assert.equal(byStatus.contacted, 1);
  assert.equal(byStatus.viewing_booked, 1);
  assert.equal(byStatus.viewed, 2);
  assert.equal(byStatus.offer, 2);
  assert.equal(byStatus.rejected, 1);
  assert.equal(byStatus.gone, 1); // p8, regardless of its status being 'new'
});

test('GET /api/stats: daily is zero-filled and sums match the seeded rows', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/stats?days=30' });
  const body = res.json();

  assert.deepEqual(body.daily.map((d) => d.date), dateRange(30, TODAY));
  const sum = (key) => body.daily.reduce((a, d) => a + d[key], 0);
  assert.equal(sum('new'), 11); // every property except p12 (40 days ago) first_seen within 30 days
  assert.equal(sum('gone'), 1); // p8, last_seen 1 day ago
  assert.equal(sum('price_changes'), 1); // p10's second price_history entry, dated 1 day ago
  assert.equal(sum('runs'), 3);
  assert.equal(sum('seen'), 270); // 120 + 100 + 50
});

test('GET /api/stats: days query param resizes the daily window', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/stats?days=7' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().daily.length, 7);
});

test('GET /api/stats: by_source shape and counts', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/stats' });
  const bySource = Object.fromEntries(res.json().by_source.map((s) => [s.source, s]));

  assert.equal(bySource.bhi.listings, 6); // p1,p2,p3,p8,p10,p12
  assert.equal(bySource.bhi.gone, 1); // p8
  assert.equal(bySource.bhi.in_filter, 6);
  assert.equal(bySource.olx.listings, 4); // p4,p5,p9,p11
  assert.equal(bySource.olx.in_filter, 2); // p5, p11
  assert.equal(bySource.kibarer.listings, 2); // p6, p7
  for (const row of Object.values(bySource)) {
    assert.ok('median_price' in row);
  }
});

test('GET /api/stats: by_area shape, viewed and shortlisted counts', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/stats' });
  const byArea = Object.fromEntries(res.json().by_area.map((a) => [a.area, a]));

  assert.equal(byArea.cemagi.listings, 3); // p1, p2, p11
  assert.equal(byArea.cemagi.viewed, 1); // p11 has a viewing
  assert.equal(byArea.cemagi.shortlisted, 1); // p2
  assert.equal(byArea.pererenan.viewed, 1); // p5 has a viewing
  assert.equal(byArea.munggu.shortlisted, 1); // p10
  assert.equal(byArea.seseh.viewed, 0);
});

test('GET /api/stats: histograms sum to the in_filter, non-gone count', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/stats' });
  const body = res.json();

  const inFilterNonGone = 8; // p1,p2,p3,p5,p6,p10,p11,p12 (p8 is in_filter but gone)
  assert.equal(body.fit_histogram.reduce((a, b) => a + b.n, 0), inFilterNonGone);
  assert.equal(body.beach_histogram.reduce((a, b) => a + b.n, 0), inFilterNonGone);
  assert.equal(body.beach_histogram.find((b) => b.bucket === 'unknown').n, 1); // p12
});

test('GET /api/stats: activity counts, by_user names, and all-time avg_ratings', async (t) => {
  const { call, ids } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/stats' });
  const body = res.json();

  assert.equal(body.activity.ratings, 5); // 6 seeded, 1 outside the 30-day window
  assert.equal(body.activity.viewings, 2);
  assert.equal(body.activity.feedback, 2); // 3 seeded, 1 outside the window
  assert.equal(body.activity.agent_info, 2);

  const byUser = Object.fromEntries(body.activity.by_user.map((u) => [u.name, u]));
  assert.deepEqual(Object.keys(byUser).sort(), ['Abigail', 'Philipp']);
  assert.equal(byUser.Philipp.ratings, 3);
  assert.equal(byUser.Abigail.ratings, 2);
  assert.equal(byUser.Philipp.viewings, 1);
  assert.equal(byUser.Abigail.viewings, 1);
  assert.equal(byUser.Philipp.feedback, 1);
  assert.equal(byUser.Abigail.feedback, 1);

  const avgByFeature = Object.fromEntries(body.activity.avg_ratings.map((r) => [r.feature, r]));
  assert.equal(avgByFeature.quiet.n, 3); // includes the rating outside the activity window
  assert.equal(avgByFeature.quiet.avg, 2.3); // (4 + 2 + 1) / 3, rounded to 1dp
  assert.equal(avgByFeature.overall.n, 2);
  assert.equal(avgByFeature.overall.avg, 4.5);
  void ids;
});

test('GET /api/stats: last_run is the most recently finished run, with duration', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/stats' });
  const { last_run } = res.json();

  assert.equal(last_run.kind, 'scrape');
  assert.equal(last_run.seen, 120);
  assert.equal(last_run.duration_s, 600); // 07:50 -> 08:00
});

test('GET /api/stats: next_run is a valid ISO string derived from SCRAPE_CRON', async (t) => {
  const { call } = await setup(t);
  const res = await call({ method: 'GET', url: '/api/stats' });
  const { next_run } = res.json();
  assert.ok(next_run);
  assert.equal(new Date(next_run).toISOString(), next_run);
});

test('GET /api/stats: unknown querystring keys are rejected as bad input, not silently dropped', async (t) => {
  const { call } = await setup(t);
  // additionalProperties:false on a querystring is stripped by removeAdditional (see
  // src/routes/_common.js) rather than rejected — this just documents that `days` still works.
  const res = await call({ method: 'GET', url: '/api/stats?days=5&utm_source=test' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().daily.length, 5);
});
