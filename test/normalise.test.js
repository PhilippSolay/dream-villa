import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parsePrice,
  normalisePrice,
  parseBedrooms,
  parseMinMonths,
  parseBeachKm,
  mapArea,
  titleCase,
  detectFeatures,
  detectStyle,
  detectRedFlags,
  normaliseListing,
} from '../src/scrape/normalise.js';
import { parseCard, cardFromSeedRaw, parseSeedRaw, toIsoDate } from '../src/scrape/adapters/bhi-parse.js';
import { DEFAULT_CONFIG } from '../src/defaults.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(here, '..', 'seed', 'bhi-sweep-2026-09-17.json');
const BHI = 'https://bali-home-immo.com';
const cardUrl = (slugPath) => `${BHI}/realestate-property/for-rent/villa/${slugPath}`;

// ---------------------------------------------------------------------------
// parsePrice
// ---------------------------------------------------------------------------

test('parsePrice — every format in SPEC §6', () => {
  const cases = [
    ['IDR 40.000.000/month', 40_000_000, 'month'],
    ['IDR 50.000.001/month', 50_000_001, 'month'],
    ['Rp 40jt/bln', 40_000_000, 'month'],
    ['Rp40.000.000 / bulan', 40_000_000, 'month'],
    ['450M/year', 450_000_000, 'year'],
    ['450 M / year', 450_000_000, 'year'],
    ['500 juta / tahun', 500_000_000, 'year'],
    ['IDR 2.100.000.000/year', 2_100_000_000, 'year'],
    ['40,000,000 per month', 40_000_000, 'month'],
    ['IDR 40.000.000 / mo', 40_000_000, 'month'],
    ['1.2B/year', 1_200_000_000, 'year'],
    ['Rp 1,2 M/bln', 1_200_000, 'month'],
    ['Rp 1,5 M/bln', 1_500_000, 'month'],
    ['IDR 44.000.000 monthly', 44_000_000, 'month'],
    ['450.000.000 per tahun', 450_000_000, 'year'],
    ['Rp 1 miliar / tahun', 1_000_000_000, 'year'],
  ];
  for (const [text, amount, per] of cases) {
    assert.deepEqual(parsePrice(text), { amount, per }, text);
  }
});

test('parsePrice — decimal vs thousands separator', () => {
  // a separator followed by exactly three digits is a thousands separator
  assert.equal(parsePrice('IDR 2.100.000.000/year').amount, 2_100_000_000);
  assert.equal(parsePrice('1,5 M/bln').amount, 1_500_000);
  assert.equal(parsePrice('1.5 M/bln').amount, 1_500_000);
});

test('parsePrice — a currency amount with no period, and prose that is not a price', () => {
  assert.deepEqual(parsePrice('37-year leasehold option available at IDR 5.500.000.000'), {
    amount: 5_500_000_000,
    per: null,
  });
  assert.equal(parsePrice('Minimum 3 months rental'), null);
  assert.equal(parsePrice('no money here'), null);
  assert.equal(parsePrice(''), null);
});

// ---------------------------------------------------------------------------
// normalisePrice
// ---------------------------------------------------------------------------

test('normalisePrice — yearly normalises down, never the reverse', () => {
  assert.deepEqual(normalisePrice({ price_year_idr: 450_000_000, price_month_idr: null }), {
    price_month_idr: 37_500_000,
    price_year_idr: 450_000_000,
  });
  // a monthly price is never extrapolated to a yearly one
  assert.deepEqual(normalisePrice({ price_month_idr: 40_000_000, price_year_idr: null }), {
    price_month_idr: 40_000_000,
    price_year_idr: null,
  });
  // an explicit monthly price wins over the division
  assert.deepEqual(normalisePrice({ price_month_idr: 44_000_000, price_year_idr: 450_000_000 }), {
    price_month_idr: 44_000_000,
    price_year_idr: 450_000_000,
  });
  assert.deepEqual(normalisePrice({}), { price_month_idr: null, price_year_idr: null });
  assert.equal(normalisePrice({ price_year_idr: 500_000_000 }).price_month_idr, 41_666_667);
});

// ---------------------------------------------------------------------------
// parseBedrooms
// ---------------------------------------------------------------------------

test('parseBedrooms', () => {
  assert.equal(parseBedrooms('Bedroom: 2'), 2);
  assert.equal(parseBedrooms('Bedroom: 3'), 3);
  assert.equal(parseBedrooms('Bedroom: >5'), 6);
  assert.equal(parseBedrooms('Bedroom: 215/12/2026'), 2); // bedrooms is one digit, the rest is a date
  assert.equal(parseBedrooms('3 Bedrooms Villa'), 3);
  assert.equal(parseBedrooms('2BR villa'), 2);
  assert.equal(parseBedrooms('Ocean view 6+1 bedroom villa'), 6);
  assert.equal(parseBedrooms('a lovely villa'), null);
});

// ---------------------------------------------------------------------------
// parseMinMonths
// ---------------------------------------------------------------------------

test('parseMinMonths', () => {
  assert.equal(parseMinMonths('Minimum 6 months rent'), 6);
  assert.equal(parseMinMonths('Minimum rental period: 6 months'), 6);
  assert.equal(parseMinMonths('min. 3 months'), 3);
  assert.equal(parseMinMonths('Minimum 2 years rental'), 24);
  assert.equal(parseMinMonths('Minimum 2 months rental'), 2);
  // availability, not a minimum — leave it alone
  assert.equal(parseMinMonths('6-month rental is available'), null);
  assert.equal(parseMinMonths('Pet friendly'), null);
});

// ---------------------------------------------------------------------------
// parseBeachKm
// ---------------------------------------------------------------------------

test('parseBeachKm — explicit metres and kilometres', () => {
  assert.deepEqual(parseBeachKm('Walk to the beach (350m)'), { beach_km: 0.35, beach_name: null });
  assert.deepEqual(parseBeachKm('1.2 km to Seseh Beach'), { beach_km: 1.2, beach_name: 'Seseh Beach' });
  assert.deepEqual(parseBeachKm('800 meters to the beach'), { beach_km: 0.8, beach_name: null });
});

test('parseBeachKm — minutes, walking 80 m/min and riding 400 m/min', () => {
  assert.deepEqual(parseBeachKm('5 mins to beach'), { beach_km: 2, beach_name: null });
  assert.deepEqual(parseBeachKm('11 minutes to Nunggalan Beach'), {
    beach_km: 4.4,
    beach_name: 'Nunggalan Beach',
  });
  assert.deepEqual(parseBeachKm('Only a 5-minute ride to the beach!'), { beach_km: 2, beach_name: null });
  assert.deepEqual(parseBeachKm('5 minute walk to the beach'), { beach_km: 0.4, beach_name: null });
  assert.deepEqual(parseBeachKm('just 4 minutes from Melasti Beach'), {
    beach_km: 1.6,
    beach_name: 'Melasti Beach',
  });
  assert.deepEqual(parseBeachKm('(~5 mins) to Pererenan Beach'), {
    beach_km: 2,
    beach_name: 'Pererenan Beach',
  });
});

test('parseBeachKm — ranges use the upper bound', () => {
  assert.equal(parseBeachKm('5–10 mins to the beach').beach_km, 4);
  assert.equal(parseBeachKm('5-10 minutes to the beach').beach_km, 4);
  assert.equal(parseBeachKm('a 5 to 10 minute walk to the beach').beach_km, 0.8);
});

test('parseBeachKm — "walking distance" with no number is the 1 km assumption', () => {
  assert.deepEqual(parseBeachKm('Walking distance to the beach'), { beach_km: 1, beach_name: null });
  assert.deepEqual(
    parseBeachKm('Walking distance to the beach and ocean view from rooftop | Minimum 2 months rental'),
    { beach_km: 1, beach_name: null }
  );
});

test('parseBeachKm — ignores distances to things that are not a beach', () => {
  assert.equal(parseBeachKm('10 minutes to Canggu'), null);
  assert.equal(parseBeachKm('Land size 200 m2'), null);
  assert.equal(parseBeachKm('Minimum 6 months rental'), null);
  // the Canggu number is skipped, the beach number is taken
  assert.equal(parseBeachKm('10 minutes to Canggu and 5 mins to the beach').beach_km, 2);
});

// ---------------------------------------------------------------------------
// mapArea — every location string in the seed (SPEC §7)
// ---------------------------------------------------------------------------

test('mapArea — the exact location strings from the seed', () => {
  const t = { title: 'a villa for rent in bali', category: '' };
  const expect = [
    ['Pererenan - North Side', 'pererenan', 'North Side'],
    ['Pererenan - Beach Side', 'pererenan', 'Beach Side'],
    ['Cemagi / Seseh - Beach Side', 'cemagi', 'Beach Side'],
    ['Ungasan - West Ungasan', 'ungasan', 'West Ungasan'],
    ['Ungasan - East Ungasan', 'ungasan', 'East Ungasan'],
    ['Tanah Lot Area - East side (Nyanyi)', 'nyanyi', 'East side (Nyanyi)'],
    ['Tanah Lot Area - North side (Tabanan)', 'tanah_lot', 'North side (Tabanan)'],
    ['Uluwatu - Bingin Residential Side', 'bingin', 'Bingin Residential Side'],
    ['Cemagi / Seseh - Residential Side', 'seseh', 'Residential Side'],
    ['Tanah Lot Area - West side (Kedungu)', 'kedungu', 'West side (Kedungu)'],
    ['Uluwatu - Pecatu', 'uluwatu', 'Pecatu'],
    ['Uluwatu - Balangan Residential Side', 'balangan', 'Balangan Residential Side'],
    ['Pandawa - Kutuh', 'pandawa', 'Kutuh'],
    ['Uluwatu - Bingin Beach Side', 'bingin', 'Bingin Beach Side'],
    ['Uluwatu - West Uluwatu', 'uluwatu', 'West Uluwatu'],
    ['Uluwatu - Balangan Beach Side', 'balangan', 'Balangan Beach Side'],
    ['Pandawa - West Pandawa', 'pandawa', 'West Pandawa'],
    ['Cemagi / Seseh', 'cemagi', null],
    ['Pererenan', 'pererenan', null],
    ['Uluwatu - East Uluwatu', 'uluwatu', 'East Uluwatu'],
    ['Other Bali Area', 'other', null],
    ['Uluwatu - Padang Padang', 'padang_padang', 'Padang Padang'],
    ['Uluwatu - Nyang Nyang', 'uluwatu', 'Nyang Nyang'],
    ['Ungasan - Melasti', 'ungasan', 'Melasti'],
  ];
  for (const [location, area, sub_area] of expect) {
    const got = mapArea({ ...t, location });
    assert.equal(got.area, area, location);
    assert.equal(got.sub_area, sub_area, location);
  }
});

test('mapArea — the title decides Seseh vs Cemagi', () => {
  assert.equal(mapArea({ location: 'Cemagi / Seseh - Beach Side', title: 'villa in Seseh' }).area, 'seseh');
  assert.equal(mapArea({ location: 'Cemagi / Seseh - Beach Side', title: 'villa in Cemagi' }).area, 'cemagi');
  assert.equal(mapArea({ location: 'Cemagi / Seseh', title: 'villa in Seseh beach' }).area, 'seseh');
  // Residential Side is Seseh whatever the title says
  assert.equal(mapArea({ location: 'Cemagi / Seseh - Residential Side', title: 'villa in Cemagi' }).area, 'seseh');
});

test('mapArea — Munggu in the title wins on the west coast', () => {
  assert.equal(mapArea({ location: 'Cemagi / Seseh - Beach Side', title: 'villa in Munggu' }).area, 'munggu');
  assert.equal(mapArea({ location: 'Pererenan - North Side', title: 'villa in Munggu' }).area, 'munggu');
});

test('mapArea — inland north-Pererenan pockets carry a 4 km hint', () => {
  for (const [name, title] of [
    ['Tumbak Bayuh', 'quiet villa in Tumbak Bayuh'],
    ['Buduk', 'quiet villa in Buduk'],
    ['Tiying Tutul', 'quiet villa in Tiying Tutul'],
  ]) {
    const got = mapArea({ location: 'Pererenan - North Side', title });
    assert.deepEqual(got, { area: 'pererenan', sub_area: name, beach_km_hint: 4 }, title);
  }
});

test('mapArea — Tanah Lot north side: Buwit and Kaba-Kaba', () => {
  assert.equal(
    mapArea({ location: 'Tanah Lot Area - North side (Tabanan)', title: 'villa in Buwit' }).area,
    'buwit'
  );
  const kaba = mapArea({ location: 'Tanah Lot Area - North side (Tabanan)', title: 'villa in Kaba-Kaba' });
  assert.equal(kaba.area, 'tanah_lot');
  assert.equal(kaba.sub_area, 'Kaba-Kaba');
});

test('mapArea — Other Bali Area resolves by title', () => {
  const byTitle = [
    ['villa in Buwit Tabanan', 'buwit'],
    ['villa in Mengwi', 'mengwi'],
    ['villa in Kaba-Kaba', 'tanah_lot'],
    ['villa in Nyanyi', 'nyanyi'],
    ['villa in Kedungu', 'kedungu'],
    ['villa in Pemuteran', 'other'],
  ];
  for (const [title, area] of byTitle) {
    assert.equal(mapArea({ location: 'Other Bali Area', title }).area, area, title);
  }
});

test('mapArea — falls back to the URL category slug when the location is garbage', () => {
  assert.equal(mapArea({ location: '2 units available', title: 'a villa', category: 'monthly/uluwatu' }).area, 'uluwatu');
  assert.equal(mapArea({ location: '', title: 'a villa', category: 'monthly/pandawa' }).area, 'pandawa');
  assert.equal(mapArea({ location: 'Ocean View', title: 'a villa', category: ['monthly/seseh', 'yearly/seseh'] }).area, 'cemagi');
  assert.equal(mapArea({ location: '', title: 'a villa in Seseh', category: 'monthly/seseh' }).area, 'seseh');
  assert.equal(mapArea({ location: '', title: 'a villa', category: 'monthly/tanah-lot-area' }).area, 'tanah_lot');
  // nothing at all to go on
  assert.equal(mapArea({ location: '', title: '', category: '' }).area, 'other');
  assert.equal(mapArea({}).area, 'other');
});

test('mapArea — a canonical string buried in a garbage location is still found', () => {
  // parseCard could not split note from location; the real location is still at the end
  const loc = 'COZY 3 BEDROOMS VILLA FOR SALE & RENT IN BALI - UNGASANUngasan - West Ungasan-';
  assert.deepEqual(mapArea({ location: loc, title: 'cozy 3 bedrooms villa' }), {
    area: 'ungasan',
    sub_area: 'West Ungasan',
    beach_km_hint: null,
  });
});

// ---------------------------------------------------------------------------
// titleCase
// ---------------------------------------------------------------------------

test('titleCase', () => {
  assert.equal(
    titleCase('BRAND NEW 2 BEDROOMS VILLA FOR MONTHLY RENTAL IN BALI - UNGASAN'),
    'Brand New 2 Bedrooms Villa for Monthly Rental in Bali - Ungasan'
  );
  assert.equal(
    titleCase('modern 2 bedroom villa for sale and rental in cemagi bali'),
    'Modern 2 Bedroom Villa for Sale and Rental in Cemagi Bali'
  );
  assert.equal(titleCase('ricefield view 2 bedroom villa'), 'Ricefield View 2 Bedroom Villa');
  assert.equal(titleCase('spacious 3-bedroom villa'), 'Spacious 3-Bedroom Villa');
  assert.equal(titleCase('the villa of a friend'), 'The Villa of a Friend'); // small words: lower unless first
  assert.equal(titleCase('villa rf9183e in cemagi'), 'Villa RF9183E in Cemagi'); // RF refs stay upper
  assert.equal(titleCase(''), '');
});

// ---------------------------------------------------------------------------
// detectFeatures / detectStyle / detectRedFlags
// ---------------------------------------------------------------------------

test('detectFeatures — keywords present', () => {
  const f = detectFeatures(
    'Open plan living with a private pool, tropical garden, fully equipped kitchen, air conditioning, an office and a breezy rooftop. Furnished.'
  );
  assert.equal(f.pool, true);
  assert.equal(f.garden, true);
  assert.equal(f.kitchen_full, true);
  assert.equal(f.aircon, true);
  assert.equal(f.workspace, true);
  assert.equal(f.living_open, true);
  assert.equal(f.airy, true);
  assert.equal(f.rooftop, true);
  assert.equal(f.furnished, 1);
});

test('detectFeatures — absent keywords are null (unknown), never false', () => {
  const f = detectFeatures('A villa.');
  for (const k of ['pool', 'garden', 'joglo', 'rooftop', 'aircon', 'kitchen_full', 'workspace', 'living_open', 'airy']) {
    assert.equal(f[k], null, k);
  }
  assert.equal(f.view, null);
  assert.equal(f.furnished, null);
});

test('detectFeatures — view', () => {
  assert.equal(detectFeatures('stunning ocean view').view, 'ocean');
  assert.equal(detectFeatures('sea view from the rooftop').view, 'ocean');
  assert.equal(detectFeatures('ricefield view villa').view, 'rice');
  assert.equal(detectFeatures('rice paddies all around').view, 'rice');
  assert.equal(detectFeatures('river view').view, 'river');
  assert.equal(detectFeatures('jungle surroundings').view, 'jungle');
  assert.equal(detectFeatures('mountain view').view, 'mountain');
  assert.equal(detectFeatures('garden view only').view, 'none');
  assert.equal(detectFeatures('no view mentioned').view, null);
});

test('detectFeatures — aircon "AC" is case-sensitive', () => {
  assert.equal(detectFeatures('AC in every bedroom').aircon, true);
  assert.equal(detectFeatures('aircon in every bedroom').aircon, true);
  assert.equal(detectFeatures('air-con in every bedroom').aircon, true);
  assert.equal(detectFeatures('a spacious terrace').aircon, null); // no stray "ac" match
});

test('detectFeatures — furnished', () => {
  assert.equal(detectFeatures('fully furnished').furnished, 1);
  assert.equal(detectFeatures('unfurnished villa').furnished, 0);
  assert.equal(detectFeatures('semi furnished villa').furnished, 1);
  assert.equal(detectFeatures('a villa').furnished, null);
});

test('detectStyle — precedence and the balinese_old review caveat', () => {
  assert.deepEqual(detectStyle('a modern joglo with bamboo details'), { style: 'joglo', review: false });
  assert.deepEqual(detectStyle('a modern bamboo house'), { style: 'bamboo', review: false });
  assert.deepEqual(detectStyle('modern industrial loft'), { style: 'industrial', review: false });
  assert.deepEqual(detectStyle('traditional Balinese villa'), { style: 'balinese_old', review: true });
  assert.deepEqual(detectStyle('antique furniture throughout'), { style: 'balinese_old', review: true });
  assert.deepEqual(detectStyle('brand new modern villa'), { style: 'modern', review: false });
  assert.deepEqual(detectStyle('tropical living'), { style: 'tropical', review: false });
  assert.deepEqual(detectStyle('a villa'), { style: null, review: false });
});

test('detectRedFlags', () => {
  assert.deepEqual(detectRedFlags('Construction next door until March'), ['construction']);
  assert.deepEqual(detectRedFlags('right on the main road'), ['main_road']);
  assert.deepEqual(detectRedFlags('building site opposite, busy road'), ['construction', 'main_road']);
  assert.deepEqual(detectRedFlags('a quiet villa'), []);
  // reassurances are not flags
  assert.deepEqual(detectRedFlags('Quiet street with no surrounding construction noise'), []);
  assert.deepEqual(detectRedFlags('far from the main road, without construction around'), []);
  assert.deepEqual(detectRedFlags('a construction-free pocket of Pererenan'), []);
  assert.deepEqual(detectRedFlags('free of construction, yet 5 min to Seseh'), []);
  // a denial followed by an admission still flags
  assert.deepEqual(detectRedFlags('No construction in the street, but the plot behind is under construction'), ['construction']);
  // custom keyword table
  assert.deepEqual(detectRedFlags('dogs barking all night', { noise: ['dogs'] }), ['noise']);
});

// ---------------------------------------------------------------------------
// normaliseListing
// ---------------------------------------------------------------------------

test('normaliseListing — a full BHI card', () => {
  const { row, hints } = normaliseListing({
    source: 'bhi',
    ref: 'RF9183E',
    url: `${BHI}/x/rf9183e`,
    title: 'modern 3 bedroom villa for rental in bali cemagi beachside',
    location: 'Cemagi / Seseh - Beach Side',
    note: 'Walking distance to the beach and ocean view from rooftop | Minimum 2 months rental',
    category: 'monthly/seseh,yearly/seseh',
    bedrooms: 3,
    available_from: '2026-12-15',
    price_month_idr: 50_000_000,
    price_year_idr: null,
    term: 'both',
    thumb: `${BHI}/images/properties/thumb/x.jpg`,
    for_sale: false,
  });

  assert.equal(row.key, 'bhi:RF9183E');
  assert.equal(row.title, 'Modern 3 Bedroom Villa for Rental in Bali Cemagi Beachside');
  assert.equal(row.area, 'cemagi');
  assert.equal(row.sub_area, 'Beach Side');
  assert.equal(row.bedrooms, 3);
  assert.equal(row.price_month_idr, 50_000_000);
  assert.equal(row.term, 'both');
  assert.equal(row.min_months, 2);
  assert.equal(row.beach_km, 1);
  assert.equal(row.beach_source, 'listing_text');
  assert.equal(row.view, 'ocean');
  assert.equal(row.availability, 'from:2026-12-15');
  assert.equal(row.available_from, '2026-12-15');
  assert.deepEqual(JSON.parse(row.red_flags), []);
  assert.equal(typeof row.raw, 'string');
  assert.equal(JSON.parse(row.raw).ref, 'RF9183E');
  assert.equal(hints.thumb, `${BHI}/images/properties/thumb/x.jpg`);
});

test('normaliseListing — yearly-only price normalises to a monthly equivalent', () => {
  const { row } = normaliseListing({
    source: 'bhi',
    ref: 'RF10038',
    title: 'brand new 1 bedroom loft in ungasan',
    location: 'Ungasan - West Ungasan',
    price_year_idr: 200_000_000,
    term: 'yearly',
  });
  assert.equal(row.price_year_idr, 200_000_000);
  assert.equal(row.price_month_idr, Math.round(200_000_000 / 12));
});

test('normaliseListing — beach_km falls back to the area hint, marked computed', () => {
  const { row, hints } = normaliseListing({
    source: 'bhi',
    ref: 'RF1',
    title: 'quiet villa in Tumbak Bayuh',
    location: 'Pererenan - North Side',
  });
  assert.equal(row.beach_km, 4);
  assert.equal(row.beach_source, 'computed');
  assert.equal(row.beach_name, 'Pererenan Beach');
  assert.equal(row.sub_area, 'Tumbak Bayuh');
  assert.equal(hints.beach_km_hint, 4);
});

test('normaliseListing — no beach information at all leaves it null', () => {
  const { row } = normaliseListing({ source: 'bhi', ref: 'RF2', title: 'a villa', location: 'Ungasan - Melasti' });
  assert.equal(row.beach_km, null);
  assert.equal(row.beach_name, null);
  assert.equal(row.beach_source, null);
});

test('normaliseListing — extra_rooms', () => {
  const office = normaliseListing({ ref: 'A', title: '2 bedroom villa with ricefield view + an office' }).row;
  assert.equal(office.extra_rooms, 1);
  const plusOne = normaliseListing({ ref: 'B', title: 'ocean view 10 +1 bedroom villa' }).row;
  assert.equal(plusOne.extra_rooms, 1);
  const plain = normaliseListing({ ref: 'C', title: '2 bedroom villa' }).row;
  assert.equal(plain.extra_rooms, 0);
});

test('normaliseListing — balinese_old is a review hint, not an asserted red flag', () => {
  const { row, hints } = normaliseListing({ ref: 'D', title: 'traditional Balinese villa in Cemagi', location: 'Cemagi / Seseh' });
  assert.equal(row.style, 'balinese_old');
  assert.equal(hints.style_review, true);
  assert.deepEqual(JSON.parse(row.red_flags), []); // not asserted while it is under review
});

test('normaliseListing — red flags from the keyword table', () => {
  const { row } = normaliseListing({ ref: 'E', title: 'villa on the main road', location: 'Pererenan' });
  assert.deepEqual(JSON.parse(row.red_flags), ['main_road']);
});

test('normaliseListing — carries no person fields', () => {
  const { row } = normaliseListing({ ref: 'F', title: 'a villa', location: 'Pererenan' });
  for (const k of ['status', 'status_by', 'assessed', 'by', 'flagged', 'fit_score', 'scope']) {
    assert.equal(k in row, false, `row must not carry ${k}`);
  }
});

// ---------------------------------------------------------------------------
// bhi-parse — the three example cards from adapters/bali-home-immo.md
// ---------------------------------------------------------------------------

test('parseCard — example 1, RF10679', () => {
  const got = parseCard({
    ref: 'RF10679',
    url: cardUrl('monthly/seseh/modern-2-bedroom-villa-for-sale-and-rental-in-cemagi-bali-rf10679'),
    text: 'leaseholdmonthlyModern 2 bedroom villa for sale and rental in Cemagi BaliCemagi / Seseh - Beach Side- RF10679Bedroom: 2IDR 40.000.000/month',
    thumb: null,
    categories: ['monthly/seseh'],
  });
  assert.equal(got.dirty, undefined);
  assert.equal(got.title, 'modern 2 bedroom villa for sale and rental in cemagi bali');
  assert.equal(got.location, 'Cemagi / Seseh - Beach Side');
  assert.equal(got.note, '');
  assert.equal(got.bedrooms, 2);
  assert.equal(got.available, null);
  assert.equal(got.available_from, null);
  assert.equal(got.price_month_idr, 40_000_000);
  assert.equal(got.price_year_idr, null);
  assert.equal(got.term, 'monthly');
  assert.equal(got.for_sale, true);
  assert.equal(got.newly_listed, false);
});

test('parseCard — example 2, RF9183E (note, yearly + monthly)', () => {
  const got = parseCard({
    ref: 'RF9183E',
    url: cardUrl('monthly/seseh/modern-3-bedroom-villa-for-rental-in-bali-cemagi-beachside-rf9183e'),
    text: 'yearlymonthlyWalking distance to the beach and ocean view from rooftop | Minimum 2 months rental | Monthly installment payment available for yearly rentalModern 3 Bedroom Villa for Rental in Bali Cemagi BeachsideCemagi / Seseh - Beach Side- RF9183EBedroom: 3IDR 50.000.000/month',
    categories: ['monthly/seseh', 'yearly/seseh'],
  });
  assert.equal(
    got.note,
    'Walking distance to the beach and ocean view from rooftop | Minimum 2 months rental | Monthly installment payment available for yearly rental'
  );
  assert.equal(got.location, 'Cemagi / Seseh - Beach Side');
  assert.equal(got.bedrooms, 3);
  assert.equal(got.price_month_idr, 50_000_000);
  assert.equal(got.term, 'both');
  assert.equal(got.for_sale, false);
});

test('parseCard — example 3, RF7025B ("Bedroom: 215/12/2026" is 2 bedrooms + a date)', () => {
  const got = parseCard({
    ref: 'RF7025B',
    url: cardUrl('monthly/seseh/2-bedroom-modern-villa-for-rent-in-cemagi-beachside-rf7025b'),
    text: 'Newly Listedyearlymonthly2 Bedroom Modern Villa For Rent in Cemagi BeachsideCemagi / Seseh - Beach Side- RF7025BBedroom: 215/12/2026 IDR 62.500.000/month',
    categories: ['monthly/seseh', 'yearly/seseh'],
  });
  assert.equal(got.bedrooms, 2);
  assert.equal(got.available, '15/12/2026');
  assert.equal(got.available_from, '2026-12-15');
  assert.equal(got.price_month_idr, 62_500_000);
  assert.equal(got.newly_listed, true);
  assert.equal(got.term, 'both');
  assert.equal(got.location, 'Cemagi / Seseh - Beach Side');
});

test('parseCard — ">5" bedrooms becomes 6 so the band check drops it later', () => {
  const got = parseCard({
    ref: 'RF4456',
    url: cardUrl('monthly/ungasan/beautiful-8-bedrooms-villa-for-sale-and-rent-in-uluwatu-pecatu-rf4456'),
    text: "freeholdleaseholdyearlymonthlyTwo years' rent paid upfront available at IDR 2,000,000,000.BEAUTIFUL 8 BEDROOMS VILLA FOR SALE AND RENT IN ULUWATU PECATUUngasan - West Ungasan- RF4456Bedroom: >5IDR 106.250.000/month",
    categories: ['monthly/ungasan', 'yearly/ungasan'],
  });
  assert.equal(got.dirty, undefined); // a second IDR in the note is NOT a concatenated card
  assert.equal(got.bedrooms, 6);
  assert.equal(got.price_month_idr, 106_250_000);
  assert.equal(got.location, 'Ungasan - West Ungasan');
});

test('parseCard — a note price does not confuse the card price', () => {
  const got = parseCard({
    ref: 'RF10172B',
    url: cardUrl('monthly/uluwatu/elegant-2-bedroom-tropical-villa-for-sale-and-rent-in-bingin-prime-investment-opportunity-rf10172b'),
    text: 'leaseholdyearlymonthlyExtension available at a fixed price of IDR 23,000,000/are/year - Contact us for more details !Elegant 2-Bedroom Tropical Villa for Sale and Rent in Bingin – Prime Investment OpportunityUluwatu - Bingin Residential Side- RF10172BBedroom: 201/10/2026 IDR 50.000.001/month',
    categories: ['monthly/uluwatu', 'yearly/uluwatu'],
  });
  assert.equal(got.dirty, undefined);
  assert.equal(got.price_month_idr, 50_000_001);
  assert.equal(got.bedrooms, 2);
  assert.equal(got.available_from, '2026-10-01');
  assert.equal(got.location, 'Uluwatu - Bingin Residential Side');
});

test('parseCard — several cards concatenated are marked dirty', () => {
  const text =
    'leaseholdmonthlyTropical villaPererenan - Beach Side- RF10028Bedroom: 4IDR 101.250.000/month' +
    'yearlymonthlyStunning villaPererenan - Beach Side- RF8923Bedroom: 4IDR 162.500.000/month';
  const got = parseCard({ ref: 'RF10336', url: cardUrl('monthly/pererenan/x-rf10336'), text });
  assert.deepEqual(got, { ref: 'RF10336', dirty: true });
});

test('toIsoDate', () => {
  assert.equal(toIsoDate('15/12/2026'), '2026-12-15');
  assert.equal(toIsoDate('01/10/2026'), '2026-10-01');
  assert.equal(toIsoDate(''), null);
  assert.equal(toIsoDate(null), null);
  assert.equal(toIsoDate('2026-12-15'), null);
});

test('cardFromSeedRaw builds the parseCard input', () => {
  const raw = {
    r: 'RF10679',
    u: 'monthly/seseh/modern-2-bedroom-villa-for-sale-and-rental-in-cemagi-bali-rf10679',
    t: 'leaseholdmonthlyModern 2 bedroom villa for sale and rental in Cemagi BaliCemagi / Seseh - Beach Side- RF10679Bedroom: 2IDR 40.000.000/month',
    i: 'modern-2-bedroom-villa-for-sale-in-cemagi-bali-rf10679-f705570b6d8be5b240a33a7bffde3fd8.jpg',
    c: 'monthly/seseh,yearly/seseh',
  };
  const card = cardFromSeedRaw(raw);
  assert.equal(card.ref, 'RF10679');
  assert.equal(card.url, `${BHI}/realestate-property/for-rent/villa/${raw.u}`);
  assert.equal(card.thumb, `${BHI}/images/properties/thumb/${raw.i}`);
  assert.deepEqual(card.categories, ['monthly/seseh', 'yearly/seseh']);
  assert.equal(card.text, raw.t);
  assert.equal(parseCard(card).term, 'both'); // categories win over the text tags
});

// ---------------------------------------------------------------------------
// The whole seed
// ---------------------------------------------------------------------------

test('the whole seed sweep parses and normalises', (t) => {
  if (!fs.existsSync(SEED)) return t.skip('seed file missing');
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  assert.equal(seed.raw.length, 324);

  const dirty = [];
  const areas = new Set();
  for (const raw of seed.raw) {
    const card = parseSeedRaw(raw);
    if (card.dirty) {
      dirty.push(card.ref);
      continue;
    }
    const { row } = normaliseListing({ ...card, source: 'bhi', category: raw.c }, DEFAULT_CONFIG);
    assert.ok(row.area, `${card.ref} has no area`);
    assert.notEqual(row.area, undefined);
    assert.equal(row.key, `bhi:${card.ref}`);
    areas.add(row.area);
  }

  // RF10336 is the ONLY true concatenation. The other four multi-"IDR" rows
  // (RF7046A, RF10172B, RF4456, RF10038) quote a sale / extension price in their
  // note and are perfectly good cards — so the dirt rule is "more than one RF ref",
  // not "more than one IDR".
  assert.deepEqual(dirty, ['RF10336']);
  assert.equal(areas.has(undefined), false);
  assert.ok(areas.size >= 10, `expected many areas, got ${[...areas].join(',')}`);
});

test('the four multi-IDR rows that are NOT dirty still parse cleanly', (t) => {
  if (!fs.existsSync(SEED)) return t.skip('seed file missing');
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const byRef = Object.fromEntries(seed.raw.map((r) => [r.r, r]));
  for (const ref of ['RF7046A', 'RF10172B', 'RF4456', 'RF10038']) {
    const card = parseSeedRaw(byRef[ref]);
    assert.equal(card.dirty, undefined, `${ref} must not be dirty`);
    assert.ok(card.price_month_idr || card.price_year_idr, `${ref} must have a price`);
    assert.ok(card.bedrooms >= 1, `${ref} must have bedrooms`);
  }
});

test('normaliseListing — an explicit canonical area from the adapter wins over the location map', () => {
  const { row } = normaliseListing({ source: 'x', ref: '1', url: 'https://x/1', title: 'Villa', location: 'Mengwi, Badung', area: 'munggu', sub_area: 'Munggu village', bedrooms: 2, price_month_idr: 30_000_000 });
  assert.equal(row.area, 'munggu');
  assert.equal(row.sub_area, 'Munggu village');
  const bad = normaliseListing({ source: 'x', ref: '2', url: 'https://x/2', title: 'Villa in Cemagi', location: 'Cemagi / Seseh - Beach Side', area: 'nowhere', bedrooms: 2, price_month_idr: 30_000_000 });
  assert.equal(bad.row.area, 'cemagi', 'an unknown area falls back to the location map');
});

// ---------------------------------------------------------------------------
// The Canggu belt (SPEC §7, added 2026-09-22)
// ---------------------------------------------------------------------------

test('mapArea — Bali Home Immo files the whole belt under a broad "Canggu"', () => {
  assert.deepEqual(
    mapArea({ location: 'Canggu - Batu Bolong / Echo Beach', title: '2 Bedroom Villa' }),
    { area: 'canggu', sub_area: 'Batu Bolong / Echo Beach', beach_km_hint: null }
  );
  assert.equal(mapArea({ location: 'Canggu - North Canggu', title: 'Villa' }).area, 'canggu');
  // Berawa is both a §7 area of its own and one of Canggu's sub-areas.
  assert.equal(mapArea({ location: 'Canggu - Berawa', title: 'Villa' }).area, 'berawa');
  assert.equal(mapArea({ location: 'Berawa', title: 'Villa' }).area, 'berawa');
  assert.equal(mapArea({ location: 'Umalas', title: 'Villa' }).area, 'umalas');
});

test('mapArea — inside Canggu, a village named in the title wins', () => {
  assert.equal(mapArea({ location: 'Canggu', title: '3 Bedroom Villa in Babakan' }).area, 'babakan');
  assert.equal(mapArea({ location: 'Canggu', title: 'Villa in Padonan, quiet lane' }).area, 'padonan');
  assert.equal(mapArea({ location: 'Canggu', title: 'Family villa in Tibubeneng' }).area, 'tibubeneng');
  assert.equal(mapArea({ location: 'Canggu', title: 'Modern villa in Umalas' }).area, 'umalas');
});

test('mapArea — a proximity phrase is a boast, not an address', () => {
  // The title is the last resort, reached when the location string says nothing.
  assert.equal(mapArea({ location: '', title: 'Villa in Pererenan, 10 minutes to Canggu' }).area, 'pererenan');
  assert.equal(mapArea({ location: '', title: 'Quiet villa close to Berawa' }).area, 'other');
  assert.equal(mapArea({ location: '', title: 'Walking distance to Canggu beach' }).area, 'other');
  // …but a villa that is actually there still lands there.
  assert.equal(mapArea({ location: '', title: 'Charming 2 bedroom villa in Canggu' }).area, 'canggu');
  assert.equal(mapArea({ location: '', title: 'Wooden villa in Babakan' }).area, 'babakan');
});

test('mapArea — the belt slugs resolve when the location string is empty', () => {
  assert.equal(mapArea({ location: '', title: 'Villa', category: 'canggu' }).area, 'canggu');
  assert.equal(mapArea({ location: '', title: 'Villa', category: 'berawa' }).area, 'berawa');
  assert.equal(mapArea({ location: '', title: 'Villa', category: 'umalas' }).area, 'umalas');
});

// ---------------------------------------------------------------------------
// Banjar level — Region › Area › Banjar (SPEC §7, 2026-09-22)
// ---------------------------------------------------------------------------

test('mapArea — a banjar in the title lands in its area, not in "other"', () => {
  const banjars = [
    ['Villa in Kayu Tulang', 'canggu'],
    ['Villa on Padang Linjong', 'canggu'],
    ['Villa in Tegal Gundul', 'canggu'],
    ['Villa in Pelambingan', 'tibubeneng'],
    ['Villa in Nyuh Kuning', 'ubud'],
    ['Villa in Penestanan', 'ubud'],
    ['Villa in Sayan', 'ubud'],
    ['Villa in Pengosekan', 'ubud'],
    ['Villa in Tumbak Bayuh', 'pererenan'],
    ['Villa in Cepaka', 'tanah_lot'],
    ['Villa in Labuan Sait', 'padang_padang'],
    ['Villa in Pecatu', 'uluwatu'],
  ];
  for (const [title, area] of banjars) {
    assert.equal(mapArea({ location: '', title }).area, area, title);
  }
});

test('mapArea — Ubud, and the west coast still outranks it', () => {
  assert.equal(mapArea({ location: 'Ubud', title: 'Villa' }).area, 'ubud');
  assert.equal(mapArea({ location: 'Ubud - Nyuh Kuning', title: 'Villa' }).area, 'ubud');
  assert.equal(mapArea({ location: '', title: 'Villa', category: 'ubud' }).area, 'ubud');
  // A bare "Ubud" is the last word in the table, so anything more specific wins.
  assert.equal(mapArea({ location: '', title: 'Villa in Pererenan with Ubud vibes' }).area, 'pererenan');
  assert.equal(mapArea({ location: '', title: 'Canggu villa, 40 minutes to Ubud' }).area, 'canggu');
});
