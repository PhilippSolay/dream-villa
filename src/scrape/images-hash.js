// Back-fill perceptual hashes for gallery images that predate image-hash.js
// (SPEC §6 "Images", dedupe amendment 2026-09-20). images.js hashes every file it
// writes from now on; every row downloaded before that carries `{ src_url, file, w, h }`
// with no `hash`, so dedupe's image identity is blind to them until this pass runs:
//
//   npm run images:hash -- --limit=500
//
// Sequential on purpose — one sharp decode at a time, no parallel storm — and one
// UPDATE per property, not per image.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../db.js';
import { loadEnvFile } from '../index.js';
import { dhash } from './image-hash.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function safeParseImages(raw) {
  if (Array.isArray(raw)) return raw.map((e) => (e && typeof e === 'object' ? { ...e } : e));
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((e) => (e && typeof e === 'object' ? { ...e } : e)) : [];
  } catch {
    return [];
  }
}

/** An entry this pass has work for: a stored file, no hash yet. */
function needsHash(entry) {
  return !!(entry && typeof entry === 'object' && entry.file && !entry.hash);
}

/** Properties (optionally restricted to `ids`) with at least one un-hashed stored file. */
function selectCandidates(db, ids) {
  let rows;
  if (ids && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    rows = db.prepare(`SELECT id, images FROM properties WHERE id IN (${placeholders})`).all(...ids);
  } else {
    rows = db.prepare('SELECT id, images FROM properties').all();
  }

  const out = [];
  for (const row of rows) {
    const images = safeParseImages(row.images);
    if (images.some(needsHash)) out.push({ id: row.id, images });
  }
  return out;
}

/**
 * Compute and persist `hash` for every stored image file that hasn't got one.
 * Entries without a `file` (remote-only, `dead`) are left exactly as they are.
 * @param {import('better-sqlite3').Database} db
 * @param {{imagesDir?:string, ids?:number[]|null, limit?:number|null, log?:object}} [opts]
 * @returns {Promise<{properties:number, hashed:number, missing_file:number, failed:number}>}
 *   `properties` = candidate rows processed (after `ids`/`limit`).
 */
export async function hashImages(
  db,
  { imagesDir = process.env.IMAGES_DIR || 'data/images', ids = null, limit = null, log = console } = {}
) {
  let candidates = selectCandidates(db, ids);
  if (limit != null) candidates = candidates.slice(0, limit);

  let hashed = 0;
  let missingFile = 0;
  let failed = 0;
  const update = db.prepare('UPDATE properties SET images = ? WHERE id = ?');

  for (const { id, images } of candidates) {
    let changed = false;

    for (let i = 0; i < images.length; i++) {
      const entry = images[i];
      if (!needsHash(entry)) continue;

      const filePath = path.join(imagesDir, entry.file);
      if (!fs.existsSync(filePath)) {
        missingFile++;
        continue;
      }

      try {
        const hash = await dhash(filePath);
        images[i] = { ...entry, hash };
        changed = true;
        hashed++;
      } catch (err) {
        failed++;
        log?.warn?.(`[images-hash] failed ${filePath}: ${err.message}`);
      }
    }

    if (changed) update.run(JSON.stringify(images), id);
  }

  return { properties: candidates.length, hashed, missing_file: missingFile, failed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  loadEnvFile();

  const flags = argv.filter((a) => a.startsWith('--'));
  const valueOf = (name) => {
    const f = flags.find((x) => x.startsWith(`--${name}=`));
    return f ? f.split('=').slice(1).join('=') : null;
  };
  const imagesDir = process.env.IMAGES_DIR || 'data/images';
  const limit = valueOf('limit') ? Number(valueOf('limit')) : null;
  const idsRaw = valueOf('ids');
  const ids = idsRaw ? idsRaw.split(',').map((s) => Number(s.trim())).filter(Number.isFinite) : null;

  const db = openDb(process.env.DB_PATH || path.join(ROOT, 'data/villa.db'));
  try {
    const result = await hashImages(db, { imagesDir, ids, limit, log: console });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`[images-hash] ${String((err && err.message) || err)}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export default { hashImages, main };
