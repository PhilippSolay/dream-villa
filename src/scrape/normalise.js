// SPEC §6 "Normalise" + §7 area map. Pure functions, zero dependencies.
// Nothing here touches the database and nothing here writes person fields.

import { AREAS } from '../areas.js';
import { DEFAULT_CONFIG } from '../defaults.js';

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const MULTIPLIERS = {
  jt: 1e6,
  juta: 1e6,
  m: 1e6, // "450 M/year" — million, the Indonesian listing convention
  b: 1e9,
  bn: 1e9,
  miliar: 1e9,
  milyar: 1e9,
};

const PERIODS = {
  month: 'month', months: 'month', monthly: 'month', mo: 'month', mth: 'month',
  bln: 'month', bulan: 'month',
  year: 'year', years: 'year', yearly: 'year', yr: 'year', annually: 'year', annum: 'year',
  thn: 'year', tahun: 'year',
};

const PERIOD_ALT = Object.keys(PERIODS).sort((a, b) => b.length - a.length).join('|');
const UNIT_ALT = Object.keys(MULTIPLIERS).sort((a, b) => b.length - a.length).join('|');

/** `IDR 40.000.000 / mo`, `Rp 40jt/bln`, `450 M / year`, `40,000,000 per month`, `1.2B/year`. */
const PRICE_WITH_PERIOD_RE = new RegExp(
  '(idr|rp\\.?)?\\s*' + //               optional currency (captured)
    '(\\d[\\d.,]*)' + //                 amount
    `\\s*(${UNIT_ALT})?` + //            optional jt / juta / M / B …
    '\\s*(?:\\/|per\\s+|a\\s+)?\\s*' + // separator: "/", "per ", "a "
    `(${PERIOD_ALT})\\b`, //             period
  'i'
);

/** Below this, a currency-less bare number is prose, not money. */
const MIN_BARE_AMOUNT = 1000;

/** A bare amount with an explicit currency and no period, e.g. a leasehold price. */
const PRICE_NO_PERIOD_RE = new RegExp(`(?:idr|rp\\.?)\\s*(\\d[\\d.,]*)\\s*(${UNIT_ALT})?\\b`, 'i');

/**
 * "40.000.000" / "40,000,000" → 40000000 (thousands separators),
 * "1.2" / "1,5" → 1.2 / 1.5 (decimal). Rule: a separator followed by exactly
 * three digits is a thousands separator, anything else is a decimal point.
 */
function parseAmount(token) {
  const seps = [...String(token).matchAll(/[.,]/g)];
  if (seps.length === 0) return Number(token);
  const last = seps[seps.length - 1].index;
  const tail = token.slice(last + 1);
  if (/^\d{3}$/.test(tail)) return Number(token.replace(/[.,]/g, '')); // all thousands
  return Number(token.slice(0, last).replace(/[.,]/g, '') + '.' + tail);
}

/**
 * @param {string} text
 * @returns {{amount:number, per:'month'|'year'|null}|null}
 */
export function parsePrice(text) {
  const s = String(text || '');
  const m = PRICE_WITH_PERIOD_RE.exec(s);
  if (m) {
    const mult = m[3] ? MULTIPLIERS[m[3].toLowerCase()] : 1;
    const amount = Math.round(parseAmount(m[2]) * mult);
    // A bare small number next to a period word is prose ("Minimum 3 months rental"),
    // not a price: demand a currency marker, a multiplier, or a plausible magnitude.
    if (m[1] || m[3] || amount >= MIN_BARE_AMOUNT) {
      return { amount, per: PERIODS[m[4].toLowerCase()] };
    }
  }
  const n = PRICE_NO_PERIOD_RE.exec(s);
  if (n) {
    const mult = n[2] ? MULTIPLIERS[n[2].toLowerCase()] : 1;
    return { amount: Math.round(parseAmount(n[1]) * mult), per: null };
  }
  return null;
}

/**
 * CLAUDE.md: yearly prices normalise to a monthly equivalent, never the reverse.
 * @returns {{price_month_idr:number|null, price_year_idr:number|null}}
 */
export function normalisePrice({ price_month_idr = null, price_year_idr = null } = {}) {
  const year = price_year_idr == null ? null : Math.round(price_year_idr);
  let month = price_month_idr == null ? null : Math.round(price_month_idr);
  if (month == null && year != null) month = Math.round(year / 12);
  return { price_month_idr: month, price_year_idr: year };
}

// ---------------------------------------------------------------------------
// Rooms, terms
// ---------------------------------------------------------------------------

/** `Bedroom: 2`, `Bedroom: >5` → 6, `3 Bedrooms`, `2BR`, `6+1 bedroom` → 6. */
export function parseBedrooms(text) {
  const s = String(text || '');
  //                       >5 ──┐  ┌── first digit  ┌── a dd/mm/yyyy glued on  ┌── further digits
  const labelled = /Bedrooms?\s*:\s*(>\s*)?(\d)(\d{2}\/\d{2}\/\d{4})?(\d*)/i.exec(s);
  if (labelled) return labelled[1] ? 6 : Number(labelled[2] + (labelled[3] ? '' : labelled[4]));
  const inline = /(\d+)\s*(?:\+\s*\d+\s*)?(?:bed\s?rooms?\b|br\b|bdr\b)/i.exec(s);
  if (inline) return Number(inline[1]);
  if (/>\s*5/.test(s)) return 6;
  return null;
}

/**
 * "Minimum 6 months rent", "Minimum rental period: 6 months", "min. 3 months",
 * "Minimum 2 years rental" → 24. "6-month rental is available" is availability,
 * not a minimum → null.
 */
export function parseMinMonths(text) {
  const s = String(text || '');
  //   min / min. / minimum … (≤30 chars of filler) … <n> month(s)|year(s)
  const m = /\bmin(?:imum|\.)?[^|.\n]{0,30}?(\d+)\s*[-–\s]?\s*(month|year|bulan|tahun)s?\b/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return /year|tahun/i.test(m[2]) ? n * 12 : n;
}

// ---------------------------------------------------------------------------
// Beach distance
// ---------------------------------------------------------------------------

const WALK_RE = /\bwalk(?:ing|s)?\b|\bon foot\b|\bstroll/i;
const BEACH_RE = /\b(?:beach|pantai)\b/i;
const BEACH_NAME_RE = /\b([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+)*)\s+Beach\b/;
const NAME_STOPWORDS = /^(?:The|A|An|To|From|Only|Just|And|At|In|Near)\s+/;

/** number [range] unit, tolerant of "5-minute", "5–10 mins", "350m". */
const DISTANCE_RE = new RegExp(
  '(\\d+(?:[.,]\\d+)?)' + //                          lower bound
    '(?:\\s*(?:[-–—]|to)\\s*(\\d+(?:[.,]\\d+)?))?' + // optional range upper bound
    '\\s*[-–—]?\\s*' + //                              "5-minute"
    '(km|kilometres?|kilometers?|minutes?|mins?|metres?|meters?|m)' +
    '(?![A-Za-z0-9²])',
  'gi'
);

const WALK_M_PER_MIN = 80;
const RIDE_M_PER_MIN = 400;
/** "walking distance to the beach", no number: walkable ≈ 1 km (assumption — SPEC gives no figure). */
const WALKING_DISTANCE_KM = 1;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function beachNameIn(...windows) {
  for (const w of windows) {
    const m = BEACH_NAME_RE.exec(w || '');
    if (m) {
      const name = m[1].replace(NAME_STOPWORDS, '').trim();
      if (name) return `${name} Beach`;
    }
  }
  return null;
}

/**
 * @param {string} text
 * @returns {{beach_km:number, beach_name:string|null}|null}
 */
export function parseBeachKm(text) {
  const s = String(text || '');
  const explicit = [];
  const timed = [];

  DISTANCE_RE.lastIndex = 0;
  for (let m; (m = DISTANCE_RE.exec(s)); ) {
    const start = m.index;
    const end = start + m[0].length;
    const before = s.slice(Math.max(0, start - 60), start);
    const after = s.slice(end, end + 70);

    // The beach reference must sit right next to the number: either just before it
    // ("Walk to the beach (350m)") or within a short, clean gap after it. A long gap,
    // or a digit / punctuation in between, means the number belongs to something else
    // ("10 minutes to Canggu and 5 mins to the beach").
    const am = BEACH_RE.exec(after);
    const gap = am ? after.slice(0, am.index) : null;
    const nearAfter = gap != null && gap.length <= 25 && !/[\d,.;!|]/.test(gap);
    const nearBefore = BEACH_RE.test(before.slice(-30));
    if (!nearAfter && !nearBefore) continue;

    const value = parseAmount(m[2] || m[1]); // a range uses the upper bound
    const unit = m[3].toLowerCase();
    const name = beachNameIn(after, before);

    if (unit.startsWith('k')) {
      explicit.push({ beach_km: round2(value), beach_name: name });
    } else if (unit === 'm' || unit.startsWith('met')) {
      explicit.push({ beach_km: round2(value / 1000), beach_name: name });
    } else {
      const walking = WALK_RE.test(before.slice(-40) + m[0] + after.slice(0, 40));
      const metres = value * (walking ? WALK_M_PER_MIN : RIDE_M_PER_MIN);
      timed.push({ beach_km: round2(metres / 1000), beach_name: name });
    }
  }

  if (explicit.length) return explicit[0];
  if (timed.length) return timed[0];

  // "Walking distance to the beach" — no number at all.
  if (
    /walking distance[^.|]{0,40}?\b(?:beach|pantai)\b/i.test(s) ||
    /\b(?:beach|pantai)\b[^.|]{0,30}?walking distance/i.test(s)
  ) {
    return { beach_km: WALKING_DISTANCE_KM, beach_name: beachNameIn(s) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Area mapping (SPEC §7)
// ---------------------------------------------------------------------------

/** The canonical Bali Home Immo location string, anchored at the END of whatever we were given. */
const LOCATION_RE =
  /(Cemagi\s*\/\s*Seseh|Pererenan|Tanah Lot Area|Uluwatu|Ungasan|Pandawa|Other Bali Area)(?:\s*-\s*(.+))?$/i;

/** URL category slug → area (the fallback when the location string is empty or garbage). */
const SLUG_AREA = {
  seseh: 'seseh',
  pererenan: 'pererenan',
  'tanah-lot-area': 'tanah_lot',
  uluwatu: 'uluwatu',
  ungasan: 'ungasan',
  pandawa: 'pandawa',
  'other-bali-area': 'other',
};

/** Inland north-Pererenan pockets — SPEC §7 puts them ≈3–5 km from the sea. */
const PERERENAN_INLAND = [
  { re: /tumbak\s*bayuh/i, name: 'Tumbak Bayuh' },
  { re: /\bbuduk\b/i, name: 'Buduk' },
  { re: /tiying\s*tutul/i, name: 'Tiying Tutul' },
];
const PERERENAN_INLAND_KM = 4;

/** Title-only area hints, used inside "Other Bali Area" and as the last fallback. */
function areaFromTitle(title) {
  const t = String(title || '');
  if (/\bbuwit\b/i.test(t)) return { area: 'buwit', sub_area: null };
  if (/\bmengwi\b/i.test(t)) return { area: 'mengwi', sub_area: null };
  if (/kaba[-\s]?kaba/i.test(t)) return { area: 'tanah_lot', sub_area: 'Kaba-Kaba' };
  if (/\bnyanyi\b/i.test(t)) return { area: 'nyanyi', sub_area: null };
  if (/\bkedungu\b/i.test(t)) return { area: 'kedungu', sub_area: null };
  if (/\bmunggu\b/i.test(t)) return { area: 'munggu', sub_area: null };
  return null;
}

function cleanSub(sub) {
  if (!sub) return null;
  const s = String(sub).replace(/[-–—\s]+$/, '').trim();
  return s || null;
}

/**
 * SPEC §7's Bali Home Immo table.
 * @param {{location?:string, title?:string, category?:string|string[]}} input
 * @returns {{area:string, sub_area:string|null, beach_km_hint:number|null}}
 */
export function mapArea({ location = '', title = '', category = '' } = {}) {
  const title_ = String(title || '');
  const loc = String(location || '').replace(/[-–—\s]+$/, '').trim();
  const hasSeseh = /\bseseh\b/i.test(title_);
  const hasMunggu = /\bmunggu\b/i.test(title_);

  const out = (area, sub_area = null, beach_km_hint = null) => ({
    area,
    sub_area: cleanSub(sub_area),
    beach_km_hint,
  });

  const m = LOCATION_RE.exec(loc);
  if (m) {
    const head = m[1].toLowerCase().replace(/\s+/g, ' ');
    const sub = cleanSub(m[2]);
    const subL = (sub || '').toLowerCase();

    if (head.startsWith('cemagi')) {
      if (hasMunggu) return out('munggu', sub);
      if (/residential/.test(subL)) return out('seseh', sub);
      // "Beach Side" and the bare string both default to cemagi; the title can say Seseh.
      return out(hasSeseh ? 'seseh' : 'cemagi', sub);
    }

    if (head === 'pererenan') {
      if (hasMunggu) return out('munggu', sub);
      for (const p of PERERENAN_INLAND) {
        if (p.re.test(title_)) return out('pererenan', p.name, PERERENAN_INLAND_KM);
      }
      return out('pererenan', sub);
    }

    if (head === 'tanah lot area') {
      if (/nyanyi/.test(subL)) return out('nyanyi', sub);
      if (/kedungu/.test(subL)) return out('kedungu', sub);
      if (/tabanan|north/.test(subL)) {
        if (/\bbuwit\b/i.test(title_)) return out('buwit', sub);
        if (/kaba[-\s]?kaba/i.test(title_)) return out('tanah_lot', 'Kaba-Kaba');
        return out('tanah_lot', sub);
      }
      if (/kaba[-\s]?kaba/i.test(title_)) return out('tanah_lot', 'Kaba-Kaba');
      return out('tanah_lot', sub);
    }

    if (head === 'uluwatu') {
      if (/bingin/.test(subL)) return out('bingin', sub);
      if (/padang\s*padang/.test(subL)) return out('padang_padang', sub);
      if (/balangan/.test(subL)) return out('balangan', sub);
      // West / Central / East Uluwatu, Pecatu, Nyang Nyang — all plain uluwatu.
      return out('uluwatu', sub);
    }

    if (head === 'ungasan') return out('ungasan', sub); // incl. Melasti
    if (head === 'pandawa') return out('pandawa', sub); // incl. Kutuh, West/East Pandawa

    if (head === 'other bali area') {
      const byTitle = areaFromTitle(title_);
      return byTitle ? out(byTitle.area, byTitle.sub_area) : out('other', sub);
    }
  }

  // Fallback: the URL category slug, then the title, then 'other'.
  const cats = Array.isArray(category) ? category : String(category || '').split(',');
  for (const c of cats) {
    const slug = String(c).trim().split('/').pop().toLowerCase();
    const area = SLUG_AREA[slug];
    if (!area) continue;
    if (area === 'other') break; // let the title decide
    if (area === 'seseh') {
      if (hasMunggu) return out('munggu');
      return out(hasSeseh ? 'seseh' : 'cemagi');
    }
    if (area === 'pererenan' && hasMunggu) return out('munggu');
    return out(area);
  }
  const byTitle = areaFromTitle(title_);
  return byTitle ? out(byTitle.area, byTitle.sub_area) : out('other');
}

// ---------------------------------------------------------------------------
// Title case
// ---------------------------------------------------------------------------

const SMALL_WORDS = new Set(['for', 'in', 'and', 'with', 'to', 'the', 'of', 'a']);

function capSegment(seg) {
  const i = seg.search(/[a-z]/i);
  if (i < 0) return seg;
  return seg.slice(0, i) + seg[i].toUpperCase() + seg.slice(i + 1).toLowerCase();
}

/** "BRAND NEW 2 BEDROOMS VILLA FOR RENTAL IN BALI - UNGASAN" → "Brand New 2 Bedrooms Villa for Rental in Bali - Ungasan" */
export function titleCase(s) {
  const words = String(s || '').trim().split(/\s+/);
  return words
    .map((word, i) => {
      if (/^rf\d+[a-z]?$/i.test(word)) return word.toUpperCase(); // keep RF refs upper
      const lower = word.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return word.split('-').map(capSegment).join('-');
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// Feature / style / red-flag keywords (SPEC §6)
// ---------------------------------------------------------------------------

const F = {
  pool: /\bpools?\b/i,
  garden: /\bgardens?\b/i,
  joglo: /\bjoglo\b/i,
  rooftop: /\broof\s?top\b/i,
  aircon: /\baircon\b|\bair[\s-]?con(?:ditioning|ditioned|ditioner)?\b/i,
  kitchen_full: /\bkitchen\b/i,
  workspace: /\boffice\b|\bworkspaces?\b|\bwork space\b|\bstudios?\b|\bshala\b|\bdesk area\b/i,
  living_open: /\bopen living\b|\bopen[\s-]plan\b|\bhigh ceilings?\b|\bspacious living\b/i,
  airy: /\bairy\b|\bbreezy\b|\blight[\s-]filled\b|\bbright\b|\bnatural light\b/i,
};
const AC_RE = /\bAC\b/; // case-sensitive: "AC" the appliance, not "ac" inside a word

const VIEWS = [
  ['ocean', /\b(?:ocean|sea|beach)\s*(?:front|view)/i],
  ['rice', /\brice\s?fields?\b|\brice\s?paddies\b|\bpaddy\b|\bricefield\b/i],
  ['river', /\briver\s*view\b|\briverside\b/i],
  ['jungle', /\bjungle\b/i],
  ['mountain', /\bmountain\s*view\b|\bvolcano\s*view\b/i],
  ['none', /\bgarden\s*view\b/i],
];

/**
 * @returns {object} booleans are `true` (keyword seen) or `null` (unknown) — never `false`,
 * because SPEC scores several unknowns at half. `furnished` is the exception: 1 / 0 / null.
 */
export function detectFeatures(text) {
  const s = String(text || '');
  const yes = (re) => (re.test(s) ? true : null);

  let view = null;
  for (const [name, re] of VIEWS) {
    if (re.test(s)) {
      view = name;
      break;
    }
  }

  let furnished = null;
  if (/\bun[\s-]?furnished\b|\bnon[\s-]?furnished\b/i.test(s)) furnished = 0;
  else if (/\bfurnished\b|\bfurniture\b/i.test(s)) furnished = 1;

  return {
    pool: yes(F.pool),
    garden: yes(F.garden),
    joglo: yes(F.joglo),
    rooftop: yes(F.rooftop),
    aircon: F.aircon.test(s) || AC_RE.test(s) ? true : null,
    kitchen_full: yes(F.kitchen_full),
    workspace: yes(F.workspace),
    living_open: yes(F.living_open),
    airy: yes(F.airy),
    view,
    furnished,
  };
}

/**
 * SPEC §6: "traditional Balinese" / "antique" / "old" flag for REVIEW rather than assert.
 * Precedence: joglo > bamboo > industrial > balinese_old > modern > tropical.
 * @returns {{style:string|null, review:boolean}}
 */
export function detectStyle(text) {
  const s = String(text || '');
  if (/\bjoglo\b/i.test(s)) return { style: 'joglo', review: false };
  if (/\bbamboo\b/i.test(s)) return { style: 'bamboo', review: false };
  if (/\bindustrial\b/i.test(s)) return { style: 'industrial', review: false };
  if (/\btraditional\s+balinese\b|\bbalinese\s+traditional\b|\bantique\b|\bold\s+(?:balinese|javanese|villa|house|joglo)\b/i.test(s)) {
    return { style: 'balinese_old', review: true };
  }
  if (/\bmodern\b|\bcontemporary\b|\bminimalist\b/i.test(s)) return { style: 'modern', review: false };
  if (/\btropical\b/i.test(s)) return { style: 'tropical', review: false };
  return { style: null, review: false };
}

function keywordRe(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const left = /^\w/.test(keyword) ? '\\b' : '';
  const right = /\w$/.test(keyword) ? '\\b' : '';
  return new RegExp(left + escaped + right, 'i');
}

/** @returns {string[]} flag names from the config keyword table. */
export function detectRedFlags(text, keywords = DEFAULT_CONFIG.red_flag_keywords) {
  const s = String(text || '');
  const flags = [];
  for (const [flag, words] of Object.entries(keywords || {})) {
    if ((words || []).some((w) => keywordRe(w).test(s))) flags.push(flag);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// The whole row
// ---------------------------------------------------------------------------

/** "2 bedroom + office", "10 +1 Bedroom", "bonus room" → one extra room. */
const EXTRA_ROOM_RE = /\+\s*1\b|\bbonus room\b|\bextra room\b|\boffice\b|\bstudios?\b|\bshala\b/i;

const asInt = (v) => (v === true ? 1 : v === false ? 0 : v == null ? null : Number(v));

/**
 * Listing facts only — never person fields (status, ratings, a person's note).
 * @param {object} input adapter output
 * @param {object} [config]
 * @returns {{row:object, hints:object}}
 */
export function normaliseListing(input, config = DEFAULT_CONFIG) {
  const src = input || {};
  const source = src.source || 'bhi';
  const ref = src.ref || null;

  const text = [src.note, src.title, src.description, src.inclusions, src.terms]
    .filter(Boolean)
    .join(' . ');

  const { area, sub_area, beach_km_hint } = mapArea({
    location: src.location,
    title: src.title,
    category: src.category ?? src.categories,
  });

  const { price_month_idr, price_year_idr } = normalisePrice({
    price_month_idr: src.price_month_idr ?? null,
    price_year_idr: src.price_year_idr ?? null,
  });

  // Text-derived beach distance wins over the computed §7 hint (SPEC §7).
  // Real pins / centroids are resolved in the seed & scrape steps, not here.
  const fromText = parseBeachKm(text);
  let beach_km = null;
  let beach_name = null;
  let beach_source = null;
  if (fromText) {
    beach_km = fromText.beach_km;
    beach_name = fromText.beach_name || AREAS[area]?.beach.name || null;
    beach_source = 'listing_text';
  } else if (beach_km_hint != null) {
    beach_km = beach_km_hint;
    beach_name = AREAS[area]?.beach.name || null;
    beach_source = 'computed';
  }

  const features = detectFeatures(text);
  const { style, review } = detectStyle(text);

  const red_flags = detectRedFlags(
    text,
    (config && config.red_flag_keywords) || DEFAULT_CONFIG.red_flag_keywords
  );
  if (style === 'balinese_old' && !review) red_flags.push('balinese_old');

  const bedrooms = src.bedrooms ?? parseBedrooms(text);
  const available_from = src.available_from ?? null;

  const row = {
    key: `${source}:${ref}`,
    ref,
    source,
    url: src.url || null,
    title: titleCase(src.title || ''),
    description: src.description ?? src.note ?? null,
    inclusions: src.inclusions ?? null,
    terms: src.terms ?? null,
    area,
    sub_area,
    beach_km,
    beach_name,
    beach_source,
    bedrooms: bedrooms == null ? null : Number(bedrooms),
    extra_rooms: EXTRA_ROOM_RE.test(text) ? 1 : 0,
    bathrooms: src.bathrooms ?? null,
    land_m2: src.land_m2 ?? null,
    build_m2: src.build_m2 ?? null,
    price_month_idr,
    price_year_idr,
    term: src.term || null,
    min_months: parseMinMonths(text),
    furnished: features.furnished,
    furniture_quality: src.furniture_quality ?? null,
    style,
    pool: asInt(features.pool),
    garden: asInt(features.garden),
    view: features.view,
    joglo: asInt(features.joglo),
    aircon: asInt(features.aircon),
    kitchen_full: asInt(features.kitchen_full),
    workspace: asInt(features.workspace),
    living_open: asInt(features.living_open),
    airy: asInt(features.airy),
    availability: available_from ? `from:${available_from}` : 'available',
    available_from,
    red_flags: JSON.stringify(red_flags),
    raw: JSON.stringify(src),
  };

  const hints = {
    style_review: review || undefined,
    rooftop: features.rooftop || undefined,
    thumb: src.thumb || undefined,
    for_sale: src.for_sale || undefined,
    newly_listed: src.newly_listed || undefined,
    beach_km_hint: beach_km_hint ?? undefined,
  };
  for (const k of Object.keys(hints)) if (hints[k] === undefined) delete hints[k];

  return { row, hints };
}

export default {
  parsePrice,
  normalisePrice,
  parseBedrooms,
  parseMinMonths,
  parseBeachKm,
  mapArea,
  titleCase,
  detectFeatures,
  detectStyle,
  detectRedFlags,
  normaliseListing,
};
