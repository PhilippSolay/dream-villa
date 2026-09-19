// The filter state and its translation to GET /api/properties query params.
// Field names and values are exactly the API's (SPEC §4).

export const DEFAULT_FILTERS = {
  scope: 'in_filter',
  status: [],
  area: [],
  bedrooms: [],
  min: null,
  max: null,
  beach: null,
  land_min: null,
  land_max: null,
  build_min: null,
  build_max: null,
  furnished: 'any',
  term: 'any',
  features: [],
  assessed: null,
  source: null,
  removed: 'hide',
  max_age_days: null,
  flagged: null,
  verdict: null, // shared search: 'match' | 'waiting_me' | 'waiting_other' | 'disagree'
  style: [],
  anchor: null, // an anchor id; only meaningful together with anchor_km
  anchor_km: null,
  q: '',
  // 'worth' is a client-only display order (flagged, fit desc, then new-today, newest
  // first) — filtersToQuery sends the API its nearest real sort, 'fit', for that value.
  sort: 'worth',
};

export function defaultFilters() {
  return { ...DEFAULT_FILTERS, status: [], area: [], bedrooms: [], features: [], style: [] };
}

export function filtersToQuery(f, { limit = 200 } = {}) {
  const p = new URLSearchParams();
  p.set('scope', f.scope || 'in_filter');
  if (f.status?.length) p.set('status', f.status.join(','));
  if (f.area?.length) p.set('area', f.area.join(','));
  if (f.bedrooms?.length) p.set('bedrooms', f.bedrooms.join(','));
  if (f.features?.length) p.set('features', f.features.join(','));
  if (f.min != null) p.set('min', String(f.min));
  if (f.max != null) p.set('max', String(f.max));
  if (f.beach != null) p.set('beach', String(f.beach));
  if (f.land_min != null) p.set('land_min', String(f.land_min));
  if (f.land_max != null) p.set('land_max', String(f.land_max));
  if (f.build_min != null) p.set('build_min', String(f.build_min));
  if (f.build_max != null) p.set('build_max', String(f.build_max));
  if (f.furnished && f.furnished !== 'any') p.set('furnished', f.furnished);
  if (f.term && f.term !== 'any') p.set('term', f.term);
  if (f.assessed) p.set('assessed', f.assessed);
  if (f.source) p.set('source', f.source);
  if (f.max_age_days != null) p.set('max_age_days', String(f.max_age_days));
  if (f.flagged === 1) p.set('flagged', '1');
  if (f.verdict) p.set('verdict', f.verdict);
  if (f.style?.length) p.set('style', f.style.join(','));
  if (f.anchor != null && f.anchor_km != null) {
    p.set('anchor', String(f.anchor));
    p.set('anchor_km', String(f.anchor_km));
  }
  if (f.q) p.set('q', f.q);
  p.set('removed', f.removed || 'hide');
  p.set('sort', f.sort === 'worth' || !f.sort ? 'fit' : f.sort);
  p.set('limit', String(limit));
  return p.toString();
}

/** How many filters differ from the defaults — the badge on the Filters button. */
export function activeFilterCount(f) {
  let n = 0;
  if (f.scope !== 'in_filter') n += 1;
  for (const key of ['status', 'area', 'bedrooms', 'features', 'style']) if (f[key]?.length) n += 1;
  if (f.anchor != null && f.anchor_km != null) n += 1;
  if (f.min != null || f.max != null) n += 1;
  if (f.beach != null) n += 1;
  if (f.land_min != null || f.land_max != null) n += 1;
  if (f.build_min != null || f.build_max != null) n += 1;
  if (f.furnished && f.furnished !== 'any') n += 1;
  if (f.term && f.term !== 'any') n += 1;
  if (f.assessed) n += 1;
  if (f.source) n += 1;
  if (f.q) n += 1;
  if (f.max_age_days != null) n += 1;
  if (f.verdict) n += 1;
  if ((f.removed || 'hide') !== 'hide') n += 1;
  return n;
}
