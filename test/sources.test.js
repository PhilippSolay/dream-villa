// Intake sources (config.sources) — seeding, the round-trip through src/sources.js,
// the API on the Agent page, the `[src:<id>]` inbox convention, and the one thing that
// changes behaviour: a disabled source is skipped by the daily run.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, getConfig, setConfig, nowIso } from '../src/db.js';
import { seedUsers } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import { upsertProperty, rescoreAll } from '../src/scrape/store.js';
import { runScrape } from '../src/scrape/index.js';
import { ADAPTER_IDS } from '../src/scrape/adapters/index.js';
import {
  SOURCE_KINDS, SKIPPED_SCRAPERS, slugify, listSources, getSource, upsertSource,
  setSourceEnabled, disabledSourceIds, sourceStats, sourcesWithStats,
  noteWithSource, sourceIdFromNote, noteWithoutSource,
} from '../src/sources.js';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-sources-'));
  const db = openDb(path.join(dir, 'villa.db'));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

/** A logged-in app over a fresh db, like test/api.test.js. */
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-sources-api-'));
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
  const rawCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie).split(';')[0];
  const call = (opts) => app.inject({ ...opts, headers: { cookie, ...(opts.headers || {}) } });
  return { db, app, env, call };
}

// ---------------------------------------------------------------------------
// seeding
// ---------------------------------------------------------------------------

test('listSources seeds every adapter plus the six skipped sites on first read', (t) => {
  const db = tmpDb(t);
  assert.equal(getConfig(db).sources, undefined);

  const sources = listSources(db);
  const ids = sources.map((s) => s.id);
  assert.deepEqual(ids.slice(0, ADAPTER_IDS.length), ADAPTER_IDS);
  assert.deepEqual(
    ids.slice(ADAPTER_IDS.length),
    ['exotiq', 'balivillahub', 'olx', 'lamudi', '99co', 'fbmarketplace']
  );
  assert.equal(sources.length, ADAPTER_IDS.length + SKIPPED_SCRAPERS.length);
  assert.ok(sources.every((s) => s.kind === 'scraper'));

  const bhi = sources.find((s) => s.id === 'bhi');
  assert.equal(bhi.enabled, true);
  assert.equal(bhi.name, 'Bali Home Immo');
  assert.equal(bhi.url, 'https://bali-home-immo.com');
  assert.equal(bhi.notes, null);
  assert.equal(bhi.created_by, 'system');
  assert.ok(bhi.created_at);

  // Every skipped site is off and says why, in one line from its adapters/*.md.
  for (const skipped of SKIPPED_SCRAPERS) {
    const row = sources.find((s) => s.id === skipped.id);
    assert.equal(row.enabled, false, `${skipped.id} must be seeded disabled`);
    assert.match(row.notes, /^(Not implemented|Skipped)/);
    assert.match(row.notes, /adapters\//);
  }

  // Persisted, and stable across reads.
  assert.deepEqual(listSources(db).map((s) => s.id), ids);
  assert.equal(getConfig(db).sources.length, ids.length);
});

test('listSources adds an adapter registered after the list was seeded, leaving the rest alone', (t) => {
  const db = tmpDb(t);
  const seeded = listSources(db);
  // A list stored before `livuma` existed, with one scraper already turned off by hand.
  const old = seeded
    .filter((s) => s.id !== 'livuma')
    .map((s) => (s.id === 'rumah123' ? { ...s, enabled: false } : s));
  setConfig(db, 'sources', old);

  const ids = listSources(db).map((s) => s.id);
  for (const id of ADAPTER_IDS) assert.ok(ids.includes(id), `${id} listed`);
  // Joined right after the last registry scraper, before the skipped sites.
  assert.equal(ids.indexOf('livuma'), ids.indexOf('rumah123') + 1);
  assert.equal(ids.indexOf('exotiq'), ids.indexOf('livuma') + 1);

  const livuma = getSource(db, 'livuma');
  assert.equal(livuma.enabled, true);
  assert.equal(livuma.kind, 'scraper');
  assert.equal(livuma.url, 'https://livuma.com');
  assert.equal(getSource(db, 'rumah123').enabled, false, 'a stored entry is never touched');
  assert.equal(getConfig(db).sources.length, seeded.length, 'persisted');
});

test('slugify — a non-scraper id is its name', () => {
  assert.equal(slugify('Bali Rentals Canggu'), 'bali-rentals-canggu');
  assert.equal(slugify('  Abigaïl’s WA group! '), 'abigail-s-wa-group');
  assert.equal(slugify('99.co'), '99-co');
});

// ---------------------------------------------------------------------------
// upsert / patch
// ---------------------------------------------------------------------------

test('upsertSource creates a manual channel, then updates it in place', (t) => {
  const db = tmpDb(t);

  const created = upsertSource(db, {
    kind: 'facebook_group', name: 'Bali Rentals Canggu',
    url: 'https://facebook.com/groups/balirentals', notes: 'Abigaïl checks it on Sundays',
  }, { name: 'Philipp' });

  assert.equal(created.id, 'bali-rentals-canggu');
  assert.equal(created.kind, 'facebook_group');
  assert.equal(created.enabled, true);
  assert.equal(created.archived, false);
  assert.equal(created.created_by, 'Philipp');
  assert.equal(created.contact_id, null);

  const renamed = upsertSource(db, { id: created.id, name: 'Bali Rentals West', notes: null }, { name: 'Abigail' });
  assert.equal(renamed.id, 'bali-rentals-canggu', 'the id never follows the name');
  assert.equal(renamed.name, 'Bali Rentals West');
  assert.equal(renamed.notes, null);
  assert.equal(renamed.url, 'https://facebook.com/groups/balirentals', 'untouched fields survive');
  assert.equal(renamed.created_by, 'Philipp', 'created_by belongs to whoever created it');
  assert.ok(renamed.updated_at >= created.updated_at);

  assert.equal(listSources(db).filter((s) => s.id === created.id).length, 1);
});

test('upsertSource validates kind, name and scraper ids', (t) => {
  const db = tmpDb(t);
  assert.throws(() => upsertSource(db, { kind: 'telegram', name: 'X' }), /kind must be one of/);
  assert.throws(() => upsertSource(db, { kind: 'agent' }), /name is required/);
  assert.throws(() => upsertSource(db, { kind: 'scraper', name: 'Made Up Site' }), /adapter in the registry/);
  assert.throws(() => upsertSource(db, { id: 'bhi', kind: 'website' }), /keeps its kind/);
  // Known kinds all pass.
  for (const kind of SOURCE_KINDS.filter((k) => k !== 'scraper')) {
    assert.equal(upsertSource(db, { kind, name: `Chan ${kind}` }).kind, kind);
  }
});

test('setSourceEnabled toggles one source and disabledSourceIds reports it', (t) => {
  const db = tmpDb(t);
  assert.deepEqual(
    [...disabledSourceIds(db)].sort(),
    ['99co', 'balivillahub', 'exotiq', 'fbmarketplace', 'lamudi', 'olx']
  );

  const off = setSourceEnabled(db, 'kibarer', false, { name: 'Philipp' });
  assert.equal(off.enabled, false);
  assert.ok(disabledSourceIds(db).has('kibarer'));

  assert.equal(setSourceEnabled(db, 'kibarer', true).enabled, true);
  assert.equal(disabledSourceIds(db).has('kibarer'), false);
  assert.equal(setSourceEnabled(db, 'nope', false), null);
});

test('archived sources stay in config but drop out of the list', (t) => {
  const db = tmpDb(t);
  upsertSource(db, { kind: 'agent', name: 'Wayan' });
  upsertSource(db, { id: 'wayan', archived: true });
  assert.ok(getSource(db, 'wayan'), 'never deleted (CLAUDE.md)');
  assert.equal(sourcesWithStats(db).some((s) => s.id === 'wayan'), false);
  assert.equal(sourcesWithStats(db, { includeArchived: true }).some((s) => s.id === 'wayan'), true);
});

// ---------------------------------------------------------------------------
// the inbox note convention
// ---------------------------------------------------------------------------

test('noteWithSource / sourceIdFromNote round-trip', () => {
  assert.equal(noteWithSource('from Ketut', 'wa-dream-house'), '[src:wa-dream-house] from Ketut');
  assert.equal(noteWithSource(null, 'wa-dream-house'), '[src:wa-dream-house]');
  assert.equal(noteWithSource('plain', null), 'plain');
  assert.equal(noteWithSource(null, null), null);

  assert.equal(sourceIdFromNote('[src:wa-dream-house] from Ketut'), 'wa-dream-house');
  assert.equal(sourceIdFromNote('no prefix here'), null);
  assert.equal(noteWithoutSource('[src:wa-dream-house] from Ketut'), 'from Ketut');
  assert.equal(noteWithoutSource('[src:wa-dream-house]'), null);
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

test('sourceStats counts listings per adapter id and inbox rows per channel', (t) => {
  const db = tmpDb(t);
  const now = '2026-09-18T00:00:00.000Z';
  const base = { term: 'monthly', availability: 'available', first_seen: now };

  upsertProperty(db, {
    ...base, key: 'bhi:A', ref: 'A', source: 'bhi', url: 'https://bhi.test/a',
    title: 'Ocean View Villa in Cemagi', area: 'cemagi', bedrooms: 2, extra_rooms: 1,
    price_month_idr: 40_000_000, pool: 1, last_seen: now,
  }, { now });
  upsertProperty(db, {
    ...base, key: 'bhi:B', ref: 'B', source: 'bhi', url: 'https://bhi.test/b',
    title: 'Huge Compound Ungasan', area: 'ungasan', bedrooms: 4, price_month_idr: 70_000_000,
    last_seen: '2026-09-17T00:00:00.000Z',
  }, { now: '2026-09-17T00:00:00.000Z' });
  upsertProperty(db, {
    ...base, key: 'kibarer:C', ref: 'C', source: 'kibarer', url: 'https://kib.test/c',
    title: 'Quiet House Seseh', area: 'seseh', bedrooms: 3, extra_rooms: 0,
    price_month_idr: 30_000_000, last_seen: now,
  }, { now });
  rescoreAll(db);

  upsertSource(db, { kind: 'facebook_group', name: 'Bali Rentals Canggu' });
  const ins = db.prepare('INSERT INTO inbox (url, "by", note, status, created_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('https://fb.test/1', 'Philipp', '[src:bali-rentals-canggu] nice one', 'pending', now);
  ins.run('https://fb.test/2', 'Philipp', '[src:bali-rentals-canggu] seen it | → #7', 'done', now);
  ins.run('https://x.test/3', 'Philipp', null, 'pending', now);

  const stats = sourceStats(db);
  assert.equal(stats.bhi.listings, 2);
  assert.equal(stats.bhi.in_filter, 1, 'the 4BR at 70 M is market, not in filter');
  assert.equal(stats.bhi.last_seen, now);
  assert.equal(stats.kibarer.listings, 1);
  assert.equal(stats.kibarer.in_filter, 1);
  assert.equal(stats.rumah123.listings, 0);
  assert.equal(stats.rumah123.last_seen, null);

  assert.equal(stats['bali-rentals-canggu'].inbox_pending, 1);
  assert.equal(stats['bali-rentals-canggu'].inbox_done, 1);
  assert.equal(stats['bali-rentals-canggu'].listings, 0);
  assert.equal(stats.bhi.inbox_pending, 0, 'an unprefixed inbox row belongs to no channel');

  const merged = sourcesWithStats(db).find((s) => s.id === 'bhi');
  assert.equal(merged.stats.listings, 2);
  assert.equal(merged.enabled, true);
});

// ---------------------------------------------------------------------------
// the scraper honours the switch
// ---------------------------------------------------------------------------

const PARTIAL = {
  source: 'stub', ref: 'S1', url: 'https://stub.test/one-s1',
  title: 'Modern 2 Bedroom Villa in Cemagi Beachside',
  location: 'Cemagi / Seseh - Beach Side', category: 'monthly/seseh',
  bedrooms: 2, price_month_idr: 40_000_000, term: 'monthly',
};

function stubAdapter(id = 'stub') {
  return {
    id,
    name: `Stub ${id}`,
    base: `https://${id}.test`,
    async *list() {
      yield { ...PARTIAL, source: id, url: `https://${id}.test/one-s1` };
    },
    async detail() {
      return null;
    },
  };
}

/** Put a stub into config.sources; upsertSource refuses to invent scraper ids. */
function registerStub(db, id, enabled) {
  const now = nowIso();
  setConfig(db, 'sources', [
    ...listSources(db),
    { id, kind: 'scraper', name: `Stub ${id}`, url: `https://${id}.test`, enabled, notes: null,
      contact_id: null, archived: false, created_by: 'test', created_at: now, updated_at: now },
  ]);
}

const RUN = { images: false, detail: false, now: '2026-09-18T00:00:00.000Z', log: () => {} };

test('runScrape skips a source whose switch is off', async (t) => {
  const db = tmpDb(t);
  registerStub(db, 'stub', false);

  const summary = await runScrape({ db, adapters: [stubAdapter()], ...RUN });

  assert.deepEqual(summary.sources, []);
  assert.deepEqual(summary.skipped_sources, ['stub']);
  assert.ok(summary.notes.some((n) => n.includes('disabled sources: stub')));
  assert.equal(summary.seen, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM properties').get().n, 0);
  // The run still closes cleanly (no `IN ()` with an empty source list).
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs WHERE finished_at IS NOT NULL').get().n, 1);
});

test('an enabled source, and an unknown one, still run', async (t) => {
  const db = tmpDb(t);
  registerStub(db, 'stub', true);

  const summary = await runScrape({ db, adapters: [stubAdapter(), stubAdapter('nosuchentry')], ...RUN });
  assert.deepEqual(summary.sources, ['stub', 'nosuchentry']);
  assert.deepEqual(summary.skipped_sources, []);
  assert.equal(summary.seen, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM properties').get().n, 2);
});

test('naming the source explicitly beats the switch', async (t) => {
  const db = tmpDb(t);
  registerStub(db, 'stub', false);

  const summary = await runScrape({ db, adapters: [stubAdapter()], sources: 'stub', ...RUN });
  assert.deepEqual(summary.sources, ['stub']);
  assert.deepEqual(summary.skipped_sources, []);
  assert.equal(summary.seen, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM properties').get().n, 1);
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

test('GET /api/sources needs a session and returns the seeded list with stats', async (t) => {
  const { app, call } = await setup(t);

  const anon = await app.inject({ method: 'GET', url: '/api/sources' });
  assert.equal(anon.statusCode, 401);

  const res = await call({ method: 'GET', url: '/api/sources' });
  assert.equal(res.statusCode, 200);
  const { sources } = res.json();
  assert.equal(sources.length, ADAPTER_IDS.length + SKIPPED_SCRAPERS.length);
  const bhi = sources.find((s) => s.id === 'bhi');
  assert.equal(bhi.kind, 'scraper');
  assert.deepEqual(bhi.stats, {
    listings: 0, in_filter: 0, flagged: 0, last_seen: null, inbox_pending: 0, inbox_done: 0,
  });
  assert.equal(sources.find((s) => s.id === 'olx').enabled, false);
});

test('POST /api/sources creates a channel; PATCH edits and disables it', async (t) => {
  const { db, call } = await setup(t);

  const created = await call({
    method: 'POST', url: '/api/sources',
    payload: { kind: 'whatsapp_group', name: 'Dream House WA', notes: 'Abigaïl forwards here' },
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().id, 'dream-house-wa');
  assert.equal(created.json().created_by, 'Philipp');

  const patched = await call({
    method: 'PATCH', url: '/api/sources/dream-house-wa',
    payload: { notes: 'Ketut posts most Fridays', url: 'https://chat.whatsapp.com/abc' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().notes, 'Ketut posts most Fridays');
  assert.equal(patched.json().name, 'Dream House WA');

  const off = await call({ method: 'PATCH', url: '/api/sources/rumah123', payload: { enabled: false } });
  assert.equal(off.statusCode, 200);
  assert.equal(off.json().enabled, false);
  assert.ok(disabledSourceIds(db).has('rumah123'));

  assert.equal((await call({ method: 'PATCH', url: '/api/sources/nope', payload: { enabled: false } })).statusCode, 404);
  assert.equal(
    (await call({ method: 'POST', url: '/api/sources', payload: { kind: 'telegram', name: 'X' } })).statusCode,
    400
  );
  const dupe = await call({ method: 'POST', url: '/api/sources', payload: { kind: 'agent', name: 'Dream House WA' } });
  assert.equal(dupe.statusCode, 400);
  assert.match(dupe.json().detail, /already exists/);

  // No DELETE — disable or archive instead (CLAUDE.md).
  assert.equal((await call({ method: 'DELETE', url: '/api/sources/dream-house-wa' })).statusCode, 404);
});

test('POST /api/inbox tags the note with the source it came from', async (t) => {
  const { db, call } = await setup(t);
  await call({ method: 'POST', url: '/api/sources', payload: { kind: 'facebook_group', name: 'Bali Rentals Canggu' } });

  const ok = await call({
    method: 'POST', url: '/api/inbox',
    payload: { url: 'https://fb.test/post/1', note: 'looks quiet', source_id: 'bali-rentals-canggu' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().source_id, 'bali-rentals-canggu');
  const row = db.prepare('SELECT * FROM inbox WHERE id = ?').get(ok.json().id);
  assert.equal(row.note, '[src:bali-rentals-canggu] looks quiet');
  assert.equal(row.by, 'Philipp');

  // No note, still tagged; no source, unchanged behaviour.
  const bare = await call({
    method: 'POST', url: '/api/inbox',
    payload: { url: 'https://fb.test/post/2', source_id: 'bali-rentals-canggu' },
  });
  assert.equal(db.prepare('SELECT note FROM inbox WHERE id = ?').get(bare.json().id).note, '[src:bali-rentals-canggu]');

  const plain = await call({ method: 'POST', url: '/api/inbox', payload: { url: 'https://x.test/3', note: 'hi' } });
  assert.equal(db.prepare('SELECT note FROM inbox WHERE id = ?').get(plain.json().id).note, 'hi');

  const bad = await call({
    method: 'POST', url: '/api/inbox',
    payload: { url: 'https://x.test/4', source_id: 'not-a-source' },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().detail, /unknown source/);

  const stats = (await call({ method: 'GET', url: '/api/sources' })).json().sources
    .find((s) => s.id === 'bali-rentals-canggu').stats;
  assert.equal(stats.inbox_pending, 2);
});
