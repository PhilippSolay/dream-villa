// Flow mode: work through many listings fast, one stage at a time.
//
//   sort     new listings         → shortlist, maybe or reject, one tap each
//   rate     shortlisted, unrated → the seven 1–5 rows, Overall last
//   contact  shortlisted          → WhatsApp the agent, mark contacted
//   view     contacted / booked   → book the viewing, log the visit
//
// A stage's queue is the current home filters with the status overridden, so a stage can
// be run per area or price band. Queue ids are fixed when the stage starts; finishing an
// item advances to the next id, skipping never removes anything, and the top pager walks
// the same queue in both directions.

import { filtersToQuery } from './filters.js';
import { verdictOf } from './verdicts.js';

const hasOverall = (p) => (p.ratings || []).some((r) => r.feature === 'overall');

export const STAGES = {
  sort: {
    label: 'Sort',
    hint: 'Shortlist, maybe or reject',
    statuses: ['new'],
    tab: 'listing',
    // A "maybe" leaves the status alone, so the person's own verdict counts as sorted too.
    inQueue: (row, userId) => row.status === 'new' && !verdictOf(row, userId),
    done: (p, userId) => p.status !== 'new' || Boolean(verdictOf(p, userId)),
  },
  rate: {
    label: 'Rate',
    hint: 'Seven rows, Overall last',
    statuses: ['shortlist'],
    tab: 'ratings',
    inQueue: (row) => row.status === 'shortlist' && (row.counts?.ratings ?? 0) === 0,
    done: (p) => p.status !== 'shortlist' || hasOverall(p),
  },
  contact: {
    label: 'Contact',
    hint: 'Message the agent',
    statuses: ['shortlist'],
    tab: 'contact',
    inQueue: (row) => row.status === 'shortlist',
    done: (p) => p.status !== 'shortlist',
  },
  view: {
    label: 'View',
    hint: 'Book, then log the visit',
    statuses: ['contacted', 'viewing_booked'],
    tab: 'viewing',
    inQueue: (row) => row.status === 'contacted' || row.status === 'viewing_booked',
    done: (p) => !(p.status === 'contacted' || p.status === 'viewing_booked') || p.assessed === 'done',
  },
};

export const STAGE_ORDER = ['sort', 'rate', 'contact', 'view'];

export function isStage(name) {
  return Object.prototype.hasOwnProperty.call(STAGES, name);
}

/** The API query for a stage: the user's filters with status and removal forced. */
export function stageQuery(stage, filters) {
  return filtersToQuery({ ...filters, status: STAGES[stage].statuses, removed: 'hide', sort: 'fit' }, { limit: 500 });
}

/** Fetches a stage's queue: ordered ids of everything still waiting for that stage,
    as seen by `userId` (their own verdicts count). */
export async function loadStageIds(api, stage, filters, userId) {
  const rows = await api.get(`/api/properties?${stageQuery(stage, filters)}`);
  return rows.filter((row) => STAGES[stage].inQueue(row, userId)).map((r) => r.id);
}

/** All four queues at once, for the launcher on Home. A stage that fails to load is empty. */
export async function loadStageQueues(api, filters, userId) {
  const out = {};
  await Promise.all(
    STAGE_ORDER.map(async (stage) => {
      try {
        out[stage] = await loadStageIds(api, stage, filters, userId);
      } catch {
        out[stage] = [];
      }
    })
  );
  return out;
}

export function nextStage(stage) {
  const i = STAGE_ORDER.indexOf(stage);
  return i === -1 || i === STAGE_ORDER.length - 1 ? null : STAGE_ORDER[i + 1];
}
