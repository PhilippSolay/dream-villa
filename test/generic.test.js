// The fallback "generic" adapter (SPEC §6 "inbox" item 5): OpenGraph + JSON-LD + regex
// extraction for a URL that doesn't match a known source. Two fixtures — one with
// JSON-LD `RealEstateListing` + geo + og:image, one plain-text Indonesian listing —
// nothing here touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import generic, {
  detectArea,
  extractBedrooms,
  extractLandBuild,
  extractPrice,
  extractWhatsapp,
  extractMapPin,
  findListingBlock,
  parseJsonLd,
  parseOg,
} from '../src/scrape/adapters/generic.js';
import { normaliseListing } from '../src/scrape/normalise.js';
import { DEFAULT_CONFIG } from '../src/defaults.js';
import * as cheerio from 'cheerio';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSONLD_HTML = fs.readFileSync(path.join(ROOT, 'test/fixtures/generic-jsonld.html'), 'utf8');
const TEXT_HTML = fs.readFileSync(path.join(ROOT, 'test/fixtures/generic-text.html'), 'utf8');

const JSONLD_URL = 'https://randomsite.test/listing/123';
const TEXT_URL = 'https://someagency.test/villa-pererenan-murah';

/** A ctx that serves one fixture for one URL, and 404s everything else. */
function stubCtx(map) {
  return {
    config: {},
    log: console,
    stats: {},
    async fetchHtml(url) {
      return map[url] || { html: null, status: 404 };
    },
  };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

test('detectArea: keyword scan against the §7 labels, first hit wins, else other', () => {
  assert.equal(detectArea('A villa in Pererenan, west Bali'), 'pererenan');
  assert.equal(detectArea('Steps from Padang Padang beach'), 'padang_padang');
  assert.equal(detectArea('Uluwatu clifftop villa'), 'uluwatu');
  assert.equal(detectArea('Somewhere in Jakarta'), 'other');
});

test('extractBedrooms: common patterns and Indonesian "kamar tidur"/"KT"', () => {
  assert.equal(extractBedrooms('A 3 bedroom villa'), 3);
  assert.equal(extractBedrooms('Villa dengan 4 kamar tidur'), 4);
  assert.equal(extractBedrooms('2KT, 1 kamar mandi'), 2);
  assert.equal(extractBedrooms('no rooms mentioned here'), null);
});

test('extractLandBuild: m2/are near land/building keywords, are is x100', () => {
  assert.deepEqual(extractLandBuild('Luas tanah 300 m2, luas bangunan 150 m2'), { land_m2: 300, build_m2: 150 });
  assert.deepEqual(extractLandBuild('Land size 2 are, no building info'), { land_m2: 200, build_m2: null });
  assert.deepEqual(extractLandBuild('nothing relevant, 42 m2 of something else'), { land_m2: null, build_m2: null });
});

test('extractPrice: prefers a candidate with an explicit period', () => {
  assert.deepEqual(extractPrice('IDR 40.000.000 / month for rent'), { amount: 40_000_000, per: 'month' });
  assert.deepEqual(extractPrice('Rp 35 juta / bulan, negotiable'), { amount: 35_000_000, per: 'month' });
  assert.equal(extractPrice('no price mentioned'), null);
});

test('extractWhatsapp: wa.me and api.whatsapp.com/send links', () => {
  const $1 = cheerio.load('<a href="https://wa.me/6281234567890">chat</a>');
  assert.equal(extractWhatsapp($1), '+6281234567890');
  const $2 = cheerio.load('<a href="https://api.whatsapp.com/send?phone=628123456789">chat</a>');
  assert.equal(extractWhatsapp($2), '+628123456789');
  const $3 = cheerio.load('<a href="https://example.test">nope</a>');
  assert.equal(extractWhatsapp($3), null);
});

test('extractMapPin: a Google Maps q= link', () => {
  const $ = cheerio.load('<a href="https://www.google.com/maps?q=-8.64,115.12">map</a>');
  assert.deepEqual(extractMapPin($), { lat: -8.64, lng: 115.12 });
});

test('parseJsonLd / findListingBlock: RealEstateListing block picked out of the page', () => {
  const $ = cheerio.load(JSONLD_HTML);
  const blocks = parseJsonLd($);
  assert.equal(blocks.length, 1);
  const listing = findListingBlock(blocks);
  assert.ok(listing);
  assert.equal(listing.name, 'Cozy Villa Near Pererenan Beach');
});

test('parseOg: og: and twitter: meta tags', () => {
  const $ = cheerio.load(JSONLD_HTML);
  const og = parseOg($);
  assert.equal(og['og:title'], 'Cozy Villa Near Pererenan Beach');
  assert.equal(og['og:image'], 'https://example.test/og.jpg');
});

// ---------------------------------------------------------------------------
// detail() — the two fixtures end to end
// ---------------------------------------------------------------------------

test('detail(): JSON-LD RealEstateListing + geo + og:image fixture', async () => {
  const ctx = stubCtx({ [JSONLD_URL]: { html: JSONLD_HTML, status: 200 } });
  const d = await generic.detail(ctx, JSONLD_URL);

  assert.ok(d);
  assert.equal(d.source, 'randomsite.test');
  assert.equal(d.ref.length, 12);
  assert.equal(d.title, 'Cozy Villa Near Pererenan Beach');
  assert.equal(d.bedrooms, 2);
  assert.equal(d.build_m2, 150);
  assert.equal(
    d.price_month_idr,
    35_000_000,
    'the text candidate with an explicit period (35M) wins over the bare JSON-LD price (32M)'
  );
  assert.equal(d.lat, -8.64);
  assert.equal(d.lng, 115.12);
  assert.equal(d.pin_source, 'listing_map');
  assert.equal(d.location, 'Pererenan - Beach Side');
  assert.deepEqual(d.images, [{ src_url: 'https://example.test/img1.jpg' }, { src_url: 'https://example.test/img2.jpg' }]);
  assert.deepEqual(d.contacts, [{ role: 'agent', whatsapp: '+6281234567890' }]);
  assert.ok(d.raw && Array.isArray(d.raw.jsonld) && d.raw.jsonld.length === 1);
  assert.ok(Buffer.byteLength(JSON.stringify(d.raw), 'utf8') <= 20 * 1024);

  // ... and normaliseListing resolves it to the right area/price/bedrooms.
  const { row } = normaliseListing(d, DEFAULT_CONFIG);
  assert.equal(row.area, 'pererenan');
  assert.equal(row.bedrooms, 2);
  assert.equal(row.price_month_idr, 35_000_000);
  assert.equal(row.key, `${d.source}:${d.ref}`);
});

test('detail(): plain-text Indonesian listing, no JSON-LD, wa.me contact via api.whatsapp.com', async () => {
  const ctx = stubCtx({ [TEXT_URL]: { html: TEXT_HTML, status: 200 } });
  const d = await generic.detail(ctx, TEXT_URL);

  assert.ok(d);
  assert.equal(d.source, 'someagency.test');
  assert.equal(d.bedrooms, 3, '"3 kamar tidur" via the Indonesian regex fallback');
  assert.equal(d.land_m2, 300, '"luas tanah 300 m2"');
  assert.equal(d.price_month_idr, 35_000_000, '"Rp 35 juta / bulan" — not the nav/script junk price');
  assert.equal(d.location, 'Pererenan - Beach Side');
  assert.deepEqual(d.contacts, [{ role: 'agent', whatsapp: '+628123456789' }]);
  assert.deepEqual(d.images, [], 'no og:image and no JSON-LD image on this fixture');

  const { row } = normaliseListing(d, DEFAULT_CONFIG);
  assert.equal(row.area, 'pererenan');
  assert.equal(row.bedrooms, 3);
  assert.equal(row.price_month_idr, 35_000_000);
});

test('detail(): 404 returns null', async () => {
  const ctx = stubCtx({});
  assert.equal(await generic.detail(ctx, 'https://gone.test/x'), null);
});

test('detail(): an unparseable URL (no hostname) returns null', async () => {
  const ctx = stubCtx({});
  assert.equal(await generic.detail(ctx, 'not a url'), null);
});

test('list(): yields nothing — generic is inbox-only', async () => {
  const items = [];
  for await (const item of generic.list()) items.push(item);
  assert.deepEqual(items, []);
});

test('applyDetail: overlays images/lat/lng/pin_source/address onto the keyword-derived row', () => {
  const row = { bedrooms: 2, images: undefined, lat: null, lng: null, pin_source: null, address: null };
  const d = { images: [{ src_url: 'https://x.test/1.jpg' }], lat: -8.6, lng: 115.1, address: 'Jl. Test No.1' };
  const out = generic.applyDetail(row, d);
  assert.deepEqual(out.images, d.images);
  assert.equal(out.lat, -8.6);
  assert.equal(out.lng, 115.1);
  assert.equal(out.pin_source, 'listing_map');
  assert.equal(out.address, 'Jl. Test No.1');
  assert.equal(generic.applyDetail(row, null), row);
});
