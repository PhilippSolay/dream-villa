import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { dedupeAll, findDuplicates, diceTrigram } from '../src/scrape/dedupe.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-dedupe-'));
  const db = openDb(path.join(dir, 'villa.db'));
  return { db, dir };
}

function cleanup({ db, dir }) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Insert a property straight into the table — dedupe only reads columns. */
function insert(db, overrides = {}) {
  const row = {
    key: 'bhi:RF1',
    ref: 'RF1',
    source: 'bhi',
    url: 'https://bali-home-immo.com/a-rf1',
    title: 'Modern 2 Bedroom Villa in Cemagi Beachside',
    description: 'A calm two bedroom villa a short walk from the beach, with a big open living room.',
    area: 'cemagi',
    bedrooms: 2,
    price_month_idr: 40_000_000,
    availability: 'available',
    first_seen: '2026-09-01T00:00:00.000Z',
    last_seen: '2026-09-01T00:00:00.000Z',
    raw: JSON.stringify({ ref: 'RF1' }),
    ...overrides,
  };
  const cols = Object.keys(row);
  const info = db
    .prepare(`INSERT INTO properties (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c]));
  return Number(info.lastInsertRowid);
}

const older = { first_seen: '2026-09-01T00:00:00.000Z' };
const newer = { first_seen: '2026-09-10T00:00:00.000Z' };

test('diceTrigram — identical, disjoint and near-identical strings', () => {
  assert.equal(diceTrigram('abc', 'abc'), 1);
  assert.equal(diceTrigram('Modern Villa', 'modern   villa'), 1); // normalised
  assert.equal(diceTrigram('', 'anything'), 0);
  assert.equal(diceTrigram(null, undefined), 0);

  const near = diceTrigram(
    'Modern 3 Bedroom Villa for Rental in Bali Cemagi Beachside',
    'Modern 3 Bedroom Villa For Rent in Bali Cemagi Beach Side'
  );
  assert.ok(near >= 0.8, `expected >= 0.8, got ${near}`);

  const far = diceTrigram('Cliff villa in Uluwatu', 'Tiny studio in Mengwi');
  assert.ok(far < 0.3, `expected < 0.3, got ${far}`);

  // symmetric
  assert.equal(diceTrigram('one two three', 'one two four'), diceTrigram('one two four', 'one two three'));
});

test('dedupeAll — a true duplicate folds into the older row', () => {
  const t = tmpDb();
  try {
    const keptId = insert(t.db, { ...older, key: 'bhi:RF1', ref: 'RF1', url: 'https://bhi/one-rf1', land_m2: null });
    const dropId = insert(t.db, {
      ...newer,
      key: 'kibarer:K9',
      ref: 'K9',
      source: 'kibarer',
      url: 'https://kibarer/one',
      alt_urls: JSON.stringify(['https://olx/one']),
      title: 'Modern 2 Bedroom Villa in Cemagi Beach Side',
      price_month_idr: 41_000_000, // 2.5 % apart
      land_m2: 250,
      raw: JSON.stringify({ ref: 'K9' }),
    });

    t.db.prepare('INSERT INTO ratings (property_id, by, feature, score) VALUES (?, ?, ?, ?)')
      .run(dropId, 1, 'quiet', 4);
    t.db.prepare('INSERT INTO feedback (property_id, by, text) VALUES (?, ?, ?)')
      .run(dropId, 1, 'loved the garden');

    const pairs = findDuplicates(t.db);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].kept_id, keptId);
    assert.equal(pairs[0].merged_id, dropId);

    const { merged } = dedupeAll(t.db, { now: '2026-09-17T00:00:00.000Z' });
    assert.equal(merged.length, 1);
    assert.deepEqual({ kept_id: merged[0].kept_id, merged_id: merged[0].merged_id }, { kept_id: keptId, merged_id: dropId });
    assert.match(merged[0].reason, /title similarity/);

    const kept = t.db.prepare('SELECT * FROM properties WHERE id = ?').get(keptId);
    assert.deepEqual(JSON.parse(kept.alt_urls), ['https://kibarer/one', 'https://olx/one']);
    assert.equal(kept.land_m2, 250, 'a null in the survivor is filled from the merged row');
    assert.notEqual(kept.availability, 'gone');

    const dropped = t.db.prepare('SELECT * FROM properties WHERE id = ?').get(dropId);
    assert.equal(dropped.availability, 'gone');
    assert.equal(JSON.parse(dropped.raw).merged_into, keptId);
    assert.equal(dropped.last_seen, '2026-09-17T00:00:00.000Z');

    assert.equal(t.db.prepare('SELECT property_id FROM ratings').get().property_id, keptId);
    assert.equal(t.db.prepare('SELECT property_id FROM feedback').get().property_id, keptId);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM properties').get().n, 2, 'never deletes');
  } finally {
    cleanup(t);
  }
});

test('dedupeAll — different bedrooms never merge', () => {
  const t = tmpDb();
  try {
    insert(t.db, { ...older, key: 'bhi:RF1', ref: 'RF1', bedrooms: 2 });
    insert(t.db, { ...newer, key: 'kibarer:K1', ref: 'K1', source: 'kibarer', bedrooms: 3 });
    assert.deepEqual(findDuplicates(t.db), []);
    assert.deepEqual(dedupeAll(t.db).merged, []);
  } finally {
    cleanup(t);
  }
});

test('dedupeAll — unknown bedrooms never merge', () => {
  const t = tmpDb();
  try {
    insert(t.db, { ...older, key: 'bhi:RF1', ref: 'RF1', bedrooms: null });
    insert(t.db, { ...newer, key: 'kibarer:K1', ref: 'K1', source: 'kibarer', bedrooms: null });
    assert.deepEqual(findDuplicates(t.db), []);
  } finally {
    cleanup(t);
  }
});

test('dedupeAll — RF9183A and RF9183B are units in one complex, not duplicates', () => {
  const t = tmpDb();
  try {
    insert(t.db, {
      ...older, key: 'bhi:RF9183A', ref: 'RF9183A', url: 'https://bhi/x-rf9183a',
      title: 'Modern 3 Bedroom Villa for Rental in Bali Cemagi Beachside', bedrooms: 3, price_month_idr: 44_000_000,
    });
    insert(t.db, {
      ...newer, key: 'bhi:RF9183B', ref: 'RF9183B', url: 'https://bhi/x-rf9183b',
      title: 'Modern 3 Bedroom Villa for Rental in Bali Cemagi Beachside', bedrooms: 3, price_month_idr: 44_000_000,
    });
    assert.deepEqual(findDuplicates(t.db), []);

    // …but the very same pair on two different sources IS a duplicate.
    insert(t.db, {
      ...newer, key: 'kibarer:RF9183B', ref: 'RF9183B', source: 'kibarer', url: 'https://kibarer/x',
      title: 'Modern 3 Bedroom Villa for Rental in Bali Cemagi Beachside', bedrooms: 3, price_month_idr: 44_000_000,
    });
    assert.equal(findDuplicates(t.db).length, 2);
  } finally {
    cleanup(t);
  }
});

test('dedupeAll — a 6 % price gap is too far apart', () => {
  const t = tmpDb();
  try {
    insert(t.db, { ...older, key: 'bhi:RF1', ref: 'RF1', price_month_idr: 40_000_000 });
    insert(t.db, {
      ...newer, key: 'kibarer:K1', ref: 'K1', source: 'kibarer', url: 'https://kibarer/one',
      price_month_idr: 42_400_000, // 6 % of 40 M
    });
    assert.deepEqual(findDuplicates(t.db), []);
  } finally {
    cleanup(t);
  }
});

test('dedupeAll — within 5 % of the larger price still merges', () => {
  const t = tmpDb();
  try {
    const keptId = insert(t.db, { ...older, key: 'bhi:RF1', ref: 'RF1', price_month_idr: 40_000_000 });
    const dropId = insert(t.db, {
      ...newer, key: 'olx:O1', ref: 'O1', source: 'olx', url: 'https://olx/one',
      price_month_idr: 42_000_000, // 5 % of 42 M
    });
    const pairs = findDuplicates(t.db);
    assert.equal(pairs.length, 1);
    assert.deepEqual({ k: pairs[0].kept_id, m: pairs[0].merged_id }, { k: keptId, m: dropId });
  } finally {
    cleanup(t);
  }
});

test('dedupeAll — a shared image url is enough, a row already gone is ignored', () => {
  const t = tmpDb();
  try {
    const keptId = insert(t.db, {
      ...older, key: 'bhi:RF1', ref: 'RF1', title: 'Something Entirely Different', description: 'nothing alike at all',
      images: JSON.stringify([{ src_url: 'https://cdn/a.jpg' }, { src_url: 'https://cdn/b.jpg' }]),
    });
    const dropId = insert(t.db, {
      ...newer, key: 'olx:O1', ref: 'O1', source: 'olx', url: 'https://olx/one',
      title: 'Villa Sewa Bulanan Cemagi', description: 'teks lain sama sekali',
      images: JSON.stringify([{ src_url: 'https://cdn/b.jpg' }]),
    });
    insert(t.db, {
      ...newer, key: 'olx:O2', ref: 'O2', source: 'olx', url: 'https://olx/two', availability: 'gone',
      images: JSON.stringify([{ src_url: 'https://cdn/a.jpg' }]),
    });

    const { merged } = dedupeAll(t.db);
    assert.equal(merged.length, 1);
    assert.deepEqual({ k: merged[0].kept_id, m: merged[0].merged_id }, { k: keptId, m: dropId });
    assert.match(merged[0].reason, /shared image/);
  } finally {
    cleanup(t);
  }
});

test('dedupeAll — a templated title alone never merges two refs of the same source', () => {
  const t = tmpDb();
  try {
    // Real pair from the 2026-09-17 sweep: 0.93 title similarity, same price, different villas.
    insert(t.db, {
      ...older, key: 'bhi:RF8504', ref: 'RF8504', url: 'https://bhi/a-rf8504',
      title: 'Brand New 2 Bedrooms Villa for Monthly Rental in Bali - Ungasan',
      description: 'A brand new villa on a quiet lane.', area: 'ungasan', price_month_idr: 37_500_000,
      images: JSON.stringify([{ src_url: 'https://cdn/8504-1.jpg' }]),
    });
    insert(t.db, {
      ...newer, key: 'bhi:RF8945', ref: 'RF8945', url: 'https://bhi/b-rf8945',
      title: 'Brand New 2 Bedrooms Villa for Yearly & Monthly Rental in Bali - Ungasan',
      description: 'Two bedrooms with a private pool, walking distance to the warungs.',
      area: 'ungasan', price_month_idr: 37_500_000,
      images: JSON.stringify([{ src_url: 'https://cdn/8945-1.jpg' }]),
    });

    assert.deepEqual(findDuplicates(t.db), [], 'the same agency re-using its title template is not a duplicate');

    // The same two titles on two different sources ARE a duplicate (SPEC §6 unchanged).
    insert(t.db, {
      ...newer, key: 'kibarer:K7', ref: 'K7', source: 'kibarer', url: 'https://kibarer/seven',
      title: 'Brand New 2 Bedrooms Villa for Yearly & Monthly Rental in Bali - Ungasan',
      description: 'Ganz andere Beschreibung.', area: 'ungasan', price_month_idr: 37_500_000,
    });
    assert.equal(findDuplicates(t.db).length, 2);
  } finally {
    cleanup(t);
  }
});
