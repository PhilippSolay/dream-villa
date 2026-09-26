// Card-sized cuts of the downloaded listing photos (served at /thumbs/<id>/<n>.webp).
//
// A card, a map pin and a duplicate row show a photo a few hundred CSS pixels wide, yet
// every one of them used to load the gallery's original — 1100–1600 px, ~130 KB. A
// 720 px WebP is a third of that and still sharp on a 3× phone at card width. Cut on the
// first ask, not at scrape time, so the 60 000 photos already on disk need no backfill;
// sharp works on libuv's thread pool, so a cut never holds up another request.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const THUMB_WIDTH = 720;
export const THUMB_QUALITY = 72;

const inflight = new Map(); // dest path → promise, so ten cards asking at once cut once

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The thumb for listing photo `<id>/<n>.jpg`, cut if missing or older than its source.
 * Numeric id and n only — a viewing photo (`v3-1.jpg`) is the team's, never cut here.
 * @returns {Promise<string|null>} the thumb's path, or null when there is no source photo
 */
export async function ensureThumb(imagesDir, thumbsDir, id, n) {
  if (!/^\d+$/.test(String(id)) || !/^\d+$/.test(String(n))) return null;
  const src = path.join(imagesDir, String(id), `${n}.jpg`);
  const dest = path.join(thumbsDir, String(id), `${n}.webp`);
  const srcTime = mtimeMs(src);
  if (srcTime == null) return null;
  const destTime = mtimeMs(dest);
  if (destTime != null && destTime >= srcTime) return dest;

  if (!inflight.has(dest)) {
    const job = (async () => {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
      try {
        // A buffer, not the path: sharp caches by filename, so a photo replaced under the
        // same name would otherwise be cut from the old picture.
        await sharp(await fs.promises.readFile(src))
          .rotate()
          .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
          .webp({ quality: THUMB_QUALITY })
          .toFile(tmp);
        await fs.promises.rename(tmp, dest);
      } catch (err) {
        await fs.promises.rm(tmp, { force: true });
        throw err;
      }
      return dest;
    })().finally(() => inflight.delete(dest));
    inflight.set(dest, job);
  }
  return inflight.get(dest);
}

export default { ensureThumb, THUMB_WIDTH, THUMB_QUALITY };
