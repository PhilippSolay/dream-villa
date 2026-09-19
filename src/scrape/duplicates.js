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

import { haversineKm } from '../areas.js';
import { diceTrigram, sameComplexDifferentUnit } from './dedupe.js';

/** Points per signal. They add up; the total is capped at 1. */
export const SIGNALS = {
  area: 0.15,
  price5: 0.25,
  price10: 0.1,
  contact: 0.35,
  image: 0.35,
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

  const images = new Map(); // property id → Set(src_url)
  for (const row of db
    .prepare(
      `SELECT p.id AS pid, json_extract(j.value, '$.src_url') AS src
         FROM properties p,
              json_each(CASE WHEN json_valid(p.images) THEN p.images ELSE '[]' END) j
        WHERE src IS NOT NULL AND src <> ''`
    )
    .all()) {
    let set = images.get(row.pid);
    if (!set) images.set(row.pid, (set = new Set()));
    set.add(row.src);
  }

  const dismissed = new Set();
  for (const row of db.prepare('SELECT property_a, property_b FROM duplicate_dismissals').all()) {
    dismissed.add(pairKey(row.property_a, row.property_b));
  }

  return { rows, contacts, images, dismissed };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score one pair, 0–1, with the reasons that got it there.
 * Returns null when the pair can never be a duplicate (different bedrooms, same row,
 * a gone row, a dismissed pair, or two units of one complex — SPEC §6: RF9183A and
 * RF9183B are neighbours, not copies).
 */
export function scorePair(a, b, ctx = {}) {
  if (!a || !b || a.id === b.id) return null;
  if (a.bedrooms == null || b.bedrooms == null || a.bedrooms !== b.bedrooms) return null;
  if (a.availability === 'gone' || b.availability === 'gone') return null;
  if (ctx.dismissed?.has(pairKey(a.id, b.id))) return null;
  if (sameComplexDifferentUnit(a, b)) return null;

  let score = 0;
  const reasons = [];
  const add = (points, reason) => {
    score += points;
    reasons.push(reason);
  };

  if (a.area && a.area === b.area) add(SIGNALS.area, `same area ${a.area}`);

  const pa = a.price_month_idr;
  const pb = b.price_month_idr;
  if (pa != null && pb != null) {
    const max = Math.max(Math.abs(pa), Math.abs(pb));
    const gap = max ? Math.abs(pa - pb) / max : 1;
    const label = pa === pb ? `same price ${priceM(pa)}` : `price ${priceM(pa)} vs ${priceM(pb)}`;
    if (gap <= 0.05) add(SIGNALS.price5, label);
    else if (gap <= 0.1) add(SIGNALS.price10, label);
  }

  const ca = ctx.contacts?.get(a.id);
  const cb = ctx.contacts?.get(b.id);
  if (ca && cb) {
    for (const [key, label] of ca) {
      if (cb.has(key)) {
        add(SIGNALS.contact, `same ${label}`);
        break;
      }
    }
  }

  const ia = ctx.images?.get(a.id);
  const ib = ctx.images?.get(b.id);
  if (ia && ib) {
    for (const src of ia) {
      if (ib.has(src)) {
        add(SIGNALS.image, 'photo shared');
        break;
      }
    }
  }

  const sim = diceTrigram(a.title, b.title);
  if (sim >= TITLE_HIGH) add(SIGNALS.title80, `title ${sim.toFixed(2)} similar`);
  else if (sim >= TITLE_LOW) add(SIGNALS.title60, `title ${sim.toFixed(2)} similar`);

  const da = normText(a.description).slice(0, DESC_PREFIX);
  const dbb = normText(b.description).slice(0, DESC_PREFIX);
  if (da && da === dbb) add(SIGNALS.description, 'same description opening');

  if (a.land_m2 != null && a.land_m2 === b.land_m2) add(SIGNALS.land, `same land ${a.land_m2} m2`);
  if (a.build_m2 != null && a.build_m2 === b.build_m2) add(SIGNALS.build, `same build ${a.build_m2} m2`);

  if (a.lat != null && a.lng != null && b.lat != null && b.lng != null) {
    const metres = haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;
    if (metres <= PIN_METRES) add(SIGNALS.pin, `pins ${Math.round(metres)} m apart`);
  }

  if (a.poster_url && a.poster_url === b.poster_url) add(SIGNALS.poster, 'same Facebook poster');

  if (!reasons.length) return null;
  return { score: Math.min(1, Math.round(score * 1000) / 1000), reasons };
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
    const scored = scorePair(row, other, context);
    if (!scored || scored.score < minScore) continue;
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
  const out = [];
  const seen = new Set();

  for (const bucket of bucketsByBedrooms(context.rows).values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (const other of plausible(bucket[i], bucket, i + 1)) {
        const key = pairKey(bucket[i].id, other.id);
        if (seen.has(key)) continue;
        const scored = scorePair(bucket[i], other, context);
        if (!scored || scored.score < minScore) continue;
        seen.add(key);
        const [a, b] = bucket[i].id < other.id ? [bucket[i].id, other.id] : [other.id, bucket[i].id];
        out.push({ a, b, score: scored.score, reasons: scored.reasons });
      }
    }
  }

  out.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);
  return out.slice(0, limit);
}

export default { candidatesFor, allCandidates, scorePair, loadContext, SIGNALS };
