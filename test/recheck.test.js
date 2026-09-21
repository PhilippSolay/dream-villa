import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, getConfig } from '../src/db.js';
import { recheckAll, forceCtx } from '../src/scrape/recheck.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-recheck-'));
  const db = openDb(path.join(dir, 'villa.db'));
  return { db, dir };
}

function cleanup({ db, dir }) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

function insert(db, overrides = {}) {
  const row = {
    key: 'bhi:RF1',
    ref: 'RF1',
    source: 'bhi',
    url: 'https://bali-home-immo.com/a-rf1',
    title: 'Modern 2 Bedroom Villa in Cemagi Beachside',
    description: 'A calm villa.',
    area: 'cemagi',
    sub_area: 'Beach Side',
    bedrooms: 2,
    price_month_idr: 40_000_000,
    term: 'monthly',
    availability: 'available',
    status: 'new',
    flagged: 0,
    scope: 'in_filter',
    price_history: JSON.stringify([{ date: '2026-09-01', price_month_idr: 40_000_000 }]),
    first_seen: '2026-09-01T00:00:00.000Z',
    last_seen: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
  const cols = Object.keys(row);
  const info = db
    .prepare(`INSERT INTO properties (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c]));
  return Number(info.lastInsertRowid);
}

/** A ctx that never touches the network but records how it was asked to fetch. */
function stubCtx(config, status = 200) {
  const calls = [];
  return {
    calls,
    config,
    log: console,
    async fetchHtml(url, opts = {}) {
      calls.push({ url, opts });
      return { html: status === 200 ? '<html></html>' : null, status, fromCache: false };
    },
  };
}

/** `pages` maps a url to the detail payload (or null for "gone"). */
function stubAdapter(pages) {
  const seen = [];
  return {
    id: 'bhi',
    name: 'stub',
    seen,
    async *list() {},
    async detail(ctx, url) {
      // Real adapters fetch through ctx; this one does too so the force flag is observable.
      await ctx.fetchHtml(url, { ttlHours: 24 });
      seen.push(url);
      return pages[url] ?? null;
    },
  };
}

test('recheckAll — a price change is reported and appended to price_history', async () => {
  const t = tmpDb();
  try {
    const id = insert(t.db, { status: 'shortlist' });
    const url = 'https://bali-home-immo.com/a-rf1';
    const adapter = stubAdapter({
      [url]: {
        source: 'bhi',
        ref: 'RF1',
        url,
        title: 'Modern 2 Bedroom Villa in Cemagi Beachside',
        description: 'A calm villa.',
        location: 'Cemagi / Seseh - Beach Side',
        bedrooms: 2,
        price_month_idr: 38_000_000,
        term: 'monthly',
      },
    });
    const ctx = stubCtx(getConfig(t.db));

    const res = await recheckAll(t.db, ctx, { bhi: adapter }, { now: '2026-09-17T00:00:00.000Z' });

    assert.equal(res.checked, 1);
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.gone, []);
    assert.deepEqual(res.price_changes, [{ id, ref: 'RF1', from: 40_000_000, to: 38_000_000 }]);

    const row = t.db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
    assert.equal(row.price_month_idr, 38_000_000);
    assert.deepEqual(JSON.parse(row.price_history), [
      { date: '2026-09-01', price_month_idr: 40_000_000 },
      { date: '2026-09-17', price_month_idr: 38_000_000 },
    ]);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM properties').get().n, 1, 'no second row');

    // SPEC §6: the recheck wants today's page, not yesterday's cache.
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0].opts.force, true);
  } finally {
    cleanup(t);
  }
});

test('recheckAll — a 404 marks the row gone', async () => {
  const t = tmpDb();
  try {
    const id = insert(t.db, { status: 'viewing_booked' });
    const adapter = stubAdapter({}); // every url → null
    const ctx = stubCtx(getConfig(t.db), 404);
    const res = await recheckAll(t.db, ctx, { bhi: adapter }, { now: '2026-09-17T00:00:00.000Z' });

    assert.equal(res.checked, 1);
    assert.deepEqual(res.gone, [id]);
    const row = t.db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
    assert.equal(row.availability, 'gone');
    assert.equal(row.removed_at, '2026-09-17T00:00:00.000Z');
    assert.equal(row.removed_reason, 'delisted');
    // `last_seen` still means the last time the source showed us the listing — the
    // archive needs it to say how long the villa was live (SPEC §16).
    assert.equal(row.last_seen, '2026-09-01T00:00:00.000Z');
  } finally {
    cleanup(t);
  }
});

test("recheckAll — an adapter's own gone:true marks the row gone", async () => {
  const t = tmpDb();
  try {
    const url = 'https://bali-home-immo.com/a-rf1';
    const id = insert(t.db, { flagged: 1 });
    const adapter = stubAdapter({ [url]: { ref: 'RF1', url, gone: true } });
    const res = await recheckAll(t.db, stubCtx(getConfig(t.db)), { bhi: adapter }, {});
    assert.deepEqual(res.gone, [id]);
    assert.equal(t.db.prepare('SELECT availability FROM properties WHERE id = ?').get(id).availability, 'gone');
  } finally {
    cleanup(t);
  }
});

test('recheckAll — a plain new, unflagged row is never rechecked', async () => {
  const t = tmpDb();
  try {
    insert(t.db, { key: 'bhi:RF1', ref: 'RF1', status: 'new', flagged: 0 });
    insert(t.db, { key: 'bhi:RF2', ref: 'RF2', url: 'https://x/2', status: 'rejected', flagged: 0 });
    insert(t.db, { key: 'bhi:RF3', ref: 'RF3', url: 'https://x/3', status: 'offer', availability: 'gone' });

    const adapter = stubAdapter({});
    const res = await recheckAll(t.db, stubCtx(getConfig(t.db)), { bhi: adapter }, {});

    assert.equal(res.checked, 0);
    assert.deepEqual(adapter.seen, [], 'no listing was fetched');
  } finally {
    cleanup(t);
  }
});

test('recheckAll — a source with no adapter is skipped, not an error', async () => {
  const t = tmpDb();
  try {
    insert(t.db, { source: 'kibarer', key: 'kibarer:K1', ref: 'K1', flagged: 1 });
    const res = await recheckAll(t.db, stubCtx(getConfig(t.db)), {}, {});
    assert.equal(res.checked, 0);
    assert.equal(res.errors.length, 0);
    assert.equal(res.skipped_no_adapter, 1);
  } finally {
    cleanup(t);
  }
});

test('forceCtx — passes force through and leaves other options alone', async () => {
  const ctx = stubCtx({});
  await forceCtx(ctx).fetchHtml('https://x/1', { ttlHours: 24 });
  assert.deepEqual(ctx.calls[0].opts, { ttlHours: 24, force: true });
});

test('recheckAll — a page served 200 that the adapter cannot parse is an error, not gone', async () => {
  const t = tmpDb();
  try {
    // The nightmare case: a site changes its markup, every detail() returns null, and a
    // naive recheck marks the whole shortlist gone. It must report instead.
    const id = insert(t.db, { status: 'shortlist' });
    const res = await recheckAll(t.db, stubCtx(getConfig(t.db), 200), { bhi: stubAdapter({}) }, {});

    assert.equal(res.checked, 1);
    assert.deepEqual(res.gone, []);
    assert.equal(res.errors.length, 1);
    assert.match(res.errors[0], /no listing data in a 200 response/);
    assert.equal(t.db.prepare('SELECT availability FROM properties WHERE id = ?').get(id).availability, 'available');
  } finally {
    cleanup(t);
  }
});
