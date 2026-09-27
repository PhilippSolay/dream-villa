// SPEC §3 (properties + runs tables), §6 "Dedupe intro" / "Recheck" — synchronous
// better-sqlite3 helpers. CLAUDE.md: the scraper writes listing facts; a person's
// rating, note, status and hand-set fields are never clobbered by a re-scrape.

import { nowIso, getConfig } from '../db.js';
import { scoreRow } from './score.js';
import { forSale } from './sale.js';
import { nearestBeach } from '../areas.js';
import { mapUrl } from './pins.js';

/** `availability` values that mean the listing is off the market (SPEC §16). */
const REMOVED_AVAILABILITY = new Set(['gone', 'unlisted']);

/**
 * Fields a person can hand-edit (SPEC §4 PATCH /api/properties/:id, plus the
 * fields the scraper only ever *seeds*: pin/beach and the initial red flags).
 * The scraper may set these on INSERT; on UPDATE it must not clobber a non-null
 * existing value — except `red_flags` (always merged) and `lat`/`lng`/`pin_source`
 * (a better pin — listing_map/geocode — is allowed to replace a centroid guess).
 */
export const PERSON_FIELDS = [
  'status', 'status_by', 'status_at', 'assessed',
  'extra_rooms', 'living_open', 'airy', 'workspace', 'style',
  'beach_km', 'beach_name', 'beach_source',
  'lat', 'lng', 'pin_source', 'map_url',
  'red_flags',
];

/** Columns JSON.stringify'd on write when the incoming value is an object/array;
 *  a value that is already a JSON string (e.g. normalise.js's `raw`/`red_flags`)
 *  is stored as-is rather than double-encoded. */
const JSON_COLS = new Set(['images', 'alt_urls', 'red_flags', 'price_history', 'raw', 'inclusions']);

/** Every listing column upsertProperty may populate on INSERT (SPEC §3, minus
 *  id/first_seen/last_seen/price_history/fit_score, which are computed inline). */
const INSERT_COLUMNS = [
  'key', 'ref', 'source', 'url', 'alt_urls',
  'title', 'description', 'inclusions', 'terms',
  'area', 'sub_area', 'address', 'lat', 'lng', 'pin_source', 'map_url',
  'beach_km', 'beach_name', 'beach_source',
  'bedrooms', 'extra_rooms', 'bathrooms', 'land_m2', 'build_m2',
  'price_month_idr', 'price_year_idr', 'term', 'min_months', 'furnished', 'furniture_quality',
  'style', 'pool', 'garden', 'view', 'joglo', 'aircon', 'kitchen_full',
  'workspace', 'living_open', 'airy',
  'images', 'hero_file', 'availability', 'available_from', 'raw', 'red_flags',
  'status', 'status_by', 'status_at', 'assessed', 'scope', 'fit_score', 'flagged',
];

/** Listing-fact columns an UPDATE may overwrite outright (never a PERSON_FIELD). */
const UPDATE_FACT_COLUMNS = [
  'title', 'description', 'inclusions', 'terms', 'area', 'sub_area', 'address',
  'bedrooms', 'bathrooms', 'land_m2', 'build_m2',
  'price_month_idr', 'price_year_idr', 'term', 'min_months', 'furnished', 'furniture_quality',
  'pool', 'garden', 'view', 'joglo', 'aircon', 'kitchen_full',
  'images', 'hero_file', 'availability', 'available_from', 'raw', 'url', 'alt_urls',
];

/** PERSON_FIELDS handled with their own logic in updateProperty(), not the generic rule. */
const SPECIAL_PERSON_FIELDS = new Set(['red_flags', 'lat', 'lng', 'pin_source', 'map_url']);

const JSON_PARSE_COLS = ['images', 'alt_urls', 'red_flags', 'price_history', 'raw', 'inclusions'];

function jsonColumn(v) {
  if (v === null || v === undefined) return v ?? null;
  return typeof v === 'object' ? JSON.stringify(v) : v;
}

function safeJsonParse(v) {
  if (v === null || v === undefined || typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function parseJsonArray(v) {
  if (Array.isArray(v)) return [...v];
  const parsed = safeJsonParse(v);
  return Array.isArray(parsed) ? parsed : [];
}

function isCoord(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

/** Row with images/alt_urls/red_flags/price_history/raw/inclusions JSON-parsed. */
export function parseRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const col of JSON_PARSE_COLS) out[col] = safeJsonParse(row[col]);
  return out;
}

function insertProperty(db, row, now) {
  const cols = ['first_seen', 'last_seen', 'for_sale'];
  const vals = [row.first_seen || now, now, forSale(row)];

  for (const col of INSERT_COLUMNS) {
    if (row[col] === undefined) continue;
    cols.push(col);
    vals.push(JSON_COLS.has(col) ? jsonColumn(row[col]) : row[col]);
  }
  if (!cols.includes('red_flags')) {
    cols.push('red_flags');
    vals.push('[]');
  }
  if (row.price_month_idr != null) {
    cols.push('price_history');
    vals.push(JSON.stringify([{ date: now.slice(0, 10), price_month_idr: row.price_month_idr }]));
  }

  const sql = `INSERT INTO properties (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  const info = db.prepare(sql).run(...vals);
  return { id: Number(info.lastInsertRowid), action: 'inserted', changes: [] };
}

function updateProperty(db, existing, row, now) {
  const sets = {};
  const changes = [];

  // Listing facts: overwrite whenever the incoming value is non-null and differs.
  for (const col of UPDATE_FACT_COLUMNS) {
    if (row[col] === undefined || row[col] === null) continue;
    const newVal = JSON_COLS.has(col) ? jsonColumn(row[col]) : row[col];
    if (newVal !== existing[col]) sets[col] = newVal;
  }

  // Price history + change log.
  if (row.price_month_idr != null && row.price_month_idr !== existing.price_month_idr) {
    changes.push({ what: 'price', from: existing.price_month_idr, to: row.price_month_idr });
    const history = parseJsonArray(existing.price_history);
    history.push({ date: now.slice(0, 10), price_month_idr: row.price_month_idr });
    sets.price_history = JSON.stringify(history);
  }

  // Gone / back-on-market transition.
  if (row.availability != null && row.availability !== existing.availability) {
    const wasGone = existing.availability === 'gone';
    const isGone = row.availability === 'gone';
    if (wasGone !== isGone) changes.push({ what: 'gone' });
  }

  // Back on the market: the source is showing it again, so the removal on record is
  // over. The row keeps its history (first_seen, price_history); only the archive
  // stamp is cleared, and `sets.availability` above has already been overwritten with
  // whatever the source now says. A person-set `status = 'gone'` is theirs and stays.
  if (REMOVED_AVAILABILITY.has(existing.availability) && row.availability != null && !REMOVED_AVAILABILITY.has(row.availability)) {
    sets.removed_at = null;
    sets.removed_reason = null;
  }

  // Person fields: only fill a hole (existing is null); the scraper never overwrites a set value.
  // A null/undefined incoming value has nothing to contribute, so it's skipped rather than
  // writing null-over-null (which would falsely mark the row as changed).
  for (const key of PERSON_FIELDS) {
    if (SPECIAL_PERSON_FIELDS.has(key)) continue;
    if (row[key] == null) continue;
    if (existing[key] == null) sets[key] = row[key];
  }

  // red_flags: union of existing + incoming scraper flags, never a replace.
  const incomingFlags = row.red_flags === undefined ? [] : parseJsonArray(row.red_flags);
  if (incomingFlags.length) {
    const existingFlags = parseJsonArray(existing.red_flags);
    const merged = [...new Set([...existingFlags, ...incomingFlags])].sort();
    const currentSorted = [...existingFlags].sort();
    const same = merged.length === currentSorted.length && merged.every((f, i) => f === currentSorted[i]);
    if (!same) sets.red_flags = JSON.stringify(merged);
  }

  // lat/lng/pin_source: a better pin (listing_map/geocode) replaces a centroid guess;
  // otherwise the general "only fill a hole" rule applies.
  const betterPin =
    existing.pin_source === 'centroid' &&
    (row.pin_source === 'listing_map' || row.pin_source === 'geocode') &&
    isCoord(row.lat) &&
    isCoord(row.lng);

  if (betterPin) {
    sets.lat = row.lat;
    sets.lng = row.lng;
    sets.pin_source = row.pin_source;
    sets.map_url = mapUrl(row.lat, row.lng);
    if (existing.beach_source !== 'listing_text') {
      const nearest = nearestBeach(Number(row.lat), Number(row.lng));
      if (nearest) {
        sets.beach_km = nearest.km;
        sets.beach_name = nearest.name;
        sets.beach_source = 'computed';
      }
    }
  } else {
    if (existing.lat == null && row.lat != null) sets.lat = row.lat;
    if (existing.lng == null && row.lng != null) sets.lng = row.lng;
    if (existing.pin_source == null && row.pin_source != null) sets.pin_source = row.pin_source;
    if (existing.map_url == null && row.map_url != null) sets.map_url = row.map_url;
  }

  // Derived from the text as it stands after this write (SPEC §2 "for sale").
  const sale = forSale({ title: sets.title ?? existing.title, description: sets.description ?? existing.description });
  if (sale !== existing.for_sale) sets.for_sale = sale;

  const meaningfulChange = Object.keys(sets).length > 0 || changes.length > 0;
  sets.last_seen = now;

  const setClause = Object.keys(sets).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE properties SET ${setClause} WHERE id = ?`).run(...Object.values(sets), existing.id);

  return { id: existing.id, action: meaningfulChange ? 'updated' : 'unchanged', changes };
}

/**
 * Insert a new listing or fold facts into an existing one (matched on `key`).
 * `runKind` is accepted for interface symmetry with startRun/finishRun call
 * sites but isn't otherwise used here — upsertProperty itself is run-agnostic.
 */
export function upsertProperty(db, row, { now = nowIso(), runKind = 'scrape' } = {}) {
  void runKind;
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM properties WHERE key = ?').get(row.key);
    return existing ? updateProperty(db, existing, row, now) : insertProperty(db, row, now);
  });
  return tx();
}

/**
 * Re-run scoreRow over every property and persist scope/fit_score/flagged/red_flags.
 * Scored first, written second: the write transaction holds SQLite's one write lock, and
 * with the scrape in a worker (src/jobs) the web process's own writes wait on it — so it
 * holds only the UPDATEs, not the scoring of every row.
 */
export function rescoreAll(db, config = getConfig(db)) {
  const rows = db.prepare('SELECT * FROM properties').all();
  const update = db.prepare('UPDATE properties SET scope = ?, fit_score = ?, flagged = ?, red_flags = ?, for_sale = ? WHERE id = ?');

  let in_filter = 0;
  let market = 0;
  let flagged = 0;

  const scores = rows.map((row) => {
    const scored = scoreRow(parseRow(row), config);
    if (scored.scope === 'in_filter') in_filter++;
    else market++;
    if (scored.flagged) flagged++;
    return [scored.scope, scored.fit_score, scored.flagged, JSON.stringify(scored.red_flags), forSale(row), row.id];
  });

  db.transaction(() => {
    for (const params of scores) update.run(...params);
  })();

  return { total: rows.length, in_filter, market, flagged };
}

/**
 * The source says this listing is off the market (SPEC §16). `last_seen` is deliberately
 * NOT moved: it means the last time the source actually showed us the listing, and the
 * archive needs that to say how long the villa was live before it went. `removed_at` is
 * when we found out, which is the closest we get to when it actually went.
 * @param {string} [reason] a REMOVAL_REASONS value
 */
export function markGone(db, id, now = nowIso(), reason = 'delisted') {
  // `flagged = 0` right here rather than at the next rescore: a villa that has left the
  // market must not still be Featured (SPEC §15.4).
  db.prepare('UPDATE properties SET availability = ?, removed_at = ?, removed_reason = ?, flagged = 0 WHERE id = ?')
    .run('gone', now, reason, id);
}

/**
 * Soft "no longer offered by the agent" (villa tracker filters, adjacent to SPEC §3
 * `availability`): a row of a source that ran cleanly this scrape but no longer lists
 * it, and whose `last_seen` is older than `staleDays`, is marked `unlisted` — distinct
 * from `gone`, which only the recheck sets (an explicit 404/archived page). `last_seen`
 * is left untouched (the row wasn't actually seen), and a row already `gone` or already
 * `unlisted` is left alone. A row that is seen again later resets on its own: every
 * normalised listing carries `availability: 'available'` (or `from:<date>`) by default
 * (normalise.js), and updateProperty()'s UPDATE_FACT_COLUMNS rule already overwrites a
 * differing non-null incoming value — no extra logic needed on the upsert path.
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} sourceIds sources that actually ran this scrape (never manual/fb/inbox)
 * @param {{now?:string, staleDays?:number}} [opts]
 * @returns {{n:number}} rows newly marked
 */
export function markUnlisted(db, sourceIds, { now = nowIso(), staleDays = 3 } = {}) {
  if (!sourceIds || !sourceIds.length) return { n: 0 };
  const cutoff = new Date(Date.parse(now) - staleDays * 86_400_000).toISOString();
  const info = db
    .prepare(
      `UPDATE properties SET availability = 'unlisted', removed_at = ?, removed_reason = 'unlisted', flagged = 0
        WHERE source IN (${sourceIds.map(() => '?').join(', ')})
          AND (availability IS NULL OR availability NOT IN ('gone', 'unlisted'))
          AND last_seen < ?`
    )
    .run(now, ...sourceIds, cutoff);
  return { n: info.changes };
}

export function startRun(db, kind, sources = []) {
  const info = db
    .prepare('INSERT INTO runs (started_at, kind, sources) VALUES (?, ?, ?)')
    .run(nowIso(), kind, JSON.stringify(sources));
  return Number(info.lastInsertRowid);
}

export function finishRun(
  db,
  id,
  { seen = null, new: newCount = null, updated = null, gone = null, flagged = null, notes = [], errors = [], weight_changes = null } = {}
) {
  db.prepare(
    `UPDATE runs SET finished_at = ?, seen = ?, new = ?, updated = ?, gone = ?, flagged = ?, notes = ?, errors = ?, weight_changes = ? WHERE id = ?`
  ).run(
    nowIso(),
    seen,
    newCount,
    updated,
    gone,
    flagged,
    JSON.stringify(notes || []),
    JSON.stringify(errors || []),
    weight_changes == null ? null : jsonColumn(weight_changes),
    id
  );
}

export function countsSummary(db) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM properties').get().n;
  const in_filter = db.prepare("SELECT COUNT(*) AS n FROM properties WHERE scope = 'in_filter'").get().n;
  const market = db.prepare("SELECT COUNT(*) AS n FROM properties WHERE scope = 'market'").get().n;
  const flagged = db.prepare('SELECT COUNT(*) AS n FROM properties WHERE flagged = 1').get().n;
  const gone = db.prepare("SELECT COUNT(*) AS n FROM properties WHERE availability = 'gone'").get().n;
  const by_area = db
    .prepare(
      `SELECT area, COUNT(*) AS n,
              SUM(CASE WHEN scope = 'in_filter' THEN 1 ELSE 0 END) AS n_in_filter,
              SUM(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) AS n_flagged
       FROM properties GROUP BY area ORDER BY n DESC`
    )
    .all();
  return { total, in_filter, market, flagged, gone, by_area };
}

export default { PERSON_FIELDS, parseRow, upsertProperty, rescoreAll, markGone, markUnlisted, startRun, finishRun, countsSummary };
