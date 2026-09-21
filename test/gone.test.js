// The archive (SPEC §16): a listing that leaves the market keeps its row, records when
// and why it went, and is readable as a group — so "what did we miss" is answerable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, nowIso } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { markGone, markUnlisted, rescoreAll, upsertProperty } from '../src/scrape/store.js';

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

// Frozen at load: two calls for the same `n` must produce the same string, or an
// assertion comparing a stored stamp against a fresh one fails on a millisecond.
const BASE_MS = Date.now();
const daysAgoIso = (n) => new Date(BASE_MS - n * 86_400_000).toISOString();

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-gone-'));
  return { db: openDb(path.join(dir, 'villa.db')), dir };
}

let seq = 0;
function insertListing(db, overrides = {}) {
  seq += 1;
  const now = nowIso();
  const row = {
    key: `test:${seq}`, ref: `RF${2000 + seq}`, source: 'bhi', url: `https://bali-home-immo.com/l-${seq}`,
    title: `Villa ${seq}`, area: 'cemagi', bedrooms: 3, price_month_idr: 40_000_000, term: 'monthly',
    beach_km: 1.2, scope: 'in_filter', fit_score: 70, flagged: 0, red_flags: '[]',
    availability: 'available', status: 'new', first_seen: now, last_seen: now,
    ...overrides,
  };
  const cols = Object.keys(row);
  const info = db
    .prepare(`INSERT INTO properties (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c]));
  return Number(info.lastInsertRowid);
}

async function setup(t) {
  const { db, dir } = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { email: ENV.USER1_EMAIL, password: ENV.USER1_PASSWORD } });
  assert.equal(login.statusCode, 200);
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw).split(';')[0];
  const call = (opts) => app.inject({ ...opts, headers: { cookie, ...(opts.headers || {}) } });
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(ENV.USER1_EMAIL).id;
  return { app, db, call, user };
}

const list = async (call, query) => {
  const res = await call({ method: 'GET', url: `/api/properties?${query}` });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
};

// ---------------------------------------------------------------------------
// Keeping the record
// ---------------------------------------------------------------------------

test('a removed listing keeps its row, its stamp and its last sighting', async (t) => {
  const { db, call } = await setup(t);
  const id = insertListing(db, { first_seen: daysAgoIso(10), last_seen: daysAgoIso(4) });
  markGone(db, id, daysAgoIso(1), 'delisted');

  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  assert.equal(row.availability, 'gone', 'the row is still there, marked gone');
  assert.equal(row.removed_reason, 'delisted');
  assert.equal(row.last_seen, daysAgoIso(4), 'last_seen is the last sighting, not the detection');

  const [p] = await list(call, 'removed=only&scope=all&status=all');
  assert.equal(p.id, id);
  assert.equal(p.removed_reason, 'delisted');
  assert.equal(p.days_live, 6, 'first_seen → last_seen, so it was live for six days');
});

test('markUnlisted stamps the removal and leaves last_seen alone', async (t) => {
  const { db, call } = await setup(t);
  const id = insertListing(db, { first_seen: daysAgoIso(30), last_seen: daysAgoIso(5) });
  const now = nowIso();
  const res = markUnlisted(db, ['bhi'], { now, staleDays: 3 });
  assert.equal(res.n, 1);

  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  assert.equal(row.availability, 'unlisted');
  assert.equal(row.removed_at, now);
  assert.equal(row.removed_reason, 'unlisted');
  assert.equal(row.last_seen, daysAgoIso(5));

  const [p] = await list(call, 'removed=only&scope=all&status=all');
  assert.equal(p.days_live, 25);
});

test('a listing that comes back loses its removal stamp and keeps its history', (t, done) => {
  const { db, dir } = tmpDb();
  try {
    const base = {
      key: 'bhi:RF9', ref: 'RF9', source: 'bhi', url: 'https://bali-home-immo.com/x',
      title: 'Villa Kembali', area: 'cemagi', price_month_idr: 40_000_000, availability: 'available',
    };
    const { id } = upsertProperty(db, base, { now: daysAgoIso(20) });
    markGone(db, id, daysAgoIso(5), 'delisted');
    assert.equal(db.prepare('SELECT removed_at FROM properties WHERE id = ?').get(id).removed_at, daysAgoIso(5));

    upsertProperty(db, base, { now: nowIso() });
    const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
    assert.equal(row.availability, 'available');
    assert.equal(row.removed_at, null, 'back on the market: the stamp is cleared');
    assert.equal(row.removed_reason, null);
    assert.equal(row.first_seen, daysAgoIso(20), 'its history survives the round trip');
    done();
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tapping Gone records the removal; moving off Gone clears it', async (t) => {
  const { db, call } = await setup(t);
  const id = insertListing(db, { first_seen: daysAgoIso(8) });

  const gone = await call({ method: 'POST', url: `/api/properties/${id}/status`, payload: { status: 'gone' } });
  assert.equal(gone.statusCode, 200);
  assert.equal(gone.json().removed_reason, 'taken');
  assert.ok(gone.json().removed_at, 'a person-set Gone is dated too');

  const back = await call({ method: 'POST', url: `/api/properties/${id}/status`, payload: { status: 'shortlist' } });
  assert.equal(back.statusCode, 200);
  assert.equal(back.json().removed_at, null);
  assert.equal(back.json().removed_reason, null);
});

test('a person tapping Gone never overwrites what the scraper already recorded', async (t) => {
  const { db, call } = await setup(t);
  const id = insertListing(db);
  markGone(db, id, daysAgoIso(3), 'archived');

  const res = await call({ method: 'POST', url: `/api/properties/${id}/status`, payload: { status: 'gone' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().removed_at, daysAgoIso(3), 'the scraper found out first; its date stands');
  assert.equal(res.json().removed_reason, 'archived');
});

test('a listing that leaves the market stops being Featured', async (t) => {
  const { db, call } = await setup(t);
  const delisted = insertListing(db, { fit_score: 88, flagged: 1 });
  const dropped = insertListing(db, { fit_score: 91, flagged: 1, last_seen: daysAgoIso(5) });

  markGone(db, delisted, nowIso(), 'delisted');
  markUnlisted(db, ['bhi'], { now: nowIso(), staleDays: 3 });

  const flags = db
    .prepare('SELECT id, flagged FROM properties WHERE id IN (?, ?)')
    .all(delisted, dropped)
    .map((r) => r.flagged);
  assert.deepEqual(flags, [0, 0], 'SPEC §15.4: a gone listing is never flagged');

  // And a rescore does not put the pill back on.
  rescoreAll(db);
  const after = db.prepare('SELECT flagged FROM properties WHERE id = ?').get(delisted).flagged;
  assert.equal(after, 0);

  const featured = await list(call, 'scope=all&status=all&removed=show&flagged=1');
  assert.equal(featured.length, 0, 'and it is out of every Featured list');
});

// ---------------------------------------------------------------------------
// Reading the archive
// ---------------------------------------------------------------------------

test('removed=only leaves out rows folded away by dedupe', async (t) => {
  const { db, call } = await setup(t);
  const real = insertListing(db, { title: 'Really gone' });
  markGone(db, real, nowIso(), 'delisted');
  const dupe = insertListing(db, {
    title: 'A duplicate',
    availability: 'gone',
    removed_at: nowIso(),
    removed_reason: 'merged',
    raw: JSON.stringify({ merged_into: real }),
  });

  const only = await list(call, 'removed=only&scope=all&status=all');
  assert.deepEqual(only.map((p) => p.id), [real], 'a merged row is bookkeeping, not a villa that got away');

  const show = await list(call, 'removed=show&scope=all&status=all');
  assert.ok(!show.some((p) => p.id === dupe), 'and it stays out of removed=show too');
});

test('removed_days windows the archive and sort=removed puts the newest loss first', async (t) => {
  const { db, call } = await setup(t);
  const old = insertListing(db, { title: 'Went long ago', first_seen: daysAgoIso(120) });
  const mid = insertListing(db, { title: 'Went last month', first_seen: daysAgoIso(90) });
  const fresh = insertListing(db, { title: 'Went yesterday', first_seen: daysAgoIso(20) });
  markGone(db, old, daysAgoIso(100), 'delisted');
  markGone(db, mid, daysAgoIso(40), 'archived');
  markGone(db, fresh, daysAgoIso(1), 'delisted');

  const all = await list(call, 'removed=only&scope=all&status=all&sort=removed');
  assert.deepEqual(all.map((p) => p.id), [fresh, mid, old], 'newest loss first');

  const month = await list(call, 'removed=only&scope=all&status=all&removed_days=30');
  assert.deepEqual(month.map((p) => p.id), [fresh]);

  const quarter = await list(call, 'removed=only&scope=all&status=all&removed_days=90&sort=removed');
  assert.deepEqual(quarter.map((p) => p.id), [fresh, mid]);
});

test('removed_reason filters the archive, and an unknown one is a 400', async (t) => {
  const { db, call } = await setup(t);
  const a = insertListing(db);
  const b = insertListing(db);
  markGone(db, a, nowIso(), 'delisted');
  markGone(db, b, nowIso(), 'archived');

  const rows = await list(call, 'removed=only&scope=all&status=all&removed_reason=archived');
  assert.deepEqual(rows.map((p) => p.id), [b]);

  const both = await list(call, 'removed=only&scope=all&status=all&removed_reason=archived,delisted&sort=removed');
  assert.equal(both.length, 2);

  const bad = await call({ method: 'GET', url: '/api/properties?removed=only&removed_reason=vanished' });
  assert.equal(bad.statusCode, 400);
});

test('rows removed before the stamp existed still read as removed', async (t) => {
  const { db, call } = await setup(t);
  // Exactly what an old row looks like: gone, with last_seen as the only evidence.
  const id = insertListing(db, { availability: 'gone', first_seen: daysAgoIso(30), last_seen: daysAgoIso(9) });
  db.prepare('UPDATE properties SET removed_at = NULL, removed_reason = NULL WHERE id = ?').run(id);

  const [p] = await list(call, 'removed=only&scope=all&status=all&sort=removed');
  assert.equal(p.id, id);
  assert.equal(p.removed_at, daysAgoIso(9), 'falls back to last_seen');
  assert.equal(p.removed_reason, 'delisted');

  const windowed = await list(call, 'removed=only&scope=all&status=all&removed_days=30');
  assert.deepEqual(windowed.map((r) => r.id), [id], 'and the window still finds it');
});

test('the archive is the only place removed listings show up by default', async (t) => {
  const { db, call } = await setup(t);
  const live = insertListing(db, { title: 'Still going' });
  const gone = insertListing(db, { title: 'Gone' });
  markGone(db, gone, nowIso(), 'delisted');

  const home = await list(call, 'scope=all&status=all');
  assert.deepEqual(home.map((p) => p.id), [live], 'lists hide removed listings unless asked');

  const archive = await list(call, 'removed=only&scope=all&status=all');
  assert.deepEqual(archive.map((p) => p.id), [gone]);
});

test('migration 006 backfills the rows that were already gone', (t, done) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-gone-mig-'));
  const file = path.join(dir, 'villa.db');
  try {
    const db = openDb(file);
    const id = insertListing(db, { availability: 'unlisted', last_seen: daysAgoIso(7) });
    const taken = insertListing(db, { status: 'gone', status_at: daysAgoIso(2) });
    // Rewind to before the migration, then let openDb run it again on the same file.
    db.prepare('UPDATE properties SET removed_at = NULL, removed_reason = NULL').run();
    db.prepare("DELETE FROM migrations WHERE name = '006_removed_at'").run();
    db.close();

    const reopened = openDb(file);
    const unlisted = reopened.prepare('SELECT * FROM properties WHERE id = ?').get(id);
    assert.equal(unlisted.removed_at, daysAgoIso(7));
    assert.equal(unlisted.removed_reason, 'unlisted');
    const person = reopened.prepare('SELECT * FROM properties WHERE id = ?').get(taken);
    assert.equal(person.removed_at, daysAgoIso(2));
    assert.equal(person.removed_reason, 'taken');
    reopened.close();
    done();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
