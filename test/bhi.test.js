// Bali Home Immo adapter + `npm run seed`.
// Fixture: test/fixtures/bhi-rf9183d.html — a real detail page fetched 2026-09-17
// (logged out, browser UA). Nothing here touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import bhi, { parseInertia, htmlToText, mapView, mapStyle } from '../src/scrape/adapters/bhi.js';
import { normaliseListing } from '../src/scrape/normalise.js';
import { scoreRow } from '../src/scrape/score.js';
import { openDb, getConfig } from '../src/db.js';
import { countsSummary, parseRow } from '../src/scrape/store.js';
import { importSweep } from '../src/seed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_HTML = path.join(ROOT, 'test/fixtures/bhi-rf9183d.html');
const SWEEP = path.join(ROOT, 'seed/bhi-sweep-2026-09-17.json');

const html = fs.readFileSync(FIXTURE_HTML, 'utf8');
const DETAIL_URL =
  'https://bali-home-immo.com/realestate-property/for-rent/villa/monthly/seseh/' +
  'modern-3-bedroom-villa-for-rental-in-bali-cemagi-beachside-rf9183d';

/** A ctx that serves the fixture for the one URL under test. */
function stubCtx(map = { [DETAIL_URL]: { html, status: 200 } }) {
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
// parseInertia
// ---------------------------------------------------------------------------

test('parseInertia reads the Inertia data-page payload off a real detail page', () => {
  const props = parseInertia(html);
  assert.ok(props, 'props parsed');
  assert.equal(props.property.property_id, 'RF9183D');
  assert.equal(props.propertyPriceCategory, 'monthly');
  assert.equal(props.meta.wa_phone_number, '6282194359401');
});

test('parseInertia returns null when there is no data-page', () => {
  assert.equal(parseInertia('<html><body>nope</body></html>'), null);
  assert.equal(parseInertia(''), null);
  assert.equal(parseInertia('<div id="app" data-page="{not json"></div>'), null);
});

test('htmlToText strips tags, keeps paragraph breaks, decodes entities', () => {
  assert.equal(htmlToText('<p>One</p>\r\n<p>Two &amp; three</p>'), 'One\n\nTwo & three');
  assert.equal(htmlToText('a<br />b'), 'a\n\nb');
  assert.equal(htmlToText(''), null);
});

test('mapView / mapStyle map the site vocabulary to SPEC §3 values', () => {
  assert.equal(mapView('Ocean'), 'ocean');
  assert.equal(mapView('Rice field'), 'rice');
  assert.equal(mapView('River'), 'river');
  assert.equal(mapView('Jungle'), 'jungle');
  assert.equal(mapView('Mountain'), 'mountain');
  assert.equal(mapView('Garden'), 'none');
  assert.equal(mapView('Pool'), 'none');
  assert.equal(mapView(undefined), null);

  assert.equal(mapStyle('Modern'), 'modern');
  assert.equal(mapStyle('Tropical'), 'tropical');
  assert.equal(mapStyle('Joglo'), 'joglo');
  // SPEC §6: "traditional Balinese" is a candidate for review, never asserted here.
  assert.equal(mapStyle('Balinese Traditional'), null);
});

// ---------------------------------------------------------------------------
// detail()
// ---------------------------------------------------------------------------

test('detail() reads RF9183D out of the fixture page', async () => {
  const d = await bhi.detail(stubCtx(), DETAIL_URL);
  assert.ok(d);

  assert.equal(d.source, 'bhi');
  assert.equal(d.ref, 'RF9183D');
  assert.equal(d.title, 'Modern 3 Bedroom Villa for Rental in Bali Cemagi Beachside');
  assert.equal(d.location, 'Cemagi / Seseh - Beach Side');

  assert.equal(d.bedrooms, 3);
  assert.equal(d.bathrooms, 2);
  assert.equal(d.land_m2, 100);
  assert.equal(d.build_m2, 158);

  assert.equal(d.price_month_idr, 44_000_000);
  assert.equal(d.price_year_idr, 450_000_000);
  assert.equal(d.term, 'both');

  assert.equal(d.furnished, 1);
  assert.equal(d.pool, 1);
  assert.equal(d.living_open, 0); // "Living room: Enclosed"
  assert.equal(d.kitchen_full, 1);
  assert.equal(d.aircon, 1); // "Air Conditioner: 4"
  assert.equal(d.view, 'none'); // "View: Pool"
  assert.equal(d.style_hint, 'modern');

  assert.ok(Math.abs(d.lat - -8.6435654) < 1e-6);
  assert.ok(Math.abs(d.lng - 115.1078041) < 1e-6);
  assert.equal(d.pin_source, 'listing_map');

  assert.equal(d.images.length, 20);
  assert.match(d.images[0].src_url, /^https:\/\/bali-home-immo\.com\/images\/properties\//);

  assert.equal(d.available_from, '2027-02-01');
  assert.equal(d.gone, true); // is_archived
  assert.equal(d.inclusions.Electricity, 'Included');
  assert.equal(d.inclusions.remark, 'Pool maintenance 2x/week');

  assert.deepEqual(d.contacts, [
    { role: 'agency', name: 'Bali Home Immo', whatsapp: '+6282194359401' },
  ]);

  assert.match(d.description, /^Can be visited from 1\/02\/2027/);
  assert.ok(d.description.includes('\n\n'), 'paragraph breaks kept');
  assert.ok(!/[<>]/.test(d.description), 'no tags left');

  // raw stays small: the three bulky duplicate blocks are dropped.
  assert.equal(d.raw.seo, undefined);
  assert.equal(d.raw.list_thumb_by_category, undefined);
  assert.equal(d.raw.grouped_attributes_by_category, undefined);
});

test('detail() returns null on 404 and on a page with no property JSON', async () => {
  assert.equal(await bhi.detail(stubCtx(), 'https://bali-home-immo.com/nope'), null);
  const noProps = stubCtx({ 'https://x/y': { html: '<html></html>', status: 200 } });
  assert.equal(await bhi.detail(noProps, 'https://x/y'), null);
});

test('normaliseListing over the detail partial gives the row the app stores', async () => {
  const d = await bhi.detail(stubCtx(), DETAIL_URL);
  const { row } = normaliseListing(d);

  assert.equal(row.key, 'bhi:RF9183D');
  assert.equal(row.area, 'cemagi');
  assert.equal(row.sub_area, 'Beach Side');
  assert.equal(row.min_months, 2); // "Minimum 2 months rental"
  assert.equal(row.beach_km, 1); // "Walking distance to the beach"
  assert.equal(row.beach_source, 'listing_text');
  assert.equal(row.bedrooms, 3);
  assert.equal(row.price_month_idr, 44_000_000);
  assert.equal(row.term, 'both');

  const scored = scoreRow(row);
  assert.equal(typeof scored.fit_score, 'number');
  assert.ok(scored.fit_score >= 0 && scored.fit_score <= 100);

  // applyDetail lets the stated facts beat the keyword guesses.
  const merged = bhi.applyDetail(row, d);
  assert.equal(merged.living_open, 0);
  assert.equal(merged.view, 'none');
  assert.equal(merged.pool, 1);
  assert.equal(merged.bathrooms, 2);
  assert.equal(merged.availability, 'gone'); // is_archived
  assert.equal(JSON.parse(merged.inclusions).Electricity, 'Included');
  assert.equal(typeof scoreRow(merged).fit_score, 'number');
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

/** Minimal stand-in for an index page's Inertia payload (real shape, two entries). */
function indexHtml(entries, pagination = { current_page: 1, last_page: 1 }) {
  const page = { component: 'Property/Index', props: { properties: entries, pagination }, url: '/x', version: '1' };
  const escaped = JSON.stringify(page)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
  return `<html><body><div id="app" data-page="${escaped}"></div></body></html>`;
}

const entry = (id, over = {}) => ({
  id: 1,
  property_id: id,
  name: `Villa ${id}`,
  slug: `villa-${id.toLowerCase()}`,
  detail_urls: {
    monthly: `https://bali-home-immo.com/realestate-property/for-rent/villa/monthly/seseh/villa-${id.toLowerCase()}`,
    yearly: `https://bali-home-immo.com/realestate-property/for-rent/villa/yearly/seseh/villa-${id.toLowerCase()}`,
  },
  area: 'Cemagi / Seseh',
  subarea: 'Beach Side',
  latitude: '-8.64',
  longitude: '115.10',
  images: ['https://bali-home-immo.com/images/properties/thumb/a.jpg'],
  is_archived: false,
  is_new: false,
  prices: { monthly: '40000000.0000' },
  list_thumb_by_category: { monthly: [{ label: 'Bedroom', value: '2', suffix: 'bedroom(s)' }] },
  label: null,
  ...over,
});

test('list() reads the index Inertia payload and dedupes refs across terms', async () => {
  const monthly = indexHtml([entry('RF1'), entry('RF2')]);
  const yearly = indexHtml([
    entry('RF2', { prices: { yearly: '450000000.0000' }, list_thumb_by_category: { yearly: [{ label: 'Bedroom', value: '2' }] } }),
    entry('RF3', { prices: { yearly: '450000000.0000' }, list_thumb_by_category: { yearly: [{ label: 'Bedroom', value: '3' }] } }),
  ]);
  const empty = indexHtml([]);

  const pages = {
    'https://bali-home-immo.com/realestate-property/for-rent/villa/monthly/seseh': { html: monthly, status: 200 },
    'https://bali-home-immo.com/realestate-property/for-rent/villa/yearly/seseh': { html: yearly, status: 200 },
  };
  const ctx = { async fetchHtml(url) { return pages[url] || { html: empty, status: 200 }; } };

  const out = [];
  for await (const item of bhi.list(ctx, { areas: ['seseh'] })) out.push(item);

  assert.deepEqual(out.map((o) => o.ref), ['RF1', 'RF2', 'RF3']);
  assert.equal(out[0].url, 'https://bali-home-immo.com/realestate-property/for-rent/villa/monthly/seseh/villa-rf1');
  assert.equal(out[0].category, 'monthly/seseh');
  assert.equal(out[0].location, 'Cemagi / Seseh - Beach Side');
  assert.equal(out[0].bedrooms, 2);
  assert.equal(out[0].price_month_idr, 40_000_000);

  // RF2 turns up under both terms → one item, term upgraded to 'both', both prices kept.
  const rf2 = out.find((o) => o.ref === 'RF2');
  assert.equal(rf2.term, 'both');
  assert.equal(rf2.price_month_idr, 40_000_000);
  assert.equal(rf2.price_year_idr, 450_000_000);
  assert.equal(out[2].term, 'yearly');
});

test('list() stops an area on an empty page', async () => {
  const ctx = { async fetchHtml() { return { html: indexHtml([]), status: 200 }; } };
  const out = [];
  for await (const item of bhi.list(ctx, { areas: ['seseh'], terms: ['monthly'] })) out.push(item);
  assert.equal(out.length, 0);
});

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

test('importSweep imports the 2026-09-17 sweep (cards only)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-seed-'));
  const db = openDb(path.join(dir, 'villa.db'));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const stats = await importSweep(db, SWEEP, { detail: false });

  // 324 raw rows, one of them (RF10336) is the known concatenated-cards dirt.
  assert.equal(stats.lines, 324);
  assert.deepEqual(stats.dirty, ['RF10336']);
  assert.equal(stats.seen, 323);
  assert.equal(stats.new, 323);

  const counts = countsSummary(db);
  assert.equal(counts.total, 323);
  assert.ok(counts.in_filter >= 60, `acceptance §11: in_filter ${counts.in_filter} >= 60`);

  const bad = db
    .prepare("SELECT COUNT(*) AS n FROM properties WHERE area IS NULL OR area = '' OR area = 'undefined'")
    .get().n;
  assert.equal(bad, 0, 'every row has an area');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM properties WHERE ref = ?').get('RF10336').n, 0);

  // first_seen comes from the sweep file, not from "now".
  const one = parseRow(db.prepare('SELECT * FROM properties WHERE ref = ?').get('RF10679'));
  assert.equal(one.first_seen, '2026-09-17T12:48:18.596Z');
  assert.equal(one.key, 'bhi:RF10679');
  assert.ok(Array.isArray(one.images) && one.images[0].src_url.includes('/images/properties/thumb/'));
  assert.ok(one.map_url, 'a pin was placed');

  const run = db.prepare("SELECT * FROM runs WHERE kind = 'seed' ORDER BY id DESC").get();
  assert.ok(run, 'a seed run row exists');
  assert.ok(run.finished_at, 'the run was closed');
  assert.equal(run.seen, 323);
});
