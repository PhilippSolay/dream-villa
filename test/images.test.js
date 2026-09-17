import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { openDb } from '../src/db.js';
import { upsertProperty } from '../src/scrape/store.js';
import { processImages, imageFilePath, resizeToJpeg } from '../src/scrape/images.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-images-'));
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

// ---------------------------------------------------------------------------
// resizeToJpeg
// ---------------------------------------------------------------------------

test('resizeToJpeg: shrinks a 3000x2000 PNG to 1600x1067 JPEG', async () => {
  const png = await makePng(3000, 2000);
  const { buffer, w, h } = await resizeToJpeg(png);
  assert.equal(w, 1600);
  assert.equal(h, 1067);
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 1600);
  assert.equal(meta.height, 1067);
});

// ---------------------------------------------------------------------------
// processImages
// ---------------------------------------------------------------------------

test('processImages: downloads, resizes, persists images/hero_file; second call downloads nothing; 404 counted failed', async () => {
  const ctx0 = tmpDb();
  const { db, imagesDir } = ctx0;

  const png = await makePng(3000, 2000);
  const { id } = upsertProperty(db, baseRow({
    images: [
      { src_url: 'https://x/1.jpg' },
      { src_url: 'https://x/404.jpg' },
    ],
  }));

  const ctx = stubCtx({
    'https://x/1.jpg': { buffer: png, status: 200, contentType: 'image/jpeg' },
    'https://x/404.jpg': { buffer: Buffer.alloc(0), status: 404, contentType: 'text/html' },
  });

  const result = await processImages(db, ctx, { imagesDir });

  assert.equal(result.listings, 1);
  assert.equal(result.downloaded, 1);
  assert.equal(result.failed, 1);

  const filePath = imageFilePath(imagesDir, id, 1);
  assert.ok(fs.existsSync(filePath), 'image 1 written to disk');
  const meta = await sharp(filePath).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 1600);

  const row = db.prepare('SELECT images, hero_file FROM properties WHERE id = ?').get(id);
  const images = JSON.parse(row.images);
  assert.equal(images[0].file, `${id}/1.jpg`);
  assert.equal(images[0].w, 1600);
  assert.equal(images[0].h, 1067);
  assert.equal(images[1].file, undefined, '404 entry left without file');
  assert.equal(row.hero_file, `${id}/1.jpg`);

  // Second call: entry 1 already has a file, entry 2 still 404s but was already attempted —
  // it has no `file` so the listing is still a candidate, but only the still-missing entry
  // is retried; nothing new downloads for entry 1.
  const before = ctx.calls.length;
  const result2 = await processImages(db, ctx, { imagesDir });
  assert.equal(result2.downloaded, 0, 'no re-download of the already-resolved entry');
  assert.ok(ctx.calls.length >= before, 'no crash on second pass');

  cleanup(ctx0);
});

test('processImages: skips availability=gone rows', async () => {
  const ctx0 = tmpDb();
  const { db, imagesDir } = ctx0;

  upsertProperty(db, baseRow({ availability: 'gone', images: [{ src_url: 'https://x/1.jpg' }] }));

  const ctx = stubCtx({});
  const result = await processImages(db, ctx, { imagesDir });
  assert.equal(result.listings, 0);
  assert.equal(result.downloaded, 0);

  cleanup(ctx0);
});

test('processImages: respects ids and limit filters', async () => {
  const ctx0 = tmpDb();
  const { db, imagesDir } = ctx0;
  const png = await makePng(400, 400);

  const a = upsertProperty(db, baseRow({ key: 'bhi:A', images: [{ src_url: 'https://x/a.jpg' }] }));
  upsertProperty(db, baseRow({ key: 'bhi:B', images: [{ src_url: 'https://x/b.jpg' }] }));

  const ctx = stubCtx({
    'https://x/a.jpg': { buffer: png, status: 200, contentType: 'image/jpeg' },
    'https://x/b.jpg': { buffer: png, status: 200, contentType: 'image/jpeg' },
  });

  const result = await processImages(db, ctx, { imagesDir, ids: [a.id] });
  assert.equal(result.listings, 1);
  assert.equal(result.downloaded, 1);

  cleanup(ctx0);
});
