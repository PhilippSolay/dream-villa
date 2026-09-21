// SPEC §4 "Properties" and "Contacts". Every route needs a logged-in user; every row a
// person creates carries `by` and `created_at` (CLAUDE.md). All SQL is built from column
// whitelists with bound parameters only — no user string ever reaches the statement text.

import crypto from 'node:crypto';
import multipart from '@fastify/multipart';

import { getConfig, nowIso } from '../db.js';
import { AREAS, nearestBeach } from '../areas.js';
import { STATUSES, REMOVAL_REASONS } from '../defaults.js';
import { parseRow, upsertProperty } from '../scrape/store.js';
import { reasonsFor } from '../scrape/score.js';
import { finishRow } from '../scrape/ingest.js';
import { mapUrl } from '../scrape/pins.js';
import {
  addRedFlags, badRequest, getProperty, heroUrl, imageUrls, imagesDirFor, int, jsonArray,
  notFound, placeholders, readMultipart, rescoreOne, safeJson, saveImage, str, strictSchemas, userNames, withByName,
} from './_common.js';
import { listAnchors, anchorDistances } from './anchors.js';

const MAX_FILES = 10;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

const SCOPES = ['in_filter', 'market', 'all'];
const ASSESSED = ['not_yet', 'partly', 'done'];
const STYLES = ['modern', 'tropical', 'joglo', 'balinese_old', 'industrial', 'bamboo'];
const RATING_FEATURES = ['quiet', 'privacy', 'living_room', 'light', 'beach', 'style', 'overall'];
const TIMES_OF_DAY = ['morning', 'midday', 'afternoon', 'evening'];
const VERDICTS = ['no', 'maybe', 'yes'];
const VIEWING_SCALES = ['quiet', 'privacy', 'living_room', 'light', 'breeze', 'overlooked', 'construction_nearby'];
const CONTACT_ROLES = ['owner', 'agent', 'agency'];

/** Feature filter → a constant SQL fragment. The map is the whitelist. */
const FEATURE_SQL = {
  pool: 'pool = 1',
  garden: 'garden = 1',
  view: "(view IS NOT NULL AND view != 'none')",
  joglo: 'joglo = 1',
  aircon: 'aircon = 1',
  kitchen_full: 'kitchen_full = 1',
  workspace: 'workspace = 1',
  airy: 'airy = 1',
  living_open: 'living_open = 1',
};
const FEATURES = Object.keys(FEATURE_SQL);

// Removal, in SQL (SPEC §16). `removed_at`/`removed_reason` are stored from migration
// 006 on; COALESCE keeps rows removed before it readable, by the same fallback
// `removalOf()` uses on the way out.
const LIVE_SQL = "availability IS NULL OR availability NOT IN ('gone', 'unlisted')";
const REMOVED_SQL = "availability IN ('gone', 'unlisted') OR status = 'gone'";
const MERGED_SQL = "json_extract(raw, '$.merged_into') IS NULL";
const REMOVED_AT_SQL = `COALESCE(removed_at, CASE
  WHEN availability IN ('gone', 'unlisted') THEN last_seen
  WHEN status = 'gone' THEN status_at END)`;
const REMOVED_REASON_SQL = `COALESCE(removed_reason, CASE
  WHEN availability = 'unlisted' THEN 'unlisted'
  WHEN availability = 'gone' THEN 'delisted'
  WHEN status = 'gone' THEN 'taken' END)`;

/** NULLs sort last everywhere: an unpriced or un-measured row is not "cheapest"/"closest". */
const SORT_SQL = {
  fit: 'fit_score IS NULL, fit_score DESC, price_month_idr IS NULL, price_month_idr ASC, id DESC',
  price: 'price_month_idr IS NULL, price_month_idr ASC, id DESC',
  beach: 'beach_km IS NULL, beach_km ASC, id DESC',
  new: 'first_seen DESC, id DESC',
  size: 'build_m2 IS NULL, build_m2 DESC, land_m2 IS NULL, land_m2 DESC, id DESC',
  // The archive's own order: what went most recently, first.
  removed: `${REMOVED_AT_SQL} IS NULL, ${REMOVED_AT_SQL} DESC, id DESC`,
};

const AREA_IDS = [...Object.keys(AREAS), 'other'];

/** Person-editable listing fields (SPEC §4 PATCH). */
const PATCH_FIELDS = [
  'extra_rooms', 'living_open', 'airy', 'workspace', 'style',
  'beach_km', 'lat', 'lng', 'notes', 'assessed', 'red_flags',
];

/** Columns the PATCH handler may ever write (the above plus what lat/lng/beach derive). */
const PATCH_WRITABLE = new Set([
  ...PATCH_FIELDS, 'beach_name', 'beach_source', 'pin_source', 'map_url',
]);

/** Listing facts a manual add may carry. `key`, `source` and scoring are set by us. */
const MANUAL_FIELDS = [
  'ref', 'url', 'title', 'description', 'inclusions', 'terms', 'area', 'sub_area', 'address',
  'lat', 'lng', 'beach_km', 'bedrooms', 'extra_rooms', 'bathrooms', 'land_m2', 'build_m2',
  'price_month_idr', 'price_year_idr', 'term', 'min_months', 'furnished', 'furniture_quality',
  'style', 'pool', 'garden', 'view', 'joglo', 'aircon', 'kitchen_full', 'workspace',
  'living_open', 'airy', 'availability', 'available_from',
];

const CONTACT_FIELDS = ['name', 'role', 'phone', 'whatsapp', 'email', 'agency', 'instagram', 'notes'];

const boolish = { type: ['integer', 'null'], enum: [0, 1, null] };
const nullableString = { type: ['string', 'null'] };

// ---------------------------------------------------------------------------
// Shared shaping
// ---------------------------------------------------------------------------

/** True when the listing is off the market, from either source (SPEC §15.4). */
function isRemovedRow(row) {
  return row.availability === 'gone' || row.availability === 'unlisted' || row.status === 'gone';
}

/**
 * When the listing went and why (SPEC §16). Both are stored from migration 006 on;
 * rows removed before it fall back to the old inference — `last_seen` was the detection
 * moment for a scraper removal, `status_at` for a person-set one.
 */
function removalOf(row) {
  if (!isRemovedRow(row)) return { at: null, reason: null };
  if (row.removed_at) return { at: row.removed_at, reason: row.removed_reason || null };
  if (row.availability === 'gone' || row.availability === 'unlisted') {
    return { at: row.last_seen, reason: row.availability === 'unlisted' ? 'unlisted' : 'delisted' };
  }
  return { at: row.status_at, reason: 'taken' };
}

/** Whole days between two ISO stamps, or null when either is missing. */
function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 86_400_000));
}

/** parseRow minus `raw` (debug-only and large), plus the computed fields the UI needs. */
export function publicRow(row) {
  const parsed = parseRow(row);
  delete parsed.raw;
  const removal = removalOf(parsed);
  return {
    ...parsed,
    hero_url: heroUrl(parsed),
    reasons: reasonsFor(parsed),
    removed_at: removal.at,
    removed_reason: removal.reason,
    // How long the villa was on the market before it went — the archive's whole point.
    // `last_seen` is the last sighting, so a scraper removal measures to the sighting;
    // a person-set one has no sighting to lean on and measures to the tap.
    days_live: removal.at
      ? daysBetween(parsed.first_seen, removal.reason === 'taken' ? removal.at : parsed.last_seen)
      : null,
  };
}

// --- shared search: per-person verdicts -------------------------------------

export const PERSON_VERDICTS = ['yes', 'maybe', 'no']; // (VERDICTS above belongs to viewings)
/** List filters, all relative to the person asking (`request.user.id`). */
export const VERDICT_FILTERS = ['match', 'waiting_other', 'waiting_me', 'disagree', 'maybe', 'unvoted'];
/** `my_verdict=`: the caller's own call, or 'none' for listings they have not called. */
export const MY_VERDICT_FILTERS = [...PERSON_VERDICTS, 'none'];

/** property_id → [{by, by_name, verdict, updated_at}] for the rows about to be returned. */
function verdictsByProperty(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = withByName(
    db,
    db
      .prepare(
        `SELECT property_id, by, verdict, updated_at FROM verdicts
          WHERE property_id IN (${placeholders(ids)}) ORDER BY by`
      )
      .all(...ids)
  );
  for (const r of rows) {
    const { property_id: pid, ...v } = r;
    if (!out.has(pid)) out.set(pid, []);
    out.get(pid).push(v);
  }
  return out;
}

// --- value: price per m² against the area, and what a yearly term saves -------

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** area → median monthly price per m² of house, over live listings that have both figures. */
function areaMediansPerM2(db) {
  const rows = db
    .prepare(
      `SELECT area, price_month_idr * 1.0 / build_m2 AS ppm2 FROM properties
        WHERE build_m2 > 0 AND price_month_idr > 0
          AND (availability IS NULL OR availability NOT IN ('gone', 'unlisted'))`
    )
    .all();
  const byArea = new Map();
  for (const r of rows) {
    if (!byArea.has(r.area)) byArea.set(r.area, []);
    byArea.get(r.area).push(r.ppm2);
  }
  const out = {};
  for (const [area, values] of byArea) out[area] = Math.round(median(values));
  return out;
}

/**
 * Pure: the row's price per m² of house, the area's median, the gap in %, and the saving a
 * yearly term offers over paying monthly (only when the listing really offers both — a
 * yearly-only listing's monthly price is derived, so there is nothing to compare).
 */
export function valueFields(row, mediansByArea, area) {
  const monthly = Number(row.price_month_idr) || 0;
  const size = Number(row.build_m2) || 0;
  const pricePerM2 = monthly > 0 && size > 0 ? Math.round(monthly / size) : null;
  const areaMedian = mediansByArea[area] ?? null;
  const vs = pricePerM2 != null && areaMedian ? Math.round((pricePerM2 / areaMedian - 1) * 100) : null;

  const yearly = Number(row.price_year_idr) || 0;
  let saving = null;
  if (row.term === 'both' && monthly > 0 && yearly > 0) {
    const pct = Math.round((1 - yearly / 12 / monthly) * 100);
    if (pct > 0) saving = pct;
  }
  return { price_per_m2: pricePerM2, area_price_per_m2: areaMedian, vs_area_pct: vs, yearly_saving_pct: saving };
}

/**
 * WHERE clause for `anchor=&anchor_km=`: an equirectangular bound, so it needs no trig in
 * SQLite — squared degrees against (km / 111.32)², with longitude scaled by cos(lat). Rows
 * without a pin never match (the exact haversine figure is what the row itself carries).
 */
const KM_PER_DEGREE = 111.32;
function anchorWhere(anchor, km) {
  const c = Math.cos((anchor.lat * Math.PI) / 180);
  const limit = (km / KM_PER_DEGREE) ** 2;
  return {
    sql: '(lat IS NOT NULL AND lng IS NOT NULL AND (lat - ?) * (lat - ?) + (lng - ?) * (lng - ?) * ? <= ?)',
    params: [anchor.lat, anchor.lat, anchor.lng, anchor.lng, c * c, limit],
  };
}

/** Adds the derived, person-facing fields to every row: verdicts, who set the status, value, anchors. */
function withShared(db, rows) {
  const verdicts = verdictsByProperty(db, rows.map((r) => r.id));
  const names = userNames(db);
  const medians = areaMediansPerM2(db);
  const anchors = listAnchors(db);
  return rows.map((r) => ({
    ...r,
    verdicts: verdicts.get(r.id) || [],
    status_by_name: r.status_by == null ? null : names.get(r.status_by) || null,
    ...valueFields(r, medians, r.area),
    anchors: anchorDistances(r, anchors),
  }));
}

/** WHERE clause for `verdict=` — "mine" is the caller's call, "other" anyone else's. */
function verdictWhere(filter, userId) {
  const mine = '(SELECT verdict FROM verdicts WHERE property_id = properties.id AND by = ?)';
  const other = '(SELECT verdict FROM verdicts WHERE property_id = properties.id AND by != ? ORDER BY updated_at DESC LIMIT 1)';
  const sql = {
    match: `${mine} = 'yes' AND ${other} = 'yes'`,
    // A No from the caller closes the matter; the other person is not waited on for it.
    waiting_other: `${mine} IS NOT NULL AND ${mine} != 'no' AND ${other} IS NULL`,
    waiting_me: `${mine} IS NULL AND ${other} IS NOT NULL`,
    disagree: `${mine} IS NOT NULL AND ${other} IS NOT NULL AND ${mine} != ${other}`,
    maybe: `(${mine} = 'maybe' OR ${other} = 'maybe')`,
    unvoted: `${mine} IS NULL AND ${other} IS NULL`,
  }[filter];
  const count = (sql.match(/\?/g) || []).length;
  return { sql: `(${sql})`, params: new Array(count).fill(userId) };
}

/** WHERE clause for `my_verdict=` — the caller's own call; 'none' means no call yet. */
function myVerdictWhere(filter, userId) {
  const mine = '(SELECT verdict FROM verdicts WHERE property_id = properties.id AND by = ?)';
  if (filter === 'none') return { sql: `(${mine} IS NULL)`, params: [userId] };
  return { sql: `(${mine} = ?)`, params: [userId, filter] };
}

function rowPayload(db, id) {
  const row = getProperty(db, id);
  return row ? withShared(db, [publicRow(row)])[0] : null;
}

/** '' → null, 'a,b' → ['a','b']. */
function listParam(v) {
  if (v === null || v === undefined || v === '') return null;
  const parts = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

/** '+62 812-345' → '+62812345'; digits only, one leading '+'. */
export function normaliseWhatsapp(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  return digits ? `+${digits}` : null;
}

function todayIso() {
  return nowIso().slice(0, 10);
}

function constructionKeywords(config) {
  const fromConfig = config?.red_flag_keywords?.construction;
  const list = Array.isArray(fromConfig) && fromConfig.length ? fromConfig : ['construction', 'building site'];
  return [...new Set([...list.map((k) => String(k).toLowerCase()), 'construction'])];
}

function mentionsConstruction(texts, config) {
  const hay = texts.filter(Boolean).join(' \n ').toLowerCase();
  if (!hay) return false;
  return constructionKeywords(config).some((k) => hay.includes(k));
}

// ---------------------------------------------------------------------------
// GET /api/properties — the list
// ---------------------------------------------------------------------------

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: { type: 'string', enum: SCOPES },
    status: { type: 'string' },
    area: { type: 'string' },
    min: { type: 'integer', minimum: 0 },
    max: { type: 'integer', minimum: 0 },
    beach: { type: 'number', minimum: 0 },
    land_min: { type: 'integer', minimum: 0 },
    land_max: { type: 'integer', minimum: 0 },
    build_min: { type: 'integer', minimum: 0 },
    build_max: { type: 'integer', minimum: 0 },
    bedrooms: { type: 'string' },
    features: { type: 'string' },
    furnished: { type: 'string', enum: ['1', '0', 'any'] },
    term: { type: 'string', enum: ['monthly', 'yearly', 'any'] },
    assessed: { type: 'string', enum: ASSESSED },
    source: { type: 'string', maxLength: 40 },
    flagged: { type: 'integer', enum: [0, 1] },
    q: { type: 'string', maxLength: 120 },
    hide_gone: { type: 'integer', enum: [0, 1] },
    removed: { type: 'string', enum: ['hide', 'show', 'only'] },
    removed_reason: { type: 'string' },
    removed_days: { type: 'integer', minimum: 1, maximum: 3650 },
    max_age_days: { type: 'integer', minimum: 1, maximum: 365 },
    verdict: { type: 'string', enum: VERDICT_FILTERS },
    my_verdict: { type: 'string', enum: MY_VERDICT_FILTERS },
    style: { type: 'string' },
    anchor: { type: 'integer', minimum: 1 },
    anchor_km: { type: 'number', minimum: 0.1, maximum: 100 },
    sort: { type: 'string', enum: Object.keys(SORT_SQL) },
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    offset: { type: 'integer', minimum: 0 },
  },
};

/** @returns {{where:string[], params:any[]} | {error:string}} */
function buildListWhere(query) {
  const where = [];
  const params = [];

  const scope = query.scope || 'in_filter';
  if (scope !== 'all') {
    where.push('scope = ?');
    params.push(scope);
  }

  const status = listParam(query.status);
  if (!status) {
    where.push("status NOT IN ('rejected', 'gone')");
  } else if (!(status.length === 1 && status[0] === 'all')) {
    const bad = status.filter((s) => !STATUSES.includes(s));
    if (bad.length) return { error: `unknown status: ${bad.join(', ')}` };
    where.push(`status IN (${placeholders(status)})`);
    params.push(...status);
  }

  const areas = listParam(query.area);
  if (areas) {
    const bad = areas.filter((a) => !AREA_IDS.includes(a));
    if (bad.length) return { error: `unknown area: ${bad.join(', ')}` };
    where.push(`area IN (${placeholders(areas)})`);
    params.push(...areas);
  }

  if (query.min !== undefined) {
    where.push('price_month_idr >= ?');
    params.push(query.min);
  }
  if (query.max !== undefined) {
    where.push('price_month_idr <= ?');
    params.push(query.max);
  }

  // Beach is a soft filter (SPEC §2, amended): an unknown distance never excludes a row.
  if (query.beach !== undefined) {
    where.push('(beach_km IS NULL OR beach_km <= ?)');
    params.push(query.beach);
  }

  // Land/building size: same soft-filter shape as beach — an unmeasured row never
  // gets excluded just because the slider moved off its default.
  if (query.land_min !== undefined) {
    where.push('(land_m2 IS NULL OR land_m2 >= ?)');
    params.push(query.land_min);
  }
  if (query.land_max !== undefined) {
    where.push('(land_m2 IS NULL OR land_m2 <= ?)');
    params.push(query.land_max);
  }
  if (query.build_min !== undefined) {
    where.push('(build_m2 IS NULL OR build_m2 >= ?)');
    params.push(query.build_min);
  }
  if (query.build_max !== undefined) {
    where.push('(build_m2 IS NULL OR build_m2 <= ?)');
    params.push(query.build_max);
  }

  const bedrooms = listParam(query.bedrooms);
  if (bedrooms) {
    const nums = bedrooms.map((b) => Number(b));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 20)) return { error: 'bedrooms must be integers' };
    where.push(`bedrooms IN (${placeholders(nums)})`);
    params.push(...nums);
  }

  const features = listParam(query.features);
  if (features) {
    const bad = features.filter((f) => !FEATURES.includes(f));
    if (bad.length) return { error: `unknown feature: ${bad.join(', ')}` };
    for (const f of features) where.push(FEATURE_SQL[f]);
  }

  const styles = listParam(query.style);
  if (styles) {
    const bad = styles.filter((s) => !STYLES.includes(s));
    if (bad.length) return { error: `unknown style: ${bad.join(', ')}` };
    where.push(`style IN (${placeholders(styles)})`);
    params.push(...styles);
  }

  if (query.furnished && query.furnished !== 'any') {
    where.push('furnished = ?');
    params.push(Number(query.furnished));
  }

  if (query.term && query.term !== 'any') {
    // A listing offering 'both' satisfies either request.
    where.push('term IN (?, ?)');
    params.push(query.term, 'both');
  }

  if (query.assessed) {
    where.push('assessed = ?');
    params.push(query.assessed);
  }

  if (query.source) {
    where.push('source = ?');
    params.push(query.source);
  }

  if (query.flagged === 1) where.push('flagged = 1');

  const q = str(query.q);
  if (q) {
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR sub_area LIKE ? ESCAPE '\\' OR ref LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }

  // Age of post (SPEC filter drawer "Posted within"): first_seen is ISO text, so the
  // cutoff is computed in JS and compared as a string rather than trusting SQLite's
  // own datetime() math against a stored format that might drift.
  if (query.max_age_days !== undefined) {
    const cutoff = new Date(Date.now() - query.max_age_days * 86_400_000).toISOString();
    where.push('first_seen >= ?');
    params.push(cutoff);
  }

  // Removed listings: `gone` (recheck saw a 404/archived page) and `unlisted` (a source
  // stopped listing it) both mean "no longer offered by the agent". `hide_gone` is kept
  // for backwards compatibility and maps onto the new tri-state.
  let removed = query.removed;
  if (!removed) {
    const hideGoneCompat = query.hide_gone === undefined ? 1 : query.hide_gone;
    removed = hideGoneCompat === 1 ? 'hide' : 'show';
  }
  // A person-set status of `gone` (the agent said it is taken) counts as removed too.
  if (removed === 'hide') where.push(`(${LIVE_SQL}) AND status != 'gone'`);
  else if (removed === 'only') where.push(`(${REMOVED_SQL})`);
  // A row folded away by dedupe is `gone` too, but it is bookkeeping — the same villa
  // is still in the list under the keeper's row. It never belongs in an archive of what
  // left the market, so it drops out of both `show` and `only` (SPEC §16).
  if (removed !== 'hide') where.push(MERGED_SQL);

  // Removal filters, only meaningful once removed rows are in play.
  const reasons = listParam(query.removed_reason);
  if (reasons) {
    const bad = reasons.filter((r) => !REMOVAL_REASONS.includes(r));
    if (bad.length) return { error: `unknown removed_reason: ${bad.join(', ')}` };
    where.push(`${REMOVED_REASON_SQL} IN (${placeholders(reasons)})`);
    params.push(...reasons);
  }

  // "Gone within the last N days" — the archive's own window, the mirror of max_age_days.
  if (query.removed_days !== undefined) {
    const cutoff = new Date(Date.now() - query.removed_days * 86_400_000).toISOString();
    where.push(`${REMOVED_AT_SQL} >= ?`);
    params.push(cutoff);
  }

  return { where, params, removed };
}

/** property_id → contacts[] for the page of rows we are about to return. */
function contactsByProperty(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT pc.property_id AS property_id, c.*
         FROM property_contacts pc JOIN contacts c ON c.id = pc.contact_id
        WHERE pc.property_id IN (${placeholders(ids)})
        ORDER BY c.id`
    )
    .all(...ids);
  for (const r of rows) {
    const { property_id: pid, ...contact } = r;
    if (!out.has(pid)) out.set(pid, []);
    out.get(pid).push(contact);
  }
  return out;
}

function countsByProperty(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  for (const id of ids) out.set(id, { viewings: 0, ratings: 0, feedback: 0 });
  for (const table of ['viewings', 'ratings', 'feedback']) {
    const rows = db
      .prepare(`SELECT property_id, COUNT(*) AS n FROM ${table} WHERE property_id IN (${placeholders(ids)}) GROUP BY property_id`)
      .all(...ids);
    for (const r of rows) if (out.has(r.property_id)) out.get(r.property_id)[table] = r.n;
  }
  return out;
}

/**
 * Tapping Gone is a removal like any other (SPEC §16), so it gets the same stamp the
 * scraper writes. A row the scraper already removed keeps that record: the scraper found
 * out first, and its date is the closer one. Moving the status back off Gone clears the
 * stamp only when the person set it — an `availability` of gone/unlisted is the source's
 * word, and a status tap does not overrule it.
 */
function stampPersonRemoval(db, id, before, next, now) {
  if (next === 'gone') {
    if (before.removed_at == null) {
      db.prepare("UPDATE properties SET removed_at = ?, removed_reason = 'taken' WHERE id = ?").run(now, id);
    }
    return;
  }
  if (before.status === 'gone' && before.removed_reason === 'taken') {
    db.prepare("UPDATE properties SET removed_at = NULL, removed_reason = NULL WHERE id = ?").run(id);
  }
}

/**
 * The journey (SPEC §15): a Yes from either person shortlists a new listing; taking a
 * Yes back returns it to `new` when no Yes is left. Nothing else moves the status from
 * here — a No is a personal call, Reject and Gone stay taps in the pipeline row.
 */
function syncShortlist(db, id, userId, before, after) {
  const row = db.prepare('SELECT status FROM properties WHERE id = ?').get(id);
  if (!row) return;
  const yesCount = db.prepare("SELECT COUNT(*) AS n FROM verdicts WHERE property_id = ? AND verdict = 'yes'").get(id).n;
  let next = null;
  if (after === 'yes' && row.status === 'new') next = 'shortlist';
  else if (before === 'yes' && after !== 'yes' && row.status === 'shortlist' && yesCount === 0) next = 'new';
  if (!next) return;
  db.prepare('UPDATE properties SET status = ?, status_by = ?, status_at = ? WHERE id = ?').run(next, userId, nowIso(), id);
  rescoreOne(db, id);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default async function propertiesRoutes(app, opts) {
  const { db, env = process.env } = opts;
  const imagesDir = imagesDirFor(env);
  // `onRequest`, not `preHandler`: schema validation runs before preHandler, so an
  // anonymous caller would otherwise get a 400 describing the body before the 401.
  const auth = { onRequest: app.requireUser };

  strictSchemas(app);

  await app.register(multipart, { limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES } });

  // --- list ---------------------------------------------------------------
  app.get('/api/properties', { ...auth, schema: { querystring: listQuerySchema } }, async (request, reply) => {
    const query = request.query || {};
    const built = buildListWhere(query);
    if (built.error) return badRequest(reply, built.error);

    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    // `removed=show` sorts live listings first, removed ones after, then the chosen sort
    // within each group (SPEC filter drawer "Removed"). Only the explicit new param
    // triggers this: `hide_gone=0` keeps its old, purely-a-filter behaviour so an
    // existing integration's sort order is not silently rearranged underneath it.
    const removedSecondary = query.removed === 'show' ? `CASE WHEN ${REMOVED_SQL} THEN 1 ELSE 0 END, ` : '';
    const order = removedSecondary + SORT_SQL[query.sort || 'fit'];
    if (query.verdict) {
      const v = verdictWhere(query.verdict, request.user.id);
      built.where.push(v.sql);
      built.params.push(...v.params);
    }
    if (query.my_verdict) {
      const v = myVerdictWhere(query.my_verdict, request.user.id);
      built.where.push(v.sql);
      built.params.push(...v.params);
    }
    if (query.anchor !== undefined) {
      if (query.anchor_km === undefined) return badRequest(reply, 'anchor needs anchor_km');
      const anchor = db.prepare('SELECT * FROM anchors WHERE id = ?').get(query.anchor);
      if (!anchor) return notFound(reply);
      const a = anchorWhere(anchor, query.anchor_km);
      built.where.push(a.sql);
      built.params.push(...a.params);
    }
    const whereSql = built.where.length ? `WHERE ${built.where.join(' AND ')}` : '';

    const rows = db
      .prepare(`SELECT * FROM properties ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...built.params, limit, offset);
    // The body stays a plain array (map, flow and detail all consume it as one); the
    // full match count rides in a header so Home can say "200 of 323" and page on.
    const total = db.prepare(`SELECT COUNT(*) AS n FROM properties ${whereSql}`).get(...built.params).n;
    reply.header('X-Total-Count', String(total));

    const ids = rows.map((r) => r.id);
    const contacts = contactsByProperty(db, ids);
    const counts = countsByProperty(db, ids);

    return withShared(
      db,
      rows.map((row) => ({
        ...publicRow(row),
        contacts: contacts.get(row.id) || [],
        counts: counts.get(row.id) || { viewings: 0, ratings: 0, feedback: 0 },
      }))
    );
  });

  // --- detail -------------------------------------------------------------
  app.get(
    '/api/properties/:id',
    { ...auth, schema: { params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } },
    async (request, reply) => {
      const { id } = request.params;
      const row = getProperty(db, id);
      if (!row) return notFound(reply);

      const parsed = parseRow(row);
      const contacts = db
        .prepare(
          `SELECT c.* FROM property_contacts pc JOIN contacts c ON c.id = pc.contact_id
            WHERE pc.property_id = ? ORDER BY c.id`
        )
        .all(id);

      const agentInfo = withByName(
        db,
        db.prepare('SELECT * FROM agent_info WHERE property_id = ? ORDER BY date DESC, id DESC').all(id)
      ).map((r) => ({ ...r, included: safeJson(r.included) }));

      const viewings = withByName(
        db,
        db.prepare('SELECT * FROM viewings WHERE property_id = ? ORDER BY date DESC, id DESC').all(id)
      ).map((r) => ({ ...r, photos: jsonArray(r.photos), photo_urls: jsonArray(r.photos).map((f) => `/images/${f}`) }));

      const ratings = withByName(db, db.prepare('SELECT * FROM ratings WHERE property_id = ? ORDER BY id DESC').all(id));
      const feedback = withByName(db, db.prepare('SELECT * FROM feedback WHERE property_id = ? ORDER BY id DESC').all(id));

      const imageUrlList = imageUrls(parsed);
      const galleryTotal = Array.isArray(parsed.images) ? parsed.images.length : 0;

      return withShared(db, [
        {
          ...parsed,
          hero_url: heroUrl(parsed),
          image_urls: imageUrlList,
          // Gallery entries that ended up with nothing to show: dead (images-audit.js
          // gave up on the remote link), or neither a local file nor a src_url.
          images_missing: Math.max(0, galleryTotal - imageUrlList.length),
          reasons: reasonsFor(parsed),
          price_history: parsed.price_history || [],
          contacts,
          agent_info: agentInfo,
          viewings,
          ratings,
          feedback,
        },
      ])[0];
    }
  );

  // --- create (inbox URL, or a full manual listing) ------------------------
  const createSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', minLength: 4, maxLength: 2000 },
      note: nullableString,
      source: { type: 'string', maxLength: 40 },
      ref: nullableString,
      title: { type: 'string', minLength: 1 },
      area: { type: 'string', enum: AREA_IDS },
      description: nullableString,
      inclusions: nullableString,
      terms: nullableString,
      sub_area: nullableString,
      address: nullableString,
      lat: { type: ['number', 'null'] },
      lng: { type: ['number', 'null'] },
      beach_km: { type: ['number', 'null'], minimum: 0 },
      bedrooms: { type: ['integer', 'null'], minimum: 0, maximum: 20 },
      extra_rooms: { type: ['integer', 'null'], minimum: 0, maximum: 20 },
      bathrooms: { type: ['integer', 'null'], minimum: 0, maximum: 20 },
      land_m2: { type: ['integer', 'null'], minimum: 0 },
      build_m2: { type: ['integer', 'null'], minimum: 0 },
      price_month_idr: { type: ['integer', 'null'], minimum: 0 },
      price_year_idr: { type: ['integer', 'null'], minimum: 0 },
      term: { type: ['string', 'null'], enum: ['monthly', 'yearly', 'both', null] },
      min_months: { type: ['integer', 'null'], minimum: 0 },
      furnished: boolish,
      furniture_quality: { type: ['integer', 'null'], minimum: 1, maximum: 5 },
      style: { type: ['string', 'null'], enum: [...STYLES, null] },
      pool: boolish,
      garden: boolish,
      view: nullableString,
      joglo: boolish,
      aircon: boolish,
      kitchen_full: boolish,
      workspace: boolish,
      living_open: boolish,
      airy: boolish,
      availability: nullableString,
      available_from: nullableString,
    },
  };

  app.post('/api/properties', { ...auth, schema: { body: createSchema } }, async (request, reply) => {
    const body = request.body;
    const url = body.url.trim();

    // No title/area → this is just a link someone pasted: queue it for the scraper.
    if (!body.title || !body.area) {
      const existing = db.prepare('SELECT id FROM inbox WHERE url = ?').get(url);
      if (existing) return { queued: true, inbox_id: existing.id, existing: true };
      const info = db
        .prepare('INSERT INTO inbox (url, by, note, status, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(url, request.user.name, str(body.note), 'pending', nowIso());
      return { queued: true, inbox_id: Number(info.lastInsertRowid) };
    }

    const config = getConfig(db);
    const row = {};
    for (const f of MANUAL_FIELDS) if (body[f] !== undefined) row[f] = body[f];
    row.url = url;
    row.source = str(body.source) || 'manual';
    row.key = `manual:${crypto.createHash('sha1').update(url).digest('hex')}`;

    // CLAUDE.md: yearly prices normalise to a monthly equivalent.
    if (row.price_month_idr == null && row.price_year_idr != null) {
      row.price_month_idr = Math.round(row.price_year_idr / 12);
    }

    // finishRow = placePins + scoreRow, the same shaping every scraped row gets.
    const finished = finishRow(row, config);
    const res = upsertProperty(db, finished, { now: nowIso() });
    return { ...rowPayload(db, res.id), action: res.action };
  });

  // --- patch --------------------------------------------------------------
  const patchSchema = {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      extra_rooms: { type: ['integer', 'null'], minimum: 0, maximum: 20 },
      living_open: boolish,
      airy: boolish,
      workspace: boolish,
      style: { type: ['string', 'null'], enum: [...STYLES, null] },
      beach_km: { type: ['number', 'null'], minimum: 0 },
      lat: { type: ['number', 'null'], minimum: -90, maximum: 90 },
      lng: { type: ['number', 'null'], minimum: -180, maximum: 180 },
      notes: nullableString,
      assessed: { type: 'string', enum: ASSESSED },
      red_flags: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 60 } },
    },
  };

  app.patch(
    '/api/properties/:id',
    { ...auth, schema: { body: patchSchema, params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } },
    async (request, reply) => {
      const { id } = request.params;
      const row = getProperty(db, id);
      if (!row) return notFound(reply);

      const body = request.body;
      const sets = {};
      for (const field of PATCH_FIELDS) {
        if (!(field in body)) continue;
        sets[field] = field === 'red_flags' ? JSON.stringify([...new Set(body.red_flags)]) : body[field];
      }

      // A hand-set distance is authoritative. The DDL comment only lists
      // 'listing_text'|'computed'; 'person' is added here so the scraper's
      // "text wins over computed" rule can still tell the three apart.
      if ('beach_km' in body) sets.beach_source = 'person';

      if ('lat' in body || 'lng' in body) {
        const lat = 'lat' in body ? body.lat : row.lat;
        const lng = 'lng' in body ? body.lng : row.lng;
        sets.pin_source = 'agent';
        if (lat != null && lng != null) {
          sets.map_url = mapUrl(lat, lng);
          if (row.beach_source !== 'listing_text' && !('beach_km' in body)) {
            const nearest = nearestBeach(Number(lat), Number(lng));
            if (nearest) {
              sets.beach_km = nearest.km;
              sets.beach_name = nearest.name;
              sets.beach_source = 'computed';
            }
          }
        }
      }

      const cols = Object.keys(sets).filter((c) => PATCH_WRITABLE.has(c));
      if (cols.length) {
        db.prepare(`UPDATE properties SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
          .run(...cols.map((c) => sets[c]), id);
      }

      rescoreOne(db, id);
      return rowPayload(db, id);
    }
  );

  // --- status -------------------------------------------------------------
  app.post(
    '/api/properties/:id/status',
    {
      ...auth,
      schema: {
        params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        body: {
          type: 'object', additionalProperties: false, required: ['status'],
          properties: { status: { type: 'string', enum: STATUSES } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const before = getProperty(db, id);
      if (!before) return notFound(reply);
      const now = nowIso();
      db.prepare('UPDATE properties SET status = ?, status_by = ?, status_at = ? WHERE id = ?')
        .run(request.body.status, request.user.id, now, id);
      stampPersonRemoval(db, id, before, request.body.status, now);
      rescoreOne(db, id);
      return rowPayload(db, id);
    }
  );

  // --- verdict (shared search) ----------------------------------------------
  // One tap per person: yes / maybe / no, or null to take it back. Only the caller's own
  // row moves; the other person's call is never touched from here.
  app.post(
    '/api/properties/:id/verdict',
    {
      ...auth,
      schema: {
        params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        body: {
          type: 'object', additionalProperties: false, required: ['verdict'],
          properties: { verdict: { type: ['string', 'null'], enum: [...PERSON_VERDICTS, null] } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!getProperty(db, id)) return notFound(reply);
      const { verdict } = request.body;
      const before = db.prepare('SELECT verdict FROM verdicts WHERE property_id = ? AND by = ?').get(id, request.user.id)?.verdict ?? null;
      if (verdict === null) {
        db.prepare('DELETE FROM verdicts WHERE property_id = ? AND by = ?').run(id, request.user.id);
      } else {
        db.prepare(
          `INSERT INTO verdicts (property_id, by, verdict, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(property_id, by) DO UPDATE SET verdict = excluded.verdict, updated_at = excluded.updated_at`
        ).run(id, request.user.id, verdict, nowIso(), nowIso());
      }
      syncShortlist(db, id, request.user.id, before, verdict);
      return rowPayload(db, id);
    }
  );

  // --- ratings ------------------------------------------------------------
  app.post(
    '/api/properties/:id/ratings',
    {
      ...auth,
      schema: {
        params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        body: {
          type: 'object', additionalProperties: false, required: ['feature', 'score'],
          properties: {
            feature: { type: 'string', enum: RATING_FEATURES },
            score: { type: 'integer', minimum: 1, maximum: 5 },
            comment: nullableString,
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!getProperty(db, id)) return notFound(reply);
      const { feature, score } = request.body;

      const info = db
        .prepare('INSERT INTO ratings (property_id, by, feature, score, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, request.user.id, feature, score, str(request.body.comment), nowIso());

      // SPEC §2: quiet or privacy ≤ 2 is a red flag, which also drops the villa's flag.
      if ((feature === 'quiet' || feature === 'privacy') && score <= 2) {
        addRedFlags(db, id, [`${feature}_low`]);
      } else {
        rescoreOne(db, id);
      }

      const rating = db.prepare('SELECT * FROM ratings WHERE id = ?').get(Number(info.lastInsertRowid));
      return withByName(db, [rating])[0];
    }
  );

  // --- feedback -----------------------------------------------------------
  app.post(
    '/api/properties/:id/feedback',
    {
      ...auth,
      schema: {
        params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        body: {
          type: 'object', additionalProperties: false, required: ['text'],
          properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!getProperty(db, id)) return notFound(reply);
      const info = db
        .prepare('INSERT INTO feedback (property_id, by, text, applied, created_at) VALUES (?, ?, ?, 0, ?)')
        .run(id, request.user.id, request.body.text, nowIso());
      const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(Number(info.lastInsertRowid));
      return withByName(db, [row])[0];
    }
  );

  // --- agent info ---------------------------------------------------------
  app.post(
    '/api/properties/:id/agent-info',
    {
      ...auth,
      schema: {
        params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            contact_id: { type: ['integer', 'null'] },
            date: nullableString,
            lease_terms: nullableString,
            deposit: nullableString,
            payment_schedule: nullableString,
            included: {}, // object → JSON, string kept as-is, null cleared (ajv union types warn)
            neighbours: nullableString,
            planned_builds: nullableString,
            water_power: nullableString,
            other: nullableString,
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!getProperty(db, id)) return notFound(reply);
      const b = request.body || {};

      const included = b.included == null ? null : typeof b.included === 'object' ? JSON.stringify(b.included) : String(b.included);
      const info = db
        .prepare(
          `INSERT INTO agent_info
             (property_id, contact_id, by, date, lease_terms, deposit, payment_schedule, included,
              neighbours, planned_builds, water_power, other, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id, b.contact_id ?? null, request.user.id, str(b.date) || todayIso(),
          str(b.lease_terms), str(b.deposit), str(b.payment_schedule), included,
          str(b.neighbours), str(b.planned_builds), str(b.water_power), str(b.other), nowIso()
        );

      if (mentionsConstruction([b.neighbours, b.planned_builds], getConfig(db))) {
        addRedFlags(db, id, ['construction']);
      } else {
        rescoreOne(db, id);
      }

      const row = db.prepare('SELECT * FROM agent_info WHERE id = ?').get(Number(info.lastInsertRowid));
      return { ...withByName(db, [row])[0], included: safeJson(row.included) };
    }
  );

  // --- viewings (JSON or multipart) ---------------------------------------
  /** Shared validator: multipart fields arrive as strings, so schemas can't do this job. */
  function readViewing(input) {
    const out = { date: str(input.date) || todayIso() };

    const timeOfDay = str(input.time_of_day);
    if (timeOfDay && !TIMES_OF_DAY.includes(timeOfDay)) return { error: `time_of_day must be one of ${TIMES_OF_DAY.join(', ')}` };
    out.time_of_day = timeOfDay;

    for (const key of VIEWING_SCALES) {
      const n = int(input[key]);
      if (Number.isNaN(n)) return { error: `${key} must be an integer 1–5 or null` };
      if (n !== null && (n < 1 || n > 5)) return { error: `${key} must be 1–5` };
      out[key] = n;
    }

    const beachMinutes = int(input.beach_minutes);
    if (Number.isNaN(beachMinutes) || (beachMinutes !== null && beachMinutes < 0)) {
      return { error: 'beach_minutes must be a non-negative integer' };
    }
    out.beach_minutes = beachMinutes;

    out.notes = str(input.notes);

    const verdict = str(input.verdict);
    if (verdict && !VERDICTS.includes(verdict)) return { error: `verdict must be one of ${VERDICTS.join(', ')}` };
    out.verdict = verdict;

    return { value: out };
  }

  app.post('/api/properties/:id/viewings', auth, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return badRequest(reply, 'id must be an integer');
    if (!getProperty(db, id)) return notFound(reply);

    let input = {};
    let files = [];
    if (typeof request.isMultipart === 'function' && request.isMultipart()) {
      const parsed = await readMultipart(request);
      input = parsed.fields;
      files = parsed.files;
    } else {
      input = request.body || {};
      if (typeof input !== 'object' || Array.isArray(input)) return badRequest(reply, 'body must be an object');
    }

    const known = new Set(['date', 'time_of_day', ...VIEWING_SCALES, 'beach_minutes', 'notes', 'verdict', 'photos']);
    const unknown = Object.keys(input).filter((k) => !known.has(k));
    if (unknown.length) return badRequest(reply, `unknown field: ${unknown.join(', ')}`);

    const checked = readViewing(input);
    if (checked.error) return badRequest(reply, checked.error);
    const v = checked.value;

    const info = db
      .prepare(
        `INSERT INTO viewings
           (property_id, by, date, time_of_day, quiet, privacy, living_room, light, breeze,
            overlooked, construction_nearby, beach_minutes, notes, photos, verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id, request.user.id, v.date, v.time_of_day, v.quiet, v.privacy, v.living_room, v.light,
        v.breeze, v.overlooked, v.construction_nearby, v.beach_minutes, v.notes, null, v.verdict, nowIso()
      );
    const viewingId = Number(info.lastInsertRowid);

    const photos = [];
    for (let i = 0; i < files.length; i++) {
      try {
        const saved = await saveImage(imagesDir, id, `v${viewingId}-${i + 1}.jpg`, files[i].buffer);
        photos.push(saved.file);
      } catch (err) {
        request.log?.warn?.({ err }, 'viewing photo failed');
      }
    }
    if (photos.length) db.prepare('UPDATE viewings SET photos = ? WHERE id = ?').run(JSON.stringify(photos), viewingId);

    // SPEC §5: a visit sets `assessed` (partly → done when a verdict is given). Never
    // downgrades a row already marked done — a later note-only visit is not a regression.
    const current = getProperty(db, id);
    const assessed = v.verdict ? 'done' : current.assessed === 'done' ? 'done' : 'partly';
    db.prepare('UPDATE properties SET assessed = ? WHERE id = ?').run(assessed, id);

    const flags = [];
    if (v.quiet != null && v.quiet <= 2) flags.push('quiet_low');
    if (v.privacy != null && v.privacy <= 2) flags.push('privacy_low');
    if (v.construction_nearby != null && v.construction_nearby >= 4) flags.push('construction');
    if (flags.length) addRedFlags(db, id, flags);
    else rescoreOne(db, id);

    const row = db.prepare('SELECT * FROM viewings WHERE id = ?').get(viewingId);
    const shaped = withByName(db, [row])[0];
    return {
      ...shaped,
      photos: jsonArray(row.photos),
      photo_urls: jsonArray(row.photos).map((f) => `/images/${f}`),
    };
  });

  // --- contacts on a property ---------------------------------------------
  app.post(
    '/api/properties/:id/contacts',
    {
      ...auth,
      schema: {
        params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            name: nullableString,
            role: { type: ['string', 'null'], enum: [...CONTACT_ROLES, null] },
            phone: nullableString,
            whatsapp: nullableString,
            email: nullableString,
            agency: nullableString,
            instagram: nullableString,
            notes: nullableString,
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!getProperty(db, id)) return notFound(reply);
      const b = request.body || {};
      const whatsapp = b.whatsapp ? normaliseWhatsapp(b.whatsapp) : null;

      // The unique index on whatsapp is the identity rule: same number, same person.
      let contact = whatsapp ? db.prepare('SELECT * FROM contacts WHERE whatsapp = ?').get(whatsapp) : null;
      if (!contact) {
        const info = db
          .prepare(
            `INSERT INTO contacts (name, role, phone, whatsapp, email, agency, instagram, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(str(b.name), str(b.role), str(b.phone), whatsapp, str(b.email), str(b.agency), str(b.instagram), str(b.notes), nowIso());
        contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(info.lastInsertRowid));
      }

      db.prepare('INSERT OR IGNORE INTO property_contacts (property_id, contact_id) VALUES (?, ?)').run(id, contact.id);
      return contact;
    }
  );

  // --- image upload --------------------------------------------------------
  app.post('/api/properties/:id/images', auth, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return badRequest(reply, 'id must be an integer');
    const row = getProperty(db, id);
    if (!row) return notFound(reply);
    if (typeof request.isMultipart !== 'function' || !request.isMultipart()) {
      return badRequest(reply, 'multipart/form-data required');
    }

    const { files } = await readMultipart(request);
    if (!files.length) return badRequest(reply, 'no files');

    const images = jsonArray(row.images);
    let next = images.reduce((max, img) => {
      const m = /\/u(\d+)\.jpg$/.exec(String(img?.file || ''));
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);

    for (const file of files) {
      next += 1;
      try {
        const saved = await saveImage(imagesDir, id, `u${next}.jpg`, file.buffer);
        images.push({ src_url: null, file: saved.file, w: saved.w, h: saved.h, by: request.user.id });
      } catch (err) {
        next -= 1;
        request.log?.warn?.({ err }, 'image upload failed');
      }
    }

    const hero = row.hero_file || images.find((i) => i.file)?.file || null;
    db.prepare('UPDATE properties SET images = ?, hero_file = ? WHERE id = ?').run(JSON.stringify(images), hero, id);

    return { images, hero_url: hero ? `/images/${hero}` : null };
  });

  // --- contacts ------------------------------------------------------------
  app.get('/api/contacts', auth, async () => {
    const contacts = db.prepare('SELECT * FROM contacts ORDER BY id').all();
    if (!contacts.length) return [];
    const links = db
      .prepare(
        `SELECT pc.contact_id AS contact_id, p.id AS id, p.title AS title
           FROM property_contacts pc JOIN properties p ON p.id = pc.property_id
          ORDER BY p.id`
      )
      .all();
    const byContact = new Map();
    for (const l of links) {
      if (!byContact.has(l.contact_id)) byContact.set(l.contact_id, []);
      byContact.get(l.contact_id).push({ id: l.id, title: l.title });
    }
    return contacts.map((c) => ({ ...c, properties: byContact.get(c.id) || [] }));
  });

  app.patch(
    '/api/contacts/:id',
    {
      ...auth,
      schema: {
        params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            name: nullableString,
            role: { type: ['string', 'null'], enum: [...CONTACT_ROLES, null] },
            phone: nullableString,
            whatsapp: nullableString,
            email: nullableString,
            agency: nullableString,
            instagram: nullableString,
            responsiveness: { type: ['integer', 'null'], minimum: 1, maximum: 5 },
            notes: nullableString,
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const existing = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
      if (!existing) return notFound(reply);

      const b = request.body;
      const sets = {};
      for (const f of [...CONTACT_FIELDS, 'responsiveness']) {
        if (!(f in b)) continue;
        sets[f] = f === 'whatsapp' ? (b.whatsapp ? normaliseWhatsapp(b.whatsapp) : null) : b[f];
      }

      const cols = Object.keys(sets);
      if (cols.length) {
        db.prepare(`UPDATE contacts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
          .run(...cols.map((c) => sets[c]), id);
      }
      return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
    }
  );
}
