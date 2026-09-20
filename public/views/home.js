// #/ — flagged / new-today strip, filter drawer (bottom sheet on phone, rail on desktop),
// sort, and the card grid. SPEC §5 "Home".

import { filtersToQuery, activeFilterCount, defaultFilters, SORTS, sortOf } from '../lib/filters.js';
import { STAGES, STAGE_ORDER, loadStageQueues } from '../lib/flow.js';
import {
  $, $$, html, setHtml, toHtml, icons, toast, priceLabel, beachLabel, statusPill, fitRing,
  FEATURE_LABELS, STATUS_LABELS, STYLE_LABELS, openSheet, closeSheet, debounce, makassarDate, makassarTime, dayLabel,
} from '../lib/ui.js';
import { verdictPairHtml, verdictControlHtml, verdictFilterOptions, bindVerdicts, firstName } from '../lib/verdicts.js';
import { valueBadgesHtml } from '../lib/value.js';

const PRICE_MIN_M = 15;
const PRICE_MAX_M = 80;
const PRICE_STEP_M = 0.5;
const PRICE_BUCKET_M = 2.5; // one histogram bar per 2.5 M
const PRICE_BUCKET_COUNT = (PRICE_MAX_M - PRICE_MIN_M) / PRICE_BUCKET_M;
const HISTOGRAM_LIMIT = 500; // the API's ceiling; enough for the whole market today
const PAGE_SIZE = 100; // cards per fetch on Home; "Load more" appends the next page
const BEACH_MAX_KM = 10;
const LAND_MIN_M2 = 0;
const LAND_MAX_M2 = 2000;
const LAND_STEP_M2 = 50;
const BUILD_MIN_M2 = 0;
const BUILD_MAX_M2 = 600;
const BUILD_STEP_M2 = 10;
// The toolbar's one control: the viewer's own call. '' shows everything.
const MY_CALLS = [['', 'All'], ['yes', 'Yes'], ['maybe', 'Maybe'], ['no', 'No'], ['none', 'New']];
const BEDROOMS = [1, 2, 3, 4];
const FEATURES = Object.keys(FEATURE_LABELS);
const AGE_OPTIONS = [['', 'Any'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']];
const STYLES = Object.keys(STYLE_LABELS);
const ANCHOR_MIN_KM = 0.5;
const ANCHOR_MAX_KM = 15;
const ANCHOR_DEFAULT_KM = 3;
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

function featureChips(p, max = 4) {
  const out = [];
  if (p.style && STYLE_LABELS[p.style]) out.push(STYLE_LABELS[p.style]);
  if (p.pool === 1) out.push('Pool');
  if (p.garden === 1) out.push('Garden');
  if (p.view && p.view !== 'none') out.push(`${p.view.charAt(0).toUpperCase()}${p.view.slice(1)} view`);
  if (p.joglo === 1) out.push('Joglo');
  if (p.living_open === 1) out.push('Open living');
  if (p.airy === 1) out.push('Airy');
  if (p.kitchen_full === 1) out.push('Full kitchen');
  if (p.workspace === 1) out.push('Workspace');
  if (p.aircon === 1) out.push('Aircon');
  return [...new Set(out)].slice(0, max); // style 'joglo' and the joglo flag both say Joglo
}

/** "2.1 km · Gym" for every anchor the listing has a distance to. */
function anchorLine(p) {
  const near = (p.anchors || []).filter((a) => a.km != null);
  if (!near.length) return '';
  return html`<div class="card-anchors mono">${near.map((a) => html`<span>${a.km} km <span class="muted">${a.name}</span></span>`)}</div>`;
}

function areaLine(p, areas) {
  const label = areas.find((a) => a.id === p.area)?.label || p.area || 'Unknown area';
  return p.sub_area ? `${label} · ${p.sub_area}` : label;
}

/**
 * @param {object} p the listing row
 * @param {Array} areas
 * @param {{reason?: boolean, viewer?: {user: object, users: object[]}|null}} [opts]
 *   `viewer` adds the shared-search foot: both people's calls and the viewer's own control.
 */
export function cardHtml(p, areas, { reason = false, viewer = null } = {}) {
  const bedrooms = p.bedrooms == null ? null : `${p.bedrooms} BR${p.extra_rooms ? ` +${p.extra_rooms}` : ''}`;
  const beach = beachLabel(p.beach_km);
  const age = ageLabel(p.first_seen);
  const removed = p.availability === 'gone' || p.availability === 'unlisted' || p.status === 'gone';
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
          ${p.flagged ? html`<span class="pill pill-flagged">Featured</span>` : ''}
        </span>
        <span class="card-ring">${fitRing(p.fit_score, 40)}</span>
      </div>
      <div class="card-body">
        <div class="card-top">
          <span class="card-price mono">${priceLabel(p)}</span>
          ${age ? html`<span class="card-age mono">${age}</span>` : ''}
        </div>
        <div class="card-title">${p.title}</div>
        ${reason ? '' : valueBadgesHtml(p, areas.find((a) => a.id === p.area)?.label, { short: true })}
        ${reason
          ? ''
          : html`<div class="card-meta">
              <span>${areaLine(p, areas)}</span>
              ${beach ? html`<span class="mono">${beach}</span>` : ''}
              ${bedrooms ? html`<span class="mono">${bedrooms}</span>` : ''}
            </div>${anchorLine(p)}`}
        ${reason
          ? html`<div class="card-reason">${(p.reasons || []).join(' · ')}</div>`
          : html`<div class="chips">${featureChips(p).map((f) => html`<span class="chip">${f}</span>`)}</div>`}
      </div>
    </a>
    ${p.map_url
      ? html`<a class="pin-link card-pin" href="${p.map_url}" target="_blank" rel="noopener"
          aria-label="Open the map pin for ${p.title}">${icons.pin()}</a>`
      : ''}
    ${viewer?.user
      ? html`<div class="card-foot">${verdictPairHtml(p, viewer)}${verdictControlHtml(p, viewer.user.id, { compact: true })}</div>`
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

/** One coast: its heading with All / Clear, then the checkboxes. Both coasts feed the one `area` filter. */
function areaGroup(label, key, items) {
  return html`<div class="group-head">
      <span class="group-label">${label}</span>
      <span class="group-actions">
        <button type="button" class="link-btn" data-area-set="${key}" data-area-mode="all">All</button>
        <button type="button" class="link-btn" data-area-set="${key}" data-area-mode="none">Clear</button>
      </span>
    </div>
    <div class="filter-cols">${checkboxes(items, 'area')}</div>`;
}

/** Position of a range input's value along its track, as a CSS percentage. */
function rangePct(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const span = max - min || 1;
  return `${((Number(input.value) - min) / span) * 100}%`;
}

/** Summary line for the collapsed Area group: "Any", the names, or a count. */
function areaHint(selected, areas) {
  if (!selected.length) return 'Any';
  if (selected.length > 2) return `${selected.length} selected`;
  return selected.map((id) => areas.find((a) => a.id === id)?.label || id).join(', ');
}

function buildFilterPanel({ areas, onChange, sources, otherName = '', anchors = [], onAnchorAdd, onAnchorRemove }) {
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

    <details class="filter-group filter-area" open>
      <summary>
        <span class="label">Area</span>
        <span class="summary-hint"><span data-role="area-hint">Any</span>${icons.chevron()}</span>
      </summary>
      ${areaGroup('West coast', 'west', west)}
      ${areaGroup('Bukit', 'bukit', bukit)}
    </details>

    <div class="filter-group">
      <span class="label">Bedrooms</span>
      <div class="chips" data-role="bedrooms">
        ${BEDROOMS.map((b) => html`<button type="button" class="chip" data-bedrooms="${b}" aria-pressed="false">${b}</button>`)}
      </div>
    </div>

    <div class="filter-group">
      <span class="label">Price per month</span>
      <div class="range-readout"><span class="mono" data-role="price-readout">15 – 80 M</span></div>
      <div class="range-hist" data-role="price-hist" aria-hidden="true"></div>
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
      <span class="label">Style</span>
      <div class="chips" data-role="style">
        ${STYLES.map((s) => html`<button type="button" class="chip" data-style="${s}" aria-pressed="false">${STYLE_LABELS[s]}</button>`)}
      </div>
    </div>

    <div class="filter-group">
      <label class="label" for="f-anchor">Near a place</label>
      <select id="f-anchor" data-role="anchor">
        <option value="">Anywhere</option>
        ${anchors.map((a) => html`<option value="${a.id}">${a.name}</option>`)}
      </select>
      <div class="anchor-km-row" data-role="anchor-km-row" hidden>
        <div class="range-readout" style="margin-top: 8px"><span class="mono" data-role="anchor-readout">${ANCHOR_DEFAULT_KM} km</span></div>
        <input type="range" data-role="anchor-km" min="${ANCHOR_MIN_KM}" max="${ANCHOR_MAX_KM}" step="0.5" aria-label="Within, km" />
        <button type="button" class="link-btn" data-role="anchor-remove">Remove this place</button>
      </div>
      <details class="anchor-add">
        <summary>Add a place</summary>
        <div class="anchor-form">
          <input type="text" data-role="anchor-name" placeholder="Name, e.g. Gym" maxlength="60" autocomplete="off" />
          <input type="text" data-role="anchor-location" placeholder="Google Maps link, or lat, lng" autocomplete="off" />
          <button type="button" class="btn btn-sm" data-role="anchor-add">Add place</button>
        </div>
      </details>
    </div>

    <div class="filter-group">
      <span class="label">Shared</span>
      <div class="chips" data-role="verdict">
        ${verdictFilterOptions(otherName).map(
          ([value, label]) => html`<button type="button" class="chip" data-verdict-filter="${value}" aria-pressed="false">${label}</button>`
        )}
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

  const histEl = $('[data-role="price-hist"]', panel);
  let histBars = [];

  // --- anchors: the select, the km slider, and the add / remove controls ------
  const anchorSelect = $('[data-role="anchor"]', panel);
  const anchorKmRow = $('[data-role="anchor-km-row"]', panel);
  const anchorKmEl = $('[data-role="anchor-km"]', panel);
  const anchorReadout = $('[data-role="anchor-readout"]', panel);
  let anchorList = anchors;

  /** Repaint the place list (after an add or remove); keeps the selection when it still exists. */
  function setAnchors(list) {
    anchorList = list;
    const current = anchorSelect.value;
    setHtml(
      anchorSelect,
      html`<option value="">Anywhere</option>${list.map((a) => html`<option value="${a.id}">${a.name}</option>`)}`
    );
    anchorSelect.value = list.some((a) => String(a.id) === current) ? current : '';
    anchorKmRow.hidden = !anchorSelect.value;
  }

  function submitAnchor() {
    const nameEl = $('[data-role="anchor-name"]', panel);
    const locEl = $('[data-role="anchor-location"]', panel);
    const name = nameEl.value.trim();
    const location = locEl.value.trim();
    if (!name || !location) {
      toast('A place needs a name and a location', 'error');
      return;
    }
    onAnchorAdd?.(name, location, () => {
      nameEl.value = '';
      locEl.value = '';
      $('.anchor-add', panel).open = false;
    });
  }

  /** Bars between the thumbs light up gold; the rest stay muted. */
  function paintHistogram() {
    if (!histBars.length) return;
    const lo = Number($('[data-role="min"]', panel).value);
    const hi = Number($('[data-role="max"]', panel).value);
    histBars.forEach((bar, i) => {
      const centre = PRICE_MIN_M + (i + 0.5) * PRICE_BUCKET_M;
      bar.classList.toggle('is-in', centre >= lo && centre <= hi);
    });
  }

  /** One bar per price bucket, scaled to the tallest inner bucket — the end buckets also
      hold everything beyond the slider's span, so they are capped rather than allowed to
      flatten the rest. `counts` comes from mountHome. */
  function setHistogram(counts) {
    const peak = Math.max(1, ...counts.slice(1, -1)) || Math.max(1, ...counts);
    setHtml(histEl, counts.map((c) => html`<span style="--h:${Math.min(100, (c / peak) * 100).toFixed(1)}%"></span>`));
    histBars = $$('span', histEl);
    paintHistogram();
  }

  /** Gold fill between the thumbs (dual) or up to the thumb (single) — CSS reads these vars. */
  function paintRanges() {
    for (const dual of $$('.range-dual', panel)) {
      const [lo, hi] = $$('input[type="range"]', dual);
      dual.style.setProperty('--lo', rangePct(lo));
      dual.style.setProperty('--hi', rangePct(hi));
    }
    for (const single of $$('input[type="range"]:not(.range-dual input)', panel)) {
      single.style.setProperty('--val', rangePct(single));
    }
    paintHistogram();
  }

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
    for (const b of $$('[data-verdict-filter]', panel)) {
      b.setAttribute('aria-pressed', String((f.verdict || null) === b.dataset.verdictFilter));
    }
    for (const b of $$('[data-style]', panel)) {
      b.setAttribute('aria-pressed', String((f.style || []).includes(b.dataset.style)));
    }
    const anchorOn = f.anchor != null && anchorList.some((a) => a.id === f.anchor);
    anchorSelect.value = anchorOn ? String(f.anchor) : '';
    const km = f.anchor_km ?? ANCHOR_DEFAULT_KM;
    anchorKmEl.value = String(km);
    anchorReadout.textContent = `${km} km`;
    anchorKmRow.hidden = !anchorOn;
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
    $('[data-role="area-hint"]', panel).textContent = areaHint(f.area || [], areas);
    paintRanges();
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
    else if (t.dataset.role === 'anchor') {
      const id = t.value ? Number(t.value) : null;
      onChange((f) => ({ anchor: id, anchor_km: id == null ? null : (f.anchor_km ?? ANCHOR_DEFAULT_KM) }));
    }
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
    } else if (role === 'anchor-km') {
      const km = Number(anchorKmEl.value);
      anchorReadout.textContent = `${km} km`;
      onChange({ anchor_km: km });
    } else if (event.target.id === 'f-q') {
      onChange({ q: event.target.value.trim() });
    }
    if (event.target.type === 'range') paintRanges();
  });

  // Enter in the add-a-place fields adds it (the panel is a form with no submit button).
  panel.addEventListener('keydown', (event) => {
    const role = event.target.dataset?.role;
    if (event.key === 'Enter' && (role === 'anchor-name' || role === 'anchor-location')) {
      event.preventDefault();
      submitAnchor();
    }
  });

  panel.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const { bedrooms, status, areaSet, areaMode, verdictFilter, style, role } = button.dataset;
    if (verdictFilter) {
      onChange((f) => ({ verdict: f.verdict === verdictFilter ? null : verdictFilter }));
    } else if (style) {
      onChange((f) => ({
        style: (f.style || []).includes(style) ? f.style.filter((s) => s !== style) : [...(f.style || []), style],
      }));
    } else if (role === 'anchor-add') {
      submitAnchor();
    } else if (role === 'anchor-remove') {
      if (anchorSelect.value) onAnchorRemove?.(Number(anchorSelect.value));
    } else if (areaSet) {
      const ids = (areaSet === 'west' ? west : bukit).map((a) => a.value);
      onChange((f) => {
        const rest = (f.area || []).filter((id) => !ids.includes(id));
        return { area: areaMode === 'all' ? [...rest, ...ids] : rest };
      });
    } else if (bedrooms) {
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

  return { panel, sync, setHistogram, setAnchors };
}

/** Listings per PRICE_BUCKET_M step across the slider's span; prices outside it land in the end buckets. */
export function priceBuckets(rows) {
  const counts = new Array(PRICE_BUCKET_COUNT).fill(0);
  for (const r of rows) {
    if (r.price_month_idr == null) continue;
    const m = Number(r.price_month_idr) / 1e6;
    const i = Math.floor((m - PRICE_MIN_M) / PRICE_BUCKET_M);
    counts[Math.max(0, Math.min(PRICE_BUCKET_COUNT - 1, i))] += 1;
  }
  return counts;
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
          <div class="seg" id="my-call" role="group" aria-label="Your call">
            ${MY_CALLS.map(([value, label]) => html`<button type="button" value="${value}" aria-pressed="false">${label}</button>`)}
          </div>
          <div class="flow-strip" id="flow-strip" role="group" aria-label="Work through the listings">
            ${STAGE_ORDER.map(
              (stage) => html`<button type="button" class="flow-chip" data-stage="${stage}" disabled title="${STAGES[stage].hint}">
                <span>${STAGES[stage].label}</span><b class="mono" data-count>…</b></button>`
            )}
          </div>
          <div class="sort-wrap" id="sort-wrap">
            <button type="button" class="btn btn-sm sort-btn" id="sort-btn" aria-haspopup="menu" aria-expanded="false" aria-label="Sort listings">
              ${icons.sort()}<span id="sort-label"></span>${icons.chevron()}
            </button>
            <div class="menu" id="sort-menu" role="menu" hidden>
              ${SORTS.map(([value, label]) => html`<button type="button" role="menuitemradio" aria-checked="false" value="${value}">${label}</button>`)}
            </div>
          </div>
          <span class="small muted toolbar-count" id="list-count"></span>
        </div>
        <div class="grid" id="grid"><p class="loading">Loading…</p></div>
        <div class="load-more" id="load-more" hidden>
          <button type="button" class="btn" id="load-more-btn">Load more</button>
        </div>
        <p class="small muted" id="updated"></p>
      </div>
    </div>`
  );

  const grid = $('#grid', el);
  const rail = $('#rail', el);
  const viewer = () => ({ user: store.get().user, users: store.get().users || [] });
  const other = (store.get().users || []).find((u) => u.id !== store.get().user?.id);

  let anchors = [];
  try {
    anchors = await api.get('/api/anchors');
  } catch {
    anchors = []; // the place list is a convenience; the rest of the panel must still work
  }
  if (!alive) return () => {};

  /** Re-read the places after a change; drop the filter if its place is gone. */
  async function refreshAnchors() {
    anchors = await api.get('/api/anchors');
    if (!alive) return;
    setAnchors(anchors);
    const f = store.get().filters;
    if (f.anchor != null && !anchors.some((a) => a.id === f.anchor)) {
      store.set({ filters: { ...f, anchor: null, anchor_km: null } });
    }
    sync(store.get().filters);
    paintToolbar();
    reload();
  }

  const { panel, sync, setHistogram, setAnchors } = buildFilterPanel({
    areas,
    sources: [...knownSources],
    otherName: firstName(other),
    anchors,
    onAnchorAdd: async (name, location, done) => {
      try {
        await api.post('/api/anchors', { name, location });
        done?.();
        toast(`${name} added`);
        await refreshAnchors();
      } catch (err) {
        toast(err.message || 'Could not add that place', 'error');
      }
    },
    onAnchorRemove: async (id) => {
      try {
        await api.del(`/api/anchors/${id}`);
        toast('Place removed');
        await refreshAnchors();
      } catch (err) {
        toast(err.message || 'Could not remove that place', 'error');
      }
    },
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
    for (const b of $$('#my-call button', el)) b.setAttribute('aria-pressed', String((f.my_verdict || '') === b.value));
    const badge = $('#filter-count', el);
    const n = activeFilterCount(f);
    badge.textContent = String(n);
    badge.hidden = n === 0;
    const sort = sortOf(f);
    $('#sort-label', el).textContent = SORTS.find(([v]) => v === sort)[1].split(',')[0];
    for (const b of $$('#sort-menu button', el)) b.setAttribute('aria-checked', String(b.value === sort));
  }

  // The sort menu: a small popover under its button; closes on a pick, outside tap, Escape.
  const sortMenu = $('#sort-menu', el);
  const sortBtn = $('#sort-btn', el);
  function toggleSortMenu(open = sortMenu.hidden) {
    sortMenu.hidden = !open;
    sortBtn.setAttribute('aria-expanded', String(open));
  }
  sortBtn.addEventListener('click', () => toggleSortMenu());
  sortMenu.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    toggleSortMenu(false);
    if (button.value === sortOf(store.get().filters)) return;
    store.set({ filters: { ...store.get().filters, sort: button.value } });
    paintToolbar();
    reload();
  });
  const onDocClick = (event) => {
    if (!sortMenu.hidden && !event.target.closest('#sort-wrap')) toggleSortMenu(false);
  };
  const onDocKey = (event) => {
    if (event.key === 'Escape' && !sortMenu.hidden) {
      toggleSortMenu(false);
      sortBtn.focus();
    }
  };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);

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

  // The price histogram shows the same search with the price limits lifted, so it only
  // needs refetching when something other than the price moved.
  let histogramKey = null;
  async function loadHistogram(filters) {
    const query = filtersToQuery({ ...filters, min: null, max: null }, { limit: HISTOGRAM_LIMIT });
    if (query === histogramKey) return;
    histogramKey = query;
    try {
      const rows = await api.get(`/api/properties?${query}`);
      if (!alive || query !== histogramKey) return;
      setHistogram(priceBuckets(rows));
    } catch {
      /* the bars are a hint, not a result — a failed fetch just leaves the last ones up */
    }
  }

  // The "Work through" launcher: one queue per stage under the current filters. Kept in
  // the store so the detail page's flow bar starts from the same list Home showed.
  let queuesKey = null;
  let queues = {};
  async function loadQueues(filters) {
    const key = filtersToQuery({ ...filters, status: [], sort: 'fit' });
    if (key === queuesKey) return;
    queuesKey = key;
    queues = await loadStageQueues(api, filters, store.get().user?.id);
    if (!alive || key !== queuesKey) return;
    for (const chip of $$('.flow-chip', el)) {
      const ids = queues[chip.dataset.stage] || [];
      chip.querySelector('[data-count]').textContent = String(ids.length);
      chip.disabled = ids.length === 0;
    }
  }

  // The list is paged: the first PAGE_SIZE rows on every filter change, then "Load more"
  // appends the next page under the same query. `page` is the state of what is shown.
  let page = { query: null, rows: [], total: 0 };
  const loadMoreWrap = $('#load-more', el);
  const loadMoreBtn = $('#load-more-btn', el);

  function paintCount() {
    const { rows, total } = page;
    const noun = `listing${total === 1 ? '' : 's'}`;
    $('#list-count', el).textContent = rows.length < total ? `${rows.length} of ${total} ${noun}` : `${total} ${noun}`;
    loadMoreWrap.hidden = rows.length >= total;
    const left = total - rows.length;
    loadMoreBtn.textContent = `Load ${Math.min(PAGE_SIZE, left)} more`;
  }

  function publishList() {
    // The detail page's prev/next arrows read this: the ordered ids of whatever the
    // list last rendered (any sort, filters applied), and the query that produced it.
    store.set({ list_ids: page.rows.map((p) => p.id), list_query: page.query, list_total: page.total });
  }

  const reload = debounce(async () => {
    const filters = store.get().filters;
    const query = filtersToQuery(filters, { limit: PAGE_SIZE });
    loadHistogram(filters);
    loadQueues(filters);
    try {
      const { rows, total } = await api.getPage(`/api/properties?${query}`);
      if (!alive) return;
      page = { query, rows, total };
      rememberSources(rows);
      paintCount();
      setHtml(
        grid,
        rows.length
          ? rows.map((p) => cardHtml(p, areas, { viewer: viewer() }))
          : html`<p class="empty">Nothing matches these filters. Try widening the price range or turning off "In-filter only".</p>`
      );
      publishList();
    } catch (err) {
      if (!alive) return;
      loadMoreWrap.hidden = true;
      setHtml(grid, html`<p class="empty">Could not load listings: ${err.message}</p>`);
    }
  }, 220);

  async function loadMore() {
    const startedFor = page.query;
    if (!startedFor || loadMoreBtn.disabled) return;
    loadMoreBtn.disabled = true;
    try {
      const query = filtersToQuery(store.get().filters, { limit: PAGE_SIZE, offset: page.rows.length });
      const { rows, total } = await api.getPage(`/api/properties?${query}`);
      // A filter change while this was in flight has already redrawn the grid; drop the page.
      if (!alive || page.query !== startedFor) return;
      const seen = new Set(page.rows.map((p) => p.id));
      const fresh = rows.filter((p) => !seen.has(p.id));
      page = { query: startedFor, rows: [...page.rows, ...fresh], total };
      rememberSources(fresh);
      grid.insertAdjacentHTML('beforeend', toHtml(fresh.map((p) => cardHtml(p, areas, { viewer: viewer() }))));
      paintCount();
      publishList();
    } catch (err) {
      if (!alive) return;
      toast(`Could not load more: ${err.message}`, 'error');
    } finally {
      if (alive) loadMoreBtn.disabled = false;
    }
  }
  loadMoreBtn.addEventListener('click', loadMore);

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

  // A verdict tap redraws just that card with the row the API sent back.
  const unbindVerdicts = bindVerdicts(el, {
    api,
    onSaved: (row, button) => {
      const card = button.closest('article.card');
      if (card && row) card.outerHTML = toHtml(cardHtml(row, areas, { viewer: viewer() }));
      ctx.refreshCounts?.();
    },
  });

  $('#flow-strip', el).addEventListener('click', (event) => {
    const chip = event.target.closest('.flow-chip');
    if (!chip || chip.disabled) return;
    const stage = chip.dataset.stage;
    const ids = queues[stage] || [];
    if (!ids.length) return;
    store.set({ flow: { stage, ids } });
    ctx.navigate(`#/p/${ids[0]}?flow=${stage}`);
  });

  $('#my-call', el).addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    store.set({ filters: { ...store.get().filters, my_verdict: button.value || null } });
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
    unbindVerdicts();
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onDocKey);
    mq.removeEventListener('change', place);
    closeSheet();
  };
}

export default mountHome;
