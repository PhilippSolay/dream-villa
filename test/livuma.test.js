// Livuma adapter. Fixtures fetched 2026-09-24, logged out with a browser UA; trimmed of
// <style>/<link>/<svg>/comments and of every <script> except the JSON-LD blocks.
// The sitemap fixture is a seven-<url> excerpt of the real one. No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import livuma, {
  parseSitemap, slugLooksNonRental, stripProximity, crumbPlace, areaFor, offerIdr, pricesFrom,
  detailFrom, isRental, applyDetail, DETAIL_TTL_HOURS, DEFAULT_EUR_IDR,
} from '../src/scrape/adapters/livuma.js';
import { normaliseListing } from '../src/scrape/normalise.js';
import { inBand } from '../src/scrape/score.js';
import { DEFAULT_CONFIG } from '../src/defaults.js';
import { DEFAULT_USD_IDR } from '../src/scrape/adapters/_shared.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => fs.readFileSync(path.join(ROOT, 'test/fixtures', name), 'utf8');

const SITEMAP = fixture('livuma-sitemap.xml');
const RENTAL = fixture('livuma-detail.html'); // 2BR Seseh, IDR monthly + yearly
const EUR = fixture('livuma-detail-eur.html'); // 3BR Tumbak Bayuh, EUR yearly, bare breadcrumb
const SALE = fixture('livuma-sale.html'); // 3BR villa for sale, Kedungu
const KOST = fixture('livuma-kost.html'); // a room in a kost, Uluwatu
const PAUSED = fixture('livuma-paused.html'); // host paused it: 200, no JSON-LD

const U = {
  rental: 'https://livuma.com/s/3914/2br-new-private-villa-in-seseh-for-rent',
  eur: 'https://livuma.com/s/3155/3br-villa-in-tumbakbayuh-for-rent',
  sale: 'https://livuma.com/s/2605/brand-new-3br-villa-for-sale-in-kedungu',
  kost: 'https://livuma.com/s/2854/the-desert-retreat-room',
  land: 'https://livuma.com/s/1011/do-60-land-for-sale-in-nusa-dua-bali',
  paused: 'https://livuma.com/s/3926/x',
};

/** ctx.fetchHtml over the fixtures; records every call, can pretend a page is cached. */
function stubCtx({ cachedAt = null } = {}) {
  const pages = {
    'https://livuma.com/sitemap.xml': SITEMAP,
    [U.rental]: RENTAL,
    [U.eur]: EUR,
    [U.sale]: SALE,
    [U.kost]: KOST,
    [U.paused]: PAUSED,
  };
  const calls = [];
  return {
    calls,
    config: {},
    log: { warn() {}, info() {} },
    async fetchHtml(url, opts = {}) {
      calls.push({ url, ...opts });
      const html = pages[url] ?? null;
      const fromCache = Boolean(cachedAt && !opts.force);
      return { html, status: html ? 200 : 404, fromCache, fetchedAt: fromCache ? cachedAt : '2026-09-24T06:00:00.000Z' };
    },
  };
}

// ---------------------------------------------------------------------------
// sitemap
// ---------------------------------------------------------------------------

test('parseSitemap keeps /s/<id>/<slug> listings only, newest id first, with lastmod', () => {
  const entries = parseSitemap(SITEMAP);
  assert.deepEqual(entries.map((e) => e.id), ['3914', '3155', '2854', '2605', '1011']);
  assert.deepEqual(entries[0], {
    url: U.rental,
    id: '3914',
    slug: '2br-new-private-villa-in-seseh-for-rent',
    lastmod: '2026-08-31',
  });
  assert.deepEqual(parseSitemap(''), []);
});

test('slugLooksNonRental skips plain sales and plots, never a slug that says rent', () => {
  assert.equal(slugLooksNonRental('brand-new-3br-villa-for-sale-in-kedungu'), true);
  assert.equal(slugLooksNonRental('do-60-land-for-sale-in-nusa-dua-bali'), true);
  assert.equal(slugLooksNonRental('leasehold-land-715-are-mertasari'), true);
  assert.equal(slugLooksNonRental('free-hold-land-17-are'), true);
  assert.equal(slugLooksNonRental('2br-new-private-villa-in-seseh-for-rent'), false);
  assert.equal(slugLooksNonRental('1910-sqm-land-for-lease-in-batu-tampih'), true, 'a plot, whatever the term');
  assert.equal(slugLooksNonRental('villa-for-sale-or-rent-pererenan'), false);
  assert.equal(slugLooksNonRental('island-vibes-2br-villa'), false, '"island" is not "land"');
});

// ---------------------------------------------------------------------------
// area
// ---------------------------------------------------------------------------

test('stripProximity drops "5 min to X" / "near X" boasts', () => {
  assert.doesNotMatch(stripProximity('Villa in Pererenan, 5 min to Canggu'), /canggu/i);
  assert.doesNotMatch(stripProximity('Quiet villa near Seseh beach'), /seseh/i);
  assert.match(stripProximity('Villa in Pererenan, 5 min to Canggu'), /Pererenan/);
});

test('crumbPlace reads the area page off the breadcrumb', () => {
  const crumb = (name) => ({ itemListElement: [{ position: 1, name: 'Home' }, { position: 2, name }] });
  assert.equal(crumbPlace(crumb('Long-Term Rentals in Seseh')), 'Seseh');
  assert.equal(crumbPlace(crumb('Budget Rooms (Kost) for Rent in Uluwatu')), 'Uluwatu');
  assert.equal(crumbPlace(crumb('Long-Term Rentals')), null);
  assert.equal(crumbPlace(null), null);
});

test('areaFor — title, then breadcrumb, then pin, then address (never Mengwi from the address)', () => {
  assert.deepEqual(areaFor({ title: '2 BEDROOM VILLA IN BALANGAN-ULUWATU', crumb: 'Uluwatu' }), { area: 'balangan', from: 'title' });
  assert.deepEqual(areaFor({ title: 'Modern 3BR villa', crumb: 'Pererenan' }), { area: 'pererenan', from: 'breadcrumb' });
  assert.deepEqual(areaFor({ title: 'Modern 3BR villa', crumb: 'Seminyak' }), { area: null, from: null });
  // Pin 300 m from the Seseh centroid.
  assert.deepEqual(areaFor({ title: 'Modern 3BR villa', lat: -8.6285, lng: 115.1015 }), { area: 'seseh', from: 'geo' });
  // Mengwi is the postcode district of Pererenan / Seseh / Cemagi — not evidence of the inland town.
  assert.deepEqual(areaFor({ title: 'Modern 3BR villa', address: 'Mengwi' }), { area: null, from: null });
  assert.deepEqual(areaFor({ title: 'Joglo', address: 'Ubud' }), { area: 'ubud', from: 'address' });
  assert.equal(areaFor({ title: 'Villa in Seminyak, 10 min to Canggu' }).area, null);
});

// ---------------------------------------------------------------------------
// prices
// ---------------------------------------------------------------------------

test('offerIdr converts IDR as is, USD and EUR at the config rate, anything else to null', () => {
  assert.equal(offerIdr({ price: '22000000.00', priceCurrency: 'IDR' }), 22_000_000);
  assert.equal(offerIdr({ price: '2000.00', priceCurrency: 'USD' }), 2000 * DEFAULT_USD_IDR);
  assert.equal(offerIdr({ price: '1000', priceCurrency: 'EUR' }), 1000 * DEFAULT_EUR_IDR);
  assert.equal(offerIdr({ price: '1000', priceCurrency: 'EUR' }, { eur_idr: 19_000 }), 19_000_000);
  assert.equal(offerIdr({ price: '1000', priceCurrency: 'AUD' }), null);
  assert.equal(offerIdr({ price: '0', priceCurrency: 'IDR' }), null);
});

test('pricesFrom takes one-month and one-year leases, ignores sales and other lengths', () => {
  const lease = (price, value, unitText, fn = 'https://schema.org/LeaseOut') => ({
    price, priceCurrency: 'IDR', businessFunction: fn, leaseLength: { value, unitText },
  });
  assert.deepEqual(pricesFrom([lease('22000000', 1, 'month'), lease('195000000', 1, 'year')]), {
    price_month_idr: 22_000_000, price_year_idr: 195_000_000,
  });
  assert.deepEqual(pricesFrom([lease('100000000', 6, 'month')]), { price_month_idr: null, price_year_idr: null });
  assert.deepEqual(pricesFrom([{ price: '7800000000', priceCurrency: 'IDR', businessFunction: 'https://schema.org/Sell' }]), {
    price_month_idr: null, price_year_idr: null,
  });
  assert.deepEqual(pricesFrom(undefined), { price_month_idr: null, price_year_idr: null });
});

// ---------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------

test('detailFrom reads a Seseh rental out of its JSON-LD and page', () => {
  const d = detailFrom(RENTAL, U.rental, {});
  assert.equal(d.source, 'livuma');
  assert.equal(d.ref, '3914');
  assert.equal(d.url, U.rental);
  assert.equal(d.title, '2BR New Private Villa in Seseh For rent');
  assert.equal(d.area, 'seseh');
  assert.equal(d.raw.area_from, 'title');
  assert.equal(d.raw.breadcrumb, 'Seseh');
  assert.equal(d.bedrooms, 2);
  assert.equal(d.bathrooms, 2);
  assert.equal(d.build_m2, 150);
  assert.equal(d.price_month_idr, 22_000_000);
  assert.equal(d.price_year_idr, 195_000_000);
  assert.equal(d.term, 'both');
  assert.equal(d.min_months, 1);
  // The chips: Pool is struck through on this listing, the rest are on.
  assert.equal(d.pool, 0);
  assert.equal(d.garden, 1);
  assert.equal(d.aircon, 1);
  assert.equal(d.kitchen_full, 1);
  assert.equal(d.workspace, 1);
  assert.equal(d.living_open, 1);
  assert.equal(d.lat, -8.6338378);
  assert.equal(d.lng, 115.1138465);
  assert.equal(d.pin_source, 'listing_map');
  assert.equal(d.gone, false);
  assert.equal(d.raw.business_function, 'LeaseOut');
  assert.equal(d.raw.category, 'Villa');
  assert.equal(d.raw.host, 'Nikholas');
  assert.equal(d.raw.host_url, 'https://livuma.com/user/nikholas');
  assert.equal(d.raw.date_posted, '2026-08-31T12:05:34Z');

  // The full description comes from the page body, not the truncated JSON-LD one.
  assert.match(d.description, /Trash collection$/);
  assert.doesNotMatch(d.description, /…$/);

  // Its own gallery folder only (the page also shows similar listings), JSON-LD's 8 ⊂ page's 18.
  assert.equal(d.images.length, 18);
  assert.ok(d.images.every((i) => i.src_url.includes('/listings/f919203a-9c98-48b4-9e6a-74840f839c39/')));
  assert.equal(d.thumb, d.images[0].src_url);
  assert.equal(isRental(d), true);
});

test('detailFrom — EUR yearly price, bare breadcrumb, banjar in the title', () => {
  const d = detailFrom(EUR, U.eur, {});
  assert.equal(d.ref, '3155');
  assert.equal(d.raw.breadcrumb, null);
  assert.equal(d.area, 'pererenan'); // "TUMBAKBAYUH" is inland north Pererenan
  assert.equal(d.beach_km_hint, 4);
  assert.equal(d.price_month_idr, null);
  assert.equal(d.price_year_idr, Math.round(40_150 * DEFAULT_EUR_IDR));
  assert.equal(d.term, 'yearly');
  assert.equal(d.min_months, 12);
  assert.deepEqual(d.raw.offers, [{ price: '40150.00', currency: 'EUR', availability: 'InStock', lease: '1 year' }]);
  assert.ok(d.images.length <= 20);
  assert.equal(isRental(d), true);
});

test('detailFrom — a sale and a kost room parse, and isRental turns both away', () => {
  const sale = detailFrom(SALE, U.sale, {});
  assert.equal(sale.raw.business_function, 'Sell');
  assert.equal(sale.for_sale, true);
  assert.equal(sale.price_month_idr, null);
  assert.equal(sale.price_year_idr, null);
  assert.equal(isRental(sale), false);

  const kost = detailFrom(KOST, U.kost, {});
  assert.equal(kost.raw.business_function, 'LeaseOut');
  assert.equal(kost.raw.category, 'Room');
  assert.equal(isRental(kost), false);
});

test('detailFrom — a paused listing is gone, an unparseable page is null', () => {
  assert.deepEqual(detailFrom(PAUSED, U.paused, {}), {
    source: 'livuma', ref: '3926', url: U.paused, gone: true, raw: { paused: true },
  });
  assert.equal(detailFrom('<html><body>nothing here</body></html>', U.rental, {}), null);
  assert.equal(detailFrom(RENTAL, 'https://example.com/x', {}).ref, '3914', 'ref from the JSON-LD url');
});

test('detailFrom — no offer in stock means gone', () => {
  const html = RENTAL.replace(/https:\/\/schema\.org\/InStock/g, 'https://schema.org/SoldOut');
  assert.equal(detailFrom(html, U.rental, {}).gone, true);
});

test('isRental — only whole homes on LeaseOut', () => {
  const d = (business_function, category, breadcrumb_url = null) => ({ raw: { business_function, category, breadcrumb_url } });
  assert.equal(isRental(d('LeaseOut', 'Villa')), true);
  assert.equal(isRental(d('LeaseOut', 'House')), true);
  assert.equal(isRental(d('LeaseOut', 'Apartment')), true);
  assert.equal(isRental(d('LeaseOut', 'Room')), false);
  assert.equal(isRental(d('LeaseOut', 'Building Land')), false);
  assert.equal(isRental(d('LeaseOut', 'Commercial')), false);
  assert.equal(isRental(d('LeaseOut', 'Villa', 'https://livuma.com/kost/canggu')), false);
  assert.equal(isRental(d('Sell', 'Villa')), false);
  assert.equal(isRental(null), false);
});

// ---------------------------------------------------------------------------
// list / detail / applyDetail
// ---------------------------------------------------------------------------

test('list walks the sitemap, skips sale slugs unfetched, yields in-area rentals only', async () => {
  const ctx = stubCtx();
  const out = [];
  for await (const p of livuma.list(ctx)) out.push(p);

  assert.deepEqual(out.map((p) => [p.ref, p.area]), [['3914', 'seseh'], ['3155', 'pererenan']]);
  const fetched = ctx.calls.map((c) => c.url);
  assert.ok(!fetched.includes(U.sale), 'sale slug never requested');
  assert.ok(!fetched.includes(U.land), 'land slug never requested');
  assert.ok(fetched.includes(U.kost), 'the kost slug says nothing — fetched, then dropped');
  // Detail pages ride the week-long cache; the sitemap the daily one.
  assert.equal(ctx.calls.find((c) => c.url.endsWith('sitemap.xml')).ttlHours, 24);
  assert.equal(ctx.calls.find((c) => c.url === U.rental).ttlHours, DETAIL_TTL_HOURS);
});

test('list refetches a cached page only when the sitemap lastmod is on or after the cached day', async () => {
  // Cached 2026-09-01: 3914 (lastmod 2026-08-31) stays cached, nothing forced.
  let ctx = stubCtx({ cachedAt: '2026-09-01T06:00:00.000Z' });
  for await (const _ of livuma.list(ctx)); // eslint-disable-line no-unused-vars
  assert.equal(ctx.calls.filter((c) => c.force).length, 0);

  // Cached 2026-08-31, the same day as 3914's lastmod → that page is forced.
  ctx = stubCtx({ cachedAt: '2026-08-31T06:00:00.000Z' });
  for await (const _ of livuma.list(ctx)); // eslint-disable-line no-unused-vars
  assert.deepEqual(ctx.calls.filter((c) => c.force).map((c) => c.url), [U.rental]);
});

test('list throws when the sitemap is missing, so the run never reads silence as "unlisted"', async () => {
  const ctx = { config: {}, log: {}, async fetchHtml() { return { html: null, status: 404 }; } };
  await assert.rejects(async () => {
    for await (const _ of livuma.list(ctx)); // eslint-disable-line no-unused-vars
  }, /sitemap unavailable/);
});

test('detail() — the page, or null on a 404', async () => {
  const ctx = stubCtx();
  assert.equal((await livuma.detail(ctx, U.rental)).ref, '3914');
  assert.equal(await livuma.detail(ctx, 'https://livuma.com/s/1/missing'), null);
});

test('the Seseh rental normalises in band and applyDetail asserts the chips and pin', () => {
  const d = detailFrom(RENTAL, U.rental, {});
  const { row } = normaliseListing(d, DEFAULT_CONFIG);
  assert.equal(row.key, 'livuma:3914');
  assert.equal(row.area, 'seseh');
  assert.equal(row.price_month_idr, 22_000_000);
  assert.equal(inBand(row, DEFAULT_CONFIG), true);

  const out = applyDetail(row, d);
  assert.equal(out.pool, 0);
  assert.equal(out.workspace, 1);
  assert.equal(out.min_months, 1);
  assert.equal(out.lat, -8.6338378);
  assert.equal(out.pin_source, 'listing_map');
  assert.equal(out.images.length, 18);
  assert.notEqual(out.availability, 'gone');

  assert.equal(applyDetail(row, { gone: true }).availability, 'gone');
  assert.equal(applyDetail(row, null), row);
});
