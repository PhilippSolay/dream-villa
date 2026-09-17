// Rumah123 adapter (SPEC §6 item 3). Fixtures are trimmed copies of real pages fetched
// 2026-09-18 logged out with a browser UA — see the comment at the top of each file and
// adapters/rumah123.md. Nothing here touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import rumah123, {
  extractCards,
  detailFromHtml,
  resolveArea,
  subAreaOf,
  refFromUrl,
  searchUrl,
  isNoise,
  periodFromText,
  plausiblePin,
  furnishedFrom,
  cleanImageUrl,
  applyDetail,
  TARGET_SLUGS,
} from '../src/scrape/adapters/rumah123.js';
import { normaliseListing, parsePrice } from '../src/scrape/normalise.js';
import { inBand } from '../src/scrape/score.js';
import { DEFAULT_CONFIG } from '../src/defaults.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'test/fixtures/rumah123-index.html'), 'utf8');
const DETAIL_HTML = fs.readFileSync(path.join(ROOT, 'test/fixtures/rumah123-detail.html'), 'utf8');

const DETAIL_URL =
  'https://www.rumah123.com/properti/badung-seseh/3-bedroom-villa-for-yearly-rental-in-seseh-vlr349347/';

/** A ctx that serves fixtures and nothing else. */
function stubCtx(map) {
  const seen = [];
  return {
    config: {},
    log: { warn() {}, info() {} },
    seen,
    async fetchHtml(url) {
      seen.push(url);
      return map[url] || { html: null, status: 404 };
    },
  };
}

// ---------------------------------------------------------------------------
// list() / extractCards
// ---------------------------------------------------------------------------

test('extractCards yields the villa cards of a real search page', () => {
  const { cards, hasNext } = extractCards(INDEX_HTML, {
    slugArea: 'seseh',
    category: 'badung/seseh/villa',
  });

  assert.equal(cards.length, 5, 'five of the eight cards survive the filter');
  assert.equal(hasNext, true, 'rel="next" is the pagination signal');

  const byRef = Object.fromEntries(cards.map((c) => [c.ref, c]));

  const monthly = byRef.vlr339097;
  assert.equal(monthly.source, 'rumah123');
  assert.equal(monthly.url, 'https://www.rumah123.com/properti/badung-seseh/1-br-villa-for-rent-vlr339097/');
  assert.equal(monthly.title, '1 BR Villa For Rent');
  assert.equal(monthly.bedrooms, 1);
  assert.equal(monthly.bathrooms, 2);
  assert.equal(monthly.price_month_idr, 37_000_000);
  assert.equal(monthly.price_year_idr, null);
  assert.equal(monthly.term, 'monthly');
  assert.equal(monthly.source_location, 'Seseh, Badung');
  assert.equal(monthly.area, 'seseh', 'the adapter states the canonical §7 area outright');
  assert.equal(monthly.sub_area, 'Seseh', 'the portal\u2019s own village name');
  assert.equal(monthly.location, undefined, 'no synthetic Bali Home Immo location string');
  assert.match(monthly.note, /1BR Villa in Seseh/);
  assert.equal(monthly.agent_name, 'Ruth Lisnawati');
  assert.match(monthly.thumb, /^https:\/\/picture\.rumah123\.com\//);

  const yearly = byRef.vlr349347;
  assert.equal(yearly.price_year_idr, 400_000_000);
  assert.equal(yearly.price_month_idr, null, 'the yearly→monthly split is normalise.js’ job');
  assert.equal(yearly.term, 'yearly');
  assert.equal(yearly.bedrooms, 3);
});

test('every yielded card carries a price that parses to IDR per month or per year', () => {
  const { cards } = extractCards(INDEX_HTML, { slugArea: 'seseh' });
  for (const c of cards) {
    const p = parsePrice(c.price_text);
    assert.ok(p, `${c.ref}: ${c.price_text} parses`);
    const amount = c.price_month_idr ?? c.price_year_idr;
    assert.equal(amount, p.amount, `${c.ref}: the stored amount is the parsed one`);
    assert.ok(amount >= 1_000_000, `${c.ref}: IDR, not a bare number`);
    assert.ok(
      (c.price_month_idr == null) !== (c.price_year_idr == null),
      `${c.ref}: exactly one of month/year is set`
    );
  }
});

test('a guesthouse, a daily rental and a card without bedrooms are all skipped', () => {
  const { cards } = extractCards(INDEX_HTML, { slugArea: 'seseh' });
  const refs = cards.map((c) => c.ref);

  // Real cards in the fixture, all three in target areas so only the rules can drop them.
  assert.ok(!refs.includes('hor42176427'), 'Ungasan guesthouse is not a long-term home');
  assert.ok(
    !cards.some((c) => /guesthouse/i.test(c.title)),
    'nothing matching the kost/guesthouse/apartment vocabulary survives'
  );
  assert.ok(!cards.some((c) => /hari/i.test(c.price_text)), 'no daily rate survives');
  assert.ok(!refs.includes('vlr327071'), 'a card with no bedroom count on it is dropped');
});

test('isNoise / periodFromText cover the portal vocabulary', () => {
  assert.equal(isNoise({ title: 'Disewakan Kost Putri di Ungasan' }), true);
  assert.equal(isNoise({ title: 'Apartemen 2BR Nusa Dua' }), true);
  assert.equal(isNoise({ title: 'Dijual Tanah di Cemagi' }), true);
  assert.equal(isNoise({ title: 'Villa Baru Cemagi', priceText: 'Rp 2,6 Juta /hari' }), true);
  assert.equal(isNoise({ title: '3 Bedroom Villa For Yearly Rental In Seseh' }), false);

  assert.equal(periodFromText('Rp 165 Juta Total /tahun'), 'year');
  assert.equal(periodFromText('Rp 40 Juta /bulan'), 'month');
  assert.equal(periodFromText('Rp 2,6 Juta /hari'), null);
});

test('refFromUrl reads the listing id off the slug', () => {
  assert.equal(refFromUrl(DETAIL_URL), 'vlr349347');
  assert.equal(refFromUrl('/properti/badung-kerobokan/villa-baru-siap-huni-hor6676262/'), 'hor6676262');
  assert.equal(refFromUrl('https://www.rumah123.com/sewa/badung/seseh/villa/'), null);
});

test('searchUrl builds path-shaped search URLs only (robots.txt bans the facets)', () => {
  assert.equal(searchUrl('badung/seseh', 'villa'), 'https://www.rumah123.com/sewa/badung/seseh/villa/');
  assert.equal(
    searchUrl('tabanan/kediri', 'rumah', 3),
    'https://www.rumah123.com/sewa/tabanan/kediri/rumah/?page=3'
  );
  for (const s of TARGET_SLUGS) {
    assert.ok(!searchUrl(s.path, 'villa').includes('?'), `${s.path} page 1 carries no query string`);
  }
});

test('list() pages one area, follows rel="next" once and stops', async () => {
  const first = searchUrl('badung/seseh', 'villa');
  const ctx = stubCtx({ [first]: { html: INDEX_HTML, status: 200 } });

  const out = [];
  for await (const card of rumah123.list(ctx, {
    slugs: [{ path: 'badung/seseh', area: 'seseh' }],
    types: ['villa'],
    maxPages: 2,
  })) {
    out.push(card);
  }

  assert.equal(out.length, 5);
  assert.deepEqual(ctx.seen, [first, `${first}?page=2`], 'page 2 is fetched, then the run ends');
});

// ---------------------------------------------------------------------------
// Area mapping
// ---------------------------------------------------------------------------

test('resolveArea prefers the location string, then the title, then the slug', () => {
  assert.equal(resolveArea({ location: 'Seseh, Badung', title: 'Villa in Munggu Seseh' }), 'seseh');
  assert.equal(resolveArea({ location: 'Munggu, Badung', title: 'Brand New Villa' }), 'munggu');
  assert.equal(resolveArea({ location: 'Kutuh, Badung', title: 'Villa' }), 'pandawa');
  assert.equal(resolveArea({ location: 'Pecatu, Badung', title: 'Villa' }), 'uluwatu');
  assert.equal(resolveArea({ location: 'Ungasan, Badung', title: 'Melasti view' }), 'ungasan');

  // Kecamatan-level strings: the title picks the village, else the documented default.
  assert.equal(
    resolveArea({ location: 'Mengwi, Badung', title: 'Villa Wooden House dekat Pantai di Seseh' }),
    'seseh'
  );
  assert.equal(resolveArea({ location: 'Mengwi, Badung', title: 'Villa di Tangeb' }), 'mengwi');
  assert.equal(resolveArea({ location: 'Kediri, Tabanan', title: 'Villa baru' }), 'tanah_lot');
  assert.equal(resolveArea({ location: 'Kediri, Tabanan', title: 'Villa dekat Kedungu' }), 'kedungu');
  assert.equal(resolveArea({ location: 'Kerambitan, Tabanan', title: 'Villa' }), 'buwit');

  // Kuta Selatan also holds Jimbaran/Benoa/Nusa Dua — no village hint, no area.
  assert.equal(resolveArea({ location: 'Kuta Selatan, Badung', title: 'Villa 3BR' }), null);
  assert.equal(
    resolveArea({ location: 'Kuta Selatan, Badung', title: 'Villa near Bingin Beach' }),
    'bingin'
  );

  // The search slug is the fallback when neither string names a village.
  assert.equal(resolveArea({ location: 'Badung', title: 'Villa', slugArea: 'balangan' }), 'balangan');
  assert.equal(resolveArea({ location: 'Denpasar', title: 'Rumah' }), null);
});

test('every §7 area the adapter can resolve survives normaliseListing untouched', () => {
  for (const area of DEFAULT_CONFIG.areas) {
    const { row } = normaliseListing(
      { source: 'rumah123', ref: 'x1', title: 'Villa For Rent', area, sub_area: 'Somewhere' },
      DEFAULT_CONFIG
    );
    assert.equal(row.area, area, `${area} is carried through, not re-derived from the text`);
    assert.equal(row.sub_area, 'Somewhere');
  }

  // Munggu, Mengwi and Buwit used to need a title keyword to survive; they no longer do.
  for (const area of ['munggu', 'mengwi', 'buwit']) {
    const { row } = normaliseListing(
      { source: 'rumah123', ref: 'x2', title: 'Villa For Rent', area },
      DEFAULT_CONFIG
    );
    assert.equal(row.area, area);
  }
});

test('subAreaOf takes the portal\u2019s village or kecamatan name', () => {
  assert.equal(subAreaOf('Seseh, Badung'), 'Seseh');
  assert.equal(subAreaOf('Kediri, Tabanan'), 'Kediri');
  assert.equal(subAreaOf(''), null);
  assert.equal(subAreaOf(null), null);
});

test('a card ends up in the right area and inside the aggregation band', () => {
  const { cards } = extractCards(INDEX_HTML, { slugArea: 'seseh' });
  const card = cards.find((c) => c.ref === 'vlr349347');

  const { row } = normaliseListing(card, DEFAULT_CONFIG);
  assert.equal(row.key, 'rumah123:vlr349347');
  assert.equal(row.area, 'seseh', 'the explicit area on the partial is what normalise keeps');
  assert.equal(row.price_year_idr, 400_000_000);
  assert.equal(row.price_month_idr, Math.round(400_000_000 / 12), 'CLAUDE.md: yearly → monthly');
  assert.equal(inBand(row, DEFAULT_CONFIG), true);
});

// ---------------------------------------------------------------------------
// detail()
// ---------------------------------------------------------------------------

test('detailFromHtml reads the facts off a real detail page', () => {
  const d = detailFromHtml(DETAIL_HTML, DETAIL_URL);

  assert.equal(d.ref, 'vlr349347');
  assert.equal(d.title, '3 Bedroom Villa For Yearly Rental In Seseh');
  assert.match(d.description, /Villa 3 kamar tidur/);
  assert.equal(d.area, 'seseh');
  assert.equal(d.sub_area, 'Seseh');
  assert.equal(d.source_location, 'Seseh, Badung');

  assert.equal(d.bedrooms, 3);
  assert.equal(d.land_m2, 150, 'from "Luas Tanah: 150 m²" in the description');
  assert.equal(d.price_year_idr, 400_000_000, 'offers unitCode ANN');
  assert.equal(d.price_month_idr, null);
  assert.equal(d.term, 'yearly');
  assert.equal(d.property_type, 'Villa');

  assert.equal(d.pool, 1, 'facility icon #pool / "Kolam Renang"');
  assert.equal(d.garden, 1, '#garden / "Taman"');
  assert.equal(d.aircon, 1, '#ac');
  assert.equal(d.kitchen_full, 1, '#kitchen-set');

  assert.equal(d.images.length, 13);
  assert.match(d.images[0].src_url, /^https:\/\/picture\.rumah123\.com\//);
  assert.ok(d.images.length <= 20, 'SPEC §6 caps a gallery at 20');

  assert.equal(d.posted_at, '2026-09-17');
  assert.equal(d.gone, undefined);
});

test('the pin is labelled geocode, never listing_map, and only when it is plausible', () => {
  const d = detailFromHtml(DETAIL_HTML, DETAIL_URL);
  assert.equal(d.pin_source, 'geocode', 'agent-placed points are not listing map pins');
  assert.ok(Math.abs(d.lat + 8.617) < 0.01 && Math.abs(d.lng - 115.127) < 0.01);

  assert.equal(plausiblePin('seseh', -8.6172, 115.1273), true);
  assert.equal(plausiblePin('seseh', -8.65, 115.27), false, 'a pin 15 km away is dropped');
  assert.equal(plausiblePin('ungasan', null, null), false);
  assert.equal(plausiblePin('other', -8.6, 115.1), false);
});

test('a listing is only gone when the page says so in visible text', () => {
  // The Next.js payload carries a report-reason table containing "Sudah terjual/tersewa";
  // reading it as a delisting marked every live listing gone (caught in the live check).
  const withScript = DETAIL_HTML.replace(
    '</body>',
    '<script>window.__t={"reasonSoldRented":"Sudah terjual/tersewa"}</script></body>'
  );
  assert.equal(detailFromHtml(withScript, DETAIL_URL).gone, undefined);

  const taken = DETAIL_HTML.replace('</body>', '<p>Properti ini sudah disewa</p></body>');
  assert.equal(detailFromHtml(taken, DETAIL_URL).gone, true);

  const soldOut = DETAIL_HTML.replace('https://schema.org/InStock', 'https://schema.org/SoldOut');
  assert.equal(detailFromHtml(soldOut, DETAIL_URL).gone, true, 'offers.availability is the other signal');
});

test('contacts record the agent and mark the portal number for what it is', () => {
  const d = detailFromHtml(DETAIL_HTML, DETAIL_URL);
  const agent = d.contacts.find((c) => c.role === 'agent');
  assert.equal(agent.name, 'Indo Agents');
  assert.equal(agent.agency, 'Indo Agents Property');
  assert.equal(agent.phone_masked, true, 'Rumah123 masks every agent phone');

  const portal = d.contacts.find((c) => c.role === 'portal');
  assert.equal(portal.name, 'Rumah123', 'the one wa.me link is the portal’s own line');
});

test('furnishedFrom maps the Indonesian furnishing vocabulary', () => {
  assert.equal(furnishedFrom('Full Furnished'), 1);
  assert.equal(furnishedFrom('Semi Furnished'), 1);
  assert.equal(furnishedFrom('Perabotan Lengkap'), 1);
  assert.equal(furnishedFrom('Unfurnished'), 0);
  assert.equal(furnishedFrom('Kosongan'), 0);
  assert.equal(furnishedFrom('tanpa perabot'), 0);
  assert.equal(furnishedFrom(''), null);
});

test('cleanImageUrl unwraps the Next.js image proxy', () => {
  assert.equal(
    cleanImageUrl('/portal-img/_next/image/?url=https%3A%2F%2Fpicture.rumah123.com%2Fa.jpg&w=640&q=75'),
    'https://picture.rumah123.com/a.jpg'
  );
  assert.equal(cleanImageUrl('https://picture.rumah123.com/b.jpg'), 'https://picture.rumah123.com/b.jpg');
  assert.equal(cleanImageUrl(null), null);
});

test('detail() returns gone on a 404 and null on an unparseable 200', async () => {
  const ctx = stubCtx({
    [DETAIL_URL]: { html: DETAIL_HTML, status: 200 },
    'https://www.rumah123.com/properti/badung-seseh/empty-vlr000001/': { html: '<html></html>', status: 200 },
  });

  assert.equal((await rumah123.detail(ctx, DETAIL_URL)).ref, 'vlr349347');
  assert.deepEqual(await rumah123.detail(ctx, 'https://www.rumah123.com/properti/x/gone-vlr000002/'), {
    gone: true,
  });
  assert.equal(
    await rumah123.detail(ctx, 'https://www.rumah123.com/properti/badung-seseh/empty-vlr000001/'),
    null,
    'a 200 we cannot parse is a scraper error, not a delisting (SPEC §6)'
  );
});

// ---------------------------------------------------------------------------
// applyDetail
// ---------------------------------------------------------------------------

test('applyDetail restores the resolved area and asserts the stated facts', () => {
  const d = detailFromHtml(DETAIL_HTML, DETAIL_URL);
  const row = {
    area: 'cemagi', // a card that only had the search slug to go on
    sub_area: null,
    bathrooms: null,
    land_m2: null,
    pool: 0,
    furnished: null,
    min_months: null,
    inclusions: null,
  };

  const out = applyDetail(row, { ...d, bathrooms: 2, furnished: 1, min_months: 12 });
  assert.equal(out.area, 'seseh', 'the portal’s own locality wins over the proxy');
  assert.equal(out.sub_area, 'Seseh');
  assert.equal(out.bathrooms, 2);
  assert.equal(out.land_m2, 150);
  assert.equal(out.pool, 1);
  assert.equal(out.furnished, 1);
  assert.equal(out.min_months, 12);
  assert.equal(out.pin_source, 'geocode');
  assert.equal(JSON.parse(out.inclusions)[0], 'AC');

  assert.deepEqual(applyDetail(row, null), row, 'no detail payload changes nothing');
  assert.equal(applyDetail(row, { gone: true }).availability, 'gone');
});

test('the adapter exposes the SPEC §6 shape', () => {
  assert.equal(rumah123.id, 'rumah123');
  assert.equal(rumah123.name, 'Rumah123');
  assert.equal(rumah123.base, 'https://www.rumah123.com');
  assert.equal(typeof rumah123.list, 'function');
  assert.equal(typeof rumah123.detail, 'function');
  assert.equal(typeof rumah123.applyDetail, 'function');
  assert.ok(TARGET_SLUGS.length >= 15, 'every verified target-area slug is crawled');
});
