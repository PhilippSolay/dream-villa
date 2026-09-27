// Card-sized photo cuts: src/thumbs.js and the /thumbs route in src/server.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { openDb } from '../src/db.js';
import { buildServer } from '../src/server.js';
import { ensureThumb, THUMB_WIDTH } from '../src/thumbs.js';
import { thumbUrl, photoFallback } from '../public/lib/ui.js';

const ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
  AGENT_TOKEN: 'test-agent-token-0123456789abcdef',
};

function photo(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 150, b: 90 } } }).jpeg().toBuffer();
}

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-thumbs-'));
  const imagesDir = path.join(dir, 'images');
  const thumbsDir = path.join(dir, 'thumbs');
  fs.mkdirSync(path.join(imagesDir, '7'), { recursive: true });
  fs.writeFileSync(path.join(imagesDir, '7', '1.jpg'), await photo(1600, 1200));
  fs.writeFileSync(path.join(imagesDir, '7', '2.jpg'), await photo(400, 300));
  fs.writeFileSync(path.join(imagesDir, '7', 'v3-1.jpg'), await photo(1600, 1200));
  const db = openDb(path.join(dir, 'villa.db'));
  const app = await buildServer({ db, env: { ...ENV, IMAGES_DIR: imagesDir } });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { app, imagesDir, thumbsDir };
}

test('thumbUrl: a downloaded listing photo maps to its cut; anything else is left alone', () => {
  assert.equal(thumbUrl('/images/12/1.jpg'), '/thumbs/12/1.webp');
  assert.equal(thumbUrl('/images/12/v3-1.jpg'), '/images/12/v3-1.jpg');
  assert.equal(thumbUrl('https://cdn.test/a.jpg'), 'https://cdn.test/a.jpg');
  assert.equal(thumbUrl(null), null);
});

test('photoFallback: a broken cut falls back to its original; nothing else has a fallback', () => {
  assert.equal(photoFallback('/thumbs/12/1.webp'), '/images/12/1.jpg');
  assert.equal(photoFallback('https://villa.solay.cloud/thumbs/12/3.webp'), '/images/12/3.jpg');
  assert.equal(photoFallback('/images/12/1.jpg'), null, 'the original is the last stop');
  assert.equal(photoFallback('https://cdn.test/thumbs/a.webp'), null);
  assert.equal(photoFallback(''), null);
  assert.equal(photoFallback(null), null);
});

test('GET /thumbs: a 720 px WebP, public and cached, cut once and then read from disk', async (t) => {
  const { app, thumbsDir } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/thumbs/7/1.webp' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.match(res.headers['cache-control'], /public, max-age=2592000/);
  assert.equal(Number(res.headers['content-length']), res.rawPayload.length, 'a cut-short transfer is detectable');
  const meta = await sharp(res.rawPayload).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, THUMB_WIDTH);
  assert.equal(meta.height, 540);

  const onDisk = path.join(thumbsDir, '7', '1.webp');
  const before = fs.statSync(onDisk).mtimeMs;
  assert.equal((await app.inject({ method: 'GET', url: '/thumbs/7/1.webp' })).statusCode, 200);
  assert.equal(fs.statSync(onDisk).mtimeMs, before, 'the second ask reads the cut, it does not recut');
});

test('GET /thumbs: a small photo is never enlarged', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/thumbs/7/2.webp' });
  assert.equal(res.statusCode, 200);
  assert.equal((await sharp(res.rawPayload).metadata()).width, 400);
});

test('GET /thumbs: viewing photos, missing photos and odd names are 404', async (t) => {
  const { app } = await setup(t);
  for (const url of ['/thumbs/7/v3-1.webp', '/thumbs/7/9.webp', '/thumbs/8/1.webp', '/thumbs/x/1.webp', '/thumbs/7/1.jpg']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404, url);
  }
});

test('ensureThumb: a replaced photo is cut again; parallel asks share one cut', async (t) => {
  const { imagesDir, thumbsDir } = await setup(t);
  const [a, b] = await Promise.all([
    ensureThumb(imagesDir, thumbsDir, 7, 1),
    ensureThumb(imagesDir, thumbsDir, 7, 1),
  ]);
  assert.equal(a, b);
  assert.equal((await sharp(a).metadata()).width, THUMB_WIDTH);

  const src = path.join(imagesDir, '7', '1.jpg');
  fs.writeFileSync(src, await photo(500, 500));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(src, later, later);
  const recut = fs.readFileSync(await ensureThumb(imagesDir, thumbsDir, 7, 1)); // a buffer: sharp caches by path
  assert.equal((await sharp(recut).metadata()).width, 500);
});
