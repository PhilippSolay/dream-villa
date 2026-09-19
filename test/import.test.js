// POST /api/import/posts and GET /api/import/status — the Facebook-group bulk
// import (SPEC §6 item 4). One temp DB per test; the plugin is registered
// manually since server.js does not wire it up (owned by another session).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import importRoutes from '../src/routes/import.js';

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
