// POST /api/import/listings and GET /api/import/listings/status — the generic
// browser-harvester import (CLAUDE.md adapters/*.md: sites like balivillahub.com
// block the server's own fetches but load fine in Philipp's own browser). One temp
// DB + one temp IMAGES_DIR per test; a tiny local http server stands in for the
// site's own image CDN so `processImages` has something real to download from
// (same trick as test/fetch.test.js), rather than stubbing fetchBuffer directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-import-listings-'));
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
  return { db, app, env, call };
}

/** A tiny local server so image-download tests never touch the network. */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stop(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

async function makePng(width = 400, height = 300) {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
}

function listing(overrides) {
  return {
    ref: 'r1',
    url: 'https://balivillahub.com/listing/r1',
    title: '2 Bedroom Villa in Cemagi',
    bedrooms: 2,
    price_month_idr: 35_000_000,
    area: 'cemagi',
    ...overrides,
  };
}

function importPayload(overrides = {}, listings = [listing()]) {
  return { source: 'balivillahub', listings, ...overrides };
}

// ---------------------------------------------------------------------------
// The happy path + explicit-facts-win overlay
// ---------------------------------------------------------------------------

test('a valid listing imports with explicit facts winning over the description keywords', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/listings',
    payload: importPayload({}, [
      listing({
        description: 'Brand new villa, 3 bedroom galore, great value, unfurnished shell.',
        bathrooms: 2,
        furnished: 1,
      }),
    ]),
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.seen, 1);
  assert.equal(body.new, 1);
  assert.equal(body.updated, 0);
  assert.equal(body.ids.length, 1);
  assert.equal(typeof body.run_id, 'number');

  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.key, 'balivillahub:r1');
  assert.equal(row.source, 'balivillahub');
  assert.equal(row.ref, 'r1');
  // explicit bedrooms (2) wins over the description's "3 bedroom"
  assert.equal(row.bedrooms, 2);
  assert.equal(row.bathrooms, 2);
  // explicit furnished:1 wins over normaliseListing's own keyword read of "unfurnished"
  assert.equal(row.furnished, 1);
  assert.equal(row.area, 'cemagi');
  assert.equal(row.price_month_idr, 35_000_000);
});

test('a stated min_months survives — the text parse only fills a gap', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/listings',
    payload: importPayload({}, [
      listing({ ref: 'stated', description: 'Minimum term is six months.', min_months: 6 }),
      listing({ ref: 'text', url: 'https://example.test/text', description: 'Minimum stay 3 months.' }),
    ]),
  });

  assert.equal(res.statusCode, 200);
  const stated = db.prepare("SELECT min_months FROM properties WHERE ref = 'stated'").get();
  const text = db.prepare("SELECT min_months FROM properties WHERE ref = 'text'").get();
  assert.equal(stated.min_months, 6);
  assert.equal(text.min_months, 3);
});

test('an explicit valid area key is used as-is', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/listings',
    payload: importPayload({}, [listing({ area: 'seseh' })]),
  });
  const body = res.json();
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.area, 'seseh');
});

test('listings outside the aggregation band are skipped, not stored (SPEC §2)', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/listings',
    payload: importPayload({}, [
      listing({ ref: 'ok', area: 'seseh' }),
      listing({ ref: 'seminyak', area: undefined, location: 'Petitenget, Seminyak', title: '2 Bedroom Villa in Seminyak' }),
      listing({ ref: 'pricey', price_month_idr: 150_000_000 }),
      listing({ ref: 'big', bedrooms: 6 }),
    ]),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.seen, 4);
  assert.equal(body.new, 1);
  assert.deepEqual(body.skipped, { out_of_band: 3 });
  assert.equal(body.ids.length, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM properties').get().n, 1);
  assert.equal(db.prepare('SELECT ref FROM properties').get().ref, 'ok');
});

test('missing area with a Bali-Home-Immo-style location string resolves via normalise', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/listings',
    payload: importPayload({}, [
      listing({ ref: 'r2', area: undefined, location: 'Cemagi / Seseh - Beach Side' }),
    ]),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.area, 'cemagi');
});

test('a yearly-only price normalises to a monthly equivalent', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/listings',
    payload: importPayload({}, [
      listing({ ref: 'r3', price_month_idr: undefined, price_year_idr: 480_000_000, term: 'yearly' }),
    ]),
  });
  const body = res.json();
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  assert.equal(row.price_year_idr, 480_000_000);
  assert.equal(row.price_month_idr, 40_000_000);
});

// ---------------------------------------------------------------------------
// Re-import: facts update, person fields (status) are never clobbered
// ---------------------------------------------------------------------------

test('re-importing the same ref updates facts but keeps a person-set status', async (t) => {
  const { db, call } = await setup(t);
  const first = await call({
    method: 'POST', url: '/api/import/listings',
    payload: importPayload({}, [listing({ ref: 'r4', price_month_idr: 30_000_000 })]),
  });
  const id = first.json().ids[0];
  db.prepare("UPDATE properties SET status = 'shortlisted' WHERE id = ?").run(id);

  const second = await call({
    method: 'POST', url: '/api/import/listings',
    payload: importPayload({}, [listing({ ref: 'r4', price_month_idr: 32_000_000 })]),
  });
  assert.equal(second.statusCode, 200);
  const body = second.json();
  assert.equal(body.new, 0);
  assert.equal(body.updated, 1);
  assert.deepEqual(body.ids, [id]);

  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  assert.equal(row.price_month_idr, 32_000_000);
  assert.equal(row.status, 'shortlisted');
});

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

test('a whatsapp number creates and links a contact with role agent', async (t) => {
  const { db, call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/listings',
    payload: importPayload({}, [
      listing({ ref: 'r5', whatsapp: '0812-3456-7890', contact_name: 'Made' }),
    ]),
  });
  const body = res.json();
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(body.ids[0]);
  const contact = db
    .prepare('SELECT c.* FROM contacts c JOIN property_contacts pc ON pc.contact_id = c.id WHERE pc.property_id = ?')
    .get(row.id);
  assert.ok(contact, 'a contact was linked');
  assert.equal(contact.whatsapp, '+6281234567890');
  assert.equal(contact.role, 'agent');
  assert.equal(contact.name, 'Made');
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

test('an image URL is downloaded to <id>/1.jpg and set as hero', async (t) => {
  const { db, call, env } = await setup(t);
  const png = await makePng();
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(png);
  });
  t.after(() => stop(server));
  const { port } = server.address();
  const imageUrl = `http://127.0.0.1:${port}/photo.png`;

  const res = await call({
    method: 'POST', url: '/api/import/listings',
    payload: importPayload({}, [listing({ ref: 'r6', images: [imageUrl] })]),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.images_queued, 1, 'downloads run in the background after the response');
  assert.equal(body.images_failed, 0);

  const id = body.ids[0];
  // the background download finishes shortly after the response
  let row;
  for (let i = 0; i < 40; i++) {
    row = db.prepare('SELECT images, hero_file FROM properties WHERE id = ?').get(id);
    if (row.hero_file) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const images = JSON.parse(row.images);
  assert.equal(images[0].file, `${id}/1.jpg`);
  assert.equal(row.hero_file, `${id}/1.jpg`);
  assert.ok(fs.existsSync(path.join(env.IMAGES_DIR, String(id), '1.jpg')));
});

test('images_b64 saves an embedded gallery image and sets hero', async (t) => {
  const { db, call, env } = await setup(t);
  const png = await makePng(200, 200);
  const res = await call({
    method: 'POST', url: '/api/import/listings',
    payload: importPayload({}, [
      listing({ ref: 'r7', images_b64: [{ data_base64: png.toString('base64'), w: 200, h: 200 }] }),
    ]),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const id = body.ids[0];
  const row = db.prepare('SELECT images, hero_file FROM properties WHERE id = ?').get(id);
  const images = JSON.parse(row.images);
  assert.equal(images[0].file, `${id}/1.jpg`);
  assert.equal(images[0].src_url, null);
  assert.match(images[0].hash, /^[0-9a-f]{16}$/, 'hashed as it is saved');
  assert.equal(row.hero_file, `${id}/1.jpg`);
  assert.ok(fs.existsSync(path.join(env.IMAGES_DIR, String(id), '1.jpg')));
});

// ---------------------------------------------------------------------------
// Validation + auth
// ---------------------------------------------------------------------------

test('a listing missing ref is rejected 400', async (t) => {
  const { call } = await setup(t);
  const res = await call({
    method: 'POST', url: '/api/import/listings',
    payload: importPayload({}, [{ url: 'https://balivillahub.com/x', title: 'No ref here' }]),
  });
  assert.equal(res.statusCode, 400);
});

test('an unauthenticated request is rejected 401', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-import-listings-noauth-'));
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

  const res = await app.inject({ method: 'POST', url: '/api/import/listings', payload: importPayload() });
  assert.equal(res.statusCode, 401);
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

test('GET /api/import/listings/status reports count and first_seen bounds', async (t) => {
  const { call } = await setup(t);
  await call({
    method: 'POST', url: '/api/import/listings',
    payload: importPayload({}, [
      listing({ ref: 'r8', first_seen: '2026-01-01T00:00:00.000Z' }),
      listing({ ref: 'r9', first_seen: '2026-02-01T00:00:00.000Z' }),
    ]),
  });
  const res = await call({ method: 'GET', url: '/api/import/listings/status?source=balivillahub' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.n, 2);
  assert.equal(body.min_first_seen, '2026-01-01T00:00:00.000Z');
  assert.equal(body.max_first_seen, '2026-02-01T00:00:00.000Z');
});
