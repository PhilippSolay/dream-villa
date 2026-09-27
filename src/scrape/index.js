// SPEC §6 — the daily run: every adapter's index, then images, geocode, dedupe,
// score, recheck, learn, and one `runs` row describing what happened.
//
//   node src/scrape/index.js [--source=bhi] [--dry] [--limit=N] [--no-detail] [--no-images]
//
// Cron: 06:00 Asia/Makassar (SPEC §6), which also takes the nightly backup (SPEC §9).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeCron from 'node-cron';

import { openDb, getConfig, nowIso } from '../db.js';
import { loadEnvFile } from '../index.js';
import { createCtx } from './fetch.js';
import { mapArea } from './normalise.js';
import { getAdapters } from './adapters/index.js';
import { ingestListing } from './ingest.js';
import { processInbox } from './inbox.js';
import { dedupeAll } from './dedupe.js';
import { recheckAll } from './recheck.js';
import { rescoreAll, startRun, finishRun, countsSummary, markUnlisted } from './store.js';
import { DEFAULT_BACKUP_DIR, DEFAULT_KEEP } from '../backup.js';
import { disabledSourceIds } from '../sources.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const DEFAULT_CRON = '0 6 * * *';
export const DEFAULT_TZ = 'Asia/Makassar';

/** A listing untouched for longer than this is worth a line in the run notes. */
const STALE_DAYS = 3;

// ---------------------------------------------------------------------------
// The concurrently-built passes (images / geocode / learn). They land in their own
// files; until they do, the run reports them as unavailable instead of failing.
// ---------------------------------------------------------------------------

async function optionalPass(spec, name) {
  try {
    const mod = await import(spec);
    const fn = mod[name] || (mod.default && mod.default[name]);
    return typeof fn === 'function' ? fn : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const pad = (s, n) => String(s ?? '').padEnd(n);
const padL = (s, n) => String(s ?? '').padStart(n);

export function money(idr) {
  if (idr == null) return '-';
  const m = idr / 1e6;
  const shown = Math.round(m * 10) / 10;
  return `${Number.isInteger(shown) ? shown : shown.toFixed(1)} M/mo`;
}

/** `'monthly/seseh,yearly/seseh'` → `['seseh']` — the source's own index slugs. */
function slugsOf(category) {
  return [
    ...new Set(
      String(category || '')
        .split(',')
        .map((c) => c.split('/').pop().trim())
        .filter(Boolean)
    ),
  ];
}

/** learn.js reports some fields as arrays and some as counts — read both. */
function count(v) {
  if (Array.isArray(v)) return v.length;
  return Number.isFinite(v) ? v : 0;
}

function tally(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function sortedEntries(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string|string[]|null} [opts.sources] `--source=`; null = every adapter
 * @param {object[]|null} [opts.adapters] adapter objects to run instead of the registry (tests)
 * @param {boolean} [opts.dry] print what would be upserted, write nothing
 * @param {number|null} [opts.limit] stop after N cards per adapter (also caps the recheck)
 * @param {boolean} [opts.detail] fetch detail pages
 * @param {boolean} [opts.images] download/resize images
 * @param {Function} [opts.log]
 * @param {Function} [opts.onRun] told the runs row id as soon as it exists (src/jobs closes it if the worker dies)
 * @returns {Promise<object>} the run summary
 */
export async function runScrape({
  db,
  sources = null,
  adapters: adapterList = null,
  dry = false,
  limit = null,
  detail = true,
  images = true,
  log = (...a) => console.log(...a),
  onRun = null,
  cacheDir = process.env.CACHE_DIR || path.join(ROOT, 'data/cache'),
  now = nowIso(),
} = {}) {
  if (!db) throw new Error('runScrape needs a db');

  const t0 = Date.now();
  const config = getConfig(db);
  const all = adapterList && adapterList.length ? adapterList : getAdapters(sources);

  // Intake settings (config.sources): a source turned off on the Agent page is skipped
  // by the daily run and by the cron. Naming a source explicitly — `--source=bhi`, or
  // `POST /api/scrape {source}` — always wins: an explicit ask is never second-guessed.
  const explicit = sources != null && sources !== '' && sources !== 'all';
  const skippedSources = [];
  let list = all;
  if (!explicit) {
    const disabled = disabledSourceIds(db);
    list = all.filter((a) => {
      if (!disabled.has(a.id)) return true;
      skippedSources.push(a.id);
      return false;
    });
    for (const id of skippedSources) log(`[scrape] ${id}: disabled in intake settings — skipped`);
  }

  const ids = list.map((a) => a.id);
  const adaptersById = Object.fromEntries(list.map((a) => [a.id, a]));

  const ctx = createCtx({ db, config, log: console, cacheDir, minIntervalMs: 1000 });

  const summary = {
    dry,
    run_id: null,
    started_at: now,
    sources: ids,
    skipped_sources: skippedSources,
    seen: 0,
    new: 0,
    updated: 0,
    unchanged: 0,
    skipped_out_of_band: 0,
    per_source: {},
    by_area: {},
    by_slug: {},
    cards: [],
    errors: [],
    notes: [],
  };

  const byArea = new Map();
  const bySlug = new Map();

  summary.run_id = dry ? null : startRun(db, 'scrape', ids);
  if (summary.run_id != null) onRun?.(summary.run_id);
  log(
    `[scrape] ${dry ? 'DRY ' : ''}start — sources ${ids.join(', ') || 'none'}` +
      `${skippedSources.length ? ` (disabled: ${skippedSources.join(', ')})` : ''}` +
      `${limit ? `, limit ${limit}/adapter` : ''}`
  );
  if (skippedSources.length) summary.notes.push(`disabled sources: ${skippedSources.join(', ')}`);

  // --- adapters -------------------------------------------------------------
  // Sources whose `list()` threw (blocked or otherwise) never "ran cleanly" — they
  // never see the unlisted pass below (SPEC-adjacent villa tracker filters).
  const erroredAdapterIds = new Set();
  for (const adapter of list) {
    const per = { seen: 0, new: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 };
    // Detail pages by cache rule (ingest.js detailPlan): new ref, known (7-day cache),
    // its weekly refresh day, or refetched today because the card moved.
    const detailCache = { new: 0, known: 0, weekly: 0, refetch: 0 };
    summary.per_source[adapter.id] = per;

    try {
      for await (const partial of adapter.list(ctx)) {
        if (limit != null && per.seen >= limit) break;
        per.seen += 1;
        summary.seen += 1;

        const { area, sub_area } = mapArea({
          location: partial.location,
          title: partial.title,
          category: partial.category ?? partial.categories,
        });
        tally(byArea, area || 'other');
        for (const slug of slugsOf(partial.category)) tally(bySlug, slug);

        if (dry) {
          summary.cards.push({
            source: adapter.id,
            ref: partial.ref,
            area,
            sub_area,
            slugs: slugsOf(partial.category),
            bedrooms: partial.bedrooms,
            price_month_idr: partial.price_month_idr,
            price_year_idr: partial.price_year_idr,
            term: partial.term,
            url: partial.url,
          });
          continue;
        }

        try {
          const res = await ingestListing(db, ctx, adapter, partial, { detail, now, config });
          if (res.detail_cache) {
            const k = res.detail_cache in detailCache ? res.detail_cache : 'refetch';
            detailCache[k] += 1;
          }
          if (res.skipped === 'out_of_band') {
            per.skipped += 1;
            summary.skipped_out_of_band += 1;
          } else if (res.action === 'inserted') {
            per.new += 1;
            summary.new += 1;
          } else if (res.action === 'updated') {
            per.updated += 1;
            summary.updated += 1;
          } else {
            per.unchanged += 1;
            summary.unchanged += 1;
          }
        } catch (err) {
          const msg = String((err && err.message) || err);
          per.errors += 1;
          summary.errors.push(`${adapter.id}/${partial.ref || partial.url}: ${msg}`);
          if (msg.startsWith('blocked:')) throw err; // stop this adapter, keep the run
        }
      }
    } catch (err) {
      // One adapter failing must never abort the run (SPEC §6).
      const msg = String((err && err.message) || err);
      per.errors += 1;
      summary.errors.push(`${adapter.id}: ${msg}`);
      erroredAdapterIds.add(adapter.id);
      log(`[scrape] ${adapter.id} stopped: ${msg}`);
    }

    log(
      `[scrape] ${adapter.id}: seen ${per.seen}, new ${per.new}, updated ${per.updated}, ` +
        `unchanged ${per.unchanged}, out of band ${per.skipped}, errors ${per.errors}; ` +
        `detail pages: ${detailCache.new} new, ${detailCache.known} known (7-day cache), ` +
        `${detailCache.weekly} weekly refresh, ${detailCache.refetch} refetched on a card change`
    );
  }

  summary.by_area = Object.fromEntries(sortedEntries(byArea));
  summary.by_slug = Object.fromEntries(sortedEntries(bySlug));

  if (dry) {
    summary.ms = Date.now() - t0;
    log(dryReport(summary));
    log(`[scrape] DRY done in ${(summary.ms / 1000).toFixed(1)}s — nothing written`);
    return summary;
  }

  // --- inbox (SPEC §6 "Adapters to build" item 5) ---------------------------
  try {
    summary.inbox = await processInbox(db, ctx, { log });
    summary.notes.push(`inbox ${summary.inbox.processed}/${summary.inbox.done}/${summary.inbox.failed}`);
  } catch (err) {
    summary.errors.push(`inbox: ${String((err && err.message) || err)}`);
  }

  // --- images ---------------------------------------------------------------
  if (images) {
    const processImages = await optionalPass('./images.js', 'processImages');
    if (!processImages) {
      summary.notes.push('images: src/scrape/images.js not available — skipped');
    } else {
      try {
        summary.images = await processImages(db, ctx, { maxPerListing: 20 });
        summary.notes.push(
          `images: ${summary.images.downloaded} downloaded, ${summary.images.skipped} skipped, ${summary.images.failed} failed`
        );
      } catch (err) {
        summary.errors.push(`images: ${String((err && err.message) || err)}`);
      }
    }
  } else {
    summary.notes.push('images: skipped (--no-images)');
  }

  // --- geocode --------------------------------------------------------------
  const geocodeMissing = await optionalPass('./geocode.js', 'geocodeMissing');
  if (!geocodeMissing) {
    summary.notes.push('geocode: src/scrape/geocode.js not available — skipped');
  } else {
    try {
      summary.geocode = await geocodeMissing(db, ctx, {});
      summary.notes.push(`geocode: ${summary.geocode.resolved}/${summary.geocode.attempted} resolved`);
    } catch (err) {
      summary.errors.push(`geocode: ${String((err && err.message) || err)}`);
    }
  }

  // --- dedupe ---------------------------------------------------------------
  try {
    summary.dedupe = dedupeAll(db, { now });
    if (summary.dedupe.merged.length) {
      summary.notes.push(
        `dedupe: ${summary.dedupe.merged.length} merged — ` +
          summary.dedupe.merged.map((m) => `#${m.merged_id} into #${m.kept_id} (${m.reason})`).join('; ')
      );
    }
  } catch (err) {
    summary.errors.push(`dedupe: ${String((err && err.message) || err)}`);
  }

  // --- score ----------------------------------------------------------------
  // Against the config as it is now, not as the run found it: a weight edited on the
  // Agent page during a long run has already been rescored in its own worker, and the
  // run's start-of-day copy would undo it.
  summary.rescore = rescoreAll(db);

  // --- recheck --------------------------------------------------------------
  try {
    // `limit` caps the recheck too: a deliberately short run stays short (SPEC silent).
    summary.recheck = await recheckAll(db, ctx, adaptersById, { now, limit, config });
    summary.notes.push(
      `recheck: ${summary.recheck.checked} checked, ${summary.recheck.price_changes.length} price changes, ` +
        `${summary.recheck.gone.length} gone`
    );
    for (const c of summary.recheck.price_changes) {
      summary.notes.push(`price: ${c.ref} ${money(c.from)} -> ${money(c.to)}`);
    }
    summary.errors.push(...summary.recheck.errors.map((e) => `recheck/${e}`));
  } catch (err) {
    summary.errors.push(`recheck: ${String((err && err.message) || err)}`);
  }

  // --- learn ----------------------------------------------------------------
  const runLearn = await optionalPass('./learn.js', 'runLearn');
  if (!runLearn) {
    summary.notes.push('learn: src/scrape/learn.js not available — skipped');
  } else {
    try {
      summary.learn = await runLearn(db, { now });
      const wc = (summary.learn && summary.learn.weight_changes) || [];
      summary.notes.push(
        `learn: ${count(summary.learn.feedback_applied)} feedback applied, ${wc.length} weight changes, ` +
          `${count(summary.learn.red_flags_added)} red flags, ${count(summary.learn.pockets_added)} pockets`
      );
      for (const w of wc) summary.notes.push(`weight: ${w.feature} ${w.from} -> ${w.to} (${w.because})`);
    } catch (err) {
      summary.errors.push(`learn: ${String((err && err.message) || err)}`);
    }
  }

  // --- not seen today -------------------------------------------------------
  // SPEC §6: `gone` comes from the recheck (404 / "no longer available"), never from a
  // listing simply missing from today's index — index pages paginate differently from
  // one day to the next. Absence is only ever a note.
  // `IN ()` is not valid SQL, so a run where every source is disabled counts nothing.
  const staleSince = (cutoff) =>
    ids.length
      ? db
          .prepare(
            `SELECT COUNT(*) AS n FROM properties
              WHERE source IN (${ids.map(() => '?').join(', ')})
                AND (availability IS NULL OR availability <> 'gone')
                AND last_seen < ?`
          )
          .get(...ids, cutoff)
      : { n: 0 };
  const stale = staleSince(now);
  const staleOld = staleSince(new Date(Date.parse(now) - STALE_DAYS * 86_400_000).toISOString());
  summary.not_seen_today = stale.n;
  summary.not_seen_3_days = staleOld.n;
  summary.notes.push(`not_seen_today: ${stale.n} (of which ${staleOld.n} not seen for ${STALE_DAYS}+ days)`);

  // --- unlisted (soft "removed by agent") ------------------------------------
  // A source that ran cleanly this run (not disabled, not blocked, not errored — see
  // `erroredAdapterIds` above) and no longer lists a row it previously saw marks that
  // row `unlisted` once it has gone STALE_DAYS+ without being seen. Manual/fb/inbox
  // rows are never touched: they never appear in `ids`, which only ever holds adapter
  // registry sources (src/scrape/adapters/index.js).
  const cleanSourceIds = ids.filter((id) => !erroredAdapterIds.has(id));
  try {
    summary.unlisted = markUnlisted(db, cleanSourceIds, { now, staleDays: STALE_DAYS });
    if (summary.unlisted.n) summary.notes.push(`unlisted +${summary.unlisted.n}`);
  } catch (err) {
    summary.errors.push(`unlisted: ${String((err && err.message) || err)}`);
  }

  // --- close the run --------------------------------------------------------
  const counts = countsSummary(db);
  summary.counts = counts;
  summary.ms = Date.now() - t0;
  summary.finished_at = nowIso();

  summary.notes.unshift(
    ...ids.map((id) => {
      const p = summary.per_source[id];
      return `${id}: seen ${p.seen}, new ${p.new}, updated ${p.updated}, unchanged ${p.unchanged}, out of band ${p.skipped}`;
    })
  );
  summary.notes.push(`wall time: ${(summary.ms / 1000).toFixed(1)}s`);

  finishRun(db, summary.run_id, {
    seen: summary.seen,
    new: summary.new,
    updated: summary.updated,
    gone: summary.recheck ? summary.recheck.gone.length : 0,
    flagged: counts.flagged ?? null,
    notes: summary.notes,
    errors: summary.errors,
  });

  log(`[scrape] done in ${(summary.ms / 1000).toFixed(1)}s — run #${summary.run_id}`);
  return summary;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** SPEC §11: "prints cards from all target areas without errors". */
export function dryReport(summary) {
  const out = [];
  const line = (s = '') => out.push(s);

  line();
  line('=== DRY RUN (no database writes) ===');
  line(`sources       ${summary.sources.join(', ')}`);
  line(`cards         ${summary.seen}`);
  line();

  line('BY INDEX SLUG (the source\'s own area pages)');
  for (const [slug, n] of Object.entries(summary.by_slug)) line(`  ${pad(slug, 20)}${padL(n, 5)}`);
  line();

  line('BY AREA (canonical, SPEC §7)');
  for (const [area, n] of Object.entries(summary.by_area)) line(`  ${pad(area, 20)}${padL(n, 5)}`);
  line();

  const grouped = new Map();
  for (const c of summary.cards) {
    const a = c.area || 'other';
    if (!grouped.has(a)) grouped.set(a, []);
    grouped.get(a).push(c);
  }
  for (const [area, cards] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
    line(`[${area}] ${cards.length}`);
    for (const c of cards) {
      line(
        `  ${pad(c.ref, 10)}${padL(c.bedrooms == null ? '-' : `${c.bedrooms}BR`, 5)}  ` +
          `${pad(money(c.price_month_idr ?? (c.price_year_idr ? Math.round(c.price_year_idr / 12) : null)), 11)}${pad(c.term || '-', 9)}${c.url}`
      );
    }
    line();
  }

  if (summary.errors.length) {
    line(`ERRORS (${summary.errors.length})`);
    for (const e of summary.errors) line(`  ${e}`);
  } else {
    line('ERRORS  none');
  }
  line('=== END ===');
  return out.join('\n');
}

export function runReport(summary) {
  const out = [];
  const line = (s = '') => out.push(s);
  line();
  line('=== SCRAPE RUN ===');
  line(`run           #${summary.run_id}`);
  line(`sources       ${summary.sources.join(', ')}`);
  line(`seen          ${summary.seen}`);
  line(`new           ${summary.new}`);
  line(`updated       ${summary.updated}`);
  line(`unchanged     ${summary.unchanged}`);
  line(`out of band   ${summary.skipped_out_of_band}`);
  if (summary.counts) {
    line(`in_filter     ${summary.counts.in_filter}`);
    line(`flagged       ${summary.counts.flagged}`);
    line(`gone          ${summary.counts.gone}`);
  }
  line(`wall time     ${(summary.ms / 1000).toFixed(1)}s`);
  line();
  line('NOTES');
  for (const n of summary.notes) line(`  ${n}`);
  line();
  line(`ERRORS (${summary.errors.length})`);
  for (const e of summary.errors) line(`  ${e}`);
  line('=== END ===');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

/**
 * Daily scrape + nightly backup (SPEC §6, §9), node-cron v4. Both run as jobs (src/jobs),
 * in a worker off the web thread. A tick that finds a scrape still running — its own
 * previous one, or one started from the Agent page — is skipped, not queued: the same
 * guard POST /api/scrape answers 409 from. `SCRAPE_CRON=off` disables it.
 * @param {object} opts
 * @param {{run:Function, busy:Function}} opts.jobs the server's job runner (`app.jobs`)
 * @returns {import('node-cron').ScheduledTask|null}
 */
export function scheduleScrape(
  db,
  {
    jobs,
    cron = process.env.SCRAPE_CRON || DEFAULT_CRON,
    tz = process.env.TZ || DEFAULT_TZ,
    log = (...a) => console.log(...a),
    backupDir = process.env.BACKUP_DIR || path.join(ROOT, DEFAULT_BACKUP_DIR),
    keep = Number(process.env.BACKUP_KEEP || DEFAULT_KEEP),
    backup = true,
    scrapeOptions = {},
  } = {}
) {
  if (!cron || cron === 'off') {
    log('[cron] scrape disabled (SCRAPE_CRON=off)');
    return null;
  }
  if (!nodeCron.validate(cron)) throw new Error(`invalid SCRAPE_CRON: ${cron}`);
  if (!jobs) throw new Error('scheduleScrape needs the job runner (src/jobs)');

  const task = nodeCron.schedule(
    cron,
    async () => {
      if (jobs.busy('scrape')) {
        log('[cron] a scrape is still running — skipping this tick');
        return;
      }
      try {
        await jobs.run('scrape', scrapeOptions);
      } catch (err) {
        log(`[cron] scrape failed: ${String((err && err.message) || err)}`);
      }

      if (backup) {
        try {
          const { file, removed } = await jobs.run('backup', { dir: backupDir, keep });
          log(`[cron] backup ${file}${removed.length ? ` (pruned ${removed.length})` : ''}`);
        } catch (err) {
          log(`[cron] backup failed: ${String((err && err.message) || err)}`);
        }
      }
    },
    { timezone: tz, name: 'villa-scrape', noOverlap: true }
  );

  const next = task.getNextRun();
  log(`[cron] scrape scheduled '${cron}' ${tz} — next run ${next ? next.toISOString() : 'unknown'}`);
  return task;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** `--inbox-only`: just the inbox pass (SPEC §6 item 5), for the Agent page's own button. */
export async function runInboxOnly({
  db,
  log = (...a) => console.log(...a),
  cacheDir = process.env.CACHE_DIR || path.join(ROOT, 'data/cache'),
} = {}) {
  const config = getConfig(db);
  const ctx = createCtx({ db, config, log: console, cacheDir, minIntervalMs: 1000 });
  const result = await processInbox(db, ctx, { log });
  log(`[inbox] processed ${result.processed}, done ${result.done}, failed ${result.failed}`);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  loadEnvFile();

  const flags = argv.filter((a) => a.startsWith('--'));
  const valueOf = (name) => {
    const f = flags.find((x) => x.startsWith(`--${name}=`));
    return f ? f.split('=').slice(1).join('=') : null;
  };

  const db = openDb(process.env.DB_PATH || path.join(ROOT, 'data/villa.db'));
  try {
    if (flags.includes('--inbox-only')) {
      const result = await runInboxOnly({ db });
      if (result.failed) process.exitCode = 1;
      return;
    }

    const summary = await runScrape({
      db,
      sources: valueOf('source'),
      dry: flags.includes('--dry'),
      limit: valueOf('limit') ? Number(valueOf('limit')) : null,
      detail: !flags.includes('--no-detail'),
      images: !flags.includes('--no-images'),
    });
    if (!summary.dry) console.log(runReport(summary));
    if (summary.errors.length) process.exitCode = 1;
  } catch (err) {
    // A bad --source or an unreadable db is a user error, not a stack trace.
    console.error(`[scrape] ${String((err && err.message) || err)}`);
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

export default { runScrape, scheduleScrape, main, dryReport, runReport, runInboxOnly };
