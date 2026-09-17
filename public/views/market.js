// public/views/market.js — Market view (SPEC §5 "Market"): an "Overview" section
// (STEP: stats — no SPEC section number yet) followed by the price distributions,
// feature premiums, and shortlist-vs-median SPEC already describes. Inline SVG only,
// no chart library. Styles live in views/charts.css (injected once).

import { dayLabel } from '../lib/ui.js';

const CHARTS_CSS_HREF = 'views/charts.css';
const OVERVIEW_DAYS = 30;
const PIPELINE_LABELS = {
  new: 'New', shortlist: 'Shortlist', contacted: 'Contacted', viewing_booked: 'Viewing booked',
  viewed: 'Viewed', offer: 'Offer', rejected: 'Rejected',
};
const ACTIVE_STAGES = new Set(['shortlist', 'contacted', 'viewing_booked', 'viewed', 'offer']);
// SPEC §3 ratings.feature values — distinct from the property FEATURE_LABELS below.
const RATING_FEATURE_LABELS = {
  quiet: 'Quiet', privacy: 'Privacy', living_room: 'Living room', light: 'Light',
  beach: 'Beach', style: 'Style', overall: 'Overall',
};

// SPEC §7 — hard-coded fallback, used only if ctx.areas is empty AND /api/areas fails.
const FALLBACK_AREAS = {
  seseh:         { label: 'Seseh',            group: 'west',  centroid: [-8.628, 115.099], beach: { name: 'Seseh Beach',        lat: -8.6315, lng: 115.0975 } },
  cemagi:        { label: 'Cemagi',           group: 'west',  centroid: [-8.619, 115.103], beach: { name: 'Cemagi/Mengening',   lat: -8.6255, lng: 115.0995 } },
  munggu:        { label: 'Munggu',           group: 'west',  centroid: [-8.617, 115.094], beach: { name: 'Munggu Beach',       lat: -8.6215, lng: 115.0905 } },
  pererenan:     { label: 'Pererenan',        group: 'west',  centroid: [-8.640, 115.121], beach: { name: 'Pererenan Beach',    lat: -8.6475, lng: 115.1185 } },
  nyanyi:        { label: 'Nyanyi',           group: 'west',  centroid: [-8.608, 115.080], beach: { name: 'Nyanyi Beach',       lat: -8.6125, lng: 115.0765 } },
  kedungu:       { label: 'Kedungu',          group: 'west',  centroid: [-8.597, 115.064], beach: { name: 'Kedungu Beach',      lat: -8.6005, lng: 115.0605 } },
  tanah_lot:     { label: 'Tanah Lot area',   group: 'west',  centroid: [-8.615, 115.090], beach: { name: 'Tanah Lot',          lat: -8.6215, lng: 115.0865 } },
  buwit:         { label: 'Buwit',            group: 'west',  centroid: [-8.583, 115.100], beach: { name: 'Nyanyi Beach',       lat: -8.6125, lng: 115.0765 } },
  mengwi:        { label: 'Mengwi',           group: 'west',  centroid: [-8.545, 115.170], beach: { name: 'Seseh Beach',        lat: -8.6315, lng: 115.0975 } },
  bingin:        { label: 'Bingin',           group: 'bukit', centroid: [-8.806, 115.113], beach: { name: 'Bingin Beach',       lat: -8.8075, lng: 115.1095 } },
  padang_padang: { label: 'Padang Padang',    group: 'bukit', centroid: [-8.811, 115.106], beach: { name: 'Padang Padang',      lat: -8.8115, lng: 115.1035 } },
  uluwatu:       { label: 'Uluwatu / Pecatu', group: 'bukit', centroid: [-8.829, 115.098], beach: { name: 'Suluban',            lat: -8.8145, lng: 115.0885 } },
  balangan:      { label: 'Balangan',         group: 'bukit', centroid: [-8.792, 115.124], beach: { name: 'Balangan Beach',     lat: -8.7915, lng: 115.1215 } },
  ungasan:       { label: 'Ungasan',          group: 'bukit', centroid: [-8.833, 115.160], beach: { name: 'Melasti',            lat: -8.8475, lng: 115.1555 } },
  pandawa:       { label: 'Pandawa / Kutuh',  group: 'bukit', centroid: [-8.842, 115.190], beach: { name: 'Pandawa Beach',      lat: -8.8455, lng: 115.1875 } },
};

const FEATURE_LABELS = {
  pool: 'Pool', garden: 'Garden', view: 'View', aircon: 'Aircon', kitchen_full: 'Full kitchen',
  workspace: 'Workspace', joglo: 'Joglo', furnished: 'Furnished',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function ensureChartsCss() {
  if (document.querySelector(`link[href="${CHARTS_CSS_HREF}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CHARTS_CSS_HREF;
  document.head.appendChild(link);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtMoney(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Math.round((Number(v) / 1e6) * 10) / 10;
  return `${n} M`;
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n}%`;
}

function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/**
 * The interface promises `ctx.areas` as a map keyed by area id, but the shell's
 * actual GET /api/areas (and the store's `areas` field it's copied from) returns
 * an *array* of `{id, label, group, centroid, beach}`. Accept either shape.
 */
function normaliseAreas(input) {
  if (!input) return null;
  if (Array.isArray(input)) {
    if (!input.length) return null;
    const map = {};
    for (const a of input) if (a && a.id) map[a.id] = a;
    return Object.keys(map).length ? map : null;
  }
  if (typeof input === 'object' && Object.keys(input).length) return input;
  return null;
}

async function resolveAreas(ctx) {
  const fromCtx = normaliseAreas(ctx.areas);
  if (fromCtx) return fromCtx;
  try {
    const res = await ctx.api.get('/api/areas');
    const areas = normaliseAreas(res && res.areas ? res.areas : res);
    if (areas) return areas;
  } catch {
    // fall through to the hard-coded SPEC §7 points
  }
  return FALLBACK_AREAS;
}

function areaLabel(areasMap, id) {
  if (id == null) return 'Unknown';
  const a = areasMap && areasMap[id];
  if (a && a.label) return a.label;
  return id === 'other' ? 'Other' : String(id);
}

function featureLabel(f) {
  return FEATURE_LABELS[f] || f;
}

// ---------------------------------------------------------------------------
// Box/whisker chart — one shared x-axis (15–80 M IDR/month), one row per group.
// The SVG viewBox is sized to the *measured* container width each render, so
// ROW_H below is a real on-screen pixel height (≥ 28 px), not a CSS-scaled
// approximation — which is also why this view re-renders on window resize.
// ---------------------------------------------------------------------------

const DOMAIN_MIN = 15e6;
const DOMAIN_MAX = 80e6;
const TICK_STEP = 10e6;
const ROW_H = 32;
const RIGHT_PAD = 20;
const TOP_PAD = 10;
const AXIS_H = 26;

function renderBoxWhisker(rows, { getLabel, getN, getInFilter, chartWidth } = {}) {
  if (!rows || !rows.length) return '<p class="mkt-empty">No priced listings yet.</p>';

  const W = Math.max(240, chartWidth || 600);
  const labelW = W < 420 ? 92 : 132;
  const chartX0 = labelW;
  const chartX1 = W - RIGHT_PAD;
  const scaleX = (v) => chartX0 + ((v - DOMAIN_MIN) / (DOMAIN_MAX - DOMAIN_MIN)) * (chartX1 - chartX0);
  const clampX = (x) => Math.min(chartX1, Math.max(chartX0, x));

  const plotBottom = TOP_PAD + rows.length * ROW_H;
  const H = plotBottom + AXIS_H;

  const ticks = [];
  for (let v = 20e6; v <= DOMAIN_MAX; v += TICK_STEP) ticks.push(v);

  let svg = `<svg class="mkt-chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Price distribution chart">`;

  for (const v of ticks) {
    const x = scaleX(v);
    svg += `<line x1="${x}" y1="${TOP_PAD}" x2="${x}" y2="${plotBottom}" class="mkt-gridline" />`;
    svg += `<text x="${x}" y="${H - 8}" class="mkt-axis-label" text-anchor="middle">${fmtMoney(v)}</text>`;
  }

  rows.forEach((row, i) => {
    const rowTop = TOP_PAD + i * ROW_H;
    const cy = rowTop + ROW_H / 2;
    const label = escapeHtml(getLabel(row));
    const n = getN(row);

    svg += `<text x="0" y="${rowTop + 12}" class="mkt-row-label">${label}</text>`;
    svg += `<text x="0" y="${rowTop + 25}" class="mkt-row-count">n=${n}</text>`;

    if (row.p25 != null && row.p75 != null) {
      const x1 = clampX(scaleX(row.p25));
      const x2 = clampX(scaleX(row.p75));
      const boxX = Math.min(x1, x2);
      const boxW = Math.max(2, Math.abs(x2 - x1));
      svg += `<rect x="${boxX}" y="${cy - 6}" width="${boxW}" height="12" rx="2" class="mkt-box"><title>p25 ${fmtMoney(row.p25)} · p75 ${fmtMoney(row.p75)}</title></rect>`;
    }
    if (row.median != null) {
      const mx = clampX(scaleX(row.median));
      svg += `<line x1="${mx}" y1="${cy - 8}" x2="${mx}" y2="${cy + 8}" class="mkt-median"><title>median ${fmtMoney(row.median)}</title></line>`;
    }
    const inFilter = getInFilter ? getInFilter(row) : null;
    if (inFilter != null && inFilter > 0 && row.median != null) {
      const mx = clampX(scaleX(row.median));
      svg += `<circle cx="${mx}" cy="${cy + 11}" r="3" class="mkt-infilter-marker"><title>${inFilter} in current filter</title></circle>`;
    }
  });

  svg += '</svg>';
  return svg;
}

/**
 * One area's price band with a listing's own price marked on it (used on the detail
 * page). `row` = an entry of /api/market by_area; `price` = the listing's monthly IDR.
 */
export function renderPriceBand(row, price, { chartWidth } = {}) {
  ensureChartsCss();
  if (!row || row.median == null) return '<p class="mkt-empty">Not enough priced listings in this area yet.</p>';
  const W = Math.max(240, chartWidth || 600);
  const chartX0 = 8;
  const chartX1 = W - RIGHT_PAD;
  const scaleX = (v) => chartX0 + ((v - DOMAIN_MIN) / (DOMAIN_MAX - DOMAIN_MIN)) * (chartX1 - chartX0);
  const clampX = (x) => Math.min(chartX1, Math.max(chartX0, x));
  const cy = TOP_PAD + ROW_H / 2;
  const H = TOP_PAD + ROW_H + AXIS_H;

  let svg = `<svg class="mkt-chart mkt-band" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Where this price sits in its area">`;
  for (let v = 20e6; v <= DOMAIN_MAX; v += TICK_STEP) {
    const x = scaleX(v);
    svg += `<line x1="${x}" y1="${TOP_PAD}" x2="${x}" y2="${TOP_PAD + ROW_H}" class="mkt-gridline" />`;
    svg += `<text x="${x}" y="${H - 8}" class="mkt-axis-label" text-anchor="middle">${fmtMoney(v)}</text>`;
  }
  if (row.p25 != null && row.p75 != null) {
    const x1 = clampX(scaleX(row.p25));
    const x2 = clampX(scaleX(row.p75));
    svg += `<rect x="${Math.min(x1, x2)}" y="${cy - 7}" width="${Math.max(2, Math.abs(x2 - x1))}" height="14" rx="2" class="mkt-box"><title>p25 ${fmtMoney(row.p25)} · p75 ${fmtMoney(row.p75)}</title></rect>`;
  }
  const mx = clampX(scaleX(row.median));
  svg += `<line x1="${mx}" y1="${cy - 10}" x2="${mx}" y2="${cy + 10}" class="mkt-median"><title>median ${fmtMoney(row.median)}</title></line>`;
  if (price != null) {
    const px = clampX(scaleX(price));
    svg += `<circle cx="${px}" cy="${cy}" r="6" class="mkt-price-marker"><title>this villa ${fmtMoney(price)}</title></circle>`;
  }
  svg += '</svg>';

  const delta = price != null ? Math.round(((price - row.median) / row.median) * 100) : null;
  const deltaText = delta == null ? '' : delta === 0 ? 'at the area median' : `${Math.abs(delta)} % ${delta > 0 ? 'above' : 'below'} the area median`;
  const caption = `<p class="mkt-band-caption mono">${fmtMoney(row.p25)} – ${fmtMoney(row.median)} – ${fmtMoney(row.p75)} · n=${row.n}${deltaText ? ` · ${escapeHtml(deltaText)}` : ''}</p>`;
  return svg + caption;
}

// ---------------------------------------------------------------------------
// Overview (GET /api/stats) — stat tiles, pipeline funnel, daily chart,
// fit/beach histograms, by-source table, activity line.
// ---------------------------------------------------------------------------

function renderStatTiles(stats) {
  const sum = (rows, key) => (rows || []).reduce((a, r) => a + (r[key] || 0), 0);
  const shortlistPlus = (stats.pipeline || []).filter((p) => ACTIVE_STAGES.has(p.status)).reduce((a, p) => a + p.n, 0);
  const newLast7 = (stats.daily || []).slice(-7).reduce((a, d) => a + d.new, 0);
  const goneWindow = (stats.daily || []).reduce((a, d) => a + d.gone, 0);
  const tiles = [
    ['In filter', sum(stats.by_area, 'in_filter')],
    ['Flagged', sum(stats.by_area, 'flagged')],
    ['Shortlist+', shortlistPlus],
    ['Viewed', sum(stats.by_area, 'viewed')],
    ['New (7d)', newLast7],
    [`Gone (${(stats.daily || []).length}d)`, goneWindow],
  ];
  const body = tiles.map(([label, n]) => `
    <div class="mkt-tile">
      <span class="mkt-tile-value mono">${n}</span>
      <span class="mkt-tile-label">${escapeHtml(label)}</span>
    </div>`).join('');
  return `<div class="mkt-tiles">${body}</div>`;
}

function renderPipeline(pipeline) {
  const stages = (pipeline || []).filter((p) => p.status !== 'gone');
  if (!stages.length) return '<p class="mkt-empty">No pipeline data yet.</p>';
  const max = Math.max(1, ...stages.map((s) => s.n));
  const rows = stages.map((s) => {
    const cls = s.status === 'new' ? 'is-new' : s.status === 'rejected' ? 'is-rejected' : 'is-active';
    const pct = Math.round((s.n / max) * 100);
    return `<div class="mkt-funnel-row">
      <span class="mkt-funnel-label">${escapeHtml(PIPELINE_LABELS[s.status] || s.status)}</span>
      <span class="mkt-funnel-track"><span class="mkt-funnel-bar ${cls}" style="width:${pct}%"></span></span>
      <span class="mkt-funnel-count mono">${s.n}</span>
    </div>`;
  }).join('');
  return `<div class="mkt-funnel">${rows}</div>`;
}

const DAILY_BAR_H = 54;
const DAILY_TOP_PAD = 8;
const DAILY_TICK_H = 5;
const DAILY_AXIS_H = 14;

/** "New listings per day" — thin bars, today at the right, run ticks below the axis. */
function renderDailyChart(daily, { chartWidth } = {}) {
  if (!daily || !daily.length) return '<p class="mkt-empty">No runs yet.</p>';
  const W = Math.max(240, chartWidth || 600);
  const n = daily.length;
  const gap = 2;
  const plotX0 = 2;
  const plotX1 = W - 2;
  const barW = Math.max(1, (plotX1 - plotX0 - gap * (n - 1)) / n);
  const maxN = Math.max(1, ...daily.map((d) => d.new));
  const tickY = DAILY_TOP_PAD + DAILY_BAR_H + 3;
  const H = DAILY_TOP_PAD + DAILY_BAR_H + DAILY_TICK_H + DAILY_AXIS_H;

  let svg = `<svg class="mkt-chart mkt-daily-chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="New listings per day, last ${n} days">`;
  daily.forEach((d, i) => {
    const x = plotX0 + i * (barW + gap);
    const h = (d.new / maxN) * DAILY_BAR_H;
    const y = DAILY_TOP_PAD + (DAILY_BAR_H - h);
    const today = i === n - 1 ? ' mkt-day-bar-today' : '';
    svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" class="mkt-day-bar${today}"><title>${d.date}: ${d.new} new</title></rect>`;
    if (d.runs > 0) {
      const cx = (x + barW / 2).toFixed(1);
      svg += `<line x1="${cx}" y1="${tickY}" x2="${cx}" y2="${tickY + DAILY_TICK_H}" class="mkt-run-tick"><title>${d.runs} run(s) · ${d.seen} seen</title></line>`;
    }
  });
  for (const i of [0, Math.floor((n - 1) / 2), n - 1]) {
    const x = (plotX0 + i * (barW + gap) + barW / 2).toFixed(1);
    svg += `<text x="${x}" y="${H - 2}" class="mkt-axis-label" text-anchor="middle">${escapeHtml(dayLabel(daily[i].date))}</text>`;
  }
  svg += '</svg>';
  return svg;
}

const HIST_BAR_H = 64;
const HIST_TOP_PAD = 12;
const HIST_AXIS_H = 14;

/** Shared categorical histogram: equal-width bars, one per bucket. `threshold`
 *  (optional) draws a dashed line at `index + fraction` bucket-widths from the left. */
function renderHistogramBars(buckets, { chartWidth, threshold, ariaLabel } = {}) {
  if (!buckets || !buckets.length || !buckets.some((b) => b.n > 0)) return '<p class="mkt-empty">No data yet.</p>';
  const W = Math.max(160, chartWidth || 260);
  const n = buckets.length;
  const gap = 3;
  const plotX0 = 2;
  const plotX1 = W - 2;
  const barW = Math.max(2, (plotX1 - plotX0 - gap * (n - 1)) / n);
  const step = barW + gap;
  const maxN = Math.max(1, ...buckets.map((b) => b.n));
  const H = HIST_TOP_PAD + HIST_BAR_H + HIST_AXIS_H;

  let svg = `<svg class="mkt-chart mkt-hist-chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${escapeHtml(ariaLabel || 'Histogram')}">`;
  buckets.forEach((b, i) => {
    const x = plotX0 + i * step;
    const h = (b.n / maxN) * HIST_BAR_H;
    const y = HIST_TOP_PAD + (HIST_BAR_H - h);
    svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" class="mkt-hist-bar"><title>${escapeHtml(b.bucket)}: ${b.n}</title></rect>`;
    if (b.n > 0) svg += `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" class="mkt-hist-n" text-anchor="middle">${b.n}</text>`;
    svg += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 2}" class="mkt-axis-label" text-anchor="middle">${escapeHtml(b.bucket)}</text>`;
  });
  if (threshold) {
    const tx = (plotX0 + threshold.index * step + threshold.fraction * barW).toFixed(1);
    svg += `<line x1="${tx}" y1="${HIST_TOP_PAD - 6}" x2="${tx}" y2="${HIST_TOP_PAD + HIST_BAR_H}" class="mkt-threshold-line"><title>flag threshold ${threshold.value}</title></line>`;
  }
  svg += '</svg>';
  return svg;
}

/** {index, fraction} of `value` inside a 10-wide bucket run (fit_histogram's shape). */
function fitThresholdPosition(value) {
  const v = Math.max(0, Math.min(100, value));
  const index = Math.min(9, Math.floor(v / 10));
  const fraction = Math.min(1, (v - index * 10) / 10);
  return { index, fraction, value };
}

function renderBySourceTable(rows) {
  if (!rows || !rows.length) return '<p class="mkt-empty">No source data yet.</p>';
  const body = rows.map((r) => `<tr>
      <td>${escapeHtml(r.source)}</td>
      <td class="mkt-mono">${r.listings}</td>
      <td class="mkt-mono">${r.in_filter}</td>
      <td class="mkt-mono">${r.flagged}</td>
      <td class="mkt-mono">${fmtMoney(r.median_price)}</td>
    </tr>`).join('');
  return `<div class="mkt-table-wrap"><table class="mkt-table">
    <thead><tr><th>Source</th><th>Listings</th><th>In filter</th><th>Flagged</th><th>Median</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function renderActivity(activity) {
  if (!activity) return '<p class="mkt-empty">No activity yet.</p>';
  const byUserText = (activity.by_user || []).map((u) => `${escapeHtml(u.name)} ${u.ratings + u.viewings + u.feedback}`).join(', ');
  const line = `${activity.ratings} rating${activity.ratings === 1 ? '' : 's'} · ${activity.viewings} visit${activity.viewings === 1 ? '' : 's'} · `
    + `${activity.feedback} feedback in ${OVERVIEW_DAYS} days${byUserText ? ` — ${byUserText}` : ''}`;
  const avgs = (activity.avg_ratings || [])
    .map((r) => `<span>${escapeHtml(RATING_FEATURE_LABELS[r.feature] || r.feature)} <strong class="mono">${r.avg}</strong></span>`)
    .join('');
  return `<p class="mkt-activity">${escapeHtml(line)}</p>${avgs ? `<div class="mkt-activity-avgs">${avgs}</div>` : ''}`;
}

function renderOverview(stats, { chartWidth } = {}) {
  if (!stats) return '<section class="mkt-section"><h2 class="mkt-heading">Overview</h2><p class="mkt-error">Could not load stats.</p></section>';
  const threshold = fitThresholdPosition(stats.flag_threshold ?? 65);
  const fitChart = renderHistogramBars(stats.fit_histogram, { chartWidth: chartWidth / 2 - 10, threshold, ariaLabel: 'Fit score spread' });
  const beachChart = renderHistogramBars(stats.beach_histogram, { chartWidth: chartWidth / 2 - 10, ariaLabel: 'Beach distance' });

  return `
    <section class="mkt-section">
      <h2 class="mkt-heading">Overview</h2>
      ${renderStatTiles(stats)}
      <h3 class="mkt-subheading">Pipeline</h3>
      ${renderPipeline(stats.pipeline)}
      <h3 class="mkt-subheading">New listings per day</h3>
      ${renderDailyChart(stats.daily, { chartWidth })}
      <h3 class="mkt-subheading">Fit score spread · Beach distance</h3>
      <div class="mkt-hist-grid">
        <div class="mkt-hist">${fitChart}</div>
        <div class="mkt-hist">${beachChart}</div>
      </div>
      <h3 class="mkt-subheading">By source</h3>
      ${renderBySourceTable(stats.by_source)}
      <h3 class="mkt-subheading">Activity</h3>
      ${renderActivity(stats.activity)}
    </section>`;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function renderFeaturePremium(rows) {
  if (!rows || !rows.length) return '<p class="mkt-empty">No feature data yet.</p>';
  const body = rows.map((r) => {
    const delta = r.median_with != null && r.median_without != null && r.median_without !== 0
      ? Math.round(((r.median_with - r.median_without) / r.median_without) * 1000) / 10
      : null;
    return `<tr>
      <td>${escapeHtml(featureLabel(r.feature))}</td>
      <td class="mkt-mono">${fmtMoney(r.median_with)}<span class="mkt-n">n=${r.n_with}</span></td>
      <td class="mkt-mono">${fmtMoney(r.median_without)}<span class="mkt-n">n=${r.n_without}</span></td>
      <td class="mkt-mono">${fmtPct(delta)}</td>
    </tr>`;
  }).join('');
  return `<div class="mkt-table-wrap"><table class="mkt-table">
    <thead><tr><th>Feature</th><th>Median with</th><th>Median without</th><th>Delta</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function renderShortlistTable(rows, areasMap) {
  if (!rows || !rows.length) return '<p class="mkt-empty">No shortlisted villas yet.</p>';
  const body = rows.map((r) => {
    const deltaClass = r.delta_pct == null ? '' : r.delta_pct < 0 ? 'mkt-ok' : r.delta_pct > 10 ? 'mkt-warn' : '';
    const title = r.title || r.ref || `#${r.property_id}`;
    return `<tr>
      <td><a href="#/p/${r.property_id}" class="mkt-link" data-id="${r.property_id}">${escapeHtml(title)}</a></td>
      <td>${escapeHtml(areaLabel(areasMap, r.area))}</td>
      <td class="mkt-mono">${fmtMoney(r.price)}</td>
      <td class="mkt-mono">${fmtMoney(r.area_median)}</td>
      <td class="mkt-mono ${deltaClass}">${fmtPct(r.delta_pct)}</td>
    </tr>`;
  }).join('');
  return `<div class="mkt-table-wrap"><table class="mkt-table">
    <thead><tr><th>Villa</th><th>Area</th><th>Price</th><th>Area median</th><th>Delta</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function renderCounts(counts) {
  const c = counts || {};
  return `<div class="mkt-counts">
    <span><strong>${c.in_filter ?? 0}</strong> in filter</span>
    <span><strong>${c.market ?? 0}</strong> market</span>
    <span><strong>${c.flagged ?? 0}</strong> flagged</span>
    <span><strong>${c.shortlist ?? 0}</strong> shortlist</span>
    <span><strong>${c.gone ?? 0}</strong> gone</span>
  </div>`;
}

// ---------------------------------------------------------------------------
// Full render
// ---------------------------------------------------------------------------

function render(el, data, areasMap, stats) {
  const chartWidth = Math.max(240, (el.clientWidth || 600) - 64);

  const overview = renderOverview(stats, { chartWidth });
  const byArea = renderBoxWhisker(data.by_area || [], {
    getLabel: (r) => areaLabel(areasMap, r.area),
    getN: (r) => r.n,
    getInFilter: (r) => r.n_in_filter,
    chartWidth,
  });
  const byBedrooms = renderBoxWhisker(data.by_bedrooms || [], {
    getLabel: (r) => (r.bedrooms == null ? 'Unknown' : `${r.bedrooms} BR`),
    getN: (r) => r.n,
    chartWidth,
  });
  const featurePremium = renderFeaturePremium(data.feature_premium);
  const shortlist = renderShortlistTable(data.shortlist_vs_median, areasMap);
  const counts = renderCounts(data.counts);

  el.innerHTML = `
    <div class="market-view">
      ${overview}
      <section class="mkt-section">
        <h2 class="mkt-heading">Price per area</h2>
        ${byArea}
      </section>
      <section class="mkt-section">
        <h2 class="mkt-heading">Price per bedrooms</h2>
        ${byBedrooms}
      </section>
      <section class="mkt-section">
        <h2 class="mkt-heading">Feature premium</h2>
        ${featurePremium}
      </section>
      <section class="mkt-section">
        <h2 class="mkt-heading">Your shortlist vs area median</h2>
        ${shortlist}
      </section>
      ${counts}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// mountMarket
// ---------------------------------------------------------------------------

export async function mountMarket(el, ctx) {
  ensureChartsCss();
  el.innerHTML = '<div class="market-view"><p class="mkt-loading">Loading market data…</p></div>';

  let destroyed = false;
  let lastData = null;
  let lastStats = null; // stays null if /api/stats fails — the rest of the page still renders.
  let areasMap = FALLBACK_AREAS;

  function handleClick(e) {
    const link = e.target.closest('.mkt-link');
    if (!link) return;
    e.preventDefault();
    const id = link.getAttribute('data-id');
    if (id) ctx.navigate(`#/p/${id}`);
  }
  el.addEventListener('click', handleClick);

  function renderNow() {
    if (destroyed || !lastData) return;
    render(el, lastData, areasMap, lastStats);
  }
  const onResize = debounce(renderNow, 150);
  window.addEventListener('resize', onResize);

  function cleanup() {
    destroyed = true;
    window.removeEventListener('resize', onResize);
    el.removeEventListener('click', handleClick);
  }

  try {
    areasMap = await resolveAreas(ctx);
  } catch {
    areasMap = FALLBACK_AREAS;
  }
  if (destroyed) return cleanup;

  // /api/market and /api/stats are fetched in parallel; a stats failure must not
  // block the rest of the Market page (renderOverview degrades to an inline error).
  const marketPromise = ctx.api.get('/api/market');
  const statsPromise = ctx.api.get(`/api/stats?days=${OVERVIEW_DAYS}`).catch(() => null);

  try {
    const [data, stats] = await Promise.all([marketPromise, statsPromise]);
    if (destroyed) return cleanup;
    lastData = data;
    lastStats = stats;
    render(el, data, areasMap, stats);
  } catch (err) {
    if (destroyed) return cleanup;
    const msg = err && err.status ? `Could not load market data (HTTP ${err.status}).` : 'Could not load market data.';
    el.innerHTML = `<div class="market-view"><p class="mkt-error">${escapeHtml(msg)}</p></div>`;
  }

  return cleanup;
}
