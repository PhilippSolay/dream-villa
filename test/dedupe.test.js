import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { dedupeAll, findDuplicates, diceTrigram, mergeInto } from '../src/scrape/dedupe.js';
import { upsertProperty } from '../src/scrape/store.js';

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

// ---------------------------------------------------------------------------
// Rule 2 (amended 2026-09-20): same area + compatible bedrooms + 2 shared photos
// ---------------------------------------------------------------------------

/** Hashes one bit apart are the same photograph; the pairs below are far apart. */
const HASH = {
  poolA: '00000000000000ff',
  poolB: '00000000000000fe', // 1 bit from poolA
  gardenA: '0f0f0f0f0f0f0f0f',
  gardenB: '0f0f0f0f0f0f0f0e', // 1 bit from gardenA
  other: '0000000000000000',
  nothing: 'ffffffffffffffff',
};

/** Two listings nobody could match on text: different titles, different descriptions. */
const textA = { title: 'Villa Melati', description: 'Agency copy, written by the agency.' };
const textB = { title: 'Disewakan rumah 2 kamar Cemagi', description: 'Postingan Facebook, teks lain.' };

test('dedupeAll — two shared photo hashes merge across a 20 % price gap and an unknown bedroom count', () => {
  const t = tmpDb();
  try {
    const keptId = insert(t.db, {
      ...older, ...textA, key: 'bhi:RF1', ref: 'RF1', price_month_idr: 40_000_000,
      images: JSON.stringify([
        { src_url: 'https://bhi.cdn/1.jpg', hash: HASH.poolA },
        { src_url: 'https://bhi.cdn/2.jpg', hash: HASH.gardenA },
      ]),
    });
    const dropId = insert(t.db, {
      ...newer, ...textB, key: 'fb:p1', ref: 'p1', source: 'fb', url: 'https://facebook.test/p1',
      bedrooms: null, // a Facebook post that never says how many bedrooms
      price_month_idr: 48_000_000, // 20 % apart — no price condition in rule 2
      images: JSON.stringify([
        { src_url: 'https://scontent.test/a.jpg', hash: HASH.poolB },
        { src_url: 'https://scontent.test/b.jpg', hash: HASH.gardenB },
      ]),
    });

    const pairs = findDuplicates(t.db);
    assert.equal(pairs.length, 1);
    assert.deepEqual({ k: pairs[0].kept_id, m: pairs[0].merged_id }, { k: keptId, m: dropId });
    assert.equal(pairs[0].reason, '2 shared photos (hash)');

    const { merged } = dedupeAll(t.db, { now: '2026-09-20T00:00:00.000Z' });
    assert.equal(merged.length, 1);
    assert.equal(t.db.prepare('SELECT availability FROM properties WHERE id = ?').get(dropId).availability, 'gone');
    assert.equal(JSON.parse(t.db.prepare('SELECT raw FROM properties WHERE id = ?').get(dropId).raw).merged_into, keptId);
  } finally {
    cleanup(t);
  }
});

test('dedupeAll — one shared photo is not enough on its own, but it is under the old rule', () => {
  const t = tmpDb();
  try {
    // A complex re-using its pool shot: one photo in common, prices 20 % apart.
    insert(t.db, {
      ...older, ...textA, key: 'bhi:RF1', ref: 'RF1', price_month_idr: 40_000_000,
      images: JSON.stringify([{ src_url: 'https://bhi.cdn/1.jpg', hash: HASH.poolA }]),
    });
    insert(t.db, {
      ...newer, ...textB, key: 'fb:p1', ref: 'p1', source: 'fb', url: 'https://facebook.test/p1',
      price_month_idr: 48_000_000,
      images: JSON.stringify([{ src_url: 'https://scontent.test/a.jpg', hash: HASH.poolB }]),
    });
    assert.deepEqual(findDuplicates(t.db), []);

    // The same single photo with the SPEC's price and bedroom conditions does merge —
    // the old rule's image test now reads hashes, not just `src_url`.
    const closeId = insert(t.db, {
      ...newer, ...textB, key: 'olx:O1', ref: 'O1', source: 'olx', url: 'https://olx/one',
      price_month_idr: 41_000_000, // 2.5 % from the first row
      images: JSON.stringify([{ src_url: 'https://olx.cdn/z.jpg', hash: HASH.poolB }]),
    });
    const pairs = findDuplicates(t.db).filter((p) => p.merged_id === closeId);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].reason, 'shared image (hash)');
  } finally {
    cleanup(t);
  }
});

test('dedupeAll — two shared photos never merge two different known bedroom counts', () => {
  const t = tmpDb();
  try {
    const images = (x, y) => JSON.stringify([{ src_url: `https://c/${x}.jpg`, hash: x }, { src_url: `https://c/${y}.jpg`, hash: y }]);
    insert(t.db, { ...older, ...textA, key: 'bhi:RF1', ref: 'RF1', bedrooms: 2, images: images(HASH.poolA, HASH.gardenA) });
    insert(t.db, {
      ...newer, ...textB, key: 'fb:p1', ref: 'p1', source: 'fb', url: 'https://facebook.test/p1',
      bedrooms: 3, images: images(HASH.poolB, HASH.gardenB),
    });
    assert.deepEqual(findDuplicates(t.db), [], 'SPEC §6: never merge across different bedrooms');
  } finally {
    cleanup(t);
  }
});

test('dedupeAll — a url match and a hash match together count as two shared photos', () => {
  const t = tmpDb();
  try {
    const keptId = insert(t.db, {
      ...older, ...textA, key: 'bhi:RF1', ref: 'RF1', price_month_idr: 40_000_000,
      images: JSON.stringify([
        { src_url: 'https://cdn/shared.jpg' },
        { src_url: 'https://bhi.cdn/2.jpg', hash: HASH.gardenA },
      ]),
    });
    const dropId = insert(t.db, {
      ...newer, ...textB, key: 'olx:O1', ref: 'O1', source: 'olx', url: 'https://olx/one',
      price_month_idr: 52_000_000, // 30 % apart, still merges under rule 2
      images: JSON.stringify([
        { src_url: 'https://cdn/shared.jpg' },
        { src_url: 'https://olx.cdn/9.jpg', hash: HASH.gardenB },
      ]),
    });

    const pairs = findDuplicates(t.db);
    assert.equal(pairs.length, 1);
    assert.deepEqual({ k: pairs[0].kept_id, m: pairs[0].merged_id }, { k: keptId, m: dropId });
    assert.equal(pairs[0].reason, '2 shared photos (url+hash)');
  } finally {
    cleanup(t);
  }
});

test('dedupeAll — the complex guard survives rule 2: RF9183A and RF9183B share photos and stay apart', () => {
  const t = tmpDb();
  try {
    const images = JSON.stringify([
      { src_url: 'https://bhi.cdn/pool.jpg', hash: HASH.poolA },
      { src_url: 'https://bhi.cdn/garden.jpg', hash: HASH.gardenA },
    ]);
    insert(t.db, { ...older, ...textA, key: 'bhi:RF9183A', ref: 'RF9183A', url: 'https://bhi/a', images });
    insert(t.db, {
      ...newer, ...textB, key: 'bhi:RF9183B', ref: 'RF9183B', url: 'https://bhi/b', bedrooms: null,
      images: JSON.stringify([
        { src_url: 'https://bhi.cdn/pool.jpg', hash: HASH.poolB },
        { src_url: 'https://bhi.cdn/garden2.jpg', hash: HASH.gardenB },
      ]),
    });
    assert.deepEqual(findDuplicates(t.db), []);
  } finally {
    cleanup(t);
  }
});

test('dedupeAll — rule 2 needs a real area: `other` never auto-merges on photos alone', () => {
  const t = tmpDb();
  try {
    const images = (x, y) => JSON.stringify([{ src_url: `https://c/${x}.jpg`, hash: x }, { src_url: `https://c/${y}.jpg`, hash: y }]);
    for (const area of ['other']) {
      insert(t.db, {
        ...older, ...textA, key: `bhi:${area}`, ref: `R${area}`, area, price_month_idr: 40_000_000,
        images: images(HASH.poolA, HASH.gardenA),
      });
      insert(t.db, {
        ...newer, ...textB, key: `fb:${area}`, ref: `F${area}`, source: 'fb', url: `https://facebook.test/${area}`,
        area, bedrooms: null, price_month_idr: 48_000_000, images: images(HASH.poolB, HASH.gardenB),
      });
    }
    assert.deepEqual(findDuplicates(t.db), []);
  } finally {
    cleanup(t);
  }
});

// ---------------------------------------------------------------------------
// 2026-09-20: promo photos are not evidence; an agency row outlives a post
// ---------------------------------------------------------------------------

const H = (n) => n.toString(16).padStart(16, '0');

test('dedupeAll — a photo seen across two areas or two bedroom counts is an agent logo, not evidence', () => {
  const t = tmpDb();
  const { db } = t;
  // logo on three listings in two areas; the two Seseh rows share only the logo plus one real photo
  insert(db, { key: 'bvh:1', source: 'balivillahub', ref: '1', area: 'seseh', bedrooms: 2, price_month_idr: 30_000_000, first_seen: '2026-09-01T00:00:00Z',
    images: JSON.stringify([{ src_url: 'https://cdn/logo1.jpg', hash: H(1) }, { src_url: 'https://cdn/a1.jpg', hash: H(0xf0f0) }]) });
  insert(db, { key: 'bvh:2', source: 'balivillahub', ref: '2', area: 'seseh', bedrooms: 2, price_month_idr: 45_000_000, first_seen: '2026-09-02T00:00:00Z',
    images: JSON.stringify([{ src_url: 'https://cdn/logo2.jpg', hash: H(1) }, { src_url: 'https://cdn/a2.jpg', hash: H(0xf0f1) }]) });
  insert(db, { key: 'bvh:3', source: 'balivillahub', ref: '3', area: 'uluwatu', bedrooms: 3, price_month_idr: 60_000_000, first_seen: '2026-09-03T00:00:00Z',
    images: JSON.stringify([{ src_url: 'https://cdn/logo3.jpg', hash: H(1) }]) });
  assert.deepEqual(findDuplicates(db), [], 'one real photo plus the logo is not two shared photos');

  // the same two Seseh rows with a second genuine photo in common do merge
  db.prepare('UPDATE properties SET images = ? WHERE key = ?').run(
    JSON.stringify([{ src_url: 'https://cdn/logo2.jpg', hash: H(1) }, { src_url: 'https://cdn/a2.jpg', hash: H(0xf0f1) }, { src_url: 'https://cdn/b2.jpg', hash: H(0xabcd) }]), 'bvh:2');
  db.prepare('UPDATE properties SET images = ? WHERE key = ?').run(
    JSON.stringify([{ src_url: 'https://cdn/logo1.jpg', hash: H(1) }, { src_url: 'https://cdn/a1.jpg', hash: H(0xf0f0) }, { src_url: 'https://cdn/b1.jpg', hash: H(0xabcc) }]), 'bvh:1');
  const pairs = findDuplicates(db);
  assert.equal(pairs.length, 1);
  assert.match(pairs[0].reason, /^2 shared photos \(hash\)$/);
  cleanup(t);
});

test('dedupeAll — the agency row is kept over a newer-or-older Facebook post', () => {
  const t = tmpDb();
  const { db } = t;
  const post = insert(db, { key: 'fb:p1', source: 'fb', ref: 'p1', area: 'cemagi', bedrooms: null, price_month_idr: 550_000_000, first_seen: '2026-08-01T00:00:00Z',
    images: JSON.stringify([{ src_url: 'https://fb/1.jpg', hash: H(0x1111) }, { src_url: 'https://fb/2.jpg', hash: H(0x2222) }]) });
  const agency = insert(db, { key: 'bcl:v1', source: 'balicoconutliving', ref: 'v1', area: 'cemagi', bedrooms: 3, price_month_idr: 52_000_000, first_seen: '2026-09-10T00:00:00Z',
    images: JSON.stringify([{ src_url: 'https://cdn/1.jpg', hash: H(0x1110) }, { src_url: 'https://cdn/2.jpg', hash: H(0x2223) }]) });
  const { merged } = dedupeAll(db);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].kept_id, agency, 'the agency record survives although it is newer');
  assert.equal(merged[0].merged_id, post);
  const kept = db.prepare('SELECT price_month_idr, bedrooms FROM properties WHERE id = ?').get(agency);
  assert.equal(kept.price_month_idr, 52_000_000, "the post's yearly-read-as-monthly price does not win");
  assert.equal(db.prepare('SELECT availability FROM properties WHERE id = ?').get(post).availability, 'gone');
  cleanup(t);
});

test('dedupeAll — a hand merge survives a re-scrape of the merged row, and is neither redone nor reversed', () => {
  const t = tmpDb();
  try {
    const olderId = insert(t.db, { ...older, key: 'bhi:RF1', ref: 'RF1', url: 'https://bhi/one-rf1' });
    const newerId = insert(t.db, {
      ...newer, key: 'kibarer:K9', ref: 'K9', source: 'kibarer', url: 'https://kibarer/one',
    });
    // A person keeps the newer row; the automatic pass would have kept the older one.
    const res = mergeInto(t.db, newerId, olderId, { by: 1, now: '2026-09-20T00:00:00.000Z' });
    assert.equal(res.merged_id, olderId);

    // Next morning the source lists the merged row again, with a new `raw`.
    upsertProperty(
      t.db,
      { key: 'bhi:RF1', availability: 'available', price_month_idr: 39_000_000, raw: JSON.stringify({ ref: 'RF1', v: 2 }) },
      { now: '2026-09-21T00:00:00.000Z' }
    );
    const drop = t.db.prepare('SELECT * FROM properties WHERE id = ?').get(olderId);
    assert.equal(drop.availability, 'gone');
    assert.equal(drop.removed_reason, 'merged');
    assert.equal(drop.removed_at, '2026-09-20T00:00:00.000Z');
    assert.equal(drop.price_month_idr, 39_000_000, 'its facts still update');
    const raw = JSON.parse(drop.raw);
    assert.equal(raw.v, 2);
    assert.equal(raw.merged_into, newerId);
    assert.equal(raw.merged_by, 1);

    assert.deepEqual(findDuplicates(t.db), []);
    assert.deepEqual(dedupeAll(t.db).merged, []);
    assert.equal(t.db.prepare('SELECT availability FROM properties WHERE id = ?').get(newerId).availability, 'available');
    assert.equal(mergeInto(t.db, olderId, newerId).error, 'keeper_merged');
  } finally {
    cleanup(t);
  }
});

test('dedupeAll — a row marked merged only in raw is never a candidate', () => {
  const t = tmpDb();
  try {
    insert(t.db, { ...older, key: 'bhi:RF1', ref: 'RF1', url: 'https://bhi/one-rf1' });
    insert(t.db, {
      ...newer, key: 'kibarer:K9', ref: 'K9', source: 'kibarer', url: 'https://kibarer/one',
      raw: JSON.stringify({ merged_into: 1 }),
    });
    assert.deepEqual(findDuplicates(t.db), []);
  } finally {
    cleanup(t);
  }
});
