import test from 'node:test';
import assert from 'node:assert/strict';

import { STAGES, STAGE_ORDER, stageQuery, loadStageIds, nextStage, isStage } from '../public/lib/flow.js';
import { defaultFilters } from '../public/lib/filters.js';

const row = (over) => ({ id: 1, status: 'new', assessed: 'not_yet', counts: { ratings: 0 }, ratings: [], ...over });

test('stage order and lookups', () => {
  assert.deepEqual(STAGE_ORDER, ['sort', 'rate', 'contact', 'view']);
  assert.equal(nextStage('sort'), 'rate');
  assert.equal(nextStage('view'), null);
  assert.equal(isStage('rate'), true);
  assert.equal(isStage('toString'), false);
});

test('stageQuery forces status, hides removed, keeps the rest of the filters', () => {
  const q = new URLSearchParams(stageQuery('view', { ...defaultFilters(), area: ['seseh'], min: 20000000, status: ['offer'], removed: 'show' }));
  assert.equal(q.get('status'), 'contacted,viewing_booked');
  assert.equal(q.get('removed'), 'hide');
  assert.equal(q.get('area'), 'seseh');
  assert.equal(q.get('min'), '20000000');
  assert.equal(q.get('limit'), '500');
});

test('queues: who is waiting for each stage', () => {
  assert.equal(STAGES.sort.inQueue(row()), true);
  assert.equal(STAGES.sort.inQueue(row({ status: 'shortlist' })), false);
  assert.equal(STAGES.rate.inQueue(row({ status: 'shortlist' })), true);
  assert.equal(STAGES.rate.inQueue(row({ status: 'shortlist', counts: { ratings: 2 } })), false);
  assert.equal(STAGES.contact.inQueue(row({ status: 'shortlist', counts: { ratings: 2 } })), true);
  assert.equal(STAGES.view.inQueue(row({ status: 'viewing_booked' })), true);
  assert.equal(STAGES.view.inQueue(row({ status: 'viewed' })), false);
});

test('done: what lets the bar move on', () => {
  assert.equal(STAGES.sort.done(row()), false);
  assert.equal(STAGES.sort.done(row({ status: 'rejected' })), true);
  assert.equal(STAGES.rate.done(row({ status: 'shortlist', ratings: [{ feature: 'quiet' }] })), false);
  assert.equal(STAGES.rate.done(row({ status: 'shortlist', ratings: [{ feature: 'quiet' }, { feature: 'overall' }] })), true);
  assert.equal(STAGES.contact.done(row({ status: 'shortlist' })), false);
  assert.equal(STAGES.contact.done(row({ status: 'contacted' })), true);
  assert.equal(STAGES.view.done(row({ status: 'contacted' })), false);
  assert.equal(STAGES.view.done(row({ status: 'viewing_booked', assessed: 'done' })), true);
  assert.equal(STAGES.view.done(row({ status: 'viewed' })), true);
});

test('loadStageIds filters the API rows and keeps their order', async () => {
  const api = {
    async get(path) {
      assert.match(path, /^\/api\/properties\?/);
      return [row({ id: 5, status: 'shortlist' }), row({ id: 3, status: 'shortlist', counts: { ratings: 1 } }), row({ id: 9, status: 'shortlist' })];
    },
  };
  assert.deepEqual(await loadStageIds(api, 'rate', defaultFilters()), [5, 9]);
  assert.deepEqual(await loadStageIds(api, 'contact', defaultFilters()), [5, 3, 9]);
});
