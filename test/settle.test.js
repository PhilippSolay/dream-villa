// src/scrape/settle.js — the background settle pass behind POST /api/import/listings:
// dedupe on cheap evidence, probe ONE hero image per row, merge what turns out to be a
// villa we already have, and only then download the surviving galleries ("make sure you
// dont get dups before downloading images").
//
// Same harness as test/import-listings.test.js: one temp DB + one temp IMAGES_DIR per
// test and a tiny local http server standing in for the site's image CDN — here it also
// records every path it was asked for, which is what proves a merged-away duplicate
// never cost more than its single hero download.

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-settle-'));
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

async function makePng(background = { r: 10, g: 120, b: 200 }, width = 400, height = 300) {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
}

/** A local image CDN that records every path it serves. `files` is path -> png buffer. */
function startImageServer(files) {
  const seen = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = req.url.split('?')[0];
      seen.push(pathname);
      const buffer = files.get(pathname);
      if (!buffer) {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(buffer);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

function stop(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

/** Wait until `n` settle runs have finished, then return the newest one (notes parsed). */
async function waitForSettle(db, n, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    const done = db
      .prepare("SELECT COUNT(*) AS n FROM runs WHERE kind = 'settle' AND finished_at IS NOT NULL")
      .get().n;
    if (done >= n) {
      const row = db.prepare("SELECT * FROM runs WHERE kind = 'settle' ORDER BY id DESC LIMIT 1").get();
      return { ...row, notes: JSON.parse(row.notes || '[]'), errors: JSON.parse(row.errors || '[]') };
    }
    if (Date.now() - started > timeoutMs) throw new Error(`settle run #${n} never finished`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function importOne(call, listing) {
  return call({
    method: 'POST', url: '/api/import/listings',
    payload: { source: 'balivillahub', listings: [listing] },
  });
}

// ---------------------------------------------------------------------------
// (a) hero probe merges a duplicate before the rest of its gallery is fetched
// (c) the merged-away row's files go with it
// (d) the settle run row carries the counts
// ---------------------------------------------------------------------------

test('a listing sharing its hero photo with a live row is merged after the probe, without fetching the rest of its gallery', async (t) => {
  const { db, call, env } = await setup(t);

  const hero = await makePng({ r: 10, g: 120, b: 200 });
  const files = new Map([
    ['/a/1.png', hero],
    ['/a/2.png', await makePng({ r: 200, g: 40, b: 30 })],
    // the duplicate's hero is the same photograph re-uploaded under another url
    ['/b/1.png', hero],
    ['/b/2.png', await makePng({ r: 30, g: 190, b: 90 })],
    ['/b/3.png', await makePng({ r: 240, g: 230, b: 20 })],
  ]);
  const { server, seen, port } = await startImageServer(files);
  t.after(() => stop(server));
  const url = (p) => `http://127.0.0.1:${port}${p}`;

  // The villa we already have.
  const first = await importOne(call, {
    ref: 'a1',
    url: 'https://balivillahub.com/listing/a1',
    title: 'Modern 2 Bedroom Villa in Cemagi',
    bedrooms: 2,
    price_month_idr: 35_000_000,
    area: 'cemagi',
    images: [url('/a/1.png'), url('/a/2.png')],
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().settle_queued, true);
  const idA = first.json().ids[0];
  await waitForSettle(db, 1);
  assert.ok(fs.existsSync(path.join(env.IMAGES_DIR, String(idA), '1.jpg')));
  assert.ok(fs.existsSync(path.join(env.IMAGES_DIR, String(idA), '2.jpg')));

  seen.length = 0;

  // The same villa from another ref, other photo urls, 8 % dearer — outside rule 1's
  // 5 % price window, so only the hero photo can catch it.
  const second = await importOne(call, {
    ref: 'b7',
    url: 'https://balivillahub.com/listing/b7',
    title: 'Tropical Beachside Retreat Cemagi',
    bedrooms: 2,
    price_month_idr: 38_000_000,
    area: 'cemagi',
    images: [url('/b/1.png'), url('/b/2.png'), url('/b/3.png')],
  });
  assert.equal(second.statusCode, 200);
  const idB = second.json().ids[0];
  const run = await waitForSettle(db, 2);

  // (a) only the hero of the duplicate was ever requested
  assert.deepEqual(seen, ['/b/1.png'], 'the rest of the duplicate gallery was never fetched');

  const rowB = db.prepare('SELECT * FROM properties WHERE id = ?').get(idB);
  assert.equal(rowB.availability, 'gone', 'the duplicate is gone, never deleted');
  const rawB = JSON.parse(rowB.raw);
  assert.equal(rawB.merged_into, idA);
  assert.match(rawB.merged_reason, /^hero photo matches #\d+$/);

  const rowA = db.prepare('SELECT * FROM properties WHERE id = ?').get(idA);
  assert.notEqual(rowA.availability, 'gone', 'the older agency record survives');

  // (c) the merged-away row's files are gone; the survivor keeps its own
  assert.equal(fs.existsSync(path.join(env.IMAGES_DIR, String(idB))), false);
  assert.ok(fs.existsSync(path.join(env.IMAGES_DIR, String(idA), '1.jpg')));

  // (d) the settle run row reports what happened
  assert.equal(run.kind, 'settle');
  assert.deepEqual(run.errors, []);
  assert.ok(run.notes.includes('merged_early=0'), run.notes.join(' | '));
  assert.ok(run.notes.includes('merged_by_hero=1'), run.notes.join(' | '));
  assert.ok(run.notes.includes('merged_late=0'), run.notes.join(' | '));
  assert.ok(run.notes.includes('galleries_downloaded=0'), run.notes.join(' | '));
  assert.ok(run.notes.includes('files_removed=1'), run.notes.join(' | '));
  assert.ok(
    run.notes.some((n) => n.startsWith(`kept #${idA} <- merged #${idB} (hero photo matches`)),
    run.notes.join(' | ')
  );
  assert.equal(run.gone, 1);

  // the import's own run row says the settle job was queued
  const scrapeRun = db.prepare("SELECT * FROM runs WHERE kind = 'scrape' ORDER BY id DESC LIMIT 1").get();
  assert.ok(JSON.parse(scrapeRun.notes).includes('settle=queued'));
});

// ---------------------------------------------------------------------------
// (b) a listing that is nobody's duplicate gets its whole gallery
// ---------------------------------------------------------------------------

test('a distinct listing downloads its full gallery', async (t) => {
  const { db, call, env } = await setup(t);

  const files = new Map([
    ['/c/1.png', await makePng({ r: 5, g: 60, b: 160 })],
    ['/c/2.png', await makePng({ r: 160, g: 10, b: 90 })],
    ['/c/3.png', await makePng({ r: 40, g: 170, b: 40 })],
  ]);
  const { server, seen, port } = await startImageServer(files);
  t.after(() => stop(server));
  const url = (p) => `http://127.0.0.1:${port}${p}`;

  const res = await importOne(call, {
    ref: 'c3',
    url: 'https://balivillahub.com/listing/c3',
    title: '3 Bedroom Villa in Pererenan',
    bedrooms: 3,
    price_month_idr: 45_000_000,
    area: 'pererenan',
    images: [url('/c/1.png'), url('/c/2.png'), url('/c/3.png')],
  });
  assert.equal(res.statusCode, 200);
  const id = res.json().ids[0];
  const run = await waitForSettle(db, 1);

  assert.deepEqual(seen.sort(), ['/c/1.png', '/c/2.png', '/c/3.png']);
  for (const n of [1, 2, 3]) assert.ok(fs.existsSync(path.join(env.IMAGES_DIR, String(id), `${n}.jpg`)));

  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  assert.notEqual(row.availability, 'gone');
  const images = JSON.parse(row.images);
  assert.equal(images.length, 3);
  assert.ok(images.every((im) => im.file && im.hash), 'every stored image has a file and a hash');
  assert.equal(row.hero_file, `${id}/1.jpg`);

  assert.deepEqual(run.errors, []);
  assert.ok(run.notes.includes('merged_early=0'), run.notes.join(' | '));
  assert.ok(run.notes.includes('merged_by_hero=0'), run.notes.join(' | '));
  assert.ok(run.notes.includes('merged_late=0'), run.notes.join(' | '));
  assert.ok(run.notes.includes('galleries_downloaded=1'), run.notes.join(' | '));
  assert.ok(run.notes.includes('files_removed=0'), run.notes.join(' | '));
  assert.equal(run.gone, 0);
});
