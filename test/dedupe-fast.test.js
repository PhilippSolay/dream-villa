// findDuplicates works each row's features out once (pairFeatures) instead of per pair.
// It must find exactly the pairs, keepers and reasons the per-pair rule helpers define —
// the loop it replaced, rebuilt here from those helpers, is the reference.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import {
  findDuplicates, matchReason, sharedPhotoReason, sameComplexDifferentUnit, bedroomsCompatible,
  promoImages, keeperFirst, priceClose,
} from '../src/scrape/dedupe.js';

/** The pre-2026-09-27 loop: every helper called per pair. */
function referenceFindDuplicates(db) {
  const rows = db
    .prepare("SELECT * FROM properties WHERE availability IS NULL OR availability <> 'gone' ORDER BY id")
    .all();
  const ignore = promoImages(rows);
  const buckets = new Map();
  for (const r of rows) {
    const k = r.area == null ? '\u0000null' : String(r.area);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const out = [];
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];
        if (a.key === b.key) continue;
        if (sameComplexDifferentUnit(a, b)) continue;
        let reason = null;
        if (a.area && a.area !== 'other' && bedroomsCompatible(a, b)) reason = sharedPhotoReason(a, b, { ignore });
        if (!reason && a.bedrooms != null && a.bedrooms === b.bedrooms && priceClose(a, b)) {
          reason = matchReason(a, b, { ignore });
        }
        if (!reason) continue;
        const [keep, drop] = keeperFirst(a, b);
        out.push({ kept_id: keep.id, merged_id: drop.id, reason });
      }
    }
  }
  return out;
}

// mulberry32: the same rows on every run.
function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A table built to hit every branch: shared photos by url and by near hash, a logo on
 * every area (ignored), template titles within one source, copied description openings,
 * complex units (RF9183A/B), legacy string images, malformed hashes, unknown bedrooms,
 * empty titles and areas, null descriptions, unreadable image JSON, gone rows.
 */
function seedRows(db, seed) {
  const rnd = prng(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const hex16 = () => Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
  const flip = (h, bits) => {
    const w = [...h].map((c) => parseInt(c, 16));
    for (let k = 0; k < bits; k++) w[Math.floor(rnd() * 16)] ^= 1 << Math.floor(rnd() * 4);
    return w.map((x) => x.toString(16)).join('');
  };

  // A villa's photographs turn up again on its other listings — same area, same bedrooms,
  // or promoImages would rightly call them an agent's stock. The logo is on every area.
  const pools = new Map();
  const poolFor = (area, bedrooms) => {
    const k = `${area}|${bedrooms ?? 2}`;
    if (!pools.has(k)) pools.set(k, Array.from({ length: 6 }, hex16));
    return pools.get(k);
  };
  const logo = hex16();
  const titles = [
    'Modern 2 Bedroom Villa in Cemagi Beachside',
    'Modern 2 Bedroom Villa in Cemagi Beach Side',
    'Brand New 2 Bedrooms Villa for Monthly Rental in Bali - Seseh',
    'Brand New 2 Bedrooms Villa for Monthly Rental in Bali - Pererenan',
    'Joglo with rice field view',
    'ab',
    '', // title is NOT NULL; an empty one is what a bare post leaves
  ];
  const descs = [
    'A calm two bedroom villa a short walk from the beach, with a big open living room and a pool.',
    'A calm two bedroom villa a short walk from the beach, with a big open living room and a garden.',
    'Traditional joglo among the rice fields, ten minutes to Seseh beach by scooter.',
    '',
    null,
  ];
  const insert = db.prepare(
    `INSERT INTO properties (key, ref, source, url, title, description, area, bedrooms, price_month_idr,
       availability, first_seen, last_seen, raw, images)
     VALUES (@key, @ref, @source, @url, @title, @description, @area, @bedrooms, @price_month_idr,
       @availability, @first_seen, @last_seen, '{}', @images)`
  );

  for (let n = 1; n <= 260; n++) {
    const source = pick(['bhi', 'bhi', 'kibarer', 'fb', 'wa']);
    const ref = source === 'bhi' ? `RF${9180 + Math.floor(rnd() * 4)}${pick(['', 'A', 'B'])}` : `R${n}`;
    const area = pick(['cemagi', 'cemagi', 'seseh', 'pererenan', 'other', '']); // NOT NULL; '' is the falsy case
    const bedrooms = pick([2, 2, 3, null]);
    const pool = poolFor(area, bedrooms);
    const sharedUrl = () => `https://cdn.test/${area || 'none'}-${bedrooms ?? 2}/${Math.floor(rnd() * 4)}.jpg`;
    const images = [];
    for (let k = Math.floor(rnd() * 6); k > 0; k--) {
      const roll = rnd();
      if (roll < 0.45) images.push({ src_url: `https://cdn.test/p/${n}-${k}.jpg`, hash: flip(pick(pool), Math.floor(rnd() * 9)) });
      else if (roll < 0.6) images.push({ src_url: sharedUrl(), hash: null });
      else if (roll < 0.7) images.push(sharedUrl()); // legacy: a bare url
      else if (roll < 0.8) images.push({ src_url: null, hash: 'not-a-hash' });
      else if (roll < 0.9) images.push({ src_url: 'https://cdn.test/logo.png', hash: logo });
      else images.push({ src_url: null, hash: hex16() });
    }
    insert.run({
      key: `${source}:${ref}:${n}`,
      ref,
      source,
      url: `https://${source}.test/${n}`,
      title: pick(titles),
      description: pick(descs),
      area,
      bedrooms,
      price_month_idr: pick([null, 0, 40_000_000, 41_000_000, 42_500_000, 60_000_000]),
      availability: rnd() < 0.05 ? 'gone' : 'available',
      first_seen: `2026-09-${String(1 + Math.floor(rnd() * 20)).padStart(2, '0')}T00:00:00.000Z`,
      last_seen: '2026-09-27T00:00:00.000Z',
      images: rnd() < 0.08 ? null : rnd() < 0.03 ? '{broken json' : JSON.stringify(images),
    });
  }
}

const SEEDS = [1, 2, 3, 4, 5];
const reached = new Set();

for (const seed of SEEDS) {
  test(`findDuplicates matches the per-pair helpers exactly (seed ${seed})`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-dedupe-fast-'));
    const db = openDb(path.join(dir, 'villa.db'));
    t.after(() => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    seedRows(db, seed);

    const expected = referenceFindDuplicates(db);
    assert.ok(expected.length > 0);
    assert.deepEqual(findDuplicates(db), expected);
    for (const p of expected) {
      reached.add(p.reason.replace(/^\d+ /, 'N ').replace(/ [\d.]+$/, ' S').replace(/https?:\S+/, 'URL'));
    }
  });
}

// The seeds have to reach every reason between them, or the comparison proves less than it says.
test('the seeded tables reach every reason findDuplicates can give', () => {
  for (const kind of [
    'N shared photos (hash)', 'N shared photos (url)', 'N shared photos (url+hash)', 'title similarity S',
    'same first 60 chars of description', 'shared image URL', 'shared image (hash)',
  ]) {
    assert.ok(reached.has(kind), `no seed produced "${kind}" (got: ${[...reached].join(' | ')})`);
  }
});
