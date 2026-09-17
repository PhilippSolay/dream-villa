// `npm run seed -- ./seed/bhi-sweep-2026-09-17.json` — SPEC §8.
//
// 1. parse the sweep's `raw` rows with the proven card parser (dirty rows are logged, not imported)
// 2. normalise → pins → score → upsert
// 3. fetch the detail page for every in-band row (SPEC §8), re-normalise with the JSON facts
// 4. download the images of those rows (SPEC §8: "then images/pins/score")
// 5. rescore everything, close the run, print a plain-text report
//
// Steps 2–4 go through `scrape/ingest.js`, the same path the daily scrape uses.
// Options: `--no-detail` (step 3 off), `--no-images` (step 4 off), `--limit=N`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, getConfig } from './db.js';
import { loadEnvFile } from './index.js';
import { inBand, reasonsFor } from './scrape/score.js';
import { createCtx } from './scrape/fetch.js';
import {
  upsertProperty, rescoreAll, startRun, finishRun, countsSummary, parseRow,
} from './scrape/store.js';
import { buildRow, ingestListing } from './scrape/ingest.js';
import bhi from './scrape/adapters/bhi.js';
import { cardFromSeedRaw, parseCard } from './scrape/adapters/bhi-parse.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SWEEP = path.join(ROOT, 'seed/bhi-sweep-2026-09-17.json');

const DETAIL_PROGRESS_EVERY = 25;
const NEAR_MISS_LIMIT = 10;

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

/** A sweep `raw` row → the adapter partial `normaliseListing` expects. */
function partialFromSeed(raw) {
  const card = parseCard(cardFromSeedRaw(raw));
  if (card.dirty) return { dirty: true, ref: card.ref };

  const categories = String(raw.c || '').split(',').map((s) => s.trim()).filter(Boolean);

  return {
    source: 'bhi',
    ref: card.ref,
    url: card.url,
    title: card.title,
    note: card.note,
    location: card.location,
    category: categories[0] || null,
    categories,
    bedrooms: card.bedrooms,
    available_from: card.available_from,
    price_month_idr: card.price_month_idr,
    price_year_idr: card.price_year_idr,
    term: card.term,
    for_sale: card.for_sale,
    newly_listed: card.newly_listed,
    thumb: card.thumb,
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Import one sweep file into `db`.
 * @param {import('better-sqlite3').Database} db
 * @param {string} file
 * @param {{detail?:boolean, images?:boolean, limit?:number, log?:Function, cacheDir?:string}} [opts]
 * @returns {Promise<object>} stats for the report
 */
export async function importSweep(db, file = DEFAULT_SWEEP, opts = {}) {
  // `images` defaults OFF here: the image pass is network-heavy, so a programmatic
  // caller (a test) has to ask for it. `npm run seed` turns it on unless --no-images.
  const {
    detail = true, images = false, limit = null,
    log = () => {}, cacheDir = path.join(ROOT, 'data/cache'),
  } = opts;

  const sweep = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fetchedAt = sweep.fetched_at || new Date().toISOString();
  const config = getConfig(db);

  const runId = startRun(db, 'seed', ['bhi']);

  const stats = {
    file,
    fetched_at: fetchedAt,
    lines: (sweep.raw || []).length,
    dirty: [],
    seen: 0,
    new: 0,
    updated: 0,
    gone: 0,
    detail_attempted: 0,
    detail_ok: 0,
    detail_failed: [],
    detail_blocked: null,
    detail_skipped: !detail,
  };

  // --- pass 1: the cards ----------------------------------------------------
  const rows = new Map(); // ref → { partial, row }
  let raws = sweep.raw || [];
  if (limit) raws = raws.slice(0, limit);

  for (const raw of raws) {
    const partial = partialFromSeed(raw);
    if (partial.dirty) {
      stats.dirty.push(partial.ref);
      log(`[seed] dirty row skipped: ${partial.ref}`);
      continue;
    }
    if (rows.has(partial.ref)) continue; // same villa under monthly AND yearly

    const row = buildRow(partial, config, {
      firstSeen: fetchedAt,
      images: partial.thumb ? [{ src_url: partial.thumb }] : null,
    });

    const res = upsertProperty(db, row, { now: fetchedAt });
    stats.seen += 1;
    if (res && (res.action === 'insert' || res.action === 'new' || res.action === 'inserted')) stats.new += 1;
    else stats.updated += 1;

    rows.set(partial.ref, { partial, row, id: res && res.id });
  }

  // --- pass 2: detail pages for everything in the aggregation band -----------
  const inband = [...rows.values()].filter((r) => inBand(r.row, config));
  // createCtx wants a console-shaped logger (it calls log.warn?.()); `log` here is a plain fn.
  const ctx = createCtx({ db, config, log: console, cacheDir, minIntervalMs: 1000 });

  if (detail) {
    let done = 0;

    for (const entry of inband) {
      stats.detail_attempted += 1;
      done += 1;
      try {
        const res = await ingestListing(db, ctx, bhi, entry.partial, { detail: true, now: fetchedAt, config });
        if (!res.detail) {
          stats.detail_failed.push(`${entry.partial.ref}: ${res.skipped || 'no property JSON'}`);
        } else {
          if (res.row.availability === 'gone') stats.gone += 1;
          entry.row = res.row;
          if (res.id) entry.id = res.id;
          stats.detail_ok += 1;
        }
      } catch (err) {
        const msg = String((err && err.message) || err);
        if (msg.startsWith('blocked:')) {
          stats.detail_blocked = msg;
          log(`[seed] ${msg} — stopping detail enrichment after ${done}/${inband.length}`);
          break;
        }
        stats.detail_failed.push(`${entry.partial.ref}: ${msg}`);
      }
      if (done % DETAIL_PROGRESS_EVERY === 0 || done === inband.length) {
        log(`[seed] detail ${done}/${inband.length} (ok ${stats.detail_ok}, failed ${stats.detail_failed.length})`);
      }
    }
  }

  // --- pass 3: images for the in-band rows (SPEC §8) -------------------------
  if (images) {
    const processImages = await loadProcessImages();
    if (!processImages) {
      log('[seed] images: src/scrape/images.js not available — skipped');
      stats.images_skipped = 'module not available';
    } else {
      const ids = inband.map((e) => e.id).filter(Boolean);
      try {
        stats.images = await processImages(db, ctx, { ids, maxPerListing: 20 });
        log(
          `[seed] images: ${stats.images.downloaded} downloaded, ${stats.images.skipped} skipped, ` +
            `${stats.images.failed} failed over ${stats.images.listings} listings`
        );
      } catch (err) {
        stats.images_skipped = String((err && err.message) || err);
        log(`[seed] images failed: ${stats.images_skipped}`);
      }
    }
  } else {
    stats.images_skipped = '--no-images';
  }

  // --- pass 4: rescore and close the run ------------------------------------
  const rescored = rescoreAll(db, config);
  const counts = countsSummary(db);

  const notes = [];
  if (stats.dirty.length) notes.push(`dirty rows discarded: ${stats.dirty.join(', ')}`);
  if (stats.detail_skipped) notes.push('detail enrichment skipped (--no-detail)');
  if (stats.detail_blocked) notes.push(`detail enrichment stopped: ${stats.detail_blocked}`);
  if (stats.detail_failed.length) {
    notes.push(`detail failures (${stats.detail_failed.length}): ${stats.detail_failed.slice(0, 20).join('; ')}`);
  }

  finishRun(db, runId, {
    seen: stats.seen,
    new: stats.new,
    updated: stats.updated,
    gone: stats.gone,
    flagged: counts.flagged ?? null,
    notes,
  });

  stats.run_id = runId;
  stats.counts = counts;
  stats.rescored = rescored;
  return stats;
}

/**
 * `src/scrape/images.js` is built alongside this step; until it lands the seed
 * simply reports that the pass was skipped instead of failing the import.
 */
async function loadProcessImages() {
  try {
    const mod = await import('./scrape/images.js');
    const fn = mod.processImages || (mod.default && mod.default.processImages);
    return typeof fn === 'function' ? fn : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const M = (idr) => {
  if (idr == null) return '-';
  const m = idr / 1e6;
  const shown = Math.round(m * 10) / 10;
  return `${Number.isInteger(shown) ? shown : shown.toFixed(1)} M/mo`;
};

const pad = (s, n) => String(s ?? '').padEnd(n);
const padL = (s, n) => String(s ?? '').padStart(n);

function allRows(db) {
  return db.prepare('SELECT * FROM properties').all().map((r) => parseRow(r));
}

function whyNotFlagged(row, config) {
  const why = [];
  const threshold = config.flag_threshold ?? 65;
  if ((row.fit_score ?? 0) < threshold) why.push(`fit ${row.fit_score} < ${threshold}`);
  const flags = Array.isArray(row.red_flags) ? row.red_flags : [];
  for (const f of flags) why.push(`red flag: ${f}`);
  if (row.status === 'rejected') why.push('status rejected');
  return why.length ? why.join(', ') : 'none';
}

/** SPEC §8's stdout report. Plain text, no emoji. */
export function buildReport(db, config, stats) {
  const rows = allRows(db);
  const out = [];
  const line = (s = '') => out.push(s);

  const counts = {
    total: rows.length,
    in_filter: rows.filter((r) => r.scope === 'in_filter').length,
    market: rows.filter((r) => r.scope !== 'in_filter').length,
    flagged: rows.filter((r) => r.flagged === 1).length,
    gone: rows.filter((r) => r.availability === 'gone').length,
  };

  line('=== SEED REPORT ===');
  line(`file          ${stats.file}`);
  line(`fetched_at    ${stats.fetched_at}`);
  line(`run           #${stats.run_id}  seen ${stats.seen}  new ${stats.new}  updated ${stats.updated}`);
  if (stats.dirty.length) line(`dirty rows    ${stats.dirty.join(', ')} (discarded)`);
  if (stats.detail_skipped) line('detail        skipped (--no-detail)');
  else {
    line(`detail        ${stats.detail_ok}/${stats.detail_attempted} enriched, ${stats.detail_failed.length} failed`);
    if (stats.detail_blocked) line(`detail        STOPPED: ${stats.detail_blocked}`);
  }
  line();
  line('COUNTS');
  line(`  total      ${counts.total}`);
  line(`  in_filter  ${counts.in_filter}`);
  line(`  market     ${counts.market}`);
  line(`  flagged    ${counts.flagged}`);
  line(`  gone       ${counts.gone}`);
  line();

  // --- per area -------------------------------------------------------------
  const byArea = new Map();
  for (const r of rows) {
    const a = r.area || '(none)';
    const e = byArea.get(a) || { area: a, n: 0, in_filter: 0, flagged: 0 };
    e.n += 1;
    if (r.scope === 'in_filter') e.in_filter += 1;
    if (r.flagged === 1) e.flagged += 1;
    byArea.set(a, e);
  }
  line('BY AREA');
  line(`  ${pad('area', 16)}${padL('n', 5)}${padL('in_filter', 11)}${padL('flagged', 9)}`);
  for (const e of [...byArea.values()].sort((a, b) => b.n - a.n || a.area.localeCompare(b.area))) {
    line(`  ${pad(e.area, 16)}${padL(e.n, 5)}${padL(e.in_filter, 11)}${padL(e.flagged, 9)}`);
  }
  line();

  // --- flagged --------------------------------------------------------------
  const flagged = rows.filter((r) => r.flagged === 1).sort((a, b) => (b.fit_score ?? 0) - (a.fit_score ?? 0));
  line(`FLAGGED (${flagged.length})`);
  if (!flagged.length) line('  (none)');
  for (const r of flagged) {
    line(`  ${pad(r.ref, 9)}fit ${padL(r.fit_score, 3)}  ${reasonsFor(r).join(', ')}  ${r.url}`);
  }
  line();

  // --- near misses ----------------------------------------------------------
  const near = rows
    .filter((r) => r.scope === 'in_filter' && r.flagged !== 1)
    .sort((a, b) => (b.fit_score ?? 0) - (a.fit_score ?? 0))
    .slice(0, NEAR_MISS_LIMIT);
  line(`NEAR MISSES (top ${near.length} in_filter but not flagged)`);
  if (!near.length) line('  (none)');
  for (const r of near) {
    line(`  ${pad(r.ref, 9)}fit ${padL(r.fit_score, 3)}  ${reasonsFor(r).join(', ')}`);
    line(`  ${' '.repeat(9)}why not: ${whyNotFlagged(r, config)}`);
    line(`  ${' '.repeat(9)}${r.url}`);
  }
  line();

  // --- far from the beach ---------------------------------------------------
  // Beach distance is a SOFT filter (Philipp, 2026-09-17): it costs fit points but
  // never excludes, so the far in-filter rows are listed for eyeballing instead.
  const beachMax = config.beach_km_max ?? 4;
  const far = rows
    .filter((r) => r.scope === 'in_filter' && r.beach_km != null && r.beach_km > beachMax)
    .map((r) => ({ r }))
    .sort((a, b) => (a.r.beach_km ?? 99) - (b.r.beach_km ?? 99));
  line(`IN-FILTER, BEACH OVER ${beachMax} KM (${far.length}) — soft filter; check these distances`);
  if (!far.length) line('  (none)');
  for (const { r } of far) {
    line(
      `  ${pad(r.ref, 9)}${pad(r.area, 14)}${pad(r.sub_area || '-', 22)}` +
        `${padL(r.beach_km == null ? '-' : r.beach_km.toFixed(1) + ' km', 9)}  ` +
        `${pad(r.beach_source || '-', 14)}${pad(r.pin_source || '-', 12)}${M(r.price_month_idr)}`
    );
  }
  line();
  line('=== END ===');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  loadEnvFile();

  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const file = positional[0] ? path.resolve(positional[0]) : DEFAULT_SWEEP;
  const limitFlag = flags.find((f) => f.startsWith('--limit='));

  if (!fs.existsSync(file)) {
    console.error(`[seed] no such sweep file: ${file}`);
    process.exit(1);
  }

  const db = openDb(process.env.DB_PATH || path.join(ROOT, 'data/villa.db'));
  try {
    const stats = await importSweep(db, file, {
      detail: !flags.includes('--no-detail'),
      images: !flags.includes('--no-images'),
      limit: limitFlag ? Number(limitFlag.split('=')[1]) : null,
      log: (...a) => console.log(...a),
    });
    console.log();
    console.log(buildReport(db, getConfig(db), stats));
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

export default { importSweep, buildReport, main };
