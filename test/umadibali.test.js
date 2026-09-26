// Uma di Bali Properties adapter. Fixtures fetched 2026-09-26, logged out with a browser
// UA, trimmed of <script>/<style>/<link>/<svg>/<noscript> and of the enquiry form:
//   umadibali-index.html          yearly rentals in Umalas, page 1 of 34 (12 a page)
//   umadibali-index-monthly.html  monthly rentals in Umalas, page 1 of 2
//   umadibali-detail.html         VB 016, Villa La Luna Pererenan (available)
//   umadibali-detail-avail.html   IP 874, Villa Sani Umalas ("Avail Oct 30, 2026")
// No network. "Today" is pinned to the fixture date so the availability rule is stable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import uma, {
  cardsFrom, detailFrom, applyDetail, lastPageOf, parseCode, availDateFrom, statusFrom, searchUrl,
  LOCATIONS, PER_PAGE, UPCOMING_MONTHS, DETAIL_TTL_HOURS,
} from '../src/scrape/adapters/umadibali.js';
import { normaliseListing } from '../src/scrape/normalise.js';
import { inBand } from '../src/scrape/score.js';
import { ingestListing, stripNulls } from '../src/scrape/ingest.js';
import { upsertProperty } from '../src/scrape/store.js';
import { openDb } from '../src/db.js';
import { DEFAULT_CONFIG } from '../src/defaults.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => fs.readFileSync(path.join(ROOT, 'test/fixtures', name), 'utf8');
const yearlyHtml = fixture('umadibali-index.html');
const monthlyHtml = fixture('umadibali-index-monthly.html');
const detailHtml = fixture('umadibali-detail.html');
const availHtml = fixture('umadibali-detail-avail.html');

const NOW = new Date('2026-09-26T00:00:00.000Z');
const DETAIL_URL = 'https://umadibali.com/villa/bali-longterm-rental-villa-la-luna-pererenan-vb-016/';
const AVAIL_URL = 'https://umadibali.com/villa/bali-long-term-rental-villa-sani-umalas-ip-874/';

const yearly = (opts = {}) => cardsFrom(yearlyHtml, {}, { location: 'Umalas', now: NOW, ...opts });
const monthly = (opts = {}) => cardsFrom(monthlyHtml, {}, { location: 'Umalas', now: NOW, ...opts });
const byRef = (cards, ref) => cards.find((c) => c.ref === ref);

function stubCtx(extra = {}) {
  const map = {
    [searchUrl('yearly_rental', 'umalas', 1)]: yearlyHtml,
    [searchUrl('monthly_rental', 'umalas', 1)]: monthlyHtml,
    [DETAIL_URL]: detailHtml,
    [AVAIL_URL]: availHtml,
  };
  const requested = [];
  const infos = [];
  return {
    config: {},
    now: NOW,
    requested,
    infos,
    log: { warn() {}, info: (m) => infos.push(m) },
    async fetchHtml(url) {
      requested.push(url);
      return map[url] ? { html: map[url], status: 200 } : { html: null, status: 404 };
    },
    ...extra,
  };
}

function tmpDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-umadibali-'));
  const db = openDb(path.join(dir, 'villa.db'));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

// ---------------------------------------------------------------------------
// the code line and the availability rule
// ---------------------------------------------------------------------------

test('parseCode normalises the site code into the ref and keeps the note after it', () => {
  assert.deepEqual(parseCode('IP 874 - Avail Oct 30, 2026'), { ref: 'IP-874', code: 'IP 874', suffix: 'Avail Oct 30, 2026' });
  assert.deepEqual(parseCode('Code : IP 036'), { ref: 'IP-036', code: 'IP 036', suffix: null });
  assert.deepEqual(parseCode('VB 016 '), { ref: 'VB-016', code: 'VB 016', suffix: null });
  assert.equal(parseCode('AR 18 - RENTED OUT - Avail Dec 2024').ref, 'AR-18', 'digits are kept as printed');
  assert.equal(parseCode('IP 1000 - Avail Nov 2026').ref, 'IP-1000');
  assert.equal(parseCode('BVB 359').ref, 'BVB-359');
  assert.equal(parseCode('IP 312 - Minim 2 years lease').suffix, 'Minim 2 years lease');
  assert.equal(parseCode('').ref, null);
  assert.equal(parseCode('TBA').ref, null);
});

test('availDateFrom reads the dates agents write after the code', () => {
  assert.equal(availDateFrom('Avail Oct 30, 2026'), '2026-10-30');
  assert.equal(availDateFrom('Avail Nov 2026'), '2026-11-01');
  assert.equal(availDateFrom('Avail 5 Sept 2025'), '2025-09-05');
  assert.equal(availDateFrom('Avail July 1, 2026'), '2026-07-01');
  assert.equal(availDateFrom('RENTED OUT - Av April 2025'), '2025-04-01');
  assert.equal(availDateFrom('RENTED until June 2020'), '2020-06-01');
  assert.equal(availDateFrom('Minim 2 years lease'), null);
  assert.equal(availDateFrom('Minimum 3 years rent'), null);
  assert.equal(availDateFrom(null), null);
});

test('statusFrom: rented is gone unless the agent names a date still to come', () => {
  const now = NOW;
  // Plain rented — the card's own "Availability : Rented", or RENTED in the code line.
  assert.deepEqual(statusFrom({ availability: 'Rented' }, now), { gone: true, rented: true, available_from: null });
  assert.equal(statusFrom({ availability: 'Now', suffix: 'RENTED until June 2020' }, now).gone, true);
  assert.equal(statusFrom({ availability: 'Now', banner: 'Rented Out' }, now).gone, true);
  // A past "Avail" date is stale bookkeeping: still rented.
  assert.equal(statusFrom({ availability: 'Rented', suffix: 'RENTED OUT - Avail July 2026' }, now).gone, true);
  // Rented until a date within UPCOMING_MONTHS (this month included): it frees up then.
  assert.equal(UPCOMING_MONTHS, 3);
  assert.deepEqual(statusFrom({ availability: 'Rented', suffix: 'Avail Oct 30, 2026' }, now), {
    gone: false, rented: true, available_from: '2026-10-30',
  });
  assert.equal(statusFrom({ availability: 'Rented', suffix: 'RENTED OUT - Avail Sept 2026' }, now).available_from, '2026-09-01');
  assert.equal(statusFrom({ availability: 'Rented', suffix: 'RENTED OUT - Avail Dec 2026' }, now).gone, false);
  // …but a multi-year lease is gone: "Avail Jan 2027" is four months out, 2037 is a decade.
  assert.deepEqual(statusFrom({ availability: 'Rented', suffix: 'RENTED OUT - Avail Jan 2027' }, now), {
    gone: true, rented: true, available_from: null,
  });
  assert.equal(statusFrom({ availability: 'Rented', suffix: 'RENTED OUT - Avail Jan 2037' }, now).gone, true);
  assert.equal(statusFrom({ availability: 'Rented', banner: 'SOLD OUT' }, now).gone, true);
  // Not taken, with a date still to come: available from then, however far.
  assert.equal(statusFrom({ availability: 'Now', suffix: 'Avail Nov 2026' }, now).available_from, '2026-11-01');
  assert.equal(statusFrom({ availability: 'Now', suffix: 'Avail Sept 2026' }, now).available_from, '2026-09-01');
  // Available now, with an old date left in the code line: plainly available.
  assert.deepEqual(statusFrom({ availability: 'Now', suffix: 'Avail May 2024' }, now), {
    gone: false, rented: false, available_from: null,
  });
});

// ---------------------------------------------------------------------------
// index cards
// ---------------------------------------------------------------------------

test('cardsFrom reads every card of a yearly page', () => {
  const cards = yearly({ all: true });
  assert.equal(cards.length, 12);
  assert.equal(new Set(cards.map((c) => c.ref)).size, 12);
  for (const c of cards) {
    assert.equal(c.source, 'umadibali');
    assert.match(c.ref, /^[A-Z]{2,4}-\d{3}$/);
    assert.equal(c.area, 'umalas');
    assert.equal(c.location, 'Umalas');
    assert.ok(c.url.startsWith('https://umadibali.com/villa/'), c.url);
    assert.ok(Number.isInteger(c.bedrooms) && c.bedrooms >= 1);
    assert.equal(c.term, 'yearly');
    assert.equal(c.price_month_idr, null, 'a yearly-only card leaves the monthly figure to normalise');
    assert.ok(c.price_year_idr >= 100_000_000, `${c.ref} ${c.price_year_idr}`);
  }

  const wanaka = byRef(cards, 'IP-060');
  assert.equal(wanaka.title, 'Villa Wanaka Umalas');
  assert.equal(wanaka.url, 'https://umadibali.com/villa/bali-long-term-rental-villa-wanaka-umalas-ip-060/');
  assert.equal(wanaka.price_year_idr, 420_000_000); // "Rp. 420.000.000 / year" — dot thousands
  assert.equal(wanaka.bedrooms, 2);
  assert.equal(wanaka.bathrooms, 2);
  assert.equal(wanaka.land_m2, 400);
  assert.equal(wanaka.note, 'Big Garden', 'the card banner travels as the note');
  assert.equal(wanaka.gone, false);
  assert.equal(wanaka.available_from, null);
  assert.ok(wanaka.thumb.startsWith('https://umadibali.com/wp-content/uploads/'));
  assert.ok(!/-\d+x\d+\.jpg$/.test(wanaka.thumb), 'the thumb is the full-size original');
  assert.equal(wanaka.raw.code, 'IP 060');
  assert.equal(wanaka.raw.site_availability, 'Now');

  // A brand-new listing with no photographs yet (and a placeholder slug).
  const arunika = byRef(cards, 'VB-086');
  assert.equal(arunika.url, 'https://umadibali.com/villa/villa/');
  assert.equal(arunika.thumb, null);
});

test('cardsFrom: "Availability : Rented" is gone; rented with a date still to come is not', () => {
  const cards = yearly({ all: true });
  assert.deepEqual(cards.filter((c) => c.gone).map((c) => c.ref).sort(), ['AR-242', 'BVB-359']);

  const sani = byRef(cards, 'IP-874');
  assert.equal(sani.raw.site_availability, 'Rented');
  assert.equal(sani.raw.code_suffix, 'Avail Oct 30, 2026');
  assert.equal(sani.gone, false);
  assert.equal(sani.available_from, '2026-10-30');
  assert.equal(sani.note, 'Avail Oct 30, 2026');

  // The same card read a year on: the date has passed, the flag says Rented — gone.
  const later = cardsFrom(yearlyHtml, {}, { location: 'Umalas', now: new Date('2027-09-26') });
  assert.equal(byRef(later, 'IP-874').gone, true);
});

test('cardsFrom reads monthly and yearly panes, and treats "Rp. 0" as not quoted', () => {
  const cards = monthly({ all: true });
  assert.equal(cards.length, 12);

  const baliana = byRef(cards, 'BVB-422');
  assert.equal(baliana.price_month_idr, 60_000_000);
  assert.equal(baliana.price_year_idr, 600_000_000);
  assert.equal(baliana.term, 'both');

  const melisa = byRef(cards, 'IT-689');
  assert.equal(melisa.price_month_idr, 50_000_000);
  assert.equal(melisa.price_year_idr, null);
  assert.equal(melisa.term, 'monthly');

  const vanuatu = byRef(cards, 'IP-562');
  assert.equal(vanuatu.price_month_idr, null, '"Rp. 0 / month" is no price');
  assert.equal(vanuatu.price_year_idr, 175_000_000);
  assert.equal(vanuatu.term, 'yearly');
  assert.equal(vanuatu.available_from, null, 'an "Avail 5 Sept 2025" that has passed is ignored');
  assert.equal(vanuatu.gone, false);
});

test('the title names the village; the search location fills in when it does not', () => {
  // Titles that name no §7 place, found under a village search: the location decides.
  const placeless = yearlyHtml.replaceAll(' Umalas', ' Dalco');
  const buduk = cardsFrom(placeless, {}, { location: 'Buduk', now: NOW });
  assert.equal(buduk.length, 12);
  assert.ok(buduk.every((c) => c.area === 'pererenan' && c.sub_area === 'Buduk'));
  assert.ok(buduk.every((c) => c.beach_km_hint === 4), 'SPEC §7: the inland north-Pererenan pockets');

  // A title that names a village wins over the search it was found under.
  const underCanggu = cardsFrom(yearlyHtml, {}, { location: 'Canggu', now: NOW });
  assert.ok(underCanggu.every((c) => c.area === 'umalas' && c.sub_area === null));
});

test('cardsFrom drops cards with no §7 area unless asked for all of them', () => {
  const jimbaran = yearlyHtml.replaceAll('Umalas', 'Jimbaran');
  assert.deepEqual(cardsFrom(jimbaran, {}, { location: 'Bukit', now: NOW }), []);
  const all = cardsFrom(jimbaran, {}, { all: true, location: 'Bukit', now: NOW });
  assert.equal(all.length, 12);
  assert.ok(all.every((c) => c.area === null));
});

test('lastPageOf reads "Page 1 of N"', () => {
  assert.equal(lastPageOf(yearlyHtml), 34);
  assert.equal(lastPageOf(monthlyHtml), 2);
  assert.equal(lastPageOf('<html><body>no paginator</body></html>'), null);
});

test('searchUrl asks for one location, 48 a page', () => {
  assert.equal(PER_PAGE, 48);
  assert.equal(
    searchUrl('yearly_rental', 'umalas', 3),
    'https://umadibali.com/search/?type=yearly_rental&loc%5B%5D=umalas&curr=idr&paging=3&ppp=48&sort-by=latest&view=grid'
  );
  // Every walked location maps to a SPEC §7 area — except the broad Bukit, where the title decides.
  for (const [slug, label] of LOCATIONS) {
    const [c] = cardsFrom(yearlyHtml.replaceAll(' Umalas', ' Dalco'), {}, { all: true, location: label, now: NOW });
    if (slug === 'bukit') assert.equal(c.area, null);
    else assert.ok(DEFAULT_CONFIG.areas.includes(c.area), `${slug} → ${c.area}`);
  }
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

test('list() walks yearly then monthly for a location, skipping the rented archive', async () => {
  const ctx = stubCtx();
  const out = [];
  for await (const card of uma.list(ctx, { locations: [['umalas', 'Umalas']] })) out.push(card);

  // 24 cards, minus the two rented ones nobody is tracking.
  assert.equal(out.length, 22);
  assert.equal(new Set(out.map((c) => c.ref)).size, 22);
  assert.ok(!out.some((c) => c.gone));
  assert.ok(out.some((c) => c.ref === 'IP-874'), 'rented until a date to come is passed on');
  assert.deepEqual(ctx.requested, [
    searchUrl('yearly_rental', 'umalas', 1),
    searchUrl('yearly_rental', 'umalas', 2),
    searchUrl('monthly_rental', 'umalas', 1),
    searchUrl('monthly_rental', 'umalas', 2),
  ]);
  assert.match(ctx.infos.join('\n'), /24 cards, 22 passed on, 2 rented \(untracked\) skipped, 0 off-target/);
});

test('list() passes a rented card on when it would retire a row we are tracking', async (t) => {
  const db = tmpDb(t);
  const now = '2026-09-25T06:00:00.000Z';
  const [mentari, sela] = ['AR-242', 'BVB-359'].map((ref) => byRef(yearly({ all: true }), ref));
  upsertProperty(db, normaliseListing({ ...mentari, gone: false }).row, { now });
  upsertProperty(db, { ...normaliseListing(sela).row, availability: 'gone' }, { now });

  const out = [];
  for await (const card of uma.list(stubCtx({ db }), { locations: [['umalas', 'Umalas']] })) out.push(card);
  const gone = out.filter((c) => c.gone).map((c) => c.ref);
  assert.deepEqual(gone, ['AR-242'], 'a live row goes gone; one already gone is not asked about again');
});

// ---------------------------------------------------------------------------
// detail()
// ---------------------------------------------------------------------------

test('detail() reads the icons, prices, facilities and the listing pin', async () => {
  const d = await uma.detail(stubCtx(), DETAIL_URL);
  assert.equal(d.source, 'umadibali');
  assert.equal(d.ref, 'VB-016');
  assert.equal(d.title, 'Villa La Luna Pererenan');
  assert.equal(d.area, 'pererenan');
  assert.equal(d.bedrooms, 2);
  assert.equal(d.bathrooms, 2);
  assert.equal(d.land_m2, 150);
  assert.equal(d.price_year_idr, 130_000_000);
  assert.equal(d.price_month_idr, null);
  assert.equal(d.term, 'yearly');
  assert.equal(d.living_open, 1);
  assert.equal(d.furnished, 1, 'semi furnished counts as furnished');
  assert.equal(d.garden, 1);
  assert.equal(d.pool, 1);
  assert.equal(d.aircon, 1);
  assert.equal(d.kitchen_full, null, '"Kitchen Semi Equipped" is not a full kitchen');
  assert.match(d.description, /Rice field view/);
  assert.match(d.terms, /^Facilities: .*Swimming Pool/);
  assert.equal(d.lat, -8.64227014979525);
  assert.equal(d.lng, 115.13610871586914);
  assert.equal(d.pin_source, 'listing_map');
  assert.deepEqual(d.contacts, [{ role: 'agency', name: 'Uma di Bali Properties', whatsapp: '+6285238086442' }]);
  assert.equal(d.gone, null, 'no rented marker on the page: the card decides');
  assert.equal(d.available_from, null);
});

test('detail() takes the full-size gallery, not the blur-up placeholders or thumbs', async () => {
  const d = await uma.detail(stubCtx(), DETAIL_URL);
  assert.equal(d.images.length, 12);
  assert.equal(new Set(d.images.map((i) => i.src_url)).size, 12);
  assert.ok(d.images.every((i) => /\/wp-content\/uploads\/.*VB-016.*\.jpg$/.test(i.src_url)));
  assert.ok(d.images.every((i) => !/-\d+x\d+\.jpg$/.test(i.src_url)));
});

test('detail() reads "Avail <date>" in the code line, and a rented marker when there is one', () => {
  const d = detailFrom(availHtml, AVAIL_URL, {}, { now: NOW });
  assert.equal(d.ref, 'IP-874');
  assert.equal(d.area, 'umalas');
  assert.equal(d.available_from, '2026-10-30');
  assert.equal(d.gone, null);
  assert.equal(d.living_open, 0);
  assert.equal(d.kitchen_full, 1);
  assert.equal(d.images.length, 13);
  assert.equal(d.lat, -8.656257499999999, 'a different pin from VB 016: per listing, not the office');

  const rented = detailHtml.replace('<h2>VB 016 </h2>', '<h2>VB 016 - RENTED OUT - Avail July 2026</h2>');
  assert.equal(detailFrom(rented, DETAIL_URL, {}, { now: NOW }).gone, true);
  const leased = detailHtml.replace('<h2>VB 016 </h2>', '<h2>VB 016 - RENTED OUT - Avail Aug 2027</h2>');
  assert.equal(detailFrom(leased, DETAIL_URL, {}, { now: NOW }).gone, true);
  const soon = detailHtml.replace('<h2>VB 016 </h2>', '<h2>VB 016 - RENTED OUT - Avail Nov 2026</h2>');
  const s = detailFrom(soon, DETAIL_URL, {}, { now: NOW });
  assert.equal(s.gone, null);
  assert.equal(s.available_from, '2026-11-01');
});

test('detail() returns null for a 404 and for a page that is not a listing', async () => {
  assert.equal(await uma.detail(stubCtx(), 'https://umadibali.com/villa/nope/'), null);
  assert.equal(detailFrom('<html><body>nothing</body></html>', DETAIL_URL), null);
});

test('detail() keeps a week-old page but lets the card own price and availability', async () => {
  const calls = [];
  const ctxWith = (fromCache) => ({
    ...stubCtx(),
    async fetchHtml(url, opts) {
      calls.push(opts);
      return { html: detailHtml, status: 200, fromCache };
    },
  });

  const fresh = await uma.detail(ctxWith(false), DETAIL_URL);
  assert.ok(fresh.price_month_idr || fresh.price_year_idr, 'a fresh page carries its price');
  assert.equal(calls[0].ttlHours, DETAIL_TTL_HOURS);
  assert.equal(calls[0].force, false);

  const cached = await uma.detail(ctxWith(true), DETAIL_URL);
  for (const k of ['price_month_idr', 'price_year_idr', 'term', 'available_from', 'gone']) assert.equal(cached[k], null, k);
  assert.equal(cached.bedrooms, fresh.bedrooms);
  assert.deepEqual(cached.images, fresh.images);
  assert.equal(cached.lat, fresh.lat);

  await uma.detail(ctxWith(false), DETAIL_URL, { force: true });
  assert.equal(calls[2].force, true);
});

// ---------------------------------------------------------------------------
// into the store
// ---------------------------------------------------------------------------

test('a yearly card normalises to an in-band monthly figure, keyed by the normalised code', () => {
  const { row } = normaliseListing(byRef(yearly(), 'IP-874'));
  assert.equal(row.key, 'umadibali:IP-874');
  assert.equal(row.area, 'umalas');
  assert.equal(row.price_year_idr, 320_000_000);
  assert.equal(row.price_month_idr, 26_666_667);
  assert.equal(row.term, 'yearly');
  assert.equal(row.availability, 'from:2026-10-30');
  assert.equal(row.available_from, '2026-10-30');
  assert.equal(inBand(row), true);

  const baliana = normaliseListing(byRef(monthly(), 'BVB-422')).row;
  assert.equal(baliana.price_month_idr, 60_000_000);
  assert.equal(baliana.term, 'both');
});

test("applyDetail keeps the card's Rented verdict and overlays the page's facts", () => {
  const d = detailFrom(detailHtml, DETAIL_URL, {}, { now: NOW });
  const mentari = byRef(yearly({ all: true }), 'AR-242');
  const merged = { ...mentari, ...stripNulls(d) };
  const row = normaliseListing(merged).row;
  const out = applyDetail({ ...row, pool: null, lat: null, lng: null }, d);
  assert.equal(out.availability, 'gone', 'the card is the only place that says "Rented"');
  assert.equal(out.pool, 1);
  assert.equal(out.lat, -8.64227014979525);
  assert.equal(out.pin_source, 'listing_map');
  assert.equal(out.images.length, 12);
  assert.equal(applyDetail(row, null), row);
});

test('applyDetail restores the area a recheck would lose for a title that names no village', () => {
  // src/scrape/recheck.js rebuilds the partial as `location: "<area> - <sub_area>"`.
  const html = detailHtml.replaceAll('Villa La Luna Pererenan', 'Rumah Dalco');
  const d = detailFrom(html, DETAIL_URL, {}, { now: NOW });
  assert.equal(d.area, null);
  const partial = {
    source: 'umadibali', ref: 'VB-016', url: DETAIL_URL, title: 'Rumah Dalco',
    location: 'tanah_lot - Kaba-Kaba', bedrooms: 2, price_month_idr: 10_833_333, price_year_idr: 130_000_000, term: 'yearly',
  };
  const row = normaliseListing({ ...partial, ...stripNulls(d) }).row;
  assert.equal(row.area, 'other', 'what the recheck would have written');
  assert.equal(applyDetail(row, d).area, 'tanah_lot');
});

test('ingestListing stores a card with its detail: pin, gallery and the date it frees up', async (t) => {
  const db = tmpDb(t);
  const card = byRef(yearly(), 'IP-874');
  const res = await ingestListing(db, stubCtx(), uma, card, { now: '2026-09-26T06:00:00.000Z', config: DEFAULT_CONFIG });
  assert.equal(res.action, 'inserted');
  const row = db.prepare('SELECT * FROM properties WHERE key = ?').get('umadibali:IP-874');
  assert.equal(row.area, 'umalas');
  assert.equal(row.availability, 'from:2026-10-30');
  assert.equal(row.price_month_idr, 26_666_667);
  assert.equal(row.pin_source, 'listing_map');
  assert.equal(JSON.parse(row.images).length, 13);
  assert.equal(row.living_open, 0);
});

test('the adapter object has the SPEC §6 shape', () => {
  assert.equal(uma.id, 'umadibali');
  assert.equal(uma.name, 'Uma di Bali Properties');
  assert.equal(uma.base, 'https://umadibali.com');
  for (const fn of ['list', 'detail', 'applyDetail', 'cardsFrom', 'detailFrom', 'lastPageOf']) {
    assert.equal(typeof uma[fn], 'function', fn);
  }
});
