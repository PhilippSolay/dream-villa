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
  furnished: 'any',
  term: 'any',
  features: [],
  assessed: null,
  source: null,
  hide_gone: 1,
  flagged: null,
  q: '',
  sort: 'fit',
};

export function defaultFilters() {
  return { ...DEFAULT_FILTERS, status: [], area: [], bedrooms: [], features: [] };
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
  if (f.furnished && f.furnished !== 'any') p.set('furnished', f.furnished);
  if (f.term && f.term !== 'any') p.set('term', f.term);
  if (f.assessed) p.set('assessed', f.assessed);
  if (f.source) p.set('source', f.source);
  if (f.flagged === 1) p.set('flagged', '1');
  if (f.q) p.set('q', f.q);
  p.set('hide_gone', String(f.hide_gone ?? 1));
  p.set('sort', f.sort || 'fit');
  p.set('limit', String(limit));
  return p.toString();
}

/** How many filters differ from the defaults — the badge on the Filters button. */
export function activeFilterCount(f) {
  let n = 0;
  if (f.scope !== 'in_filter') n += 1;
  for (const key of ['status', 'area', 'bedrooms', 'features']) if (f[key]?.length) n += 1;
  if (f.min != null || f.max != null) n += 1;
  if (f.beach != null) n += 1;
  if (f.furnished && f.furnished !== 'any') n += 1;
  if (f.term && f.term !== 'any') n += 1;
  if (f.assessed) n += 1;
  if (f.source) n += 1;
  if (f.q) n += 1;
  if ((f.hide_gone ?? 1) !== 1) n += 1;
  return n;
}
