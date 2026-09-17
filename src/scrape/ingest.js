// SPEC §6 — the single path every listing takes, whatever brought it in:
//
//   normalise (card) → band check → adapter.detail → applyDetail → normalise (full)
//   → placePins → scoreRow → upsertProperty
//
// The seed (SPEC §8), the daily scrape and the recheck all go through here so a
// listing is shaped the same way no matter which of them saw it first.

import { nowIso, getConfig } from '../db.js';
import { normaliseListing } from './normalise.js';
import { inBand, scoreRow } from './score.js';
import { placePins } from './pins.js';
import { upsertProperty } from './store.js';

/** Detail fields that are null must not blank out what the card already knew. */
export function stripNulls(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

/** placePins returns a NEW row (it does not mutate) — keep its result. */
export function finishRow(input, config) {
  const row = placePins(input);
  const s = scoreRow(row, config);
  row.scope = s.scope;
  row.fit_score = s.fit_score;
  row.flagged = s.flagged;
  row.red_flags = JSON.stringify(s.red_flags);
  return row;
}

/** normalise → pins → score, the three steps every row goes through. */
export function buildRow(partial, config, { firstSeen = null, images = null } = {}) {
  const { row } = normaliseListing(partial, config);
  if (firstSeen) {
    row.first_seen = firstSeen;
    row.last_seen = firstSeen;
  }
  if (images) row.images = images;
  return finishRow(row, config);
}

/** ctx carries the run's config; a bare ctx (or none) falls back to the db. */
function configFrom(db, ctx) {
  const c = ctx && ctx.config;
  if (c && typeof c === 'object' && Object.keys(c).length) return c;
  return getConfig(db);
}

/** Adapters without an applyDetail of their own rely on the merged partial alone. */
const passthroughDetail = (row) => row;

/**
 * Fold an already-fetched detail payload into the store.
 * Split out of `ingestListing` so `recheck.js` can reuse it after its own forced fetch.
 */
export function ingestDetail(db, { partial, detail: d, adapter = null, config, now = nowIso() }) {
  const merged = { ...partial, ...stripNulls(d) };
  const { row } = normaliseListing(merged, config);
  row.first_seen = now;
  row.last_seen = now;

  const apply = (adapter && adapter.applyDetail) || passthroughDetail;
  const withDetail = apply(row, d);

  // `raw` is "JSON of what the adapter saw" (SPEC §3). Take it from the detail payload
  // alone rather than from the merged partial: the daily list and the recheck reach the
  // same page carrying different card fields, and a partial-shaped `raw` would then flip
  // back and forth every night and report a phantom update each time.
  if (d) withDetail.raw = JSON.stringify(d);
  if (d && d.gone) withDetail.availability = 'gone';
  // A detail page without a gallery must not lose the card thumbnail.
  if (!withDetail.images && partial && partial.thumb) withDetail.images = [{ src_url: partial.thumb }];

  const finished = finishRow(withDetail, config);
  const res = upsertProperty(db, finished, { now });
  return { ...res, row: finished, skipped: null, detail: d };
}

/**
 * One adapter partial → one stored property.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} ctx createCtx() result (fetchHtml, config, log)
 * @param {object} adapter the adapter that produced `partial`
 * @param {object} partial an adapter `list()` item
 * @param {{detail?:boolean, now?:string, config?:object}} [opts]
 * @returns {Promise<{id:number|null, action:string, changes:object[], row:object, skipped:string|null, detail:object|null}>}
 */
export async function ingestListing(db, ctx, adapter, partial, { detail = true, now = nowIso(), config: cfgIn = null } = {}) {
  const config = cfgIn || configFrom(db, ctx);

  // SPEC §2 "Aggregation band": outside it the scraper keeps nothing at all, so the
  // band is tested on the cheap card-level row, before any detail page is fetched.
  const cardRow = buildRow(partial, config, {
    firstSeen: now,
    images: partial && partial.thumb ? [{ src_url: partial.thumb }] : null,
  });

  if (!inBand(cardRow, config)) {
    return { id: null, action: 'skipped', changes: [], row: cardRow, skipped: 'out_of_band', detail: null };
  }

  let d = null;
  if (detail && adapter && typeof adapter.detail === 'function' && partial.url) {
    d = await adapter.detail(ctx, partial.url, { force: false });
  }

  // No detail page (404, no payload, --no-detail): the card-level row still stands.
  if (!d) {
    if (partial && partial.gone) cardRow.availability = 'gone';
    const res = upsertProperty(db, cardRow, { now });
    return { ...res, row: cardRow, skipped: null, detail: null };
  }

  return ingestDetail(db, { partial, detail: d, adapter, config, now });
}

export default { ingestListing, ingestDetail, buildRow, finishRow, stripNulls };
