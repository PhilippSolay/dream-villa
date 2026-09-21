// Settle an import batch — "make sure you dont get dups before downloading images"
// (Philipp, 2026-09-21).
//
// POST /api/import/listings used to queue every gallery of every imported row straight
// into processImages and let the 06:00 run merge duplicates hours later. A Bali Villa
// Hub listing that is the same villa as a row we already have (another agency's record,
// or a Facebook post) therefore cost a full gallery of downloads — 20 requests at one
// per second against the source host — for a row that was about to be marked `gone`.
//
// This pass orders the work cheapest-evidence-first:
//
//   1. dedupeAll  — rule 1 (title / description prefix / shared src_url) needs no pixels.
//   2. hero probe — ONE image per surviving row, which gives it a dHash (image-hash.js),
//      then look for a live row in the same area that already owns that photograph.
//      A single shared photo is not proof on its own (a complex reuses its pool shot),
//      so it must be corroborated by price within 10 % or a title Dice >= 0.6 — the same
//      shape as SPEC §6 rule 1, with the photo standing in for the strict-5 % price test.
//   3. galleries  — full download, survivors only.
//   4. dedupeAll  — again, now that rule 2 (two shared photos, by hash) has hashes.
//   5. cleanup    — drop the image files of rows merged away in this job.
//
// CLAUDE.md: a listing row is never deleted; a duplicate becomes `availability='gone'`
// with `raw.merged_into`. Only its *files* go, and only when no surviving row's gallery
// still points at them (mergeInto hands `images`/`hero_file` to a keeper that had none).
//
// Never throws: every step is guarded, and the summary reports what did happen.

import fs from 'node:fs';
import path from 'node:path';

import {
  dedupeAll,
  mergeInto,
  keeperFirst,
  bedroomsCompatible,
  sameComplexDifferentUnit,
  promoImages,
  diceTrigram,
} from './dedupe.js';
import { sharedImages } from './image-hash.js';
import { processImages } from './images.js';

/** A hero photo plus a price this close is the same villa (rule 1 uses 5 % with no photo). */
const HERO_PRICE_TOLERANCE = 0.1;
/** ...or a title this similar. Lower than rule 1's 0.8: the photo is carrying the match. */
const HERO_TITLE_SIMILARITY = 0.6;
/** Same ceiling images.js uses by default and the daily run passes explicitly. */
const GALLERY_MAX_PER_LISTING = 20;

const LIVE = "(availability IS NULL OR availability <> 'gone')";

function parseImages(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function liveRows(db) {
  return db.prepare(`SELECT * FROM properties WHERE ${LIVE} ORDER BY id`).all();
}

function priceWithin(a, b, tolerance) {
  const pa = a.price_month_idr;
  const pb = b.price_month_idr;
  if (pa == null || pb == null) return false;
  const max = Math.max(Math.abs(pa), Math.abs(pb));
  if (max === 0) return false;
  return Math.abs(pa - pb) <= tolerance * max;
}

/** The probed row's first photo that actually carries a hash, as a one-entry images array. */
function heroImages(row) {
  const entry = parseImages(row.images).find((im) => im && typeof im === 'object' && im.hash);
  return entry ? [{ src_url: entry.src_url ?? null, hash: entry.hash }] : null;
}

/**
 * A live row that already owns this row's hero photograph, or null.
 * Same guards findDuplicates applies (area known and not `other`, bedrooms may not
 * contradict, never two units of one complex), plus the corroboration test.
 */
function findHeroMatch(row, candidates, ignore) {
  const hero = heroImages(row);
  if (!hero) return null;
  if (!row.area || row.area === 'other') return null;

  for (const other of candidates) {
    if (other.id === row.id || other.key === row.key) continue;
    if (other.area !== row.area) continue;
    if (!bedroomsCompatible(row, other)) continue;
    if (sameComplexDifferentUnit(row, other)) continue;
    if (sharedImages(hero, other.images, { ignore }).count < 1) continue;
    if (!priceWithin(row, other, HERO_PRICE_TOLERANCE) && diceTrigram(row.title, other.title) < HERO_TITLE_SIMILARITY) {
      continue;
    }
    return other;
  }
  return null;
}

/** `<id>/` prefixes still referenced by a surviving row's gallery — those files must stay. */
function referencedPrefixes(db) {
  const out = new Set();
  for (const row of db.prepare(`SELECT images, hero_file FROM properties WHERE ${LIVE}`).all()) {
    if (typeof row.hero_file === 'string' && row.hero_file.includes('/')) out.add(row.hero_file.split('/')[0]);
    for (const im of parseImages(row.images)) {
      if (im && typeof im === 'object' && typeof im.file === 'string' && im.file.includes('/')) {
        out.add(im.file.split('/')[0]);
      }
    }
  }
  return out;
}

/** Delete `<imagesDir>/<id>/`; returns how many files went. Missing directory = 0. */
function removeImageDir(imagesDir, id) {
  const dir = path.join(imagesDir, String(id));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    try {
      fs.rmSync(path.join(dir, name), { force: true, recursive: true });
      removed += 1;
    } catch {
      /* leave it; the row is gone either way */
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* non-empty or already gone */
  }
  return removed;
}

/**
 * Dedupe an imported batch before its galleries are downloaded, then download and
 * dedupe again. Background job for POST /api/import/listings; never rejects.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{fetchBuffer:Function}} ctx fetch context (per-host rate limiting lives there)
 * @param {{ids:number[], imagesDir:string, log?:object}} opts
 * @returns {Promise<{merged_early:number, merged_by_hero:number, merged_late:number,
 *   galleries_downloaded:number, files_removed:number,
 *   merges:{kept_id:number, merged_id:number, reason:string}[], errors:string[]}>}
 */
export async function settleImport(db, ctx, { ids = [], imagesDir, log = ctx?.log } = {}) {
  const merges = [];
  const errors = [];
  const mergedAway = new Set();
  let mergedEarly = 0;
  let mergedByHero = 0;
  let mergedLate = 0;
  let galleriesDownloaded = 0;

  const note = (err, step) => {
    const message = String((err && err.message) || err);
    errors.push(`${step}: ${message}`);
    log?.error?.({ err, step }, 'settle: step failed');
  };

  const record = (list) => {
    for (const m of list) {
      merges.push(m);
      mergedAway.add(m.merged_id);
    }
  };

  try {
    // --- 1. cheap dedupe ----------------------------------------------------
    try {
      const { merged } = dedupeAll(db);
      mergedEarly = merged.length;
      record(merged);
    } catch (err) {
      note(err, 'dedupe_early');
    }

    const isLive = db.prepare(`SELECT id FROM properties WHERE id = ? AND ${LIVE}`);
    let survivors = ids.filter((id) => !mergedAway.has(id) && isLive.get(id));

    // --- 2. hero probe ------------------------------------------------------
    try {
      if (survivors.length) {
        await processImages(db, ctx, { ids: survivors, imagesDir, maxPerListing: 1, log });

        // One snapshot of the live table, refreshed only when a merge actually changes
        // it — merges are rare, and re-reading every row per probed listing is not.
        let rows = liveRows(db);
        let ignore = promoImages(rows);

        for (const id of survivors.slice()) {
          if (mergedAway.has(id)) continue;
          const probed = rows.find((r) => r.id === id);
          if (!probed) continue;

          const match = findHeroMatch(probed, rows, ignore);
          if (!match) continue;

          const [keep, drop] = keeperFirst(probed, match);
          const result = mergeInto(db, keep.id, drop.id, { reason: `hero photo matches #${match.id}` });
          if (result.error) continue;

          mergedByHero += 1;
          record([result]);
          // The merged-away row keeps whatever it already had; the rest of its gallery
          // is never fetched — that is the whole point of the probe.
          survivors = survivors.filter((s) => s !== result.merged_id);
          rows = liveRows(db);
          ignore = promoImages(rows);
        }
      }
    } catch (err) {
      note(err, 'hero_probe');
    }

    // --- 3. galleries -------------------------------------------------------
    try {
      if (survivors.length) {
        await processImages(db, ctx, {
          ids: survivors,
          imagesDir,
          maxPerListing: GALLERY_MAX_PER_LISTING,
          log,
        });
        galleriesDownloaded = survivors.length;
      }
    } catch (err) {
      note(err, 'galleries');
    }

    // --- 4. full dedupe -----------------------------------------------------
    try {
      const { merged } = dedupeAll(db);
      mergedLate = merged.length;
      record(merged);
    } catch (err) {
      note(err, 'dedupe_late');
    }
  } catch (err) {
    note(err, 'settle');
  }

  // --- 5. cleanup -----------------------------------------------------------
  let filesRemoved = 0;
  try {
    if (imagesDir) {
      const keepPrefixes = referencedPrefixes(db);
      for (const id of mergedAway) {
        if (keepPrefixes.has(String(id))) continue; // a survivor inherited that gallery
        filesRemoved += removeImageDir(imagesDir, id);
      }
    }
  } catch (err) {
    note(err, 'cleanup');
  }

  const summary = {
    merged_early: mergedEarly,
    merged_by_hero: mergedByHero,
    merged_late: mergedLate,
    galleries_downloaded: galleriesDownloaded,
    files_removed: filesRemoved,
  };
  log?.info?.({ ...summary }, 'settle: import settled');

  return { ...summary, merges, errors };
}

export default { settleImport };
