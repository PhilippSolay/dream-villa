// SPEC §6 "Normalise" + §7 area map. Pure functions, zero dependencies.
// Nothing here touches the database and nothing here writes person fields.

import { AREAS, PLACE_WORDS } from '../areas.js';
import { DEFAULT_CONFIG } from '../defaults.js';

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const MULTIPLIERS = {
  jt: 1e6,
  juta: 1e6,
  m: 1e6, // "450 M/year" — million, the Indonesian listing convention
  mil: 1e6, // "93 mil/year" — FB posts
  mill: 1e6,
  mio: 1e6,
  mln: 1e6,
  million: 1e6,
  millions: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  miliar: 1e9,
  milyar: 1e9,
};

const PERIODS = {
  month: 'month', months: 'month', monthly: 'month', mo: 'month', mth: 'month',
  bln: 'month', bulan: 'month',
  year: 'year', years: 'year', yearly: 'year', yr: 'year', annual: 'year', annually: 'year', annum: 'year',
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
// Rent in free text (Facebook posts; a harvested card's text when it has no price field)
//
// parsePrice reads one price field. A post is prose: the rent sits between an
// "Available: 28 September 2026" (the year once became a 2 026 IDR rent), a
// deposit, the pool man's fee, a leasehold price and a USD twin. parseRent reads
// every money mention on its own line, drops what is not rent, and keeps the
// first plausible monthly and yearly figure.
// ---------------------------------------------------------------------------

/**
 * Documented default when `config.usd_idr` is absent. SPEC is silent on the rate;
 * 16 000 IDR/USD is the mid-2026 ballpark and only ever gates the band check — an
 * adapter's USD price also travels verbatim in `raw.price_original`, a post's in its text.
 */
export const DEFAULT_USD_IDR = 16_000;

export function usdRate(config) {
  const n = Number(config && config.usd_idr);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_IDR;
}

const H = '[^\\S\\n]*'; // spaces and tabs: a price never runs across a line break
const RENT_UNITS = { ...MULTIPLIERS, k: 1e3, rb: 1e3, ribu: 1e3 };
const RENT_UNIT_ALT = Object.keys(RENT_UNITS).sort((a, b) => b.length - a.length).join('|');
const CURRENCY_ALT = 'idr[^\\S\\n]*\\$|idr|rp\\.?|rupiah|usd|us\\$|\\$|eur|€|aud|sgd'; // "IDR $380,000,000" is rupiah
const OTHER_PERIODS = ['night', 'nights', 'nightly', 'day', 'days', 'daily', 'week', 'weeks', 'weekly', 'hari', 'malam', 'minggu'];
const RENT_PERIOD_ALT = [...Object.keys(PERIODS), ...OTHER_PERIODS].sort((a, b) => b.length - a.length).join('|');

//   currency? amount [– amount]? unit? currency? [/ | per | a | for 1 | : ] period?
const MONEY_RE = new RegExp(
  `(?<![\\w.,])(?:(${CURRENCY_ALT})${H}:?${H})?` + //       1 currency before ("IDR: 1,200,000")
    '(\\d(?:[\\d.,]*\\d)?)' + //                          2 amount (a range keeps its lower bound)
    `(?:${H}[-–~]${H}\\d(?:[\\d.,]*\\d)?)?(?:[.,]-)?` + //  "40–45", "12.500.000,-"
    `(?:${H}(${RENT_UNIT_ALT})(?![a-z0-9²³]))?` + //       3 unit — "300 m²" and "40 months" are not money
    `(?:${H}(${CURRENCY_ALT})(?![a-z]))?` + //             4 currency after ("120 Million IDR")
    `(?:${H}(?:\\/|per|a(?=\\s)|each|for${H}(?:1|one|a)(?=\\s)|[:,–-])?${H}(${RENT_PERIOD_ALT})(?![a-z]))?`, // 5 period
  'gi'
);

/** A fee, not the rent: the word labels the amount ("Security Deposit: IDR 15,000,000"). */
const FEE_LABEL_RE =
  /\b(?:deposit|jaminan|electric\w*|listrik|pln|token|clean\w*|laundry|gardener|internet|wi-?fi|banjar|ipl|maintenance|service|fees?|tax|pajak|commission|komisi|staff|driver|water|gas)\b[^\d\n]{0,15}$/i;
/** A price to buy, a valuation or a yield: never the rent. */
const SALE_LABEL_RE =
  /\b(?:lease\s?hold|free\s?hold|sale|sell|jual|dijual|purchase|buy|investment|income|profit|revenue|return|roi|yield|value|valuation)\b[^\d\n]{0,25}$/i;
const SALE_AFTER_RE = /^[^\n]{0,25}\b(?:lease\s?hold|free\s?hold)\b/i;
/** A rate per something other than the villa-month: "/are/year", "per night", "per visit". */
const PER_UNIT_AFTER_RE = /^[^\S\n]*(?:\/|per\b|a\b)?[^\S\n]*(?:are|m2|sqm|night|day|week|person|pax|visit|kwh|hari|malam|minggu)\b/i;
/** "IDR 98M / 6 months", "650mil for 2 years", "320M IDR – 12 months upfront". */
const COUNTED_AFTER_RE = /^[^\S\n]*(?:\/|per\b|for\b|a\b|[:–—-])?[^\S\n]*(\d+|one|two|three|six)[^\S\n]*-?[^\S\n]*(?:(months?|bulan|mos?)|(years?|tahun|yrs?))\b/i;
const COUNT_WORDS = { one: 1, two: 2, three: 3, six: 6 };
/** The label in front of an amount can carry its period ("Monthly: IDR 55 Million"). */
const LABEL_PERIOD_RE =
  /\b(?:(semi[- ]?annual(?:ly)?|daily|nightly|weekly|night|day|week|harian|mingguan)|(\d+)[- ]?(?:(months?|bulan)|(years?|tahun|yrs?))|(monthly|montly|monthy|bulanan|month|bulan|mo)|(yearly|annual(?:ly)?|year|tahun(?:an)?|yr))\b/gi;
/** What may sit between that label and the amount: "Monthly Rent Price: IDR". */
const LABEL_FILLER_RE = /\b(?:rent(?:al)?|price|harga|sewa|rate|idr|rp|usd|only|lease|contract|kontrak)\b|[\s:=—–\-•*()|,.@]/gi;

const RENT_MIN = { month: 2_000_000, year: 20_000_000 };
const RENT_MAX = { month: 500_000_000, year: 5_000_000_000 };
/** A bare amount (no period anywhere) at or above this is yearly; at or above SALE_MIN, a sale price. */
const BARE_YEARLY_MIN = 100_000_000;
const BARE_SALE_MIN = 1_000_000_000;

function labelPeriod(label) {
  let last = null;
  LABEL_PERIOD_RE.lastIndex = 0;
  for (let m; (m = LABEL_PERIOD_RE.exec(label)); ) last = m;
  if (!last) return null;
  // "Monthly Rent (High Season): IDR …" — only filler may sit between label and amount.
  const between = label.slice(last.index + last[0].length).replace(/\([^)]*\)/g, '');
  if (between.replace(LABEL_FILLER_RE, '') !== '') return null;
  if (last[1]) return 'other';
  if (last[2]) return countedPeriod(Number(last[2]), Boolean(last[3]));
  return last[5] ? 'month' : 'year';
}

/** "1 month" is monthly, "12 months" or "1 year" yearly; any other count is a price for several periods. */
function countedPeriod(n, isMonths) {
  if (isMonths) return n === 1 ? 'month' : n === 12 ? 'year' : 'other';
  return n === 1 ? 'year' : 'other';
}

/**
 * A posted amount. "IDR 4,500,000.00" drops its cents. "IDR 25,000,0000", "IDR 50,00,000"
 * and "IDR 33.00.000" put their separators in the wrong places; the first group is the
 * millions the poster meant (only next to a currency: "28.09.2026" is a date).
 */
function postAmount(token, hasCurrency) {
  const groups = token.split(/[.,]/);
  if (groups.length < 3) return parseAmount(token);
  const cents = /^\d{2}$/.test(groups.at(-1)) && groups.slice(1, -1).every((g) => g.length === 3);
  const body = cents ? groups.slice(0, -1) : groups;
  if (body.slice(1).some((g) => g.length !== 3)) return hasCurrency ? Number(body[0]) * 1e6 : parseAmount(token);
  return Number(body.join(''));
}

/**
 * Every money mention in the text, as the rent it would be.
 * @returns {Array<{idr:number, per:'month'|'year'|null, currency:'IDR'|'USD'|null}>}
 */
function rentCandidates(s, config) {
  const out = [];
  MONEY_RE.lastIndex = 0;
  for (let m; (m = MONEY_RE.exec(s)); ) {
    const lineStart = s.lastIndexOf('\n', m.index) + 1;
    const label = s.slice(Math.max(lineStart, m.index - 40), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const cur = (m[1] || m[4] || '').toLowerCase();
    const currency = /^(?:idr|rp|rupiah)/.test(cur) ? 'IDR' : /^(?:usd|us\$|\$)$/.test(cur) ? 'USD' : cur ? 'other' : null;
    if (currency === 'other') continue; // a wrong rate is worse than no price
    if (FEE_LABEL_RE.test(label) || SALE_LABEL_RE.test(label)) continue;

    let per = m[5] ? PERIODS[m[5].toLowerCase()] || 'other' : null;
    if (!per) {
      // "USD 1,900,000 for 40 years leasehold" — but "25jt/month | 250jt/year — leasehold welcome" is rent.
      if (PER_UNIT_AFTER_RE.test(after) || SALE_AFTER_RE.test(after)) continue;
      const counted = COUNTED_AFTER_RE.exec(after);
      const n = counted && (COUNT_WORDS[counted[1].toLowerCase()] ?? Number(counted[1]));
      per = counted ? countedPeriod(n, Boolean(counted[2])) : labelPeriod(label);
    }
    if (per === 'other') continue;
    // An amount with no currency needs a period to be money at all: "300 m", "2026".
    if (!currency && !per) continue;

    const unit = m[3] ? RENT_UNITS[m[3].toLowerCase()] : 1;
    let amount = postAmount(m[2], Boolean(currency)) * unit;
    // "IDR 40/month", "Rp 120/tahun": Bali shorthand for millions.
    if (currency === 'IDR' && !m[3] && per && amount < 1000) amount *= 1e6;
    const idr = Math.round(currency === 'USD' ? amount * usdRate(config) : amount);
    if (!Number.isFinite(idr) || idr <= 0) continue;
    out.push({ idr, per, currency });
  }
  return out;
}

/**
 * The rent a free-text post asks, as listing fields.
 * @param {string} text
 * @param {object} [config] run config (`usd_idr`)
 * @returns {{price_month_idr?:number, price_year_idr?:number, term:'monthly'|'yearly'|'both', stated:boolean}|null}
 *   `stated`: the text itself gave the period, which is a rent signal on its own.
 */
export function parseRent(text, config = {}) {
  const s = String(text || '').normalize('NFKC'); // 𝐈𝐃𝐑 𝟔𝟔,𝟎𝟎𝟎,𝟎𝟎𝟎 → IDR 66,000,000
  const all = rentCandidates(s, config);
  const pick = (per) => {
    const ok = all.filter((c) => c.per === per && c.idr >= RENT_MIN[per] && c.idr <= RENT_MAX[per]);
    return ok.find((c) => c.currency === 'IDR') || ok[0] || null;
  };
  const year = pick('year');
  let month = pick('month');
  // "IDR 3.300.000/month" beside "IDR 310.000.000/year": a monthly figure a thirtieth
  // of the yearly one is a typo, and the yearly one is the price.
  if (month && year && year.idr > 30 * month.idr) month = null;
  if (month && year) return { price_month_idr: month.idr, price_year_idr: year.idr, term: 'both', stated: true };
  if (month) return { price_month_idr: month.idr, term: 'monthly', stated: true };
  if (year) return { price_year_idr: year.idr, term: 'yearly', stated: true };

  // No period anywhere: guess from the Bali market. Villas in the aggregation band
  // (SPEC §2) run roughly 8–80 M/month, so under 100 M reads as monthly, 100 M up to
  // 1 B as yearly, and anything larger is a price to buy.
  const bare = all.filter((c) => c.per == null && c.idr >= RENT_MIN.month && c.idr < BARE_SALE_MIN);
  const b = bare.find((c) => c.currency === 'IDR') || bare[0];
  if (!b) return null;
  return b.idr >= BARE_YEARLY_MIN
    ? { price_year_idr: b.idr, term: 'yearly', stated: false }
    : { price_month_idr: b.idr, term: 'monthly', stated: false };
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
  /(Cemagi\s*\/\s*Seseh|Pererenan|Tanah Lot Area|Canggu|Berawa|Umalas|Ubud|Uluwatu|Ungasan|Pandawa|Other Bali Area)(?:\s*-\s*(.+))?$/i;

/** URL category slug → area (the fallback when the location string is empty or garbage). */
const SLUG_AREA = {
  seseh: 'seseh',
  pererenan: 'pererenan',
  'tanah-lot-area': 'tanah_lot',
  canggu: 'canggu',
  berawa: 'berawa',
  umalas: 'umalas',
  ubud: 'ubud',
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

/**
 * Bali Home Immo files the whole belt under a broad "Canggu"; its sub-area, or the title,
 * names the village. Most specific first — Berawa is both a §7 area and a Canggu sub-area.
 */
const CANGGU_BELT = [
  { re: /\bumalas\b/i, area: 'umalas', name: 'Umalas' },
  { re: /\bbabakan\b/i, area: 'babakan', name: 'Babakan' },
  { re: /\bpadonan\b/i, area: 'padonan', name: 'Padonan' },
  { re: /\btibubeneng\b/i, area: 'tibubeneng', name: 'Tibubeneng' },
  { re: /\bberawa\b|\bbrawa\b/i, area: 'berawa', name: 'Berawa' },
];

/**
 * "5 minutes to Canggu" is a distance boast, not an address. A belt name in a title only
 * counts when no proximity phrase runs into it — the same rule the Facebook importer uses,
 * and the reason a Pererenan villa does not file itself under Canggu.
 */
const PROXIMITY_BEFORE = /\b(?:to|from|mins?|minutes?|drive|near|close to|dekat|walk|walking distance)\b[\s\W]{0,12}$/i;

/**
 * True when the pattern occurs at least once with no proximity phrase running into it.
 * Every occurrence is tried, not just the first: "near Goa Gajah, Bedulu" names Bedulu
 * plainly, and the first hit being a boast must not bury the second. (The Facebook
 * importer's `areaFromKeywords` has always walked them all; this now agrees with it.)
 */
function namedNotNear(text, re) {
  const s = String(text || '');
  const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m;
  while ((m = scan.exec(s))) {
    if (!PROXIMITY_BEFORE.test(s.slice(0, m.index))) return true;
    if (scan.lastIndex === m.index) scan.lastIndex += 1; // zero-length match guard
  }
  return false;
}

/**
 * Title-only area hints, used inside "Other Bali Area" and as the last fallback. Walks the
 * one §7 place table (areas.js PLACE_WORDS), so a banjar in the title — Kayu Tulang,
 * Nyuh Kuning, Tumbak Bayuh — lands in its area instead of falling through to `other`.
 * A name only counts when no proximity phrase runs into it.
 */
function areaFromTitle(title) {
  const t = String(title || '');
  if (/kaba[-\s]?kaba/i.test(t)) return { area: 'tanah_lot', sub_area: 'Kaba-Kaba' };
  for (const [re, area] of PLACE_WORDS) {
    if (namedNotNear(t, re)) return { area, sub_area: null };
  }
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

    if (head === 'canggu') {
      for (const v of CANGGU_BELT) {
        if (v.re.test(subL)) return out(v.area, sub);
        if (namedNotNear(title_, v.re)) return out(v.area, sub);
      }
      // Batu Bolong / Echo Beach and North Canggu are Canggu proper; the sub-area says which.
      return out('canggu', sub);
    }

    if (head === 'berawa') return out('berawa', sub);
    if (head === 'umalas') return out('umalas', sub);

    if (head === 'ubud') {
      // One BHI location for the whole region, no sub-areas: a neighbouring desa can
      // only be named in the title (Lodtunduh, Pejeng, Tegallalang …). Anything the
      // title names outside Center is ignored — a listing filed under Ubud is in Ubud,
      // whatever else the copy boasts about being close to.
      const byTitle = areaFromTitle(title_);
      const village = byTitle && AREAS[byTitle.area]?.group === 'center' ? byTitle.area : null;
      return out(village || 'ubud', sub); // Ubud's own banjars stay in sub_area
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

/**
 * A keyword inside a reassurance is not a flag: "no construction nearby", "far from the
 * main road", "construction-free street". Blank those windows out before matching, so a
 * listing that first denies and then admits ("... but the plot next door is under
 * construction") still gets flagged by the second mention.
 */
function negatedRe(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const lead = "(?:no|not|without|zero|never|nor|free\\s+(?:of|from)|away\\s+from|far\\s+from|none\\s+of|isn'?t\\s+any|aren'?t\\s+any|not\\s+near)";
  return new RegExp('\\b' + lead + "\\b[\\w\\s,'-]{0,30}?" + escaped + '\\b|\\b' + escaped + '[\\s-]*(?:noise[\\s-]*)?free\\b', 'gi');
}

/** @returns {string[]} flag names from the config keyword table. */
export function detectRedFlags(text, keywords = DEFAULT_CONFIG.red_flag_keywords) {
  const s = String(text || '');
  const flags = [];
  for (const [flag, words] of Object.entries(keywords || {})) {
    const hit = (words || []).some((w) => keywordRe(w).test(s.replace(negatedRe(w), ' ')));
    if (hit) flags.push(flag);
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

  // A caller-supplied canonical `area` (a §7 key) wins over the location-string map,
  // so non-BHI adapters can set it directly; `sub_area` then comes from the caller too.
  const mapped = mapArea({
    location: src.location,
    title: src.title,
    category: src.category ?? src.categories,
  });
  const explicitArea = src.area && AREAS[src.area] ? src.area : null;
  const area = explicitArea || mapped.area;
  const sub_area = explicitArea ? (src.sub_area ?? mapped.sub_area ?? null) : mapped.sub_area;
  const beach_km_hint = explicitArea ? (src.beach_km_hint ?? null) : mapped.beach_km_hint;

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
