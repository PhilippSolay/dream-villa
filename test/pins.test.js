import test from 'node:test';
import assert from 'node:assert/strict';

import { mapUrl, assignPin, computeBeach, placePins } from '../src/scrape/pins.js';
import { AREAS } from '../src/areas.js';

test('mapUrl builds a Google Maps query link', () => {
  assert.equal(mapUrl(-8.628, 115.099), 'https://www.google.com/maps?q=-8.628,115.099');
});

// ---------------------------------------------------------------------------
// assignPin
// ---------------------------------------------------------------------------

test('assignPin: no lat/lng, known area → centroid pin + map_url', () => {
  const row = { area: 'seseh' };
  const out = assignPin(row);
  assert.deepEqual([out.lat, out.lng], AREAS.seseh.centroid);
  assert.equal(out.pin_source, 'centroid');
  assert.equal(out.map_url, mapUrl(...AREAS.seseh.centroid));
  // source row not mutated
  assert.equal(row.lat, undefined);
});

test("assignPin: area 'other' with no lat/lng is left unchanged", () => {
  const row = { area: 'other' };
  const out = assignPin(row);
  assert.equal(out.lat, undefined);
  assert.equal(out.lng, undefined);
  assert.equal(out.pin_source, undefined);
  assert.equal(out.map_url, undefined);
});

test('assignPin: existing lat/lng kept, pin_source defaulted to listing_map when missing', () => {
  const row = { area: 'seseh', lat: -8.63, lng: 115.1 };
  const out = assignPin(row);
  assert.equal(out.lat, -8.63);
  assert.equal(out.lng, 115.1);
  assert.equal(out.pin_source, 'listing_map');
  assert.equal(out.map_url, mapUrl(-8.63, 115.1));
});

test('assignPin: an existing pin_source (e.g. geocode) is never overwritten', () => {
  const row = { area: 'seseh', lat: -8.63, lng: 115.1, pin_source: 'geocode' };
  const out = assignPin(row);
  assert.equal(out.pin_source, 'geocode');
});

test('assignPin: unknown area with no lat/lng stays unchanged', () => {
  const row = { area: 'nonexistent' };
  const out = assignPin(row);
  assert.equal(out.lat, undefined);
  assert.equal(out.pin_source, undefined);
});

// ---------------------------------------------------------------------------
// computeBeach
// ---------------------------------------------------------------------------

test('computeBeach: seseh centroid yields a sensible (0–5 km) distance', () => {
  const pinned = assignPin({ area: 'seseh' });
  const out = computeBeach(pinned);
  assert.equal(out.beach_source, 'computed');
  assert.equal(typeof out.beach_name, 'string'); // nearest beach point, not necessarily "Seseh Beach"
  assert.ok(out.beach_km >= 0 && out.beach_km <= 5, `expected 0-5 km, got ${out.beach_km}`);
});

test('computeBeach: listing_text source is never overwritten', () => {
  const row = {
    area: 'seseh', lat: -8.628, lng: 115.099,
    beach_km: 0.35, beach_name: 'Cemagi Beach', beach_source: 'listing_text',
  };
  const out = computeBeach(row);
  assert.equal(out.beach_km, 0.35);
  assert.equal(out.beach_name, 'Cemagi Beach');
  assert.equal(out.beach_source, 'listing_text');
});

test('computeBeach: does nothing without lat/lng', () => {
  const out = computeBeach({ area: 'other' });
  assert.equal(out.beach_km, undefined);
});

test('computeBeach: a non-null beach_km with a non-listing_text source is left alone', () => {
  const out = computeBeach({ area: 'seseh', lat: -8.628, lng: 115.099, beach_km: 2, beach_source: 'computed' });
  assert.equal(out.beach_km, 2);
});

// ---------------------------------------------------------------------------
// placePins
// ---------------------------------------------------------------------------

test('placePins composes assignPin + computeBeach', () => {
  const out = placePins({ area: 'bingin' });
  assert.equal(out.pin_source, 'centroid');
  assert.equal(out.beach_source, 'computed');
  assert.equal(out.beach_name, 'Bingin Beach');
  assert.ok(out.beach_km >= 0 && out.beach_km <= 5);
});
