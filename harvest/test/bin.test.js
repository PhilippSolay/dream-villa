// Tests for the node side of the kit: the date parser the importers share and the nightly queue.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parseDate, sourceIdFor } from '../bin/lib.mjs';
import { buildQueue, lastDoneMap, addDays, localDate } from '../bin/state.mjs';

const exported = new Date('2026-10-06T12:00:00Z');

test('parseDate resolves relative times against the export time, not now', () => {
  assert.equal(parseDate('6d', exported), '2026-09-30T12:00:00.000Z');
  assert.equal(parseDate('3h', exported), '2026-10-06T09:00:00.000Z');
  assert.equal(parseDate('2w', exported), '2026-09-22T12:00:00.000Z');
  assert.ok(parseDate('Yesterday at 8:15 PM', exported).startsWith('2026-10-0'));
  assert.equal(new Date(parseDate('September 12, 2025 at 9:00 AM', exported)).getFullYear(), 2025);
  // no year and later than the export → last year
  assert.equal(new Date(parseDate('December 24', exported)).getFullYear(), 2025);
  assert.equal(parseDate('just now', exported), null);
});

test('sourceIdFor maps a group to its registered source, else fb-<id>', () => {
  const sources = [{ id: 'seseh-pererenan-villas', url: 'https://www.facebook.com/groups/971973697615659/' }];
  assert.equal(sourceIdFor(sources, '971973697615659'), 'seseh-pererenan-villas');
  assert.equal(sourceIdFor(sources, '123'), 'fb-123');
});

test('addDays and localDate', () => {
  assert.equal(addDays('2026-10-01', -2), '2026-09-29');
  assert.equal(addDays('2026-10-06', -30), '2026-09-06');
  assert.equal(localDate(new Date('2026-10-05T17:00:00Z'), 'Asia/Makassar'), '2026-10-06');
});

test('lastDoneMap reads the new and the old state shape', () => {
  assert.deepEqual(lastDoneMap({ last_done: { a: '2026-10-01' } }), { a: '2026-10-01' });
  assert.deepEqual(lastDoneMap({ groups: [{ id: 'a', last_done: '2026-10-01' }, { id: 'b', last_done: null }] }), { a: '2026-10-01' });
  assert.deepEqual(lastDoneMap(null), {});
});

test('buildQueue: incremental groups first, then first harvests; deferred and skipped never run', () => {
  const doc = { groups: [
    { id: 'p1', name: 'P1', status: 'pending' },
    { id: 'a1', name: 'A1', status: 'active' },
    { id: 'd1', name: 'D1', status: 'deferred' },
    { id: 's1', name: 'S1', status: 'skipped' },
    { id: 'a2', name: 'A2', status: 'active' },
  ] };
  const q = buildQueue(doc, { a1: '2026-10-04', d1: '2026-10-04' }, '2026-10-06');
  assert.deepEqual(q.map((r) => [r.n, r.id, r.mode]), [[1, 'a1', 'incremental'], [2, 'p1', 'first'], [3, 'a2', 'first']]);
  assert.deepEqual(q[0].options, { cutoff: '2026-10-02', minRounds: 6, minPosts: 0 });
  assert.deepEqual(q[1].options, { cutoff: '2026-09-06' });
});

test('groups.json: every group has id, name, a facebook url, a known region and status, and a reason when not harvested', () => {
  const doc = JSON.parse(fs.readFileSync(new URL('../groups.json', import.meta.url), 'utf8'));
  const ids = new Set();
  for (const g of doc.groups) {
    assert.ok(g.id && g.name, JSON.stringify(g));
    assert.ok(!ids.has(g.id), 'duplicate ' + g.id); ids.add(g.id);
    assert.equal(g.url, 'https://www.facebook.com/groups/' + g.id);
    assert.ok(['west', 'bukit', 'ubud', 'bali'].includes(g.region), g.id);
    assert.ok(['active', 'pending', 'deferred', 'skipped'].includes(g.status), g.id);
    if (g.status === 'deferred' || g.status === 'skipped') assert.ok(g.reason, 'reason for ' + g.id);
    assert.ok(!('last_done' in g), 'no harvest state in groups.json');
  }
});
