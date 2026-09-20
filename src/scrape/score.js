// SPEC §2 — band, hard filters, fit score, flag rule. Pure functions over a row + config.
// Nothing in here touches the database.

import { AREAS } from '../areas.js';
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS } from '../defaults.js';

const isTrue = (v) => v === true || v === 1;
const isUnknown = (v) => v === null || v === undefined;

/** SPEC's table rounds 15/2 down to 7, 12/2 to 6, 10/2 to 5, 8/2 to 4 — i.e. floor. */
const half = (w) => Math.floor(w / 2);

/** view worth 70 % of the weight (SPEC: 10 → 7). */
const VIEW_PARTIAL = 0.7;
const PARTIAL_VIEWS = new Set(['rice', 'river', 'jungle']);
const LOW_PRIORITY_PENALTY = 10;
const BEACH_FULL_KM = 1;

function asArray(redFlags) {
  if (Array.isArray(redFlags)) return [...redFlags];
  if (typeof redFlags === 'string' && redFlags.trim()) {
    try {
      const parsed = JSON.parse(redFlags);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * The aggregation band — what the scraper keeps at all (SPEC §2).
 * Unknown bedrooms or an unknown price fail the band.
 */
export function inBand(row, config = DEFAULT_CONFIG) {
  const band = config.band || DEFAULT_CONFIG.band;
  const areas = config.areas || DEFAULT_CONFIG.areas;
  const { bedrooms, price_month_idr: price, area } = row || {};

  if (bedrooms == null || bedrooms < band.bedrooms_min || bedrooms > band.bedrooms_max) return false;
  if (price == null || price < band.price_min || price > band.price_max) return false;
  if (!area || area === 'other' || !areas.includes(area)) return false;
  return true;
}

/**
 * SPEC §2 hard filters. Beach distance is not one of them (soft, see fitScore); an unknown
 * distance is recorded in `unknowns` so the pin step can revisit it.
 * @returns {{pass:boolean, fails:string[], unknowns:string[]}}
 */
export function hardFilters(row, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const r = row || {};
  const fails = [];
  const unknowns = [];

  const bedrooms = r.bedrooms;
  const extra = r.extra_rooms || 0;
  if (bedrooms == null || bedrooms < 1 || bedrooms + extra < 2 || bedrooms > 3) fails.push('rooms');

  const price = r.price_month_idr;
  if (price == null || price < cfg.budget_min || price > cfg.budget_max) fails.push('budget');

  if (!r.area || !cfg.areas.includes(r.area)) fails.push('area');

  // Beach distance is a SOFT filter (Philipp, 2026-09-17): it scores, it never excludes.
  if (r.beach_km == null) unknowns.push('beach_unknown');

  if (r.style === 'balinese_old') fails.push('style');

  if (asArray(r.red_flags).includes('construction')) fails.push('construction');

  return { pass: fails.length === 0, fails, unknowns };
}

/** @returns {'in_filter'|'market'} */
export function scopeFrom(row, config = DEFAULT_CONFIG) {
  return hardFilters(row, config).pass ? 'in_filter' : 'market';
}

/**
 * Beach proximity factor 0..1: full credit at ≤ 1 km, none at ≥ 2 × beach_km_max (8 km by
 * default), linear in between; unknown distance → 0.5.
 */
export function beachFactor(beachKm, beachKmMax = DEFAULT_CONFIG.beach_km_max) {
  if (beachKm == null || !Number.isFinite(Number(beachKm))) return 0.5;
  const km = Number(beachKm);
  const zeroAt = beachKmMax * 2;
  if (km <= BEACH_FULL_KM) return 1;
  if (km >= zeroAt) return 0;
  return (zeroAt - km) / (zeroAt - BEACH_FULL_KM);
}

/**
 * SPEC §2 fit score, 0–100, normalised to the sum of the weights so edited weights stay on
 * a 0–100 scale. With default weights: all features true + ocean view + furniture quality 3
 * + beach ≤ 1 km = 100; everything unknown = 28.
 */
export function fitScore(
  row,
  weights = DEFAULT_WEIGHTS,
  lowPriorityPockets = DEFAULT_CONFIG.low_priority_pockets,
  beachKmMax = DEFAULT_CONFIG.beach_km_max,
) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const points = fitPoints(row, w, lowPriorityPockets, beachKmMax);
  const total = Object.values(w).reduce((a, b) => a + (Number(b) || 0), 0) || 100;
  return Math.max(0, Math.min(100, Math.round((points * 100) / total)));
}

/** Raw weighted points before normalisation (the §2 table, feature by feature). */
export function fitPoints(
  row,
  weights = DEFAULT_WEIGHTS,
  lowPriorityPockets = DEFAULT_CONFIG.low_priority_pockets,
  beachKmMax = DEFAULT_CONFIG.beach_km_max,
) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const r = row || {};
  let score = 0;

  // beach: soft filter — proximity scaled, unknown → half
  score += Math.floor(w.beach * beachFactor(r.beach_km, beachKmMax));

  // true → full, unknown → half, false → 0
  for (const key of ['living_open', 'airy', 'kitchen_full', 'aircon']) {
    if (isTrue(r[key])) score += w[key];
    else if (isUnknown(r[key])) score += half(w[key]);
  }

  // true → full, anything else → 0
  for (const key of ['pool', 'garden', 'workspace', 'joglo']) {
    if (isTrue(r[key])) score += w[key];
  }

  // view: ocean → full, rice/river/jungle → 70 %, none/unknown → 0
  if (r.view === 'ocean') score += w.view;
  else if (PARTIAL_VIEWS.has(r.view)) score += Math.round(w.view * VIEW_PARTIAL);

  // furniture: furnished & quality ≥ 3 → full; furnished with unknown quality → half;
  // unfurnished → 0; unknown whether furnished → half (same treatment as unknown quality).
  const furnished = r.furnished;
  const quality = r.furniture_quality;
  if (isTrue(furnished)) {
    if (quality != null && quality >= 3) score += w.furniture;
    else if (quality == null) score += half(w.furniture);
  } else if (isUnknown(furnished)) {
    score += half(w.furniture);
  }

  // Pockets people have already rejected (set by `learn`) cost 10 points.
  const pockets = Array.isArray(lowPriorityPockets) ? lowPriorityPockets : [];
  if (r.sub_area && pockets.length) {
    const sub = String(r.sub_area).toLowerCase();
    if (pockets.some((p) => sub.includes(String(p).toLowerCase()))) score -= LOW_PRIORITY_PENALTY;
  }

  return score;
}

/** Short human strings for the morning digest: "3BR", "Cemagi", "0.9 km to beach", "44 M/mo", "pool". */
export function reasonsFor(row) {
  const r = row || {};
  const out = [];

  if (r.bedrooms != null) out.push(`${r.bedrooms}BR${r.extra_rooms ? ` +${r.extra_rooms}` : ''}`);

  const label = AREAS[r.area]?.label;
  if (label) out.push(label);
  else if (r.area && r.area !== 'other') out.push(r.area);

  if (r.beach_km != null) out.push(`${r.beach_km} km to beach`);

  if (r.price_month_idr != null) {
    const m = r.price_month_idr / 1e6;
    const shown = Math.round(m * 10) / 10;
    out.push(`${Number.isInteger(shown) ? shown : shown.toFixed(1)} M/mo`);
  }

  if (isTrue(r.pool)) out.push('pool');
  if (isTrue(r.garden)) out.push('garden');
  if (r.view === 'ocean') out.push('ocean view');
  else if (r.view === 'rice') out.push('ricefield view');
  else if (r.view === 'river') out.push('river view');
  else if (r.view === 'jungle') out.push('jungle view');
  if (isTrue(r.joglo)) out.push('joglo');
  if (isTrue(r.workspace)) out.push('workspace');

  return out;
}

/**
 * Scope + score + flags for one row.
 * `over_budget` is the only flag toggled automatically; flags a person added stay put.
 * @returns {{scope:string, fit_score:number, flagged:0|1, red_flags:string[], reasons:string[]}}
 */
export function scoreRow(row, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const r = row || {};

  const scope = scopeFrom(r, cfg);

  const fit_score = fitScore(r, cfg.weights, cfg.low_priority_pockets, cfg.beach_km_max);

  const red_flags = asArray(r.red_flags);
  const overBudget = r.price_month_idr != null && r.price_month_idr > cfg.budget_max;
  const at = red_flags.indexOf('over_budget');
  if (overBudget && at < 0) red_flags.push('over_budget');
  if (!overBudget && at >= 0) red_flags.splice(at, 1);

  const flagged =
    scope === 'in_filter' &&
    fit_score >= cfg.flag_threshold &&
    red_flags.length === 0 &&
    r.status !== 'rejected' &&
    r.status !== 'gone'
      ? 1
      : 0;

  return { scope, fit_score, flagged, red_flags, reasons: reasonsFor(r) };
}

export default { inBand, hardFilters, scopeFrom, beachFactor, fitPoints, fitScore, reasonsFor, scoreRow };
