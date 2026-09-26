// src/scrape/adapters/_shared.js and src/scrape/browser.js — the two pieces the
// step-7a agency adapters lean on. No network, no browser.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  absUrl,
  areToM2,
  areaFromText,
  subAreaFrom,
  beachHint,
  moneyIdr,
  nextData,
  numberIn,
  pickJsonLd,
  textOf,
  usdRate,
  DEFAULT_USD_IDR,
} from '../src/scrape/adapters/_shared.js';
import { normaliseListing } from '../src/scrape/normalise.js';
import { AREAS } from '../src/areas.js';
import { getBrowserHtml, playwrightEnabled } from '../src/scrape/browser.js';

test('absUrl resolves against the site base', () => {
  assert.equal(absUrl('/a/b', 'https://x.test'), 'https://x.test/a/b');
  assert.equal(absUrl('https://y.test/c', 'https://x.test'), 'https://y.test/c');
  assert.equal(absUrl('', 'https://x.test'), null);
  assert.equal(absUrl(null, 'https://x.test'), null);
});

test('textOf collapses whitespace and returns null for nothing', () => {
  assert.equal(textOf('  a \n  b  '), 'a b');
  assert.equal(textOf('   '), null);
  assert.equal(textOf(null), null);
});

test('numberIn reads the first number, thousands separators included', () => {
  assert.equal(numberIn('166 m²'), 166);
  assert.equal(numberIn('1.2'), 1.2);
  assert.equal(numberIn('IDR 360.000.000'), 360000000);
  assert.equal(numberIn('IDR 360,000,000'), 360000000);
  assert.equal(numberIn('no digits'), null);
});

test('areToM2 converts the Balinese are', () => {
  assert.equal(areToM2('1.2 Are'), 120);
  assert.equal(areToM2('4 Are'), 400);
  assert.equal(areToM2(''), null);
});

test('moneyIdr keeps IDR, converts USD, refuses the rest', () => {
  assert.deepEqual(moneyIdr('idr 220,000,000 / Annually'), {
    amount: 220_000_000,
    per: 'year',
    currency: 'IDR',
    original: 220_000_000,
  });
  assert.deepEqual(moneyIdr('USD 2,500 per month'), {
    amount: 2500 * DEFAULT_USD_IDR,
    per: 'month',
    currency: 'USD',
    original: 2500,
  });
  assert.equal(moneyIdr('USD 2,500 per month', { usd_idr: 17_000 }).amount, 2500 * 17_000);
  assert.equal(moneyIdr('AUD 482,000'), null);
  assert.equal(moneyIdr('TBA'), null);
});

test('usdRate falls back to the documented default', () => {
  assert.equal(usdRate({}), DEFAULT_USD_IDR);
  assert.equal(usdRate({ usd_idr: 0 }), DEFAULT_USD_IDR);
  assert.equal(usdRate({ usd_idr: 16_500 }), 16_500);
});

test('areaFromText maps the site dialects onto SPEC §7 areas', () => {
  assert.equal(areaFromText('Bukit, Ungasan'), 'ungasan');
  assert.equal(areaFromText('Bukit, Pecatu'), 'uluwatu');
  assert.equal(areaFromText('Canggu, Pererenan'), 'pererenan');
  assert.equal(areaFromText('Tabanan, Nyanyi'), 'nyanyi');
  assert.equal(areaFromText('Tabanan'), 'tanah_lot');
  // The Canggu belt joined §7 on 2026-09-22; a west-coast name in the same string still wins.
  assert.equal(areaFromText('Kayu Tulang, Canggu'), 'canggu');
  assert.equal(areaFromText('Babakan, Canggu'), 'babakan', 'the village beats the region');
  assert.equal(areaFromText('Umalas'), 'umalas');
  assert.equal(areaFromText('Brawa'), 'berawa', 'the spelling agents actually use');
  // Two Bali Realty titles (2026-09-26) that named only a banjar or a beach and were dropped.
  assert.equal(areaFromText('Newly Built Three-Bedroom Villa, Fully Furnished in Semat'), 'tibubeneng');
  assert.equal(areaFromText('Chic and Spacious Three-Bedroom Villa for Yearly Rental Near Lima Beach'), 'pererenan');
  assert.equal(areaFromText('Bukit, Nusa Dua'), null, 'a bare Bukit is not a target area');
  assert.equal(areaFromText(null, 'Villa in Seseh'), 'seseh', 'later parts are searched too');
});

test('every SPEC §7 area survives normaliseListing when the adapter states it', () => {
  // The adapters set `area` outright rather than faking a Bali-Home-Immo location
  // string; normaliseListing honours a canonical key and ignores an unknown one.
  for (const area of Object.keys(AREAS)) {
    const { row } = normaliseListing({ source: 'x', ref: '1', area, sub_area: 'Banjar Foo', title: 'Villa Foo' });
    assert.equal(row.area, area);
    assert.equal(row.sub_area, 'Banjar Foo');
  }
  const { row } = normaliseListing({ source: 'x', ref: '1', area: 'seminyak', title: 'Villa Foo' });
  assert.equal(row.area, 'other', 'an area outside §7 falls back to the location map');
});

test('subAreaFrom keeps only what is more specific than the area', () => {
  assert.equal(subAreaFrom('Canggu, Pererenan', 'pererenan'), null);
  assert.equal(subAreaFrom('Pererenan, Tumbak', 'pererenan'), 'Tumbak');
  assert.equal(subAreaFrom('Bukit, Uluwatu, Pecatu', 'uluwatu'), null);
  assert.equal(subAreaFrom('Tabanan, Cepaka', 'tanah_lot'), 'Cepaka');
  assert.equal(subAreaFrom('Bukit, Ungasan', 'ungasan'), null);
  assert.equal(subAreaFrom(null, 'pererenan'), null);
  assert.equal(subAreaFrom('Pererenan', 'seminyak'), null);
});

test('beachHint only fires for the SPEC §7 inland Pererenan pockets', () => {
  assert.equal(beachHint('pererenan', 'Pererenan, Tumbak'), 4);
  assert.equal(beachHint('pererenan', null, 'Joglo Villa in Tumbak Bayuh'), 4);
  assert.equal(beachHint('pererenan', 'Pererenan, Buduk'), 4);
  assert.equal(beachHint('pererenan', 'Pererenan'), null);
  assert.equal(beachHint('seseh', 'Tumbak'), null);
});

test('pickJsonLd walks @graph, arrays and itemListElement', () => {
  const html = `
    <script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"A"}]}</script>
    <script type="application/ld+json">{"@type":"ItemList","itemListElement":[
      {"@type":"ListItem","item":{"@type":"Product","name":"B"}}]}</script>
    <script type="application/ld+json">{ not json </script>`;
  assert.deepEqual(pickJsonLd(html, 'Product').map((n) => n.name), ['B']);
  assert.deepEqual(pickJsonLd(html, ['organization']).map((n) => n.name), ['A']);
  assert.deepEqual(pickJsonLd('<html></html>', 'Product'), []);
});

test('nextData reads a __NEXT_DATA__ payload and survives a page without one', () => {
  assert.deepEqual(
    nextData('<script id="__NEXT_DATA__" type="application/json">{"props":{"a":1}}</script>'),
    { props: { a: 1 } }
  );
  assert.equal(nextData('<html></html>'), null);
  assert.equal(nextData('<script id="__NEXT_DATA__">{oops</script>'), null);
});

test('browser.js stays off unless PLAYWRIGHT=1', async () => {
  const before = process.env.PLAYWRIGHT;
  delete process.env.PLAYWRIGHT;
  try {
    assert.equal(playwrightEnabled(), false);
    await assert.rejects(() => getBrowserHtml('https://example.test/'), /PLAYWRIGHT=1 is not set/);
  } finally {
    if (before === undefined) delete process.env.PLAYWRIGHT;
    else process.env.PLAYWRIGHT = before;
  }
});
