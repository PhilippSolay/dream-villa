// Perceptual image identity for dedupe (SPEC §6, amended 2026-09-20): the same villa's
// photos get re-uploaded by every agency and every Facebook poster, so `src_url` equality
// almost never fires across sources. A 64-bit difference hash (dHash) of the stored file
// survives resizing, re-encoding and mild colour shifts; two hashes within a few bits are
// the same photograph.
//
// Image entries in `properties.images` carry it as `hash` (16 hex chars), set by
// images.js when a file is written and back-filled by `npm run images:hash`.

import sharp from 'sharp';

/** Hamming distance at or under this = same photo. 64-bit dHash; unrelated photos sit ~32 apart. */
export const MATCH_DISTANCE = 6;

/** 64-bit dHash of an image (Buffer or file path), as 16 lowercase hex chars. */
export async function dhash(input) {
  const px = await sharp(input).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let hex = '';
  for (let r = 0; r < 8; r++) {
    let byte = 0;
    for (let c = 0; c < 8; c++) {
      byte = (byte << 1) | (px[r * 9 + c] > px[r * 9 + c + 1] ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Bits that differ between two 16-hex hashes; Infinity when either is missing or malformed. */
export function hamming(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== 16 || b.length !== 16) return Infinity;
  let d = 0;
  for (let i = 0; i < 16; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    if (Number.isNaN(x)) return Infinity;
    d += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return d;
}

/** True when two hashes are the same photograph. */
export function sameImage(a, b) {
  return hamming(a, b) <= MATCH_DISTANCE;
}

/** A 16-hex hash as two 32-bit words, or null where hamming() would say Infinity. */
export function hashWords(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{16}$/i.test(hex)) return null;
  return [parseInt(hex.slice(0, 8), 16), parseInt(hex.slice(8), 16)];
}

function popcount32(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

/** hamming() on two hashWords() — the same count, without parsing 32 hex digits each time. */
export function hammingWords(a, b) {
  return popcount32(a[0] ^ b[0]) + popcount32(a[1] ^ b[1]);
}

/**
 * A listing's photos parsed once for countSharedImages. The pairwise duplicate scorer
 * compares every photo of one listing with every photo of another, over hundreds of
 * thousands of pairs; parsing each hash per comparison is what made it take minutes.
 * `ignore` leaves out what sharedImages' own `ignore` would: a photo that can never
 * match counts the same whether it sits in the list or not.
 */
export function imageKeys(images, { ignore = null } = {}) {
  return entries(images)
    .filter((im) => !isIgnored(im, ignore))
    .map((im) => ({ src_url: im.src_url, words: hashWords(im.hash) }));
}

function isIgnored(im, ignore) {
  return Boolean(ignore && ((im.hash && ignore.has(im.hash)) || (im.src_url && ignore.has(im.src_url))));
}

/** sharedImages(a, b).count on two imageKeys() — the same greedy match, photo by photo. */
export function countSharedImages(keysA, keysB) {
  const usedB = new Uint8Array(keysB.length);
  let count = 0;
  for (let i = 0; i < keysA.length; i++) {
    const x = keysA[i];
    for (let j = 0; j < keysB.length; j++) {
      if (usedB[j]) continue;
      const y = keysB[j];
      const same =
        (x.src_url && x.src_url === y.src_url) ||
        (x.words && y.words && hammingWords(x.words, y.words) <= MATCH_DISTANCE);
      if (!same) continue;
      usedB[j] = 1;
      count++;
      break;
    }
  }
  return count;
}

function entries(images) {
  let list = images;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((im) => (im && typeof im === 'object' ? { src_url: im.src_url || null, hash: im.hash || null } : { src_url: im || null, hash: null }))
    .filter((im) => im.src_url || im.hash);
}

/**
 * Photos two listings have in common: identical `src_url` (same CDN file) or hashes within
 * MATCH_DISTANCE. Each photo of `a` matches at most one photo of `b`.
 * @param {Array|string|null} imagesA `properties.images` (JSON string or parsed)
 * @param {Array|string|null} imagesB
 * @param {{ignore?: Set<string>}} [opts] hashes/urls to leave out — an agent's logo or
 *   collage that sits on every one of its listings says nothing about the villa
 * @returns {{count:number, pairs:{a:number, b:number, how:'url'|'hash'}[]}} indexes into each array
 */
export function sharedImages(imagesA, imagesB, { ignore = null } = {}) {
  const skip = (im) => isIgnored(im, ignore);
  const ea = entries(imagesA).map((im) => (skip(im) ? { src_url: null, hash: null } : im));
  const eb = entries(imagesB).map((im) => (skip(im) ? { src_url: null, hash: null } : im));
  const usedB = new Set();
  const pairs = [];
  for (let i = 0; i < ea.length; i++) {
    for (let j = 0; j < eb.length; j++) {
      if (usedB.has(j)) continue;
      const how = ea[i].src_url && ea[i].src_url === eb[j].src_url ? 'url' : sameImage(ea[i].hash, eb[j].hash) ? 'hash' : null;
      if (!how) continue;
      pairs.push({ a: i, b: j, how });
      usedB.add(j);
      break;
    }
  }
  return { count: pairs.length, pairs };
}

export default { dhash, hamming, sameImage, sharedImages, hashWords, hammingWords, imageKeys, countSharedImages, MATCH_DISTANCE };
