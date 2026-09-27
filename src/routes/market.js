// SPEC §4 "Market" — price distributions over scope=all, band prices, excluding `gone`.
// Percentiles are computed in JS (nearest-rank) so the maths is testable without SQLite.

import { getConfig } from '../db.js';
import { DEFAULT_CONFIG, ACTIVE_STATUSES } from '../defaults.js';
import { placeholders, REGION_IDS, regionWhere } from './_common.js';
import { listingsSql } from '../teams.js';

/**
 * Nearest-rank percentiles: the p-th percentile is the value at ceil(p/100 × n).
 * @param {number[]} nums
 * @returns {{n:number, p25:number|null, median:number|null, p75:number|null}}
 */
export function percentiles(nums) {
  const sorted = (nums || []).filter((n) => n != null && Number.isFinite(Number(n))).map(Number).sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { n: 0, p25: null, median: null, p75: null };
  const at = (p) => sorted[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
  return { n, p25: at(25), median: at(50), p75: at(75) };
}

/** Truthiness of a feature on a row, for the "with vs without" split. */
const FEATURE_TESTS = {
  pool: (r) => r.pool === 1,
  garden: (r) => r.garden === 1,
  view: (r) => r.view === 'ocean' || r.view === 'rice',
  aircon: (r) => r.aircon === 1,
  kitchen_full: (r) => r.kitchen_full === 1,
  workspace: (r) => r.workspace === 1,
  joglo: (r) => r.joglo === 1,
  furnished: (r) => r.furnished === 1,
};
const FEATURES = Object.keys(FEATURE_TESTS);

function groupBy(rows, keyOf) {
  const out = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  }
  return out;
}

export default async function marketRoutes(app, opts) {
  const { db } = opts;

  const querystring = { type: 'object', properties: { region: { type: 'string', enum: REGION_IDS } } };

  app.get('/api/market', { onRequest: app.requireUser, schema: { querystring } }, async (request) => {
    const config = getConfig(db);
    const band = config.band || DEFAULT_CONFIG.band;
    // SPEC §17: price statistics are shared facts (read straight off `properties`); the
    // caller's own shortlist below is per-team, so it reads through the overlay.
    const listingsExpr = listingsSql(db, request.user, config);
    // Market's region tab (SPEC §7): every figure below, counts included, is that region's.
    const region = regionWhere(request.query?.region);

    const rows = db
      .prepare(
        `SELECT id, ref, title, area, bedrooms, price_month_idr, scope, status,
                pool, garden, view, aircon, kitchen_full, workspace, joglo, furnished
           FROM properties
          WHERE (availability IS NULL OR availability != 'gone')
            AND price_month_idr IS NOT NULL
            AND price_month_idr >= ? AND price_month_idr <= ?
            AND ${region.sql}`
      )
      .all(band.price_min, band.price_max, ...region.params);

    const priceOf = (r) => r.price_month_idr;

    const by_area = [...groupBy(rows, (r) => r.area).entries()]
      .map(([area, list]) => {
        const p = percentiles(list.map(priceOf));
        return {
          area,
          n: p.n,
          p25: p.p25,
          median: p.median,
          p75: p.p75,
          n_in_filter: list.filter((r) => r.scope === 'in_filter').length,
        };
      })
      .sort((a, b) => b.n - a.n || String(a.area).localeCompare(String(b.area)));

    const by_bedrooms = [...groupBy(rows, (r) => r.bedrooms).entries()]
      .map(([bedrooms, list]) => {
        const p = percentiles(list.map(priceOf));
        return { bedrooms: bedrooms == null ? null : Number(bedrooms), n: p.n, p25: p.p25, median: p.median, p75: p.p75 };
      })
      .sort((a, b) => (a.bedrooms ?? 99) - (b.bedrooms ?? 99));

    const feature_premium = FEATURES.map((feature) => {
      const test = FEATURE_TESTS[feature];
      const withRows = rows.filter(test);
      const withoutRows = rows.filter((r) => !test(r));
      const a = percentiles(withRows.map(priceOf));
      const b = percentiles(withoutRows.map(priceOf));
      return {
        feature,
        median_with: a.median,
        median_without: b.median,
        n_with: a.n,
        n_without: b.n,
      };
    });

    const areaMedian = new Map(by_area.map((a) => [a.area, a.median]));
    const shortlist = db
      .prepare(
        `SELECT id, ref, title, area, price_month_idr FROM ${listingsExpr} AS properties
          WHERE status IN (${placeholders(ACTIVE_STATUSES)})
            AND (availability IS NULL OR availability != 'gone')
            AND ${region.sql}
          ORDER BY id`
      )
      .all(...ACTIVE_STATUSES, ...region.params);

    const shortlist_vs_median = shortlist.map((r) => {
      const median = areaMedian.get(r.area) ?? null;
      const price = r.price_month_idr;
      const delta =
        median && price != null ? Math.round(((price - median) / median) * 1000) / 10 : null;
      return {
        property_id: r.id,
        ref: r.ref,
        title: r.title,
        area: r.area,
        price,
        area_median: median,
        delta_pct: delta,
      };
    });

    // Scope and gone are shared facts; Featured and Shortlist depend on the team's own
    // taps (SPEC §17), so those two are counted through the overlay.
    const summary = db
      .prepare(
        `SELECT SUM(CASE WHEN scope = 'in_filter' THEN 1 ELSE 0 END) AS in_filter,
                SUM(CASE WHEN scope = 'market' THEN 1 ELSE 0 END) AS market,
                SUM(CASE WHEN availability = 'gone' THEN 1 ELSE 0 END) AS gone
           FROM properties WHERE ${region.sql}`
      )
      .get(...region.params);
    const countWhere = (cond) =>
      db.prepare(`SELECT COUNT(*) AS n FROM ${listingsExpr} AS properties WHERE ${cond} AND ${region.sql}`).get(...region.params).n;
    const shortlistCount = countWhere("status = 'shortlist'");
    const flaggedCount = countWhere('flagged = 1');

    return {
      band: { price_min: band.price_min, price_max: band.price_max },
      by_area,
      by_bedrooms,
      feature_premium,
      shortlist_vs_median,
      counts: {
        in_filter: summary.in_filter || 0,
        market: summary.market || 0,
        flagged: flaggedCount,
        shortlist: shortlistCount,
        gone: summary.gone || 0,
      },
    };
  });
}
