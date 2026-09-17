import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, getConfig } from '../src/db.js';
import {
  PERSON_FIELDS,
  upsertProperty,
  rescoreAll,
  markGone,
  startRun,
  finishRun,
  countsSummary,
  parseRow,
} from '../src/scrape/store.js';
import { scoreRow } from '../src/scrape/score.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-store-'));
  const file = path.join(dir, 'villa.db');
  const db = openDb(file);
  return { db, file, dir };
}

function cleanup({ db, dir }) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A minimal, in-band, in-filter row as normalise.js + pins.js would produce it. */
function baseRow(overrides = {}) {
  return {
    key: 'bhi:RF1', ref: 'RF1', source: 'bhi', url: 'https://bali-home-immo.com/x-rf1',
    title: 'Modern 2 Bedroom Villa', description: 'A lovely villa', inclusions: null, terms: 'monthly',
    area: 'cemagi', sub_area: 'Beach Side', address: null, lat: -8.628, lng: 115.099, pin_source: 'centroid',
    map_url: 'https://www.google.com/maps?q=-8.628,115.099',
    beach_km: 0.9, beach_name: 'Cemagi/Mengening', beach_source: 'computed',
    bedrooms: 2, extra_rooms: 0, bathrooms: 2, land_m2: 200, build_m2: 150,
    price_month_idr: 40_000_000, price_year_idr: null, term: 'monthly', min_months: null,
    furnished: 1, furniture_quality: null, style: 'modern',
    pool: 1, garden: 1, view: 'ocean', joglo: 0, aircon: 1, kitchen_full: 1,
    workspace: null, living_open: 1, airy: 1,
    images: [{ src_url: 'https://x/1.jpg', file: '1.jpg' }], hero_file: '1.jpg',
    availability: 'available', available_from: null,
    red_flags: ['construction'],
    raw: JSON.stringify({ note: 'raw' }),
    first_seen: '2026-09-17T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// upsertProperty — insert
// ---------------------------------------------------------------------------

test('upsertProperty: inserts a new row with a price_history seed entry', () => {
  const ctx = tmpDb();
  const now = '2026-09-17T06:00:00.000Z';
  const result = upsertProperty(ctx.db, baseRow(), { now });
  assert.equal(result.action, 'inserted');
  assert.deepEqual(result.changes, []);

  const row = ctx.db.prepare('SELECT * FROM properties WHERE id = ?').get(result.id);
  assert.equal(row.key, 'bhi:RF1');
  assert.equal(row.first_seen, '2026-09-17T00:00:00.000Z', 'explicit first_seen from the row is kept');
  assert.equal(row.last_seen, now);
  assert.equal(row.status, 'new');
  assert.equal(row.assessed, 'not_yet');
  assert.deepEqual(JSON.parse(row.price_history), [{ date: '2026-09-17', price_month_idr: 40_000_000 }]);
  assert.deepEqual(JSON.parse(row.red_flags), ['construction']);
  assert.deepEqual(JSON.parse(row.images), [{ src_url: 'https://x/1.jpg', file: '1.jpg' }]);

  cleanup(ctx);
});

test('upsertProperty: first_seen defaults to now when the row has none', () => {
  const ctx = tmpDb();
  const now = '2026-09-17T06:00:00.000Z';
  const { row: input } = { row: baseRow({ first_seen: undefined }) };
  const result = upsertProperty(ctx.db, input, { now });
  const row = ctx.db.prepare('SELECT * FROM properties WHERE id = ?').get(result.id);
  assert.equal(row.first_seen, now);
  cleanup(ctx);
});

// ---------------------------------------------------------------------------
// upsertProperty — update: price change, price_history, gone/back transitions
// ---------------------------------------------------------------------------

test('upsertProperty: a price change on update appends to price_history and reports the change', () => {
  const ctx = tmpDb();
  const t1 = '2026-09-17T06:00:00.000Z';
  const t2 = '2026-09-18T06:00:00.000Z';
  const first = upsertProperty(ctx.db, baseRow(), { now: t1 });

  const result = upsertProperty(ctx.db, baseRow({ price_month_idr: 42_000_000 }), { now: t2 });
  assert.equal(result.id, first.id);
  assert.equal(result.action, 'updated');
  assert.deepEqual(result.changes, [{ what: 'price', from: 40_000_000, to: 42_000_000 }]);

  const row = ctx.db.prepare('SELECT * FROM properties WHERE id = ?').get(first.id);
  assert.equal(row.price_month_idr, 42_000_000);
  assert.equal(row.last_seen, t2);
  assert.deepEqual(JSON.parse(row.price_history), [
    { date: '2026-09-17', price_month_idr: 40_000_000 },
    { date: '2026-09-18', price_month_idr: 42_000_000 },
  ]);

  cleanup(ctx);
});

test('upsertProperty: availability flipping to/from gone is logged as a change', () => {
  const ctx = tmpDb();
  const first = upsertProperty(ctx.db, baseRow(), { now: '2026-09-17T06:00:00.000Z' });

  const gone = upsertProperty(ctx.db, baseRow({ availability: 'gone' }), { now: '2026-09-18T06:00:00.000Z' });
  assert.deepEqual(gone.changes, [{ what: 'gone' }]);

  const back = upsertProperty(ctx.db, baseRow({ availability: 'available' }), { now: '2026-09-19T06:00:00.000Z' });
  assert.deepEqual(back.changes, [{ what: 'gone' }]);

  const row = ctx.db.prepare('SELECT availability FROM properties WHERE id = ?').get(first.id);
  assert.equal(row.availability, 'available');

  cleanup(ctx);
});

test('upsertProperty: re-upserting identical facts reports "unchanged"', () => {
  const ctx = tmpDb();
  upsertProperty(ctx.db, baseRow(), { now: '2026-09-17T06:00:00.000Z' });
  const result = upsertProperty(ctx.db, baseRow(), { now: '2026-09-18T06:00:00.000Z' });
  assert.equal(result.action, 'unchanged');
  assert.deepEqual(result.changes, []);
  // last_seen still advances even when nothing else changed
  const row = ctx.db.prepare('SELECT last_seen FROM properties WHERE id = ?').get(result.id);
  assert.equal(row.last_seen, '2026-09-18T06:00:00.000Z');
  cleanup(ctx);
});

// ---------------------------------------------------------------------------
// upsertProperty — person fields survive; red_flags merge
// ---------------------------------------------------------------------------

test('upsertProperty: person fields survive a re-scrape; red_flags are merged, never replaced', () => {
  const ctx = tmpDb();
  const { id } = upsertProperty(ctx.db, baseRow({ red_flags: ['construction'] }), { now: '2026-09-17T06:00:00.000Z' });

  ctx.db
    .prepare('UPDATE properties SET status = ?, status_by = ?, status_at = ?, living_open = ? WHERE id = ?')
    .run('shortlist', 1, '2026-09-17T07:00:00.000Z', 1, id);

  const result = upsertProperty(
    ctx.db,
    baseRow({ living_open: null, red_flags: ['main_road'] }),
    { now: '2026-09-18T06:00:00.000Z' }
  );
  assert.equal(result.id, id);

  const row = ctx.db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  assert.equal(row.status, 'shortlist', 'status must never be overwritten by the scraper');
  assert.equal(row.living_open, 1, 'a person-set value survives even when the scraper re-detects nothing');
  assert.deepEqual(JSON.parse(row.red_flags).sort(), ['construction', 'main_road']);

  cleanup(ctx);
});

test('upsertProperty: an unset person field is filled in by the scraper on first sight', () => {
  const ctx = tmpDb();
  const { id } = upsertProperty(ctx.db, baseRow({ workspace: null }), { now: '2026-09-17T06:00:00.000Z' });
  let row = ctx.db.prepare('SELECT workspace FROM properties WHERE id = ?').get(id);
  assert.equal(row.workspace, null);

  upsertProperty(ctx.db, baseRow({ workspace: 1 }), { now: '2026-09-18T06:00:00.000Z' });
  row = ctx.db.prepare('SELECT workspace FROM properties WHERE id = ?').get(id);
  assert.equal(row.workspace, 1);

  cleanup(ctx);
});

// ---------------------------------------------------------------------------
// upsertProperty — pin upgrade
// ---------------------------------------------------------------------------

test('upsertProperty: a centroid pin is replaced by a listing_map pin, and beach recomputes', () => {
  const ctx = tmpDb();
  const { id } = upsertProperty(
    ctx.db,
    baseRow({ lat: -8.628, lng: 115.099, pin_source: 'centroid', beach_km: 0.9, beach_source: 'computed' }),
    { now: '2026-09-17T06:00:00.000Z' }
  );

  upsertProperty(
    ctx.db,
    baseRow({ lat: -8.6315, lng: 115.0975, pin_source: 'listing_map', beach_km: null, beach_source: null }),
    { now: '2026-09-18T06:00:00.000Z' }
  );

  const row = ctx.db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  assert.equal(row.pin_source, 'listing_map');
  assert.equal(row.lat, -8.6315);
  assert.equal(row.lng, 115.0975);
  assert.equal(row.beach_source, 'computed');
  assert.ok(row.beach_km < 0.9, 'the beach distance should have been recomputed from the better pin');
  assert.equal(row.map_url, 'https://www.google.com/maps?q=-8.6315,115.0975');

  cleanup(ctx);
});

test('upsertProperty: a centroid pin does not get replaced when beach_source is listing_text', () => {
  const ctx = tmpDb();
  const { id } = upsertProperty(
    ctx.db,
    baseRow({
      lat: -8.628, lng: 115.099, pin_source: 'centroid',
      beach_km: 0.35, beach_name: 'Cemagi Beach', beach_source: 'listing_text',
    }),
    { now: '2026-09-17T06:00:00.000Z' }
  );

  upsertProperty(
    ctx.db,
    baseRow({ lat: -8.6315, lng: 115.0975, pin_source: 'listing_map', beach_km: null, beach_source: null }),
    { now: '2026-09-18T06:00:00.000Z' }
  );

  const row = ctx.db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  assert.equal(row.pin_source, 'listing_map', 'the pin itself still upgrades');
  assert.equal(row.beach_km, 0.35, 'but a listing_text beach distance is never recomputed');
  assert.equal(row.beach_source, 'listing_text');

  cleanup(ctx);
});

// ---------------------------------------------------------------------------
// rescoreAll
// ---------------------------------------------------------------------------

test('rescoreAll: writes scope/fit_score/flagged consistent with scoreRow and returns totals', () => {
  const ctx = tmpDb();
  const config = getConfig(ctx.db);

  // in_filter, high-scoring, no red flags -> flagged
  upsertProperty(ctx.db, baseRow({ key: 'bhi:A', red_flags: [] }), { now: '2026-09-17T06:00:00.000Z' });
  // market (bedrooms out of band for hard filters via 'rooms', but still in aggregation band)
  upsertProperty(
    ctx.db,
    baseRow({ key: 'bhi:B', bedrooms: 4, price_month_idr: 60_000_000, red_flags: [] }),
    { now: '2026-09-17T06:00:00.000Z' }
  );

  const summary = rescoreAll(ctx.db, config);
  assert.equal(summary.total, 2);
  assert.equal(summary.in_filter + summary.market, 2);

  for (const row of ctx.db.prepare('SELECT * FROM properties').all()) {
    const parsed = parseRow(row);
    const expected = scoreRow(parsed, config);
    assert.equal(row.scope, expected.scope, row.key);
    assert.equal(row.fit_score, expected.fit_score, row.key);
    assert.equal(row.flagged, expected.flagged, row.key);
    assert.deepEqual(JSON.parse(row.red_flags), expected.red_flags, row.key);
  }

  cleanup(ctx);
});

// ---------------------------------------------------------------------------
// markGone
// ---------------------------------------------------------------------------

test('markGone sets availability=gone and last_seen', () => {
  const ctx = tmpDb();
  const { id } = upsertProperty(ctx.db, baseRow(), { now: '2026-09-17T06:00:00.000Z' });
  markGone(ctx.db, id, '2026-09-20T06:00:00.000Z');
  const row = ctx.db.prepare('SELECT availability, last_seen FROM properties WHERE id = ?').get(id);
  assert.equal(row.availability, 'gone');
  assert.equal(row.last_seen, '2026-09-20T06:00:00.000Z');
  cleanup(ctx);
});

// ---------------------------------------------------------------------------
// runs: startRun / finishRun
// ---------------------------------------------------------------------------

test('startRun / finishRun round-trip', () => {
  const ctx = tmpDb();
  const id = startRun(ctx.db, 'scrape', ['bhi']);
  assert.ok(Number.isInteger(id));

  finishRun(ctx.db, id, {
    seen: 10, new: 3, updated: 5, gone: 1, flagged: 2,
    notes: ['ok'], errors: [], weight_changes: [{ feature: 'pool', from: 12, to: 14, because: 'x' }],
  });

  const row = ctx.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  assert.equal(row.kind, 'scrape');
  assert.deepEqual(JSON.parse(row.sources), ['bhi']);
  assert.ok(row.finished_at);
  assert.equal(row.seen, 10);
  assert.equal(row.new, 3);
  assert.equal(row.updated, 5);
  assert.equal(row.gone, 1);
  assert.equal(row.flagged, 2);
  assert.deepEqual(JSON.parse(row.notes), ['ok']);
  assert.deepEqual(JSON.parse(row.errors), []);
  assert.deepEqual(JSON.parse(row.weight_changes), [{ feature: 'pool', from: 12, to: 14, because: 'x' }]);

  cleanup(ctx);
});

// ---------------------------------------------------------------------------
// countsSummary
// ---------------------------------------------------------------------------

test('countsSummary: shape and area rollup, sorted by n desc', () => {
  const ctx = tmpDb();
  upsertProperty(ctx.db, baseRow({ key: 'bhi:A', area: 'cemagi' }), { now: '2026-09-17T06:00:00.000Z' });
  upsertProperty(ctx.db, baseRow({ key: 'bhi:B', area: 'cemagi' }), { now: '2026-09-17T06:00:00.000Z' });
  upsertProperty(ctx.db, baseRow({ key: 'bhi:C', area: 'uluwatu' }), { now: '2026-09-17T06:00:00.000Z' });
  rescoreAll(ctx.db);

  const summary = countsSummary(ctx.db);
  assert.equal(summary.total, 3);
  assert.equal(typeof summary.in_filter, 'number');
  assert.equal(typeof summary.market, 'number');
  assert.equal(typeof summary.flagged, 'number');
  assert.equal(summary.gone, 0);
  assert.ok(Array.isArray(summary.by_area));
  assert.equal(summary.by_area[0].area, 'cemagi');
  assert.equal(summary.by_area[0].n, 2);
  assert.ok(summary.by_area[0].n >= summary.by_area[1].n);

  cleanup(ctx);
});

// ---------------------------------------------------------------------------
// PERSON_FIELDS / parseRow sanity
// ---------------------------------------------------------------------------

test('PERSON_FIELDS includes the scraper-seeded and person-editable fields', () => {
  for (const f of ['status', 'living_open', 'beach_km', 'lat', 'lng', 'pin_source', 'red_flags']) {
    assert.ok(PERSON_FIELDS.includes(f), f);
  }
});

test('parseRow JSON-parses the known columns and tolerates null/bad JSON', () => {
  const row = { images: '[{"a":1}]', red_flags: null, raw: 'not json', price_history: '[]', alt_urls: null, inclusions: null };
  const parsed = parseRow(row);
  assert.deepEqual(parsed.images, [{ a: 1 }]);
  assert.equal(parsed.red_flags, null);
  assert.equal(parsed.raw, 'not json');
  assert.deepEqual(parsed.price_history, []);
});
