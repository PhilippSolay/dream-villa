// Bali Coconut Living adapter. Fixtures fetched 2026-09-18, logged out with a browser
// UA; trimmed of <style>/<link>/<svg> and of every <script> except the commented-out
// Google-Maps bootstrap that carries the listing's marker. No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import bcl, { cardsFrom, detailFrom, applyDetail, parseMeta } from '../src/scrape/adapters/balicoconutliving.js';
import { normaliseListing } from '../src/scrape/normalise.js';
import { inBand } from '../src/scrape/score.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'test/fixtures/balicoconutliving-index.html'), 'utf8');
const detailHtml = fs.readFileSync(path.join(ROOT, 'test/fixtures/balicoconutliving-detail.html'), 'utf8');

const INDEX_URL = 'https://balicoconutliving.com/property/villa-for-long-term-rental';
const DETAIL_URL = 'https://balicoconutliving.com/bali-villa-monthly-rental/Pererenan/1502-V009-1466/Villa-Pelangi';

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

test('parseMeta splits the card meta line', () => {
  assert.deepEqual(parseMeta('ID V009-4425 | VILLA - Pererenan'), {
    ref: 'V009-4425',
    location: 'Pererenan',
  });
  assert.deepEqual(parseMeta('ID V005-6056 | VILLA - Kayu Tulang, Canggu'), {
    ref: 'V005-6056',
    location: 'Kayu Tulang, Canggu',
  });
  assert.deepEqual(parseMeta(''), { ref: null, location: null });
});

test('cardsFrom keeps the target-area rentals and drops the rest', () => {
  const inArea = cardsFrom(indexHtml, {});
  const all = cardsFrom(indexHtml, {}, { all: true });
  assert.equal(all.length, 12); // 12 cards a page
  assert.equal(inArea.length, 4); // all four Pererenan
  for (const c of inArea) {
    assert.equal(c.source, 'balicoconutliving');
    assert.match(c.ref, /^V\d{3}-\d{3,5}$/);
    assert.equal(c.area, 'pererenan', 'the adapter states the §7 area outright');
    assert.equal(c.location, 'Pererenan');
    assert.ok(c.url.startsWith('https://balicoconutliving.com/bali-villa-'));
    assert.ok(Number.isInteger(c.bedrooms));
    // A "for rent and sale" card can render only its leasehold pane, leaving both
    // rental columns null — the band check drops it, which is the right outcome.
    for (const k of ['price_month_idr', 'price_year_idr']) {
      assert.ok(c[k] === null || c[k] > 0, `${c.ref} ${k}`);
    }
  }
  assert.equal(inArea.filter((c) => c.price_month_idr != null || c.price_year_idr != null).length, 3);
});

test('cardsFrom reads the per-term price panes and the rented label', () => {
  const c = cardsFrom(indexHtml, {}).find((x) => x.ref === 'V009-4425');
  assert.equal(c.title, 'BEAUTIFUL 1 BEDROOM APARTMENT IN PERERENAN FOR MONTHLY RENT');
  assert.equal(c.price_month_idr, 30_000_000); // "IDR 30.000.000" — dot thousands
  assert.equal(c.price_year_idr, null);
  assert.equal(c.term, 'monthly');
  assert.equal(c.bedrooms, 1);
  assert.equal(c.land_m2, 90);
  assert.equal(c.build_m2, 45);
  assert.equal(c.note, 'Rented Until October 2026');
  assert.equal(c.gone, true);
  assert.ok(c.thumb.startsWith('https://balicoconutliving.com/upload/image/property/'));
  assert.ok(!c.thumb.includes('/_thumb/'), 'the card thumb is upgraded to full size');
});

test('list() walks the long-term index and yields only in-area cards', async () => {
  const out = [];
  for await (const card of bcl.list(stubCtx())) out.push(card);
  assert.equal(out.length, 4);
  assert.equal(new Set(out.map((c) => c.ref)).size, 4);
});

test('detail() reads the fact list, description and facilities', async () => {
  const d = await bcl.detail(stubCtx(), DETAIL_URL);
  assert.equal(d.source, 'balicoconutliving');
  assert.equal(d.ref, 'V009-1466');
  assert.equal(d.title, 'Villa Pelangi');
  assert.equal(d.bedrooms, 1);
  assert.equal(d.bathrooms, 1);
  assert.equal(d.land_m2, 250);
  assert.equal(d.pool, 1);
  assert.equal(d.furnished, 1);
  assert.equal(d.living_open, 1);
  assert.equal(d.garden, 1);
  assert.equal(d.kitchen_full, 1);
  assert.equal(d.aircon, 1);
  assert.equal(d.area, 'pererenan');
  assert.equal(d.location, 'Pererenan');
  assert.match(d.description, /cottage style villa/);
  assert.ok(d.raw.included.includes('Pool Maintenance'));
});

test('detail() reads the commented-out map marker as a listing pin', async () => {
  const d = await bcl.detail(stubCtx(), DETAIL_URL);
  assert.equal(d.lat, -8.6426109);
  assert.equal(d.lng, 115.12913159999994);
  assert.equal(d.pin_source, 'listing_map');
  assert.deepEqual(d.contacts, [
    { role: 'agency', name: 'Bali Coconut Living', whatsapp: '+623618476727' },
  ]);
});

test('detail() takes the full-size gallery, capped and deduped', async () => {
  const d = await bcl.detail(stubCtx(), DETAIL_URL);
  assert.equal(d.images.length, 7);
  assert.ok(d.images.every((i) => i.src_url.includes('/upload/image/property_gallery/')));
  assert.ok(d.images.every((i) => !i.src_url.includes('/_thumb/')));
  assert.ok(d.images.length <= 20);
});

test('detail() returns null for a 404 and for a page with no fact list', async () => {
  assert.equal(await bcl.detail(stubCtx(), 'https://balicoconutliving.com/nope'), null);
  assert.equal(detailFrom('<html><body>nothing</body></html>', DETAIL_URL), null);
});

test('a card normalises into an in-band Pererenan row', () => {
  const card = cardsFrom(indexHtml, {}).find((c) => c.ref === 'V009-4425');
  const { row } = normaliseListing(card);
  assert.equal(row.key, 'balicoconutliving:V009-4425');
  assert.equal(row.area, 'pererenan');
  assert.equal(row.price_month_idr, 30_000_000);
  assert.equal(inBand(row), true);
});

test('the detail page states nothing about availability, so the card decides', () => {
  const d = detailFrom(detailHtml, DETAIL_URL);
  // Every `.property-label` on a detail page belongs to an "OTHER PROPERTY" card.
  assert.equal(d.gone, null);
  const rented = cardsFrom(indexHtml, {}).find((c) => c.ref === 'V009-4425');
  assert.equal(rented.gone, true);
  const row = normaliseListing({ ...rented, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v != null)) }).row;
  assert.equal(applyDetail(row, d).availability, 'gone', "the card's Rented label survives");
});

test('applyDetail overlays the asserted facts and the listing pin', () => {
  const card = cardsFrom(indexHtml, {}).find((c) => c.ref === 'V009-4425');
  const { row } = normaliseListing(card);
  const d = detailFrom(detailHtml, DETAIL_URL);
  const merged = applyDetail({ ...row, pool: null, lat: null, lng: null }, d);
  assert.equal(merged.pool, 1);
  assert.equal(merged.lat, -8.6426109);
  assert.equal(merged.pin_source, 'listing_map');
  assert.equal(merged.images.length, 7);
  assert.equal(applyDetail(row, null), row);
  assert.equal(applyDetail(row, { ...d, gone: true }).availability, 'gone');
});

test('the adapter object has the SPEC §6 shape', () => {
  assert.equal(bcl.id, 'balicoconutliving');
  assert.equal(bcl.base, 'https://balicoconutliving.com');
  assert.equal(typeof bcl.list, 'function');
  assert.equal(typeof bcl.detail, 'function');
  assert.equal(typeof bcl.applyDetail, 'function');
});
