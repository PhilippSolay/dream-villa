// #/ — flagged / new-today strip, filter drawer (bottom sheet on phone, rail on desktop),
// sort, and the card grid. SPEC §5 "Home".

import { filtersToQuery, activeFilterCount, defaultFilters } from '../lib/filters.js';
import {
  $, $$, html, setHtml, icons, priceLabel, beachLabel, statusPill, fitRing,
  FEATURE_LABELS, STATUS_LABELS, openSheet, closeSheet, debounce, makassarDate, makassarTime, todayMakassar, dayLabel,
} from '../lib/ui.js';

const PRICE_MIN_M = 15;
const PRICE_MAX_M = 80;
const PRICE_STEP_M = 0.5;
const BEACH_MAX_KM = 10;
const LAND_MIN_M2 = 0;
const LAND_MAX_M2 = 2000;
const LAND_STEP_M2 = 50;
const BUILD_MIN_M2 = 0;
const BUILD_MAX_M2 = 600;
const BUILD_STEP_M2 = 10;
const SORTS = [['worth', 'Worth a look'], ['fit', 'Fit'], ['price', 'Price'], ['beach', 'Beach'], ['new', 'Newest']];
const BEDROOMS = [1, 2, 3, 4];
const FEATURES = Object.keys(FEATURE_LABELS);
const AGE_OPTIONS = [['', 'Any'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']];
const REMOVED_OPTIONS = [['hide', 'Hide'], ['show', 'Show'], ['only', 'Only']];

/** first_seen → "today" / "3d" / "5w" / "4mo" (SPEC §5 card, age of post filter). */
function ageLabel(firstSeenIso) {
  if (!firstSeenIso) return null;
  const ms = Date.now() - new Date(firstSeenIso).getTime();
  if (!Number.isFinite(ms)) return null;
  const days = Math.max(0, Math.floor(ms / 86_400_000));
  if (days === 0) return 'today';
  if (days < 7) return `${days}d`;
  if (days < 60) return `${Math.max(1, Math.round(days / 7))}w`;
  return `${Math.max(1, Math.round(days / 30))}mo`;
}

/** sort=worth: flagged listings (fit desc — already this order from the API's own
 *  sort=fit) followed by today's non-flagged arrivals (newest first). Client-side only:
 *  the API has no 'worth' sort, so the request itself goes out as sort=fit (filters.js). */
function worthOrder(rows) {
  const today = todayMakassar();
  const flagged = rows.filter((r) => r.flagged);
  const newToday = rows
    .filter((r) => !r.flagged && makassarDate(r.first_seen) === today)
    .sort((a, b) => new Date(b.first_seen).getTime() - new Date(a.first_seen).getTime());
  return [...flagged, ...newToday];
}

function featureChips(p, max = 4) {
  const out = [];
  if (p.pool === 1) out.push('Pool');
  if (p.garden === 1) out.push('Garden');
  if (p.view && p.view !== 'none') out.push(`${p.view.charAt(0).toUpperCase()}${p.view.slice(1)} view`);
  if (p.joglo === 1) out.push('Joglo');
  if (p.living_open === 1) out.push('Open living');
  if (p.airy === 1) out.push('Airy');
  if (p.kitchen_full === 1) out.push('Full kitchen');
  if (p.workspace === 1) out.push('Workspace');
  if (p.aircon === 1) out.push('Aircon');
  return out.slice(0, max);
}

function areaLine(p, areas) {
  const label = areas.find((a) => a.id === p.area)?.label || p.area || 'Unknown area';
  return p.sub_area ? `${label} · ${p.sub_area}` : label;
}

export function cardHtml(p, areas, { reason = false } = {}) {
  const bedrooms = p.bedrooms == null ? null : `${p.bedrooms} BR${p.extra_rooms ? ` +${p.extra_rooms}` : ''}`;
  const beach = beachLabel(p.beach_km);
  const age = ageLabel(p.first_seen);
  const removed = p.availability === 'gone' || p.availability === 'unlisted';
  return html`<article class="card">
    <a class="card-hit" href="#/p/${p.id}" aria-label="${p.title}">
      <div class="card-media">
        ${p.hero_url
          ? html`<img src="${p.hero_url}" alt="" loading="lazy" decoding="async" />`
          : html`<span class="placeholder">No photo yet</span>`}
        <span class="card-badges">
          ${statusPill(p.status)}
          ${removed
            ? html`<span class="pill pill-removed" title="Removed${p.removed_at ? ` · ${dayLabel(p.removed_at)}` : ''}">Removed</span>`
            : ''}
          ${p.flagged ? html`<span class="pill pill-flagged">Flagged</span>` : ''}
        </span>
        <span class="card-ring">${fitRing(p.fit_score, 40)}</span>
      </div>
      <div class="card-body">
        <div class="card-top">
          <span class="card-price mono">${priceLabel(p)}</span>
          ${age ? html`<span class="card-age mono">${age}</span>` : ''}
        </div>
        <div class="card-title">${p.title}</div>
        ${reason
          ? ''
          : html`<div class="card-meta">
              <span>${areaLine(p, areas)}</span>
              ${beach ? html`<span class="mono">${beach}</span>` : ''}
              ${bedrooms ? html`<span class="mono">${bedrooms}</span>` : ''}
            </div>`}
        ${reason
          ? html`<div class="card-reason">${(p.reasons || []).join(' · ')}</div>`
          : html`<div class="chips">${featureChips(p).map((f) => html`<span class="chip">${f}</span>`)}</div>`}
      </div>
    </a>
    ${p.map_url
      ? html`<a class="pin-link card-pin" href="${p.map_url}" target="_blank" rel="noopener"
          aria-label="Open the map pin for ${p.title}">${icons.pin()}</a>`
      : ''}
  </article>`;
}

// ---------------------------------------------------------------------------
// Filter panel
// ---------------------------------------------------------------------------

function checkboxes(items, name) {
  return items.map(
    (i) => html`<label class="check"><input type="checkbox" data-filter="${name}" value="${i.value}" />
      <span>${i.label}</span></label>`
  );
}

function buildFilterPanel({ areas, onChange, sources }) {
  const panel = document.createElement('form');
  panel.className = 'filters';
  panel.setAttribute('novalidate', '');
  const west = areas.filter((a) => a.group === 'west').map((a) => ({ value: a.id, label: a.label }));
  const bukit = areas.filter((a) => a.group === 'bukit').map((a) => ({ value: a.id, label: a.label }));

  setHtml(
    panel,
    html`<div class="filter-group">
      <label class="label" for="f-q">Search</label>
      <input type="search" id="f-q" data-filter="q" placeholder="Title, ref or words" />
    </div>

    <div class="filter-group">
      <span class="label">Area</span>
      <div class="group-label">West coast</div>
      <div class="filter-cols">${checkboxes(west, 'area')}</div>
      <div class="group-label">Bukit</div>
      <div class="filter-cols">${checkboxes(bukit, 'bukit-area')}</div>
    </div>

    <div class="filter-group">
      <span class="label">Bedrooms</span>
      <div class="chips" data-role="bedrooms">
        ${BEDROOMS.map((b) => html`<button type="button" class="chip" data-bedrooms="${b}" aria-pressed="false">${b}</button>`)}
      </div>
    </div>

    <div class="filter-group">
      <span class="label">Price per month</span>
      <div class="range-readout"><span class="mono" data-role="price-readout">15 – 80 M</span></div>
      <div class="range-dual">
        <input type="range" data-role="min" min="${PRICE_MIN_M}" max="${PRICE_MAX_M}" step="${PRICE_STEP_M}"
          aria-label="Lowest price, million IDR per month" />
        <input type="range" data-role="max" min="${PRICE_MIN_M}" max="${PRICE_MAX_M}" step="${PRICE_STEP_M}"
          aria-label="Highest price, million IDR per month" />
      </div>
    </div>

    <div class="filter-group">
      <span class="label">Beach within</span>
      <div class="range-readout"><span class="mono" data-role="beach-readout">any</span></div>
      <input type="range" data-role="beach" min="0" max="${BEACH_MAX_KM}" step="0.5"
        aria-label="Maximum distance to the beach, km" />
    </div>

    <div class="filter-group">
      <span class="label">Land size</span>
      <div class="range-readout"><span class="mono" data-role="land-readout">0 – 2000 m²</span></div>
      <div class="range-dual">
        <input type="range" data-role="land-min" min="${LAND_MIN_M2}" max="${LAND_MAX_M2}" step="${LAND_STEP_M2}"
          aria-label="Lowest land size, square metres" />
        <input type="range" data-role="land-max" min="${LAND_MIN_M2}" max="${LAND_MAX_M2}" step="${LAND_STEP_M2}"
          aria-label="Highest land size, square metres" />
      </div>
    </div>

    <div class="filter-group">
      <span class="label">House size</span>
      <div class="range-readout"><span class="mono" data-role="build-readout">0 – 600 m²</span></div>
      <div class="range-dual">
        <input type="range" data-role="build-min" min="${BUILD_MIN_M2}" max="${BUILD_MAX_M2}" step="${BUILD_STEP_M2}"
          aria-label="Lowest house size, square metres" />
        <input type="range" data-role="build-max" min="${BUILD_MIN_M2}" max="${BUILD_MAX_M2}" step="${BUILD_STEP_M2}"
          aria-label="Highest house size, square metres" />
      </div>
    </div>

    <div class="filter-group">
      <span class="label">Furnishing</span>
      <div class="seg" data-role="furnished" role="group" aria-label="Furnishing">
        <button type="button" value="any" aria-pressed="true">Any</button>
        <button type="button" value="1" aria-pressed="false">Furnished</button>
        <button type="button" value="0" aria-pressed="false">Unfurnished</button>
      </div>
    </div>

    <div class="filter-group">
      <span class="label">Term</span>
      <div class="seg" data-role="term" role="group" aria-label="Term">
        <button type="button" value="any" aria-pressed="true">Any</button>
        <button type="button" value="monthly" aria-pressed="false">Monthly</button>
        <button type="button" value="yearly" aria-pressed="false">Yearly</button>
      </div>
    </div>

    <div class="filter-group">
      <span class="label">Posted within</span>
      <div class="seg seg-tap" data-role="age" role="group" aria-label="Posted within">
        ${AGE_OPTIONS.map(([value, label]) => html`<button type="button" value="${value}" aria-pressed="false">${label}</button>`)}
      </div>
    </div>

    <div class="filter-group">
      <span class="label">Removed</span>
      <div class="seg seg-tap" data-role="removed" role="group" aria-label="Removed">
        ${REMOVED_OPTIONS.map(([value, label]) => html`<button type="button" value="${value}" aria-pressed="false">${label}</button>`)}
      </div>
    </div>

    <div class="filter-group">
      <span class="label">Features</span>
      <div class="filter-cols">
        ${checkboxes(FEATURES.map((f) => ({ value: f, label: FEATURE_LABELS[f] })), 'features')}
      </div>
    </div>

    <div class="filter-group">
      <span class="label">Status</span>
      <div class="chips" data-role="status">
        ${Object.entries(STATUS_LABELS).map(
          ([value, label]) => html`<button type="button" class="chip" data-status="${value}" aria-pressed="false">${label}</button>`
        )}
      </div>
    </div>

    <div class="filter-group">
      <label class="label" for="f-source">Source</label>
      <select id="f-source" data-role="source">
        <option value="">Any source</option>
        ${sources.map((s) => html`<option value="${s}">${s}</option>`)}
      </select>
    </div>

    <div class="filter-group">
      <label class="check"><input type="checkbox" data-role="assessed" /><span>Assessed on location</span></label>
      <label class="check"><input type="checkbox" data-role="hide-rejected" /><span>Hide rejected</span></label>
      <label class="check"><input type="checkbox" data-role="in-filter" /><span>In-filter only</span></label>
    </div>

    <button type="button" class="btn btn-sm" data-role="reset">Reset filters</button>`
  );

  // Areas are two blocks but one filter; normalise the second block's name.
  for (const input of $$('[data-filter="bukit-area"]', panel)) input.dataset.filter = 'area';

  const readouts = {
    price: $('[data-role="price-readout"]', panel),
    beach: $('[data-role="beach-readout"]', panel),
    land: $('[data-role="land-readout"]', panel),
    build: $('[data-role="build-readout"]', panel),
  };
  const minEl = $('[data-role="min"]', panel);
  const maxEl = $('[data-role="max"]', panel);
  const beachEl = $('[data-role="beach"]', panel);
  const landMinEl = $('[data-role="land-min"]', panel);
  const landMaxEl = $('[data-role="land-max"]', panel);
  const buildMinEl = $('[data-role="build-min"]', panel);
  const buildMaxEl = $('[data-role="build-max"]', panel);

  /** Paint the panel from the filter state (never rebuilt — a drag keeps its grip). */
  function sync(f) {
    for (const input of $$('input[type="checkbox"][data-filter]', panel)) {
      input.checked = (f[input.dataset.filter] || []).includes(input.value);
    }
    $('#f-q', panel).value = f.q || '';
    for (const b of $$('[data-bedrooms]', panel)) {
      b.setAttribute('aria-pressed', String((f.bedrooms || []).includes(Number(b.dataset.bedrooms))));
    }
    for (const b of $$('[data-status]', panel)) {
      b.setAttribute('aria-pressed', String((f.status || []).includes(b.dataset.status)));
    }
    for (const group of ['furnished', 'term']) {
      for (const b of $$(`[data-role="${group}"] button`, panel)) {
        b.setAttribute('aria-pressed', String((f[group] || 'any') === b.value));
      }
    }
    for (const b of $$('[data-role="age"] button', panel)) {
      b.setAttribute('aria-pressed', String(String(f.max_age_days ?? '') === b.value));
    }
    for (const b of $$('[data-role="removed"] button', panel)) {
      b.setAttribute('aria-pressed', String((f.removed || 'hide') === b.value));
    }
    const minM = f.min != null ? f.min / 1e6 : PRICE_MIN_M;
    const maxM = f.max != null ? f.max / 1e6 : PRICE_MAX_M;
    minEl.value = String(minM);
    maxEl.value = String(maxM);
    const trim = (n) => (Number.isInteger(n) ? n : n.toFixed(1));
    readouts.price.textContent =
      f.min == null && f.max == null ? `${PRICE_MIN_M} – ${PRICE_MAX_M} M · any` : `${trim(minM)} – ${trim(maxM)} M`;
    beachEl.value = String(f.beach ?? BEACH_MAX_KM);
    readouts.beach.textContent = f.beach == null ? 'any distance' : `${f.beach} km`;
    const landLo = f.land_min ?? LAND_MIN_M2;
    const landHi = f.land_max ?? LAND_MAX_M2;
    landMinEl.value = String(landLo);
    landMaxEl.value = String(landHi);
    readouts.land.textContent =
      f.land_min == null && f.land_max == null ? `${LAND_MIN_M2} – ${LAND_MAX_M2} m² · any` : `${landLo} – ${landHi} m²`;
    const buildLo = f.build_min ?? BUILD_MIN_M2;
    const buildHi = f.build_max ?? BUILD_MAX_M2;
    buildMinEl.value = String(buildLo);
    buildMaxEl.value = String(buildHi);
    readouts.build.textContent =
      f.build_min == null && f.build_max == null ? `${BUILD_MIN_M2} – ${BUILD_MAX_M2} m² · any` : `${buildLo} – ${buildHi} m²`;
    $('[data-role="source"]', panel).value = f.source || '';
    $('[data-role="assessed"]', panel).checked = f.assessed === 'done';
    $('[data-role="hide-rejected"]', panel).checked =
      !(f.status || []).includes('rejected') && !(f.status || []).includes('all');
    $('[data-role="in-filter"]', panel).checked = f.scope === 'in_filter';
  }

  function listFrom(selector, key) {
    return $$(selector, panel)
      .filter((i) => i.checked)
      .map((i) => (key === 'number' ? Number(i.value) : i.value));
  }

  panel.addEventListener('change', (event) => {
    const t = event.target;
    if (t.dataset.filter === 'area') onChange({ area: listFrom('[data-filter="area"]') });
    else if (t.dataset.filter === 'features') onChange({ features: listFrom('[data-filter="features"]') });
    else if (t.dataset.role === 'source') onChange({ source: t.value || null });
    else if (t.dataset.role === 'assessed') onChange({ assessed: t.checked ? 'done' : null });
    else if (t.dataset.role === 'in-filter') onChange({ scope: t.checked ? 'in_filter' : 'all' });
    else if (t.dataset.role === 'hide-rejected') {
      onChange((f) => ({ status: t.checked ? (f.status || []).filter((s) => s !== 'rejected' && s !== 'all') : ['all'] }));
    }
  });

  panel.addEventListener('input', (event) => {
    const role = event.target.dataset.role;
    if (role === 'min' || role === 'max') {
      let lo = Number(minEl.value);
      let hi = Number(maxEl.value);
      if (lo > hi) {
        if (role === 'min') hi = lo;
        else lo = hi;
        minEl.value = String(lo);
        maxEl.value = String(hi);
      }
      const full = lo === PRICE_MIN_M && hi === PRICE_MAX_M;
      const trim = (n) => (Number.isInteger(n) ? n : n.toFixed(1));
      readouts.price.textContent = full ? `${PRICE_MIN_M} – ${PRICE_MAX_M} M · any` : `${trim(lo)} – ${trim(hi)} M`;
      onChange({ min: full ? null : Math.round(lo * 1e6), max: full ? null : Math.round(hi * 1e6) });
    } else if (role === 'beach') {
      const km = Number(beachEl.value);
      const any = km >= BEACH_MAX_KM;
      readouts.beach.textContent = any ? 'any distance' : `${km} km`;
      onChange({ beach: any ? null : km });
    } else if (role === 'land-min' || role === 'land-max') {
      let lo = Number(landMinEl.value);
      let hi = Number(landMaxEl.value);
      if (lo > hi) {
        if (role === 'land-min') hi = lo;
        else lo = hi;
        landMinEl.value = String(lo);
        landMaxEl.value = String(hi);
      }
      const full = lo === LAND_MIN_M2 && hi === LAND_MAX_M2;
      readouts.land.textContent = full ? `${LAND_MIN_M2} – ${LAND_MAX_M2} m² · any` : `${lo} – ${hi} m²`;
      onChange({ land_min: full ? null : lo, land_max: full ? null : hi });
    } else if (role === 'build-min' || role === 'build-max') {
      let lo = Number(buildMinEl.value);
      let hi = Number(buildMaxEl.value);
      if (lo > hi) {
        if (role === 'build-min') hi = lo;
        else lo = hi;
        buildMinEl.value = String(lo);
        buildMaxEl.value = String(hi);
      }
      const full = lo === BUILD_MIN_M2 && hi === BUILD_MAX_M2;
      readouts.build.textContent = full ? `${BUILD_MIN_M2} – ${BUILD_MAX_M2} m² · any` : `${lo} – ${hi} m²`;
      onChange({ build_min: full ? null : lo, build_max: full ? null : hi });
    } else if (event.target.id === 'f-q') {
      onChange({ q: event.target.value.trim() });
    }
  });

  panel.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const { bedrooms, status } = button.dataset;
    if (bedrooms) {
      const n = Number(bedrooms);
      onChange((f) => ({
        bedrooms: (f.bedrooms || []).includes(n) ? f.bedrooms.filter((b) => b !== n) : [...(f.bedrooms || []), n].sort(),
      }));
    } else if (status) {
      onChange((f) => ({
        status: (f.status || []).includes(status)
          ? f.status.filter((s) => s !== status)
          : [...(f.status || []).filter((s) => s !== 'all'), status],
      }));
    } else if (button.parentElement?.dataset.role === 'furnished') {
      onChange({ furnished: button.value });
    } else if (button.parentElement?.dataset.role === 'term') {
      onChange({ term: button.value });
    } else if (button.parentElement?.dataset.role === 'age') {
      onChange({ max_age_days: button.value ? Number(button.value) : null });
    } else if (button.parentElement?.dataset.role === 'removed') {
      onChange({ removed: button.value });
    } else if (button.dataset.role === 'reset') {
      onChange('reset');
    }
  });

  return { panel, sync };
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export async function mountHome(el, ctx) {
  const { api, store } = ctx;
  const areas = store.get().areas || [];
  const knownSources = new Set(['bhi', 'manual']);
  let alive = true;

  setHtml(
    el,
    html`<div class="home-layout">
      <aside class="rail" id="rail"><h2 class="rail-title">Filters</h2></aside>
      <div class="home-main">
        <div class="toolbar">
          <button type="button" class="btn btn-sm filters-toggle" id="filters-btn">
            ${icons.filter()}<span>Filters</span><span class="filter-count" id="filter-count" hidden></span>
          </button>
          <div class="seg" id="sort" role="group" aria-label="Sort listings">
            ${SORTS.map(([value, label]) => html`<button type="button" value="${value}" aria-pressed="false">${label}</button>`)}
          </div>
        </div>
        <div class="section-head"><h2 id="list-title">Listings</h2><span class="small muted" id="list-count"></span></div>
        <div class="grid" id="grid"><p class="loading">Loading…</p></div>
        <p class="small muted" id="updated"></p>
      </div>
    </div>`
  );

  const grid = $('#grid', el);
  const rail = $('#rail', el);
  const { panel, sync } = buildFilterPanel({
    areas,
    sources: [...knownSources],
    onChange: (patch) => {
      const filters = store.get().filters;
      if (patch === 'reset') {
        store.set({ filters: defaultFilters() });
      } else {
        const next = typeof patch === 'function' ? patch(filters) : patch;
        store.set({ filters: { ...filters, ...next } });
      }
      sync(store.get().filters);
      paintToolbar();
      reload();
    },
  });

  const mq = window.matchMedia('(min-width: 900px)');
  function place() {
    if (mq.matches) {
      closeSheet();
      rail.appendChild(panel);
    } else if (panel.parentElement === rail) {
      panel.remove();
    }
  }
  mq.addEventListener('change', place);

  function paintToolbar() {
    const f = store.get().filters;
    for (const b of $$('#sort button', el)) b.setAttribute('aria-pressed', String((f.sort || 'worth') === b.value));
    const badge = $('#filter-count', el);
    const n = activeFilterCount(f);
    badge.textContent = String(n);
    badge.hidden = n === 0;
  }

  function rememberSources(rows) {
    let added = false;
    for (const r of rows) {
      if (r.source && !knownSources.has(r.source)) {
        knownSources.add(r.source);
        added = true;
      }
    }
    if (!added) return;
    const select = $('[data-role="source"]', panel);
    const current = store.get().filters.source || '';
    setHtml(
      select,
      html`<option value="">Any source</option>${[...knownSources].sort().map((s) => html`<option value="${s}">${s}</option>`)}`
    );
    select.value = current;
  }

  const reload = debounce(async () => {
    const filters = store.get().filters;
    const query = filtersToQuery(filters);
    try {
      const fetched = await api.get(`/api/properties?${query}`);
      if (!alive) return;
      const rows = filters.sort === 'worth' ? worthOrder(fetched) : fetched;
      rememberSources(fetched);
      $('#list-count', el).textContent = `${rows.length} listing${rows.length === 1 ? '' : 's'}`;
      setHtml(
        grid,
        rows.length
          ? rows.map((p) => cardHtml(p, areas))
          : html`<p class="empty">Nothing matches these filters. Try widening the price range or turning off "In-filter only".</p>`
      );
      // The detail page's prev/next arrows read this: the ordered ids of whatever the
      // list last rendered (any sort, filters applied), and the query that produced it.
      store.set({ list_ids: rows.map((p) => p.id), list_query: query });
    } catch (err) {
      if (!alive) return;
      setHtml(grid, html`<p class="empty">Could not load listings: ${err.message}</p>`);
    }
  }, 220);

  async function loadUpdated() {
    try {
      const runs = await api.get('/api/runs?limit=1');
      if (!alive || !runs.length) return;
      const run = runs[0];
      const when = run.finished_at || run.started_at;
      $('#updated', el).textContent = run.finished_at
        ? `Updated ${makassarTime(when)} · ${makassarDate(when)} (${run.kind})`
        : `${run.kind} run in progress since ${makassarTime(when)}`;
    } catch {
      /* no runs yet */
    }
  }

  $('#filters-btn', el).addEventListener('click', () => {
    openSheet('Filters', panel, { onClose: place });
  });

  $('#sort', el).addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    store.set({ filters: { ...store.get().filters, sort: button.value } });
    paintToolbar();
    reload();
  });

  place();
  sync(store.get().filters);
  paintToolbar();
  reload();
  loadUpdated();

  return () => {
    alive = false;
    reload.cancel?.();
    mq.removeEventListener('change', place);
    closeSheet();
  };
}

export default mountHome;
