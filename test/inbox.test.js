// SPEC §6 "Adapters to build" item 5 (`inbox`) — processInbox() routes each pending
// `inbox` row to the matching adapter (by hostname) or the generic fallback, and always
// stores the result (never skipped for being out of band — SPEC §2 says that's fine,
// a person chose to add it). Nothing here touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { processInbox, pickAdapter } from '../src/scrape/inbox.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-inbox-'));
  const db = openDb(path.join(dir, 'villa.db'));
  return { db, dir };
}

function cleanup({ db, dir }) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

function addInbox(db, url, note = null) {
  const info = db
    .prepare("INSERT INTO inbox (url, by, note, status, created_at) VALUES (?, 'Philipp', ?, 'pending', datetime('now'))")
    .run(url, note);
  return Number(info.lastInsertRowid);
}

const BHI_URL =
  'https://bali-home-immo.com/realestate-property/for-rent/villa/monthly/pererenan/modern-3br-pererenan-rf1234';
const GENERIC_IN_BAND_URL = 'https://randomvilla.test/spacious-listing';
const GENERIC_OUT_OF_BAND_URL = 'https://randomvilla.test/small-studio';
const GONE_URL = 'https://randomvilla.test/gone';

/** A stub in place of the real bhi adapter — proves routing-by-hostname, not bhi.js itself. */
function stubBhiAdapter() {
  return {
    id: 'bhi',
    name: 'Stub Bali Home Immo',
    base: 'https://bali-home-immo.com',
    async *list() {},
    async detail(ctx, url) {
      if (url !== BHI_URL) return null;
      return {
        source: 'bhi',
        ref: 'RF1234',
        url,
        title: 'Modern 3 Bedroom Villa in Pererenan',
        location: 'Pererenan - Beach Side',
        bedrooms: 3,
        price_month_idr: 40_000_000,
        term: 'monthly',
        description: 'Pool and garden, walk to the beach (400m).',
        images: [{ src_url: 'https://bali-home-immo.com/images/properties/rf1234/1.jpg' }],
      };
    },
  };
}

const GENERIC_IN_BAND_HTML = `<!doctype html><html><head><title>3BR Villa in Pererenan</title></head><body>
  <p>3 kamar tidur, Pererenan. Rp 38 juta / bulan. Pool and garden.</p>
</body></html>`;

// Deliberately below the aggregation band's price floor (SPEC §2: 15M) so scope must
// land on 'market' even though the URL was added on purpose (SPEC §6 "inbox").
const GENERIC_OUT_OF_BAND_HTML = `<!doctype html><html><head><title>Small studio in Pererenan</title></head><body>
  <p>1 kamar tidur. Rp 5 juta / bulan. Pererenan area.</p>
</body></html>`;

function stubCtx(htmlByUrl) {
  return {
    config: {},
    log: console,
    stats: {},
    async fetchHtml(url) {
      return htmlByUrl[url] || { html: null, status: 404 };
    },
  };
}

test('pickAdapter: matches by the URL hostname against each pool adapter\'s base, else generic', () => {
  const pool = [stubBhiAdapter()];
  assert.equal(pickAdapter(BHI_URL, pool).id, 'bhi');
  assert.equal(pickAdapter('https://www.bali-home-immo.com/x', pool).id, 'bhi', 'www. is stripped on both sides');
  assert.equal(pickAdapter(GENERIC_IN_BAND_URL, pool).id, 'generic');
  assert.equal(pickAdapter('not a url', pool).id, 'generic');
});

test('processInbox: routes to the matching adapter, generic fallback, a 404, and a second run does nothing', async () => {
  const t = tmpDb();
  try {
    const bhiId = addInbox(t.db, BHI_URL);
    const genId = addInbox(t.db, GENERIC_OUT_OF_BAND_URL);
    const goneId = addInbox(t.db, GONE_URL);

    const ctx = stubCtx({
      [GENERIC_OUT_OF_BAND_URL]: { html: GENERIC_OUT_OF_BAND_HTML, status: 200 },
      [GONE_URL]: { html: null, status: 404 },
    });

    const result = await processInbox(t.db, ctx, { adapters: [stubBhiAdapter()] });

    assert.equal(result.processed, 3);
    assert.equal(result.done, 2);
    assert.equal(result.failed, 1);

    // --- matched adapter (bhi) --------------------------------------------
    const bhiRow = t.db.prepare('SELECT * FROM properties WHERE key = ?').get('bhi:RF1234');
    assert.ok(bhiRow, 'bhi property inserted under key bhi:RF1234');
    assert.equal(bhiRow.area, 'pererenan');
    assert.equal(bhiRow.bedrooms, 3);

    const bhiInbox = t.db.prepare('SELECT * FROM inbox WHERE id = ?').get(bhiId);
    assert.equal(bhiInbox.status, 'done');
    assert.match(bhiInbox.note, new RegExp(`→ #${bhiRow.id}$`));

    // --- generic fallback, out of band -> stored anyway, scope market -----
    const genRow = t.db.prepare("SELECT * FROM properties WHERE source = 'randomvilla.test'").get();
    assert.ok(genRow, 'generic property stored even though it is out of band');
    assert.equal(genRow.scope, 'market');
    assert.equal(genRow.bedrooms, 1);
    assert.equal(genRow.price_month_idr, 5_000_000);

    const genInbox = t.db.prepare('SELECT * FROM inbox WHERE id = ?').get(genId);
    assert.equal(genInbox.status, 'done');
    assert.match(genInbox.note, new RegExp(`→ #${genRow.id}$`));

    // --- 404 -> failed, nothing stored -------------------------------------
    const goneInbox = t.db.prepare('SELECT * FROM inbox WHERE id = ?').get(goneId);
    assert.equal(goneInbox.status, 'failed');
    assert.ok(goneInbox.note, 'failure note recorded');
    const goneRow = t.db.prepare("SELECT * FROM properties WHERE url = ?").get(GONE_URL);
    assert.equal(goneRow, undefined);

    // --- a second run: nothing left pending ---------------------------------
    const second = await processInbox(t.db, ctx, { adapters: [stubBhiAdapter()] });
    assert.deepEqual(second, { processed: 0, done: 0, failed: 0, skipped: 0, items: [] });
  } finally {
    cleanup(t);
  }
});

test('processInbox: an in-band generic listing lands in scope in_filter', async () => {
  const t = tmpDb();
  try {
    addInbox(t.db, GENERIC_IN_BAND_URL);
    const ctx = stubCtx({ [GENERIC_IN_BAND_URL]: { html: GENERIC_IN_BAND_HTML, status: 200 } });

    const result = await processInbox(t.db, ctx, { adapters: [] });
    assert.equal(result.done, 1);

    const row = t.db.prepare("SELECT * FROM properties WHERE source = 'randomvilla.test'").get();
    assert.ok(row);
    assert.equal(row.scope, 'in_filter');
    assert.equal(row.bedrooms, 3);
    assert.equal(row.price_month_idr, 38_000_000);
  } finally {
    cleanup(t);
  }
});

test('processInbox: an exception from the adapter marks the row failed without throwing', async () => {
  const t = tmpDb();
  try {
    const url = 'https://boom.test/x';
    addInbox(t.db, url);
    const throwingAdapter = {
      id: 'boom',
      name: 'Boom',
      base: 'https://boom.test',
      async *list() {},
      async detail() {
        throw new Error('kaboom');
      },
    };

    const result = await processInbox(t.db, { config: {} }, { adapters: [throwingAdapter] });
    assert.equal(result.failed, 1);
    assert.equal(result.done, 0);

    const row = t.db.prepare('SELECT * FROM inbox WHERE url = ?').get(url);
    assert.equal(row.status, 'failed');
    assert.match(row.note, /kaboom/);
  } finally {
    cleanup(t);
  }
});

test('processInbox: respects `limit` and only touches pending rows', async () => {
  const t = tmpDb();
  try {
    const ctx = stubCtx({});
    addInbox(t.db, 'https://a.test/1');
    addInbox(t.db, 'https://a.test/2');
    t.db
      .prepare("INSERT INTO inbox (url, by, note, status, created_at) VALUES (?, 'Philipp', NULL, 'done', datetime('now'))")
      .run('https://a.test/already-done');

    const result = await processInbox(t.db, ctx, { adapters: [], limit: 1 });
    assert.equal(result.processed, 1, 'limit caps how many pending rows are attempted');

    const stillPending = t.db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE status = 'pending'").get().n;
    assert.equal(stillPending, 1);
  } finally {
    cleanup(t);
  }
});
