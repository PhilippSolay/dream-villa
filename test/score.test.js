import test from 'node:test';
import assert from 'node:assert/strict';

import { inBand, hardFilters, scopeFrom, fitScore, fitPoints, reasonsFor, scoreRow, beachFactor } from '../src/scrape/score.js';
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS } from '../src/defaults.js';

/** A row that passes every hard filter, with no features known. */
const base = () => ({
  key: 'bhi:RF1',
  area: 'cemagi',
  sub_area: 'Beach Side',
  bedrooms: 2,
  extra_rooms: 0,
  price_month_idr: 40_000_000,
  beach_km: 0.9,
  style: 'modern',
  red_flags: '[]',
  status: 'new',
});

/** Everything known and good — the 100-point row. */
const perfect = () => ({
  ...base(),
  living_open: true,
  airy: true,
  pool: true,
  garden: true,
  view: 'ocean',
  kitchen_full: true,
  aircon: true,
  furnished: 1,
  furniture_quality: 3,
  workspace: true,
  joglo: true,
});

// ---------------------------------------------------------------------------
// inBand
// ---------------------------------------------------------------------------

test('inBand — bedrooms 1–4, 15–80 M, target areas', () => {
  assert.equal(inBand(base()), true);
  assert.equal(inBand({ ...base(), bedrooms: 4 }), true);
  assert.equal(inBand({ ...base(), bedrooms: 5 }), false);
  assert.equal(inBand({ ...base(), bedrooms: 0 }), false);
  assert.equal(inBand({ ...base(), bedrooms: null }), false, 'unknown bedrooms fail the band');
  assert.equal(inBand({ ...base(), price_month_idr: 15_000_000 }), true);
  assert.equal(inBand({ ...base(), price_month_idr: 80_000_000 }), true);
  assert.equal(inBand({ ...base(), price_month_idr: 14_999_999 }), false);
  assert.equal(inBand({ ...base(), price_month_idr: 80_000_001 }), false);
  assert.equal(inBand({ ...base(), price_month_idr: null }), false, 'unknown price fails the band');
  assert.equal(inBand({ ...base(), area: 'other' }), false);
  assert.equal(inBand({ ...base(), area: 'mengwi' }), true);
});

// ---------------------------------------------------------------------------
// hardFilters
// ---------------------------------------------------------------------------

test('hardFilters — a clean row passes', () => {
  const got = hardFilters(base());
  assert.deepEqual(got, { pass: true, fails: [], unknowns: [] });
  assert.equal(scopeFrom(base()), 'in_filter');
});

test('hardFilters — rooms: >=1 bedroom, bedrooms+extra >= 2, bedrooms <= 3', () => {
  assert.deepEqual(hardFilters({ ...base(), bedrooms: 1, extra_rooms: 0 }).fails, ['rooms']);
  assert.equal(hardFilters({ ...base(), bedrooms: 1, extra_rooms: 1 }).pass, true);
  assert.equal(hardFilters({ ...base(), bedrooms: 3 }).pass, true);
  assert.deepEqual(hardFilters({ ...base(), bedrooms: 4 }).fails, ['rooms']);
  assert.deepEqual(hardFilters({ ...base(), bedrooms: 0, extra_rooms: 5 }).fails, ['rooms']);
  assert.deepEqual(hardFilters({ ...base(), bedrooms: null }).fails, ['rooms']);
});

test('hardFilters — budget 25–50 M inclusive', () => {
  assert.equal(hardFilters({ ...base(), price_month_idr: 25_000_000 }).pass, true);
  assert.equal(hardFilters({ ...base(), price_month_idr: 50_000_000 }).pass, true);
  assert.deepEqual(hardFilters({ ...base(), price_month_idr: 24_999_999 }).fails, ['budget']);
  assert.deepEqual(hardFilters({ ...base(), price_month_idr: 50_000_001 }).fails, ['budget']);
  assert.deepEqual(hardFilters({ ...base(), price_month_idr: null }).fails, ['budget']);
});

test('hardFilters — area must be in the target list', () => {
  assert.deepEqual(hardFilters({ ...base(), area: 'other' }).fails, ['area']);
  assert.deepEqual(hardFilters({ ...base(), area: null }).fails, ['area']);
  assert.equal(hardFilters({ ...base(), area: 'ungasan' }).pass, true);
});

test('hardFilters — beach distance is soft: never fails; unknown is recorded', () => {
  assert.equal(hardFilters({ ...base(), beach_km: 4 }).pass, true);
  assert.equal(hardFilters({ ...base(), beach_km: 9 }).pass, true);
  assert.deepEqual(hardFilters({ ...base(), beach_km: 9 }).fails, []);
  const unknown = hardFilters({ ...base(), beach_km: null });
  assert.equal(unknown.pass, true, 'no pins yet — an unknown distance must not drop the listing');
  assert.deepEqual(unknown.fails, []);
  assert.deepEqual(unknown.unknowns, ['beach_unknown']);
});

test('hardFilters — style and construction', () => {
  assert.deepEqual(hardFilters({ ...base(), style: 'balinese_old' }).fails, ['style']);
  assert.equal(hardFilters({ ...base(), style: 'joglo' }).pass, true);
  assert.deepEqual(hardFilters({ ...base(), red_flags: '["construction"]' }).fails, ['construction']);
  assert.deepEqual(hardFilters({ ...base(), red_flags: ['construction'] }).fails, ['construction']);
  assert.equal(hardFilters({ ...base(), red_flags: '["main_road"]' }).pass, true, 'main_road is not a hard filter');
});

test('hardFilters — several failures are all reported', () => {
  const got = hardFilters({ ...base(), bedrooms: 5, price_month_idr: 90_000_000, area: 'other' });
  assert.deepEqual(got.fails, ['rooms', 'budget', 'area']);
  assert.equal(got.pass, false);
  assert.equal(scopeFrom({ ...base(), area: 'other' }), 'market');
});

// ---------------------------------------------------------------------------
// fitScore
// ---------------------------------------------------------------------------

test('fitScore — everything true, ocean view, good furniture = 100', () => {
  assert.equal(fitScore(perfect(), DEFAULT_WEIGHTS), 100);
});

test('fitScore — everything unknown = 28 ((7+6+0+0+0+5+4+4+0+0 + beach 5) / 110)', () => {
  assert.equal(fitScore({}, DEFAULT_WEIGHTS), 28);
  assert.equal(fitScore({ ...base(), beach_km: null }, DEFAULT_WEIGHTS), 28);
});

test('fitScore — everything explicitly false = 0', () => {
  const none = {
    living_open: false, airy: false, pool: false, garden: false, view: 'none',
    kitchen_full: false, aircon: false, furnished: 0, furniture_quality: null,
    workspace: false, joglo: false, beach_km: 9,
  };
  assert.equal(fitScore(none, DEFAULT_WEIGHTS), 0);
});

test('fitScore — the §2 table, feature by feature', () => {
  const none = {
    living_open: false, airy: false, pool: false, garden: false, view: 'none',
    kitchen_full: false, aircon: false, furnished: 0, workspace: false, joglo: false, beach_km: 9,
  };
  // raw points, before normalisation to Σweights
  const only = (patch) => fitPoints({ ...none, ...patch }, DEFAULT_WEIGHTS);
  assert.equal(only({ living_open: true }), 15);
  assert.equal(only({ living_open: null }), 7, '15 / 2 rounds down to 7, as SPEC prints it');
  assert.equal(only({ airy: true }), 12);
  assert.equal(only({ airy: null }), 6);
  assert.equal(only({ pool: true }), 12);
  assert.equal(only({ garden: true }), 10);
  assert.equal(only({ view: 'ocean' }), 10);
  assert.equal(only({ view: 'rice' }), 7);
  assert.equal(only({ view: 'river' }), 7);
  assert.equal(only({ view: 'jungle' }), 7);
  assert.equal(only({ view: 'mountain' }), 0, 'not in the SPEC table — scores nothing');
  assert.equal(only({ view: null }), 0);
  assert.equal(only({ kitchen_full: true }), 10);
  assert.equal(only({ kitchen_full: null }), 5);
  assert.equal(only({ aircon: true }), 8);
  assert.equal(only({ aircon: null }), 4);
  assert.equal(only({ workspace: true }), 8);
  assert.equal(only({ joglo: true }), 7);
  // furniture
  assert.equal(only({ furnished: 1, furniture_quality: 3 }), 8);
  assert.equal(only({ furnished: 1, furniture_quality: 5 }), 8);
  assert.equal(only({ furnished: 1, furniture_quality: 2 }), 0);
  assert.equal(only({ furnished: 1, furniture_quality: null }), 4, 'furnished, quality unknown → half');
  assert.equal(only({ furnished: null }), 4, 'unknown whether furnished → half');
  assert.equal(only({ furnished: 0 }), 0);
  // beach (soft filter)
  assert.equal(only({ beach_km: 0.8 }), 10);
  assert.equal(only({ beach_km: 4.5 }), 5, 'midpoint of the 1–8 km ramp');
  assert.equal(only({ beach_km: null }), 5, 'unknown → half');
});

test('fitScore — accepts 1/0 as well as true/false (SQLite integers)', () => {
  const asInts = { ...perfect(), living_open: 1, airy: 1, pool: 1, garden: 1, kitchen_full: 1, aircon: 1, workspace: 1, joglo: 1 };
  assert.equal(fitScore(asInts, DEFAULT_WEIGHTS), 100);
});

test('fitScore — custom weights', () => {
  const w = { ...DEFAULT_WEIGHTS, pool: 20 };
  assert.equal(fitScore(perfect(), w), 100, 'clamped at 100');
  assert.equal(fitPoints({ pool: true, living_open: false, airy: false, kitchen_full: false, aircon: false, furnished: 0, beach_km: 9 }, w), 20);
  assert.equal(fitScore({ pool: true, living_open: false, airy: false, kitchen_full: false, aircon: false, furnished: 0, beach_km: 9 }, w), 17, '20 of 120');
});

test('fitScore — a low-priority pocket costs 10 points', () => {
  const row = { ...perfect(), sub_area: 'Tumbak Bayuh' };
  assert.equal(fitPoints(row, DEFAULT_WEIGHTS, []), 110);
  assert.equal(fitPoints(row, DEFAULT_WEIGHTS, ['tumbak bayuh']), 100);
  assert.equal(fitPoints(row, DEFAULT_WEIGHTS, ['Buduk']), 110);
  assert.equal(fitScore(row, DEFAULT_WEIGHTS, ['tumbak bayuh']), 91);
  // clamped at 0
  assert.equal(fitScore({ ...base(), sub_area: 'Tumbak Bayuh', living_open: false, airy: false, kitchen_full: false, aircon: false, furnished: 0 }, DEFAULT_WEIGHTS, ['Tumbak']), 0);
});

// ---------------------------------------------------------------------------
// reasonsFor
// ---------------------------------------------------------------------------

test('reasonsFor — short digest strings', () => {
  assert.deepEqual(reasonsFor({ ...perfect(), price_month_idr: 44_000_000, beach_km: 0.9, bedrooms: 3, view: 'rice' }), [
    '3BR',
    'Cemagi',
    '0.9 km to beach',
    '44 M/mo',
    'pool',
    'garden',
    'ricefield view',
    'joglo',
    'workspace',
  ]);
  assert.deepEqual(reasonsFor({ area: 'bingin', bedrooms: 2, extra_rooms: 1, price_month_idr: 37_500_000 }), [
    '2BR +1',
    'Bingin',
    '37.5 M/mo',
  ]);
  assert.deepEqual(reasonsFor({}), []);
});

// ---------------------------------------------------------------------------
// scoreRow
// ---------------------------------------------------------------------------

test('scoreRow — an in-filter, high-scoring row is flagged', () => {
  const got = scoreRow(perfect(), DEFAULT_CONFIG);
  assert.equal(got.scope, 'in_filter');
  assert.equal(got.fit_score, 100);
  assert.equal(got.flagged, 1);
  assert.deepEqual(got.red_flags, []);
  assert.ok(got.reasons.includes('pool'));
});

test('scoreRow — the flag rule', () => {
  // below the threshold
  assert.equal(scoreRow(base(), DEFAULT_CONFIG).flagged, 0, 'fit < 65');
  // market scope never flags
  assert.equal(scoreRow({ ...perfect(), area: 'other' }, DEFAULT_CONFIG).flagged, 0);
  // a red flag blocks it
  assert.equal(scoreRow({ ...perfect(), red_flags: '["main_road"]' }, DEFAULT_CONFIG).flagged, 0);
  // a rejected listing never flags
  assert.equal(scoreRow({ ...perfect(), status: 'rejected' }, DEFAULT_CONFIG).flagged, 0);
  // exactly on the threshold flags
  const onThreshold = { ...perfect(), joglo: false, workspace: false, garden: false, view: 'none', aircon: null };
  assert.equal(fitPoints(onThreshold, DEFAULT_WEIGHTS), 71);
  assert.equal(fitScore(onThreshold, DEFAULT_WEIGHTS), 65, '71 of 110 rounds to 65');
  assert.equal(scoreRow(onThreshold, DEFAULT_CONFIG).flagged, 1);
});

test('scoreRow — over_budget toggles on and off, person flags survive', () => {
  const over = scoreRow({ ...base(), price_month_idr: 60_000_000, red_flags: '["custom:noisy"]' }, DEFAULT_CONFIG);
  assert.deepEqual(over.red_flags, ['custom:noisy', 'over_budget']);
  assert.equal(over.scope, 'market', 'over budget also fails the hard filter');

  // price drops back into budget → over_budget goes, the person's flag stays
  const back = scoreRow({ ...base(), price_month_idr: 44_000_000, red_flags: JSON.stringify(over.red_flags) }, DEFAULT_CONFIG);
  assert.deepEqual(back.red_flags, ['custom:noisy']);
  assert.equal(back.scope, 'in_filter');

  // never added twice
  const again = scoreRow({ ...base(), price_month_idr: 60_000_000, red_flags: '["over_budget"]' }, DEFAULT_CONFIG);
  assert.deepEqual(again.red_flags, ['over_budget']);

  // an unknown price never sets it
  assert.deepEqual(scoreRow({ ...base(), price_month_idr: null }, DEFAULT_CONFIG).red_flags, []);
});

test('scoreRow — red_flags accepts a JSON string or an array', () => {
  assert.deepEqual(scoreRow({ ...base(), red_flags: ['main_road'] }, DEFAULT_CONFIG).red_flags, ['main_road']);
  assert.deepEqual(scoreRow({ ...base(), red_flags: '[]' }, DEFAULT_CONFIG).red_flags, []);
  assert.deepEqual(scoreRow({ ...base(), red_flags: 'not json' }, DEFAULT_CONFIG).red_flags, []);
  assert.deepEqual(scoreRow({ ...base(), red_flags: null }, DEFAULT_CONFIG).red_flags, []);
});

test('scoreRow — the source row is not mutated', () => {
  const row = { ...base(), price_month_idr: 60_000_000, red_flags: '[]' };
  const snapshot = JSON.stringify(row);
  scoreRow(row, DEFAULT_CONFIG);
  assert.equal(JSON.stringify(row), snapshot);
});

test('scoreRow — a custom config threshold and budget are honoured', () => {
  const cfg = { ...DEFAULT_CONFIG, flag_threshold: 95, budget_max: 70_000_000 };
  assert.equal(scoreRow({ ...perfect(), joglo: false }, cfg).flagged, 0, 'fit 93 < 95');
  const wider = scoreRow({ ...perfect(), price_month_idr: 60_000_000 }, cfg);
  assert.deepEqual(wider.red_flags, [], 'inside the widened budget');
  assert.equal(wider.scope, 'in_filter');
});

test('beachFactor — soft beach filter: full at <= 1 km, zero at 8 km, half when unknown', () => {
  assert.equal(beachFactor(0.5), 1);
  assert.equal(beachFactor(1), 1);
  assert.equal(beachFactor(8), 0);
  assert.equal(beachFactor(12), 0);
  assert.equal(beachFactor(null), 0.5);
  assert.ok(Math.abs(beachFactor(4.5) - 0.5) < 1e-9, '4.5 km is the midpoint');
  const near = fitScore({ ...perfect(), beach_km: 0.5 }, DEFAULT_WEIGHTS);
  const far = fitScore({ ...perfect(), beach_km: 7 }, DEFAULT_WEIGHTS);
  assert.equal(near, 100);
  assert.ok(far < near && far >= 90, `far villa scores lower but stays in_filter-eligible: ${far}`);
  assert.equal(scoreRow({ ...perfect(), price_month_idr: 40_000_000, beach_km: 9 }, DEFAULT_CONFIG).scope, 'in_filter');
});

test('fitScore — normalised to the sum of the weights, so edited weights stay 0–100', () => {
  const heavy = { ...DEFAULT_WEIGHTS, pool: 40 };
  assert.equal(fitScore(perfect(), heavy), 100);
  assert.ok(fitScore({ ...perfect(), pool: null }, heavy) < fitScore({ ...perfect(), pool: null }, DEFAULT_WEIGHTS));
});
