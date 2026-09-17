import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

import { openDb, nowIso, getConfig, setConfig } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import agentRoutes, { createRateLimiter } from '../src/routes/agent.js';
import { scoreRow } from '../src/scrape/score.js';
import { DEFAULT_WEIGHTS } from '../src/defaults.js';

const ENV = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
  AGENT_TOKEN: 't-agent',
  USER1_EMAIL: 'philipp@example.com',
  USER1_NAME: 'Philipp',
  USER1_PASSWORD: 'correct horse battery staple',
  USER2_EMAIL: 'abigail@example.com',
  USER2_NAME: 'Abigail',
  USER2_PASSWORD: 'another long passphrase',
};

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-agent-'));
  return openDb(path.join(dir, 'villa.db'));
}

let seq = 0;
/** A minimal, fully-controlled `properties` row — plain SQL so the test owns
 *  first_seen/last_seen/scope/fit_score/flagged directly rather than going
 *  through the scraper's upsert/score pipeline. */
function insertListing(db, overrides = {}) {
  seq += 1;
  const now = nowIso();
  const row = {
    key: `test:${seq}`,
    ref: `RF${1000 + seq}`,
    source: 'bhi',
    url: `https://bali-home-immo.com/listing-${seq}`,
    title: `Test Villa ${seq}`,
    area: 'cemagi',
    sub_area: 'Beach Side',
    bedrooms: 2,
    price_month_idr: 30_000_000,
    term: 'monthly',
    beach_km: 1.2,
    scope: 'in_filter',
    fit_score: 70,
    flagged: 0,
    red_flags: '[]',
    availability: 'available',
    status: 'new',
    first_seen: now,
    last_seen: now,
    price_history: JSON.stringify([{ date: now.slice(0, 10), price_month_idr: 30_000_000 }]),
    ...overrides,
  };
  const cols = Object.keys(row);
  const sql = `INSERT INTO properties (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  const info = db.prepare(sql).run(...cols.map((c) => row[c]));
  return Number(info.lastInsertRowid);
}

function insertFeedback(db, { propertyId, by, text = 'noisy road, dogs barking', createdAt = nowIso() }) {
  const info = db
    .prepare('INSERT INTO feedback (property_id, by, text, created_at) VALUES (?, ?, ?, ?)')
    .run(propertyId, by, text, createdAt);
  return Number(info.lastInsertRowid);
}

function insertViewing(db, { propertyId, by, date = '2026-09-17', verdict = 'maybe', createdAt = nowIso() }) {
  db.prepare('INSERT INTO viewings (property_id, by, date, verdict, quiet, privacy, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    propertyId,
    by,
    date,
    verdict,
    3,
    4,
    'nice breeze',
    createdAt
  );
}

// ---------------------------------------------------------------------------
// Auth / transport gate
// ---------------------------------------------------------------------------

test('agent API: no token -> 401, wrong token -> 401', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const noToken = await app.inject({ method: 'GET', url: '/api/agent/digest' });
  assert.equal(noToken.statusCode, 401);
  assert.equal(noToken.json().error, 'unauthorized');

  const wrongToken = await app.inject({ method: 'GET', url: '/api/agent/digest?token=nope' });
  assert.equal(wrongToken.statusCode, 401);
  assert.equal(wrongToken.json().error, 'unauthorized');
});

test('agent API: AGENT_TOKEN unset -> 503', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: { ...ENV, AGENT_TOKEN: '' } });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const res = await app.inject({ method: 'GET', url: '/api/agent/digest?token=whatever' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, 'agent_api_disabled');
});

test('agent API: HTTPS gate — production over plain http is 403, x-forwarded-proto:https passes', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: { ...ENV, NODE_ENV: 'production' } });
  t.after(async () => {
    await app.close();
    db.close();
  });

  // A non-loopback remote address so the loopback allowance doesn't mask the check.
  const plainHttp = await app.inject({
    method: 'GET',
    url: '/api/agent/digest?token=t-agent',
    remoteAddress: '203.0.113.5',
  });
  assert.equal(plainHttp.statusCode, 403);
  assert.equal(plainHttp.json().error, 'https_required');

  const viaTraefik = await app.inject({
    method: 'GET',
    url: '/api/agent/digest?token=t-agent',
    remoteAddress: '203.0.113.5',
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(viaTraefik.statusCode, 200);
});

test('agent API: responses are text/plain and JSON-parsable', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const res = await app.inject({ method: 'GET', url: '/api/agent/digest?token=t-agent' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^text\/plain; ?charset=utf-8$/);
  assert.doesNotThrow(() => JSON.parse(res.body));
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

test('digest: first call uses a 24h window and advances last_digest_at; second call picks up where it left off', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  assert.equal(getConfig(db).last_digest_at, undefined, 'no watermark before the first call');

  const first = await app.inject({ method: 'GET', url: '/api/agent/digest?token=t-agent' });
  const firstBody = first.json();
  const spanMs = new Date(firstBody.now) - new Date(firstBody.since);
  assert.ok(Math.abs(spanMs - 24 * 3600 * 1000) < 5000, `since should be ~24h before now, got ${spanMs}ms`);
  assert.equal(getConfig(db).last_digest_at, firstBody.now, 'call sets last_digest_at to its own `now`');

  const second = await app.inject({ method: 'GET', url: '/api/agent/digest?token=t-agent' });
  assert.equal(second.json().since, firstBody.now, "second call's since is the first call's now");
});

test('digest: `new` includes a freshly-seen listing and excludes one from a week ago, not-gone only', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const freshId = insertListing(db, { title: 'Fresh Cemagi Villa' });
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  insertListing(db, { title: 'Old News Villa', first_seen: weekAgo, last_seen: weekAgo });
  insertListing(db, { title: 'Gone Fresh Villa', availability: 'gone' });

  const res = await app.inject({ method: 'GET', url: '/api/agent/digest?token=t-agent' });
  const body = res.json();
  const ids = body.new.map((r) => r.id);
  assert.ok(ids.includes(freshId), 'freshly first-seen listing appears in `new`');
  assert.equal(body.new.every((r) => r.title !== 'Old News Villa'), true, 'week-old listing excluded');
  assert.equal(body.new.every((r) => r.title !== 'Gone Fresh Villa'), true, 'gone listing excluded even if freshly first-seen');

  const row = body.new.find((r) => r.id === freshId);
  assert.deepEqual(Object.keys(row).sort(), [
    'area', 'bedrooms', 'beach_km', 'flagged', 'fit_score', 'hero_url', 'id', 'price_month_idr',
    'ref', 'reasons', 'status', 'sub_area', 'term', 'title', 'url',
  ].sort());
});

test('digest: `flagged` lists currently-flagged rows with reasons', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const flaggedId = insertListing(db, { title: 'Flagged Villa', flagged: 1, fit_score: 80, pool: 1, view: 'ocean' });
  insertListing(db, { title: 'Not Flagged Villa', flagged: 0 });

  const res = await app.inject({ method: 'GET', url: '/api/agent/digest?token=t-agent' });
  const body = res.json();
  const row = body.flagged.find((r) => r.id === flaggedId);
  assert.ok(row, 'flagged listing is present');
  assert.ok(row.reasons.length > 0, 'reasons is non-empty');
  assert.equal(body.flagged.every((r) => r.title !== 'Not Flagged Villa'), true);
});

test('digest: a price_history entry dated today appears in `changes`', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  // Pin `since` explicitly so the test isn't sensitive to the default 24h window / midnight.
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  setConfig(db, 'last_digest_at', twoDaysAgo);

  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const today = nowIso().slice(0, 10);
  const id = insertListing(db, {
    title: 'Price Drop Villa',
    price_history: JSON.stringify([
      { date: yesterday, price_month_idr: 35_000_000 },
      { date: today, price_month_idr: 32_000_000 },
    ]),
  });

  const res = await app.inject({ method: 'GET', url: '/api/agent/digest?token=t-agent' });
  const change = res.json().changes.find((c) => c.id === id && c.what === 'price');
  assert.ok(change, 'price change recorded');
  assert.equal(change.from, 35_000_000);
  assert.equal(change.to, 32_000_000);
});

test('digest: feedback and viewings created since the watermark appear with by_name', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  setConfig(db, 'last_digest_at', twoDaysAgo);

  const id = insertListing(db, { title: 'Feedback Villa' });
  insertFeedback(db, { propertyId: id, by: 1, text: 'too far from the beach' });
  insertViewing(db, { propertyId: id, by: 2, verdict: 'yes' });

  const res = await app.inject({ method: 'GET', url: '/api/agent/digest?token=t-agent' });
  const body = res.json();

  assert.equal(body.feedback.length, 1);
  assert.equal(body.feedback[0].by_name, 'Philipp');
  assert.equal(body.feedback[0].title, 'Feedback Villa');
  assert.equal(body.feedback[0].applied, 0);

  assert.equal(body.viewings.length, 1);
  assert.equal(body.viewings[0].by_name, 'Abigail');
  assert.equal(body.viewings[0].verdict, 'yes');
  assert.equal(body.viewings[0].title, 'Feedback Villa');
});

test('digest: size stays under 40 KB even with 60 flagged rows and long titles', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const longTitle = `Extremely Long Templated Bali Home Immo Villa Title ${'x'.repeat(700)}`;
  for (let i = 0; i < 60; i += 1) {
    insertListing(db, { title: `${longTitle} #${i}`, flagged: 1, fit_score: 90, description: 'y'.repeat(500) });
  }

  const res = await app.inject({ method: 'GET', url: '/api/agent/digest?token=t-agent' });
  assert.equal(res.statusCode, 200);
  const bytes = Buffer.byteLength(res.body, 'utf8');
  assert.ok(bytes < 40 * 1024, `digest body was ${bytes} bytes`);
  const body = res.json();
  assert.ok(body.flagged.length <= 40, 'flagged capped at 40');
});

// ---------------------------------------------------------------------------
// note
// ---------------------------------------------------------------------------

test('note: inserts and rejects text over 2000 chars', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const ok = await app.inject({ method: 'GET', url: `/api/agent/note?token=t-agent&text=${encodeURIComponent('Two strong candidates today.')}` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().ok, true);
  const row = db.prepare('SELECT * FROM agent_notes WHERE id = ?').get(ok.json().id);
  assert.equal(row.text, 'Two strong candidates today.');
  assert.equal(row.date, nowIso().slice(0, 10));

  const tooLong = await app.inject({ method: 'GET', url: `/api/agent/note?token=t-agent&text=${encodeURIComponent('a'.repeat(2001))}` });
  assert.equal(tooLong.statusCode, 400);

  const empty = await app.inject({ method: 'GET', url: '/api/agent/note?token=t-agent' });
  assert.equal(empty.statusCode, 400);
});

// ---------------------------------------------------------------------------
// inbox
// ---------------------------------------------------------------------------

test('inbox: inserts, dedupes on URL, rejects a non-URL', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const url = encodeURIComponent('https://bali-home-immo.com/listing-9001');
  const first = await app.inject({ method: 'GET', url: `/api/agent/inbox?token=t-agent&url=${url}&note=from+the+group+chat` });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().ok, true);
  assert.equal(first.json().existing, undefined);

  const dupe = await app.inject({ method: 'GET', url: `/api/agent/inbox?token=t-agent&url=${url}` });
  assert.equal(dupe.statusCode, 200);
  assert.equal(dupe.json().existing, true);
  assert.equal(dupe.json().id, first.json().id);

  const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(first.json().id);
  assert.equal(row.by, 'agent');
  assert.equal(row.status, 'pending');

  const bad = await app.inject({ method: 'GET', url: '/api/agent/inbox?token=t-agent&url=not-a-url' });
  assert.equal(bad.statusCode, 400);
});

// ---------------------------------------------------------------------------
// weights
// ---------------------------------------------------------------------------

test('weights: valid set rescoring, missing keys keep current, invalid key/value -> 400, no `set` -> current', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const current = await app.inject({ method: 'GET', url: '/api/agent/weights?token=t-agent' });
  assert.deepEqual(current.json().weights, DEFAULT_WEIGHTS, 'no `set` returns current weights');

  const id = insertListing(db, { pool: 1, view: 'ocean' });

  const set = encodeURIComponent(JSON.stringify({ pool: 20 }));
  const res = await app.inject({ method: 'GET', url: `/api/agent/weights?token=t-agent&set=${set}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().weights.pool, 20);
  assert.equal(res.json().weights.garden, DEFAULT_WEIGHTS.garden, 'unspecified keys keep their current value');

  const configAfter = getConfig(db);
  const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  const expected = scoreRow(row, configAfter).fit_score;
  assert.equal(row.fit_score, expected, 'rescoreAll actually applied the new weight');

  const learnRun = db.prepare("SELECT * FROM runs WHERE kind = 'learn' ORDER BY id DESC LIMIT 1").get();
  assert.ok(learnRun, 'a learn run was written');
  const changes = JSON.parse(learnRun.weight_changes);
  assert.deepEqual(changes, [{ feature: 'pool', from: 12, to: 20, because: 'agent' }]);

  const badKey = encodeURIComponent(JSON.stringify({ not_a_feature: 5 }));
  const badKeyRes = await app.inject({ method: 'GET', url: `/api/agent/weights?token=t-agent&set=${badKey}` });
  assert.equal(badKeyRes.statusCode, 400);

  const outOfRange = encodeURIComponent(JSON.stringify({ pool: 25 }));
  const outOfRangeRes = await app.inject({ method: 'GET', url: `/api/agent/weights?token=t-agent&set=${outOfRange}` });
  assert.equal(outOfRangeRes.statusCode, 400);

  // A rejected `set` must not have touched the stored config.
  const unchanged = await app.inject({ method: 'GET', url: '/api/agent/weights?token=t-agent' });
  assert.equal(unchanged.json().weights.pool, 20);
});

// ---------------------------------------------------------------------------
// feedback-applied
// ---------------------------------------------------------------------------

test('feedback-applied: marks a row applied and 404s on an unknown id', async (t) => {
  const db = tmpDb();
  seedUsers(db, ENV);
  const app = await buildServer({ db, env: ENV });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const propId = insertListing(db);
  const feedbackId = insertFeedback(db, { propertyId: propId, by: 1, text: 'loved the garden' });

  const res = await app.inject({
    method: 'GET',
    url: `/api/agent/feedback-applied?token=t-agent&id=${feedbackId}&note=${encodeURIComponent('raised garden weight')}`,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);

  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(feedbackId);
  assert.equal(row.applied, 1);
  assert.equal(row.applied_note, 'raised garden weight');

  const missing = await app.inject({ method: 'GET', url: '/api/agent/feedback-applied?token=t-agent&id=999999' });
  assert.equal(missing.statusCode, 404);
});

// ---------------------------------------------------------------------------
// rate limit
// ---------------------------------------------------------------------------

test('rate limit: 429 after the configured number of requests, per token', async (t) => {
  const db = tmpDb();
  const app = Fastify();
  const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
  await app.register(agentRoutes, { db, env: ENV, rateLimiter: limiter });
  t.after(async () => {
    await app.close();
    db.close();
  });

  for (let i = 0; i < 3; i += 1) {
    const res = await app.inject({ method: 'GET', url: '/api/agent/weights?token=t-agent' });
    assert.equal(res.statusCode, 200, `request ${i + 1} should succeed`);
  }
  const blocked = await app.inject({ method: 'GET', url: '/api/agent/weights?token=t-agent' });
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error, 'rate_limited');
  assert.ok(blocked.json().retry_after_s > 0);
});
