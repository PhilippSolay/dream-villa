// Bali Home Immo — pure card-text parsing.
// Port of `parseCard` from adapters/bali-home-immo.md. No cheerio, no fetching:
// `extractCards`, `list` and `detail` land in a later step. Zero dependencies.

const BASE = 'https://bali-home-immo.com';
const THUMB_BASE = `${BASE}/images/properties/thumb/`;
const CARD_PATH = '/realestate-property/for-rent/villa/';

/** Tag prefix the site glues in front of the note, e.g. "Newly Listedleaseholdyearlymonthly". */
const TAG_PREFIX_RE = /^((?:Newly Listed|leasehold|freehold|yearly|monthly)+)/i;

/** Every `RFnnnn[a]` token in the card text — more than one means several cards were concatenated. */
const REF_TOKEN_RE = /\bRF\d+[A-Z]?\b/gi;

/** `Bedroom: 2`, `Bedroom: >5`, `Bedroom: 215/12/2026` (bedrooms is ONE digit, the rest is a date). */
const BEDROOM_RE = /Bedroom:\s*(>?)(\d)/;
const AVAILABLE_RE = /Bedroom:\s*>?\d(\d{2}\/\d{2}\/\d{4})/;

/**
 * A real card price: `IDR 40.000.000/month`, `IDR 2.100.000.000/year`.
 * Thousands separators may be dots or commas. The slash must be followed straight
 * away by month|year, so a note price such as `IDR 23,000,000/are/year` never matches.
 */
const CARD_PRICE_RE = /IDR\s*([\d][\d.,]*)\/(month|year)\b/gi;

/** `>5` means "more than 5 bedrooms"; we record 6 so the band check drops it later. */
const OVER_FIVE_BEDROOMS = 6;

/** Strip everything but [a-z0-9] so `3-Bedroom` matches the slug's `3 bedroom`, `6+1` matches `6 1`, `–` matches `-`. */
function foldForMatch(s) {
  const chars = [];
  const index = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i].toLowerCase();
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      chars.push(ch);
      index.push(i);
    }
  }
  return { folded: chars.join(''), index };
}

/**
 * Where the slug-derived title sits inside the card text, tolerant of punctuation
 * the slug drops ("3-Bedroom" vs "3 bedroom", "+ AN OFFICE" vs "an office", en dashes).
 * @returns {{start:number, end:number}|null} offsets into `haystack`
 */
function findTitleSpan(haystack, title) {
  const h = foldForMatch(haystack);
  const t = foldForMatch(title);
  if (!t.folded) return null;
  const at = h.folded.indexOf(t.folded);
  if (at < 0) return null;
  return { start: h.index[at], end: h.index[at + t.folded.length - 1] + 1 };
}

/** dd/mm/yyyy → yyyy-mm-dd; anything else → null. */
export function toIsoDate(ddmmyyyy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(ddmmyyyy || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Number of digits + separators → integer, treating `.` and `,` as thousands separators. */
function toInt(digits) {
  return Number(String(digits).replace(/[.,]/g, ''));
}

/**
 * Parse one index card.
 *
 * @param {object} c
 * @param {string} c.ref     upper-case `RFnnnn[A]`
 * @param {string} c.url     absolute detail URL
 * @param {string} c.text    whitespace-collapsed card text
 * @param {string} [c.thumb] thumbnail URL
 * @param {string[]} [c.categories] e.g. ['monthly/seseh', 'yearly/seseh'] — wins over the text tags for `term`
 * @returns {object} the card fields, or `{ ref, dirty: true }` when the text holds several cards
 */
export function parseCard({ ref, url, text, thumb = null, categories = null }) {
  const cardText = String(text || '');

  // --- Dirt gate -------------------------------------------------------------
  // The DOM walk can hand us an ancestor that wrapped several cards (the RF10336 bug).
  // The tell is more than one ref token / bedroom marker / per-period price — NOT simply
  // more than one "IDR", because legitimate notes quote a sale or extension price
  // ("37-year leasehold option available at IDR 5.500.000.000").
  const refs = cardText.match(REF_TOKEN_RE) || [];
  const bedroomMarkers = cardText.match(/Bedroom:/g) || [];
  const prices = cardText.match(CARD_PRICE_RE) || [];
  if (refs.length > 1 || bedroomMarkers.length > 1 || prices.length > 1) {
    return { ref, dirty: true };
  }

  // --- Title from the URL slug ----------------------------------------------
  const slug = String(url || '')
    .split('/')
    .pop()
    .replace(new RegExp(`-${String(ref).toLowerCase()}$`, 'i'), '');
  const title = slug.replace(/-/g, ' ');

  // --- Tags, note, location --------------------------------------------------
  const tagm = cardText.match(TAG_PREFIX_RE);
  const tags = (tagm ? tagm[1] : '').toLowerCase();
  const rest = cardText.slice(tagm ? tagm[1].length : 0);

  const span = findTitleSpan(rest, title);
  const refIdx = rest.indexOf(ref);
  const note = span ? rest.slice(0, span.start).trim() : '';
  const rawLocation = span
    ? rest.slice(span.end, refIdx >= 0 ? refIdx : undefined)
    : rest.slice(0, refIdx >= 0 ? refIdx : undefined);
  // Drop leading whitespace and the trailing "- " that precedes the ref.
  const location = rawLocation.replace(/^\s+/, '').replace(/[-–—]\s*$/, '').trim();

  // --- Facts -----------------------------------------------------------------
  const bm = cardText.match(BEDROOM_RE);
  const bedrooms = bm ? (bm[1] === '>' ? OVER_FIVE_BEDROOMS : Number(bm[2])) : null;

  const available = (cardText.match(AVAILABLE_RE) || [])[1] || null;

  const pm = new RegExp(CARD_PRICE_RE.source, 'i').exec(cardText);
  const price = pm ? toInt(pm[1]) : null;
  const per = pm ? pm[2].toLowerCase() : null;

  // `term` prefers the index categories the card was found under; the text tags are the fallback.
  const catText = (Array.isArray(categories) ? categories.join(',') : String(categories || '')).toLowerCase();
  const termSource = catText || tags;
  const hasYear = /yearly/.test(termSource);
  const hasMonth = /monthly/.test(termSource);

  return {
    ref,
    url,
    title,
    location,
    note,
    bedrooms,
    available,
    available_from: toIsoDate(available),
    price_month_idr: per === 'month' ? price : null,
    price_year_idr: per === 'year' ? price : null,
    term: hasYear && hasMonth ? 'both' : hasYear ? 'yearly' : 'monthly',
    for_sale: /leasehold|freehold/.test(tags),
    newly_listed: /newly listed/.test(tags),
    thumb,
  };
}

/**
 * Build a `parseCard` input from a `seed/bhi-sweep-*.json` `raw` row.
 * @param {{r:string,u:string,t:string,i:string,c:string}} raw
 * @param {string} [base]
 */
export function cardFromSeedRaw(raw, base = BASE) {
  return {
    ref: raw.r,
    url: `${base}${CARD_PATH}${raw.u}`,
    text: raw.t,
    thumb: raw.i ? `${THUMB_BASE}${raw.i}` : null,
    categories: String(raw.c || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** Convenience: seed row → parsed card (or `{ ref, dirty: true }`). */
export function parseSeedRaw(raw, base = BASE) {
  return parseCard(cardFromSeedRaw(raw, base));
}

export default { parseCard, cardFromSeedRaw, parseSeedRaw, toIsoDate };
