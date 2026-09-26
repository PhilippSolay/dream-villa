// Detail-page caching (ingest.js detailPlan): index pages 24 h; a known listing's detail
// page 7 days, refetched today when its card moves; a brand-new ref fetched at once; an
// older cached detail never overwrites the facts today's card states. No network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ingestListing, ingestDetail, detailPlan, detailCtx, servedStale, withoutCardFacts, buildRow, refreshDay,
  DETAIL_TTL_HOURS, FRESH_TTL_HOURS, DEFAULT_CARD_FACTS,
} from '../src/scrape/ingest.js';
import { createCtx, cachePathFor } from '../src/scrape/fetch.js';
import { upsertProperty } from '../src/scrape/store.js';
import { openDb } from '../src/db.js';
import { DEFAULT_CONFIG } from '../src/defaults.js';
import bhi from '../src/scrape/adapters/bhi.js';

const URL_A = 'https://agency.test/villa/a1';
const DAY = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
/** The run's clock: the most recent day that is NOT agency:A1's weekly refresh day. */
const NOW = daysAgo([0, 1].find((k) => !refreshDay('agency:A1', daysAgo(k))));
const REFRESH_NOW = daysAgo([0, 1, 2, 3, 4, 5, 6].find((k) => refreshDay('agency:A1', daysAgo(k))));

function tmpDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-detail-cache-'));
  const db = openDb(path.join(dir, 'villa.db'));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

/** Today's index card. */
const card = (over = {}) => ({
  source: 'agency',
  ref: 'A1',
  url: URL_A,
  title: 'Villa Alpha',
  area: 'pererenan',
  location: 'Pererenan',
  bedrooms: 3,
  price_month_idr: 30_000_000,
  term: 'monthly',
  gone: false,
  ...over,
});

/** What the detail page says (served as JSON in place of HTML). */
const page = (over = {}) => ({
  source: 'agency',
  ref: 'A1',
  url: URL_A,
  title: 'Villa Alpha',
  description: 'Joglo with a rice-field view.',
  bedrooms: 3,
  bathrooms: 3,
  land_m2: 400,
  price_month_idr: 30_000_000,
  term: 'monthly',
  images: [{ src_url: 'https://agency.test/img/1.jpg' }],
  gone: false,
  ...over,
});

/** A minimal adapter: detail() fetches the page with its own 24 h TTL, like most do. */
const adapter = {
  id: 'agency',
  async detail(ctx, url) {
    const res = await ctx.fetchHtml(url, { ttlHours: 24 });
    return res && res.html ? JSON.parse(res.html) : null;
  },
  applyDetail(row, d) {
    const out = { ...row };
    for (const k of ['bathrooms', 'land_m2']) if (d[k] != null) out[k] = d[k];
    if (Array.isArray(d.images) && d.images.length) out.images = d.images;
    if (d.gone) out.availability = 'gone';
    return out;
  },
};

/**
 * A fetchHtml with an in-memory cache that honours ttlHours/force like fetch.js does.
 * `live` is what the site serves today; `cache` is url → {html, fetchedAt}.
 */
function fakeCtx({ live = {}, cache = {} } = {}) {
  const ctx = {
    config: DEFAULT_CONFIG,
    calls: [],
    requests: [],
    live,
    cache,
    async fetchHtml(url, { ttlHours = 24, force = false } = {}) {
      ctx.calls.push({ url, ttlHours, force });
      const hit = ctx.cache[url];
      if (!force && hit && Date.now() - Date.parse(hit.fetchedAt) < ttlHours * 3_600_000) {
        return { html: hit.html, status: 200, fromCache: true, fetchedAt: hit.fetchedAt };
      }
      ctx.requests.push(url);
      const html = ctx.live[url] == null ? null : ctx.live[url];
      const fetchedAt = new Date().toISOString();
      if (html != null) ctx.cache[url] = { html, fetchedAt };
      return { html, status: html == null ? 404 : 200, fromCache: false, fetchedAt };
    },
  };
  return ctx;
}

/** Forget the requests so far and age the cached copy of URL_A. */
function nextMorning(ctx, ageDays) {
  ctx.cache[URL_A].fetchedAt = daysAgo(ageDays);
  ctx.requests.length = 0;
  ctx.calls.length = 0;
}

const ingest = (db, ctx, partial, ad = adapter, now = NOW) =>
  ingestListing(db, ctx, ad, partial, { now, config: DEFAULT_CONFIG });

const stored = (db) => db.prepare("SELECT * FROM properties WHERE key = 'agency:A1'").get();

// ---------------------------------------------------------------------------
// The whole path through ingestListing
// ---------------------------------------------------------------------------

test('a brand-new ref is fetched at once, with the adapter\'s own TTL', async (t) => {
  const db = tmpDb(t);
  const ctx = fakeCtx({ live: { [URL_A]: JSON.stringify(page()) } });

  const res = await ingest(db, ctx, card());
  assert.equal(res.action, 'inserted');
  assert.equal(res.detail_cache, 'new');
  assert.deepEqual(ctx.requests, [URL_A], 'one network request for the detail page');
  assert.equal(ctx.calls[0].ttlHours, 24, 'no override: the adapter decides for a new ref');
  assert.equal(stored(db).land_m2, 400);
});

test('a known listing whose card agrees is served from a 7-day cache: no request', async (t) => {
  const db = tmpDb(t);
  const ctx = fakeCtx({ live: { [URL_A]: JSON.stringify(page()) } });
  await ingest(db, ctx, card());
  // Three mornings later: the old 24 h rule would refetch, the 7-day rule does not.
  nextMorning(ctx, 3);

  const res = await ingest(db, ctx, card());
  assert.equal(res.detail_cache, 'known');
  assert.equal(res.detail_stale, true);
  assert.deepEqual(ctx.requests, [], 'served from cache');
  assert.equal(ctx.calls[0].ttlHours, DETAIL_TTL_HOURS);
  assert.equal(res.action, 'unchanged');
});

test('on its own weekday a known listing refreshes its detail page', async (t) => {
  const db = tmpDb(t);
  const ctx = fakeCtx({ live: { [URL_A]: JSON.stringify(page()) } });
  await ingest(db, ctx, card());
  nextMorning(ctx, 3);

  const res = await ingest(db, ctx, card(), adapter, REFRESH_NOW);
  assert.equal(res.detail_cache, 'weekly');
  assert.equal(ctx.calls[0].ttlHours, FRESH_TTL_HOURS);
  assert.deepEqual(ctx.requests, [URL_A]);
});

test('refreshDay: every key has exactly one weekday, and keys spread over the week', () => {
  const day0 = Date.UTC(2026, 8, 21);
  for (const key of ['bhi:RF1', 'rumah123:vlr349347', 'kibarer:YRV4752']) {
    const hits = [0, 1, 2, 3, 4, 5, 6].filter((k) => refreshDay(key, day0 + k * DAY));
    assert.equal(hits.length, 1, key);
    assert.equal(refreshDay(key, day0 + (hits[0] + 7) * DAY), true, 'same weekday next week');
  }
  const perDay = new Array(7).fill(0);
  for (let i = 0; i < 700; i++) {
    for (let k = 0; k < 7; k++) if (refreshDay(`rumah123:r${i}`, day0 + k * DAY)) perDay[k]++;
  }
  for (const n of perDay) assert.ok(n > 60 && n < 140, `about a seventh a day, got ${perDay}`);
  assert.equal(refreshDay('', day0), false);
  assert.equal(refreshDay('bhi:RF1', 'not a date'), false);
});

test('a known listing\'s detail is refetched once it is older than 7 days', async (t) => {
  const db = tmpDb(t);
  const ctx = fakeCtx({ live: { [URL_A]: JSON.stringify(page()) } });
  await ingest(db, ctx, card());
  nextMorning(ctx, 8);

  const res = await ingest(db, ctx, card());
  assert.equal(res.detail_cache, 'known');
  assert.deepEqual(ctx.requests, [URL_A]);
});

test('price change = refetch: a card price that differs from the stored row busts the cache', async (t) => {
  const db = tmpDb(t);
  const ctx = fakeCtx({ live: { [URL_A]: JSON.stringify(page()) } });
  await ingest(db, ctx, card());
  nextMorning(ctx, 3);
  // The agency drops the price; card and page both say so today.
  ctx.live = { [URL_A]: JSON.stringify(page({ price_month_idr: 27_000_000 })) };

  const res = await ingest(db, ctx, card({ price_month_idr: 27_000_000 }));
  assert.equal(res.detail_cache, 'price');
  assert.equal(ctx.calls[0].ttlHours, FRESH_TTL_HOURS);
  assert.deepEqual(ctx.requests, [URL_A], 'the 3-day-old copy is not good enough');
  assert.equal(res.detail_stale, false);
  const row = stored(db);
  assert.equal(row.price_month_idr, 27_000_000);
  const history = JSON.parse(row.price_history);
  assert.deepEqual(history.map((h) => h.price_month_idr), [30_000_000, 27_000_000]);
});

test('a busted ref reuses a copy fetched earlier in the same run instead of asking twice', async (t) => {
  const db = tmpDb(t);
  const ctx = fakeCtx({ live: { [URL_A]: JSON.stringify(page()) } });
  await ingest(db, ctx, card());
  // Fetched an hour ago (livuma's list() reads the page itself before ingest does).
  ctx.cache[URL_A] = { html: JSON.stringify(page({ price_month_idr: 27_000_000 })), fetchedAt: new Date(Date.now() - 3_600_000).toISOString() };
  ctx.requests.length = 0;

  const res = await ingest(db, ctx, card({ price_month_idr: 27_000_000 }));
  assert.equal(res.detail_cache, 'price');
  assert.deepEqual(ctx.requests, []);
  assert.equal(res.detail_stale, false, 'this run\'s own copy is not an older copy');
  assert.equal(stored(db).price_month_idr, 27_000_000);
});

test('a cached detail never clobbers the fresh card: price, title, bedrooms and status come from today\'s card', async (t) => {
  const db = tmpDb(t);
  // The stored row already carries today's facts (e.g. the recheck saw the new price);
  // the cached detail page is five days old and still says the old ones.
  const row = buildRow(card({ price_month_idr: 32_000_000, title: 'Villa Alpha Renovated' }), DEFAULT_CONFIG, { firstSeen: daysAgo(5) });
  upsertProperty(db, row, { now: daysAgo(1) });
  const oldPage = page({ price_month_idr: 30_000_000, title: 'Villa Alpha', bedrooms: 2, gone: true, land_m2: 450 });
  const ctx = fakeCtx({ cache: { [URL_A]: { html: JSON.stringify(oldPage), fetchedAt: daysAgo(5) } } });

  const res = await ingest(db, ctx, card({ price_month_idr: 32_000_000, title: 'Villa Alpha Renovated' }));
  assert.equal(res.detail_cache, 'known');
  assert.equal(res.detail_stale, true);
  assert.deepEqual(ctx.requests, []);

  const after = stored(db);
  assert.equal(after.price_month_idr, 32_000_000, 'the card price stands');
  assert.equal(after.title, 'Villa Alpha Renovated');
  assert.equal(after.bedrooms, 3);
  assert.notEqual(after.availability, 'gone', 'the card says it is on the market');
  assert.equal(after.land_m2, 450, 'what only the detail page knows still comes from it');
  assert.equal(JSON.parse(after.price_history).length, 1, 'no phantom price change');
});

test('a fresh detail still wins over the card, as before', async (t) => {
  const db = tmpDb(t);
  const ctx = fakeCtx({ live: { [URL_A]: JSON.stringify(page({ bedrooms: 4 })) } });
  await ingest(db, ctx, card({ bedrooms: 3 }));
  assert.equal(stored(db).bedrooms, 4);
});

test('the card saying rented busts the cache, and the listing goes gone today', async (t) => {
  const db = tmpDb(t);
  const ctx = fakeCtx({ live: { [URL_A]: JSON.stringify(page()) } });
  await ingest(db, ctx, card());
  nextMorning(ctx, 3);

  const res = await ingest(db, ctx, card({ gone: true }));
  assert.equal(res.detail_cache, 'status');
  assert.deepEqual(ctx.requests, [URL_A]);
});

test('a card back on the index after the row went unlisted busts the cache', async (t) => {
  const db = tmpDb(t);
  const ctx = fakeCtx({ live: { [URL_A]: JSON.stringify(page()) } });
  await ingest(db, ctx, card());
  db.prepare("UPDATE properties SET availability = 'unlisted' WHERE key = 'agency:A1'").run();
  nextMorning(ctx, 3);

  const res = await ingest(db, ctx, card());
  assert.equal(res.detail_cache, 'status');
  assert.deepEqual(ctx.requests, [URL_A]);
  assert.equal(stored(db).availability, 'available');
});

test('with the real fetch cache: a known listing reads its 3-day-old page off disk', async (t) => {
  const db = tmpDb(t);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-detail-cache-disk-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  upsertProperty(db, buildRow(card(), DEFAULT_CONFIG, { firstSeen: daysAgo(3) }), { now: daysAgo(3) });

  const base = cachePathFor(URL_A, cacheDir);
  fs.writeFileSync(`${base}.html`, JSON.stringify(page()));
  fs.writeFileSync(`${base}.json`, JSON.stringify({ url: URL_A, status: 200, fetched_at: daysAgo(3) }));

  const ctx = createCtx({ db, config: DEFAULT_CONFIG, cacheDir, log: { warn() {} } });
  const res = await ingest(db, ctx, card());
  assert.equal(res.detail_cache, 'known');
  assert.equal(ctx.stats.requests, 0, 'no request left the machine');
  assert.equal(ctx.stats.cached, 1);
});

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

test('detailPlan: new, known, and each bust trigger', () => {
  const cfg = DEFAULT_CONFIG;
  const c = card();
  const cr = buildRow(c, cfg);
  const same = { title: cr.title, bedrooms: 3, price_month_idr: 30_000_000, price_year_idr: null, availability: 'available' };

  assert.deepEqual(detailPlan(c, cr, null), { reason: 'new', ttlHours: null });
  assert.deepEqual(detailPlan(c, cr, same), { reason: 'known', ttlHours: DETAIL_TTL_HOURS });
  assert.equal(detailPlan(c, cr, { ...same, price_month_idr: 29_000_000 }).reason, 'price');
  assert.equal(detailPlan(c, cr, { ...same, bedrooms: 2 }).reason, 'bedrooms');
  assert.equal(detailPlan(c, cr, { ...same, title: 'Something Else' }).reason, 'title');
  assert.equal(detailPlan(c, cr, { ...same, availability: 'gone' }).reason, 'status');
  const gone = card({ gone: true });
  assert.equal(detailPlan(gone, buildRow(gone, cfg), same).reason, 'status');
});

test('detailPlan: a yearly-only card is compared on the yearly price it states, not the derived monthly', () => {
  const c = card({ price_month_idr: null, price_year_idr: 360_000_000, term: 'yearly' });
  const cr = buildRow(c, DEFAULT_CONFIG);
  // The stored monthly came from a detail page that quotes both; the card did not state one.
  const existing = { title: cr.title, bedrooms: 3, price_month_idr: 32_000_000, price_year_idr: 360_000_000, availability: 'available' };
  assert.equal(detailPlan(c, cr, existing).reason, 'known');
  assert.equal(detailPlan(c, cr, { ...existing, price_year_idr: 330_000_000 }).reason, 'price');
});

test('detailPlan: Bali Home Immo\'s slug-built card title is not a card fact', () => {
  assert.ok(!bhi.cardFacts.includes('title'));
  const c = card({ source: 'bhi', title: 'villa alpha pererenan' });
  const cr = buildRow(c, DEFAULT_CONFIG);
  const existing = { title: 'Villa Alpha — Rice Field Joglo', bedrooms: 3, price_month_idr: 30_000_000, price_year_idr: null, availability: 'available' };
  assert.equal(detailPlan(c, cr, existing, bhi.cardFacts).reason, 'known');
  assert.equal(detailPlan(c, cr, existing).reason, 'title', 'the default set would have busted');
});

test('detailCtx overrides the TTL and records what came from cache', async () => {
  const ctx = fakeCtx({ cache: { [URL_A]: { html: '{}', fetchedAt: daysAgo(2) } } });
  const d = detailCtx(ctx, { ttlHours: DETAIL_TTL_HOURS });
  await d.fetchHtml(URL_A, { ttlHours: 24 });
  assert.equal(ctx.calls[0].ttlHours, DETAIL_TTL_HOURS);
  assert.equal(d.fetched[0].fromCache, true);
  assert.equal(servedStale(d.fetched), true);

  const passthrough = detailCtx(ctx, {});
  await passthrough.fetchHtml(URL_A, { ttlHours: 24, force: true });
  assert.deepEqual(ctx.calls[1], { url: URL_A, ttlHours: 24, force: true });
  assert.equal(servedStale(passthrough.fetched), false, 'a network fetch is fresh');
});

test('servedStale: this run\'s own cache hit is fresh, an older one or one of unknown age is not', () => {
  const now = Date.now();
  assert.equal(servedStale([{ fromCache: true, fetchedAt: new Date(now - 3_600_000).toISOString() }], now), false);
  assert.equal(servedStale([{ fromCache: true, fetchedAt: new Date(now - FRESH_TTL_HOURS * 3_600_000).toISOString() }], now), true);
  assert.equal(servedStale([{ fromCache: true, fetchedAt: null }], now), true);
  assert.equal(servedStale([], now), false);
});

test('withoutCardFacts drops only the facts the card itself states', () => {
  const d = page({ price_year_idr: 350_000_000, available_from: '2026-11-01' });
  const out = withoutCardFacts(d, card({ gone: undefined }));
  for (const k of ['price_month_idr', 'bedrooms', 'title']) assert.ok(!(k in out), k);
  assert.equal(out.price_year_idr, 350_000_000, 'the card has no yearly price: the page keeps it');
  assert.equal(out.available_from, '2026-11-01');
  assert.equal(out.gone, false, 'the card has no status: the page keeps it');
  assert.equal(out.land_m2, 400);
  assert.deepEqual(DEFAULT_CARD_FACTS.includes('gone'), true);
});

test('ingestDetail keeps raw as the page said it, stale or not (no phantom update)', (t) => {
  const db = tmpDb(t);
  const d = page({ price_month_idr: 30_000_000 });
  const fresh = ingestDetail(db, { partial: card(), detail: d, adapter, config: DEFAULT_CONFIG, now: NOW });
  const again = ingestDetail(db, { partial: card(), detail: d, adapter, config: DEFAULT_CONFIG, now: NOW, stale: true });
  assert.equal(fresh.action, 'inserted');
  assert.equal(again.action, 'unchanged');
});
