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
import { sha1 } from './fetch.js';

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

// ---------------------------------------------------------------------------
// Detail-page caching (CLAUDE.md "Respect source sites")
//
// Index pages are re-read every morning (24 h cache) and carry the facts that move:
// price, rented/sold, title, bedrooms. A detail page adds what hardly moves (gallery,
// description, land, pin), so for a listing we already hold a copy up to a week old is
// enough. The rule, for every adapter:
//   - a brand-new ref: fetched now (the adapter's own TTL; it has no cache anyway);
//   - a known ref whose card agrees with the stored row: detail cached for 7 days, and
//     refreshed on the listing's own weekday so a seventh of them renew each morning;
//   - a known ref whose card price (or status, bedrooms, title) moved: refetched today.
// And whenever the detail that comes back is an older copy, the card's own facts are
// taken over it: a week-old page never overwrites what today's card says.
// ---------------------------------------------------------------------------

/** A known listing's detail page is refetched after a week (sooner on a card change). */
export const DETAIL_TTL_HOURS = 24 * 7;

/**
 * "Today's copy": a page fetched within this window is this run's own (the run is once
 * a day), so a busted ref reuses it instead of asking twice, and anything older is
 * refetched. Also the line past which a cached detail counts as an older copy.
 */
export const FRESH_TTL_HOURS = 12;

/**
 * Facts an index card states that belong to the card, not to a cached detail page.
 * An adapter whose card does not carry one of these reliably (Bali Home Immo's card
 * title is rebuilt from the URL slug) declares its own `cardFacts`.
 */
export const DEFAULT_CARD_FACTS = ['price_month_idr', 'price_year_idr', 'bedrooms', 'title', 'gone', 'available_from'];

const REMOVED = new Set(['gone', 'unlisted']);

function cardFactsOf(adapter) {
  return (adapter && Array.isArray(adapter.cardFacts) && adapter.cardFacts) || DEFAULT_CARD_FACTS;
}

/** The stored row a card would update, or null for a brand-new ref. */
function knownRow(db, key) {
  if (!db || typeof db.prepare !== 'function' || !key) return null;
  try {
    return (
      db
        .prepare('SELECT title, bedrooms, price_month_idr, price_year_idr, availability, removed_reason FROM properties WHERE key = ?')
        .get(key) || null
    );
  } catch {
    return null;
  }
}

/**
 * How fresh this listing's detail page has to be.
 * @param {object} partial the adapter's card
 * @param {object} cardRow `buildRow(partial)`: the card's facts, normalised like the store
 * @param {object|null} existing the stored row, null for a brand-new ref
 * @param {string[]} [facts] the adapter's card facts
 * @param {{now?:string|number|Date|null}} [opts] the run's clock, for the weekly refresh day
 * @returns {{reason:string, ttlHours:number|null}} reason `new` | `known` | `weekly` | the
 *   bust trigger (`price`, `status`, `bedrooms`, `title`); `ttlHours` null = the adapter's own
 */
export function detailPlan(partial, cardRow, existing, facts = DEFAULT_CARD_FACTS, { now = null } = {}) {
  if (!existing) return { reason: 'new', ttlHours: null };
  const bust = (reason) => ({ reason, ttlHours: FRESH_TTL_HOURS });
  const states = (k) => facts.includes(k) && partial != null && partial[k] != null;

  // Price change = refetch. Compared only where the card states the price itself: a
  // yearly-only card's derived monthly figure is not a price the card gave.
  for (const k of ['price_month_idr', 'price_year_idr']) {
    if (states(k) && cardRow[k] !== existing[k]) return bust('price');
  }
  // Rented/sold on the card, or back on the index after being taken off the market.
  const cardGone = partial != null && partial.gone === true;
  if (facts.includes('gone') && cardGone && existing.availability !== 'gone') return bust('status');
  // A row merged into a keeper is `gone` by design while its source still lists it: that
  // is not a listing coming back, so it waits for its weekly refresh like any other.
  if (REMOVED.has(existing.availability) && !cardGone && existing.removed_reason !== 'merged') return bust('status');
  if (states('bedrooms') && Number(partial.bedrooms) !== existing.bedrooms) return bust('bedrooms');
  if (states('title') && cardRow.title && cardRow.title !== existing.title) return bust('title');
  // The weekly refresh, spread over the week: each listing has its own weekday.
  if (now != null && refreshDay(cardRow.key, now)) return { reason: 'weekly', ttlHours: FRESH_TTL_HOURS };
  return { reason: 'known', ttlHours: DETAIL_TTL_HOURS };
}

/**
 * True on this listing's own refresh weekday (a hash of its key, mod 7). Without it every
 * page cached on the same morning, say the day this rule shipped, would expire on the
 * same morning a week later, and that run would be as long as the old daily ones. With
 * it about a seventh of the known listings refresh each day; DETAIL_TTL_HOURS stays as
 * the backstop.
 * @param {string} key `source:ref`
 * @param {string|number|Date} now the run's clock
 */
export function refreshDay(key, now) {
  const ms = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (!key || !Number.isFinite(ms)) return false;
  const slot = parseInt(sha1(key).slice(0, 8), 16) % 7;
  return Math.floor(ms / 86_400_000) % 7 === slot;
}

/**
 * A ctx for one detail() call: every fetch uses `ttlHours` (when given) and is
 * remembered, so the caller can tell a fresh page from an older cached copy.
 * Throttling and the 429/403 back-off stay in the wrapped ctx, untouched.
 */
export function detailCtx(ctx, { ttlHours = null } = {}) {
  if (!ctx || typeof ctx.fetchHtml !== 'function') return ctx;
  const fetched = [];
  return {
    ...ctx,
    fetched,
    async fetchHtml(url, opts = {}) {
      const res = await ctx.fetchHtml(url, ttlHours == null ? opts : { ...opts, ttlHours });
      if (res) fetched.push({ url, fromCache: Boolean(res.fromCache), fetchedAt: res.fetchedAt || null });
      return res;
    },
  };
}

/** True when any page behind a detail was a cached copy older than today's run. */
export function servedStale(fetched = [], nowMs = Date.now()) {
  return fetched.some((f) => {
    if (!f.fromCache) return false;
    const at = Date.parse(f.fetchedAt);
    // A cache hit of unknown age counts as old: the card then wins, which is the safe side.
    return !Number.isFinite(at) || nowMs - at >= FRESH_TTL_HOURS * 3_600_000;
  });
}

/** An older detail copy minus every card fact today's card states itself. */
export function withoutCardFacts(d, partial, facts = DEFAULT_CARD_FACTS) {
  if (!d) return d;
  const out = { ...d };
  for (const k of facts) if (partial && partial[k] != null) delete out[k];
  return out;
}

/**
 * Fold an already-fetched detail payload into the store.
 * Split out of `ingestListing` so `recheck.js` can reuse it after its own forced fetch.
 */
export function ingestDetail(db, { partial, detail: seen, adapter = null, config, now = nowIso(), stale = false }) {
  // An older cached copy never overrides what today's card says (see detailPlan).
  const d = stale ? withoutCardFacts(seen, partial, cardFactsOf(adapter)) : seen;
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
  // The page as the adapter saw it, older copy or not, so `raw` does not flip between
  // a fresh and a cached morning and report a phantom update.
  if (seen) withDetail.raw = JSON.stringify(seen);
  if (d && d.gone) withDetail.availability = 'gone';
  // A detail page without a gallery must not lose the card thumbnail.
  if (!withDetail.images && partial && partial.thumb) withDetail.images = [{ src_url: partial.thumb }];

  const finished = finishRow(withDetail, config);
  const res = upsertProperty(db, finished, { now });
  return { ...res, row: finished, skipped: null, detail: seen };
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
  let plan = null;
  let stale = false;
  if (detail && adapter && typeof adapter.detail === 'function' && partial.url) {
    plan = detailPlan(partial, cardRow, knownRow(db, cardRow.key), cardFactsOf(adapter), { now });
    const dctx = detailCtx(ctx, { ttlHours: plan.ttlHours });
    d = await adapter.detail(dctx, partial.url, { force: false });
    stale = Boolean(dctx && dctx.fetched && servedStale(dctx.fetched));
  }
  const detail_cache = plan ? plan.reason : null;

  // No detail page (404, no payload, --no-detail): the card-level row still stands.
  if (!d) {
    if (partial && partial.gone) cardRow.availability = 'gone';
    const res = upsertProperty(db, cardRow, { now });
    return { ...res, row: cardRow, skipped: null, detail: null, detail_cache };
  }

  const res = ingestDetail(db, { partial, detail: d, adapter, config, now, stale });
  return { ...res, detail_cache, detail_stale: stale };
}

export default {
  ingestListing, ingestDetail, buildRow, finishRow, stripNulls,
  detailPlan, detailCtx, servedStale, withoutCardFacts, refreshDay,
  DETAIL_TTL_HOURS, FRESH_TTL_HOURS, DEFAULT_CARD_FACTS,
};
