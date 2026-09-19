// POST /api/import/posts and GET /api/import/status — the Facebook-group bulk
// import (SPEC §6 item 4). One temp DB per test. server.js now registers the
// import routes itself, so buildServer() alone is enough (no manual plugin
// registration needed here).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { openDb } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';

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

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-import-'));
  const env = { ...ENV, IMAGES_DIR: path.join(dir, 'images') };
  const db = openDb(path.join(dir, 'villa.db'));
  seedUsers(db, env);
  const app = await buildServer({ db, env });
  await app.ready();

  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const login = await app.inject({
    method: 'POST', url: '/api/login',
    payload: { email: env.USER1_EMAIL, password: env.USER1_PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw).split(';')[0];

  const call = (opts) => app.inject({ ...opts, headers: { cookie, ...(opts.headers || {}) } });
  return { db, app, env, cookie, call };
}

function post(overrides) {
  return {
    post_id: 'p', url: 'https://facebook.com/groups/x/posts/p',
    posted_at: '2026-09-10T08:00:00.000Z', text: 'placeholder',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('a valid rent post imports with area, bedrooms, price and a linked contact', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-pererenan-villas',
      posts: [
        post({
          post_id: 'p1',
          url: 'https://facebook.com/groups/x/posts/p1',
          text:
            'For rent: lovely 2 bedroom villa in Cemagi with pool and garden. ' +
            'IDR 35.000.000/month. Contact 0812-3456-7890 (WhatsApp).',
          poster_name: 'Wayan',
          poster_url: 'https://facebook.com/wayan.rentals',
          images: ['https://img.test/villa1.jpg'],
          group_name: 'Cemagi Pererenan Villas For Rent',
        }),
      ],
    },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.seen, 1);
  assert.equal(body.new, 1);
  assert.equal(body.updated, 0);
  assert.equal(body.imported, 1);
  assert.deepEqual(body.skipped, { no_signal: 0, offtopic: 0, wanted: 0 });
  assert.equal(body.ids.length, 1);
  assert.equal(typeof body.run_id, 'number');

  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.key, 'fb:p1');
  assert.equal(row.source, 'fb');
  assert.equal(row.ref, 'p1');
  assert.equal(row.area, 'cemagi');
  assert.equal(row.bedrooms, 2);
  assert.equal(row.price_month_idr, 35_000_000);
  assert.equal(row.term, 'monthly');
  assert.equal(row.first_seen, '2026-09-10T08:00:00.000Z');
  assert.equal(row.pool, 1);
  assert.equal(row.garden, 1);
  assert.equal(JSON.parse(row.images)[0].src_url, 'https://img.test/villa1.jpg');

  const contact = db
    .prepare(
      `SELECT c.* FROM contacts c JOIN property_contacts pc ON pc.contact_id = c.id WHERE pc.property_id = ?`
    )
    .get(row.id);
  assert.ok(contact, 'a contact was linked to the property');
  assert.match(contact.whatsapp, /^\+62/);
  assert.equal(contact.role, 'agent');
});

test('a post with no images imports fine and hero_file stays null', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-pererenan-villas',
      posts: [post({ post_id: 'p1b', text: 'Disewakan 2 bedroom villa Cemagi, 40jt/month.' })],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.new, 1);
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.hero_file, null);
  assert.equal(row.images, null);
});

// ---------------------------------------------------------------------------
// Skip classification
// ---------------------------------------------------------------------------

test('a sale-only post is skipped as offtopic', async (t) => {
  const { call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'bukit-listings',
      posts: [
        post({
          post_id: 'p2',
          text: 'Beautiful 3 bedroom villa for sale in Uluwatu, freehold, 5.5 miliar IDR, contact for viewing.',
        }),
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.skipped.offtopic, 1);
  assert.equal(body.imported, 0);
  assert.equal(body.ids.length, 0);
});

test('a "looking for" post is skipped as wanted', async (t) => {
  const { call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-pererenan-villas',
      posts: [post({ post_id: 'p3', text: 'Looking for a 2 bedroom villa to rent in Cemagi, budget 30 juta per month.' })],
    },
  });
  const body = res.json();
  assert.equal(body.skipped.wanted, 1);
  assert.equal(body.imported, 0);
});

test('a rent post with no price at all is skipped as no_signal', async (t) => {
  const { call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-pererenan-villas',
      posts: [post({ post_id: 'p4', text: 'For rent, lovely villa in Seseh, message us for pricing details.' })],
    },
  });
  const body = res.json();
  assert.equal(body.skipped.no_signal, 1);
  assert.equal(body.imported, 0);
});

test('a room/kost post is skipped as offtopic even with a monthly price', async (t) => {
  const { call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-pererenan-villas',
      posts: [post({ post_id: 'p4b', text: 'Kost room only for rent in Cemagi, 3 million/month, share bathroom.' })],
    },
  });
  const body = res.json();
  assert.equal(body.skipped.offtopic, 1);
  assert.equal(body.imported, 0);
});

// ---------------------------------------------------------------------------
// Re-import
// ---------------------------------------------------------------------------

test('re-posting the same post_id updates, not inserts, and stays one row', async (t) => {
  const { db, call } = await setup(t);
  const payload = {
    source: 'fb', group_id: 'cemagi-pererenan-villas',
    posts: [post({ post_id: 'p5', text: 'For rent 2 bedroom villa in Cemagi, IDR 32.000.000/month.' })],
  };

  const first = await call({ method: 'POST', url: '/api/import/posts', payload });
  assert.equal(first.json().new, 1);
  assert.equal(first.json().updated, 0);

  const second = await call({ method: 'POST', url: '/api/import/posts', payload });
  const secondBody = second.json();
  assert.equal(secondBody.new, 0);
  assert.equal(secondBody.updated, 1);
  assert.equal(secondBody.imported, 1);

  const count = db.prepare("SELECT COUNT(*) AS n FROM properties WHERE key = 'fb:p5'").get().n;
  assert.equal(count, 1);
});

// ---------------------------------------------------------------------------
// Indonesian text
// ---------------------------------------------------------------------------

test('Indonesian post: "kamar tidur" bedrooms and a "juta / tahun" yearly price', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'pererenan-group',
      posts: [post({ post_id: 'p6', text: 'Disewakan villa 2 kamar tidur di Pererenan, 450 juta / tahun.' })],
    },
  });
  const body = res.json();
  assert.equal(body.new, 1);
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.area, 'pererenan');
  assert.equal(row.bedrooms, 2);
  assert.equal(row.price_year_idr, 450_000_000);
  assert.equal(row.price_month_idr, 37_500_000);
  assert.equal(row.term, 'yearly');
});

test('a bare amount ("Rp 35jt") with rent words is treated as monthly', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-pererenan-villas',
      posts: [post({ post_id: 'p7', text: 'Disewakan 2 bedroom villa Cemagi, Rp 35jt, minimum contract 1 year.' })],
    },
  });
  const body = res.json();
  assert.equal(body.new, 1);
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.price_month_idr, 35_000_000);
  assert.equal(row.term, 'monthly');
});

test('a bare amount >= 100 M with rent words is treated as yearly', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-pererenan-villas',
      posts: [post({ post_id: 'p7b', text: 'Disewakan 3 bedroom villa Cemagi, Rp 350jt, kontrak minimum 1 tahun.' })],
    },
  });
  const body = res.json();
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.price_year_idr, 350_000_000);
  assert.equal(row.term, 'yearly');
});

// ---------------------------------------------------------------------------
// Validation / auth
// ---------------------------------------------------------------------------

test('a post missing post_id is a 400', async (t) => {
  const { call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'g',
      posts: [{ url: 'https://facebook.com/x', posted_at: '2026-09-10', text: 'For rent villa 30jt/month sewa' }],
    },
  });
  assert.equal(res.statusCode, 400);
});

test('more than 200 posts in one call is a 400', async (t) => {
  const { call } = await setup(t);
  const posts = Array.from({ length: 201 }, (_, i) => post({ post_id: `bulk${i}`, text: 'sewa 30jt/month' }));
  const res = await call({ method: 'POST', url: '/api/import/posts', payload: { source: 'fb', group_id: 'g', posts } });
  assert.equal(res.statusCode, 400);
});

test('an unauthenticated request is a 401', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST', url: '/api/import/posts',
    payload: { source: 'fb', group_id: 'g', posts: [post()] },
  });
  assert.equal(res.statusCode, 401);
});

test('an unauthenticated status request is a 401', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/api/import/status?source=fb' });
  assert.equal(res.statusCode, 401);
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

test('GET /api/import/status returns per-group counts', async (t) => {
  const { call } = await setup(t);
  await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'group-a',
      posts: [post({ post_id: 's1', text: 'Disewakan villa 2BR Seseh, 30jt/bulan.' })],
    },
  });
  await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'group-b',
      posts: [post({ post_id: 's2', text: 'Disewakan villa 2BR Pererenan, 30jt/bulan.' })],
    },
  });

  const res = await call({ method: 'GET', url: '/api/import/status?source=fb' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.total, 2);
  const byId = Object.fromEntries(body.by_group.map((g) => [g.group_id, g]));
  assert.equal(byId['group-a'].n, 1);
  assert.equal(byId['group-b'].n, 1);
  assert.ok(byId['group-a'].min_first_seen);
  assert.ok(byId['group-a'].max_first_seen);
});

// ---------------------------------------------------------------------------
// Area fix: no more group-name fallback; out-of-target places; proximity words
// ("10 minutes to Pererenan" is a distance reference, not the villa's area).
// Regression cover for the 2026-09 "SESEH CEMAGI KEDUNGU VILLA & LAND" import,
// where the old group-name fallback wrongly tagged 72 posts 'seseh'.
// ---------------------------------------------------------------------------

test('area: the group name is never used as a fallback', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'seseh-cemagi-kedungu',
      posts: [
        post({
          post_id: 'area1',
          // No area word anywhere in the post text; the group's own name mentions
          // three of them — this must NOT leak into the row.
          text: 'For rent, lovely villa, pool and garden, IDR 40.000.000/month.',
          group_name: 'SESEH CEMAGI KEDUNGU VILLA & LAND',
        }),
      ],
    },
  });
  const body = res.json();
  assert.equal(body.new, 1);
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.area, 'other');
});

test('area: a distance reference to a target area does not count ("X minutes to Y")', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'canggu-group',
      posts: [
        post({
          post_id: 'area2',
          text: 'Modern 2 bedroom villa for rent in Canggu, only 10 minutes to Pererenan and the beach. IDR 30.000.000/month.',
        }),
      ],
    },
  });
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(res.json().ids[0]);
  assert.equal(row.area, 'other', 'Canggu is out of target and "to Pererenan" is a distance reference, not the area');
});

test('area: an out-of-target place with no target word at all is "other"', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'canggu-group',
      posts: [post({ post_id: 'area3', text: 'Brand new 3 bedroom villa for rent in Umalas, IDR 45.000.000/month.' })],
    },
  });
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(res.json().ids[0]);
  assert.equal(row.area, 'other');
});

test('area: a genuine target-area mention still wins even alongside an out-of-target one', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'pererenan-group',
      posts: [
        post({
          post_id: 'area4',
          text: '3 bedroom villa for rent in Pererenan, 15 min from Canggu. IDR 38.000.000/month.',
        }),
      ],
    },
  });
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(res.json().ids[0]);
  assert.equal(row.area, 'pererenan');
});

test('area: Cepaka maps to tanah_lot', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'tanah-lot-group',
      posts: [post({ post_id: 'area5', text: 'For rent 2 bedroom villa in Cepaka, IDR 28.000.000/month.' })],
    },
  });
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(res.json().ids[0]);
  assert.equal(row.area, 'tanah_lot');
});

// ---------------------------------------------------------------------------
// Title fix: strip repost-header noise and trailing junk.
// ---------------------------------------------------------------------------

test('title: strips leading repost-header lines and trailing junk', async (t) => {
  const { db, call } = await setup(t);
  const text = [
    'Villa Inbali',
    '3d',
    'SESEH CEMAGI PERERENAN VILLA & LAND',
    '· Follow',
    'Gorgeous 2 bedroom villa for rent in Cemagi with private pool. IDR 33.000.000/month.',
    'See less',
  ].join('\n');
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [
        post({
          post_id: 'title1', text,
          poster_name: 'Villa Inbali',
          group_name: 'SESEH CEMAGI PERERENAN VILLA & LAND',
        }),
      ],
    },
  });
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(res.json().ids[0]);
  assert.match(row.title, /Gorgeous 2 Bedroom Villa/);
  assert.notEqual(row.title, 'Villa Inbali');
});

test('title: a trailing lone number and "Comment as …" line are stripped', async (t) => {
  const { db, call } = await setup(t);
  const text = ['2h', 'Lovely 2 bedroom villa for rent, Seseh, IDR 30.000.000/month.', '14', 'Comment as Philipp'].join('\n');
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: { source: 'fb', group_id: 'seseh-group', posts: [post({ post_id: 'title2', text })] },
  });
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(res.json().ids[0]);
  assert.match(row.title, /Lovely 2 Bedroom Villa/);
});

test('title: falls back to the first 90 chars when every line is header/junk or short', async (t) => {
  const { db, call } = await setup(t);
  const text = ['Villa Inbali', '3d', 'ok', 'For rent, IDR 25.000.000/month, dogs allowed, pool, garden, call us today please.'].join('\n');
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'seseh-group',
      posts: [post({ post_id: 'title3', text, poster_name: 'Villa Inbali' })],
    },
  });
  // "ok" (2 chars) and the last line (>=12 chars) both survive header-stripping,
  // but "ok" is under the 12-char title threshold, so the scan moves past it.
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(res.json().ids[0]);
  assert.match(row.title, /For Rent/);
});

// ---------------------------------------------------------------------------
// Offtopic fix: land offers.
// ---------------------------------------------------------------------------

test('offtopic: a land-only post (no villa/house/bedroom word) is skipped', async (t) => {
  const { call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [post({ post_id: 'land1', text: 'For rent: 10 are of land in Cemagi, road access, IDR 50.000.000/year.' })],
    },
  });
  const body = res.json();
  assert.equal(body.skipped.offtopic, 1);
  assert.equal(body.imported, 0);
});

test('offtopic: a villa post priced per-are/year (land pricing) is skipped', async (t) => {
  const { call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [post({ post_id: 'land2', text: 'Villa with land for rent in Cemagi, Rp 15.000.000/are/year, negotiable.' })],
    },
  });
  const body = res.json();
  assert.equal(body.skipped.offtopic, 1);
  assert.equal(body.imported, 0);
});

test('a normal villa post with the word "are" in prose still imports (not land)', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [
        post({
          post_id: 'land3',
          text: 'For rent: 2 bedroom villa in Cemagi. Rooms are big and airy. IDR 32.000.000/month.',
        }),
      ],
    },
  });
  const body = res.json();
  assert.equal(body.skipped.offtopic, 0);
  assert.equal(body.new, 1);
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.area, 'cemagi');
});

// ---------------------------------------------------------------------------
// Re-import safety: a corrected re-import overwrites listing facts.
// ---------------------------------------------------------------------------

test('re-importing the same post_id with corrected text fixes area and title on the existing row', async (t) => {
  const { db, call } = await setup(t);
  const groupId = 'seseh-cemagi-kedungu';

  const firstText = [
    'Villa Inbali',
    '3d',
    'For rent: nice option available for the right family, message for details.',
    'IDR 40.000.000/month.',
  ].join('\n');
  const first = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: groupId,
      posts: [post({ post_id: 'corr1', text: firstText, poster_name: 'Villa Inbali' })],
    },
  });
  assert.equal(first.json().new, 1);
  const firstRow = db.prepare("SELECT * FROM properties WHERE key = 'fb:corr1'").get();
  assert.equal(firstRow.area, 'other');

  const secondText = [
    'Villa Inbali',
    '5d',
    'Gorgeous 2 bedroom villa for rent in Seseh, close to the beach. IDR 42.000.000/month.',
  ].join('\n');
  const second = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: groupId,
      posts: [post({ post_id: 'corr1', text: secondText, poster_name: 'Villa Inbali' })],
    },
  });
  assert.equal(second.json().new, 0);
  assert.equal(second.json().updated, 1);

  const count = db.prepare("SELECT COUNT(*) AS n FROM properties WHERE key = 'fb:corr1'").get().n;
  assert.equal(count, 1, 'still one row, not a duplicate');

  const updatedRow = db.prepare("SELECT * FROM properties WHERE key = 'fb:corr1'").get();
  assert.equal(updatedRow.area, 'seseh');
  assert.match(updatedRow.title, /Gorgeous 2 Bedroom Villa/);
  assert.equal(updatedRow.price_month_idr, 42_000_000);
});

// ---------------------------------------------------------------------------
// Rent-signal fix: a price with a period ("/month", "/year") is itself a rent
// signal, so a post doesn't also need a rent WORD. Sale-only posts still stay
// offtopic because a bare/leasehold price carries no period.
// ---------------------------------------------------------------------------

test('rent-signal: a price with "/month" and no other rent word still imports', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [post({ post_id: 'rs1', text: '3BR villa Cemagi, IDR 40.000.000/month, WA 0812-3456-7890.' })],
    },
  });
  const body = res.json();
  assert.equal(body.skipped.no_signal, 0);
  assert.equal(body.new, 1);
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.price_month_idr, 40_000_000);
  assert.equal(row.term, 'monthly');
});

test('rent-signal: a leasehold-for-sale post with no monthly/yearly price stays offtopic', async (t) => {
  const { call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [post({ post_id: 'rs2', text: 'Villa for sale leasehold 25 years IDR 2.5 B, Cemagi.' })],
    },
  });
  const body = res.json();
  assert.equal(body.skipped.offtopic, 1);
  assert.equal(body.imported, 0);
});

test('rent-signal: "IDR 450.000.000 / year" imports as yearly', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [post({ post_id: 'rs3', text: '3 bedroom villa in Cemagi, IDR 450.000.000 / year.' })],
    },
  });
  const body = res.json();
  assert.equal(body.new, 1);
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.price_year_idr, 450_000_000);
  assert.equal(row.term, 'yearly');
});

// ---------------------------------------------------------------------------
// Cover image — a harvested base64 JPEG/PNG.
// ---------------------------------------------------------------------------

async function tinyImageBase64(format = 'jpeg') {
  const img = sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 180, g: 120, b: 60 } } });
  const buf = format === 'png' ? await img.png().toBuffer() : await img.jpeg().toBuffer();
  return buf.toString('base64');
}

test('image: a valid base64 cover photo is decoded, resized and written to disk', async (t) => {
  const { db, call, env } = await setup(t);
  const data_base64 = await tinyImageBase64('jpeg');
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [
        post({
          post_id: 'img1',
          text: 'For rent 2 bedroom villa in Cemagi, IDR 30.000.000/month.',
          image: { data_base64, w: 12, h: 8 },
        }),
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.new, 1);
  assert.equal(body.skipped_images, 0);

  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.hero_file, `${row.id}/1.jpg`);
  const filePath = path.join(env.IMAGES_DIR, row.hero_file);
  assert.ok(fs.existsSync(filePath), 'the resized file exists on disk under IMAGES_DIR');

  const images = JSON.parse(row.images);
  assert.equal(images[0].file, `${row.id}/1.jpg`);
  assert.equal(images[0].src_url, null);
  assert.ok(images[0].w > 0 && images[0].h > 0);
});

test('image: a valid PNG cover photo also works', async (t) => {
  const { db, call, env } = await setup(t);
  const data_base64 = await tinyImageBase64('png');
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [
        post({
          post_id: 'img1b',
          text: 'For rent 2 bedroom villa in Cemagi, IDR 30.000.000/month.',
          image: { data_base64 },
        }),
      ],
    },
  });
  const body = res.json();
  assert.equal(body.skipped_images, 0);
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.ok(fs.existsSync(path.join(env.IMAGES_DIR, row.hero_file)));
});

test('image: invalid base64 is skipped and counted, the post still imports', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [
        post({
          post_id: 'img2',
          text: 'For rent 2 bedroom villa in Cemagi, IDR 30.000.000/month.',
          image: { data_base64: 'not-a-real-image-payload', w: 12, h: 8 },
        }),
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.new, 1);
  assert.equal(body.skipped_images, 1);
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.hero_file, null);
});

test('image: an oversized image (> 600 KB decoded) is skipped, not attached', async (t) => {
  const { db, call } = await setup(t);
  // 600 KB decoded ≈ 800 KB of base64 text; pad well past that with valid base64 chars.
  const bigBase64 = Buffer.alloc(650 * 1024, 1).toString('base64');
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [
        post({
          post_id: 'img3',
          text: 'For rent 2 bedroom villa in Cemagi, IDR 30.000.000/month.',
          image: { data_base64: bigBase64 },
        }),
      ],
    },
  });
  const body = res.json();
  assert.equal(body.new, 1);
  assert.equal(body.skipped_images, 1);
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.hero_file, null);
});

test('a post with no image field at all still imports fine (existing behaviour)', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [post({ post_id: 'img4', text: 'For rent 2 bedroom villa in Cemagi, IDR 30.000.000/month.' })],
    },
  });
  const body = res.json();
  assert.equal(body.new, 1);
  assert.equal(body.skipped_images, 0);
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.hero_file, null);
});

// ---------------------------------------------------------------------------
// Gallery images — images_b64 (multi-image), alongside the legacy single `image`.
// ---------------------------------------------------------------------------

async function tinyImagesBase64(count, format = 'jpeg') {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push({ data_base64: await tinyImageBase64(format) });
  return out;
}

test('gallery: 3 valid images import as a 3-image gallery with hero = 1.jpg', async (t) => {
  const { db, call, env } = await setup(t);
  const images_b64 = await tinyImagesBase64(3);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [
        post({
          post_id: 'gal1',
          text: 'For rent 3 bedroom villa in Cemagi, IDR 45.000.000/month.',
          images_b64,
        }),
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.new, 1);
  assert.equal(body.skipped_images, 0);

  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.hero_file, `${row.id}/1.jpg`);
  const images = JSON.parse(row.images);
  assert.equal(images.length, 3);
  for (let i = 1; i <= 3; i += 1) {
    assert.equal(images[i - 1].file, `${row.id}/${i}.jpg`);
    assert.equal(images[i - 1].src_url, null);
    assert.ok(fs.existsSync(path.join(env.IMAGES_DIR, images[i - 1].file)));
  }
});

test('gallery: 2 valid + 1 invalid entry writes 2 files and counts 1 skipped', async (t) => {
  const { db, call, env } = await setup(t);
  const valid = await tinyImagesBase64(2);
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [
        post({
          post_id: 'gal2',
          text: 'For rent 2 bedroom villa in Cemagi, IDR 30.000.000/month.',
          images_b64: [valid[0], { data_base64: 'not-a-real-image-payload' }, valid[1]],
        }),
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.new, 1);
  assert.equal(body.skipped_images, 1);

  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  const images = JSON.parse(row.images);
  assert.equal(images.length, 2);
  assert.equal(images[0].file, `${row.id}/1.jpg`);
  assert.equal(images[1].file, `${row.id}/2.jpg`);
  assert.ok(fs.existsSync(path.join(env.IMAGES_DIR, images[0].file)));
  assert.ok(fs.existsSync(path.join(env.IMAGES_DIR, images[1].file)));
});

test('gallery: re-importing the same post with fewer images replaces the gallery, not accumulates it', async (t) => {
  const { db, call } = await setup(t);
  const groupId = 'cemagi-group';

  const first = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: groupId,
      posts: [
        post({
          post_id: 'gal3',
          text: 'For rent 3 bedroom villa in Cemagi, IDR 40.000.000/month.',
          images_b64: await tinyImagesBase64(3),
        }),
      ],
    },
  });
  assert.equal(first.json().new, 1);
  const propertyId = first.json().ids[0];
  assert.equal(JSON.parse(db.prepare('SELECT images FROM properties WHERE id = ?').get(propertyId).images).length, 3);

  const second = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: groupId,
      posts: [
        post({
          post_id: 'gal3',
          text: 'For rent 3 bedroom villa in Cemagi, IDR 41.000.000/month.',
          images_b64: await tinyImagesBase64(2),
        }),
      ],
    },
  });
  assert.equal(second.json().new, 0);
  assert.equal(second.json().updated, 1);

  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  const images = JSON.parse(row.images);
  assert.equal(images.length, 2, 'gallery should be replaced by the new count, not accumulated to 5');
  assert.equal(images[0].file, `${propertyId}/1.jpg`);
  assert.equal(images[1].file, `${propertyId}/2.jpg`);
  assert.equal(row.hero_file, `${propertyId}/1.jpg`, 'hero_file was already set, so it stays put');
});

test('gallery: legacy `image` still works when images_b64 is absent', async (t) => {
  const { db, call, env } = await setup(t);
  const data_base64 = await tinyImageBase64('jpeg');
  const res = await call({
    method: 'POST', url: '/api/import/posts',
    payload: {
      source: 'fb', group_id: 'cemagi-group',
      posts: [
        post({
          post_id: 'gal4',
          text: 'For rent 2 bedroom villa in Cemagi, IDR 30.000.000/month.',
          image: { data_base64 },
        }),
      ],
    },
  });
  const body = res.json();
  assert.equal(body.new, 1);
  assert.equal(body.skipped_images, 0);
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.hero_file, `${row.id}/1.jpg`);
  const images = JSON.parse(row.images);
  assert.equal(images.length, 1);
  assert.ok(fs.existsSync(path.join(env.IMAGES_DIR, images[0].file)));
});

