// Bali Realty adapter. Fixtures fetched 2026-09-18, logged out with a browser UA,
// trimmed of <style>/<script>/<link>/<svg> only. No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import balirealty, { cardsFrom, detailFrom, applyDetail } from '../src/scrape/adapters/balirealty.js';
import { normaliseListing } from '../src/scrape/normalise.js';
import { inBand } from '../src/scrape/score.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'test/fixtures/balirealty-index.html'), 'utf8');
const detailHtml = fs.readFileSync(path.join(ROOT, 'test/fixtures/balirealty-detail.html'), 'utf8');

const INDEX_URL = 'https://www.balirealty.com/properties/?filter-contract=RENT&filter-property-type=75';
const DETAIL_URL =
  'https://www.balirealty.com/properties/move-in-ready-3-bedroom-villa-with-spacious-garden-in-pererenan-2984/';

function stubCtx() {
  const map = { [INDEX_URL]: indexHtml, [DETAIL_URL]: detailHtml };
  return {
    config: {},
    log: { warn() {}, info() {} },
    async fetchHtml(url) {
      return map[url] ? { html: map[url], status: 200 } : { html: null, status: 404 };
    },
  };
}

test('cardsFrom keeps the target-area rentals and drops the rest', () => {
  const inArea = cardsFrom(indexHtml, {});
  const all = cardsFrom(indexHtml, {}, { all: true });
  assert.equal(all.length, 12); // the page renders 12 rental cards
  assert.equal(inArea.length, 2); // both Pererenan; the other 10 are Seminyak / Jimbaran / …
  for (const c of inArea) {
    assert.equal(c.source, 'balirealty');
    assert.match(c.ref, /^\d{3,6}$/);
    assert.equal(c.area, 'pererenan', 'the adapter states the §7 area outright');
    assert.ok(c.url.startsWith('https://www.balirealty.com/properties/'));
    assert.ok(Number.isInteger(c.bedrooms));
    assert.ok(c.thumb && c.thumb.startsWith('https://'));
  }
});

test('the 150 M boundary reads a bare card amount as yearly or monthly', () => {
  const c = cardsFrom(indexHtml, {}).find((x) => x.ref === '2984');
  assert.equal(c.price_year_idr, 365_000_000);
  assert.equal(c.price_month_idr, null);
  assert.equal(c.term, 'yearly');
  assert.equal(c.raw.price_currency, 'IDR');
  assert.equal(c.raw.price_original, 365_000_000);
});

test('the card title loses the theme-appended reference', () => {
  const c = cardsFrom(indexHtml, {}).find((x) => x.ref === '2984');
  assert.equal(c.title, 'Move-In Ready 3 Bedroom Villa with Spacious Garden in Pererenan');
  assert.equal(c.bedrooms, 3);
  assert.equal(c.bathrooms, 3);
});

test('list() walks the rental filter and yields only in-area cards', async () => {
  const out = [];
  for await (const card of balirealty.list(stubCtx())) out.push(card);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.ref).sort(), ['2984', '2985']);
});

test('detail() states the period in full and wins over the card', async () => {
  const d = await balirealty.detail(stubCtx(), DETAIL_URL);
  assert.equal(d.source, 'balirealty');
  assert.equal(d.ref, '2984');
  assert.equal(d.title, 'Move-In Ready 3 Bedroom Villa with Spacious Garden in Pererenan');
  assert.equal(d.price_year_idr, 365_000_000); // "IDR 365,000,000/year"
  assert.equal(d.price_month_idr, null);
  assert.equal(d.term, 'yearly');
  assert.equal(d.bedrooms, 3);
  assert.equal(d.bathrooms, 3);
  assert.equal(d.land_m2, 350);
  assert.equal(d.area, 'pererenan'); // from body class `locations-pererenan`
  assert.equal(d.location, 'Pererenan');
  assert.equal(d.gone, false);
  assert.match(d.description, /quiet area of Pererenan/);
  assert.ok(!/Property Description/.test(d.description), 'the section heading is stripped');
});

test('detail() takes the gallery, the agent WhatsApp and no map pin', async () => {
  const d = await balirealty.detail(stubCtx(), DETAIL_URL);
  assert.equal(d.images.length, 9);
  assert.ok(d.images.every((i) => i.src_url.startsWith('https://www.balirealty.com/wp-content/uploads/')));
  assert.deepEqual(d.contacts, [
    { role: 'agency', name: 'Bali Realty — Vherina', whatsapp: '+6281908196990' },
  ]);
  assert.equal(d.lat, null); // #simple-map ships with data-latitude=""
  assert.equal(d.pin_source, null);
});

test('detail() only keeps the facilities this villa actually has', async () => {
  const d = await balirealty.detail(stubCtx(), DETAIL_URL);
  // Every facility is rendered; the ones it lacks carry class="no".
  assert.equal(d.terms, null);
  assert.deepEqual(d.raw.amenities, []);
});

test('detail() returns null for a 404 and for a page that is not a property', async () => {
  assert.equal(await balirealty.detail(stubCtx(), 'https://www.balirealty.com/nope/'), null);
  assert.equal(detailFrom('<html><body>nothing</body></html>', DETAIL_URL), null);
});

test('a card normalises into an in-band Pererenan row', () => {
  const card = cardsFrom(indexHtml, {}).find((c) => c.ref === '2984');
  const { row } = normaliseListing(card);
  assert.equal(row.key, 'balirealty:2984');
  assert.equal(row.area, 'pererenan');
  assert.equal(row.price_month_idr, Math.round(365_000_000 / 12));
  assert.equal(inBand(row), true);
});

test('applyDetail overlays the asserted facts', () => {
  const card = cardsFrom(indexHtml, {}).find((c) => c.ref === '2984');
  const { row } = normaliseListing(card);
  const d = detailFrom(detailHtml, DETAIL_URL);
  const merged = applyDetail({ ...row, land_m2: null }, d);
  assert.equal(merged.land_m2, 350);
  assert.equal(merged.images.length, 9);
  assert.equal(applyDetail(row, null), row);
});

test('the adapter object has the SPEC §6 shape', () => {
  assert.equal(balirealty.id, 'balirealty');
  assert.equal(balirealty.base, 'https://www.balirealty.com');
  assert.equal(typeof balirealty.list, 'function');
  assert.equal(typeof balirealty.detail, 'function');
  assert.equal(typeof balirealty.applyDetail, 'function');
});
