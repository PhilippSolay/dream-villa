import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeFilterCount, defaultFilters, filtersToQuery } from '../public/lib/filters.js';

test('filters: the list asks for every listing; the visible filters do the filtering', () => {
  const q = new URLSearchParams(filtersToQuery(defaultFilters()));
  assert.equal(q.get('scope'), 'all');
});

test('filters: a scope persisted before the in-filter switch went is ignored', () => {
  const stale = { ...defaultFilters(), scope: 'in_filter' };
  assert.equal(new URLSearchParams(filtersToQuery(stale)).get('scope'), 'all');
  assert.equal(activeFilterCount(stale), 0);
});
