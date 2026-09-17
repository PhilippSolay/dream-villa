// public/views/market.js — Market view (SPEC §5 "Market"): price distributions,
// feature premiums, and shortlist-vs-median, rendered as inline SVG box/whisker
// charts. No chart library. Styles live in views/charts.css (injected once).

const CHARTS_CSS_HREF = 'views/charts.css';

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

function render(el, data, areasMap) {
  const chartWidth = Math.max(240, (el.clientWidth || 600) - 64);

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
    render(el, lastData, areasMap);
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

  try {
    const data = await ctx.api.get('/api/market');
    if (destroyed) return cleanup;
    lastData = data;
    render(el, data, areasMap);
  } catch (err) {
    if (destroyed) return cleanup;
    const msg = err && err.status ? `Could not load market data (HTTP ${err.status}).` : 'Could not load market data.';
    el.innerHTML = `<div class="market-view"><p class="mkt-error">${escapeHtml(msg)}</p></div>`;
  }

  return cleanup;
}
