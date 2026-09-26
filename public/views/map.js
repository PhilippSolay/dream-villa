// public/views/map.js — Map view (SPEC §5 "Map"): Leaflet pins colour-coded by
// status, 4 km rings around beach points, filter state shared with Home via
// ctx.store. Leaflet is expected as window.L (loaded by the shell); this module
// loads it itself as a fallback. Styles live in views/charts.css (injected once).

import { filtersToQuery } from '../lib/filters.js';
// SPEC §7, the one copy (src/areas.js re-exports this same module server-side).
import { BEACHES } from '../lib/areas.js';
import { thumbUrl } from '../lib/ui.js';

// Resolved against this module's own URL, so it follows the /v/<hash>/ asset prefix.
const CHARTS_CSS_HREF = new URL('./charts.css', import.meta.url).pathname;
const LEAFLET_VERSION = '1.9.4';
const LEAFLET_JS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;

const FALLBACK_CENTER = [-8.72, 115.13];
const FALLBACK_ZOOM = 11;
const BEACH_RING_M = 4000;

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

/** Filters (same names/values as GET /api/properties) → a query string, +limit=500. */
// The list query is built by the shared filters module: it knows which filter keys the
// API accepts and how (e.g. the client-only sort 'worth' goes out as 'fit'). A hand-rolled
// dump of the filter object here once sent sort=worth and got a 400 for every map load.
function buildQuery(filters) {
  return filtersToQuery(filters || {}, { limit: 500 });
}

function popupHtml(p) {
  const thumb = p.hero_url ? `<img class="map-popup-thumb" src="${escapeHtml(thumbUrl(p.hero_url))}" alt="" />` : '';
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

  for (const beach of BEACHES) {
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
