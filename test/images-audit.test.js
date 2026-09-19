// SPEC §6 "Images" — audit + repair (Philipp: "check all current items for image
// availability, some have only one or broken links"). Mirrors test/images.test.js's
// fixtures (tmpDb/baseRow/stubCtx/makePng) so the two suites read the same way.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { openDb } from '../src/db.js';
import { upsertProperty } from '../src/scrape/store.js';
import { processImages, imageFilePath } from '../src/scrape/images.js';
import { auditImages, repairImages } from '../src/scrape/images-audit.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-images-audit-'));
  const file = path.join(dir, 'villa.db');
  const db = openDb(file);
  return { db, dir, imagesDir: path.join(dir, 'images') };
}

function cleanup({ db, dir }) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

function baseRow(overrides = {}) {
  return {
    key: 'bhi:RF1', ref: 'RF1', source: 'bhi', url: 'https://bali-home-immo.com/x-rf1',
    title: 'Modern 2 Bedroom Villa', area: 'cemagi', bedrooms: 2,
    price_month_idr: 40_000_000, availability: 'available',
    first_seen: '2026-09-17T00:00:00.000Z',
    ...overrides,
  };
}

async function makePng(width, height) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .png()
    .toBuffer();
}

function stubCtx(responses) {
  const calls = [];
  return {
    log: { warn: () => {}, info: () => {} },
    calls,
    fetchBuffer: async (url) => {
      calls.push(url);
      const entry = responses[url];
      if (!entry) throw new Error(`unexpected url ${url}`);
      return entry;
    },
  };
}

/** Writes a real file to <imagesDir>/<id>/<n>.jpg, as processImages would. */
function writeOnDisk(imagesDir, id, n, buffer) {
  const filePath = imageFilePath(imagesDir, id, n);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return `${id}/${n}.jpg`;
}

// ---------------------------------------------------------------------------
// auditImages
// ---------------------------------------------------------------------------

test('auditImages: one file on disk, one missing → local_ok 1, local_missing 1, gallery1', async () => {
  const ctx0 = tmpDb();
  const { db, imagesDir } = ctx0;
  const png = await makePng(200, 200);

  const { id } = upsertProperty(db, baseRow());
  writeOnDisk(imagesDir, id, 1, png);
  db.prepare('UPDATE properties SET images = ?, hero_file = ? WHERE id = ?').run(
    JSON.stringify([
      { src_url: 'https://x/1.jpg', file: `${id}/1.jpg`, w: 200, h: 200 },
      { src_url: 'https://x/2.jpg', file: `${id}/2.jpg`, w: 200, h: 200 }, // never written to disk
    ]),
    `${id}/1.jpg`,
    id
  );

  const report = auditImages(db, { imagesDir });
  assert.equal(report.totals.listings, 1);
  assert.equal(report.totals.entries, 2);
  assert.equal(report.totals.local_ok, 1);
  assert.equal(report.totals.local_missing, 1);
  assert.equal(report.totals.remote_only, 0);
  assert.equal(report.totals.dead, 0);
  assert.equal(report.totals.gallery1, 1);
  assert.equal(report.totals.gallery0, 0);
  assert.ok(report.problem_ids.includes(id));

  const bhi = report.by_source.find((s) => s.source === 'bhi');
  assert.equal(bhi.listings, 1);
  assert.equal(bhi.local_ok, 1);
  assert.equal(bhi.local_missing, 1);

  cleanup(ctx0);
});

test('auditImages: remote-only and dead entries counted separately; gallery0 when nothing usable', async () => {
  const ctx0 = tmpDb();
  const { db, imagesDir } = ctx0;

  upsertProperty(db, baseRow({
    images: [
      { src_url: 'https://x/gone.jpg', dead: true },
      { src_url: 'https://x/not-yet-downloaded.jpg' },
    ],
  }));

  const report = auditImages(db, { imagesDir });
  assert.equal(report.totals.dead, 1);
  assert.equal(report.totals.remote_only, 1);
  assert.equal(report.totals.gallery0, 1);
  assert.equal(report.totals.hero_missing, 1);

  cleanup(ctx0);
});

test('auditImages: two usable photos → gallery2plus, not a problem listing', async () => {
  const ctx0 = tmpDb();
  const { db, imagesDir } = ctx0;
  const png = await makePng(100, 100);

  const { id } = upsertProperty(db, baseRow({ key: 'bhi:RF2', ref: 'RF2' }));
  writeOnDisk(imagesDir, id, 1, png);
  writeOnDisk(imagesDir, id, 2, png);
  db.prepare('UPDATE properties SET images = ?, hero_file = ? WHERE id = ?').run(
    JSON.stringify([
      { src_url: 'https://x/1.jpg', file: `${id}/1.jpg`, w: 100, h: 100 },
      { src_url: 'https://x/2.jpg', file: `${id}/2.jpg`, w: 100, h: 100 },
    ]),
    `${id}/1.jpg`,
    id
  );

  const report = auditImages(db, { imagesDir });
  assert.equal(report.totals.gallery2plus, 1);
  assert.equal(report.totals.hero_missing, 0);
  assert.ok(!report.problem_ids.includes(id));

  cleanup(ctx0);
});

test('auditImages: a row merged into another (raw.merged_into) is excluded entirely', async () => {
  const ctx0 = tmpDb();
  const { db, imagesDir } = ctx0;

  upsertProperty(db, baseRow({
    key: 'bhi:RF3', ref: 'RF3',
    images: [{ src_url: 'https://x/1.jpg' }],
    raw: JSON.stringify({ merged_into: 999, merged_reason: 'test' }),
  }));

  const report = auditImages(db, { imagesDir });
  assert.equal(report.totals.listings, 0);
  assert.equal(report.by_source.length, 0);

  cleanup(ctx0);
});

// ---------------------------------------------------------------------------
// repairImages
// ---------------------------------------------------------------------------

test('repairImages: downloads a missing entry, marks a 404 dead, and recomputes hero_file', async () => {
  const ctx0 = tmpDb();
  const { db, imagesDir } = ctx0;
  const png = await makePng(2000, 1000);

  const { id } = upsertProperty(db, baseRow({
    images: [
      { src_url: 'https://x/ok.jpg' }, // never downloaded — repaired below
      { src_url: 'https://x/gone.jpg' }, // will 404 — repaired into dead:true
    ],
    hero_file: null,
  }));

  const ctx = stubCtx({
    'https://x/ok.jpg': { buffer: png, status: 200, contentType: 'image/jpeg' },
    'https://x/gone.jpg': { buffer: Buffer.alloc(0), status: 404, contentType: 'text/html' },
  });

  const result = await repairImages(db, ctx, { imagesDir });
  assert.equal(result.downloaded, 1);
  assert.equal(result.dropped, 1);
  assert.equal(result.hero_fixed, 1);
  assert.equal(result.still_missing, 0);

  const row = db.prepare('SELECT images, hero_file FROM properties WHERE id = ?').get(id);
  const images = JSON.parse(row.images);
  assert.equal(images[0].file, `${id}/1.jpg`);
  assert.ok(fs.existsSync(imageFilePath(imagesDir, id, 1)));
  assert.equal(images[1].dead, true);
  assert.equal(images[1].src_url, 'https://x/gone.jpg', 'src_url kept for reference');
  assert.equal(images[1].file, undefined, 'the dead entry is never given a file');
  assert.equal(row.hero_file, `${id}/1.jpg`);

  // A second pass touches nothing new: the dead entry is never retried, the good one
  // is already on disk.
  const before = ctx.calls.length;
  const result2 = await repairImages(db, ctx, { imagesDir });
  assert.equal(result2.downloaded, 0);
  assert.equal(result2.dropped, 0);
  assert.equal(ctx.calls.length, before, 'dead entry never refetched');

  cleanup(ctx0);
});

test('repairImages: an entry with no src_url (a person upload) is left as still_missing, never marked dead', async () => {
  const ctx0 = tmpDb();
  const { db, imagesDir } = ctx0;

  upsertProperty(db, baseRow({
    images: [{ src_url: null, file: '1/u1.jpg', by: 1 }], // the file went missing from disk
  }));

  const ctx = stubCtx({});
  const result = await repairImages(db, ctx, { imagesDir });
  assert.equal(result.still_missing, 1);
  assert.equal(result.downloaded, 0);
  assert.equal(result.dropped, 0);
  assert.equal(ctx.calls.length, 0, 'nothing to fetch — never even tried');

  cleanup(ctx0);
});

test('repairImages: a non-image 200 response (e.g. an HTML error page) is also marked dead', async () => {
  const ctx0 = tmpDb();
  const { db, imagesDir } = ctx0;

  const { id } = upsertProperty(db, baseRow({ images: [{ src_url: 'https://x/oops.jpg' }] }));
  const ctx = stubCtx({
    'https://x/oops.jpg': { buffer: Buffer.from('<html>not found</html>'), status: 200, contentType: 'text/html' },
  });

  const result = await repairImages(db, ctx, { imagesDir });
  assert.equal(result.dropped, 1);
  const row = db.prepare('SELECT images FROM properties WHERE id = ?').get(id);
  assert.equal(JSON.parse(row.images)[0].dead, true);

  cleanup(ctx0);
});

test('repairImages: respects limit (number of listings touched)', async () => {
  const ctx0 = tmpDb();
  const { db, imagesDir } = ctx0;
  const png = await makePng(100, 100);

  upsertProperty(db, baseRow({ key: 'bhi:A', ref: 'A', images: [{ src_url: 'https://x/a.jpg' }] }));
  upsertProperty(db, baseRow({ key: 'bhi:B', ref: 'B', images: [{ src_url: 'https://x/b.jpg' }] }));

  const ctx = stubCtx({
    'https://x/a.jpg': { buffer: png, status: 200, contentType: 'image/jpeg' },
    'https://x/b.jpg': { buffer: png, status: 200, contentType: 'image/jpeg' },
  });

  const result = await repairImages(db, ctx, { imagesDir, limit: 1 });
  assert.equal(result.downloaded, 1);

  cleanup(ctx0);
});

// ---------------------------------------------------------------------------
// processImages skips dead entries
// ---------------------------------------------------------------------------

test('processImages: never retries an entry flagged dead', async () => {
  const ctx0 = tmpDb();
  const { db, imagesDir } = ctx0;

  const { id } = upsertProperty(db, baseRow({
    images: [
      { src_url: 'https://x/gone.jpg', dead: true },
      { src_url: 'https://x/new.jpg' }, // still a normal candidate
    ],
  }));

  const png = await makePng(100, 100);
  const ctx = stubCtx({
    'https://x/new.jpg': { buffer: png, status: 200, contentType: 'image/jpeg' },
  });

  const result = await processImages(db, ctx, { imagesDir });
  assert.equal(result.downloaded, 1);
  assert.deepEqual(ctx.calls, ['https://x/new.jpg'], 'the dead entry is never fetched');

  const row = db.prepare('SELECT images FROM properties WHERE id = ?').get(id);
  const images = JSON.parse(row.images);
  assert.equal(images[0].dead, true, 'dead entry untouched');
  assert.equal(images[1].file, `${id}/2.jpg`);

  cleanup(ctx0);
});

test('processImages: a listing whose only broken entry is dead is not a candidate at all', async () => {
  const ctx0 = tmpDb();
  const { db, imagesDir } = ctx0;

  upsertProperty(db, baseRow({ images: [{ src_url: 'https://x/gone.jpg', dead: true }] }));

  const ctx = stubCtx({});
  const result = await processImages(db, ctx, { imagesDir });
  assert.equal(result.listings, 0, 'nothing left to do for this listing');

  cleanup(ctx0);
});
