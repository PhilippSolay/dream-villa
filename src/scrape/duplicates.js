// Manual duplicate review — the human half of SPEC §6.
//
// `dedupe.js` merges only what it is certain about (same bedrooms AND same area AND
// price within 5 % AND a title/description/image match). The same villa now arrives
// from five agency scrapers and from Facebook posts where the text is rewritten, the
// photos are re-uploaded and the only stable thing is the poster's WhatsApp number —
// so plenty of real duplicates never meet that bar. This module scores the near misses
// instead of merging them, and a person decides on the detail page or the Agent page.
//
// Every signal carries its own points and its own short reason string, so the score is
// always explainable ("same WhatsApp +62…", "photo shared", "price 40 M vs 41 M").
//
// Amended 2026-09-20: photos are compared by perceptual hash as well as by `src_url`
// (`sharedImages`), because every agency and every Facebook poster re-uploads the same
// pictures. One shared photo scores `image`; two or more add `image2` on top, so two
// shared photographs alone reach 0.6 and surface on the Agent page — just under the bar
// where dedupe.js would have merged them by itself.

import { haversineKm } from '../areas.js';
import { diceProfiles, refParts, trigramProfile } from './dedupe.js';
import { countSharedImages, imageKeys } from './image-hash.js';

/** Points per signal. They add up; the total is capped at 1. */
export const SIGNALS = {
  area: 0.15,
  price5: 0.25,
  price10: 0.1,
  contact: 0.35,
  image: 0.35,
  image2: 0.25, // on top of `image` when the two listings share two or more photos
  title80: 0.2,
  title60: 0.1,
  description: 0.2,
  land: 0.1,
  build: 0.1,
  pin: 0.15,
  poster: 0.1,
};

const PRICE_BAND = 0.15; // prefilter width: nothing outside ±15 % is worth scoring
const TITLE_HIGH = 0.8;
const TITLE_LOW = 0.6;
const DESC_PREFIX = 60;
const PIN_METRES = 150;
const MIN_PHONE_DIGITS = 7;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 40_000_000 → "40 M" (the app's price idiom, SPEC §5). */
function priceM(idr) {
  if (idr == null) return '—';
  const m = Math.round((Number(idr) / 1e6) * 10) / 10;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} M`;
}

/**
 * The last nine digits of a number, so the same line written three ways — "+62 812-3456-7890"
 * by an agency, "0812 3456 7890" in a Facebook post, "62812…" by the WhatsApp reader —
 * compares equal. Nine digits is past the country code and the leading 0 in every form.
 */
function phoneKey(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  if (digits.length < MIN_PHONE_DIGITS) return null;
  return digits.length > 9 ? digits.slice(-9) : digits;
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// ---------------------------------------------------------------------------
// One read of everything the scorer needs
// ---------------------------------------------------------------------------

/**
 * Rows plus the three lookups that would otherwise be a query per pair:
 * contacts by property, image `src_url`s by property, dismissed pairs.
 */
export function loadContext(db) {
  const rows = db
    .prepare(
      `SELECT id, key, ref, source, title, description, area, sub_area, lat, lng,
              bedrooms, land_m2, build_m2, price_month_idr, availability, first_seen,
              CASE WHEN json_valid(raw) THEN json_extract(raw, '$.poster_url') END AS poster_url
         FROM properties
        WHERE availability IS NULL OR availability <> 'gone'
        ORDER BY id`
    )
    .all();

  const contacts = new Map(); // property id → Map(phone digits → label)
  for (const row of db
    .prepare(
      `SELECT pc.property_id AS pid, c.whatsapp, c.phone
         FROM property_contacts pc JOIN contacts c ON c.id = pc.contact_id`
    )
    .all()) {
    let map = contacts.get(row.pid);
    if (!map) contacts.set(row.pid, (map = new Map()));
    const wa = phoneKey(row.whatsapp);
    if (wa) map.set(wa, `WhatsApp ${row.whatsapp}`);
    const phone = phoneKey(row.phone);
    if (phone && !map.has(phone)) map.set(phone, `phone ${row.phone}`);
  }

  const images = new Map(); // property id → [{src_url, hash}] — the shape sharedImages reads
  for (const row of db
    .prepare(
      `SELECT p.id AS pid,
              json_extract(j.value, '$.src_url') AS src,
              json_extract(j.value, '$.hash') AS hash
         FROM properties p,
              json_each(CASE WHEN json_valid(p.images) THEN p.images ELSE '[]' END) j
        WHERE (src IS NOT NULL AND src <> '') OR (hash IS NOT NULL AND hash <> '')`
    )
    .all()) {
    let list = images.get(row.pid);
    if (!list) images.set(row.pid, (list = []));
    list.push({ src_url: row.src || null, hash: row.hash || null });
  }

  const dismissed = new Set();
  for (const row of db.prepare('SELECT property_a, property_b FROM duplicate_dismissals').all()) {
    dismissed.add(pairKey(row.property_a, row.property_b));
  }

  return { rows, contacts, images, dismissed };
}

// ---------------------------------------------------------------------------
// The same read, kept between requests
// ---------------------------------------------------------------------------

// loadContext reads every live row with its description, every contact and every photo
// hash: ~0.4 s on 6 000 listings, synchronous, so each detail page that asked for its
// duplicates held up every photo queued behind it. The context is kept per database and
// re-read when the fingerprint moves (a listing added, merged or gone, a contact linked,
// a pair dismissed) or after CONTEXT_TTL_MS, which bounds how stale a changed price or
// a newly hashed photo can be in a hint that only ever suggests.
export const CONTEXT_TTL_MS = 10 * 60_000;
const contexts = new WeakMap(); // db → { stamp, at, ctx }

function fingerprint(db) {
  const p = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(id) AS max_id,
              SUM(CASE WHEN availability = 'gone' THEN 1 ELSE 0 END) AS gone
         FROM properties`
    )
    .get();
  const links = db.prepare('SELECT COUNT(*) AS n FROM property_contacts').get().n;
  const dismissed = db.prepare('SELECT COUNT(*) AS n FROM duplicate_dismissals').get().n;
  return `${p.n}:${p.max_id}:${p.gone}:${links}:${dismissed}`;
}

/** loadContext, served from memory while nothing it depends on has visibly moved. */
export function cachedContext(db, { now = Date.now() } = {}) {
  const stamp = fingerprint(db);
  const hit = contexts.get(db);
  if (hit && hit.stamp === stamp && now - hit.at < CONTEXT_TTL_MS) return hit.ctx;
  const ctx = loadContext(db);
  contexts.set(db, { stamp, at: now, ctx });
  return ctx;
}

/** Forget the kept context — after a merge, whose effect the fingerprint may not see. */
export function forgetContext(db) {
  contexts.delete(db);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

// The per-listing half of the work, done once per listing and context instead of once per
// pair: the title's trigrams, the description's opening, the photo hashes as integers.
// allCandidates scores every same-bedroom pair within ±15 % — hundreds of thousands on
// 6 000 listings — and redoing this per pair took minutes (2026-09-26: Market and Agent
// held the server long enough for the health check to fail and Traefik to drop it).
const featureCache = new WeakMap(); // ctx → WeakMap(row → features)

function featuresOf(row, ctx) {
  let byRow = featureCache.get(ctx);
  if (!byRow) featureCache.set(ctx, (byRow = new WeakMap()));
  let f = byRow.get(row);
  if (!f) {
    const images = ctx.images?.get(row.id);
    f = {
      title: trigramProfile(row.title),
      ref: refParts(row.ref),
      descPrefix: normText(row.description).slice(0, DESC_PREFIX),
      images: images ? imageKeys(images) : null,
    };
    byRow.set(row, f);
  }
  return f;
}

/**
 * Score one pair, 0–1, with the reasons that got it there.
 * Returns null when the pair can never be a duplicate (different bedrooms, same row,
 * a gone row, a dismissed pair, or two units of one complex — SPEC §6: RF9183A and
 * RF9183B are neighbours, not copies).
 */
export function scorePair(a, b, ctx = {}) {
  return scoreAtLeast(a, b, ctx, -Infinity);
}

// A perfect title is worth this much; the rounding below can lift a sum by half a point.
const TITLE_MAX = SIGNALS.title80;
const ROUNDING = 0.0005;

/**
 * scorePair for the pairwise passes: null as soon as the pair cannot reach `minScore`.
 * Every other signal is a comparison or two, so the title similarity — the one that
 * costs — is skipped when even a perfect title could not lift the pair over the bar,
 * and the reason strings are only written for a pair that makes it. The sum runs in
 * scorePair's original order, so the rounded score is the same to the last digit.
 */
function scoreAtLeast(a, b, ctx, minScore) {
  if (!a || !b || a.id === b.id) return null;
  if (a.bedrooms == null || b.bedrooms == null || a.bedrooms !== b.bedrooms) return null;
  if (a.availability === 'gone' || b.availability === 'gone') return null;
  if (ctx.dismissed?.size && ctx.dismissed.has(pairKey(a.id, b.id))) return null;
  const fa = featuresOf(a, ctx);
  const fb = featuresOf(b, ctx);
  // sameComplexDifferentUnit, on refs parsed once per listing.
  if (a.source && a.source === b.source && fa.ref && fb.ref && fa.ref.stem === fb.ref.stem && fa.ref.suffix !== fb.ref.suffix) {
    return null;
  }

  const sameArea = Boolean(a.area && a.area === b.area);

  const pa = a.price_month_idr;
  const pb = b.price_month_idr;
  let pricePoints = 0;
  if (pa != null && pb != null) {
    const max = Math.max(Math.abs(pa), Math.abs(pb));
    const gap = max ? Math.abs(pa - pb) / max : 1;
    if (gap <= 0.05) pricePoints = SIGNALS.price5;
    else if (gap <= 0.1) pricePoints = SIGNALS.price10;
  }

  let contact = null;
  const ca = ctx.contacts?.get(a.id);
  const cb = ctx.contacts?.get(b.id);
  if (ca && cb) {
    for (const [key, label] of ca) {
      if (cb.has(key)) {
        contact = label;
        break;
      }
    }
  }

  const shared = fa.images && fb.images ? countSharedImages(fa.images, fb.images) : 0;
  const imagePoints = shared ? SIGNALS.image + (shared >= 2 ? SIGNALS.image2 : 0) : 0;
  const sameDescription = Boolean(fa.descPrefix && fa.descPrefix === fb.descPrefix);
  const sameLand = a.land_m2 != null && a.land_m2 === b.land_m2;
  const sameBuild = a.build_m2 != null && a.build_m2 === b.build_m2;
  let metres = null;
  if (a.lat != null && a.lng != null && b.lat != null && b.lng != null) {
    metres = haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;
  }
  const pin = metres != null && metres <= PIN_METRES;
  const poster = Boolean(a.poster_url && a.poster_url === b.poster_url);

  const withoutTitle =
    (sameArea ? SIGNALS.area : 0) + pricePoints + (contact ? SIGNALS.contact : 0) + imagePoints +
    (sameDescription ? SIGNALS.description : 0) + (sameLand ? SIGNALS.land : 0) +
    (sameBuild ? SIGNALS.build : 0) + (pin ? SIGNALS.pin : 0) + (poster ? SIGNALS.poster : 0);
  if (withoutTitle + TITLE_MAX + ROUNDING < minScore) return null;

  const sim = diceProfiles(fa.title, fb.title);
  const titlePoints = sim >= TITLE_HIGH ? SIGNALS.title80 : sim >= TITLE_LOW ? SIGNALS.title60 : 0;

  // The original order of addition (adding 0 changes nothing in floating point).
  let score = 0;
  if (sameArea) score += SIGNALS.area;
  score += pricePoints;
  if (contact) score += SIGNALS.contact;
  score += imagePoints;
  score += titlePoints;
  if (sameDescription) score += SIGNALS.description;
  if (sameLand) score += SIGNALS.land;
  if (sameBuild) score += SIGNALS.build;
  if (pin) score += SIGNALS.pin;
  if (poster) score += SIGNALS.poster;
  if (score === 0) return null; // no signal at all — every SIGNALS value is positive
  const rounded = Math.min(1, Math.round(score * 1000) / 1000);
  if (rounded < minScore) return null;

  const reasons = [];
  if (sameArea) reasons.push(`same area ${a.area}`);
  if (pricePoints) reasons.push(pa === pb ? `same price ${priceM(pa)}` : `price ${priceM(pa)} vs ${priceM(pb)}`);
  if (contact) reasons.push(`same ${contact}`);
  if (shared) reasons.push(shared === 1 ? 'photo shared' : `${shared} photos shared`);
  if (titlePoints) reasons.push(`title ${sim.toFixed(2)} similar`);
  if (sameDescription) reasons.push('same description opening');
  if (sameLand) reasons.push(`same land ${a.land_m2} m2`);
  if (sameBuild) reasons.push(`same build ${a.build_m2} m2`);
  if (pin) reasons.push(`pins ${Math.round(metres)} m apart`);
  if (poster) reasons.push('same Facebook poster');
  return { score: rounded, reasons };
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

/** Rows that could plausibly pair with `row`: same bedrooms, price within ±15 %. */
function plausible(row, bucket, from = 0) {
  const out = [];
  for (let i = from; i < bucket.length; i++) {
    const other = bucket[i];
    if (other.id === row.id) continue;
    const pa = row.price_month_idr;
    const pb = other.price_month_idr;
    if (pa == null || pb == null) {
      // No price on one side: only worth comparing inside the same area, where the
      // other signals (photo, phone, pin) have to carry the pair on their own.
      if (row.area && row.area === other.area) out.push(other);
      continue;
    }
    const max = Math.max(Math.abs(pa), Math.abs(pb));
    if (max === 0 || Math.abs(pa - pb) / max <= PRICE_BAND) out.push(other);
  }
  return out;
}

function bucketsByBedrooms(rows) {
  const buckets = new Map();
  for (const row of rows) {
    if (row.bedrooms == null) continue; // never pair across an unknown bedroom count
    if (!buckets.has(row.bedrooms)) buckets.set(row.bedrooms, []);
    buckets.get(row.bedrooms).push(row);
  }
  return buckets;
}

/**
 * The likely duplicates of one listing, best first.
 * @returns {{a:number, b:number, score:number, reasons:string[]}[]} `a` is always `id`.
 */
export function candidatesFor(db, id, { limit = 10, minScore = 0.5, ctx = null } = {}) {
  const context = ctx || loadContext(db);
  const row = context.rows.find((r) => r.id === Number(id));
  if (!row || row.bedrooms == null) return [];

  const bucket = bucketsByBedrooms(context.rows).get(row.bedrooms) || [];
  const out = [];
  for (const other of plausible(row, bucket)) {
    const scored = scoreAtLeast(row, other, context, minScore);
    if (!scored) continue;
    out.push({ a: row.id, b: other.id, score: scored.score, reasons: scored.reasons });
  }
  out.sort((x, y) => y.score - x.score || x.b - y.b);
  return out.slice(0, limit);
}

/**
 * Every candidate pair in the database, best first, each pair once (a < b).
 * @returns {{a:number, b:number, score:number, reasons:string[]}[]}
 */
export function allCandidates(db, { limit = 200, minScore = 0.5, ctx = null } = {}) {
  const context = ctx || loadContext(db);
  // One full pass per context: Agent (0.6) and Market (0.6) and a second visit within
  // the cached context's life all read the same list. A list scored at a lower bar
  // answers a higher one by filtering; the pass itself only runs once.
  const lists = pairLists.get(context) || [];
  let found = lists.find((l) => l.minScore <= minScore);
  if (!found) {
    found = { minScore, pairs: scoreAllPairs(context, minScore) };
    lists.push(found);
    pairLists.set(context, lists);
  }
  const pairs = found.minScore === minScore ? found.pairs : found.pairs.filter((p) => p.score >= minScore);
  return pairs.slice(0, limit);
}

const pairLists = new WeakMap(); // context → [{minScore, pairs}], each list complete and sorted

// Each bucket pairs row i only with rows after it, so every pair is met exactly once.
function scoreAllPairs(context, minScore) {
  const out = [];

  for (const bucket of bucketsByBedrooms(context.rows).values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (const other of plausible(bucket[i], bucket, i + 1)) {
        const scored = scoreAtLeast(bucket[i], other, context, minScore);
        if (!scored) continue;
        const [a, b] = bucket[i].id < other.id ? [bucket[i].id, other.id] : [other.id, bucket[i].id];
        out.push({ a, b, score: scored.score, reasons: scored.reasons });
      }
    }
  }

  out.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);
  return out;
}

export default { candidatesFor, allCandidates, scorePair, loadContext, cachedContext, forgetContext, SIGNALS };
