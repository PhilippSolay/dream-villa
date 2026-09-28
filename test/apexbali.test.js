// Apex Property adapter. Fixtures fetched 2026-09-28, logged out with a browser UA;
// trimmed of <style>/<link>/<svg>/<meta>, external scripts, comments and most classes.
// The SvelteKit hydration <script> and the JSON-LD are kept whole. No network.
//   apexbali-index.html       /rentals, page 1 of 11 (12 cards)
//   apexbali-index-last.html  /rentals?page=11 (8 cards, the rented tail)
//   apexbali-detail.html      CM001, rented until 2026-12-14

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import apex, {
  literalToJson,
  payloadValue,
  pagingOf,
  cleanTitle,
  areaFor,
  pricesOf,
  statusOf,
  amenityFlags,
  cardsFrom,
  detailFrom,
  applyDetail,
  indexUrl,
} from '../src/scrape/adapters/apexbali.js';
import { normaliseListing } from '../src/scrape/normalise.js';
import { inBand } from '../src/scrape/score.js';
import { DEFAULT_CONFIG } from '../src/defaults.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (f) => fs.readFileSync(path.join(ROOT, 'test/fixtures', f), 'utf8');
const indexHtml = fixture('apexbali-index.html');
const lastHtml = fixture('apexbali-index-last.html');
const detailHtml = fixture('apexbali-detail.html');

const NOW = new Date('2026-09-28T00:00:00Z');
const DETAIL_URL = 'https://apexbali.com/villa/2br-architectural-tropical-pool-villa-in-quiet-seseh-cm001';

test('literalToJson reads devalue output: bare keys, void 0, escaped strings', () => {
  const lit = '{id:"CM001",n:2,x:void 0,ok:true,s:"a \\"b\\" c: d",arr:[1,null],o:{k:"v"}}';
  assert.deepEqual(JSON.parse(literalToJson(lit)), {
    id: 'CM001', n: 2, x: null, ok: true, s: 'a "b" c: d', arr: [1, null], o: { k: 'v' },
  });
});

test('payloadValue and pagingOf read the index hydration script', () => {
  const villas = payloadValue(indexHtml, 'villas');
  assert.equal(villas.length, 12);
  assert.equal(villas[0].id, 'DE001');
  assert.deepEqual(pagingOf(indexHtml), { total: 128, page: 1, totalPages: 11 });
  assert.equal(payloadValue('<html>no script</html>', 'villas'), null);
});

test('cleanTitle drops the trailing ref', () => {
  assert.equal(cleanTitle('2BR Villa in Quiet Seseh - CM001', 'CM001'), '2BR Villa in Quiet Seseh');
  assert.equal(cleanTitle('3 Bedroom Villa in Umalas | EL001', 'EL001'), '3 Bedroom Villa in Umalas');
  assert.equal(cleanTitle('Villa R', 'AP037'), 'Villa R');
});

test('areaFor: the site tag, then the title without neighbour phrases', () => {
  assert.equal(areaFor('Seseh', 'Villa in a Quiet Area of Cemagi'), 'seseh');
  assert.equal(areaFor('Tumbak Bayuh', '2BR Villa'), 'pererenan');
  assert.equal(areaFor('Tabanan', '4BR Villa'), 'tanah_lot');
  assert.equal(areaFor('Beraban', 'Boutique 2BR Villa in Gated Nyanyi'), 'nyanyi');
  // Mengwi is the postcode district: a village in the title wins, else Mengwi stands.
  assert.equal(areaFor('Mengwi', '3BR Le Marva Pool Villa in a Quiet Area of Pererenan'), 'pererenan');
  assert.equal(areaFor('Mengwi', 'Villa Amara'), 'mengwi');
  // Kerobokan / Bengkel are not §7 places; "between Canggu and Umalas" is a neighbour.
  assert.equal(areaFor('Kerobokan', '2BR Private Pool Villa between Canggu and Umalas'), null);
  assert.equal(areaFor('Bengkel', '1BR JOP Residence in Bengkel'), null);
  assert.equal(areaFor(null, '4BR Villa in Umalas, Minutes from Canggu'), 'umalas');
});

test('pricesOf: zero is unquoted, a yearly figure under six months of rent is a slip', () => {
  assert.deepEqual(pricesOf({ priceMonthlyIdr: 56_000_000, priceYearlyIdr: 560_000_000 }), {
    price_month_idr: 56_000_000, price_year_idr: 560_000_000,
  });
  assert.deepEqual(pricesOf({ priceMonthlyIdr: 20_000_000, priceYearlyIdr: 0 }), {
    price_month_idr: 20_000_000, price_year_idr: null,
  });
  assert.deepEqual(pricesOf({ priceMonthlyIdr: 65_000_000, priceYearlyIdr: 65_000_000 }), {
    price_month_idr: 65_000_000, price_year_idr: null,
  });
  assert.deepEqual(pricesOf({ priceMonthlyIdr: null, priceYearlyIdr: 550_000_000 }), {
    price_month_idr: null, price_year_idr: 550_000_000,
  });
});

test('statusOf: rented until soon is live from the next day; far or undated is gone', () => {
  assert.deepEqual(statusOf({ status: 'available', availabilityEndDate: null }, NOW), {
    gone: false, rented: false, available_from: null,
  });
  // The site prints "Available from Oct 2, 2026" for an end date of Oct 1.
  assert.deepEqual(statusOf({ status: 'rented', availabilityEndDate: '2026-10-01' }, NOW), {
    gone: false, rented: true, available_from: '2026-10-02',
  });
  assert.deepEqual(statusOf({ status: 'rented', availabilityEndDate: '2026-12-14' }, NOW), {
    gone: false, rented: true, available_from: '2026-12-15',
  });
  assert.equal(statusOf({ status: 'rented', availabilityEndDate: '2027-08-13' }, NOW).gone, true);
  assert.equal(statusOf({ status: 'rented', availabilityEndDate: '2044-02-10' }, NOW).gone, true);
  // "All 2 units taken", no date.
  assert.equal(statusOf({ status: 'rented', availabilityEndDate: null }, NOW).gone, true);
  // Frees up today: live, available now.
  assert.deepEqual(statusOf({ status: 'rented', availabilityEndDate: '2026-09-27' }, NOW), {
    gone: false, rented: true, available_from: null,
  });
});

test('amenityFlags states only what the chips say', () => {
  assert.deepEqual(amenityFlags(['WiFi', 'Pool', 'Kitchen', 'Air Conditioning', 'Garden', 'Workspace']), {
    pool: 1, garden: 1, aircon: 1, kitchen_full: 1, workspace: 1,
  });
  assert.deepEqual(amenityFlags([]), { pool: null, garden: null, aircon: null, kitchen_full: null, workspace: null });
});

test('cardsFrom: page 1 — IDR prices, §7 areas, off-target villas dropped', () => {
  const all = cardsFrom(indexHtml, { all: true, now: NOW });
  const inArea = cardsFrom(indexHtml, { now: NOW });
  assert.equal(all.length, 12);
  // AP003 (Bengkel) and AL002 (Kerobokan, "between Canggu and Umalas") are off-target.
  assert.deepEqual(all.filter((c) => !c.area).map((c) => c.ref).sort(), ['AL002', 'AP003']);
  assert.equal(inArea.length, 10);
  for (const c of inArea) {
    assert.equal(c.source, 'apexbali');
    assert.ok(DEFAULT_CONFIG.areas.includes(c.area), `${c.ref} is in a §7 area`);
    assert.ok(c.url.startsWith('https://apexbali.com/villa/'));
    assert.ok(Number.isInteger(c.bedrooms));
    assert.equal(c.gone, false);
  }

  const kp = all.find((c) => c.ref === 'KP001');
  assert.equal(kp.title, 'Boutique 2BR Villa in Gated Nyanyi');
  assert.equal(kp.area, 'nyanyi');
  assert.equal(kp.sub_area, 'Beraban');
  assert.equal(kp.price_month_idr, 55_000_000);
  assert.equal(kp.price_year_idr, 550_000_000);
  assert.equal(kp.term, 'both');
  assert.equal(kp.lat, -8.6178453);

  const de = all.find((c) => c.ref === 'DE001');
  assert.equal(de.pool, 1);
  assert.equal(de.price_month_idr, 270_000_000); // out of band, but read right
});

test('cardsFrom: the rented tail — soon is live with a date, far is gone', () => {
  const cards = cardsFrom(lastHtml, { all: true, now: NOW });
  assert.equal(cards.length, 8);
  const by = Object.fromEntries(cards.map((c) => [c.ref, c]));
  assert.equal(by.WS001.gone, false);
  assert.equal(by.WS001.available_from, '2026-10-05');
  assert.equal(by.IR001.area, 'munggu');
  assert.equal(by.IR001.available_from, '2026-10-16');
  assert.equal(by.MY002.gone, true); // until Aug 2027
  assert.equal(by.LI005.gone, true); // all units taken, no date
  assert.equal(by.AP041.area, 'tanah_lot');
  assert.equal(by.AP041.price_month_idr, null);
  assert.equal(by.AP041.term, 'yearly');
});

test('cardsFrom returns null on a page without the payload', () => {
  assert.equal(cardsFrom('<html><body>maintenance</body></html>'), null);
});

test('detailFrom: CM001 from the hydration payload', () => {
  const d = detailFrom(detailHtml, DETAIL_URL, { now: NOW });
  assert.equal(d.ref, 'CM001');
  assert.equal(d.title, '2BR Architectural Tropical Pool Villa in Quiet Seseh');
  assert.equal(d.area, 'seseh');
  assert.equal(d.bedrooms, 2);
  assert.equal(d.bathrooms, 3);
  assert.equal(d.price_month_idr, 56_000_000);
  assert.equal(d.price_year_idr, 560_000_000);
  assert.equal(d.images.length, 20);
  assert.match(d.images[0].src_url, /^https:\/\/apexbali\.com\/villa-photos\/CM001\/0\.webp/);
  assert.equal(d.lat, -8.6269132);
  assert.equal(d.lng, 115.1163098);
  assert.equal(d.pin_source, 'listing_map');
  // "Rented until Dec 14, 2026" / "Available from 15 December 2026": within three months.
  assert.equal(d.available_from, '2026-12-15');
  assert.equal(d.gone, null);
  assert.match(d.description, /^Tucked within the serene surroundings of Seseh/);
  assert.match(d.description, /private viewings and availability\.$/);
  assert.deepEqual(d.contacts, [{ role: 'agency', name: 'Apex Property', whatsapp: '+6282342194697' }]);
  assert.equal(d.raw.from, 'payload');

  // The same villa read in January 2027 is past its rented-until date; in September
  // 2026 with a lease to 2027-06 it would be gone.
  assert.equal(detailFrom(detailHtml, DETAIL_URL, { now: new Date('2027-01-10') }).available_from, null);
});

test('detailFrom falls back to the JSON-LD and the visible text', () => {
  const noPayload = detailHtml.replace(/<script>[\s\S]*?<\/script>/, '');
  const d = detailFrom(noPayload, DETAIL_URL, { now: NOW });
  assert.equal(d.raw.from, 'jsonld');
  assert.equal(d.ref, 'CM001');
  assert.equal(d.area, 'seseh');
  assert.equal(d.bedrooms, 2);
  assert.equal(d.price_month_idr, 56_000_000);
  assert.equal(d.images.length, 8); // JSON-LD holds the first eight
  assert.equal(d.available_from, '2026-12-15');
  assert.equal(detailFrom('<html></html>', DETAIL_URL), null);
});

test('a card goes through normalise and the band like the others', () => {
  const card = cardsFrom(lastHtml, { now: NOW }).find((c) => c.ref === 'WS001');
  const { row } = normaliseListing(card, DEFAULT_CONFIG);
  assert.equal(row.key, 'apexbali:WS001');
  assert.equal(row.area, 'umalas');
  assert.equal(row.price_month_idr, 50_000_000);
  assert.equal(row.availability, 'from:2026-10-05');
  assert.ok(inBand(row, DEFAULT_CONFIG));

  const d = detailFrom(detailHtml, DETAIL_URL, { now: NOW });
  const out = applyDetail({ ...row, raw: JSON.stringify({ gone: true }) }, d);
  assert.equal(out.availability, 'gone', 'a rented card verdict survives the detail');
  assert.equal(applyDetail(row, d).images.length, 20);
});

test('list() walks the pages, stops at totalPages and skips untracked gone villas', async () => {
  const pages = { [indexUrl(1)]: indexHtml, [indexUrl(2)]: lastHtml };
  const asked = [];
  // Pretend page 2 is the last: totalPages in the fixture says 11, so feed the walk a
  // page-1 copy that says 2.
  pages[indexUrl(1)] = indexHtml.replace('totalPages:11', 'totalPages:2');
  const ctx = {
    now: NOW,
    log: { info() {}, warn() {} },
    async fetchHtml(url) {
      asked.push(url);
      return pages[url] ? { html: pages[url], status: 200 } : { html: null, status: 404 };
    },
  };
  const got = [];
  for await (const c of apex.list(ctx)) got.push(c);
  assert.deepEqual(asked, [indexUrl(1), indexUrl(2)]);
  const refs = got.map((c) => c.ref);
  assert.ok(!refs.includes('AL002') && !refs.includes('AP003'), 'off-target dropped');
  assert.ok(!refs.includes('MY002') && !refs.includes('LI005'), 'untracked gone skipped');
  assert.ok(refs.includes('WS001') && refs.includes('KP001'));
  assert.ok(got.every((c) => c.gone === false));
});

test('list() throws when cards render but the payload is gone', async () => {
  const broken = indexHtml.replace(/<script>[\s\S]*?<\/script>/, '');
  const ctx = { now: NOW, log: {}, fetchHtml: async () => ({ html: broken, status: 200 }) };
  await assert.rejects(async () => {
    for await (const _ of apex.list(ctx)) void _;
  }, /hydration payload/);
});
