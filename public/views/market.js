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

const MONEY_DOMAIN = { min: DOMAIN_MIN, max: DOMAIN_MAX, step: TICK_STEP, tickStart: 20e6, fmt: fmtMoney, label: 'Price distribution chart' };

/**
 * Shared box/whisker rows. `domain` overrides the default money scale — the
 * "Time on market" section passes a days domain and its own tick formatter, which
 * is the whole reason the axis is parameterised rather than hard-coded.
 */
function renderBoxWhisker(rows, { getLabel, getN, getInFilter, chartWidth, domain, emptyText } = {}) {
  if (!rows || !rows.length) return `<p class="mkt-empty">${escapeHtml(emptyText || 'No priced listings yet.')}</p>`;

  const dom = { ...MONEY_DOMAIN, ...(domain || {}) };
  const W = Math.max(240, chartWidth || 600);
  const labelW = W < 420 ? 92 : 132;
  const chartX0 = labelW;
  const chartX1 = W - RIGHT_PAD;
  const scaleX = (v) => chartX0 + ((v - dom.min) / (dom.max - dom.min)) * (chartX1 - chartX0);
  const clampX = (x) => Math.min(chartX1, Math.max(chartX0, x));

  const plotBottom = TOP_PAD + rows.length * ROW_H;
  const H = plotBottom + AXIS_H;

  const ticks = [];
  for (let v = dom.tickStart; v <= dom.max; v += dom.step) ticks.push(v);

  let svg = `<svg class="mkt-chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${escapeHtml(dom.label)}">`;

  for (const v of ticks) {
    const x = scaleX(v);
    svg += `<line x1="${x}" y1="${TOP_PAD}" x2="${x}" y2="${plotBottom}" class="mkt-gridline" />`;
    svg += `<text x="${x}" y="${H - 8}" class="mkt-axis-label" text-anchor="middle">${dom.fmt(v)}</text>`;
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
      svg += `<rect x="${boxX}" y="${cy - 6}" width="${boxW}" height="12" rx="2" class="mkt-box"><title>p25 ${dom.fmt(row.p25)} · p75 ${dom.fmt(row.p75)}</title></rect>`;
    }
    if (row.median != null) {
      const mx = clampX(scaleX(row.median));
      svg += `<line x1="${mx}" y1="${cy - 8}" x2="${mx}" y2="${cy + 8}" class="mkt-median"><title>median ${dom.fmt(row.median)}</title></line>`;
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
// Market metrics (GET /api/market/metrics) — thirteen sections between the
// Overview and "Price per area". Every one of them degrades to the same empty
// state, because on a fresh database most of them have nothing to say yet.
// ---------------------------------------------------------------------------

const METRICS_DAYS = 90;
const EMPTY_METRIC = 'Not enough data yet — fills in as the daily scrape and the Facebook backfill run.';
const BR_GROUPS = ['1', '2', '3', '4+'];
const TREND_AREA_LIMIT = 6;

function emptyMetric() {
  return `<p class="mkt-empty">${EMPTY_METRIC}</p>`;
}

function section(title, explainer, body) {
  return `<section class="mkt-section">
      <h2 class="mkt-heading">${escapeHtml(title)}</h2>
      <p class="mkt-explainer">${escapeHtml(explainer)}</p>
      ${body}
    </section>`;
}

function chips(group, values, isOn) {
  return `<div class="mkt-chips" role="group">${values
    .map((v) => `<button type="button" class="mkt-chip${isOn(v.value) ? ' is-on' : ''}" data-chip="${escapeHtml(group)}" data-value="${escapeHtml(v.value)}" aria-pressed="${isOn(v.value) ? 'true' : 'false'}">${escapeHtml(v.label)}</button>`)
    .join('')}</div>`;
}

function tiles(items) {
  // A lone tile in an auto-fit grid would stretch the full width; cap it instead.
  return `<div class="mkt-tiles${items.length === 1 ? ' is-narrow' : ''}">${items
    .map(([label, value, hint]) => `<div class="mkt-tile">
        <span class="mkt-tile-value mono">${escapeHtml(value)}</span>
        <span class="mkt-tile-label">${escapeHtml(label)}</span>
        ${hint ? `<span class="mkt-tile-hint mono">${escapeHtml(hint)}</span>` : ''}
      </div>`)
    .join('')}</div>`;
}

function fmtDays(v) {
  return v == null || !Number.isFinite(Number(v)) ? '—' : `${Math.round(Number(v))}d`;
}

function fmtPlainPct(v, digits = 1) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return `${digits === 0 ? Math.round(n) : n}%`;
}

function monthLabel(month) {
  if (!month) return '';
  const [y, m] = String(month).split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(m) - 1] || m}${Number(m) === 1 ? ` ${String(y).slice(2)}` : ''}`;
}

function weekLabel(week) {
  return String(week || '').replace(/^\d{4}-/, '');
}

// --- 1. Asking price trend -------------------------------------------------

const TREND_H = 132;
const TREND_PAD = { l: 52, r: 12, t: 12, b: 20 };

function renderTrendChart(rows, months, areasMap, { chartWidth, br, selectedArea }) {
  const mine = (rows || []).filter((r) => r.br === br && r.area !== 'all' && r.median != null);
  if (!mine.length || !months || months.length < 1) return emptyMetric();

  const totals = new Map();
  for (const r of mine) totals.set(r.area, (totals.get(r.area) || 0) + r.n);
  const areas = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TREND_AREA_LIMIT).map(([a]) => a);
  const shown = mine.filter((r) => areas.includes(r.area));
  if (!shown.length) return emptyMetric();

  const W = Math.max(260, chartWidth || 600);
  const x0 = TREND_PAD.l;
  const x1 = W - TREND_PAD.r;
  const y0 = TREND_PAD.t;
  const y1 = TREND_H - TREND_PAD.b;
  const stepX = months.length > 1 ? (x1 - x0) / (months.length - 1) : 0;
  const scaleX = (i) => (months.length > 1 ? x0 + i * stepX : (x0 + x1) / 2);

  const values = shown.map((r) => r.median);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) {
    lo = Math.max(0, lo - 5e6);
    hi += 5e6;
  } else {
    const pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;
  }
  const scaleY = (v) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);

  let svg = `<svg class="mkt-chart mkt-trend-chart" viewBox="0 0 ${W} ${TREND_H}" width="100%" role="img" aria-label="Median asking price per month, ${escapeHtml(br)} bedroom">`;
  for (const v of [lo, (lo + hi) / 2, hi]) {
    const y = scaleY(v);
    svg += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" class="mkt-gridline" />`;
    svg += `<text x="${x0 - 6}" y="${(y + 3).toFixed(1)}" class="mkt-axis-label" text-anchor="end">${fmtMoney(v)}</text>`;
  }
  months.forEach((m, i) => {
    svg += `<text x="${scaleX(i).toFixed(1)}" y="${TREND_H - 4}" class="mkt-axis-label" text-anchor="middle">${escapeHtml(monthLabel(m))}</text>`;
  });

  for (const area of areas) {
    const pts = months
      .map((m, i) => ({ i, row: shown.find((r) => r.area === area && r.month === m) }))
      .filter((p) => p.row);
    if (!pts.length) continue;
    const sel = area === selectedArea ? ' is-sel' : '';
    const d = pts.map((p) => `${scaleX(p.i).toFixed(1)},${scaleY(p.row.median).toFixed(1)}`).join(' ');
    svg += `<g class="mkt-trend-series${sel}">`;
    if (pts.length > 1) svg += `<polyline class="mkt-trend-line" points="${d}" />`;
    for (const p of pts) {
      svg += `<circle class="mkt-trend-dot" cx="${scaleX(p.i).toFixed(1)}" cy="${scaleY(p.row.median).toFixed(1)}" r="3.2"><title>${escapeHtml(areaLabel(areasMap, area))} · ${escapeHtml(monthLabel(p.row.month))} · ${fmtMoney(p.row.median)} · n=${p.row.n}</title></circle>`;
    }
    svg += '</g>';
  }
  svg += '</svg>';

  const legend = `<div class="mkt-chips mkt-legend">${areas
    .map((a) => `<button type="button" class="mkt-chip mkt-legend-item${a === selectedArea ? ' is-on' : ''}" data-chip="trend-area" data-value="${escapeHtml(a)}"><span class="mkt-legend-swatch"></span>${escapeHtml(areaLabel(areasMap, a))}</button>`)
    .join('')}</div>`;

  return `<div class="mkt-trend"><h3 class="mkt-subheading">${escapeHtml(br)} bedroom</h3>${svg}${legend}</div>`;
}

function renderPriceTrend(trend, areasMap, { chartWidth, brs, selectedArea }) {
  if (!trend || !trend.rows || !trend.rows.length) return emptyMetric();
  const active = BR_GROUPS.filter((b) => brs.has(b));
  const picker = chips('trend-br', BR_GROUPS.map((b) => ({ value: b, label: `${b} BR` })), (v) => brs.has(v));
  const charts = active.map((br) => renderTrendChart(trend.rows, trend.months, areasMap, { chartWidth, br, selectedArea })).join('');
  return `${picker}${charts || emptyMetric()}`;
}

// --- 2. Supply flow --------------------------------------------------------

const FLOW_H = 128;
const FLOW_PAD = { l: 30, r: 10, t: 10, b: 18 };

function renderSupplyFlow(flow, areasMap, { chartWidth, area }) {
  if (!flow || !flow.rows || !flow.rows.length) return emptyMetric();
  const areaList = flow.areas && flow.areas.length ? flow.areas : ['all'];
  const current = areaList.includes(area) ? area : 'all';
  const rows = flow.weeks.map((w) => flow.rows.find((r) => r.week === w && r.area === current) || { week: w, new: 0, removed: 0, net: 0 });
  const picker = chips(
    'flow-area',
    areaList.map((a) => ({ value: a, label: a === 'all' ? 'All' : areaLabel(areasMap, a) })),
    (v) => v === current
  );
  if (!rows.some((r) => r.new || r.removed)) return `${picker}${emptyMetric()}`;

  const W = Math.max(260, chartWidth || 600);
  const x0 = FLOW_PAD.l;
  const x1 = W - FLOW_PAD.r;
  const n = rows.length;
  const slot = (x1 - x0) / n;
  const barW = Math.max(3, slot * 0.62);
  const maxV = Math.max(1, ...rows.map((r) => Math.max(r.new, r.removed)));
  const midY = FLOW_PAD.t + (FLOW_H - FLOW_PAD.t - FLOW_PAD.b) / 2;
  const half = (FLOW_H - FLOW_PAD.t - FLOW_PAD.b) / 2;
  const scaleH = (v) => (v / maxV) * half;
  const netMax = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
  const scaleNet = (v) => midY - (v / netMax) * half * 0.9;

  let svg = `<svg class="mkt-chart mkt-flow-chart" viewBox="0 0 ${W} ${FLOW_H}" width="100%" role="img" aria-label="New and removed listings per week">`;
  svg += `<line x1="${x0}" y1="${midY.toFixed(1)}" x2="${x1}" y2="${midY.toFixed(1)}" class="mkt-gridline" />`;
  svg += `<text x="${x0 - 4}" y="${(FLOW_PAD.t + 8).toFixed(1)}" class="mkt-axis-label" text-anchor="end">${maxV}</text>`;
  svg += `<text x="${x0 - 4}" y="${(midY + 3).toFixed(1)}" class="mkt-axis-label" text-anchor="end">0</text>`;

  rows.forEach((r, i) => {
    const cx = x0 + i * slot + slot / 2;
    const bx = cx - barW / 2;
    if (r.new > 0) {
      const h = scaleH(r.new);
      svg += `<rect class="mkt-flow-new" x="${bx.toFixed(1)}" y="${(midY - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"><title>${escapeHtml(r.week)}: ${r.new} new</title></rect>`;
    }
    if (r.removed > 0) {
      const h = scaleH(r.removed);
      svg += `<rect class="mkt-flow-removed" x="${bx.toFixed(1)}" y="${midY.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"><title>${escapeHtml(r.week)}: ${r.removed} removed</title></rect>`;
    }
  });
  const netPts = rows.map((r, i) => `${(x0 + i * slot + slot / 2).toFixed(1)},${scaleNet(r.net).toFixed(1)}`).join(' ');
  svg += `<polyline class="mkt-flow-net" points="${netPts}" />`;
  for (const i of [0, Math.floor((n - 1) / 2), n - 1]) {
    svg += `<text x="${(x0 + i * slot + slot / 2).toFixed(1)}" y="${FLOW_H - 4}" class="mkt-axis-label" text-anchor="middle">${escapeHtml(weekLabel(rows[i].week))}</text>`;
  }
  svg += '</svg>';

  const totalNew = rows.reduce((a, r) => a + r.new, 0);
  const totalGone = rows.reduce((a, r) => a + r.removed, 0);
  const caption = `<p class="mkt-band-caption mono">${totalNew} new · ${totalGone} removed · net ${totalNew - totalGone >= 0 ? '+' : ''}${totalNew - totalGone} over ${n} weeks</p>`;
  return `${picker}${svg}${caption}`;
}

// --- 3. Time on market -----------------------------------------------------

function renderTimeOnMarket(tom, areasMap, { chartWidth }) {
  if (!tom) return emptyMetric();
  const rows = (tom.by_area || []).map((r) => ({ ...r, median: r.median_days }));
  const stale = tom.stale_share || {};
  const allMedian = rows.length ? rows.map((r) => r.median_days).filter((v) => v != null).sort((a, b) => a - b) : [];
  const medianAll = allMedian.length ? allMedian[Math.ceil(allMedian.length / 2) - 1] : null;
  const maxDays = Math.max(60, ...rows.map((r) => r.p75 || 0));
  const domainMax = Math.ceil(maxDays / 30) * 30;

  const tileRow = tiles([
    ['Median days listed', fmtDays(medianAll)],
    ['Removed rows', String(rows.reduce((a, r) => a + r.n, 0))],
    ['Live over 30 d', stale.n_live_over_30d == null ? '—' : String(stale.n_live_over_30d), stale.n_live ? `of ${stale.n_live}` : ''],
    ['Stale share', stale.share == null ? '—' : `${Math.round(stale.share * 100)}%`],
  ]);

  const chart = renderBoxWhisker(rows, {
    getLabel: (r) => areaLabel(areasMap, r.area),
    getN: (r) => r.n,
    chartWidth,
    emptyText: EMPTY_METRIC,
    domain: { min: 0, max: domainMax, step: Math.max(15, Math.round(domainMax / 4 / 5) * 5), tickStart: 0, fmt: (v) => `${Math.round(v)}d`, label: 'Days on market per area' },
  });

  const bands = (tom.by_price_band || []).filter((b) => b.n > 0);
  const bandTable = bands.length
    ? `<div class="mkt-table-wrap"><table class="mkt-table mkt-table-sm">
        <thead><tr><th>Price band (M)</th><th>Listings</th><th>Median days</th></tr></thead>
        <tbody>${bands.map((b) => `<tr><td class="mkt-mono">${escapeHtml(b.band)}</td><td class="mkt-mono">${b.n}</td><td class="mkt-mono">${fmtDays(b.median_days)}</td></tr>`).join('')}</tbody>
      </table></div>`
    : '';

  return `${tileRow}${chart}${bandTable}`;
}

// --- 4. Price drops --------------------------------------------------------

function renderPriceDrops(drops, areasMap, days) {
  if (!drops) return emptyMetric();
  const tileRow = tiles([
    [`Drops (${days} d)`, String(drops.count || 0)],
    ['Average drop', drops.avg_pct == null ? '—' : `${drops.avg_pct}%`],
  ]);
  if (!drops.latest || !drops.latest.length) return `${tileRow}${emptyMetric()}`;
  const body = drops.latest
    .map((d) => `<tr>
      <td><a href="#/p/${d.id}" class="mkt-link" data-id="${d.id}">${escapeHtml(d.title || d.ref || `#${d.id}`)}</a></td>
      <td>${escapeHtml(areaLabel(areasMap, d.area))}</td>
      <td class="mkt-mono">${fmtMoney(d.from)} → ${fmtMoney(d.to)}</td>
      <td class="mkt-mono mkt-ok">−${d.pct}%</td>
      <td class="mkt-mono">${escapeHtml(d.date || '')}</td>
    </tr>`)
    .join('');
  return `${tileRow}<div class="mkt-table-wrap"><table class="mkt-table">
    <thead><tr><th>Villa</th><th>Area</th><th>Price</th><th>Drop</th><th>When</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

// --- 5. Price per m² -------------------------------------------------------

const PER_M2_COLS = [
  { key: 'area', label: 'Area', numeric: false },
  { key: 'n', label: 'Listings', numeric: true },
  { key: 'median_per_build_m2', label: 'Per m² / mo', numeric: true },
  { key: 'median_per_bedroom', label: 'Per bedroom', numeric: true },
  { key: 'median_price', label: 'Median', numeric: true },
];

function sortRows(rows, sort, areasMap) {
  const col = PER_M2_COLS.find((c) => c.key === sort.key) || PER_M2_COLS[2];
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (!col.numeric) return dir * String(areaLabel(areasMap, a.area)).localeCompare(String(areaLabel(areasMap, b.area)));
    const av = a[col.key];
    const bv = b[col.key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir * (av - bv);
  });
}

function fmtThousands(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Math.round(Number(v));
  return n >= 1e6 ? fmtMoney(n) : `${Math.round(n / 1000)} k`;
}

function renderPerM2(perM2, areasMap, sort) {
  if (!perM2 || !perM2.by_area || !perM2.by_area.length) return emptyMetric();
  const rows = sortRows(perM2.by_area, sort, areasMap);
  const head = PER_M2_COLS.map((c) => {
    const on = sort.key === c.key;
    const arrow = on ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th><button type="button" class="mkt-sort${on ? ' is-on' : ''}" data-sort="per-m2" data-value="${c.key}">${escapeHtml(c.label)}${arrow}</button></th>`;
  }).join('');
  const line = (r, cls = '') => `<tr class="${cls}">
      <td>${escapeHtml(r.area === 'all' ? 'All areas' : areaLabel(areasMap, r.area))}</td>
      <td class="mkt-mono">${r.n}</td>
      <td class="mkt-mono">${fmtThousands(r.median_per_build_m2)}</td>
      <td class="mkt-mono">${fmtMoney(r.median_per_bedroom)}</td>
      <td class="mkt-mono">${fmtMoney(r.median_price)}</td>
    </tr>`;
  return `<div class="mkt-table-wrap"><table class="mkt-table">
    <thead><tr>${head}</tr></thead>
    <tbody>${rows.map((r) => line(r)).join('')}${perM2.all ? line(perM2.all, 'mkt-row-total') : ''}</tbody>
  </table></div>`;
}

// --- 6. Yearly discount ----------------------------------------------------

function renderYearlyDiscount(yd, areasMap) {
  if (!yd || !yd.n) return emptyMetric();
  const tileRow = tiles([
    ['Yearly is cheaper by', yd.median_discount_pct == null ? '—' : `${yd.median_discount_pct}%`, `n=${yd.n}`],
  ]);
  const rows = (yd.by_area || []).filter((r) => r.n > 0);
  if (!rows.length) return tileRow;
  const body = rows
    .map((r) => `<tr><td>${escapeHtml(areaLabel(areasMap, r.area))}</td><td class="mkt-mono">${r.n}</td><td class="mkt-mono">${fmtPlainPct(r.median_discount_pct)}</td></tr>`)
    .join('');
  return `${tileRow}<div class="mkt-table-wrap"><table class="mkt-table mkt-table-sm">
    <thead><tr><th>Area</th><th>Listings</th><th>Discount</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

// --- 7. Beach premium ------------------------------------------------------

const BEACH_BANDS = ['0-1', '1-2', '2-4', '4+', 'unknown'];
const GROUP_H = 132;
const GROUP_PAD = { l: 10, r: 10, t: 16, b: 30 };

function renderBeachPremium(rows, { chartWidth }) {
  const data = (rows || []).filter((r) => r.n > 0 && r.median != null);
  if (!data.length) return emptyMetric();
  const brs = BR_GROUPS.filter((b) => data.some((r) => r.br === b));
  const bands = BEACH_BANDS.filter((b) => data.some((r) => r.band === b));
  if (!brs.length || !bands.length) return emptyMetric();

  const W = Math.max(260, chartWidth || 600);
  const x0 = GROUP_PAD.l;
  const x1 = W - GROUP_PAD.r;
  const plotH = GROUP_H - GROUP_PAD.t - GROUP_PAD.b;
  const slot = (x1 - x0) / bands.length;
  const barW = Math.max(4, (slot * 0.72) / brs.length);
  const maxV = Math.max(...data.map((r) => r.median));

  let svg = `<svg class="mkt-chart mkt-group-chart" viewBox="0 0 ${W} ${GROUP_H}" width="100%" role="img" aria-label="Median price by beach distance and bedrooms">`;
  bands.forEach((band, bi) => {
    const groupX = x0 + bi * slot + (slot - barW * brs.length) / 2;
    brs.forEach((br, i) => {
      const row = data.find((r) => r.br === br && r.band === band);
      const x = groupX + i * barW;
      if (row) {
        const h = (row.median / maxV) * plotH;
        const y = GROUP_PAD.t + (plotH - h);
        svg += `<rect class="mkt-group-bar mkt-br-${escapeHtml(br).replace('+', 'p')}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 1.5).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}"><title>${escapeHtml(br)} BR · ${escapeHtml(band)} km · ${fmtMoney(row.median)} · n=${row.n}</title></rect>`;
        if (barW >= 16) svg += `<text class="mkt-hist-n" x="${(x + barW / 2 - 0.75).toFixed(1)}" y="${(y - 3).toFixed(1)}" text-anchor="middle">${fmtMoney(row.median)}</text>`;
      }
    });
    svg += `<text x="${(x0 + bi * slot + slot / 2).toFixed(1)}" y="${GROUP_H - 14}" class="mkt-axis-label" text-anchor="middle">${escapeHtml(band)} km</text>`;
  });
  svg += '</svg>';

  const legend = `<div class="mkt-legend-row">${brs
    .map((br) => `<span class="mkt-legend-key"><span class="mkt-legend-swatch mkt-br-${escapeHtml(br).replace('+', 'p')}"></span>${escapeHtml(br)} BR</span>`)
    .join('')}</div>`;
  return `${svg}${legend}`;
}

// --- 8. Inclusions premium -------------------------------------------------

function renderInclusionsPremium(ip) {
  if (!ip) return emptyMetric();
  const pair = (label, s) => {
    if (!s || (!s.n_with && !s.n_without)) return '';
    const delta = s.median_with != null && s.median_without ? Math.round(((s.median_with - s.median_without) / s.median_without) * 1000) / 10 : null;
    return `<div class="mkt-pair">
      <span class="mkt-pair-title">${escapeHtml(label)}</span>
      <div class="mkt-tiles">
        <div class="mkt-tile"><span class="mkt-tile-value mono">${fmtMoney(s.median_with)}</span><span class="mkt-tile-label">Included</span><span class="mkt-tile-hint mono">n=${s.n_with}</span></div>
        <div class="mkt-tile"><span class="mkt-tile-value mono">${fmtMoney(s.median_without)}</span><span class="mkt-tile-label">Not included</span><span class="mkt-tile-hint mono">n=${s.n_without}</span></div>
      </div>
      <p class="mkt-band-caption mono">${delta == null ? '—' : `${fmtPct(delta)} on the median`}</p>
    </div>`;
  };
  const body = `${pair('Electricity', ip.electricity)}${pair('Cleaning / staff', ip.staff)}`;
  return body.trim() ? `<div class="mkt-pairs">${body}</div>` : emptyMetric();
}

// --- 9. Same villa, different price ----------------------------------------

function renderCrossSourceGaps(csg, areasMap) {
  if (!csg || !csg.pairs || !csg.pairs.length) return emptyMetric();
  const body = csg.pairs
    .map((p) => `<tr>
      <td><a href="#/p/${p.a.id}" class="mkt-link" data-id="${p.a.id}">${escapeHtml(p.a.title || p.a.ref || `#${p.a.id}`)}</a><span class="mkt-n">${escapeHtml(p.a.source)}</span></td>
      <td class="mkt-mono">${fmtMoney(p.a.price)}</td>
      <td><a href="#/p/${p.b.id}" class="mkt-link" data-id="${p.b.id}">${escapeHtml(p.b.ref || `#${p.b.id}`)}</a><span class="mkt-n">${escapeHtml(p.b.source)}</span></td>
      <td class="mkt-mono">${fmtMoney(p.b.price)}</td>
      <td class="mkt-mono ${Math.abs(p.gap_pct) > 10 ? 'mkt-warn' : ''}">${fmtPct(p.gap_pct)}</td>
      <td><span class="mkt-pill mkt-pill-${escapeHtml(p.kind)}">${escapeHtml(p.kind)}</span></td>
    </tr>`)
    .join('');
  const summary = csg.summary || {};
  const caption = `<p class="mkt-band-caption mono">${summary.n_pairs || 0} pair${summary.n_pairs === 1 ? '' : 's'}${summary.median_gap_pct == null ? '' : ` · median gap ${summary.median_gap_pct}%`}</p>`;
  return `<div class="mkt-table-wrap"><table class="mkt-table">
    <thead><tr><th>Listing A</th><th>Price A</th><th>Listing B</th><th>Price B</th><th>Gap</th><th>Kind</th></tr></thead>
    <tbody>${body}</tbody></table></div>${caption}`;
}

// --- 10. Source share ------------------------------------------------------

function renderSourceShare(rows) {
  if (!rows || !rows.length) return emptyMetric();
  const body = rows
    .map((r) => `<tr>
      <td>${escapeHtml(r.source)}</td>
      <td class="mkt-mono">${r.listings}</td>
      <td class="mkt-mono">${r.in_filter}</td>
      <td class="mkt-mono">${fmtPlainPct(r.share_in_filter_pct)}</td>
      <td class="mkt-mono">${r.flagged}</td>
      <td class="mkt-mono">${fmtPlainPct(r.share_flagged_pct)}</td>
    </tr>`)
    .join('');
  return `<div class="mkt-table-wrap"><table class="mkt-table">
    <thead><tr><th>Source</th><th>Listings</th><th>In filter</th><th>Share</th><th>Flagged</th><th>Share</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

// --- 11. Budget bands ------------------------------------------------------

function renderBudgetBands(bb, areasMap) {
  if (!bb || !bb.by_area || !bb.by_area.length) return emptyMetric();
  const bands = bb.bands || [];
  const max = Math.max(1, ...bb.by_area.flatMap((r) => bands.map((b) => r.counts[b] || 0)));
  const head = bands
    .map((b) => `<th class="mkt-heat-head">${escapeHtml(b)}${b === bb.stretch_band ? '<span class="mkt-n">stretch</span>' : ''}</th>`)
    .join('');
  const body = bb.by_area
    .map((r) => `<tr>
      <td>${escapeHtml(areaLabel(areasMap, r.area))}</td>
      ${bands
        .map((b) => {
          const n = r.counts[b] || 0;
          const alpha = n ? (0.15 + 0.75 * (n / max)).toFixed(2) : '0';
          return `<td class="mkt-heat"><span class="mkt-heat-fill" style="opacity:${alpha}"></span><span class="mkt-heat-n mono">${n || ''}</span></td>`;
        })
        .join('')}
      <td class="mkt-mono">${r.n}</td>
    </tr>`)
    .join('');
  return `<div class="mkt-table-wrap"><table class="mkt-table mkt-heat-table">
    <thead><tr><th>Area</th>${head}<th>All</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

// --- 12. Availability ------------------------------------------------------

function renderAvailability(lead, areasMap) {
  if (!lead) return emptyMetric();
  const total = ['now', 'within_1m', 'in_1_3m', 'later', 'unknown'].reduce((a, k) => a + (lead[k] || 0), 0);
  if (!total) return emptyMetric();
  const tileRow = tiles([
    ['Now', String(lead.now || 0)],
    ['≤ 1 month', String(lead.within_1m || 0)],
    ['1–3 months', String(lead.in_1_3m || 0)],
    ['Later', String(lead.later || 0)],
    ['Unknown', String(lead.unknown || 0)],
  ]);
  const rows = (lead.by_area || []).filter((r) => r.n > 0);
  if (!rows.length) return tileRow;
  const body = rows
    .map((r) => `<tr><td>${escapeHtml(areaLabel(areasMap, r.area))}</td><td class="mkt-mono">${r.now}</td><td class="mkt-mono">${r.within_1m}</td><td class="mkt-mono">${r.in_1_3m}</td><td class="mkt-mono">${r.later}</td><td class="mkt-mono">${r.unknown}</td></tr>`)
    .join('');
  return `${tileRow}<div class="mkt-table-wrap"><table class="mkt-table mkt-table-sm">
    <thead><tr><th>Area</th><th>Now</th><th>≤ 1 m</th><th>1–3 m</th><th>Later</th><th>Unknown</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

// --- 13. Negotiable --------------------------------------------------------

function renderNegotiable(rows, areasMap) {
  const data = (rows || []).filter((r) => r.n_live > 0);
  if (!data.length) return emptyMetric();
  const max = Math.max(1, ...data.map((r) => r.share_pct || 0));
  const body = data
    .map((r) => `<div class="mkt-funnel-row">
      <span class="mkt-funnel-label">${escapeHtml(areaLabel(areasMap, r.area))}</span>
      <span class="mkt-funnel-track"><span class="mkt-funnel-bar is-active" style="width:${Math.round(((r.share_pct || 0) / max) * 100)}%"></span></span>
      <span class="mkt-funnel-count mono" title="${r.n_negotiable} of ${r.n_live}">${fmtPlainPct(r.share_pct, 0)}</span>
    </div>`)
    .join('');
  return `<div class="mkt-funnel">${body}</div>`;
}

// --- the whole block -------------------------------------------------------

function renderMetrics(metrics, areasMap, uiState, { chartWidth }) {
  if (!metrics) {
    return section('Market metrics', 'The deeper read of the market.', '<p class="mkt-error">Could not load the market metrics.</p>');
  }
  const days = metrics.days || METRICS_DAYS;
  return [
    section('Asking price trend', 'Median asking price per month, by area and bedrooms — what the market is asking, not what anyone paid.',
      renderPriceTrend(metrics.price_trend, areasMap, { chartWidth, brs: uiState.trendBrs, selectedArea: uiState.trendArea })),
    section('Supply flow', 'New listings up, removed listings down, per week. Removal is dated by the last day the listing was confirmed.',
      renderSupplyFlow(metrics.supply_flow, areasMap, { chartWidth, area: uiState.flowArea })),
    section('Time on market', 'How long a listing stays up before it disappears — and how much of what is live has been sitting for over a month.',
      renderTimeOnMarket(metrics.time_on_market, areasMap, { chartWidth })),
    section('Price drops', `Listings that lowered their asking price in the last ${days} days.`,
      renderPriceDrops(metrics.price_drops, areasMap, days)),
    section('Price per m²', 'Monthly rent per built square metre and per bedroom — tap a column to sort.',
      renderPerM2(metrics.per_m2, areasMap, uiState.m2Sort)),
    section('Yearly discount', 'How much cheaper a month is when the listing quotes both a monthly and a yearly price.',
      renderYearlyDiscount(metrics.yearly_discount, areasMap)),
    section('Beach premium', 'Median price by distance to the beach, one group of bars per bedroom count.',
      renderBeachPremium(metrics.beach_premium, { chartWidth })),
    section('Inclusions premium', 'What the median asks when electricity or cleaning is included versus when it is not.',
      renderInclusionsPremium(metrics.inclusions_premium)),
    section('Same villa, different price', 'The same house listed twice — merged duplicates and the near misses the scorer is fairly sure about.',
      renderCrossSourceGaps(metrics.cross_source_gaps, areasMap)),
    section('Where the good ones come from', 'Each source’s share of the in-filter and flagged pool.',
      renderSourceShare(metrics.source_share)),
    section('Budget bands', 'Live 1–3 bedroom listings per area across the budget, plus the 50–60 M stretch.',
      renderBudgetBands(metrics.budget_bands, areasMap)),
    section('Availability', 'When the live listings say they are free.',
      renderAvailability(metrics.availability_lead, areasMap)),
    section('Negotiable', 'Share of live listings per area that say the price is negotiable.',
      renderNegotiable(metrics.negotiable_share, areasMap)),
  ].join('');
}

// ---------------------------------------------------------------------------
// Full render
// ---------------------------------------------------------------------------

function render(el, data, areasMap, stats, metrics, uiState) {
  const chartWidth = Math.max(240, (el.clientWidth || 600) - 64);

  const overview = renderOverview(stats, { chartWidth });
  const metricSections = renderMetrics(metrics, areasMap, uiState, { chartWidth });
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
      ${metricSections}
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
  let lastMetrics = null; // same for /api/market/metrics.
  let areasMap = FALLBACK_AREAS;

  // Section-local UI state. It lives here (not in the DOM) so a resize re-render,
  // which rebuilds innerHTML wholesale, keeps the chips and the sort where they were.
  const uiState = {
    trendBrs: new Set(['2', '3']),
    trendArea: null,
    flowArea: 'all',
    m2Sort: { key: 'median_per_build_m2', dir: 'desc' },
  };

  function handleClick(e) {
    const chip = e.target.closest('.mkt-chip');
    if (chip) {
      e.preventDefault();
      const group = chip.getAttribute('data-chip');
      const value = chip.getAttribute('data-value');
      if (group === 'trend-br') {
        if (uiState.trendBrs.has(value)) {
          if (uiState.trendBrs.size > 1) uiState.trendBrs.delete(value);
        } else uiState.trendBrs.add(value);
      } else if (group === 'trend-area') {
        uiState.trendArea = uiState.trendArea === value ? null : value;
      } else if (group === 'flow-area') {
        uiState.flowArea = value;
      }
      renderNow();
      return;
    }

    const sorter = e.target.closest('.mkt-sort');
    if (sorter) {
      e.preventDefault();
      const value = sorter.getAttribute('data-value');
      if (sorter.getAttribute('data-sort') === 'per-m2') {
        uiState.m2Sort = uiState.m2Sort.key === value
          ? { key: value, dir: uiState.m2Sort.dir === 'asc' ? 'desc' : 'asc' }
          : { key: value, dir: value === 'area' ? 'asc' : 'desc' };
      }
      renderNow();
      return;
    }

    const link = e.target.closest('.mkt-link');
    if (!link) return;
    e.preventDefault();
    const id = link.getAttribute('data-id');
    if (id) ctx.navigate(`#/p/${id}`);
  }
  el.addEventListener('click', handleClick);

  function renderNow() {
    if (destroyed || !lastData) return;
    render(el, lastData, areasMap, lastStats, lastMetrics, uiState);
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

  // /api/market, /api/stats and /api/market/metrics are fetched in parallel; a
  // failure of either extra call must not block the rest of the Market page
  // (renderOverview / renderMetrics degrade to an inline error).
  const marketPromise = ctx.api.get('/api/market');
  const statsPromise = ctx.api.get(`/api/stats?days=${OVERVIEW_DAYS}`).catch(() => null);
  const metricsPromise = ctx.api.get(`/api/market/metrics?days=${METRICS_DAYS}`).catch(() => null);

  try {
    const [data, stats, metrics] = await Promise.all([marketPromise, statsPromise, metricsPromise]);
    if (destroyed) return cleanup;
    lastData = data;
    lastStats = stats;
    lastMetrics = metrics;
    render(el, data, areasMap, stats, metrics, uiState);
  } catch (err) {
    if (destroyed) return cleanup;
    const msg = err && err.status ? `Could not load market data (HTTP ${err.status}).` : 'Could not load market data.';
    el.innerHTML = `<div class="market-view"><p class="mkt-error">${escapeHtml(msg)}</p></div>`;
  }

  return cleanup;
}
