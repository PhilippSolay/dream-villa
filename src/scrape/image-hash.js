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
 * @returns {{count:number, pairs:{a:number, b:number, how:'url'|'hash'}[]}} indexes into each array
 */
export function sharedImages(imagesA, imagesB) {
  const ea = entries(imagesA);
  const eb = entries(imagesB);
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

export default { dhash, hamming, sameImage, sharedImages, MATCH_DISTANCE };
