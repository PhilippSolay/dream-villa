// SPEC §6 "Dedupe" — the same villa listed twice (two refs, two sources, two URLs).
//
// Same `key` is handled by upsertProperty; this module finds the harder case. Two rules
// merge automatically, and a pair only has to satisfy one of them:
//
//   1. SPEC §6: bedrooms equal (both known) AND area equal AND price within 5 % AND
//      (title similarity >= 0.8 OR the first 60 chars of the description equal OR at
//      least one shared photo). The photo test is now `sharedImages` — same `src_url`
//      *or* a perceptual hash within MATCH_DISTANCE — not raw `src_url` equality.
//
//   2. Amended 2026-09-20: same area (known, not `other`) AND bedrooms compatible
//      (equal, or unknown on one side — Facebook posts rarely state them; two different
//      known counts never merge) AND at least 2 shared photos. No price condition: the
//      same villa is quoted at different prices by different agencies and in different
//      months. Two photographs of one house on two listings is the villa's identity;
//      one is not, because a complex reuses a pool shot across its units.
//
// CLAUDE.md: never delete a listing. The newer row is marked `availability='gone'`
// with `raw.merged_into` pointing at the survivor, and everything a person wrote on
// it (contacts, ratings, feedback, viewings, agent info) moves to the kept row.

import { nowIso } from '../db.js';
import { sharedImages } from './image-hash.js';

const PRICE_TOLERANCE = 0.05;
/** Photos two listings must share before rule 2 merges them without any price check. */
const AUTO_SHARED_PHOTOS = 2;
/** Sources that are people's posts, not an agency's record: they lose the keep decision. */
const POST_SOURCES = new Set(['fb', 'wa']);
const TITLE_SIMILARITY = 0.8;
const DESC_PREFIX = 60;

/** Listing facts the survivor may inherit — only where the survivor has a hole. */
const MERGE_FIELDS = [
  'title', 'description', 'inclusions', 'terms', 'sub_area', 'address',
  'lat', 'lng', 'pin_source', 'map_url', 'beach_km', 'beach_name', 'beach_source',
  'bathrooms', 'land_m2', 'build_m2', 'price_month_idr', 'price_year_idr', 'term', 'min_months',
  'furnished', 'furniture_quality', 'style', 'pool', 'garden', 'view', 'joglo', 'aircon',
  'kitchen_full', 'workspace', 'living_open', 'airy', 'images', 'hero_file',
  'availability', 'available_from',
];

/** Person-written rows that follow the villa to its surviving id. */
const CHILD_TABLES = ['ratings', 'feedback', 'viewings', 'agent_info'];

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

function normText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trigrams(s) {
  if (s.length < 3) return s ? [s] : [];
  const out = [];
  for (let i = 0; i <= s.length - 3; i++) out.push(s.slice(i, i + 3));
  return out;
}

/**
 * Sørensen–Dice coefficient over character trigrams, 0..1.
 * Multiset intersection, so a repeated trigram counts as often as both strings have it.
 */
export function diceTrigram(a, b) {
  const x = normText(a);
  const y = normText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  const ga = trigrams(x);
  const gb = trigrams(y);
  if (!ga.length || !gb.length) return 0;

  const counts = new Map();
  for (const g of ga) counts.set(g, (counts.get(g) || 0) + 1);

  let shared = 0;
  for (const g of gb) {
    const n = counts.get(g);
    if (n) {
      shared += 1;
      counts.set(g, n - 1);
    }
  }

  return (2 * shared) / (ga.length + gb.length);
}

// normText leaves only a–z, 0–9 and the space: 37 symbols, so a trigram is one integer.
const SYMBOL = (ch) => (ch === ' ' ? 36 : ch <= '9' ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 87);
function gramCode(g) {
  if (g.length === 3) return SYMBOL(g[0]) * 1369 + SYMBOL(g[1]) * 37 + SYMBOL(g[2]);
  // trigrams() hands back a one- or two-letter string whole; keep those clear of the rest.
  return 50653 + (g.length === 1 ? SYMBOL(g[0]) : 37 + SYMBOL(g[0]) * 37 + SYMBOL(g[1]));
}

/** A title normalised and cut into its trigrams once, sorted as integers, for diceProfiles. */
export function trigramProfile(text) {
  const norm = normText(text);
  const codes = Int32Array.from(trigrams(norm), gramCode).sort();
  return { norm, n: codes.length, codes };
}

/**
 * diceTrigram on two trigramProfile()s — the same number: walking two sorted lists counts
 * each trigram as often as both titles have it, the multiset intersection diceTrigram takes.
 */
export function diceProfiles(a, b) {
  if (!a.norm || !b.norm) return 0;
  if (a.norm === b.norm) return 1;
  if (!a.n || !b.n) return 0;
  const x = a.codes;
  const y = b.codes;
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      shared++;
      i++;
      j++;
    } else if (x[i] < y[j]) i++;
    else j++;
  }
  return (2 * shared) / (a.n + b.n);
}

// ---------------------------------------------------------------------------
// Candidate rules
// ---------------------------------------------------------------------------

function safeJson(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function imageUrls(row) {
  const list = safeJson(row.images);
  if (!Array.isArray(list)) return [];
  return list.map((im) => (im && typeof im === 'object' ? im.src_url : im)).filter(Boolean);
}

/** `RF9183A` → `{ stem: 'RF9183', suffix: 'A' }`; anything else → null. */
export function refParts(ref) {
  const m = /^([A-Za-z]*)(\d+)([A-Za-z]*)$/.exec(String(ref || '').trim());
  if (!m) return null;
  return { stem: `${m[1].toUpperCase()}${m[2]}`, suffix: m[3].toUpperCase() };
}

/**
 * RF9183A / RF9183B / RF9183E are separate units in one complex (adapters/bali-home-immo.md),
 * not duplicates: same source, same numeric stem, different letter suffix → never merge.
 */
export function sameComplexDifferentUnit(a, b) {
  if (!a.source || a.source !== b.source) return false;
  const ra = refParts(a.ref);
  const rb = refParts(b.ref);
  if (!ra || !rb) return false;
  return ra.stem === rb.stem && ra.suffix !== rb.suffix;
}

function priceClose(a, b) {
  const pa = a.price_month_idr;
  const pb = b.price_month_idr;
  if (pa == null || pb == null) return false;
  const max = Math.max(Math.abs(pa), Math.abs(pb));
  if (max === 0) return false;
  return Math.abs(pa - pb) <= PRICE_TOLERANCE * max;
}

/**
 * The match reason (SPEC §6 order: title, description, image) or null.
 *
 * Deviation from SPEC §6, measured against the 2026-09-17 sweep: Bali Home Immo writes
 * titles from a template ("Brand New 2 Bedrooms Villa for Monthly Rental in Bali -
 * Ungasan"), so within ONE source a Dice score over 0.8 says nothing — it matched 13
 * pairs of demonstrably different villas, none sharing an image or a description. Two
 * refs on the same agency site are that agency's own two records; a title alone is not
 * evidence. Across sources the titles are written independently, so the SPEC rule stands
 * there unchanged. Same-source pairs need the description or an image to corroborate.
 */
export function matchReason(a, b, { ignore = null } = {}) {
  const sameSource = Boolean(a.source) && a.source === b.source;

  const sim = diceTrigram(a.title, b.title);
  if (sim >= TITLE_SIMILARITY && !sameSource) return `title similarity ${sim.toFixed(2)}`;

  const da = normText(a.description).slice(0, DESC_PREFIX);
  const dbb = normText(b.description).slice(0, DESC_PREFIX);
  if (da && dbb && da === dbb) return `same first ${DESC_PREFIX} chars of description`;

  const ia = new Set(imageUrls(a));
  for (const url of imageUrls(b)) if (ia.has(url) && !ignore?.has(url)) return `shared image ${url}`;
  if (sharedImages(a.images, b.images, { ignore }).count >= 1) return 'shared image (hash)';

  return null;
}

/** `pairs` from sharedImages → `url`, `hash` or `url+hash`. */
function howLabel(pairs) {
  const url = pairs.some((p) => p.how === 'url');
  const hash = pairs.some((p) => p.how === 'hash');
  return url && hash ? 'url+hash' : url ? 'url' : 'hash';
}

/**
 * Bedrooms may not contradict: equal, or unknown on a side. Two different known counts
 * are two different villas (SPEC §6), whatever else they share.
 */
export function bedroomsCompatible(a, b) {
  return a.bedrooms == null || b.bedrooms == null || a.bedrooms === b.bedrooms;
}

/**
 * Rule 2's reason — `2 shared photos (hash)`, `3 shared photos (url+hash)` — or null
 * when the two listings share fewer than AUTO_SHARED_PHOTOS photographs.
 */
export function sharedPhotoReason(a, b, { ignore = null } = {}) {
  const { count, pairs } = sharedImages(a.images, b.images, { ignore });
  if (count < AUTO_SHARED_PHOTOS) return null;
  return `${count} shared photos (${howLabel(pairs)})`;
}

/**
 * Which row survives. An agency's or portal's record beats a Facebook/WhatsApp post
 * (structured price, bedrooms, gallery, a URL that stays valid — the post's price is
 * often a yearly figure read as monthly); otherwise the older row wins: smaller
 * first_seen, ties broken by the smaller id.
 */
export function keeperFirst(a, b) {
  const pa = POST_SOURCES.has(a.source);
  const pb = POST_SOURCES.has(b.source);
  if (pa !== pb) return pa ? [b, a] : [a, b];
  return olderFirst(a, b);
}

function olderFirst(a, b) {
  const fa = String(a.first_seen || '');
  const fb = String(b.first_seen || '');
  if (fa !== fb) return fa < fb ? [a, b] : [b, a];
  return a.id <= b.id ? [a, b] : [b, a];
}

/**
 * Candidate duplicate pairs, newest-into-oldest, without touching the database.
 * @returns {{kept_id:number, merged_id:number, reason:string}[]}
 */
/**
 * Photos that are not evidence: a hash (or url) that appears on listings in two or more
 * areas, or with two or more different known bedroom counts, is an agent's logo, collage
 * or stock shot, not a picture of one villa. A villa reposted ten times still keeps all
 * its photos as evidence (same area, same bedrooms every time).
 * @returns {Set<string>}
 */
export function promoImages(rows) {
  const seen = new Map(); // key → { areas:Set, beds:Set }
  for (const r of rows) {
    const list = safeJson(r.images);
    if (!Array.isArray(list)) continue;
    const keys = new Set();
    for (const im of list) {
      if (!im || typeof im !== 'object') continue;
      if (im.hash) keys.add(im.hash);
      if (im.src_url) keys.add(im.src_url);
    }
    for (const k of keys) {
      let e = seen.get(k);
      if (!e) seen.set(k, (e = { areas: new Set(), beds: new Set() }));
      if (r.area) e.areas.add(r.area);
      if (r.bedrooms != null) e.beds.add(r.bedrooms);
    }
  }
  const out = new Set();
  for (const [k, e] of seen) if (e.areas.size >= 2 || e.beds.size >= 2) out.add(k);
  return out;
}

export function findDuplicates(db) {
  const rows = db
    .prepare("SELECT * FROM properties WHERE availability IS NULL OR availability <> 'gone' ORDER BY id")
    .all();
  const ignore = promoImages(rows);

  // Both rules need the same area, so only rows sharing an area can ever pair up.
  // Bedrooms are checked per pair, not bucketed: rule 2 pairs a bedroom-less Facebook
  // post with a known count. An area holds a few hundred live rows, so the O(n²) inside
  // one bucket stays cheap.
  const buckets = new Map();
  for (const r of rows) {
    const k = r.area == null ? '\u0000null' : String(r.area);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }

  const out = [];
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];
        if (a.key === b.key) continue;
        if (sameComplexDifferentUnit(a, b)) continue;

        // Rule 2 — photographs, no price condition.
        let reason = null;
        if (a.area && a.area !== 'other' && bedroomsCompatible(a, b)) reason = sharedPhotoReason(a, b, { ignore });

        // Rule 1 — SPEC §6, unchanged apart from the photo test.
        if (!reason && a.bedrooms != null && a.bedrooms === b.bedrooms && priceClose(a, b)) {
          reason = matchReason(a, b, { ignore });
        }
        if (!reason) continue;

        const [keep, drop] = keeperFirst(a, b);
        out.push({ kept_id: keep.id, merged_id: drop.id, reason });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function altUrlsFor(keep, drop) {
  const existing = safeJson(keep.alt_urls);
  const dropAlts = safeJson(drop.alt_urls);
  const all = [
    ...(Array.isArray(existing) ? existing : []),
    drop.url,
    ...(Array.isArray(dropAlts) ? dropAlts : []),
  ].filter(Boolean);
  return [...new Set(all)].filter((u) => u !== keep.url);
}

function mergeOne(db, keep, drop, reason, now, by = null) {
  const sets = {};

  const alt = altUrlsFor(keep, drop);
  const altJson = JSON.stringify(alt);
  if (alt.length && altJson !== keep.alt_urls) sets.alt_urls = altJson;

  for (const col of MERGE_FIELDS) {
    if (keep[col] == null && drop[col] != null) sets[col] = drop[col];
  }
  // The survivor is still on the market as long as one of the two was.
  if (sets.availability === 'gone') delete sets.availability;

  if (Object.keys(sets).length) {
    const clause = Object.keys(sets).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE properties SET ${clause} WHERE id = ?`).run(...Object.values(sets), keep.id);
  }

  for (const table of CHILD_TABLES) {
    db.prepare(`UPDATE ${table} SET property_id = ? WHERE property_id = ?`).run(keep.id, drop.id);
  }
  db.prepare(
    'INSERT OR IGNORE INTO property_contacts (property_id, contact_id) SELECT ?, contact_id FROM property_contacts WHERE property_id = ?'
  ).run(keep.id, drop.id);
  db.prepare('DELETE FROM property_contacts WHERE property_id = ?').run(drop.id);

  let raw = safeJson(drop.raw);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = { raw: drop.raw ?? null };
  raw.merged_into = keep.id;
  raw.merged_at = now;
  raw.merged_reason = reason;
  if (by != null) raw.merged_by = by;

  // `removed_reason = 'merged'` keeps this row out of the archive (SPEC §16): it is
  // bookkeeping, not a villa that got away.
  db.prepare(
    'UPDATE properties SET availability = ?, last_seen = ?, removed_at = ?, removed_reason = ?, raw = ? WHERE id = ?'
  ).run('gone', now, now, 'merged', JSON.stringify(raw), drop.id);

  return { kept_id: keep.id, merged_id: drop.id, reason };
}

/**
 * One merge, chosen by a person: `keepId` survives, `mergeId` becomes `gone` with
 * `raw.merged_into/_by/_at`. Same machinery as the automatic pass — the only difference
 * is that the caller, not `first_seen`, decides which row is the keeper.
 *
 * @returns {{kept_id:number, merged_id:number, reason:string} | {error:string}}
 */
export function mergeInto(db, keepId, mergeId, { by = null, reason = 'merged by hand', now = nowIso() } = {}) {
  const keep = db.prepare('SELECT * FROM properties WHERE id = ?').get(keepId);
  const drop = db.prepare('SELECT * FROM properties WHERE id = ?').get(mergeId);
  if (!keep || !drop) return { error: 'not_found' };
  if (keep.id === drop.id) return { error: 'same_row' };
  if (drop.availability === 'gone') return { error: 'already_gone' };
  return db.transaction(() => mergeOne(db, keep, drop, reason, now, by))();
}

/**
 * Find and apply every duplicate merge. Never deletes a row.
 * @returns {{merged:{kept_id:number, merged_id:number, reason:string}[]}}
 */
export function dedupeAll(db, { now = nowIso() } = {}) {
  const pairs = findDuplicates(db);
  const merged = [];
  if (!pairs.length) return { merged };

  const done = new Set(); // ids already folded away in this pass
  const get = db.prepare('SELECT * FROM properties WHERE id = ?');

  db.transaction(() => {
    for (const pair of pairs) {
      if (done.has(pair.kept_id) || done.has(pair.merged_id)) continue;
      const keep = get.get(pair.kept_id);
      const drop = get.get(pair.merged_id);
      if (!keep || !drop) continue;
      if (drop.availability === 'gone') continue;
      merged.push(mergeOne(db, keep, drop, pair.reason, now));
      done.add(pair.merged_id);
    }
  })();

  return { merged };
}

export default {
  dedupeAll, findDuplicates, mergeInto, diceTrigram, matchReason, refParts,
  sameComplexDifferentUnit, bedroomsCompatible, sharedPhotoReason, promoImages, keeperFirst,
};
