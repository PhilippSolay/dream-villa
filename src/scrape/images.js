// SPEC §6 "Images" — download every gallery image (max maxPerListing/listing), resize with
// sharp, write to <imagesDir>/<id>/<n>.jpg, persist images JSON + hero_file. Pure I/O + one
// small DB write per listing; scoring/pins/dedupe live elsewhere.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const MAX_SIDE = 1600;
const JPEG_QUALITY = 82;

function safeParseImages(raw) {
  if (Array.isArray(raw)) return raw.map((e) => ({ ...e }));
  if (raw === null || raw === undefined) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((e) => ({ ...e })) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Absolute path image n (1-based, position in the images array) is written to for property id. */
export function imageFilePath(imagesDir, id, n) {
  return path.join(imagesDir, String(id), `${n}.jpg`);
}

/** Pure: resize a buffer to max side 1600px (fit inside, no enlargement), JPEG q82. */
export async function resizeToJpeg(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, w: info.width, h: info.height };
}

/** Listings (optionally restricted to `ids`) whose images array has an entry without a `file`
 *  that isn't flagged `dead` (images-audit.js repairImages gave up on that one for good). */
function selectCandidates(db, ids) {
  let rows;
  if (ids && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    rows = db
      .prepare(`SELECT id, images, hero_file, availability FROM properties WHERE id IN (${placeholders})`)
      .all(...ids);
  } else {
    rows = db.prepare('SELECT id, images, hero_file, availability FROM properties').all();
  }

  const out = [];
  for (const row of rows) {
    if (row.availability === 'gone') continue;
    const images = safeParseImages(row.images);
    if (images.some((img) => !img.file && !img.dead)) out.push({ id: row.id, images, hero_file: row.hero_file });
  }
  return out;
}

/**
 * Download + resize missing gallery images and persist images/hero_file.
 * @returns {{listings:number, downloaded:number, skipped:number, failed:number}}
 */
export async function processImages(
  db,
  ctx,
  {
    ids = null,
    limit = null,
    maxPerListing = 20,
    imagesDir = process.env.IMAGES_DIR || 'data/images',
    log = ctx.log,
  } = {}
) {
  let candidates = selectCandidates(db, ids);
  if (limit != null) candidates = candidates.slice(0, limit);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  const update = db.prepare('UPDATE properties SET images = ?, hero_file = ? WHERE id = ?');

  for (const { id, images, hero_file } of candidates) {
    let changed = false;
    let processed = 0;

    for (let i = 0; i < images.length; i++) {
      if (processed >= maxPerListing) break;
      const entry = images[i];
      if (entry.file || entry.dead) continue; // dead: images-audit.js gave up on this one — never retried here
      processed++;

      const n = i + 1;
      const filePath = imageFilePath(imagesDir, id, n);

      // Already on disk from a prior interrupted run — reuse it, don't re-fetch.
      if (fs.existsSync(filePath)) {
        try {
          const meta = await sharp(filePath).metadata();
          images[i] = { src_url: entry.src_url, file: `${id}/${n}.jpg`, w: meta.width, h: meta.height };
          changed = true;
          skipped++;
        } catch (err) {
          failed++;
          log?.warn?.(`[images] existing file unreadable ${filePath}: ${err.message}`);
        }
        continue;
      }

      try {
        const { buffer, status, contentType } = await ctx.fetchBuffer(entry.src_url);
        if (status !== 200) throw new Error(`status ${status}`);
        if (!contentType || !contentType.startsWith('image/')) throw new Error(`bad content-type ${contentType}`);
        const { buffer: out, w, h } = await resizeToJpeg(buffer);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, out);
        images[i] = { src_url: entry.src_url, file: `${id}/${n}.jpg`, w, h };
        changed = true;
        downloaded++;
      } catch (err) {
        failed++;
        log?.warn?.(`[images] failed ${entry.src_url}: ${err.message}`);
      }
    }

    if (changed) {
      const heroFile = hero_file || images[0]?.file || null;
      update.run(JSON.stringify(images), heroFile, id);
    }
  }

  return { listings: candidates.length, downloaded, skipped, failed };
}

export default { processImages, imageFilePath, resizeToJpeg };
