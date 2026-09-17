import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { upsertProperty } from '../src/scrape/store.js';
import { geocodeMissing, geocodeOne } from '../src/scrape/geocode.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-geocode-'));
  const file = path.join(dir, 'villa.db');
  const db = openDb(file);
  return { db, dir };
}

function cleanup({ db, dir }) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

function baseRow(overrides = {}) {
  return {
    key: 'bhi:RF1', ref: 'RF1', source: 'bhi', url: 'https://bali-home-immo.com/x-rf1',
    title: 'Modern 2 Bedroom Villa', area: 'cemagi', bedrooms: 2,
    price_month_idr: 40_000_000, availability: 'available', pin_source: 'centroid',
    lat: -8.619, lng: 115.103,
    first_seen: '2026-09-17T00:00:00.000Z',
    ...overrides,
  };
}

function nominatimHit(lat, lon, display_name = 'Somewhere, Bali, Indonesia') {
  return { html: JSON.stringify([{ lat: String(lat), lon: String(lon), display_name }]), status: 200 };
}

function stubCtx(handler) {
  const calls = [];
  return {
    log: { warn: () => {}, info: () => {} },
    calls,
    fetchHtml: async (url, opts) => {
      calls.push(url);
      return handler(url, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// geocodeOne
// ---------------------------------------------------------------------------

test('geocodeOne: parses a Nominatim hit inside Bali', async () => {
  const ctx = stubCtx(() => nominatimHit(-8.62, 115.1));
  const result = await geocodeOne(ctx, { address: 'Jalan Nelayan', sub_area: 'Beach Side', area: 'cemagi', email: 'x@example.com' });
  assert.deepEqual(result, { lat: -8.62, lng: 115.1, display_name: 'Somewhere, Bali, Indonesia' });
});

test('geocodeOne: rejects a result outside Bali bbox', async () => {
  const ctx = stubCtx(() => nominatimHit(1.3, 103.8)); // Singapore
  const result = await geocodeOne(ctx, { address: 'Jalan Nelayan', sub_area: null, area: 'cemagi', email: 'x@example.com' });
  assert.equal(result, null);
});

test('geocodeOne: no address → null', async () => {
  const ctx = stubCtx(() => nominatimHit(-8.62, 115.1));
  const result = await geocodeOne(ctx, { address: '', sub_area: null, area: 'cemagi', email: 'x@example.com' });
  assert.equal(result, null);
  assert.equal(ctx.calls.length, 0);
});

test('geocodeOne: empty Nominatim result → null', async () => {
  const ctx = stubCtx(() => ({ html: '[]', status: 200 }));
  const result = await geocodeOne(ctx, { address: 'Jalan Nelayan', sub_area: null, area: 'cemagi', email: 'x@example.com' });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// geocodeMissing
// ---------------------------------------------------------------------------

test('geocodeMissing: updates lat/lng/pin_source and recomputes beach for a hit', async () => {
  const ctx0 = tmpDb();
  const { db } = ctx0;
  const { id } = upsertProperty(db, baseRow({ address: 'Jalan Nelayan No. 3', sub_area: 'Beach Side' }));

  const ctx = stubCtx(() => nominatimHit(-8.6255, 115.0995)); // Cemagi/Mengening beach point
  const result = await geocodeMissing(db, ctx, { email: 'x@example.com' });

  assert.equal(result.attempted, 1);
  assert.equal(result.resolved, 1);
  assert.equal(result.skipped, 0);

  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  assert.equal(row.pin_source, 'geocode');
  assert.equal(row.lat, -8.6255);
  assert.equal(row.lng, 115.0995);
  assert.equal(row.map_url, 'https://www.google.com/maps?q=-8.6255,115.0995');
  assert.equal(row.beach_source, 'computed');
  assert.ok(row.beach_km != null);

  cleanup(ctx0);
});

test('geocodeMissing: never overwrites a listing_text beach_source', async () => {
  const ctx0 = tmpDb();
  const { db } = ctx0;
  const { id } = upsertProperty(
    db,
    baseRow({ address: 'Jalan Nelayan No. 3', beach_km: 0.35, beach_name: 'Cemagi', beach_source: 'listing_text' })
  );

  const ctx = stubCtx(() => nominatimHit(-8.6255, 115.0995));
  await geocodeMissing(db, ctx, { email: 'x@example.com' });

  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  assert.equal(row.beach_source, 'listing_text');
  assert.equal(row.beach_km, 0.35);

  cleanup(ctx0);
});

test('geocodeMissing: a result outside Bali is rejected (row left untouched)', async () => {
  const ctx0 = tmpDb();
  const { db } = ctx0;
  const { id } = upsertProperty(db, baseRow({ address: 'Jalan Nelayan No. 3' }));

  const ctx = stubCtx(() => nominatimHit(1.3, 103.8));
  const result = await geocodeMissing(db, ctx, { email: 'x@example.com' });

  assert.equal(result.attempted, 1);
  assert.equal(result.resolved, 0);

  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  assert.equal(row.pin_source, 'centroid');

  cleanup(ctx0);
});

test('geocodeMissing: row without address is skipped, not attempted', async () => {
  const ctx0 = tmpDb();
  const { db } = ctx0;
  upsertProperty(db, baseRow({ address: null }));

  const ctx = stubCtx(() => nominatimHit(-8.62, 115.1));
  const result = await geocodeMissing(db, ctx, { email: 'x@example.com' });

  assert.equal(result.attempted, 0);
  assert.equal(result.resolved, 0);
  assert.equal(result.skipped, 1);
  assert.equal(ctx.calls.length, 0);

  cleanup(ctx0);
});

test('geocodeMissing: no email configured → whole batch skipped', async () => {
  const ctx0 = tmpDb();
  const { db } = ctx0;
  upsertProperty(db, baseRow({ address: 'Jalan Nelayan No. 3' }));
  upsertProperty(db, baseRow({ key: 'bhi:RF2', address: 'Jalan Lain' }));

  const ctx = stubCtx(() => nominatimHit(-8.62, 115.1));
  const result = await geocodeMissing(db, ctx, { email: undefined });

  assert.deepEqual(result, { attempted: 0, resolved: 0, skipped: 2 });
  assert.equal(ctx.calls.length, 0);

  cleanup(ctx0);
});

test('geocodeMissing: rows with a real pin (listing_map) are left alone', async () => {
  const ctx0 = tmpDb();
  const { db } = ctx0;
  upsertProperty(db, baseRow({ pin_source: 'listing_map', address: 'Jalan Nelayan No. 3' }));

  const ctx = stubCtx(() => nominatimHit(-8.62, 115.1));
  const result = await geocodeMissing(db, ctx, { email: 'x@example.com' });

  assert.deepEqual(result, { attempted: 0, resolved: 0, skipped: 0 });

  cleanup(ctx0);
});
