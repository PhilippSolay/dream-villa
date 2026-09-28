// Apex Property (apexbali.com) — an agency added 2026-09-28. SvelteKit, server-rendered:
// `/rentals?page=N` carries 12 cards a page and, in its hydration script, the full villa
// record behind each card (area, bedrooms, monthly / 6-month / yearly IDR, status, rented
// -until date, pin, amenities). `list()` reads that payload; `detail()` reads the same
// record on `/villa/<slug>-<ref>` (all photos, the full description), with the page's
// JSON-LD `Accommodation` as the fallback. See adapters/apexbali.md.

import * as cheerio from 'cheerio';
import { MAX_IMAGES, absUrl, textOf, numberIn } from './_shared.js';
import { moneyIdr, areaFromText, subAreaFrom, beachHint, termFor, pickJsonLd } from './_shared.js';
import { stripProximity } from './livuma.js';
import { UPCOMING_MONTHS } from './umadibali.js';

const BASE = 'https://apexbali.com';
const SOURCE = 'apexbali';
const NAME = 'Apex Property';

/** The agency's one line, on every detail page as `wa.me/…` and `tel:`. */
export const AGENCY_PHONE = '+6282342194697';

/** Safety stop only: on 2026-09-28 the index held 128 villas on 11 pages. */
export const MAX_PAGES = 30;

/** Detail pages add photos and prose that hardly move; ingest's `detailPlan` busts it
 * early when the card's price, status, bedrooms or title change. */
export const DETAIL_TTL_HOURS = 24 * 7;

export const indexUrl = (page) => (page > 1 ? `${BASE}/rentals?page=${page}` : `${BASE}/rentals`);

// ---------------------------------------------------------------------------
// The SvelteKit hydration payload
// ---------------------------------------------------------------------------

/**
 * A `devalue.uneval` object literal (unquoted keys, `void 0`) → JSON text. Strings are
 * copied verbatim: devalue writes them JSON-escaped.
 */
export function literalToJson(src) {
  const s = String(src ?? '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < s.length && /[\w$]/.test(s[j])) j++;
      const word = s.slice(i, j);
      let k = j;
      while (k < s.length && /\s/.test(s[k])) k++;
      if (s[k] === ':') out += JSON.stringify(word);
      else if (word === 'void') {
        while (k < s.length && /\d/.test(s[k])) k++;
        out += 'null';
        j = k;
      } else if (word === 'undefined' || word === 'NaN' || word === 'Infinity') out += 'null';
      else out += word; // true / false / null
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The `{…}` or `[…]` starting at `start`, brackets inside strings ignored. */
function balanced(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** The value of the first `key:` in the payload whose value opens with `{` / `[`, or null. */
export function payloadValue(html, key) {
  const s = String(html || '');
  const re = new RegExp(`[{,]${key}:([\\[{])`, 'g');
  const m = re.exec(s);
  if (!m) return null;
  const lit = balanced(s, m.index + m[0].length - 1);
  if (!lit) return null;
  try {
    return JSON.parse(literalToJson(lit));
  } catch {
    return null;
  }
}

/** Index paging facts (`total`, `page`, `totalPages`), or nulls. */
export function pagingOf(html) {
  const s = String(html || '');
  const num = (k) => {
    const m = new RegExp(`[{,]${k}:(\\d+)[,}]`).exec(s);
    return m ? Number(m[1]) : null;
  };
  return { total: num('total'), page: num('page'), totalPages: num('totalPages') };
}

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

/** "…in Quiet Seseh - CM001" / "…in Umalas | EL001" → without the trailing ref. */
export function cleanTitle(name, ref) {
  let t = String(name ?? '').trim();
  if (ref) {
    const esc = ref.replace(/[-]/g, '\\-');
    t = t.replace(new RegExp(`\\s*[-–|·]\\s*${esc}\\s*$`, 'i'), '').trim();
  }
  return t || null;
}

/** "between Canggu and Umalas", "Minutes from Canggu": a neighbour, not an address. */
const NEIGHBOUR_RE = /\bbetween\s+[a-z]+(?:\s+[a-z]+)?\s+(?:and|&)\s+[a-z]+(?:\s+[a-z]+)?|\b(?:minutes?|mins?)\s+(?:from|to)\s+[a-z]+/gi;

/**
 * §7 area: the site's own `area` tag when it names one (Seseh, Cemagi, Tumbak Bayuh →
 * Pererenan, Tabanan → Tanah Lot …), else the title with neighbour phrases removed. The
 * tag "Mengwi" is the postcode district that holds Pererenan, Seseh and Cemagi, so a
 * title naming a village beats it. Kerobokan, Bengkel and "Kuta Utara" are not §7 places:
 * those villas resolve only if the title places them itself.
 * @returns {string|null}
 */
export function areaFor(siteArea, title) {
  const byTag = areaFromText(siteArea);
  if (byTag && byTag !== 'mengwi') return byTag;
  const byTitle = areaFromText(stripProximity(String(title ?? '').replace(NEIGHBOUR_RE, ' ')));
  return byTitle || byTag || null;
}

/** IDR amount or null: the site stores "not quoted" as 0 as well as null. */
const idr = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/**
 * Monthly / yearly IDR from the record. A yearly figure under six months' rent is a data
 * entry slip (LI007 and AL005 carry their monthly rent as the yearly one) and is dropped.
 */
export function pricesOf(v) {
  const month = idr(v && v.priceMonthlyIdr);
  let year = idr(v && v.priceYearlyIdr);
  if (month != null && year != null && year < month * 6) year = null;
  return { price_month_idr: month, price_year_idr: year };
}

/** ISO date + n days (UTC). */
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isoDay(now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 10);
}

function monthsAhead(iso, now) {
  const base = now instanceof Date ? now : new Date(now || Date.now());
  const b = Number.isNaN(base.getTime()) ? new Date() : base;
  return (Number(iso.slice(0, 4)) - b.getUTCFullYear()) * 12 + (Number(iso.slice(5, 7)) - 1 - b.getUTCMonth());
}

/**
 * The availability rule — Uma di Bali's (adapters/umadibali.md), so a villa "rented until"
 * reads the same whichever agency lists it:
 *
 * - `status: "available"` → live (a future `availabilityEndDate` becomes `available_from`);
 * - rented, and free again this month or within `UPCOMING_MONTHS` → live, with
 *   `available_from` = the day after `availabilityEndDate` (the site's own
 *   "Available from" line), not gone;
 * - rented with no end date ("All units taken"), or one further out (leases run to 2044)
 *   → gone.
 * @returns {{gone:boolean, rented:boolean, available_from:string|null}}
 */
export function statusOf(v, now = new Date()) {
  const rented = /^(rented|booked|taken|unavailable)$/i.test(String((v && v.status) || ''));
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String((v && v.availabilityEndDate) || '')) ? v.availabilityEndDate : null;
  const from = end ? addDays(end, 1) : null;
  const ahead = from ? monthsAhead(from, now) : null;
  // A date already reached is simply "available now".
  const future = from && from > isoDay(now) ? from : null;
  if (rented) {
    const soon = ahead != null && ahead <= UPCOMING_MONTHS;
    return { gone: !soon, rented, available_from: soon ? future : null };
  }
  return { gone: false, rented, available_from: future };
}

/** Amenity chips → the booleans they state. Absence says nothing (null), never 0. */
export function amenityFlags(list) {
  const a = (Array.isArray(list) ? list : []).map((x) => String(x).toLowerCase());
  const has = (re) => (a.some((x) => re.test(x)) ? 1 : null);
  return {
    pool: has(/\bpool\b/),
    garden: has(/\bgarden\b/),
    aircon: has(/air\s*con/),
    kitchen_full: has(/^kitchen$/),
    workspace: has(/workspace|office/),
  };
}

/** "Unfurnished" / "Fully furnished" (the field, else the title) → 0 / 1 / null. */
function furnishedOf(v, title) {
  const s = `${(v && v.furniture) || ''} ${title || ''}`;
  if (/\bun-?furnished\b/i.test(s)) return 0;
  if (/\b(?:fully|semi)?[- ]?furnished\b/i.test(s)) return 1;
  return null;
}

/** Test and placeholder records the agency's back office leaks onto the index. */
const JUNK_REF_RE = /^test/i;

/**
 * One villa record → a SPEC §6 partial. `area` is null when the villa is off-target.
 * @param {object} v the record (`id`, `slug`, `name`, `area`, prices, `status` …)
 * @param {{now?:Date|string}} [opts]
 */
export function partialFrom(v, { now = new Date() } = {}) {
  if (!v || !v.id || !v.slug) return null;
  const ref = String(v.id).trim().toUpperCase();
  if (!ref || JUNK_REF_RE.test(ref)) return null;
  if (v.purpose && v.purpose !== 'rental') return null;

  const title = cleanTitle(v.name, ref);
  const location = v.area ? String(v.area).trim() : null;
  const area = areaFor(location, title);
  const { price_month_idr, price_year_idr } = pricesOf(v);
  const status = statusOf(v, now);
  const amen = Array.isArray(v.amenities) ? v.amenities : [];
  const photos = (Array.isArray(v.photos) ? v.photos : []).map((p) => absUrl(p, BASE)).filter(Boolean);
  const lat = Number(v.lat);
  const lng = Number(v.lng);
  const hasPin = v.lat != null && v.lng != null && Number.isFinite(lat) && Number.isFinite(lng) && lat < -8 && lat > -9 && lng > 114.4 && lng < 115.8;

  const units = v.unitsTotal ? `${v.unitsFree ?? 0} of ${v.unitsTotal} units free` : null;
  const terms =
    [
      amen.length ? `Amenities: ${amen.join(', ')}` : null,
      Array.isArray(v.inclusions) && v.inclusions.length ? `Included: ${v.inclusions.join(', ')}` : null,
      v.furniture ? `Furniture: ${v.furniture}` : null,
    ]
      .filter(Boolean)
      .join(' | ') || null;

  return {
    source: SOURCE,
    ref,
    url: `${BASE}/villa/${v.slug}`,
    title,
    description: v.description ? String(v.description).trim() : null,
    terms,
    note: [status.rented ? (v.availabilityEndDate ? `Rented until ${v.availabilityEndDate}` : 'All units taken') : null, units]
      .filter(Boolean)
      .join(' · ') || null,
    area,
    sub_area: subAreaFrom(location, area),
    beach_km_hint: beachHint(area, location, title),
    location,
    bedrooms: Number.isInteger(v.bedrooms) ? v.bedrooms : numberIn(v.bedrooms),
    bathrooms: v.bathrooms == null ? null : numberIn(v.bathrooms),
    land_m2: numberIn(v.landSize),
    build_m2: numberIn(v.buildingSize) ?? numberIn(v.livingArea),
    price_month_idr,
    price_year_idr,
    term: termFor(price_month_idr, price_year_idr),
    furnished: furnishedOf(v, title),
    ...amenityFlags(amen),
    thumb: photos[0] || null,
    images: photos.slice(0, MAX_IMAGES).map((src_url) => ({ src_url })),
    lat: hasPin ? lat : null,
    lng: hasPin ? lng : null,
    pin_source: hasPin ? 'listing_map' : null,
    available_from: status.available_from,
    gone: status.gone,
    raw: {
      site_area: location,
      status: v.status ?? null,
      status_label: v.statusLabel ?? null,
      availability_end: v.availabilityEndDate ?? null,
      units_total: v.unitsTotal ?? null,
      units_free: v.unitsFree ?? null,
      price_monthly_idr: v.priceMonthlyIdr ?? null,
      price_six_month_idr: v.priceSixMonthIdr ?? null,
      price_yearly_idr: v.priceYearlyIdr ?? null,
      amenities: amen,
    },
  };
}

/** Every villa record of one `/rentals` page, as partials (`all` keeps off-target ones). */
export function cardsFrom(html, { all = false, now = new Date() } = {}) {
  const villas = payloadValue(html, 'villas');
  if (!Array.isArray(villas)) return null;
  const out = [];
  for (const v of villas) {
    const p = partialFrom(v, { now });
    if (!p) continue;
    if (!all && !p.area) continue;
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

function todayOf(ctx) {
  const n = ctx && ctx.now;
  const d = n ? new Date(n) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** A live `apexbali:<ref>` row exists (ctx.db) — only then is a rented card passed on. */
function tracking(ctx, ref) {
  const db = ctx && ctx.db;
  if (!db || typeof db.prepare !== 'function') return false;
  try {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM properties WHERE key = ?
             AND (availability IS NULL OR availability NOT IN ('gone', 'unlisted'))`
        )
        .get(`${SOURCE}:${ref}`)
    );
  } catch {
    return false;
  }
}

/** The villa-card count on a page, to tell "no payload" from "no villas". */
const cardCount = (html) => (String(html || '').match(/data-testid="villa-card"/g) || []).length;

async function* list(ctx, { now = todayOf(ctx) } = {}) {
  const seen = new Set();
  const tally = { villas: 0, yielded: 0, off_target: 0, rented_skipped: 0 };
  let totalPages = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await ctx.fetchHtml(indexUrl(page), { ttlHours: 24 });
    if (!res || !res.html) {
      if (page === 1) throw new Error('[apexbali] /rentals did not load');
      break;
    }
    const cards = cardsFrom(res.html, { all: true, now });
    if (cards == null) {
      // Cards on the page but no payload: the site changed shape. Throw so the run
      // counts the source as errored and never marks its rows unlisted on a bad day.
      if (cardCount(res.html)) throw new Error(`[apexbali] page ${page}: villa cards but no hydration payload`);
      break;
    }
    if (page === 1) totalPages = pagingOf(res.html).totalPages;

    let fresh = 0;
    for (const card of cards) {
      if (seen.has(card.ref)) continue;
      seen.add(card.ref);
      fresh++;
      tally.villas++;
      if (!card.area) {
        tally.off_target++;
        continue;
      }
      if (card.gone && !tracking(ctx, card.ref)) {
        tally.rented_skipped++;
        continue;
      }
      tally.yielded++;
      yield card;
    }
    // A page past the end repeats the last one (page=12 of 11), so "nothing new" is the
    // natural end; the payload's totalPages says so first.
    if (fresh === 0) break;
    if (totalPages != null && page >= totalPages) break;
  }

  if (ctx.log && typeof ctx.log.info === 'function') {
    ctx.log.info(
      `[apexbali] ${tally.villas} villas, ${tally.yielded} passed on, ` +
        `${tally.rented_skipped} rented (untracked) skipped, ${tally.off_target} off-target`
    );
  }
}

// ---------------------------------------------------------------------------
// detail()
// ---------------------------------------------------------------------------

/** "Rented until Dec 14, 2026" / "All 2 units taken" / "IDR 56 M /mo" off the page text. */
function visibleFacts($) {
  const text = textOf($('main')) || textOf($('body')) || '';
  const rentedUntil = (/Rented until ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(text) || [])[1] || null;
  const allTaken = /All \d+ units taken/i.test(text);
  const price = (/IDR\s*[\d.,]+\s*M\s*\/\s*(?:mo|yr)/i.exec(text) || [])[0] || null;
  return { rentedUntil, allTaken, price };
}

/**
 * JSON-LD `Accommodation` → a record shaped like the payload's, for a page whose
 * hydration script cannot be read. Only the facts the JSON-LD states.
 */
function recordFromJsonLd(html, url) {
  const ld = pickJsonLd(html, 'Accommodation')[0];
  if (!ld) return null;
  const slug = (String(ld.url || url || '').split('/villa/')[1] || '').replace(/[/?#].*$/, '') || null;
  const m = /-([a-z]{2,4}\d{2,4})$/i.exec(slug || '');
  const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers || {};
  const perMonth = /MON/i.test(String(offer.priceSpecification?.unitCode || ''));
  const inIdr = String(offer.priceCurrency || 'IDR').toUpperCase() === 'IDR';
  return {
    id: m ? m[1] : null,
    slug,
    name: ld.name,
    area: ld.address?.addressLocality || null,
    bedrooms: ld.numberOfBedrooms ?? null,
    bathrooms: ld.numberOfBathroomsTotal ?? null,
    purpose: 'rental',
    priceMonthlyIdr: inIdr && perMonth ? offer.price : null,
    priceYearlyIdr: null,
    description: ld.description || null,
    lat: ld.geo?.latitude ?? null,
    lng: ld.geo?.longitude ?? null,
    photos: Array.isArray(ld.image) ? ld.image : ld.image ? [ld.image] : [],
    status: /OutOfStock/i.test(String(offer.availability || '')) ? 'rented' : 'available',
    availabilityEndDate: null,
  };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function isoOf(text) {
  const m = /([A-Z][a-z]+) (\d{1,2}), (\d{4})/.exec(String(text || ''));
  const mo = m && MONTHS[m[1].slice(0, 3).toLowerCase()];
  return mo ? `${m[3]}-${String(mo).padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

/** The pure half of `detail()`. Exported for tests. */
export function detailFrom(html, url, { now = new Date() } = {}) {
  const $ = cheerio.load(html);
  const seen = visibleFacts($);
  let record = payloadValue(html, 'villa');
  let from = 'payload';
  if (!record || !record.id) {
    record = recordFromJsonLd(html, url);
    from = 'jsonld';
    // The page still prints the rented-until line; the JSON-LD only says OutOfStock.
    if (record && seen.rentedUntil) record.availabilityEndDate = isoOf(seen.rentedUntil);
    if (record && !record.priceMonthlyIdr && seen.price) {
      const money = moneyIdr(seen.price);
      if (money && money.per === 'month') record.priceMonthlyIdr = money.amount;
      if (money && money.per === 'year') record.priceYearlyIdr = money.amount;
    }
  }
  if (!record) return null;

  const p = partialFrom(record, { now });
  if (!p) return null;

  // "Enquire on WhatsApp" / "Call": the agency's general line, not the owner's.
  const wa = /wa\.me\/(\d{8,15})/.exec(html);
  const whatsapp = wa ? `+${wa[1]}` : AGENCY_PHONE;

  return {
    ...p,
    url: url || p.url,
    contacts: [{ role: 'agency', name: NAME, whatsapp }],
    gone: p.gone ? true : null,
    raw: { ...p.raw, from, visible: seen, blocked: (payloadValue(html, 'availability') || {}).blocked || null },
  };
}

async function detail(ctx, url, { force = false } = {}) {
  const res = await ctx.fetchHtml(url, { ttlHours: DETAIL_TTL_HOURS, force });
  if (!res || res.status === 404 || res.status === 410 || !res.html) return null;
  return detailFrom(res.html, url, { now: todayOf(ctx) });
}

/** Facts the record states outright beat normaliseListing's keyword guesses. */
const ASSERTED = ['bathrooms', 'land_m2', 'build_m2', 'furnished', 'pool', 'garden', 'kitchen_full', 'aircon', 'workspace'];

function rawOf(row) {
  try {
    return typeof row.raw === 'string' ? JSON.parse(row.raw || '{}') : row.raw || {};
  } catch {
    return {};
  }
}

export function applyDetail(row, d) {
  if (!d) return row;
  const out = { ...row };
  for (const k of ASSERTED) if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  if (d.lat != null && d.lng != null) {
    out.lat = d.lat;
    out.lng = d.lng;
    out.pin_source = d.pin_source || 'listing_map';
  }
  if (Array.isArray(d.images) && d.images.length) out.images = d.images;
  // The merged partial sits in row.raw: a rented card's verdict survives there.
  if (d.gone || rawOf(row).gone === true) out.availability = 'gone';
  return out;
}

export default {
  id: SOURCE,
  name: NAME,
  base: BASE,
  list, detail, applyDetail, cardsFrom, detailFrom, partialFrom, statusOf, areaFor,
};
