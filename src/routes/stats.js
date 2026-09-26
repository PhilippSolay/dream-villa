// GET /api/stats?days=N for the Market page's "Overview" section (no SPEC section yet).
// Pure/testable helpers (date bucketing, histograms, the cron -> next-run guess) are
// exported for unit tests; the route below wires them to SQL.
//
// Decisions made where SPEC/the task brief were silent:
//  - a "day" is a calendar day in Asia/Makassar (UTC+8, fixed offset, no DST), via
//    SQLite's `date(col, '+8 hours')` — matches public/lib/ui.js's makassarDate().
//  - pipeline counts every row by its `status` regardless of availability, plus a
//    separate `gone` line (availability='gone') — a villa can go gone from any status.
//  - fit/beach histograms and by_source's median_price run over non-gone rows; fit and
//    beach are additionally restricted to scope='in_filter' per SPEC §2.
//  - next_run only understands a plain "M H * * *" daily cron (the only shape SPEC §9
//    uses); anything else returns null rather than guessing.

import { getConfig, nowIso } from '../db.js';
import { STATUSES, DEFAULT_CONFIG } from '../defaults.js';
import { percentiles } from './market.js';
import { userNames } from './_common.js';
import { listingsSql, sameTeamSql, teamMemberIds } from '../teams.js';

const MAKASSAR_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Makassar = UTC+8, no DST.
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for test/stats.test.js)
// ---------------------------------------------------------------------------

/** `days` consecutive YYYY-MM-DD strings (Makassar-local), ending at `endDateStr`. */
export function dateRange(days, endDateStr) {
  const end = new Date(`${endDateStr}T00:00:00Z`);
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(end.getTime() - i * DAY_MS).toISOString().slice(0, 10));
  return out;
}

/** Today's date in Asia/Makassar, as YYYY-MM-DD. */
export function todayMakassar(now = new Date()) {
  return new Date(now.getTime() + MAKASSAR_OFFSET_MS).toISOString().slice(0, 10);
}

/** Zero-fill a `days`-long daily series from per-metric date->count Maps. */
export function fillDays(days, endDateStr, byDate) {
  const metrics = ['new', 'gone', 'price_changes', 'runs', 'seen'];
  return dateRange(days, endDateStr).map((date) => {
    const row = { date };
    for (const m of metrics) row[m] = (byDate[m] && byDate[m].get(date)) || 0;
    return row;
  });
}

/** date -> count map from `[{d, n}]` SQL rows (d is null for unset timestamps). */
function toDateMap(rows) {
  const map = new Map();
  for (const r of rows) if (r.d) map.set(r.d, Number(r.n) || 0);
  return map;
}

/**
 * price_history is `[{date, price_month_idr}]`, oldest first (store.js writes one
 * entry per insert/update). The first entry is the starting price, not a "change",
 * so a price-change day is any entry at index >= 1.
 */
export function priceChangeCounts(historyJsonList) {
  const counts = new Map();
  for (const raw of historyJsonList) {
    if (!raw) continue;
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(arr) || arr.length < 2) continue;
    for (const entry of arr.slice(1)) {
      const d = String((entry && entry.date) || '').slice(0, 10);
      if (d) counts.set(d, (counts.get(d) || 0) + 1);
    }
  }
  return counts;
}

const FIT_EDGES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];

/** Fit-score histogram: 0-9, 10-19, ... 80-89, 90-100 (SPEC §2's 0-100 scale). */
export function bucketiseFit(scores) {
  const buckets = FIT_EDGES.map((lo, i) => ({ bucket: i === FIT_EDGES.length - 1 ? '90-100' : `${lo}-${lo + 9}`, n: 0 }));
  for (const raw of scores) {
    const v = Number(raw);
    if (raw == null || !Number.isFinite(v)) continue;
    buckets[Math.min(9, Math.floor(Math.max(0, Math.min(100, v)) / 10))].n += 1;
  }
  return buckets;
}

const BEACH_BUCKETS = [
  { bucket: '0-1', test: (k) => k >= 0 && k < 1 },
  { bucket: '1-2', test: (k) => k >= 1 && k < 2 },
  { bucket: '2-3', test: (k) => k >= 2 && k < 3 },
  { bucket: '3-4', test: (k) => k >= 3 && k < 4 },
  { bucket: '4-6', test: (k) => k >= 4 && k < 6 },
  { bucket: '6+', test: (k) => k >= 6 },
];

/** Beach-distance histogram in km, plus an "unknown" bucket for null beach_km. */
export function bucketiseBeach(kms) {
  const buckets = [...BEACH_BUCKETS.map((b) => ({ bucket: b.bucket, n: 0 })), { bucket: 'unknown', n: 0 }];
  for (const raw of kms) {
    const v = Number(raw);
    if (raw == null || !Number.isFinite(v)) {
      buckets[buckets.length - 1].n += 1;
      continue;
    }
    const hit = BEACH_BUCKETS.findIndex((b) => b.test(v));
    buckets[hit === -1 ? buckets.length - 1 : hit].n += 1;
  }
  return buckets;
}

/**
 * Next occurrence of a plain daily "M H * * *" cron expression, in Asia/Makassar, as
 * an ISO (UTC) string. Any other shape (ranges, steps, non-`*` day fields) returns
 * null rather than guessing — see the file header note on not adding a dependency.
 */
export function nextDailyRun(cronExpr, from = new Date()) {
  if (typeof cronExpr !== 'string') return null;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*' || dow !== '*') return null;
  const m = Number(min);
  const h = Number(hour);
  if (!Number.isInteger(m) || !Number.isInteger(h) || m < 0 || m > 59 || h < 0 || h > 23) return null;

  const localNow = new Date(from.getTime() + MAKASSAR_OFFSET_MS);
  const localMidnight = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
  let candidate = localMidnight + h * 3600000 + m * 60000;
  if (candidate <= localNow.getTime()) candidate += DAY_MS;
  return new Date(candidate - MAKASSAR_OFFSET_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export default async function statsRoutes(app, { db, env = process.env }) {
  const auth = { onRequest: app.requireUser };
  const querystring = { type: 'object', additionalProperties: false, properties: { days: { type: 'integer', minimum: 1, maximum: 365 } } };

  app.get('/api/stats', { ...auth, schema: { querystring } }, async (request) => {
    const user = request.user;
    const days = request.query.days ?? 30;
    const today = todayMakassar();
    const windowStart = new Date(Date.now() - days * DAY_MS).toISOString();
    // Team 17: `status`/`flagged`/`assessed` are per-team (listingsSql overlays them for
    // anyone off the home team); everything else on `properties` is a shared scraper fact.
    const listingsExpr = listingsSql(db, user);

    // pipeline
    const byStatus = new Map(
      db.prepare(`SELECT status, COUNT(*) AS n FROM ${listingsExpr} AS properties GROUP BY status`).all().map((r) => [r.status, r.n])
    );
    // One `gone` bucket: the scraper's detection (availability) and the person-set status.
    const goneCount = db
      .prepare(`SELECT COUNT(*) AS n FROM ${listingsExpr} AS properties WHERE availability = 'gone' OR status = 'gone'`)
      .get().n;
    const pipeline = [
      ...STATUSES.filter((status) => status !== 'gone').map((status) => ({ status, n: byStatus.get(status) || 0 })),
      { status: 'gone', n: goneCount },
    ];

    // daily
    const newByDate = toDateMap(db.prepare("SELECT date(first_seen, '+8 hours') AS d, COUNT(*) AS n FROM properties GROUP BY d").all());
    // Dated by `removed_at` (when we found out it was gone), falling back to `last_seen`
    // for rows removed before migration 006 — which is what `last_seen` meant then.
    const goneByDate = toDateMap(
      db
        .prepare(
          `SELECT date(COALESCE(removed_at, last_seen), '+8 hours') AS d, COUNT(*) AS n
             FROM properties WHERE availability = 'gone' GROUP BY d`
        )
        .all()
    );
    const runsByDate = toDateMap(
      db.prepare("SELECT date(finished_at, '+8 hours') AS d, COUNT(*) AS n FROM runs WHERE finished_at IS NOT NULL GROUP BY d").all()
    );
    const seenByDate = toDateMap(
      db.prepare("SELECT date(finished_at, '+8 hours') AS d, SUM(seen) AS n FROM runs WHERE finished_at IS NOT NULL GROUP BY d").all()
    );
    const priceByDate = priceChangeCounts(
      db.prepare('SELECT price_history FROM properties WHERE price_history IS NOT NULL').all().map((r) => r.price_history)
    );
    const daily = fillDays(days, today, { new: newByDate, gone: goneByDate, price_changes: priceByDate, runs: runsByDate, seen: seenByDate });

    // by_source — `flagged` is per-team (the overlay), the rest are shared scraper facts.
    const sourceCounts = db
      .prepare(
        `SELECT source, COUNT(*) AS listings,
                SUM(CASE WHEN scope = 'in_filter' THEN 1 ELSE 0 END) AS in_filter,
                SUM(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) AS flagged,
                SUM(CASE WHEN availability = 'gone' THEN 1 ELSE 0 END) AS gone
           FROM ${listingsExpr} AS properties GROUP BY source ORDER BY listings DESC`
      )
      .all();
    const pricesBySource = new Map();
    for (const row of db
      .prepare("SELECT source, price_month_idr FROM properties WHERE price_month_idr IS NOT NULL AND (availability IS NULL OR availability != 'gone')")
      .all()) {
      if (!pricesBySource.has(row.source)) pricesBySource.set(row.source, []);
      pricesBySource.get(row.source).push(row.price_month_idr);
    }
    const by_source = sourceCounts.map((r) => ({
      source: r.source, listings: r.listings, in_filter: r.in_filter, flagged: r.flagged, gone: r.gone,
      median_price: percentiles(pricesBySource.get(r.source) || []).median,
    }));

    // by_area
    const areaCounts = db
      .prepare(
        `SELECT area, COUNT(*) AS listings,
                SUM(CASE WHEN scope = 'in_filter' THEN 1 ELSE 0 END) AS in_filter,
                SUM(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) AS flagged
           FROM ${listingsExpr} AS properties GROUP BY area ORDER BY listings DESC`
      )
      .all();
    // "Viewed" is activity (SPEC §17: a viewing is visible to its own team only), so it
    // is scoped the same way ratings/feedback below are — nobody's visit inflates
    // another team's numbers.
    const viewedByArea = new Map(
      db
        .prepare(
          `SELECT p.area AS area, COUNT(DISTINCT p.id) AS n
             FROM ${listingsExpr} AS p JOIN viewings v ON v.property_id = p.id
            WHERE ${sameTeamSql(user, 'v.by')}
            GROUP BY p.area`
        )
        .all()
        .map((r) => [r.area, r.n])
    );
    const shortlistedByArea = new Map(
      db
        .prepare(`SELECT area, COUNT(*) AS n FROM ${listingsExpr} AS properties WHERE status = 'shortlist' GROUP BY area`)
        .all()
        .map((r) => [r.area, r.n])
    );
    const by_area = areaCounts.map((r) => ({
      area: r.area, listings: r.listings, in_filter: r.in_filter, flagged: r.flagged,
      viewed: viewedByArea.get(r.area) || 0, shortlisted: shortlistedByArea.get(r.area) || 0,
    }));

    // histograms — in_filter, non-gone
    const inFilterRows = db
      .prepare("SELECT fit_score, beach_km FROM properties WHERE scope = 'in_filter' AND (availability IS NULL OR availability != 'gone')")
      .all();
    const fit_histogram = bucketiseFit(inFilterRows.map((r) => r.fit_score));
    const beach_histogram = bucketiseBeach(inFilterRows.map((r) => r.beach_km));

    // activity — a team's own ratings/viewings/feedback/agent_info only (sameTeamSql on
    // `by`); another team's taps never move Philipp's numbers, and his never move theirs.
    const teamFilter = sameTeamSql(user, 'by');
    const countSince = (table) =>
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE created_at >= ? AND ${teamFilter}`).get(windowStart).n;
    const names = userNames(db);
    const byUser = new Map();
    const ensure = (id) => {
      if (!byUser.has(id)) byUser.set(id, { name: names.get(id) || `user ${id}`, ratings: 0, viewings: 0, feedback: 0 });
      return byUser.get(id);
    };
    for (const r of db.prepare(`SELECT by, COUNT(*) AS n FROM ratings WHERE created_at >= ? AND ${teamFilter} GROUP BY by`).all(windowStart))
      ensure(r.by).ratings = r.n;
    for (const r of db.prepare(`SELECT by, COUNT(*) AS n FROM viewings WHERE created_at >= ? AND ${teamFilter} GROUP BY by`).all(windowStart))
      ensure(r.by).viewings = r.n;
    for (const r of db.prepare(`SELECT by, COUNT(*) AS n FROM feedback WHERE created_at >= ? AND ${teamFilter} GROUP BY by`).all(windowStart))
      ensure(r.by).feedback = r.n;
    const userIds = teamMemberIds(db, user);
    const by_user = [...userIds, ...byUser.keys()].filter((id, i, arr) => arr.indexOf(id) === i).map(ensure);
    const avg_ratings = db
      .prepare(`SELECT feature, AVG(score) AS avg, COUNT(*) AS n FROM ratings WHERE ${teamFilter} GROUP BY feature`)
      .all()
      .map((r) => ({ feature: r.feature, avg: Math.round(r.avg * 10) / 10, n: r.n }));

    // last_run / next_run
    const lastRunRow = db
      .prepare(
        `SELECT kind, started_at, finished_at, seen, new, updated, gone, flagged
           FROM runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`
      )
      .get();
    const last_run = lastRunRow && {
      kind: lastRunRow.kind, finished_at: lastRunRow.finished_at, seen: lastRunRow.seen, new: lastRunRow.new,
      updated: lastRunRow.updated, gone: lastRunRow.gone, flagged: lastRunRow.flagged,
      duration_s: Math.round((new Date(lastRunRow.finished_at) - new Date(lastRunRow.started_at)) / 1000),
    };
    const next_run = nextDailyRun(env.SCRAPE_CRON || '0 6 * * *');
    const flag_threshold = getConfig(db).flag_threshold ?? DEFAULT_CONFIG.flag_threshold;

    return {
      pipeline, daily, by_source, by_area, fit_histogram, beach_histogram, flag_threshold,
      activity: { ratings: countSince('ratings'), viewings: countSince('viewings'), feedback: countSince('feedback'), agent_info: countSince('agent_info'), by_user, avg_ratings },
      last_run, next_run, generated_at: nowIso(),
    };
  });
}
