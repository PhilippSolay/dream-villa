// Migration 013 / repricePosts: stored Facebook rents are re-read from their text.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, MIGRATIONS } from '../src/db.js';
import { repricePosts } from '../src/scrape/reprice.js';

function tmpDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-reprice-'));
  const db = openDb(path.join(dir, 'villa.db'));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

const insert = (db, row) =>
  db
    .prepare(
      `INSERT INTO properties (key, source, url, title, area, description, price_month_idr, price_year_idr, term,
         price_history, first_seen, last_seen)
       VALUES (@key, @source, 'https://x.test', 't', 'pererenan', @description, @price_month_idr, @price_year_idr, @term,
         @price_history, '2026-09-27T08:00:00.000Z', '2026-09-27T08:00:00.000Z')`
    )
    .run({ price_year_idr: null, price_history: null, ...row }).lastInsertRowid;

const get = (db, id) => db.prepare('SELECT * FROM properties WHERE id = ?').get(id);

test('repricePosts: a year read as the rent becomes the stated rent, history follows', (t) => {
  const db = tmpDb(t);
  const id = insert(db, {
    key: 'fb:8672', source: 'fb',
    description: 'Available: 28 September 2026\nMonthly: IDR 66,000,000 / month\nSecurity Deposit: IDR 15,000,000',
    price_month_idr: 2026, term: 'monthly',
    price_history: JSON.stringify([{ date: '2026-09-27', price_month_idr: 2026 }]),
  });
  assert.deepEqual(repricePosts(db), { checked: 1, changed: 1 });
  const row = get(db, id);
  assert.equal(row.price_month_idr, 66_000_000);
  assert.equal(row.price_year_idr, null);
  assert.equal(row.term, 'monthly');
  assert.deepEqual(JSON.parse(row.price_history), [{ date: '2026-09-27', price_month_idr: 66_000_000 }]);
});

test('repricePosts: both terms are stored, a yearly-only rent derives its month', (t) => {
  const db = tmpDb(t);
  const both = insert(db, {
    key: 'fb:1', source: 'fb', description: 'IDR 450.000.000 / Year\nIDR 45.000.000 /month',
    price_month_idr: 37_500_000, price_year_idr: 450_000_000, term: 'yearly',
  });
  const yearly = insert(db, {
    key: 'fb:2', source: 'fb', description: 'Rental price : 65million per year (yearly only) ( 3 mil security deposit )',
    price_month_idr: 65_000_000, term: 'monthly',
  });
  repricePosts(db);
  assert.equal(get(db, both).price_month_idr, 45_000_000);
  assert.equal(get(db, both).term, 'both');
  assert.equal(get(db, yearly).price_year_idr, 65_000_000);
  assert.equal(get(db, yearly).price_month_idr, Math.round(65_000_000 / 12));
  assert.equal(get(db, yearly).term, 'yearly');
});

test('repricePosts: a sale post loses its made-up rent; agency prices stay, a missing one is filled from the text', (t) => {
  const db = tmpDb(t);
  const sale = insert(db, {
    key: 'fb:3', source: 'fb', description: 'Price: IDR 3,500,000,000\n* 30-Year Leasehold',
    price_month_idr: 291_666_667, price_year_idr: 3_500_000_000, term: 'yearly',
    price_history: JSON.stringify([{ date: '2026-09-01', price_month_idr: 291_666_667 }]),
  });
  const agency = insert(db, {
    key: 'bhi:1', source: 'bhi', description: 'Available: 28 September 2026', price_month_idr: 2026, term: 'monthly',
  });
  const right = insert(db, {
    key: 'fb:4', source: 'fb', description: '3BR villa Cemagi, IDR 40.000.000/month', price_month_idr: 40_000_000, term: 'monthly',
  });
  const unpriced = insert(db, {
    key: 'balivillahub:1', source: 'balivillahub', description: '💰 PRICE: IDR 37,000,000 / month', price_month_idr: null, term: 'monthly',
  });
  const unpricedNoText = insert(db, {
    key: 'balivillahub:2', source: 'balivillahub', description: 'Ask for the price', price_month_idr: null, term: 'monthly',
  });
  assert.deepEqual(repricePosts(db), { checked: 4, changed: 2 });
  assert.equal(get(db, unpriced).price_month_idr, 37_000_000);
  assert.deepEqual(JSON.parse(get(db, unpriced).price_history), [{ date: '2026-09-27', price_month_idr: 37_000_000 }]);
  assert.equal(get(db, unpricedNoText).term, 'monthly');
  assert.equal(get(db, sale).price_month_idr, null);
  assert.equal(get(db, sale).price_year_idr, null);
  assert.equal(get(db, sale).term, null);
  assert.deepEqual(JSON.parse(get(db, sale).price_history), []);
  assert.equal(get(db, agency).price_month_idr, 2026);
  assert.equal(get(db, right).price_month_idr, 40_000_000);
});

test('migration 013_reprice_posts is registered after 012', () => {
  const names = MIGRATIONS.map((m) => m.name);
  assert.equal(names.indexOf('013_reprice_posts'), names.indexOf('012_for_sale') + 1);
});
