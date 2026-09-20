import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { openDb } from '../src/db.js';
import { hashImages } from '../src/scrape/images-hash.js';

const HEX16 = /^[0-9a-f]{16}$/;

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-images-hash-'));
  const db = openDb(path.join(dir, 'villa.db'));
  return { db, dir, imagesDir: path.join(dir, 'images') };
}

function cleanup({ db, dir }) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

const quietLog = { warn: () => {}, info: () => {} };

/** Insert a property straight into the table — this pass only reads id + images. */
function insert(db, images, overrides = {}) {
  const row = {
    key: 'bhi:RF1',
    ref: 'RF1',
    source: 'bhi',
    url: 'https://bali-home-immo.com/a-rf1',
    title: 'Modern 2 Bedroom Villa in Cemagi',
    area: 'cemagi',
    bedrooms: 2,
    price_month_idr: 40_000_000,
    availability: 'available',
    first_seen: '2026-09-01T00:00:00.000Z',
    last_seen: '2026-09-01T00:00:00.000Z',
    images: JSON.stringify(images),
    ...overrides,
  };
  const cols = Object.keys(row);
  const info = db
    .prepare(`INSERT INTO properties (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c]));
  return Number(info.lastInsertRowid);
}

/** Write a real jpeg at <imagesDir>/<rel>, with a distinct pattern per `seed`. */
async function writeJpeg(imagesDir, rel, seed = 0) {
  const full = path.join(imagesDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const buf = await sharp({
    create: { width: 240, height: 180, channels: 3, background: { r: (seed * 37) % 256, g: 120, b: 200 } },
  })
    .composite([
      {
        input: await sharp({ create: { width: 60, height: 60, channels: 3, background: { r: 250, g: 250, b: 250 } } })
          .png()
          .toBuffer(),
        left: (seed * 23) % 150,
        top: (seed * 17) % 110,
      },
    ])
    .jpeg({ quality: 82 })
    .toBuffer();
  fs.writeFileSync(full, buf);
  return full;
}

const imagesOf = (db, id) => JSON.parse(db.prepare('SELECT images FROM properties WHERE id = ?').get(id).images);

// ---------------------------------------------------------------------------

test('hashImages: back-fills a 16-hex hash on entries with files, leaves file-less entries alone', async () => {
  const ctx = tmpDb();
  const { db, imagesDir } = ctx;

  const id = insert(db, [
    { src_url: 'https://x/1.jpg', file: '7/1.jpg', w: 240, h: 180 },
    { src_url: 'https://x/2.jpg' },
    { src_url: 'https://x/3.jpg', dead: true },
  ]);
  await writeJpeg(imagesDir, '7/1.jpg', 1);

  const result = await hashImages(db, { imagesDir, log: quietLog });
  assert.deepEqual(result, { properties: 1, hashed: 1, missing_file: 0, failed: 0 });

  const images = imagesOf(db, id);
  assert.match(images[0].hash, HEX16);
  assert.equal(images[0].src_url, 'https://x/1.jpg', 'other fields preserved');
  assert.equal(images[0].w, 240);
  assert.equal(images[1].hash, undefined, 'remote-only entry untouched');
  assert.equal(images[2].hash, undefined, 'dead entry untouched');
  assert.equal(images[2].dead, true);

  cleanup(ctx);
});

test('hashImages: skips rows that are already hashed', async () => {
  const ctx = tmpDb();
  const { db, imagesDir } = ctx;

  const id = insert(db, [{ src_url: 'https://x/1.jpg', file: '8/1.jpg', w: 240, h: 180, hash: '0123456789abcdef' }]);
  await writeJpeg(imagesDir, '8/1.jpg', 2);

  const result = await hashImages(db, { imagesDir, log: quietLog });
  assert.deepEqual(result, { properties: 0, hashed: 0, missing_file: 0, failed: 0 });
  assert.equal(imagesOf(db, id)[0].hash, '0123456789abcdef', 'existing hash never recomputed');

  cleanup(ctx);
});

test('hashImages: counts missing files and leaves those entries without a hash', async () => {
  const ctx = tmpDb();
  const { db, imagesDir } = ctx;

  const id = insert(db, [
    { src_url: 'https://x/1.jpg', file: '9/1.jpg', w: 240, h: 180 },
    { src_url: 'https://x/2.jpg', file: '9/2.jpg', w: 240, h: 180 },
  ]);
  await writeJpeg(imagesDir, '9/1.jpg', 3); // 9/2.jpg deliberately never written

  const result = await hashImages(db, { imagesDir, log: quietLog });
  assert.deepEqual(result, { properties: 1, hashed: 1, missing_file: 1, failed: 0 });

  const images = imagesOf(db, id);
  assert.match(images[0].hash, HEX16);
  assert.equal(images[1].hash, undefined);
  assert.equal(images[1].file, '9/2.jpg', 'missing file is not cleared or marked');

  cleanup(ctx);
});

test('hashImages: honours ids and limit', async () => {
  const ctx = tmpDb();
  const { db, imagesDir } = ctx;

  const a = insert(db, [{ src_url: 'https://x/a.jpg', file: 'a/1.jpg' }], { key: 'bhi:A', ref: 'A' });
  const b = insert(db, [{ src_url: 'https://x/b.jpg', file: 'b/1.jpg' }], { key: 'bhi:B', ref: 'B' });
  const c = insert(db, [{ src_url: 'https://x/c.jpg', file: 'c/1.jpg' }], { key: 'bhi:C', ref: 'C' });
  await writeJpeg(imagesDir, 'a/1.jpg', 4);
  await writeJpeg(imagesDir, 'b/1.jpg', 5);
  await writeJpeg(imagesDir, 'c/1.jpg', 6);

  const byIds = await hashImages(db, { imagesDir, ids: [b], log: quietLog });
  assert.deepEqual(byIds, { properties: 1, hashed: 1, missing_file: 0, failed: 0 });
  assert.match(imagesOf(db, b)[0].hash, HEX16);
  assert.equal(imagesOf(db, a)[0].hash, undefined);
  assert.equal(imagesOf(db, c)[0].hash, undefined);

  const limited = await hashImages(db, { imagesDir, limit: 1, log: quietLog });
  assert.deepEqual(limited, { properties: 1, hashed: 1, missing_file: 0, failed: 0 });

  const remaining = [a, c].filter((id) => !imagesOf(db, id)[0].hash);
  assert.equal(remaining.length, 1, 'limit stopped after one property');

  const rest = await hashImages(db, { imagesDir, log: quietLog });
  assert.deepEqual(rest, { properties: 1, hashed: 1, missing_file: 0, failed: 0 });
  assert.match(imagesOf(db, a)[0].hash, HEX16);
  assert.match(imagesOf(db, c)[0].hash, HEX16);

  cleanup(ctx);
});

test('hashImages: different photos get different hashes, one UPDATE covers a whole gallery', async () => {
  const ctx = tmpDb();
  const { db, imagesDir } = ctx;

  const id = insert(db, [
    { src_url: 'https://x/1.jpg', file: '11/1.jpg' },
    { src_url: 'https://x/2.jpg', file: '11/2.jpg' },
  ]);
  await writeJpeg(imagesDir, '11/1.jpg', 1);
  await writeJpeg(imagesDir, '11/2.jpg', 7);

  const result = await hashImages(db, { imagesDir, log: quietLog });
  assert.deepEqual(result, { properties: 1, hashed: 2, missing_file: 0, failed: 0 });

  const images = imagesOf(db, id);
  assert.match(images[0].hash, HEX16);
  assert.match(images[1].hash, HEX16);
  assert.notEqual(images[0].hash, images[1].hash);

  cleanup(ctx);
});
