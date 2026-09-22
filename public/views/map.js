// public/views/map.js — Map view (SPEC §5 "Map"): Leaflet pins colour-coded by
// status, 4 km rings around beach points, filter state shared with Home via
// ctx.store. Leaflet is expected as window.L (loaded by the shell); this module
// loads it itself as a fallback. Styles live in views/charts.css (injected once).

import { filtersToQuery } from '../lib/filters.js';

// Resolved against this module's own URL, so it follows the /v/<hash>/ asset prefix.
const CHARTS_CSS_HREF = new URL('./charts.css', import.meta.url).pathname;
const LEAFLET_VERSION = '1.9.4';
const LEAFLET_JS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;

const FALLBACK_CENTER = [-8.72, 115.13];
const FALLBACK_ZOOM = 11;
const BEACH_RING_M = 4000;

// SPEC §7 — hard-coded fallback, used only if ctx.areas is empty AND /api/areas fails.
const FALLBACK_AREAS = {
  // Center — around Ubud. Inland: ~30 km from the nearest beach we track, so the beach
  // score is 0 by construction rather than by a missing value.
  ubud:          { label: 'Ubud',              group: 'center',     centroid: [-8.507, 115.263], beach: { name: 'Berawa Beach',      lat: -8.6725, lng: 115.1400 } },

  // West Coast — north to south, Tabanan down to the Kerobokan edge.
  mengwi:        { label: 'Mengwi',            group: 'west_coast', centroid: [-8.545, 115.170], beach: { name: 'Seseh Beach',        lat: -8.6315, lng: 115.0975 } },
  buwit:         { label: 'Buwit',             group: 'west_coast', centroid: [-8.583, 115.100], beach: { name: 'Nyanyi Beach',       lat: -8.6125, lng: 115.0765 } },
  kedungu:       { label: 'Kedungu',           group: 'west_coast', centroid: [-8.597, 115.064], beach: { name: 'Kedungu Beach',      lat: -8.6005, lng: 115.0605 } },
  nyanyi:        { label: 'Nyanyi',            group: 'west_coast', centroid: [-8.608, 115.080], beach: { name: 'Nyanyi Beach',       lat: -8.6125, lng: 115.0765 } },
  tanah_lot:     { label: 'Tanah Lot area',    group: 'west_coast', centroid: [-8.615, 115.090], beach: { name: 'Tanah Lot',          lat: -8.6215, lng: 115.0865 } },
  munggu:        { label: 'Munggu',            group: 'west_coast', centroid: [-8.617, 115.094], beach: { name: 'Munggu Beach',       lat: -8.6215, lng: 115.0905 } },
  cemagi:        { label: 'Cemagi',            group: 'west_coast', centroid: [-8.619, 115.103], beach: { name: 'Cemagi/Mengening',   lat: -8.6255, lng: 115.0995 } },
  seseh:         { label: 'Seseh',             group: 'west_coast', centroid: [-8.628, 115.099], beach: { name: 'Seseh Beach',        lat: -8.6315, lng: 115.0975 } },
  pererenan:     { label: 'Pererenan',         group: 'west_coast', centroid: [-8.640, 115.121], beach: { name: 'Pererenan Beach',    lat: -8.6475, lng: 115.1185 } },
  padonan:       { label: 'Padonan',           group: 'west_coast', centroid: [-8.645, 115.148], beach: { name: 'Berawa Beach',       lat: -8.6725, lng: 115.1400 } },
  canggu:        { label: 'Canggu',            group: 'west_coast', centroid: [-8.652, 115.130], beach: { name: 'Batu Bolong / Echo', lat: -8.6565, lng: 115.1265 } },
  tibubeneng:    { label: 'Tibubeneng',        group: 'west_coast', centroid: [-8.653, 115.151], beach: { name: 'Berawa Beach',       lat: -8.6725, lng: 115.1400 } },
  babakan:       { label: 'Babakan',           group: 'west_coast', centroid: [-8.657, 115.139], beach: { name: 'Batu Bolong / Echo', lat: -8.6565, lng: 115.1265 } },
  berawa:        { label: 'Berawa',            group: 'west_coast', centroid: [-8.666, 115.143], beach: { name: 'Berawa Beach',       lat: -8.6725, lng: 115.1400 } },
  umalas:        { label: 'Umalas',            group: 'west_coast', centroid: [-8.670, 115.157], beach: { name: 'Berawa Beach',       lat: -8.6725, lng: 115.1400 } },

  // South — the Bukit, north to south.
  balangan:      { label: 'Balangan',          group: 'south',      centroid: [-8.792, 115.124], beach: { name: 'Balangan Beach',     lat: -8.7915, lng: 115.1215 } },
  bingin:        { label: 'Bingin',            group: 'south',      centroid: [-8.806, 115.113], beach: { name: 'Bingin Beach',       lat: -8.8075, lng: 115.1095 } },
  padang_padang: { label: 'Padang Padang',     group: 'south',      centroid: [-8.811, 115.106], beach: { name: 'Padang Padang',      lat: -8.8115, lng: 115.1035 } },
  uluwatu:       { label: 'Uluwatu / Pecatu',  group: 'south',      centroid: [-8.829, 115.098], beach: { name: 'Suluban',            lat: -8.8145, lng: 115.0885 } },
  ungasan:       { label: 'Ungasan',           group: 'south',      centroid: [-8.833, 115.160], beach: { name: 'Melasti',            lat: -8.8475, lng: 115.1555 } },
  pandawa:       { label: 'Pandawa / Kutuh',   group: 'south',      centroid: [-8.842, 115.190], beach: { name: 'Pandawa Beach',      lat: -8.8455, lng: 115.1875 } },
};

const STATUS_COLOR = {
  new: 'var(--muted)',
  shortlist: 'var(--gold)',
  contacted: 'var(--gold)',
  viewing_booked: 'var(--gold)',
  viewed: 'var(--ok)',
  offer: 'var(--ok)',
  rejected: 'var(--danger)',
};

function statusColor(status) {
  return STATUS_COLOR[status] || 'var(--muted)';
}

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

function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

let leafletPromise = null;
function ensureLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-leaflet-map]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS;
      link.setAttribute('data-leaflet-map', '1');
      document.head.appendChild(link);
    }
    let script = document.querySelector('script[data-leaflet-map]');
    if (script && window.L) { resolve(window.L); return; }
    if (!script) {
      script = document.createElement('script');
      script.src = LEAFLET_JS;
      script.setAttribute('data-leaflet-map', '1');
      document.head.appendChild(script);
    }
    script.addEventListener('load', () => resolve(window.L), { once: true });
    script.addEventListener('error', () => reject(new Error('Failed to load Leaflet')), { once: true });
  });
  return leafletPromise;
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

/** Filters (same names/values as GET /api/properties) → a query string, +limit=500. */
// The list query is built by the shared filters module: it knows which filter keys the
// API accepts and how (e.g. the client-only sort 'worth' goes out as 'fit'). A hand-rolled
// dump of the filter object here once sent sort=worth and got a 400 for every map load.
function buildQuery(filters) {
  return filtersToQuery(filters || {}, { limit: 500 });
}

/** Distinct beach points (deduped by name) across every area. */
function beachPoints(areasMap) {
  const seen = new Map();
  for (const area of Object.values(areasMap || {})) {
    const b = area && area.beach;
    if (b && b.name && !seen.has(b.name)) seen.set(b.name, b);
  }
  return [...seen.values()];
}

function popupHtml(p) {
  const thumb = p.hero_url ? `<img class="map-popup-thumb" src="${escapeHtml(p.hero_url)}" alt="" />` : '';
  const price = p.price_month_idr != null ? `${fmtMoney(p.price_month_idr)} / mo` : '— / mo';
  const beach = p.beach_km != null ? `${p.beach_km} km beach` : 'beach n/a';
  const bedrooms = p.bedrooms != null ? `${p.bedrooms} BR` : '';
  const meta = [price, beach, bedrooms].filter(Boolean).join(' · ');
  const approx = p.pin_source === 'centroid'
    ? '<div class="map-popup-approx">Approximate pin (area centroid)</div>'
    : '';
  return `
    <div class="map-popup">
      ${thumb}
      <div class="map-popup-title">${escapeHtml(p.title || p.ref || ('#' + p.id))}</div>
      <div class="map-popup-meta">${escapeHtml(meta)}</div>
      <div class="map-popup-status">${escapeHtml(p.status || '')}</div>
      ${approx}
      <button type="button" class="map-popup-open" data-id="${p.id}">Open</button>
    </div>
  `;
}

function legendHtml() {
  return `
    <div><span class="map-legend-dot" style="background:var(--muted)"></span>New</div>
    <div><span class="map-legend-dot" style="background:var(--gold)"></span>Shortlist / contacted / booked</div>
    <div><span class="map-legend-dot" style="background:var(--ok)"></span>Viewed / offer</div>
    <div><span class="map-legend-dot" style="background:var(--danger)"></span>Rejected</div>
    <div><span class="map-legend-dot map-legend-anchor"></span>Your places</div>
    <div class="map-legend-ring">Ring = 4 km from beach</div>
  `;
}

// ---------------------------------------------------------------------------
// mountMap
// ---------------------------------------------------------------------------

export async function mountMap(el, ctx) {
  ensureChartsCss();
  el.innerHTML = '<div class="map-view"><p class="map-loading">Loading map…</p></div>';

  let destroyed = false;
  let map = null;
  let markersLayer = null;
  let requestSeq = 0;

  function noopCleanup() {
    destroyed = true;
  }

  function showFatalError(err) {
    const msg = err && err.status ? `Could not load the map (HTTP ${err.status}).` : 'Could not load the map.';
    el.innerHTML = `<div class="map-view"><p class="map-error">${escapeHtml(msg)}</p></div>`;
  }

  let L;
  try {
    L = await ensureLeaflet();
  } catch (err) {
    if (!destroyed) showFatalError(err);
    return noopCleanup;
  }
  if (destroyed) return noopCleanup;

  let areasMap = FALLBACK_AREAS;
  try {
    areasMap = await resolveAreas(ctx);
  } catch {
    areasMap = FALLBACK_AREAS;
  }
  if (destroyed) return noopCleanup;

  // --- container + map -----------------------------------------------------
  el.innerHTML = `<div class="map-view"><div class="map-container"></div></div>`;
  const viewEl = el.querySelector('.map-view');
  const container = el.querySelector('.map-container');

  function handleClick(e) {
    const btn = e.target.closest('.map-popup-open');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    if (id) ctx.navigate(`#/p/${id}`);
  }
  el.addEventListener('click', handleClick);

  try {
    map = L.map(container, { scrollWheelZoom: true });
  } catch (err) {
    showFatalError(err);
    el.removeEventListener('click', handleClick);
    return noopCleanup;
  }
  map.setView(FALLBACK_CENTER, FALLBACK_ZOOM);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
  const ringsLayer = L.layerGroup().addTo(map);

  for (const beach of beachPoints(areasMap)) {
    L.circle([beach.lat, beach.lng], {
      radius: BEACH_RING_M,
      color: 'var(--gold)',
      weight: 1,
      dashArray: '4 4',
      fill: false,
    }).bindTooltip(beach.name, { direction: 'top', sticky: true }).addTo(ringsLayer);
  }

  // The people's own places (anchors): gold diamonds with the name on hover.
  const anchorsLayer = L.layerGroup().addTo(map);
  ctx.api
    .get('/api/anchors')
    .then((list) => {
      if (destroyed) return;
      for (const a of list || []) {
        L.marker([a.lat, a.lng], {
          icon: L.divIcon({ className: 'map-anchor', html: '<span></span>', iconSize: [16, 16], iconAnchor: [8, 8] }),
          keyboard: false,
        })
          .bindTooltip(a.name, { direction: 'top', offset: [0, -8] })
          .addTo(anchorsLayer);
      }
    })
    .catch(() => {}); // anchors are decoration on the map; a failed fetch just leaves them off

  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend-control');
    div.innerHTML = legendHtml();
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  legend.addTo(map);

  function clearInlineError() {
    const banner = viewEl.querySelector('.map-inline-error');
    if (banner) banner.remove();
  }

  function showInlineError(err) {
    let banner = viewEl.querySelector('.map-inline-error');
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'map-inline-error';
      viewEl.prepend(banner);
    }
    banner.textContent = err && err.status ? `Could not load listings (HTTP ${err.status}).` : 'Could not load listings.';
  }

  function drawMarkers(rows) {
    clearInlineError();
    markersLayer.clearLayers();
    const points = [];
    for (const p of rows) {
      if (p.lat == null || p.lng == null) continue;
      const flagged = !!p.flagged;
      const color = flagged ? 'var(--gold)' : statusColor(p.status);
      const marker = L.circleMarker([p.lat, p.lng], {
        radius: flagged ? 10 : 7,
        color,
        weight: flagged ? 2 : 1,
        fillColor: statusColor(p.status),
        fillOpacity: p.pin_source === 'centroid' ? 0.35 : 0.85,
        opacity: p.pin_source === 'centroid' ? 0.55 : 1,
      });
      marker.bindPopup(popupHtml(p));
      marker.addTo(markersLayer);
      points.push([p.lat, p.lng]);
    }
    if (points.length) {
      map.fitBounds(points, { padding: [24, 24], maxZoom: 15 });
    } else {
      map.setView(FALLBACK_CENTER, FALLBACK_ZOOM);
    }
  }

  async function loadAndDraw(filters) {
    const seq = ++requestSeq;
    let rows;
    try {
      rows = await ctx.api.get(`/api/properties?${buildQuery(filters)}`);
    } catch (err) {
      if (seq === requestSeq && !destroyed) showInlineError(err);
      return;
    }
    if (seq !== requestSeq || destroyed) return;
    const list = Array.isArray(rows) ? rows : [];
    drawMarkers(list);
    // The detail page's prev/next pager follows whatever the map last drew.
    ctx.store.set({ list_ids: list.map((p) => p.id) });
  }

  const initialFilters = (ctx.store.get() || {}).filters || {};
  let lastFiltersJson = JSON.stringify(initialFilters);
  await loadAndDraw(initialFilters);
  if (destroyed) {
    map.remove();
    el.removeEventListener('click', handleClick);
    return noopCleanup;
  }

  const unsubscribe = ctx.store.subscribe((state) => {
    const filters = (state && state.filters) || {};
    const json = JSON.stringify(filters);
    if (json === lastFiltersJson) return;
    lastFiltersJson = json;
    loadAndDraw(filters);
  });

  const onResize = debounce(() => { if (map) map.invalidateSize(); }, 150);
  window.addEventListener('resize', onResize);

  return () => {
    destroyed = true;
    window.removeEventListener('resize', onResize);
    unsubscribe();
    el.removeEventListener('click', handleClick);
    if (map) {
      map.remove();
      map = null;
    }
  };
}
