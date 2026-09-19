// Value badges: price per m² of house against the area's median, and the yearly saving.
// The numbers come from the API (price_per_m2, area_price_per_m2, vs_area_pct,
// yearly_saving_pct); this only turns them into words.

import { html } from './ui.js';

/** 285_000 → "285k", 1_250_000 → "1.25M". */
export function perM2Label(idr) {
  if (idr == null) return null;
  const n = Number(idr);
  if (n >= 1e6) return `${(Math.round(n / 1e4) / 100).toFixed(2).replace(/\.?0+$/, '')}M`;
  return `${Math.round(n / 1e3)}k`;
}

/** Below the median by more than this is "good", above it "steep"; in between is at par. */
const PAR_BAND_PCT = 3;

export function vsAreaLabel(pct, areaLabel) {
  if (pct == null) return null;
  const where = areaLabel ? ` vs ${areaLabel}` : '';
  if (Math.abs(pct) <= PAR_BAND_PCT) return { text: `at par${where}`, tone: 'par' };
  return pct < 0 ? { text: `${Math.abs(pct)}% under${where}`, tone: 'good' } : { text: `${pct}% over${where}`, tone: 'steep' };
}

/**
 * One row of value facts, or nothing when the listing has none. `areaLabel` names the
 * comparison; pass `short: true` on cards so the area name is dropped when space is tight.
 */
export function valueBadgesHtml(p, areaLabel, { short = false } = {}) {
  const parts = [];
  const ppm2 = perM2Label(p.price_per_m2);
  if (ppm2) parts.push(html`<span class="mono muted value-ppm2" title="Monthly price per m² of house">${ppm2}/m²</span>`);
  const vs = vsAreaLabel(p.vs_area_pct, short ? null : areaLabel);
  if (vs) parts.push(html`<span class="pill pill-vs pill-vs-${vs.tone}" title="Against the median price per m² in ${areaLabel || 'the area'}">${vs.text}</span>`);
  if (p.yearly_saving_pct) parts.push(html`<span class="pill pill-save" title="Paying yearly instead of monthly">Yearly saves ${p.yearly_saving_pct}%</span>`);
  return parts.length ? html`<div class="value-row">${parts}</div>` : '';
}
