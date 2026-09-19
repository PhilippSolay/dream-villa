// GET /api/market/metrics — the deeper market read behind SPEC §4/§5 "Market".
// `/api/market` answers "what does an area cost"; this answers the questions that
// need time, flow and cross-source comparison: is asking price moving, how fast do
// listings disappear, who drops their price, what does a m² cost, how much cheaper
// is a yearly deal, and where the same villa is priced twice.
//
// Shape: one or two SELECTs, all aggregation in JS (the table is ~2k rows, and the
// thirteen groupings below would otherwise be thirteen awkward SQL statements).
// The pure helpers are exported for test/market-metrics.test.js.
//
// Decisions made where SPEC and the task brief were silent:
//  - "non-merged" = `raw.merged_into` absent (src/scrape/dedupe.js writes it on the
//    row it folds away, which is also left `availability='gone'`).
//  - the global filter is: non-merged AND price_month_idr NOT NULL AND price inside
//    `config.band` (same as /api/market). Two metrics deliberately step outside it:
//    `cross_source_gaps` (a merged row is merged by definition, so it can never pass
//    the non-merged test) and nothing else.
//  - "removed" = `availability IN ('gone','unlisted')`. `last_seen` is when the row
//    was last confirmed, so it is the best available proxy for the removal date —
//    said out loud in the response's `notes`.
//  - calendar months and ISO weeks are Asia/Makassar (UTC+8, no DST), like stats.js.
//  - `source_share`'s two share columns are each source's share OF the in-filter (resp.
//    flagged) pool — they sum to ~100 across sources, which is what "where the good
//    ones come from" asks.
//  - `cross_source_gaps.summary.median_gap_pct` is the median of the ABSOLUTE gaps.
//  - a bedrooms count of null (or 0) is dropped from every by-bedrooms grouping
//    rather than given an "unknown" row — the brief's questions are all about 1–4 BR.

import { getConfig, nowIso } from '../db.js';
import { DEFAULT_CONFIG } from '../defaults.js';
import { percentiles } from './market.js';
import { TARGET_AREAS } from '../areas.js';
import { allCandidates } from '../scrape/duplicates.js';

const MAKASSAR_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

const TREND_MONTHS = 6;
const FLOW_WEEKS = 13;
const STALE_DAYS = 30;
const MIN_BUILD_M2 = 20;
const CANDIDATE_MIN_SCORE = 0.6;
const MAX_GAP_PAIRS = 30;
const MAX_DROPS = 20;

const REMOVED_STATES = new Set(['gone', 'unlisted']);
const TARGET_AREA_SET = new Set(TARGET_AREAS);

// ---------------------------------------------------------------------------
// Pure helpers (exported for the tests)
// ---------------------------------------------------------------------------

/** YYYY-MM-DD for an ISO timestamp, in Asia/Makassar. Null for anything unparseable. */
export function makassarDay(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null;
  return new Date(t + MAKASSAR_OFFSET_MS).toISOString().slice(0, 10);
}

/** Calendar month of an ISO timestamp, Makassar-local: 'YYYY-MM'. */
export function monthKey(iso) {
  const d = makassarDay(iso);
  return d ? d.slice(0, 7) : null;
}

/** ISO-8601 week of an ISO timestamp, Makassar-local: 'YYYY-Www' (Monday-based). */
export function isoWeek(iso) {
  const d = makassarDay(iso);
  if (!d) return null;
  const date = new Date(`${d}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  // Shift to the Thursday of this week: that Thursday's year is the ISO week-year.
  const dow = (date.getUTCDay() + 6) % 7; // Mon = 0
  date.setUTCDate(date.getUTCDate() - dow + 3);
  const year = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Thursday = new Date(jan4.getTime() + (3 - jan4Dow) * DAY_MS);
  const week = 1 + Math.round((date.getTime() - week1Thursday.getTime()) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Monthly-price band label: '<30' | '30-40' | '40-50' | '50+' (millions IDR). */
export function priceBand(idr) {
  const v = Number(idr);
  if (idr == null || !Number.isFinite(v)) return null;
  if (v < 30e6) return '<30';
  if (v < 40e6) return '30-40';
  if (v < 50e6) return '40-50';
  return '50+';
}

export const PRICE_BANDS = ['<30', '30-40', '40-50', '50+'];

/** Beach-distance band: '0-1' | '1-2' | '2-4' | '4+' | 'unknown' (km). */
export function beachBand(km) {
  const v = Number(km);
  if (km == null || !Number.isFinite(v)) return 'unknown';
  if (v < 1) return '0-1';
  if (v < 2) return '1-2';
  if (v < 4) return '2-4';
  return '4+';
}

export const BEACH_BANDS = ['0-1', '1-2', '2-4', '4+', 'unknown'];

/** Bedrooms group: '1' | '2' | '3' | '4+'. Null (dropped) for 0/null/negative. */
export function brGroup(bedrooms) {
  const n = Number(bedrooms);
  if (bedrooms == null || !Number.isFinite(n) || n < 1) return null;
  return n >= 4 ? '4+' : String(Math.round(n));
}

export const BR_GROUPS = ['1', '2', '3', '4+'];

const ELECTRICITY_KEY_RE = /electric/i;
const STAFF_KEY_RE = /cleaning|housekeeping|staff/i;
const INCLUDED_VALUE_RE = /included|yes/i;
const NOT_RE = /\bnot\b|\bno\b|excluded/i;

/**
 * Read an `inclusions` blob (Bali Home Immo writes `{"Cleaning Service":"Included",
 * "Electricity":"Not included", …}`) into two tri-state flags: true = stated as
 * included, false = stated but not included, null = the listing never says.
 */
export function inclusionsFlags(inclusions) {
  let obj = inclusions;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      obj = null;
    }
  }
  const out = { electricity_included: null, staff_included: null };
  if (!obj || typeof obj !== 'object') return out;

  const entries = Array.isArray(obj)
    ? obj.map((v) => [String(v ?? ''), String(v ?? '')])
    : Object.entries(obj).map(([k, v]) => [String(k), typeof v === 'string' ? v : v === true ? 'Included' : String(v ?? '')]);

  const test = (keyRe) => {
    let seen = null;
    for (const [k, v] of entries) {
      if (!keyRe.test(k)) continue;
      const included = INCLUDED_VALUE_RE.test(v) && !NOT_RE.test(v);
      if (included) return true; // any "included" line wins
      seen = false;
    }
    return seen;
  };

  out.electricity_included = test(ELECTRICITY_KEY_RE);
  out.staff_included = test(STAFF_KEY_RE);
  return out;
}

/** "Price negotiable", "nego", "bisa nego", "harga nego" — in any of title/description/notes. */
export const negotiableRe = /negotiable|nego\b|bisa nego|harga nego/i;

/** The last `n` Makassar calendar months, oldest first, ending at `today` (YYYY-MM-DD). */
export function lastMonths(n, today) {
  const [y, m] = today.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/** The last `n` ISO weeks, oldest first, ending with the week containing `today`. */
export function lastWeeks(n, today) {
  const end = Date.parse(`${today}T00:00:00Z`);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(isoWeek(new Date(end - i * 7 * DAY_MS).toISOString()));
  return out;
}

/**
 * When a listing becomes available, as a lead bucket relative to `today`.
 * Tolerant: null / '' / 'available' / 'now' / 'immediately' → 'now'; 'from:2026-10-01'
 * and '01/10/2026' are understood too; anything else non-empty → 'unknown'.
 */
export function availabilityBucket(availableFrom, today) {
  const raw = String(availableFrom ?? '').trim();
  if (!raw) return 'now';
  if (/^(available|now|immediate(ly)?|ready|asap)$/i.test(raw)) return 'now';

  let text = raw.replace(/^from:\s*/i, '').trim();
  let iso = null;
  const ymd = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  const dmy = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (ymd) iso = `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  else if (dmy) iso = `${dmy[3]}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`;
  else {
    const t = Date.parse(text);
    if (Number.isFinite(t)) iso = new Date(t).toISOString().slice(0, 10);
  }
  if (!iso) return /available|now/i.test(text) ? 'now' : 'unknown';

  const days = Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  if (!Number.isFinite(days)) return 'unknown';
  if (days <= 0) return 'now';
  if (days <= 31) return 'within_1m';
  if (days <= 92) return 'in_1_3m';
  return 'later';
}

export const LEAD_BUCKETS = ['now', 'within_1m', 'in_1_3m', 'later', 'unknown'];

// ---------------------------------------------------------------------------
// Small internal utilities
// ---------------------------------------------------------------------------

function safeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function push(map, key, value) {
  let list = map.get(key);
  if (!list) map.set(key, (list = []));
  list.push(value);
  return list;
}

function round1(v) {
  return v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10;
}

function medianOf(nums) {
  return percentiles(nums).median;
}

function dayDiff(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((b - a) / DAY_MS));
}

const isRemoved = (r) => REMOVED_STATES.has(r.availability);

// ---------------------------------------------------------------------------
// The thirteen metrics
// ---------------------------------------------------------------------------

function buildPriceTrend(base, today) {
  const months = lastMonths(TREND_MONTHS, today);
  const monthSet = new Set(months);
  const buckets = new Map(); // `${month}|${area}|${br}` -> prices

  for (const r of base) {
    const month = monthKey(r.first_seen);
    if (!month || !monthSet.has(month)) continue;
    const br = brGroup(r.bedrooms);
    if (!br) continue;
    if (!TARGET_AREA_SET.has(r.area)) continue;
    push(buckets, `${month}|${r.area}|${br}`, r.price_month_idr);
    push(buckets, `${month}|all|${br}`, r.price_month_idr);
  }

  const out = [];
  for (const [key, prices] of buckets) {
    const [month, area, br] = key.split('|');
    const p = percentiles(prices);
    out.push({ month, area, br, n: p.n, median: p.median, p25: p.p25, p75: p.p75 });
  }
  out.sort(
    (a, b) =>
      a.month.localeCompare(b.month) ||
      BR_GROUPS.indexOf(a.br) - BR_GROUPS.indexOf(b.br) ||
      (a.area === 'all' ? -1 : b.area === 'all' ? 1 : a.area.localeCompare(b.area))
  );
  return { months, rows: out };
}

function buildSupplyFlow(base, today) {
  const weeks = lastWeeks(FLOW_WEEKS, today);
  const weekSet = new Set(weeks);
  const counts = new Map(); // `${week}|${area}` -> {new, removed}
  const areas = new Set();

  const bump = (week, area, field) => {
    if (!week || !weekSet.has(week)) return;
    areas.add(area);
    for (const a of [area, 'all']) {
      const key = `${week}|${a}`;
      let cell = counts.get(key);
      if (!cell) counts.set(key, (cell = { new: 0, removed: 0 }));
      cell[field] += 1;
    }
  };

  for (const r of base) {
    bump(isoWeek(r.first_seen), r.area || 'other', 'new');
    if (isRemoved(r)) bump(isoWeek(r.last_seen), r.area || 'other', 'removed');
  }

  const areaList = ['all', ...[...areas].sort()];
  const rows = [];
  for (const week of weeks) {
    for (const area of areaList) {
      const cell = counts.get(`${week}|${area}`) || { new: 0, removed: 0 };
      rows.push({ week, area, new: cell.new, removed: cell.removed, net: cell.new - cell.removed });
    }
  }
  return { weeks, areas: areaList, rows };
}

function buildTimeOnMarket(base, nowMs) {
  const removed = base.filter(isRemoved);
  const byAreaDays = new Map();
  const byBandDays = new Map();

  for (const r of removed) {
    const days = dayDiff(r.first_seen, r.last_seen);
    if (days == null) continue;
    push(byAreaDays, r.area || 'other', days);
    const band = priceBand(r.price_month_idr);
    if (band) push(byBandDays, band, days);
  }

  const by_area = [...byAreaDays.entries()]
    .map(([area, list]) => {
      const p = percentiles(list);
      return { area, n: p.n, median_days: p.median, p25: p.p25, p75: p.p75 };
    })
    .sort((a, b) => b.n - a.n || a.area.localeCompare(b.area));

  const by_price_band = PRICE_BANDS.map((band) => {
    const p = percentiles(byBandDays.get(band) || []);
    return { band, n: p.n, median_days: p.median };
  });

  const live = base.filter((r) => !isRemoved(r));
  const n_live_over_30d = live.filter((r) => {
    const t = Date.parse(r.first_seen);
    return Number.isFinite(t) && nowMs - t > STALE_DAYS * DAY_MS;
  }).length;

  return {
    by_area,
    by_price_band,
    stale_share: {
      n_live: live.length,
      n_live_over_30d,
      share: live.length ? Math.round((n_live_over_30d / live.length) * 1000) / 1000 : null,
    },
  };
}

function buildPriceDrops(base, days, nowMs) {
  const cutoff = nowMs - days * DAY_MS;
  const drops = [];

  for (const r of base) {
    const history = safeJson(r.price_history);
    if (!Array.isArray(history) || history.length < 2) continue;
    for (let i = 1; i < history.length; i++) {
      const prev = Number(history[i - 1] && history[i - 1].price_month_idr);
      const cur = Number(history[i] && history[i].price_month_idr);
      if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur >= prev) continue;
      const date = String((history[i] && history[i].date) || '').slice(0, 10);
      const t = Date.parse(`${date}T00:00:00Z`);
      if (!Number.isFinite(t) || t < cutoff) continue;
      drops.push({
        id: r.id, ref: r.ref, title: r.title, area: r.area,
        from: prev, to: cur, pct: round1(((prev - cur) / prev) * 100), date,
      });
    }
  }

  drops.sort((a, b) => b.date.localeCompare(a.date) || b.pct - a.pct);
  const avg = drops.length ? drops.reduce((sum, d) => sum + d.pct, 0) / drops.length : null;
  return { count: drops.length, avg_pct: round1(avg), latest: drops.slice(0, MAX_DROPS) };
}

function buildPerM2(base) {
  const byArea = new Map();
  const all = { perM2: [], perBr: [], price: [] };

  for (const r of base) {
    if (!(Number(r.build_m2) > MIN_BUILD_M2)) continue;
    let cell = byArea.get(r.area || 'other');
    if (!cell) byArea.set(r.area || 'other', (cell = { perM2: [], perBr: [], price: [] }));
    const perM2 = r.price_month_idr / Number(r.build_m2);
    cell.perM2.push(perM2);
    all.perM2.push(perM2);
    cell.price.push(r.price_month_idr);
    all.price.push(r.price_month_idr);
    if (Number(r.bedrooms) > 0) {
      const perBr = r.price_month_idr / Number(r.bedrooms);
      cell.perBr.push(perBr);
      all.perBr.push(perBr);
    }
  }

  const shape = (area, cell) => ({
    area,
    n: cell.perM2.length,
    median_per_build_m2: cell.perM2.length ? Math.round(medianOf(cell.perM2)) : null,
    median_per_bedroom: cell.perBr.length ? Math.round(medianOf(cell.perBr)) : null,
    median_price: medianOf(cell.price),
  });

  return {
    by_area: [...byArea.entries()].map(([area, cell]) => shape(area, cell)).sort((a, b) => b.n - a.n || a.area.localeCompare(b.area)),
    all: shape('all', all),
  };
}

/**
 * Yearly vs monthly. A row whose monthly price was *derived* from the yearly one
 * (store/normalise divides by 12 when only a yearly price exists) would always show a
 * 0 % discount and drown the real ones, so only `term = 'both'` rows count — that is
 * the marker this schema has for "the listing quotes both prices".
 */
function buildYearlyDiscount(base) {
  const ratios = [];
  const byArea = new Map();

  for (const r of base) {
    if (r.term !== 'both') continue;
    const yearly = Number(r.price_year_idr);
    const monthly = Number(r.price_month_idr);
    if (!Number.isFinite(yearly) || !Number.isFinite(monthly) || yearly <= 0 || monthly <= 0) continue;
    const ratio = yearly / 12 / monthly;
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 5) continue;
    ratios.push(ratio);
    push(byArea, r.area || 'other', ratio);
  }

  const pct = (list) => (list.length ? round1((1 - medianOf(list)) * 100) : null);
  return {
    n: ratios.length,
    median_discount_pct: pct(ratios),
    by_area: [...byArea.entries()]
      .map(([area, list]) => ({ area, n: list.length, median_discount_pct: pct(list) }))
      .sort((a, b) => b.n - a.n || a.area.localeCompare(b.area)),
  };
}

function buildBeachPremium(base) {
  const buckets = new Map();
  for (const r of base) {
    const br = brGroup(r.bedrooms);
    if (!br) continue;
    push(buckets, `${br}|${beachBand(r.beach_km)}`, r.price_month_idr);
  }
  const out = [];
  for (const br of BR_GROUPS) {
    for (const band of BEACH_BANDS) {
      const list = buckets.get(`${br}|${band}`) || [];
      if (!list.length) continue;
      out.push({ br, band, n: list.length, median: medianOf(list) });
    }
  }
  return out;
}

function buildInclusionsPremium(base) {
  const split = { electricity: { with: [], without: [] }, staff: { with: [], without: [] } };
  for (const r of base) {
    if (r.inclusions == null || r.inclusions === '') continue;
    const flags = inclusionsFlags(r.inclusions);
    if (flags.electricity_included === true) split.electricity.with.push(r.price_month_idr);
    else if (flags.electricity_included === false) split.electricity.without.push(r.price_month_idr);
    if (flags.staff_included === true) split.staff.with.push(r.price_month_idr);
    else if (flags.staff_included === false) split.staff.without.push(r.price_month_idr);
  }
  const shape = (s) => ({
    median_with: medianOf(s.with), median_without: medianOf(s.without),
    n_with: s.with.length, n_without: s.without.length,
  });
  return { electricity: shape(split.electricity), staff: shape(split.staff) };
}

function buildCrossSourceGaps(db, allRows) {
  const byId = new Map(allRows.map((r) => [r.id, r]));
  const pairs = [];
  const seen = new Set();
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const side = (r) => ({ id: r.id, ref: r.ref, source: r.source, price: r.price_month_idr, title: r.title, area: r.area });
  const addPair = (a, b, kind) => {
    if (!a || !b || a.id === b.id) return;
    if (a.price_month_idr == null || b.price_month_idr == null || !(Number(a.price_month_idr) > 0)) return;
    const key = pairKey(a.id, b.id);
    if (seen.has(key)) return;
    seen.add(key);
    const gap = ((b.price_month_idr - a.price_month_idr) / a.price_month_idr) * 100;
    pairs.push({ a: side(a), b: side(b), gap_pct: round1(gap), kind });
  };

  // (a) rows this repo's dedupe folded away — the same villa, by construction.
  for (const row of allRows) {
    if (row.merged_into == null) continue;
    addPair(byId.get(Number(row.merged_into)), row, 'merged');
  }

  // (b) near misses the duplicate scorer is fairly sure about, across two sources.
  let candidates = [];
  try {
    candidates = allCandidates(db, { minScore: CANDIDATE_MIN_SCORE });
  } catch {
    candidates = [];
  }
  for (const c of candidates) {
    const a = byId.get(c.a);
    const b = byId.get(c.b);
    if (!a || !b || a.source === b.source) continue;
    addPair(a, b, 'candidate');
  }

  pairs.sort((x, y) => Math.abs(y.gap_pct) - Math.abs(x.gap_pct) || x.a.id - y.a.id);
  const gaps = pairs.map((p) => Math.abs(p.gap_pct));
  return {
    pairs: pairs.slice(0, MAX_GAP_PAIRS),
    summary: { n_pairs: pairs.length, median_gap_pct: gaps.length ? round1(medianOf(gaps)) : null },
  };
}

function buildSourceShare(base) {
  const bySource = new Map();
  for (const r of base) {
    let cell = bySource.get(r.source);
    if (!cell) bySource.set(r.source, (cell = { listings: 0, in_filter: 0, flagged: 0 }));
    cell.listings += 1;
    if (r.scope === 'in_filter') cell.in_filter += 1;
    if (r.flagged === 1) cell.flagged += 1;
  }
  const totalInFilter = [...bySource.values()].reduce((a, c) => a + c.in_filter, 0);
  const totalFlagged = [...bySource.values()].reduce((a, c) => a + c.flagged, 0);
  return [...bySource.entries()]
    .map(([source, c]) => ({
      source, listings: c.listings, in_filter: c.in_filter, flagged: c.flagged,
      share_in_filter_pct: totalInFilter ? round1((c.in_filter / totalInFilter) * 100) : null,
      share_flagged_pct: totalFlagged ? round1((c.flagged / totalFlagged) * 100) : null,
    }))
    .sort((a, b) => b.listings - a.listings || a.source.localeCompare(b.source));
}

function buildBudgetBands(base, config) {
  const min = Number(config.budget_min ?? DEFAULT_CONFIG.budget_min);
  const max = Number(config.budget_max ?? DEFAULT_CONFIG.budget_max);
  const m = (v) => Math.round(v / 1e6);
  const edges = [
    [min, 30e6], [30e6, 40e6], [40e6, max], [max, max + 10e6],
  ];
  const bands = edges.map(([lo, hi]) => `${m(lo)}-${m(hi)}`);
  const stretch_band = bands[bands.length - 1];

  const byArea = new Map();
  for (const r of base) {
    if (isRemoved(r)) continue;
    const br = Number(r.bedrooms);
    if (!(br >= 1 && br <= 3)) continue;
    const price = r.price_month_idr;
    const idx = edges.findIndex(([lo, hi], i) => price >= lo && (i === edges.length - 1 ? price <= hi : price < hi));
    if (idx === -1) continue;
    let cell = byArea.get(r.area || 'other');
    if (!cell) byArea.set(r.area || 'other', (cell = Object.fromEntries(bands.map((b) => [b, 0]))));
    cell[bands[idx]] += 1;
  }

  return {
    bands,
    stretch_band,
    by_area: [...byArea.entries()]
      .map(([area, counts]) => ({ area, counts, n: Object.values(counts).reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.n - a.n || a.area.localeCompare(b.area)),
  };
}

function buildAvailabilityLead(base, today) {
  const totals = Object.fromEntries(LEAD_BUCKETS.map((b) => [b, 0]));
  const byArea = new Map();
  for (const r of base) {
    if (isRemoved(r)) continue;
    const bucket = availabilityBucket(r.available_from ?? (r.availability === 'available' ? 'available' : r.availability), today);
    totals[bucket] += 1;
    let cell = byArea.get(r.area || 'other');
    if (!cell) byArea.set(r.area || 'other', (cell = Object.fromEntries(LEAD_BUCKETS.map((b) => [b, 0]))));
    cell[bucket] += 1;
  }
  return {
    ...totals,
    by_area: [...byArea.entries()]
      .map(([area, counts]) => ({ area, ...counts, n: LEAD_BUCKETS.reduce((a, b) => a + counts[b], 0) }))
      .sort((a, b) => b.n - a.n || a.area.localeCompare(b.area)),
  };
}

function buildNegotiableShare(base) {
  const byArea = new Map();
  for (const r of base) {
    if (isRemoved(r)) continue;
    let cell = byArea.get(r.area || 'other');
    if (!cell) byArea.set(r.area || 'other', (cell = { n_live: 0, n_negotiable: 0 }));
    cell.n_live += 1;
    const text = `${r.title || ''} ${r.description || ''} ${r.notes || ''}`;
    if (negotiableRe.test(text)) cell.n_negotiable += 1;
  }
  return [...byArea.entries()]
    .map(([area, c]) => ({
      area, n_live: c.n_live, n_negotiable: c.n_negotiable,
      share_pct: c.n_live ? round1((c.n_negotiable / c.n_live) * 100) : null,
    }))
    .sort((a, b) => b.n_live - a.n_live || a.area.localeCompare(b.area));
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const SELECT_COLUMNS = `id, key, ref, source, url, title, description, notes, area, sub_area,
       bedrooms, price_month_idr, price_year_idr, term, build_m2, beach_km, inclusions,
       availability, available_from, first_seen, last_seen, price_history,
       scope, flagged, raw`;

export default async function marketMetricsRoutes(app, opts) {
  const { db } = opts;
  const querystring = {
    type: 'object',
    additionalProperties: false,
    properties: { days: { type: 'integer', minimum: 1, maximum: 365 } },
  };

  app.get('/api/market/metrics', { onRequest: app.requireUser, schema: { querystring } }, async (request) => {
    const days = request.query.days ?? 90;
    const config = getConfig(db);
    const band = config.band || DEFAULT_CONFIG.band;
    const now = nowIso();
    const nowMs = Date.parse(now);
    const today = makassarDay(now);

    const allRows = db.prepare(`SELECT ${SELECT_COLUMNS} FROM properties`).all().map((row) => {
      const raw = safeJson(row.raw);
      return { ...row, merged_into: raw && !Array.isArray(raw) ? (raw.merged_into ?? null) : null };
    });

    // The shared filter: not folded into another row, priced, inside the band.
    const base = allRows.filter(
      (r) =>
        r.merged_into == null &&
        r.price_month_idr != null &&
        r.price_month_idr >= band.price_min &&
        r.price_month_idr <= band.price_max
    );

    return {
      days,
      band: { price_min: band.price_min, price_max: band.price_max },
      n_rows: base.length,
      price_trend: buildPriceTrend(base, today),
      supply_flow: buildSupplyFlow(base, today),
      time_on_market: buildTimeOnMarket(base, nowMs),
      price_drops: buildPriceDrops(base, days, nowMs),
      per_m2: buildPerM2(base),
      yearly_discount: buildYearlyDiscount(base),
      beach_premium: buildBeachPremium(base),
      inclusions_premium: buildInclusionsPremium(base),
      cross_source_gaps: buildCrossSourceGaps(db, allRows),
      source_share: buildSourceShare(base),
      budget_bands: buildBudgetBands(base, config),
      availability_lead: buildAvailabilityLead(base, today),
      negotiable_share: buildNegotiableShare(base),
      notes: {
        removed:
          "A listing counts as removed when availability is 'gone' or 'unlisted'. `last_seen` is when it was last confirmed on the source, so it is used as the removal date — the real one is somewhere between that day and the next scrape.",
        base: 'All figures except cross_source_gaps run over non-merged, priced listings inside the aggregation band.',
        yearly_discount: "Only listings whose term is 'both' count; a monthly price derived from a yearly one would always show 0 %.",
        source_share: 'The two share columns are each source’s share of the in-filter (resp. flagged) pool, so they add up to 100 %.',
      },
      generated_at: now,
    };
  });
}
