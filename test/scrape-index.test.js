import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { runScrape } from '../src/scrape/index.js';
import { getAdapters } from '../src/scrape/adapters/index.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-scrape-'));
  const db = openDb(path.join(dir, 'villa.db'));
  return { db, dir };
}

function cleanup({ db, dir }) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Two in-band cards and one 6-bedroom card the band must drop. */
const PARTIALS = [
  {
    source: 'stub', ref: 'S1', url: 'https://stub.test/one-s1',
    title: 'Modern 2 Bedroom Villa in Cemagi Beachside',
    location: 'Cemagi / Seseh - Beach Side', note: 'Pool and garden, walk to the beach (350m)',
    category: 'monthly/seseh', bedrooms: 2, price_month_idr: 40_000_000, term: 'monthly',
  },
  {
    source: 'stub', ref: 'S2', url: 'https://stub.test/two-s2',
    title: '3 Bedroom Villa for Rent in Pererenan',
    location: 'Pererenan - Beach Side', note: 'Minimum 6 months rent',
    category: 'monthly/pererenan', bedrooms: 3, price_month_idr: 48_000_000, term: 'both',
  },
  {
    source: 'stub', ref: 'S3', url: 'https://stub.test/three-s3',
    title: 'Huge 6 Bedroom Compound in Ungasan',
    location: 'Ungasan - East', note: '',
    category: 'monthly/ungasan', bedrooms: 6, price_month_idr: 120_000_000, term: 'monthly',
  },
];

/** No network: `list` yields from the array, `detail` has nothing to add. */
function stubAdapter({ detailFor = () => null } = {}) {
  return {
    id: 'stub',
    name: 'Stub source',
    base: 'https://stub.test',
    async *list() {
      for (const p of PARTIALS) yield { ...p };
    },
    async detail(ctx, url) {
      return detailFor(url);
    },
  };
}

const RUN = { adapters: [stubAdapter()], images: false, now: '2026-09-17T00:00:00.000Z' };

test('getAdapters — the registry, the filter and an unknown source', () => {
  assert.deepEqual(getAdapters().map((a) => a.id), ['bhi', 'kibarer', 'balirealty', 'balicoconutliving', 'rumah123']);
  assert.deepEqual(getAdapters('bhi').map((a) => a.id), ['bhi']);
  assert.deepEqual(getAdapters(['bhi']).map((a) => a.id), ['bhi']);
  assert.throws(() => getAdapters('nope'), /unknown source\(s\): nope/);
});

test('runScrape — dry mode writes nothing', async () => {
  const t = tmpDb();
  try {
    const summary = await runScrape({ db: t.db, ...RUN, dry: true, log: () => {} });

    assert.equal(summary.dry, true);
    assert.equal(summary.seen, 3);
    assert.equal(summary.run_id, null);
    assert.equal(summary.cards.length, 3);
    assert.deepEqual(summary.errors, []);
    assert.deepEqual(summary.by_slug, { pererenan: 1, seseh: 1, ungasan: 1 });
    assert.deepEqual(Object.keys(summary.by_area).sort(), ['cemagi', 'pererenan', 'ungasan']);

    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM properties').get().n, 0);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0);
  } finally {
    cleanup(t);
  }
});

test('runScrape — a real run inserts the in-band cards and writes a finished runs row', async () => {
  const t = tmpDb();
  try {
    const summary = await runScrape({ db: t.db, ...RUN, log: () => {} });

    assert.equal(summary.seen, 3);
    assert.equal(summary.new, 2);
    assert.equal(summary.updated, 0);
    assert.equal(summary.skipped_out_of_band, 1);
    assert.deepEqual(summary.errors, []);

    const rows = t.db.prepare('SELECT key, area, bedrooms, price_month_idr FROM properties ORDER BY id').all();
    assert.deepEqual(rows.map((r) => r.key), ['stub:S1', 'stub:S2']);
    assert.deepEqual(rows.map((r) => r.area), ['cemagi', 'pererenan']);

    const run = t.db.prepare('SELECT * FROM runs').get();
    assert.equal(run.kind, 'scrape');
    assert.ok(run.finished_at, 'the run is closed');
    assert.equal(run.seen, 3);
    assert.equal(run.new, 2);
    assert.equal(run.updated, 0);
    assert.equal(run.gone, 0);
    assert.deepEqual(JSON.parse(run.sources), ['stub']);
    assert.deepEqual(JSON.parse(run.errors), []);
    assert.ok(JSON.parse(run.notes).some((n) => n.startsWith('stub: seen 3')));
  } finally {
    cleanup(t);
  }
});

test('runScrape — a second identical run updates nothing', async () => {
  const t = tmpDb();
  try {
    await runScrape({ db: t.db, ...RUN, log: () => {} });
    const summary = await runScrape({ db: t.db, ...RUN, now: '2026-09-18T00:00:00.000Z', log: () => {} });

    assert.equal(summary.seen, 3);
    assert.equal(summary.new, 0);
    assert.equal(summary.updated, 0);
    assert.equal(summary.unchanged, 2);
    assert.equal(summary.skipped_out_of_band, 1);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM properties').get().n, 2);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 2);

    // last_seen still moves forward even when nothing about the listing changed.
    const seen = t.db.prepare('SELECT last_seen FROM properties ORDER BY id').all().map((r) => r.last_seen);
    assert.deepEqual(seen, ['2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z']);
  } finally {
    cleanup(t);
  }
});

test('runScrape — a detail page that lowers the price counts as an update', async () => {
  const t = tmpDb();
  try {
    await runScrape({ db: t.db, ...RUN, log: () => {} });

    const cheaper = stubAdapter({
      detailFor: (url) =>
        url.endsWith('one-s1')
          ? { source: 'stub', ref: 'S1', url, price_month_idr: 36_000_000, description: 'Now cheaper.' }
          : null,
    });
    const summary = await runScrape({
      db: t.db, adapters: [cheaper], images: false, now: '2026-09-18T00:00:00.000Z', log: () => {},
    });

    assert.equal(summary.new, 0);
    assert.equal(summary.updated, 1);
    const row = t.db.prepare("SELECT * FROM properties WHERE key = 'stub:S1'").get();
    assert.equal(row.price_month_idr, 36_000_000);
    assert.deepEqual(
      JSON.parse(row.price_history).map((h) => h.price_month_idr),
      [40_000_000, 36_000_000]
    );
  } finally {
    cleanup(t);
  }
});

test('runScrape — one adapter failing does not abort the run', async () => {
  const t = tmpDb();
  try {
    const broken = {
      id: 'broken',
      // eslint-disable-next-line require-yield
      async *list() {
        throw new Error('boom');
      },
      async detail() {
        return null;
      },
    };
    const summary = await runScrape({
      db: t.db, adapters: [broken, stubAdapter()], images: false, now: '2026-09-17T00:00:00.000Z', log: () => {},
    });

    assert.equal(summary.new, 2, 'the healthy adapter still ran');
    assert.equal(summary.errors.length, 1);
    assert.match(summary.errors[0], /^broken: boom/);
    const run = t.db.prepare('SELECT * FROM runs').get();
    assert.equal(JSON.parse(run.errors).length, 1);
  } finally {
    cleanup(t);
  }
});
