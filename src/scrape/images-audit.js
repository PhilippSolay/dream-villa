// Image availability audit + repair for existing listings (Philipp: "check all
// current items for image availability, some have only one or broken links").
// SPEC §6 "Images". processImages (images.js) only checks whether a gallery entry
// HAS a `file` field in the DB — it never verifies that file is still on disk (a
// wiped volume, a bad deploy, a manual delete). This module closes that gap:
//   - auditImages: read-only, disk-aware counts, safe to run anywhere, anytime.
//   - repairImages: re-downloads what it can, permanently marks the rest `dead`
//     so the UI and processImages stop retrying a link that will never come back.
//
//   node src/scrape/images-audit.js [--fix] [--limit=N]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../db.js';
import { loadEnvFile } from '../index.js';
import { createCtx } from './fetch.js';
import { parseRow } from './store.js';
import { imageFilePath, resizeToJpeg } from './images.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------------------
// Shared row selection
// ---------------------------------------------------------------------------

/** A row folded away by dedupe (`raw.merged_into`) is a duplicate's leftovers, not a
 *  listing anyone looks at — SPEC-adjacent to market-metrics.js's own reading of `raw`. */
function isMerged(row) {
  const raw = row.raw;
  return !!(raw && typeof raw === 'object' && !Array.isArray(raw) && raw.merged_into != null);
}

function nonMergedProperties(db) {
  return db
    .prepare('SELECT * FROM properties')
    .all()
    .map(parseRow)
    .filter((row) => !isMerged(row));
}

/** Whether a gallery entry's `file` actually exists on disk right now. */
function onDisk(imagesDir, entry) {
  return !!(entry && entry.file && fs.existsSync(path.join(imagesDir, entry.file)));
}

// ---------------------------------------------------------------------------
// Audit — read-only, disk-aware
// ---------------------------------------------------------------------------

function emptySourceRow(source) {
  return {
    source, listings: 0, entries: 0, local_ok: 0, local_missing: 0,
    remote_only: 0, dead: 0, gallery0: 0, gallery1: 0, gallery2plus: 0, hero_missing: 0,
  };
}

/**
 * For every non-merged property: count gallery entries by state, and bucket galleries
 * by how many images actually usable (present on disk).
 * @returns {{by_source: object[], totals: object, problem_ids: number[]}}
 */
export function auditImages(db, { imagesDir = process.env.IMAGES_DIR || 'data/images' } = {}) {
  const rows = nonMergedProperties(db);
  const bySource = new Map();
  const problemIds = [];

  for (const row of rows) {
    const images = Array.isArray(row.images) ? row.images : [];
    const source = row.source || 'unknown';
    if (!bySource.has(source)) bySource.set(source, emptySourceRow(source));
    const s = bySource.get(source);
    s.listings += 1;

    let usable = 0;
    let hasEntryProblem = false;
    for (const entry of images) {
      s.entries += 1;
      if (entry?.dead) {
        s.dead += 1;
        hasEntryProblem = true;
      } else if (entry?.file) {
        if (onDisk(imagesDir, entry)) {
          s.local_ok += 1;
          usable += 1;
        } else {
          s.local_missing += 1;
          hasEntryProblem = true;
        }
      } else {
        s.remote_only += 1;
      }
    }

    if (usable === 0) s.gallery0 += 1;
    else if (usable === 1) s.gallery1 += 1;
    else s.gallery2plus += 1;

    const heroMissing = !row.hero_file || !onDisk(imagesDir, { file: row.hero_file });
    if (heroMissing) s.hero_missing += 1;

    // "some have only one or broken links" — a problem row is one with 0-1 usable
    // photos, a broken hero, or an entry that's missing/dead on disk.
    if (usable <= 1 || heroMissing || hasEntryProblem) problemIds.push(row.id);
  }

  const bySourceList = [...bySource.values()].sort((a, b) => b.listings - a.listings || a.source.localeCompare(b.source));
  const totals = bySourceList.reduce((acc, s) => {
    for (const key of Object.keys(s)) if (key !== 'source') acc[key] = (acc[key] || 0) + s[key];
    return acc;
  }, {});
  totals.listings = rows.length;

  return { by_source: bySourceList, totals, problem_ids: problemIds };
}

// ---------------------------------------------------------------------------
// Repair — downloads what it can, marks the rest dead
// ---------------------------------------------------------------------------

/** Non-merged rows carrying at least one entry worth touching: no file, or a file
 *  that no longer exists on disk — dead entries are permanently skipped. */
function repairCandidates(db, imagesDir) {
  return nonMergedProperties(db).filter((row) => {
    const images = Array.isArray(row.images) ? row.images : [];
    return images.some((e) => !e?.dead && !onDisk(imagesDir, e));
  });
}

/**
 * Re-download missing/broken gallery entries (rate-limited per host via ctx.fetchBuffer),
 * mark permanently-gone ones `dead: true` (src_url kept for reference, entry never
 * deleted), then recompute hero_file from what's actually on disk.
 * @returns {Promise<{downloaded:number, dropped:number, hero_fixed:number, still_missing:number}>}
 */
export async function repairImages(
  db,
  ctx,
  { imagesDir = process.env.IMAGES_DIR || 'data/images', limit = null, log = ctx.log } = {}
) {
  let candidates = repairCandidates(db, imagesDir);
  if (limit != null) candidates = candidates.slice(0, limit);

  let downloaded = 0;
  let dropped = 0;
  let heroFixed = 0;
  let stillMissing = 0;

  const update = db.prepare('UPDATE properties SET images = ?, hero_file = ? WHERE id = ?');

  for (const row of candidates) {
    const images = (Array.isArray(row.images) ? row.images : []).map((e) => ({ ...e }));
    let changed = false;

    for (let i = 0; i < images.length; i++) {
      const entry = images[i];
      if (entry.dead || onDisk(imagesDir, entry)) continue;

      // Nothing to (re)fetch — e.g. a person-uploaded photo (`src_url: null`) whose
      // file went missing. Not "dead" (we can't know it's gone for good), just missing.
      if (!entry.src_url) {
        stillMissing += 1;
        continue;
      }

      const n = i + 1;
      const filePath = imageFilePath(imagesDir, row.id, n);
      try {
        const { buffer, status, contentType } = await ctx.fetchBuffer(entry.src_url);

        if (status === 404 || status === 410 || !contentType || !contentType.startsWith('image/')) {
          images[i] = { src_url: entry.src_url, dead: true };
          changed = true;
          dropped += 1;
          continue;
        }
        if (status !== 200) throw new Error(`status ${status}`);

        const { buffer: out, w, h } = await resizeToJpeg(buffer);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, out);
        images[i] = { src_url: entry.src_url, file: `${row.id}/${n}.jpg`, w, h };
        changed = true;
        downloaded += 1;
      } catch (err) {
        // Anything else (timeout, 5xx, blocked): leave the entry alone for next time.
        stillMissing += 1;
        log?.warn?.(`[images-audit] failed ${entry.src_url}: ${err.message}`);
      }
    }

    const heroEntry = images.find((e) => onDisk(imagesDir, e));
    const newHero = heroEntry ? heroEntry.file : null;
    if (newHero !== row.hero_file) heroFixed += 1;
    if (changed || newHero !== row.hero_file) update.run(JSON.stringify(images), newHero, row.id);
  }

  return { downloaded, dropped, hero_fixed: heroFixed, still_missing: stillMissing };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const pad = (s, n) => String(s ?? '').padEnd(n);
const padL = (s, n) => String(s ?? '').padStart(n);

export function auditReport(report) {
  const out = [];
  const line = (s = '') => out.push(s);
  const cols = ['source', 'listings', 'entries', 'local_ok', 'local_missing', 'remote_only', 'dead', 'gallery0', 'gallery1', 'gallery2plus', 'hero_missing'];
  const widths = { source: 14, listings: 9, entries: 8, local_ok: 9, local_missing: 13, remote_only: 12, dead: 6, gallery0: 9, gallery1: 9, gallery2plus: 12, hero_missing: 12 };

  line();
  line('=== IMAGE AUDIT ===');
  line(cols.map((c) => padL(c, widths[c])).join(' '));
  for (const s of report.by_source) line(cols.map((c) => padL(s[c], widths[c])).join(' '));
  line(cols.map((c) => padL(c === 'source' ? 'TOTAL' : report.totals[c], widths[c])).join(' '));
  line();
  line(`problem listings (0-1 usable photo, broken hero, or a missing/dead entry): ${report.problem_ids.length}`);
  line('=== END ===');
  return out.join('\n');
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

  const db = openDb(process.env.DB_PATH || path.join(ROOT, 'data/villa.db'));
  try {
    const before = auditImages(db, { imagesDir });
    console.log(auditReport(before));

    if (flags.includes('--fix')) {
      const ctx = createCtx({
        db, log: console,
        cacheDir: process.env.CACHE_DIR || path.join(ROOT, 'data/cache'),
        minIntervalMs: 1000,
      });
      const limit = valueOf('limit') ? Number(valueOf('limit')) : null;
      const result = await repairImages(db, ctx, { imagesDir, limit, log: console });
      console.log(
        `\n[images-audit] repair: ${result.downloaded} downloaded, ${result.dropped} dropped (dead), ` +
          `${result.hero_fixed} hero fixed, ${result.still_missing} still missing`
      );

      console.log('\n=== AFTER ===');
      console.log(auditReport(auditImages(db, { imagesDir })));
    }
  } catch (err) {
    console.error(`[images-audit] ${String((err && err.message) || err)}`);
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

export default { auditImages, repairImages, auditReport, main };
