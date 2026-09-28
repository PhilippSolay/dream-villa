// The Term filter (2026-09-27, Philipp: "filter out monthly, yearly, sale. multiple choice"):
// what "for sale" reads from a listing's text, how term= combines the three chips, and
// that the flag follows the text through writes, rescores and the migration.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { upsertProperty, rescoreAll } from '../src/scrape/store.js';
import { forSale } from '../src/scrape/sale.js';
import { activeFilterCount, defaultFilters, filtersToQuery, termsOf } from '../public/lib/filters.js';

// ---------------------------------------------------------------------------
// forSale — the text rules
// ---------------------------------------------------------------------------

test('forSale: a title that offers the villa for sale', () => {
  for (const title of [
    'Modern 3 Bedroom Villa for Sale and Rent in Umalas Bali',
    'Spacious 3-Bedroom Rice Field View Villa for Rent and Sale in Pererenan',
    'Stunning 3 Bedrooms Villa for Sale & Rent Near Balangan Beach',
    'Peaceful 3 Bedroom Villa for Leasehold Sale in Canggu Bali',
    'Leasehold villa in Seseh',
    'Dijual Villa Baru di Munggu',
  ]) assert.equal(forSale({ title }), 1, title);
});

test('forSale: a description that offers the villa for sale', () => {
  for (const description of [
    'This villa is available for monthly rental and for sale.',
    'Available for Monthly, Yearly Rental, and Leasehold. Experience contemporary living.',
    'OWNER REPRESENTATIVE FOR RENT & LEASEHOLD SALE Available now.',
    'Available for monthly, yearly rent & Freehold sale. Land size 500 m²',
    'Leasehold sale Option • Leasehold with approx. 20 years remaining',
    'Price Freehold — Rp 3,7 M (nego)',
    'Harga: - Dijual: Rp 3,6 M (nego tipis) - Disewakan: - Bulanan: Rp 35 juta',
    'Brand new villa available for rent or sale. 3 Bedroom villa',
    // Facebook sale posts (2026-09-28): the lease they sell, a sale price, a bold headline
    'Price: IDR 4,600,000,000\n* Leasehold: 25 Years',
    '• 40-Year Leasehold — until 2066',
    'Monthly: IDR 145,000,000\nLeasehold until March 2053: IDR 13,500,000,000',
    'Ownership: Leasehold – 30 years',
    'Selling Price : IDR 2,9 Billion',
    'Harga Jual: Rp1,9 Miliar (Nego).',
    '𝗧𝗨𝗠𝗕𝗔𝗞 𝗕𝗔𝗬𝗨𝗛 | 𝟮-𝗕𝗘𝗗𝗥𝗢𝗢𝗠 𝗩𝗜𝗟𝗟𝗔 | 𝗙𝗢𝗥 𝗦𝗔𝗟𝗘 | REF ID: DR0400',
    'Nice villa\n𝗙𝗢𝗥 𝗦𝗔𝗟𝗘 – 𝟭-𝗕𝗘𝗗𝗥𝗢𝗢𝗠 𝗛𝗢𝗠𝗘',
    'Sale Tanah 2 Are View Sawah Dekat Pantai Kedungu',
  ]) assert.equal(forSale({ title: 'Villa in Canggu', description }), 1, description);
  for (const title of ['Taman Griya, Jimbaran – 2 Villas for IDR 1.575B', 'Villa in Nunggalan – Rp2,869,952,000']) {
    assert.equal(forSale({ title }), 1, title);
  }
});

test('forSale: a rental that only mentions sales in passing stays a rental', () => {
  for (const description of [
    // agency signature on every balirealty page
    'Price : IDR 260,000,000 / Year For more Bali villas for sale please browse this website.',
    // the land certificate, not an offer
    'Certificate : SHM (Freehold) Building Permit (IMB/PBG) : On progress',
    'Legalitas: SHM / Freehold LOKASI STRATEGIS UNGASAN',
    // "suitable for resale" in an Indonesian rental ad
    'Cocok Untuk Investasi. - Cocok Untuk Dijual Kembali. - Properti Bisa Nego.',
    'Yearly rental only, minimum 12 months.',
    // rentals head their yearly rent "Lease Price" or "Asking Price"
    'Detail: Asphalt Access Lease Price: IDR290.000.000 / year (TANPA service)',
    'ASKING PRICE\n• IDR 45,000,000 / month\n• IDR 410,000,000 / year',
    'Minimum 2-year lease Price IDR 300 million/year',
    // a rental's minimum term, not a lease on sale
    'Leasehold  2  tahun paling minim',
  ]) assert.equal(forSale({ title: 'Villa for Rent in Ungasan', description }), 0, description);
  assert.equal(forSale({}), 0);
  assert.equal(forSale(null), 0);
});

// ---------------------------------------------------------------------------
// the client's filter state
// ---------------------------------------------------------------------------

test('filters: all three chips on by default and no term= sent', () => {
  const f = defaultFilters();
  assert.deepEqual(termsOf(f), ['monthly', 'yearly', 'sale']);
  assert.equal(new URLSearchParams(filtersToQuery(f)).get('term'), null);
  assert.equal(activeFilterCount(f), 0);
});

test('filters: a chip turned off sends the ones left on and counts as a filter', () => {
  const noSale = { ...defaultFilters(), term: ['monthly', 'yearly'] };
  assert.equal(new URLSearchParams(filtersToQuery(noSale)).get('term'), 'monthly,yearly');
  assert.equal(activeFilterCount(noSale), 1);
  const yearlyOnly = { ...defaultFilters(), term: ['yearly'] };
  assert.equal(new URLSearchParams(filtersToQuery(yearlyOnly)).get('term'), 'yearly');
});

test('filters: a Term saved before the chips (a string) still means what it meant', () => {
  assert.deepEqual(termsOf({ term: 'any' }), ['monthly', 'yearly', 'sale']);
  assert.deepEqual(termsOf({}), ['monthly', 'yearly', 'sale']);
  assert.deepEqual(termsOf({ term: 'yearly' }), ['yearly', 'sale']);
  assert.equal(new URLSearchParams(filtersToQuery({ ...defaultFilters(), term: 'monthly' })).get('term'), 'monthly,sale');
});

// ---------------------------------------------------------------------------
// GET /api/properties?term=
// ---------------------------------------------------------------------------

const ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
  AGENT_TOKEN: 'test-agent-token-0123456789abcdef',
  USER1_EMAIL: 'philipp@example.com',
  USER1_NAME: 'Philipp',
  USER1_PASSWORD: 'correct horse battery staple',
  USER2_EMAIL: 'abigail@example.com',
  USER2_NAME: 'Abigail',
  USER2_PASSWORD: 'another long passphrase',
};

const row = (k, term, title = `Villa ${k}`) => ({
  key: `bhi:${k}`, ref: `RF${k}`, source: 'bhi', url: `https://bhi.test/${k}`, title,
  area: 'cemagi', beach_km: 1, bedrooms: 2, price_month_idr: 40_000_000, term,
  status: 'new', availability: 'available',
});
const SEED = [
  row('M', 'monthly'),
  row('Y', 'yearly'),
  row('B', 'both'),
  row('SM', 'monthly', 'Villa SM for Sale and Rent in Cemagi'),
  row('SY', 'yearly', 'Villa SY for Leasehold Sale in Cemagi'),
];

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-term-'));
  const env = { ...ENV, IMAGES_DIR: path.join(dir, 'images') };
  const db = openDb(path.join(dir, 'villa.db'));
  seedUsers(db, env);
  for (const r of SEED) upsertProperty(db, { ...r, first_seen: '2026-09-10T00:00:00.000Z' }, { now: '2026-09-10T00:00:00.000Z' });
  rescoreAll(db);
  const app = await buildServer({ db, env });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email: env.USER1_EMAIL, password: env.USER1_PASSWORD } });
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw).split(';')[0];
  const keys = async (term) => {
    const res = await app.inject({ method: 'GET', url: `/api/properties?scope=all${term == null ? '' : `&term=${term}`}`, headers: { cookie } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().map((p) => p.key.split(':')[1]).sort();
  };
  return { db, app, cookie, keys };
}

test('term=: the three chips combine as "show what offers one of these"', async (t) => {
  const { keys } = await setup(t);
  assert.deepEqual(await keys(null), ['B', 'M', 'SM', 'SY', 'Y'], 'no term= is everything');
  assert.deepEqual(await keys('monthly,yearly,sale'), ['B', 'M', 'SM', 'SY', 'Y'], 'all three is everything');
  assert.deepEqual(await keys('any'), ['B', 'M', 'SM', 'SY', 'Y'], 'the old any still works');
  assert.deepEqual(await keys('monthly,yearly'), ['B', 'M', 'Y'], 'sale off hides everything also for sale');
  assert.deepEqual(await keys('yearly'), ['B', 'Y'], 'yearly alone: yearly or both, nothing for sale');
  assert.deepEqual(await keys('monthly'), ['B', 'M'], 'the old single value keeps working');
  assert.deepEqual(await keys('yearly,sale'), ['B', 'SM', 'SY', 'Y'], 'monthly off: a monthly listing for sale still offers a sale');
  assert.deepEqual(await keys('sale'), ['SM', 'SY'], 'sale alone');
});

test('term=: an unknown value is a 400', async (t) => {
  const { app, cookie } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/api/properties?scope=all&term=weekly', headers: { cookie } });
  assert.equal(res.statusCode, 400);
});

test('for_sale follows the text: a list row carries it, a rewritten title moves it', async (t) => {
  const { db, app, cookie } = await setup(t);
  const id = db.prepare("SELECT id FROM properties WHERE key = 'bhi:M'").get().id;
  const card = async () => (await app.inject({ method: 'GET', url: '/api/properties?scope=all', headers: { cookie } }))
    .json().find((p) => p.id === id);
  assert.equal((await card()).for_sale, 0);

  // a scraper update that rewrites the title
  upsertProperty(db, { ...SEED[0], title: 'Villa M for Sale and Rent in Cemagi' });
  assert.equal((await card()).for_sale, 1);

  // text changed by any other path (a merge, a hand fix) is caught by the next rescore
  db.prepare('UPDATE properties SET title = ? WHERE id = ?').run('Villa M, monthly rental', id);
  rescoreAll(db);
  assert.equal((await card()).for_sale, 0);
});

test('migration 012 fills for_sale for the rows already stored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-term-mig-'));
  const file = path.join(dir, 'villa.db');
  try {
    const db = openDb(file);
    upsertProperty(db, row('SX', 'yearly', 'Villa SX for Sale and Rent'));
    // as it would have stood before 012: the column there, nothing filled in
    db.prepare('UPDATE properties SET for_sale = 0').run();
    db.prepare("DELETE FROM migrations WHERE name = '012_for_sale'").run();
    db.close();

    const again = openDb(file);
    assert.deepEqual(again.migrationsApplied, ['012_for_sale']);
    assert.equal(again.prepare("SELECT for_sale FROM properties WHERE key = 'bhi:SX'").get().for_sale, 1);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
