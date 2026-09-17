import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, getConfig } from '../src/db.js';
import { upsertProperty, rescoreAll } from '../src/scrape/store.js';
import { runLearn, extractReasonsKeyword, REASON_KEYWORDS } from '../src/scrape/learn.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-learn-'));
  const file = path.join(dir, 'villa.db');
  const db = openDb(file);
  return { db, dir };
}

function cleanup({ db, dir }) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A property that clears the hard filters (in_filter) and scores ~100 with default
 *  weights: every boolean feature true, ocean view, furnished quality 3, beach <= 1km. */
function strongRow(overrides = {}) {
  return {
    key: 'bhi:RF1', ref: 'RF1', source: 'bhi', url: 'https://bali-home-immo.com/x-rf1',
    title: 'Modern 2 Bedroom Villa', area: 'cemagi', sub_area: 'Beach Side',
    bedrooms: 2, extra_rooms: 0, price_month_idr: 40_000_000,
    beach_km: 0.5, style: 'modern', availability: 'available',
    pool: 1, garden: 1, view: 'ocean', joglo: 1, aircon: 1, kitchen_full: 1,
    workspace: 1, living_open: 1, airy: 1, furnished: 1, furniture_quality: 3,
    first_seen: '2026-09-17T00:00:00.000Z',
    ...overrides,
  };
}

function insertFeedback(db, { property_id = null, text, by = 1 }) {
  return db
    .prepare('INSERT INTO feedback (property_id, by, text, applied) VALUES (?, ?, ?, 0)')
    .run(property_id, by, text).lastInsertRowid;
}

function insertViewing(db, { property_id, by = 1, date = '2026-09-17', quiet = null, privacy = null }) {
  return db
    .prepare('INSERT INTO viewings (property_id, by, date, quiet, privacy) VALUES (?, ?, ?, ?, ?)')
    .run(property_id, by, date, quiet, privacy).lastInsertRowid;
}

// ---------------------------------------------------------------------------
// extractReasonsKeyword (pure)
// ---------------------------------------------------------------------------

test('extractReasonsKeyword: matches quiet(negative) + living_open(negative), no duplicates', () => {
  const reasons = extractReasonsKeyword('very noisy road and the living room was cramped');
  assert.deepEqual(
    reasons.sort((a, b) => a.feature.localeCompare(b.feature)),
    [
      { feature: 'living_open', polarity: 'negative' },
      { feature: 'quiet', polarity: 'negative' },
    ]
  );
});

test('extractReasonsKeyword: positive garden reason', () => {
  assert.deepEqual(extractReasonsKeyword('loved the garden'), [{ feature: 'garden', polarity: 'positive' }]);
});

test('extractReasonsKeyword: far from beach is now a WEIGHT_KEYS feature (beach), negative', () => {
  assert.deepEqual(extractReasonsKeyword('too far from the beach'), [{ feature: 'beach', polarity: 'negative' }]);
});

test('REASON_KEYWORDS: every non-quiet/privacy feature is a WEIGHT_KEYS entry', async () => {
  const { WEIGHT_KEYS } = await import('../src/defaults.js');
  for (const { feature } of REASON_KEYWORDS) {
    if (feature === 'quiet' || feature === 'privacy') continue;
    assert.ok(WEIGHT_KEYS.includes(feature), `${feature} should be a weight key`);
  }
  assert.ok(WEIGHT_KEYS.includes('beach'), 'beach is a soft-scored weight key per the 2026-09-17 contract change');
});

// ---------------------------------------------------------------------------
// runLearn — feedback
// ---------------------------------------------------------------------------

test('runLearn: negative feedback raises living_open by 2, notes quiet, flags the property quiet_low', async () => {
  const ctx = tmpDb();
  const { db } = ctx;
  const { id: propertyId } = upsertProperty(db, strongRow());
  rescoreAll(db);

  const before = getConfig(db).weights.living_open;
  assert.equal(before, 15);

  insertFeedback(db, { property_id: propertyId, text: 'very noisy road and the living room was cramped' });

  const result = await runLearn(db, { now: '2026-09-17T07:00:00.000Z' });

  assert.equal(result.feedback_applied, 1);
  assert.equal(getConfig(db).weights.living_open, 17);
  const change = result.weight_changes.find((c) => c.feature === 'living_open');
  assert.ok(change, 'living_open weight_change recorded');
  assert.equal(change.from, 15);
  assert.equal(change.to, 17);

  const feedbackRow = db.prepare('SELECT * FROM feedback WHERE property_id = ?').get(propertyId);
  assert.equal(feedbackRow.applied, 1);
  const note = JSON.parse(feedbackRow.applied_note);
  assert.ok(note.some((n) => n.feature === 'quiet' && n.polarity === 'negative'), 'applied_note mentions quiet');

  const property = db.prepare('SELECT red_flags FROM properties WHERE id = ?').get(propertyId);
  assert.ok(JSON.parse(property.red_flags).includes('quiet_low'));
  assert.deepEqual(result.red_flags_added, [{ property_id: propertyId, flag: 'quiet_low' }]);

  assert.ok(result.run_id != null);
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(result.run_id);
  assert.equal(run.kind, 'learn');
  assert.ok(JSON.parse(run.weight_changes).length > 0);

  cleanup(ctx);
});

test('runLearn: positive feedback raises garden by 1', async () => {
  const ctx = tmpDb();
  const { db } = ctx;
  const { id: propertyId } = upsertProperty(db, strongRow());
  rescoreAll(db);

  insertFeedback(db, { property_id: propertyId, text: 'loved the garden' });
  const result = await runLearn(db);

  assert.equal(getConfig(db).weights.garden, 11);
  const change = result.weight_changes.find((c) => c.feature === 'garden');
  assert.equal(change.from, 10);
  assert.equal(change.to, 11);

  cleanup(ctx);
});

test('runLearn: weight increases cap at 20', async () => {
  const ctx = tmpDb();
  const { db } = ctx;
  const { id: propertyId } = upsertProperty(db, strongRow());
  rescoreAll(db);

  const config = getConfig(db);
  const { setConfig } = await import('../src/db.js');
  setConfig(db, 'weights', { ...config.weights, living_open: 19 });

  insertFeedback(db, { property_id: propertyId, text: 'the living room was so cramped' });
  const result = await runLearn(db);

  assert.equal(getConfig(db).weights.living_open, 20, 'capped at 20, not 21');
  assert.equal(result.weight_changes.find((c) => c.feature === 'living_open').to, 20);

  cleanup(ctx);
});

// ---------------------------------------------------------------------------
// runLearn — viewings
// ---------------------------------------------------------------------------

test('runLearn: a viewing with quiet=2 adds quiet_low and drops flagged after rescore', async () => {
  const ctx = tmpDb();
  const { db } = ctx;
  const { id: propertyId } = upsertProperty(db, strongRow());
  rescoreAll(db);

  const before = db.prepare('SELECT fit_score, flagged, scope FROM properties WHERE id = ?').get(propertyId);
  assert.equal(before.scope, 'in_filter');
  assert.ok(before.fit_score >= 65, `fit_score ${before.fit_score} should be >= 65`);
  assert.equal(before.flagged, 1);

  insertViewing(db, { property_id: propertyId, quiet: 2, privacy: 5 });

  const result = await runLearn(db);

  const after = db.prepare('SELECT flagged, red_flags FROM properties WHERE id = ?').get(propertyId);
  assert.ok(JSON.parse(after.red_flags).includes('quiet_low'));
  assert.equal(after.flagged, 0, 'flagged drops once a red flag is present');
  assert.deepEqual(result.red_flags_added, [{ property_id: propertyId, flag: 'quiet_low' }]);

  assert.equal(getConfig(db).learn_last_viewing_id, 1);

  cleanup(ctx);
});

test('runLearn: viewings already processed (learn_last_viewing_id) are not reprocessed', async () => {
  const ctx = tmpDb();
  const { db } = ctx;
  const { id: propertyId } = upsertProperty(db, strongRow());
  rescoreAll(db);

  insertViewing(db, { property_id: propertyId, quiet: 2 });
  await runLearn(db);

  // Manually clear the flag to prove a second pass does not re-add it from the same viewing.
  db.prepare("UPDATE properties SET red_flags = '[]' WHERE id = ?").run(propertyId);
  rescoreAll(db);

  const second = await runLearn(db);
  assert.equal(second.red_flags_added.length, 0);
  const row = db.prepare('SELECT red_flags FROM properties WHERE id = ?').get(propertyId);
  assert.deepEqual(JSON.parse(row.red_flags), []);

  cleanup(ctx);
});

// ---------------------------------------------------------------------------
// runLearn — pockets
// ---------------------------------------------------------------------------

test('runLearn: two rejected properties in the same sub_area add a low_priority_pocket', async () => {
  const ctx = tmpDb();
  const { db } = ctx;
  upsertProperty(db, strongRow({ key: 'bhi:P1', sub_area: 'Tumbak Bayuh', status: 'rejected' }));
  upsertProperty(db, strongRow({ key: 'bhi:P2', sub_area: 'tumbak bayuh', status: 'rejected' }));
  rescoreAll(db);

  const result = await runLearn(db);

  assert.deepEqual(result.pockets_added, ['Tumbak Bayuh']);
  assert.ok(getConfig(db).low_priority_pockets.includes('Tumbak Bayuh'));

  cleanup(ctx);
});

// ---------------------------------------------------------------------------
// runLearn — run bookkeeping
// ---------------------------------------------------------------------------

test('runLearn: a second run with nothing new returns run_id null', async () => {
  const ctx = tmpDb();
  const { db } = ctx;
  const { id: propertyId } = upsertProperty(db, strongRow());
  rescoreAll(db);
  insertFeedback(db, { property_id: propertyId, text: 'loved the garden' });

  const first = await runLearn(db);
  assert.ok(first.run_id != null);

  const second = await runLearn(db);
  assert.equal(second.run_id, null);
  assert.equal(second.feedback_applied, 0);
  assert.deepEqual(second.weight_changes, []);
  assert.deepEqual(second.red_flags_added, []);
  assert.deepEqual(second.pockets_added, []);

  cleanup(ctx);
});

test('runLearn: no unapplied feedback, no new viewings, no pockets → run_id null from the start', async () => {
  const ctx = tmpDb();
  const { db } = ctx;
  upsertProperty(db, strongRow());
  rescoreAll(db);

  const result = await runLearn(db);
  assert.equal(result.run_id, null);
  assert.equal(result.feedback_applied, 0);

  cleanup(ctx);
});
