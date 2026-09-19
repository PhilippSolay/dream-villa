// The duplicate checker: scoring (src/scrape/duplicates.js) and its API
// (src/routes/duplicates.js). One temp DB per test; rows go straight into the table
// because the scorer only ever reads columns.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { allCandidates, candidatesFor, scorePair, loadContext } from '../src/scrape/duplicates.js';

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

function tmpDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-dup-'));
  const db = openDb(path.join(dir, 'villa.db'));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir };
}

let n = 0;
function insert(db, overrides = {}) {
  n += 1;
  const row = {
    key: `bhi:RF${n}`,
    ref: `RF${n}`,
    source: 'bhi',
    url: `https://bali-home-immo.com/rf${n}`,
    title: `Modern 2 Bedroom Villa in Cemagi ${n}`,
    description: null,
    area: 'cemagi',
    bedrooms: 2,
    price_month_idr: 40_000_000,
    availability: 'available',
    first_seen: '2026-09-01T00:00:00.000Z',
    last_seen: '2026-09-01T00:00:00.000Z',
    raw: JSON.stringify({ ref: `RF${n}` }),
    ...overrides,
  };
  const cols = Object.keys(row);
  const info = db
    .prepare(`INSERT INTO properties (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c]));
  return Number(info.lastInsertRowid);
}

/** Link a (found or created) contact with this WhatsApp number to a property. */
function linkContact(db, propertyId, whatsapp) {
  const existing = db.prepare('SELECT id FROM contacts WHERE whatsapp = ?').get(whatsapp);
  const contactId =
    existing?.id ??
    Number(
      db
        .prepare('INSERT INTO contacts (name, role, whatsapp, created_at) VALUES (?, ?, ?, ?)')
        .run('Wayan', 'owner', whatsapp, '2026-09-01T00:00:00.000Z').lastInsertRowid
    );
  db.prepare('INSERT OR IGNORE INTO property_contacts (property_id, contact_id) VALUES (?, ?)')
    .run(propertyId, contactId);
  return contactId;
}

const pairOf = (list, a, b) => list.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

test('scoring: shared WhatsApp and the same price clear 0.6 with both reasons', (t) => {
  const { db } = tmpDb(t);
  const a = insert(db, { source: 'bhi', title: 'Villa Melati', key: 'bhi:M1', ref: 'M1' });
  const b = insert(db, { source: 'fb', title: 'Rumah disewakan Cemagi', key: 'fb:p1', ref: 'p1', url: 'https://facebook.test/p1' });
  linkContact(db, a, '+6281234567890');
  linkContact(db, b, '0812 3456 7890'); // same line, written the way a Facebook post writes it

  const pairs = allCandidates(db);
  const pair = pairOf(pairs, a, b);
  assert.ok(pair, 'expected the pair to be a candidate');
  assert.ok(pair.score >= 0.6, `expected >= 0.6, got ${pair.score}`);
  assert.ok(pair.reasons.some((r) => r.includes('WhatsApp')), pair.reasons.join(' · '));
  assert.ok(pair.reasons.some((r) => r.includes('40 M')), pair.reasons.join(' · '));
  assert.ok(pair.reasons.some((r) => r.startsWith('same area')), pair.reasons.join(' · '));
});

test('scoring: a shared photo and a matching pin are enough on their own', (t) => {
  const { db } = tmpDb(t);
  const shared = 'https://cdn.test/photo-9.jpg';
  const a = insert(db, {
    images: JSON.stringify([{ src_url: shared, file: '1/1.jpg' }]), lat: -8.6191, lng: 115.1031,
  });
  const b = insert(db, {
    source: 'kibarer', key: 'kibarer:9', ref: '9', price_month_idr: 42_000_000,
    images: JSON.stringify([{ src_url: shared }]), lat: -8.6192, lng: 115.1032,
  });

  const pair = pairOf(allCandidates(db), a, b);
  assert.ok(pair, 'expected a candidate');
  assert.ok(pair.reasons.includes('photo shared'), pair.reasons.join(' · '));
  assert.ok(pair.reasons.some((r) => /pins \d+ m apart/.test(r)), pair.reasons.join(' · '));
  assert.ok(pair.score >= 0.65, `expected >= 0.65, got ${pair.score}`);
});

test('scoring: different bedroom counts never pair, however alike', (t) => {
  const { db } = tmpDb(t);
  const shared = 'https://cdn.test/same.jpg';
  const a = insert(db, { bedrooms: 2, title: 'Villa Kenari', images: JSON.stringify([{ src_url: shared }]) });
  const b = insert(db, {
    bedrooms: 3, title: 'Villa Kenari', source: 'fb', key: 'fb:x', ref: 'x',
    images: JSON.stringify([{ src_url: shared }]),
  });
  linkContact(db, a, '+6281111111111');
  linkContact(db, b, '+6281111111111');

  assert.equal(pairOf(allCandidates(db), a, b), undefined);
  assert.deepEqual(candidatesFor(db, a), []);

  const ctx = loadContext(db);
  const rows = new Map(ctx.rows.map((r) => [r.id, r]));
  assert.equal(scorePair(rows.get(a), rows.get(b), ctx), null);
});

test('scoring: a dismissed pair and a gone row drop out', (t) => {
  const { db } = tmpDb(t);
  const shared = 'https://cdn.test/one.jpg';
  const a = insert(db, { images: JSON.stringify([{ src_url: shared }]) });
  const b = insert(db, { source: 'fb', key: 'fb:b', ref: 'b', images: JSON.stringify([{ src_url: shared }]) });
  const gone = insert(db, {
    source: 'fb', key: 'fb:c', ref: 'c', availability: 'gone',
    images: JSON.stringify([{ src_url: shared }]),
  });

  assert.ok(pairOf(allCandidates(db), a, b), 'a and b should pair before the dismissal');
  assert.equal(pairOf(allCandidates(db), a, gone), undefined, 'a gone row is never a candidate');

  db.prepare('INSERT INTO duplicate_dismissals (property_a, property_b, by, created_at) VALUES (?, ?, ?, ?)')
    .run(Math.min(a, b), Math.max(a, b), 1, '2026-09-18T00:00:00.000Z');

  assert.equal(pairOf(allCandidates(db), a, b), undefined, 'dismissed pairs stay hidden');
  assert.deepEqual(candidatesFor(db, a), []);
});

test('scoring: two units of one complex (RF9183A / RF9183B) are never duplicates', (t) => {
  const { db } = tmpDb(t);
  const shared = 'https://cdn.test/complex.jpg';
  const a = insert(db, { key: 'bhi:RF9183A', ref: 'RF9183A', title: 'Villa Complex Unit A', images: JSON.stringify([{ src_url: shared }]) });
  const b = insert(db, { key: 'bhi:RF9183B', ref: 'RF9183B', title: 'Villa Complex Unit B', images: JSON.stringify([{ src_url: shared }]) });
  assert.equal(pairOf(allCandidates(db), a, b), undefined);
});

test('scoring: the score is capped at 1 and sorted best first', (t) => {
  const { db } = tmpDb(t);
  const shared = 'https://cdn.test/twin.jpg';
  const common = {
    title: 'Beautiful Two Bedroom Villa in Cemagi Beach Side',
    description: 'A calm two bedroom villa a short walk from the beach with an open living room.',
    land_m2: 200, build_m2: 120, lat: -8.619, lng: 115.103,
    images: JSON.stringify([{ src_url: shared }]),
  };
  const a = insert(db, common);
  const b = insert(db, { ...common, source: 'fb', key: 'fb:twin', ref: 'twin', url: 'https://facebook.test/twin' });
  linkContact(db, a, '+6282222222222');
  linkContact(db, b, '+6282222222222');
  // A weaker pair, so the sort has something to order.
  const c = insert(db, { source: 'olx', key: 'olx:c', ref: 'c', title: 'Some Other Villa', price_month_idr: 41_500_000 });

  const pairs = allCandidates(db);
  assert.equal(pairs[0].score, 1);
  assert.ok(pairOf(pairs, a, b));
  for (let i = 1; i < pairs.length; i++) assert.ok(pairs[i - 1].score >= pairs[i].score);
  assert.ok(pairs.every((p) => p.score <= 1));
  assert.ok(c > 0);
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-dupapi-'));
  const env = { ...ENV, IMAGES_DIR: path.join(dir, 'images') };
  const db = openDb(path.join(dir, 'villa.db'));
  seedUsers(db, env);
  const app = await buildServer({ db, env });
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
  return { db, app, call };
}

/** Two rows that are obviously the same villa: shared photo, shared WhatsApp, same price. */
function twin(db) {
  const shared = 'https://cdn.test/pair.jpg';
  const a = insert(db, { title: 'Villa Anggrek', images: JSON.stringify([{ src_url: shared }]), hero_file: '1/1.jpg' });
  const b = insert(db, {
    source: 'fb', key: 'fb:anggrek', ref: 'anggrek', url: 'https://facebook.test/anggrek',
    title: 'Disewakan villa 2 kamar Cemagi', images: JSON.stringify([{ src_url: shared }]),
  });
  linkContact(db, a, '+6283333333333');
  linkContact(db, b, '+6283333333333');
  return { a, b };
}

test('API: candidates for one listing, then a merge that keeps the chosen row', async (t) => {
  const { db, call } = await setup(t);
  const { a, b } = twin(db);

  const res = await call({ method: 'GET', url: `/api/properties/${a}/duplicates` });
  assert.equal(res.statusCode, 200);
  const { candidates } = res.json();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].property.id, b);
  assert.equal(candidates[0].property.source, 'fb');
  assert.ok(candidates[0].score >= 0.6);
  assert.ok(candidates[0].reasons.length);

  // The person keeps the Facebook row (b) — not the older one, which the automatic pass
  // would have chosen.
  const droppedUrl = db.prepare('SELECT url FROM properties WHERE id = ?').get(a).url;
  const merged = await call({ method: 'POST', url: '/api/duplicates/merge', payload: { keep_id: b, merge_id: a } });
  assert.equal(merged.statusCode, 200);
  assert.equal(merged.json().property.id, b);

  const dropped = db.prepare('SELECT availability, raw FROM properties WHERE id = ?').get(a);
  assert.equal(dropped.availability, 'gone');
  const raw = JSON.parse(dropped.raw);
  assert.equal(raw.merged_into, b);
  assert.equal(raw.merged_by, 1);
  assert.ok(raw.merged_at);

  // The kept row keeps the other listing's URL (SPEC §6: append to alt_urls).
  const kept = db.prepare('SELECT alt_urls FROM properties WHERE id = ?').get(b);
  assert.deepEqual(JSON.parse(kept.alt_urls), [droppedUrl]);

  // The pair is gone from both listings.
  assert.deepEqual((await call({ method: 'GET', url: `/api/properties/${b}/duplicates` })).json().candidates, []);
  assert.deepEqual((await call({ method: 'GET', url: '/api/duplicates' })).json().pairs, []);
});

test('API: /api/duplicates lists both sides, dismiss hides the pair, undismiss restores it', async (t) => {
  const { db, call } = await setup(t);
  const { a, b } = twin(db);

  const listed = await call({ method: 'GET', url: '/api/duplicates?limit=10' });
  assert.equal(listed.statusCode, 200);
  const { pairs } = listed.json();
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].a.id, pairs[0].b.id].sort((x, y) => x - y), [a, b].sort((x, y) => x - y));
  assert.ok(pairs[0].a.title && pairs[0].b.title);
  assert.ok('hero_url' in pairs[0].a);

  const dismissed = await call({ method: 'POST', url: '/api/duplicates/dismiss', payload: { a: b, b: a } });
  assert.equal(dismissed.statusCode, 200);
  assert.deepEqual(dismissed.json(), { ok: true, a: Math.min(a, b), b: Math.max(a, b) });
  assert.equal(db.prepare('SELECT by FROM duplicate_dismissals').get().by, 1);

  assert.deepEqual((await call({ method: 'GET', url: '/api/duplicates' })).json().pairs, []);
  assert.deepEqual((await call({ method: 'GET', url: `/api/properties/${a}/duplicates` })).json().candidates, []);

  // Dismissing twice is not an error, and does not make a second row.
  assert.equal((await call({ method: 'POST', url: '/api/duplicates/dismiss', payload: { a, b } })).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM duplicate_dismissals').get().n, 1);

  const undismissed = await call({ method: 'POST', url: '/api/duplicates/undismiss', payload: { a, b } });
  assert.equal(undismissed.statusCode, 200);
  assert.equal(undismissed.json().removed, 1);
  assert.equal((await call({ method: 'GET', url: '/api/duplicates' })).json().pairs.length, 1);
});

test('API: bad merges are refused, unknown ids are 404', async (t) => {
  const { db, call } = await setup(t);
  const { a, b } = twin(db);

  assert.equal(
    (await call({ method: 'POST', url: '/api/duplicates/merge', payload: { keep_id: a, merge_id: a } })).statusCode,
    400
  );
  assert.equal(
    (await call({ method: 'POST', url: '/api/duplicates/merge', payload: { keep_id: a, merge_id: 9999 } })).statusCode,
    404
  );
  assert.equal((await call({ method: 'GET', url: '/api/properties/9999/duplicates' })).statusCode, 404);
  assert.equal(
    (await call({ method: 'POST', url: '/api/duplicates/merge', payload: { keep_id: a, merge_id: b, why: 'x' } })).statusCode,
    400
  );

  // Merging a row that is already gone is a 400, not a second merge.
  assert.equal(
    (await call({ method: 'POST', url: '/api/duplicates/merge', payload: { keep_id: a, merge_id: b } })).statusCode,
    200
  );
  assert.equal(
    (await call({ method: 'POST', url: '/api/duplicates/merge', payload: { keep_id: a, merge_id: b } })).statusCode,
    400
  );
});

test('API: every duplicate route needs a logged-in user', async (t) => {
  const { db, app } = await setup(t);
  const { a, b } = twin(db);
  const calls = [
    { method: 'GET', url: `/api/properties/${a}/duplicates` },
    { method: 'GET', url: '/api/duplicates' },
    { method: 'POST', url: '/api/duplicates/merge', payload: { keep_id: a, merge_id: b } },
    { method: 'POST', url: '/api/duplicates/dismiss', payload: { a, b } },
    { method: 'POST', url: '/api/duplicates/undismiss', payload: { a, b } },
  ];
  for (const opts of calls) {
    const res = await app.inject(opts);
    assert.equal(res.statusCode, 401, `${opts.method} ${opts.url}`);
  }
});
