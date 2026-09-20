import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { dhash, hamming, sameImage, sharedImages, MATCH_DISTANCE } from '../src/scrape/image-hash.js';

async function gradient(width, height, { flip = false, noise = 0 } = {}) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round((flip ? width - 1 - x : x) / (width - 1) * 200 + (y % 7) * 5 + ((x * 31 + y * 17) % noise || 0));
      const i = (y * width + x) * 3;
      raw[i] = v; raw[i + 1] = 255 - v; raw[i + 2] = (x * y) % 255;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
}

test('dhash — 16 hex chars, stable across resize and re-encode', async () => {
  const big = await gradient(640, 480);
  const small = await sharp(big).resize(320).jpeg({ quality: 60 }).toBuffer();
  const a = await dhash(big);
  const b = await dhash(small);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(hamming(a, b) <= MATCH_DISTANCE, `resized copy differs by ${hamming(a, b)} bits`);
  assert.equal(sameImage(a, b), true);
});

test('dhash — a different picture is far away', async () => {
  const a = await dhash(await gradient(640, 480));
  const b = await dhash(await gradient(640, 480, { flip: true }));
  assert.ok(hamming(a, b) > MATCH_DISTANCE, `flipped picture only ${hamming(a, b)} bits apart`);
  assert.equal(sameImage(a, b), false);
});

test('hamming — exact bits, malformed input never matches', () => {
  assert.equal(hamming('0000000000000000', '0000000000000000'), 0);
  assert.equal(hamming('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(hamming('0000000000000000', '0000000000000001'), 1);
  assert.equal(hamming(null, '0000000000000000'), Infinity);
  assert.equal(hamming('short', '0000000000000000'), Infinity);
  assert.equal(sameImage(undefined, undefined), false);
});

test('sharedImages — url or hash, each photo matched once, JSON strings accepted', () => {
  const a = JSON.stringify([
    { src_url: 'https://cdn/a.jpg', hash: '00000000000000ff' },
    { src_url: 'https://cdn/b.jpg', hash: 'ffffffffffffffff' },
    { src_url: 'https://cdn/c.jpg' },
  ]);
  const b = [
    { src_url: 'https://other/1.jpg', hash: '00000000000000fe' }, // 1 bit from a[0]
    { src_url: 'https://other/2.jpg', hash: '00000000000000fd' }, // also close to a[0], but a[0] is taken
    { src_url: 'https://cdn/c.jpg' },                                // same CDN file as a[2]
  ];
  const got = sharedImages(a, b);
  assert.equal(got.count, 2);
  assert.deepEqual(got.pairs, [{ a: 0, b: 0, how: 'hash' }, { a: 2, b: 2, how: 'url' }]);
  assert.equal(sharedImages(null, b).count, 0);
  assert.equal(sharedImages('not json', b).count, 0);
});
