// Kibarer Property adapter (villabalisale.com). Fixtures were fetched 2026-09-18,
// logged out with a browser UA, and trimmed of <style>/<script>/<link>/<svg> only.
// Nothing here touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import kibarer, { cardsFrom, detailFrom, lastPageOf, applyDetail, TARGET_SLUGS } from '../src/scrape/adapters/kibarer.js';
import { normaliseListing } from '../src/scrape/normalise.js';
import { inBand } from '../src/scrape/score.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'test/fixtures/kibarer-index.html'), 'utf8');
const detailHtml = fs.readFileSync(path.join(ROOT, 'test/fixtures/kibarer-detail.html'), 'utf8');

const INDEX_URL = 'https://www.villabalisale.com/realestate-property/for-rent/villa/all/pererenan';
const DETAIL_URL =
  'https://www.villabalisale.com/realestate-property/for-rent/villa/annually/pererenan/' +
  'minimalist-two-bedroom-villa-in-pererenan-yrv4752';

/** A ctx that serves the fixtures and 404s everything else. */
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

test('cardsFrom reads every in-area card off the Pererenan index page', () => {
  const cards = cardsFrom(indexHtml, {});
  assert.equal(cards.length, 10);
  for (const c of cards) {
    assert.equal(c.source, 'kibarer');
    assert.match(c.ref, /^[A-Z]{2,4}\d{3,6}$/);
    assert.ok(c.url.startsWith('https://www.villabalisale.com/realestate-property/for-rent/'));
    assert.ok(c.title && c.title.length > 5);
    assert.equal(c.area, 'pererenan', 'the adapter states the §7 area outright');
    assert.equal(c.location, c.raw.site_location);
    assert.ok(Number.isInteger(c.bedrooms) && c.bedrooms >= 1);
    assert.ok(c.price_month_idr != null || c.price_year_idr != null);
    assert.ok(['monthly', 'yearly', 'both'].includes(c.term));
  }
});

test('cardsFrom keeps the price on the side of the period the card states', () => {
  const cards = cardsFrom(indexHtml, {});
  const yearly = cards.find((c) => c.ref === 'YRV4752');
  assert.equal(yearly.price_year_idr, 220_000_000);
  assert.equal(yearly.price_month_idr, null);
  assert.equal(yearly.bedrooms, 2);
  assert.equal(yearly.land_m2, 120); // "1.2 Are"
  assert.equal(yearly.build_m2, 100); // "100 m²"

  const monthly = cards.find((c) => c.ref === 'YRC5202');
  assert.equal(monthly.price_month_idr, 45_000_000);
  assert.equal(monthly.price_year_idr, null);
  assert.equal(monthly.term, 'monthly');
});

test('cardsFrom({all:true}) also returns the cards with no §7 area', () => {
  const all = cardsFrom(indexHtml, {}, { all: true });
  assert.ok(all.length >= cardsFrom(indexHtml, {}).length);
  for (const c of all) assert.ok('area' in c);
});

test('the sub-area keeps only what is finer than the area', () => {
  const cards = cardsFrom(indexHtml, {}, { all: true });
  const plain = cards.find((c) => c.raw.site_location === 'Pererenan');
  assert.equal(plain.sub_area, null);
  const tumbak = cards.find((c) => c.raw.site_location === 'Pererenan, Tumbak');
  assert.equal(tumbak.sub_area, 'Tumbak');
  assert.equal(tumbak.beach_km_hint, 4, 'SPEC §7 puts the inland pockets ≈4 km out');
});

test('lastPageOf finds the highest page the paginator links to', () => {
  assert.equal(lastPageOf(indexHtml), 15);
  assert.equal(lastPageOf('<html>no pagination</html>'), null);
});

test('list() walks one area and yields the fixture cards', async () => {
  const ctx = stubCtx();
  const out = [];
  for await (const card of kibarer.list(ctx, { areas: ['pererenan'] })) out.push(card);
  assert.equal(out.length, 10);
  assert.equal(new Set(out.map((c) => c.ref)).size, 10);
});

test('detail() returns the facts the page states', async () => {
  const d = await kibarer.detail(stubCtx(), DETAIL_URL);
  assert.equal(d.source, 'kibarer');
  assert.equal(d.ref, 'YRV4752');
  assert.equal(d.title, 'Sleek Living – Two Bedroom Private Pool Villa in Pererenan');
  assert.equal(d.bedrooms, 2);
  assert.equal(d.bathrooms, 3);
  assert.equal(d.land_m2, 120);
  assert.equal(d.build_m2, 100);
  assert.equal(d.price_year_idr, 220_000_000);
  assert.equal(d.price_month_idr, null);
  assert.equal(d.term, 'yearly');
  assert.equal(d.pool, 1);
  assert.equal(d.kitchen_full, 1);
  assert.equal(d.aircon, 1);
  assert.equal(d.gone, false);
  assert.match(d.description, /prime area of Pererenan/);
  assert.equal(d.area, 'pererenan');
  assert.equal(d.location, 'Pererenan');
});

test('detail() takes the gallery but not the similar-properties carousel', async () => {
  const d = await kibarer.detail(stubCtx(), DETAIL_URL);
  assert.equal(d.images.length, 13);
  assert.ok(d.images.every((i) => !i.src_url.includes('/uploads/images/property/thumb/')));
  assert.equal(new Set(d.images.map((i) => i.src_url)).size, 13);
});

test('detail() reads the commented-out WhatsApp button and leaves the fake pin alone', async () => {
  const d = await kibarer.detail(stubCtx(), DETAIL_URL);
  assert.deepEqual(d.contacts, [
    { role: 'agency', name: 'Kibarer Property', whatsapp: '+6288219082080' },
  ]);
  // data-latitude on .property-detail is the agency office, identical on every
  // listing — adapters/kibarer.md. It must not become a listing_map pin.
  assert.equal(d.lat, null);
  assert.equal(d.lng, null);
  assert.equal(d.pin_source, null);
});

test('detail() returns null for a 404 and for a page with no property markup', async () => {
  assert.equal(await kibarer.detail(stubCtx(), 'https://www.villabalisale.com/nope'), null);
  assert.equal(detailFrom('<html><body>nothing</body></html>', DETAIL_URL), null);
});

test('a card normalises into an in-band Pererenan row', () => {
  const card = cardsFrom(indexHtml, {}).find((c) => c.ref === 'YRV4752');
  const { row } = normaliseListing(card);
  assert.equal(row.key, 'kibarer:YRV4752');
  assert.equal(row.area, 'pererenan');
  assert.equal(row.price_year_idr, 220_000_000);
  assert.equal(row.price_month_idr, Math.round(220_000_000 / 12));
  assert.equal(inBand(row), true);
});

test('applyDetail overlays the asserted facts and the gallery', () => {
  const card = cardsFrom(indexHtml, {}).find((c) => c.ref === 'YRV4752');
  const { row } = normaliseListing(card);
  const d = detailFrom(detailHtml, DETAIL_URL);
  const merged = applyDetail({ ...row, pool: null, bathrooms: null }, d);
  assert.equal(merged.pool, 1);
  assert.equal(merged.bathrooms, 3);
  assert.equal(merged.images.length, 13);
  assert.equal(applyDetail(row, null), row);
  assert.equal(applyDetail(row, { ...d, gone: true }).availability, 'gone');
});

test('the adapter object has the SPEC §6 shape', () => {
  assert.equal(kibarer.id, 'kibarer');
  assert.equal(kibarer.base, 'https://www.villabalisale.com');
  assert.equal(typeof kibarer.list, 'function');
  assert.equal(typeof kibarer.detail, 'function');
  assert.equal(typeof kibarer.applyDetail, 'function');
  assert.ok(Array.isArray(kibarer.areas) && kibarer.areas.includes('pererenan'));
});

test('TARGET_SLUGS covers the west-coast and Canggu-belt indexes probed 2026-09-26', () => {
  // The original six plus the villages that were previously never reached.
  const added = [
    'mengwi', 'buwit', 'kedungu', 'nyanyi', 'tanah-lot',
    'munggu', 'cemagi', 'seseh', 'padonan',
    'tibubeneng', 'babakan', 'berawa', 'umalas',
    'balangan', 'bingin', 'padang-padang', 'ungasan', 'pandawa',
  ];
  for (const slug of added) assert.ok(TARGET_SLUGS.includes(slug), `missing ${slug}`);
  // The pre-existing slugs stay.
  for (const slug of ['pererenan', 'tabanan', 'uluwatu', 'bukit', 'canggu', 'ubud']) {
    assert.ok(TARGET_SLUGS.includes(slug), `missing ${slug}`);
  }
  assert.equal(new Set(TARGET_SLUGS).size, TARGET_SLUGS.length, 'no duplicate slugs');
});

/** Builds one synthetic index page: one fresh, in-area card plus a paginator that
 * links up to `lastPage`. Used to prove the adapter walks past the shared
 * `_shared.MAX_PAGES` (10) cap that other adapters still use. */
function syntheticPage(page, lastPage) {
  const nav = [...Array(lastPage).keys()].map((i) => `<a class="page-link" href="?page=${i + 1}">${i + 1}</a>`).join('');
  return `<html><body>
    <div class="property-thumbnail" data-id="${page}">
      <a href="/realestate-property/for-rent/villa/annually/canggu/villa-p${page}-yrz${1000 + page}"></a>
      <span class="property-code">YRZ${1000 + page}</span>
      <div class="property-title">Synthetic Villa ${page}</div>
      <div class="property-location"><div>Canggu, Berawa</div></div>
      <div class="property-price"><div class="property-status">Yearly Rent</div><span>idr 200,000,000 / Annually</span></div>
    </div>
    <div class="pagination">${nav}</div>
  </body></html>`;
}

test('list() walks a slug past the shared 10-page cap up to the Kibarer-specific one', async () => {
  const LAST_PAGE = 20; // > _shared.MAX_PAGES (10), well under the 50-page ceiling
  const ctx = {
    config: {},
    log: { warn() {}, info() {} },
    async fetchHtml(url) {
      const m = /[?&]page=(\d+)/.exec(url);
      const page = m ? Number(m[1]) : 1;
      if (page > LAST_PAGE) return { html: null, status: 404 };
      return { html: syntheticPage(page, LAST_PAGE), status: 200 };
    },
  };
  const out = [];
  for await (const card of kibarer.list(ctx, { areas: ['canggu'] })) out.push(card);
  assert.equal(out.length, LAST_PAGE, 'every page up to the paginator\'s own last page was walked');
  assert.equal(new Set(out.map((c) => c.ref)).size, LAST_PAGE, 'refs stay deduped across pages');
});
