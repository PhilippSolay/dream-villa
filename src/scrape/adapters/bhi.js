// Bali Home Immo — SPEC §6 adapter (list + detail).
//
// The site is an Inertia.js app: index AND detail pages carry the whole payload as
// HTML-escaped JSON in `<div id="app" data-page="…">` (verified 2026-09-17, see
// adapters/bali-home-immo.md). We read that JSON; the card-text extractor from the
// doc stays as the proven fallback for when the shape changes.

import * as cheerio from 'cheerio';
import { parseCard, toIsoDate } from './bhi-parse.js';

const BASE = 'https://bali-home-immo.com';
const LIST_PATH = '/realestate-property/for-rent/villa';

/** Index slugs that matter (adapters/bali-home-immo.md "URL scheme"). */
export const TARGET_SLUGS = [
  'seseh',
  'pererenan',
  'tanah-lot-area',
  'uluwatu',
  'ungasan',
  'pandawa',
  'other-bali-area',
];

const TERMS = ['monthly', 'yearly'];

/** Safety stop: the doc says most areas are 1–3 pages. */
const MAX_PAGES = 10;

const MAX_IMAGES = 20;

// ---------------------------------------------------------------------------
// Inertia payload
// ---------------------------------------------------------------------------

const ENTITIES = { quot: '"', amp: '&', '#039': "'", apos: "'", lt: '<', gt: '>', nbsp: ' ' };

/** The five entities the attribute can contain; `&amp;` must be resolved last. */
function unescapeAttr(s) {
  return String(s)
    .replace(/&(quot|#039|apos|lt|gt|nbsp);/g, (_, e) => ENTITIES[e])
    .replace(/&amp;/g, '&');
}

/**
 * Pull `props` out of the Inertia `data-page` attribute.
 * @param {string} html
 * @returns {object|null}
 */
export function parseInertia(html) {
  const s = String(html || '');
  // The attribute is always double-quoted and its own value is entity-escaped,
  // so a non-greedy run up to the next `"` is safe.
  const m = /data-page="([^"]*)"/.exec(s);
  if (!m) return null;
  try {
    const page = JSON.parse(unescapeAttr(m[1]));
    return page && typeof page === 'object' && page.props ? page.props : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** "100 m²" / "93" / 93 → 93; anything unparseable → null. */
function parseM2(value) {
  if (value == null) return null;
  const m = /(\d[\d.,]*)/.exec(String(value));
  if (!m) return null;
  const n = Number(m[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** "44000000.0000" → 44000000. */
function parseMoney(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `both` when the listing offers monthly and yearly, else whichever it has. */
function termFrom(hasMonthly, hasYearly) {
  if (hasMonthly && hasYearly) return 'both';
  if (hasYearly) return 'yearly';
  if (hasMonthly) return 'monthly';
  return null;
}

const BLOCK_TAG_RE = /<\/(?:p|div|li|h[1-6]|tr|blockquote)>|<br\s*\/?>/gi;

/** Listing HTML → plain text, paragraph breaks kept as blank lines. */
export function htmlToText(html) {
  if (!html) return null;
  const text = String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(BLOCK_TAG_RE, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(quot|#039|apos|lt|gt|nbsp|amp);/g, (_, e) => ENTITIES[e])
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

/** `grouped_attributes.<group>` → `{label: value}` for easy lookup. */
function attrMap(list) {
  const out = {};
  for (const a of Array.isArray(list) ? list : []) {
    if (a && a.label != null) out[String(a.label).trim()] = a.value;
  }
  return out;
}

/** Case-insensitive, whitespace-tolerant lookup ("Dinning room", "Air Conditioner"). */
function attr(map, label) {
  const want = String(label).toLowerCase().replace(/\s+/g, ' ').trim();
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase().replace(/\s+/g, ' ').trim() === want) return v;
  }
  return undefined;
}

const YES_RE = /^(yes|available|ada)\b/i;
const NO_RE = /^(no|none|tidak)\b/i;

/** "Yes" → 1, "No" → 0, absent → null. */
function yesNo(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (YES_RE.test(s)) return 1;
  if (NO_RE.test(s)) return 0;
  return null;
}

/** generalInfo "View" → the SPEC §3 `view` vocabulary. */
export function mapView(value) {
  if (value == null || value === '') return null;
  const s = String(value).toLowerCase();
  if (/ocean|sea\b|beach/.test(s)) return 'ocean';
  if (/rice|paddy|sawah/.test(s)) return 'rice';
  if (/river/.test(s)) return 'river';
  if (/jungle|forest/.test(s)) return 'jungle';
  if (/mountain|volcano/.test(s)) return 'mountain';
  if (/garden|pool|city|street|complex|no view/.test(s)) return 'none';
  return null;
}

/** generalInfo "Style / Design" → the SPEC §3 `style` vocabulary (a hint, never asserted). */
export function mapStyle(value) {
  if (value == null || value === '') return null;
  const s = String(value).toLowerCase();
  if (/joglo/.test(s)) return 'joglo';
  if (/bamboo/.test(s)) return 'bamboo';
  if (/industrial/.test(s)) return 'industrial';
  if (/modern|contemporary|minimalist/.test(s)) return 'modern';
  if (/tropical/.test(s)) return 'tropical';
  // "Balinese" / "Traditional" is only a CANDIDATE for balinese_old (SPEC §6: flag for
  // review, do not assert). It travels in `terms` so normaliseListing's own rule decides.
  return null;
}

/** facilities "Furniture" → 1 / 0 / null. */
function furnishedFrom(value) {
  if (value == null || value === '') return null;
  const s = String(value).toLowerCase();
  if (/^un\s*-?\s*furnished|non[\s-]?furnished|not furnished|empty/.test(s)) return 0;
  if (/semi/.test(s)) return 1;
  if (/furnished/.test(s)) return 1;
  return null;
}

/** indoor "Living room": Open / Semi open → 1, Enclosed → 0, absent → null. */
function livingOpenFrom(value) {
  if (value == null || value === '') return null;
  const s = String(value).toLowerCase();
  if (/enclosed|closed/.test(s)) return 0;
  if (/open/.test(s)) return 1;
  return null;
}

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

function indexUrl(term, slug, page) {
  const base = `${BASE}${LIST_PATH}/${term}/${slug}`;
  return page > 1 ? `${base}?page=${page}` : base;
}

/** Title exactly as parseCard derives it: the URL slug minus `-rfnnnn`, hyphens → spaces. */
function titleFromSlug(slug, ref) {
  return String(slug || '')
    .replace(new RegExp(`-${String(ref).toLowerCase()}$`, 'i'), '')
    .replace(/-/g, ' ');
}

/** An index `props.properties[]` entry → the parseCard-shaped partial. */
function cardFromIndexJson(p, term, slug) {
  const ref = String(p.property_id || '').toUpperCase();
  if (!ref) return null;

  const urls = p.detail_urls && typeof p.detail_urls === 'object' ? p.detail_urls : {};
  const url = urls[term] || urls.monthly || urls.yearly || `${indexUrl(term, slug, 1)}/${p.slug}`;

  const prices = p.prices && typeof p.prices === 'object' ? p.prices : {};
  const hasMonthly = prices.monthly != null;
  const hasYearly = prices.yearly != null;

  // Bedrooms live in the per-category thumb stats, e.g. {value:'2', suffix:'bedroom(s)'}.
  const thumbStats = p.list_thumb_by_category && typeof p.list_thumb_by_category === 'object'
    ? p.list_thumb_by_category[term] || Object.values(p.list_thumb_by_category)[0] || []
    : [];
  const bedStat = (Array.isArray(thumbStats) ? thumbStats : []).find(
    (s) => s && /bedroom/i.test(String(s.label || s.name || ''))
  );

  const location = [p.area, p.subarea].filter(Boolean).join(' - ') || p.location || '';

  return {
    ref,
    url,
    title: titleFromSlug(p.slug, ref),
    location,
    note: p.label || '',
    bedrooms: bedStat ? num(bedStat.value) : null,
    available: null,
    available_from: null,
    price_month_idr: parseMoney(prices.monthly),
    price_year_idr: parseMoney(prices.yearly),
    term: termFrom(hasMonthly, hasYearly) || term,
    for_sale: prices.leasehold != null || prices.freehold != null,
    newly_listed: p.is_new === true,
    thumb: Array.isArray(p.images) ? p.images[0] || null : null,
    lat: num(p.latitude),
    lng: num(p.longitude),
    gone: p.is_archived === true,
  };
}

/**
 * Cheerio port of `extractCards` from adapters/bali-home-immo.md.
 * Walks up from each `-rfNNNN` link to the smallest ancestor holding a price AND a
 * bedroom count AND exactly one ref link (that last test is what killed the RF10336 bug).
 */
export function extractCards(html, origin = BASE) {
  const $ = cheerio.load(html);
  const seen = new Map();

  $('a[href*="/realestate-property/for-rent/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const m = /-(rf\d+[a-z]?)(?:[/?#]|$)/i.exec(href);
    if (!m) return;

    let el = a;
    let found = null;
    for (let i = 0; i < 8 && el; i++) {
      const $el = $(el);
      const t = $el.text() || '';
      if (/IDR/.test(t) && /Bedroom/i.test(t)) {
        if ($el.find('a[href*="-rf"]').length <= 1) found = $el;
        break; // several cards in this ancestor → skip the link entirely
      }
      el = $el.parent()[0];
    }
    if (!found) return;

    const ref = m[1].toUpperCase();
    if (seen.has(ref)) return;

    const text = found
      .text()
      .replace(/\s+/g, ' ')
      .replace(/SEE MORE IMAGES IN DETAIL PAGE|Previous slide|Next slide/g, '')
      .trim();
    const img = found.find('img').first();

    seen.set(ref, {
      ref,
      url: new URL(href, origin).href,
      text,
      thumb: img.attr('src') || img.attr('data-src') || null,
    });
  });

  return [...seen.values()];
}

/**
 * Every card of one index page, Inertia JSON first, card text as the fallback.
 * @returns {{cards:object[], lastPage:number|null}}
 */
function cardsFromIndex(html, term, slug) {
  const props = parseInertia(html);
  const list = props && Array.isArray(props.properties) ? props.properties : null;

  if (list && (list.length === 0 || list.some((p) => p && p.property_id))) {
    const lastPage = props.pagination && Number(props.pagination.last_page);
    return {
      cards: list.map((p) => cardFromIndexJson(p, term, slug)).filter(Boolean),
      lastPage: Number.isFinite(lastPage) ? lastPage : null,
    };
  }

  // Fallback: the proven DOM walk + card-text parser.
  const cards = [];
  for (const raw of extractCards(html)) {
    const parsed = parseCard({ ...raw, categories: [`${term}/${slug}`] });
    if (parsed.dirty) continue;
    cards.push(parsed);
  }
  return { cards, lastPage: null };
}

/**
 * SPEC §6 `list`: yields one partial listing per card across term × area × page.
 * Refs are deduped across the whole run — a villa found under monthly AND yearly
 * is yielded once with `term: 'both'`.
 */
async function* list(ctx, { areas = TARGET_SLUGS, terms = TERMS } = {}) {
  const seen = new Map(); // ref → the yielded item, so a second sighting can upgrade `term`

  for (const term of terms) {
    for (const slug of areas) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = indexUrl(term, slug, page);
        const res = await ctx.fetchHtml(url, { ttlHours: 24 });
        if (!res || !res.html) break;

        const { cards, lastPage } = cardsFromIndex(res.html, term, slug);
        if (cards.length === 0) break;

        for (const card of cards) {
          const prev = seen.get(card.ref);
          if (prev) {
            // Same villa under the other term: it offers both.
            if (prev.term !== card.term) prev.term = 'both';
            if (prev.price_month_idr == null) prev.price_month_idr = card.price_month_idr;
            if (prev.price_year_idr == null) prev.price_year_idr = card.price_year_idr;
            if (!prev.category.includes(`${term}/${slug}`)) prev.category += `,${term}/${slug}`;
            continue;
          }
          const item = { ...card, source: 'bhi', category: `${term}/${slug}` };
          seen.set(card.ref, item);
          yield item;
        }

        if (lastPage != null && page >= lastPage) break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// detail()
// ---------------------------------------------------------------------------

/**
 * SPEC §6 `detail`: one listing's facts from the Inertia JSON, shaped for
 * `normaliseListing`. Returns null on 404 or when the page has no property payload.
 */
async function detail(ctx, url) {
  const res = await ctx.fetchHtml(url, { ttlHours: 24 });
  if (!res || res.status === 404 || !res.html) return null;

  const props = parseInertia(res.html);
  const p = props && props.property;
  if (!p || !p.property_id) return null;

  return detailFromProps(props, url);
}

/** The pure half of `detail()` — everything but the fetch. Exported for tests. */
export function detailFromProps(props, url) {
  const p = props && props.property;
  if (!p || !p.property_id) return null;

  const g = p.grouped_attributes && typeof p.grouped_attributes === 'object' ? p.grouped_attributes : {};
  const general = attrMap(g.generalInfo);
  const indoor = attrMap(g.indoor);
  const outdoor = attrMap(g.outdoor);
  const facilities = attrMap(g.facilities);

  // --- prices and term ------------------------------------------------------
  let price_month_idr = null;
  let price_year_idr = null;
  for (const c of Array.isArray(p.available_categories) ? p.available_categories : []) {
    const label = String(c && c.label || '').toLowerCase();
    if (label === 'monthly') price_month_idr = parseMoney(c.price);
    else if (label === 'yearly') price_year_idr = parseMoney(c.price);
  }
  // Single-category pages carry only `price` + the page's own category.
  if (price_month_idr == null && price_year_idr == null && p.price != null) {
    const cat = String(props.propertyPriceCategory || '').toLowerCase();
    if (cat === 'yearly') price_year_idr = parseMoney(p.price);
    else if (cat === 'monthly') price_month_idr = parseMoney(p.price);
  }

  // --- rooms ----------------------------------------------------------------
  const bedrooms = num(p.bedroom) ?? num(attr(indoor, 'Bedroom'));
  const bathrooms = num(attr(indoor, 'Bathroom'));

  // --- features -------------------------------------------------------------
  const aircon = (() => {
    const n = num(attr(facilities, 'Air Conditioner'));
    if (n == null) return null;
    return n > 0 ? 1 : 0;
  })();

  const gardenRaw = attr(outdoor, 'Garden');
  const styleValue = attr(general, 'Style / Design');

  // --- inclusions -----------------------------------------------------------
  const costs = p.monthlyCosts && Array.isArray(p.monthlyCosts.items) ? p.monthlyCosts : p.yearlyCosts;
  let inclusions = null;
  if (costs && Array.isArray(costs.items) && costs.items.length) {
    inclusions = {};
    for (const it of costs.items) {
      if (it && it.label != null) inclusions[String(it.label).replace(/\s+/g, ' ').trim()] = it.value;
    }
    if (costs.remark) inclusions.remark = costs.remark;
  }

  // --- lat / lng ------------------------------------------------------------
  const lat = num(p.latitude);
  const lng = num(p.longitude);
  const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);

  // Facts that carry meaning for normaliseListing's keyword rules but have no column
  // of their own. `terms` is in normalise's text join, so the style/design string
  // reaches detectStyle and its "flag for review" rule (SPEC §6) applies as written.
  const termsText = [
    styleValue ? `Style / Design: ${styleValue}` : null,
    attr(general, 'View') ? `View: ${attr(general, 'View')}` : null,
    attr(general, 'Surrounding') ? `Surrounding: ${attr(general, 'Surrounding')}` : null,
    attr(general, 'Year of Build') ? `Year of Build: ${attr(general, 'Year of Build')}` : null,
    costs && costs.remark ? String(costs.remark) : null,
  ]
    .filter(Boolean)
    .join(' | ') || null;

  const raw = { ...p };
  delete raw.seo;
  delete raw.list_thumb_by_category;
  delete raw.grouped_attributes_by_category;

  const wa = props.meta && props.meta.wa_phone_number;

  return {
    source: 'bhi',
    ref: String(p.property_id).toUpperCase(),
    url: url || null,
    title: p.name || null,
    note: p.label || null,
    description: htmlToText(p.description),
    terms: termsText,
    location: [p.area, p.subArea].filter(Boolean).join(' - ') || null,

    bedrooms,
    bathrooms,
    land_m2: parseM2(p.land_size ?? attr(general, 'Land Size')),
    build_m2: parseM2(p.building_size ?? attr(general, 'Building Size')),

    price_month_idr,
    price_year_idr,
    term: termFrom(price_month_idr != null, price_year_idr != null),

    furnished: furnishedFrom(p.furniture ?? attr(facilities, 'Furniture')),
    pool: yesNo(attr(outdoor, 'Swimming Pool')),
    garden: gardenRaw === undefined ? null : yesNo(gardenRaw) === 1 ? 1 : null,
    view: mapView(attr(general, 'View')),
    style_hint: mapStyle(styleValue),
    living_open: livingOpenFrom(attr(indoor, 'Living room')),
    kitchen_full: attr(indoor, 'Kitchen') === undefined ? null : 1,
    aircon,

    images: (Array.isArray(p.images) ? p.images : []).slice(0, MAX_IMAGES).map((src) => ({ src_url: src })),

    lat: hasPin ? lat : null,
    lng: hasPin ? lng : null,
    pin_source: hasPin ? 'listing_map' : null,

    available_from: toIsoDate(p.availability),
    inclusions,
    gone: p.is_archived === true,
    contacts: wa ? [{ role: 'agency', name: 'Bali Home Immo', whatsapp: `+${wa}` }] : [],
    raw,
  };
}

/**
 * Overlay a detail partial's asserted facts on the row `normaliseListing` produced.
 * normaliseListing derives every feature from keywords; where the source states a
 * fact outright (pool: No, Living room: Enclosed) the statement wins, and the
 * keyword guess only fills the gaps.
 */
const ASSERTED = [
  'bathrooms', 'land_m2', 'build_m2', 'furnished', 'pool', 'garden', 'view',
  'living_open', 'kitchen_full', 'aircon',
];

export function applyDetail(row, d) {
  if (!d) return row;
  const out = { ...row };
  for (const k of ASSERTED) {
    if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  }
  if (out.style == null && d.style_hint) out.style = d.style_hint;
  if (d.lat != null && d.lng != null) {
    out.lat = d.lat;
    out.lng = d.lng;
    out.pin_source = d.pin_source || 'listing_map';
  }
  if (d.inclusions) out.inclusions = JSON.stringify(d.inclusions);
  if (Array.isArray(d.images) && d.images.length) out.images = d.images;
  if (d.gone) out.availability = 'gone';
  return out;
}

export default {
  id: 'bhi',
  name: 'Bali Home Immo',
  base: BASE,
  areas: TARGET_SLUGS,
  list,
  detail,
  // exposed for the seed / tests
  parseInertia,
  detailFromProps,
  applyDetail,
  extractCards,
};
