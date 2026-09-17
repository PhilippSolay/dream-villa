// SPEC §6 "Adapters to build" item 5 — the fallback for any `inbox` URL that isn't a
// known agency/portal: OpenGraph + JSON-LD (`RealEstateListing`/`Product`/`Offer`/
// `Accommodation`/`House`/`Residence`/`Place`) + regex over the visible text. Never
// guesses what it can't find; always keeps `raw` for debugging (SPEC §6 "inbox").
//
// Two things normaliseListing (src/scrape/normalise.js) does NOT do for us, unlike the
// bhi adapter's own text, so this file has to: (1) area — mapArea only reads a bhi-shaped
// `location`/`category`, never scans free text, so detectArea() below runs its own
// keyword scan and translates the hit into a `location` string mapArea recognises
// (documented per-area below — a handful of areas are only reachable via mapArea's own
// title-text heuristics, same as the real bhi adapter, and fall back to 'other' there);
// (2) land_m2/build_m2 and price — normaliseListing takes these straight off the input,
// with no text fallback, so they are parsed here from the page text.

import * as cheerio from 'cheerio';
import { sha1 } from '../fetch.js';
import { parsePrice, parseBedrooms } from '../normalise.js';

const MAX_RAW_BYTES = 20 * 1024;
const AREA_SCAN_CHARS = 2000;
const MAX_IMAGES = 20;

const LD_TYPES = new Set([
  'realestatelisting', 'product', 'offer', 'accommodation', 'house', 'residence', 'place',
]);

/**
 * Canonical area → a `location` string mapArea() will resolve deterministically
 * (SPEC §7's own bhi-shaped strings). seseh's "Residential Side" branch and every
 * "Uluwatu - <sub>" branch don't depend on the page's title at all; cemagi/munggu/
 * buwit/mengwi do (mapArea has no title-independent route for them — same limitation
 * the real bhi adapter lives with), so they're left for mapArea's own title fallback.
 */
const AREA_LOCATION_HINT = {
  seseh: 'Cemagi / Seseh - Residential Side',
  pererenan: 'Pererenan - Beach Side',
  nyanyi: 'Tanah Lot Area - East side (Nyanyi)',
  kedungu: 'Tanah Lot Area - West side (Kedungu)',
  tanah_lot: 'Tanah Lot Area',
  bingin: 'Uluwatu - Bingin',
  padang_padang: 'Uluwatu - Padang Padang',
  balangan: 'Uluwatu - Balangan',
  uluwatu: 'Uluwatu',
  ungasan: 'Ungasan',
  pandawa: 'Pandawa',
};

/** Keyword scan against the §7 area labels and common spellings. Order matters: more
 *  specific sub-areas (padang_padang, balangan, bingin) before the broad 'uluwatu'. */
const AREA_KEYWORDS = [
  ['seseh', /\bseseh\b/i],
  ['cemagi', /\bcemagi\b/i],
  ['munggu', /\bmunggu\b/i],
  ['pererenan', /\bpererenan\b/i],
  ['nyanyi', /\bnyanyi\b/i],
  ['kedungu', /\bkedungu\b/i],
  ['buwit', /\bbuwit\b/i],
  ['mengwi', /\bmengwi\b/i],
  ['tanah_lot', /\btanah\s*lot\b/i],
  ['padang_padang', /\bpadang[\s-]?padang\b/i],
  ['balangan', /\bbalangan\b/i],
  ['bingin', /\bbingin\b/i],
  ['pandawa', /\bpandawa\b|\bkutuh\b/i],
  ['ungasan', /\bungasan\b/i],
  ['uluwatu', /\buluwatu\b|\bpecatu\b/i],
];

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

/** @returns {string} the first area keyword hit in the text, else 'other'. */
export function detectArea(text) {
  const s = String(text || '');
  for (const [area, re] of AREA_KEYWORDS) if (re.test(s)) return area;
  return 'other';
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

/** Flatten `@graph` arrays and top-level arrays into one flat list of objects. */
function flattenJsonLd(node, out) {
  if (Array.isArray(node)) {
    for (const n of node) flattenJsonLd(n, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  out.push(node);
  if (Array.isArray(node['@graph'])) flattenJsonLd(node['@graph'], out);
}

/** Every `<script type="application/ld+json">` block on the page, parsed and flattened. */
export function parseJsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).contents().text();
    if (!text || !text.trim()) return;
    try {
      flattenJsonLd(JSON.parse(text), out);
    } catch {
      // malformed JSON-LD is common in the wild — skip it, don't fail the page
    }
  });
  return out;
}

function typesOf(node) {
  const t = node && node['@type'];
  if (!t) return [];
  return (Array.isArray(t) ? t : [t]).map((s) => String(s).toLowerCase());
}

/** First block whose `@type` is one of the SPEC §6 listing types. */
export function findListingBlock(blocks) {
  for (const b of blocks) {
    if (typesOf(b).some((t) => LD_TYPES.has(t))) return b;
  }
  return null;
}

// ---------------------------------------------------------------------------
// OpenGraph / Twitter meta
// ---------------------------------------------------------------------------

export function parseOg($) {
  const out = {};
  $('meta[property^="og:"], meta[name^="twitter:"]').each((_, el) => {
    const key = $(el).attr('property') || $(el).attr('name');
    const val = $(el).attr('content');
    if (key && val != null && out[key] === undefined) out[key] = val;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Contact / pin
// ---------------------------------------------------------------------------

const WA_RE = /(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\d[\d-]{5,})/i;

export function extractWhatsapp($) {
  let found = null;
  $('a[href*="wa.me/"], a[href*="api.whatsapp.com/send"]').each((_, el) => {
    if (found) return;
    const href = $(el).attr('href') || '';
    const m = WA_RE.exec(href);
    if (m) found = `+${m[1].replace(/-/g, '')}`;
  });
  return found;
}

const MAPS_Q_RE = /[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;
const MAPS_AT_RE = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;

export function extractMapPin($) {
  let found = null;
  $('a[href*="google.com/maps"], a[href*="goo.gl/maps"], iframe[src*="google.com/maps"]').each((_, el) => {
    if (found) return;
    const href = $(el).attr('href') || $(el).attr('src') || '';
    const m = MAPS_Q_RE.exec(href) || MAPS_AT_RE.exec(href);
    if (m) found = { lat: Number(m[1]), lng: Number(m[2]) };
  });
  return found;
}

// ---------------------------------------------------------------------------
// Bedrooms / land / build / price (SPEC §6: normaliseListing has no text fallback
// for these except bedrooms, and even that misses the Indonesian "kamar tidur"/"KT").
// ---------------------------------------------------------------------------

const BEDROOM_ID_RE = /(\d+)\s*(?:kamar\s*tidur|KT\b|BR\b|bed(?:room)?s?)/i;

export function extractBedrooms(text) {
  const viaCommon = parseBedrooms(text);
  if (viaCommon != null) return viaCommon;
  const m = BEDROOM_ID_RE.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

// "are" (1 hundred m²) is normally a one- or two-digit land measure ("2 are"), so it
// needs its own, shorter digit run than m2/sqm ("(\d{2,5})" per SPEC §6) — one pattern
// with two alternatives, tried per match.
const M2_RE = /(\d{2,5})\s*(m2|m²|sqm)\b|(\d{1,3})\s*are\b/gi;
const LAND_NEAR_RE = /\b(land|tanah)\b/i;
const BUILD_NEAR_RE = /\b(building|bangunan)\b/i;
const NEAR_WINDOW = 40;

/** `(\d{2,5}) (m2|m²|sqm)` / `(\d{1,3}) are` near "land|tanah" → land_m2; near
 *  "building|bangunan" → build_m2; `are` is ×100 m² (SPEC §6). A hit with neither
 *  keyword nearby is skipped. */
export function extractLandBuild(text) {
  const s = String(text || '');
  let land_m2 = null;
  let build_m2 = null;
  M2_RE.lastIndex = 0;
  for (let m; (m = M2_RE.exec(s)); ) {
    const before = s.slice(Math.max(0, m.index - NEAR_WINDOW), m.index);
    const value = m[3] != null ? Number(m[3]) * 100 : Number(m[1]);
    if (land_m2 == null && LAND_NEAR_RE.test(before)) land_m2 = Math.round(value);
    else if (build_m2 == null && BUILD_NEAR_RE.test(before)) build_m2 = Math.round(value);
  }
  return { land_m2, build_m2 };
}

/** Marks the position of a price-shaped keyword — a window around each hit is handed
 *  to normalise.js's own `parsePrice`, rather than a whole "sentence" (thousands
 *  separators are dots, so stopping a candidate at the next `.` would cut a price
 *  like "IDR 40.000.000" down to "IDR 40"). */
const PRICE_MARKER_RE = /\b(?:IDR|Rp\.?|juta|jt|M\/|\/\s*month|\/\s*bulan|\/\s*tahun|\/\s*year)\b/gi;
const PRICE_WINDOW_BEFORE = 30;
const PRICE_WINDOW_AFTER = 60;

/** First price-shaped candidate window, parsed with normalise.js's own parsePrice;
 *  a candidate with an explicit period (month/year) wins over a bare amount. */
export function extractPrice(text) {
  const s = String(text || '');
  let withPeriod = null;
  let bare = null;
  PRICE_MARKER_RE.lastIndex = 0;
  for (let m; (m = PRICE_MARKER_RE.exec(s)); ) {
    const window = s.slice(Math.max(0, m.index - PRICE_WINDOW_BEFORE), m.index + PRICE_WINDOW_AFTER);
    const parsed = parsePrice(window);
    if (!parsed) continue;
    if (parsed.per && !withPeriod) withPeriod = parsed;
    else if (!parsed.per && !bare) bare = parsed;
    if (withPeriod) break;
  }
  return withPeriod || bare;
}

// ---------------------------------------------------------------------------
// detail()
// ---------------------------------------------------------------------------

/**
 * SPEC §6 `detail`: OpenGraph + JSON-LD + regex extraction for any URL that isn't a
 * known source. Returns null on 404/410/blocked or an unreadable page.
 */
export async function detail(ctx, url) {
  const res = await ctx.fetchHtml(url);
  if (!res || res.status === 404 || res.status === 410 || !res.html) return null;

  const host = hostnameOf(url);
  if (!host) return null;

  const $ = cheerio.load(res.html);
  const jsonld = parseJsonLd($);
  const og = parseOg($);
  const listing = findListingBlock(jsonld);

  const pageTitle = ($('title').first().text() || '').trim() || null;
  const h1 = ($('h1').first().text() || '').trim() || null;
  const metaDescription = $('meta[name="description"]').attr('content') || null;

  const wa = extractWhatsapp($);
  const pin = extractMapPin($);

  // Visible text only, for the regex fallbacks and the area scan.
  $('script, style, nav').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  const title = (listing && (listing.name || (listing.offers && listing.offers.name))) || og['og:title'] || pageTitle || h1 || null;
  const description = (listing && listing.description) || og['og:description'] || metaDescription || null;

  const textForRegex = [title, description, bodyText].filter(Boolean).join(' . ');

  // --- images: JSON-LD image(s), else og:image ---
  const images = [];
  const ldImages = listing && listing.image;
  if (ldImages) {
    for (const im of Array.isArray(ldImages) ? ldImages : [ldImages]) {
      const src = typeof im === 'string' ? im : im && im.url;
      if (src) images.push({ src_url: src });
    }
  }
  if (!images.length && og['og:image']) images.push({ src_url: og['og:image'] });

  // --- price: JSON-LD offers.price first (assume the listing's own currency/period is
  // IDR/rent — this is a best-effort fallback extractor, SPEC gives no period for LD
  // offers), the text regex fills in / overrides when it finds an explicit period.
  let price_month_idr = null;
  let price_year_idr = null;
  const offer = listing && listing.offers && (Array.isArray(listing.offers) ? listing.offers[0] : listing.offers);
  if (offer) {
    const ldPrice = offer.price ?? (offer.priceSpecification && offer.priceSpecification.price);
    const ldCurrency = offer.priceCurrency || (offer.priceSpecification && offer.priceSpecification.priceCurrency);
    const n = Number(ldPrice);
    if (Number.isFinite(n) && (!ldCurrency || /idr/i.test(ldCurrency))) price_month_idr = Math.round(n);
  }
  const parsedPrice = extractPrice(textForRegex);
  if (parsedPrice) {
    if (parsedPrice.per === 'year') price_year_idr = parsedPrice.amount;
    else if (parsedPrice.per === 'month') price_month_idr = parsedPrice.amount;
    else if (price_month_idr == null) price_month_idr = parsedPrice.amount;
  }

  // --- bedrooms: JSON-LD numberOfBedrooms/numberOfRooms first, else the text regexes ---
  let bedrooms = null;
  const ldBedrooms = listing && (listing.numberOfBedrooms ?? listing.numberOfRooms);
  if (ldBedrooms != null && Number.isFinite(Number(ldBedrooms))) bedrooms = Number(ldBedrooms);
  else bedrooms = extractBedrooms(textForRegex);

  // --- land / build: text regex, then JSON-LD floorSize fills a hole ---
  const { land_m2, build_m2: build_m2FromText } = extractLandBuild(textForRegex);
  let build_m2 = build_m2FromText;
  if (build_m2 == null && listing && listing.floorSize && listing.floorSize.value != null) {
    const v = Number(listing.floorSize.value);
    if (Number.isFinite(v)) build_m2 = Math.round(v);
  }

  // --- address / geo ---
  let address = null;
  if (listing && listing.address) {
    address =
      typeof listing.address === 'string'
        ? listing.address
        : [listing.address.streetAddress, listing.address.addressLocality, listing.address.addressRegion]
            .filter(Boolean)
            .join(', ') || null;
  }

  let lat = null;
  let lng = null;
  let pin_source = null;
  if (listing && listing.geo && listing.geo.latitude != null && listing.geo.longitude != null) {
    lat = Number(listing.geo.latitude);
    lng = Number(listing.geo.longitude);
    pin_source = 'listing_map';
  } else if (pin) {
    lat = pin.lat;
    lng = pin.lng;
    pin_source = 'listing_map';
  }

  // --- area: title + og:description + first 2000 chars of text, keyword scan (SPEC §6) ---
  const scanText = [title, og['og:description'], bodyText.slice(0, AREA_SCAN_CHARS)].filter(Boolean).join(' . ');
  const area = detectArea(scanText);
  const location = AREA_LOCATION_HINT[area] || null;

  const source = host;
  const ref = sha1(url).slice(0, 12);

  let raw = { jsonld, og, text_sample: bodyText.slice(0, 4000) };
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_RAW_BYTES) {
    raw = { jsonld, og, text_sample: bodyText.slice(0, 500) };
  }
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_RAW_BYTES) {
    raw = { jsonld: jsonld.slice(0, 1), og, text_sample: bodyText.slice(0, 500) };
  }

  return {
    source,
    ref,
    url,
    title,
    description,
    location,
    bedrooms,
    land_m2,
    build_m2,
    price_month_idr,
    price_year_idr,
    images: images.slice(0, MAX_IMAGES),
    address,
    lat,
    lng,
    pin_source,
    contacts: wa ? [{ role: 'agent', whatsapp: wa }] : [],
    gone: false,
    raw,
  };
}

/**
 * Facts normaliseListing's primary pass never reads directly (images, address,
 * lat/lng/pin_source) — the same overlay pattern bhi.js's applyDetail uses.
 */
export function applyDetail(row, d) {
  if (!d) return row;
  const out = { ...row };
  if (d.address) out.address = d.address;
  if (d.lat != null && d.lng != null) {
    out.lat = d.lat;
    out.lng = d.lng;
    out.pin_source = d.pin_source || 'listing_map';
  }
  if (Array.isArray(d.images) && d.images.length) out.images = d.images;
  if (d.gone) out.availability = 'gone';
  return out;
}

export default {
  id: 'generic',
  name: 'Generic URL',
  base: null,
  // SPEC §6 adapter interface: `list` yields nothing — generic is only ever reached
  // through the inbox, never through the daily per-source index crawl.
  async *list() {},
  detail,
  applyDetail,
  detectArea,
  parseJsonLd,
  parseOg,
  extractWhatsapp,
  extractMapPin,
  extractBedrooms,
  extractLandBuild,
  extractPrice,
};
