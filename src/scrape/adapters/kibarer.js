// Kibarer Property — SPEC §6 "Adapters to build" item 2.
// kibarer.com is a parked domain-for-sale page (checked 2026-09-18); the agency's live
// long-term rental site is villabalisale.com — server-rendered, 10 cards a page,
// `?page=N`. See adapters/kibarer.md.

import * as cheerio from 'cheerio';
import { MAX_IMAGES, absUrl, textOf, numberIn, areToM2 } from './_shared.js';
import { moneyIdr, areaFromText, subAreaFrom, beachHint, termFor } from './_shared.js';

const BASE = 'https://www.villabalisale.com';
const LIST_PATH = '/realestate-property/for-rent/villa/all';

/**
 * Rental index slugs that can hold a SPEC §7 area, west to east like `defaults.js`
 * `areas`. `ubud` also carries the Center desa (Tegallalang, Payangan, Pejeng,
 * Lodtunduh have no slug of their own). `tabanan` and `bukit` are broad regions kept
 * alongside their villages' own slugs — the site's per-village index is not a strict
 * subset of the regional one, and `list()` dedupes by ref across slugs either way.
 * `buwit` returned zero listings on 2026-09-26 but is a valid index (kept for when
 * one appears). Probed 2026-09-26 (curl, browser UA, 1 req/s): see adapters/kibarer.md
 * for the observed page count per slug.
 */
export const TARGET_SLUGS = [
  // Center
  'ubud',
  // West Coast
  'mengwi', 'buwit', 'kedungu', 'nyanyi', 'tanah-lot', 'tabanan',
  'munggu', 'cemagi', 'seseh', 'pererenan', 'padonan', 'canggu',
  'tibubeneng', 'babakan', 'berawa', 'umalas',
  // South (the Bukit)
  'bukit', 'balangan', 'bingin', 'padang-padang', 'uluwatu', 'ungasan', 'pandawa',
];

/**
 * Kibarer-specific page cap — the shared `_shared.MAX_PAGES` (10) is too low for
 * this site's biggest indexes (`canggu` ran 45–46 pages, `berawa`/`umalas` 16–17 on
 * 2026-09-26). 50 is a safety ceiling only: `list()` still stops earlier on the
 * paginator's own last page or a page with nothing new.
 */
const KIBARER_MAX_PAGES = 50;

const IMG_PATH = '/uploads/images/property/';

function indexUrl(slug, page) {
  const url = `${BASE}${LIST_PATH}/${slug}`;
  return page > 1 ? `${url}?page=${page}` : url;
}

/** `…-yrv4752` → `YRV4752`; the card also prints it in `.property-code`. */
function refFromUrl(url) {
  const m = /-([a-z]{2,4}\d{3,6}[a-z]?)(?:[/?#]|$)/i.exec(String(url || ''));
  return m ? m[1].toUpperCase() : null;
}

/** "Yearly Rent" / "Monthly Rent" + "idr 220,000,000 / Annually" → the two price columns. */
function pricesFrom($, $card, config) {
  let price_month_idr = null;
  let price_year_idr = null;
  let currency = null;
  let original = null;

  $card.find('.property-price').each((_, el) => {
    const $el = $(el);
    const status = (textOf($el.find('.property-status')) || '').toLowerCase();
    const money = moneyIdr(textOf($el) || '', config);
    if (!money) return;
    currency = money.currency;
    original = money.original;
    const per = money.per || (/year|annual/.test(status) ? 'year' : /month/.test(status) ? 'month' : null);
    if (per === 'year' && price_year_idr == null) price_year_idr = money.amount;
    else if (per === 'month' && price_month_idr == null) price_month_idr = money.amount;
  });

  return { price_month_idr, price_year_idr, currency, original };
}

/**
 * Bed / bath / land / building from `.property-meta` (index) or `.property-badge`
 * (detail). The icon filename is the only label both templates share — the index
 * uses alt="Bedroom"/"s", the detail leaves alt empty.
 */
function metaStats($, $scope) {
  const out = {};
  $scope.find('.property-meta, .property-badge').each((_, el) => {
    const $el = $(el);
    const icon = ($el.find('img').attr('src') || '').split('/').pop() || '';
    const value = textOf($el.find('span, div').last());
    if (value == null) return;
    if (icon === 'bed.svg') out.bedrooms = numberIn(value);
    else if (icon === 'bathtub.svg') out.bathrooms = numberIn(value);
    else if (icon === 'scale-frame-enlarge.svg') out.land_m2 = areToM2(value);
    else if (icon === 'scale-frame-reduce.svg') out.build_m2 = numberIn(value);
  });
  return out;
}

/** `/for-rent/villa/annually/…` → 'year', `/monthly/…` → 'month'. */
function periodFromUrl(url) {
  const m = /\/for-rent\/villa\/(annually|yearly|monthly)\//i.exec(String(url || ''));
  if (!m) return null;
  return /month/i.test(m[1]) ? 'month' : 'year';
}

/** One `.property-thumbnail` card → a SPEC §6 partial (`area` null when off-target). */
export function cardFrom($, el, config = {}) {
  const $card = $(el);
  const href = $card.find('a[href*="/realestate-property/for-rent/"]').first().attr('href');
  const url = absUrl(href, BASE);
  if (!url) return null;

  const ref = textOf($card.find('.property-code')) || refFromUrl(url);
  if (!ref) return null;

  const title = textOf($card.find('.property-title'));
  const location = textOf($card.find('.property-location > div').last()) || textOf($card.find('.property-location'));

  const area = areaFromText(location, title);

  const { price_month_idr, price_year_idr, currency, original } = pricesFrom($, $card, config);
  const stats = metaStats($, $card.find('.property-specifications'));
  const thumb = absUrl($card.find('img[src*="' + IMG_PATH + '"]').first().attr('src'), BASE);

  return {
    source: 'kibarer',
    ref: ref.toUpperCase(),
    url,
    title,
    // §7 area stated outright (normaliseListing honours it); the site's own string
    // travels on as `location`.
    area,
    sub_area: subAreaFrom(location, area),
    beach_km_hint: beachHint(area, location, title),
    location,
    note: null,
    bedrooms: stats.bedrooms ?? null,
    bathrooms: stats.bathrooms ?? null,
    land_m2: stats.land_m2 ?? null,
    build_m2: stats.build_m2 ?? null,
    price_month_idr,
    price_year_idr,
    term: termFor(price_month_idr, price_year_idr),
    thumb,
    raw: { site_location: location, price_currency: currency, price_original: original },
  };
}

/** Every card of one index page. `all: true` also keeps the cards whose `area` is
 * null, which `list()` needs to tell "nothing new" from "all Berawa". */
export function cardsFrom(html, config = {}, { all = false } = {}) {
  const $ = cheerio.load(html);
  const out = [];
  $('.property-thumbnail').each((_, el) => {
    const card = cardFrom($, el, config);
    if (!card) return;
    if (!all && !card.area) return;
    out.push(card);
  });
  return out;
}

/** The highest `?page=N` the paginator links to, or null. */
export function lastPageOf(html) {
  const pages = [...String(html || '').matchAll(/\?page=(\d+)/g)].map((m) => Number(m[1]));
  return pages.length ? Math.max(...pages) : null;
}

async function* list(ctx, { areas = TARGET_SLUGS } = {}) {
  const seen = new Set();
  for (const slug of areas) {
    let lastPage = null;
    for (let page = 1; page <= KIBARER_MAX_PAGES; page++) {
      const res = await ctx.fetchHtml(indexUrl(slug, page), { ttlHours: 24 });
      if (!res || !res.html) break;

      const cards = cardsFrom(res.html, ctx.config, { all: true });
      if (page === 1) lastPage = lastPageOf(res.html);

      let fresh = 0;
      for (const card of cards) {
        if (seen.has(card.ref)) continue;
        seen.add(card.ref);
        fresh++;
        if (card.area) yield card;
      }
      // A page with nothing new means the paginator has wrapped or the area is
      // exhausted; either way there is no point asking for page N+1.
      if (fresh === 0) break;
      if (lastPage != null && page >= lastPage) break;
    }
  }
}

// ---------------------------------------------------------------------------
// detail()
// ---------------------------------------------------------------------------

const GONE_RE = /\b(sold|rented out|no longer available|not available)\b/i;

/** The pure half of `detail()`. Exported for tests. */
export function detailFrom(html, url, config = {}) {
  const $ = cheerio.load(html);
  const $main = $('.property-detail').first();
  if (!$main.length) return null;

  const title = textOf($('#property-name'));
  const ref = textOf($('#specifications dl dd:contains("Code")').first().next('dt')) || refFromUrl(url);
  if (!ref) return null;

  // #specifications is a <dl> of dd/dt pairs (Code, Location, Status, Land/Building Size).
  const spec = {};
  $('#specifications dl > div').each((_, el) => {
    const $el = $(el);
    const k = textOf($el.find('dd').first());
    const v = textOf($el.find('dt').first());
    if (k) spec[k.toLowerCase()] = v;
  });

  const facilities = $('#facilities .property-facility span')
    .map((_, el) => textOf($(el)))
    .get()
    .filter(Boolean);
  const has = (re) => (facilities.some((f) => re.test(f)) ? 1 : null);

  const description = $('#property-description .description').text().replace(/\n{3,}/g, '\n\n').trim() || null;

  // The header badges carry bedroom / bathroom / land / building for the main listing.
  const stats = metaStats($, $('.property-badges').first());

  // The detail page prints one bare amount (`#property-price .primary-price`); the
  // period it belongs to is the URL's own category segment.
  const money = moneyIdr(textOf($('#property-price .primary-price')) || '', config);
  const per = money ? money.per || periodFromUrl(url) : null;
  const price_year_idr = money && per === 'year' ? money.amount : null;
  const price_month_idr = money && per === 'month' ? money.amount : null;
  const currency = money ? money.currency : null;
  const original = money ? money.original : null;

  const location = spec.location || null;
  const area = areaFromText(location, title);

  const images = [];
  $(`img[src*="${IMG_PATH}"]`).each((_, el) => {
    const src = $(el).attr('src') || '';
    // /uploads/images/property/thumb/… belongs to the "similar properties" carousel.
    if (src.includes(`${IMG_PATH}thumb/`)) return;
    const abs = absUrl(src, BASE);
    if (abs && !images.some((i) => i.src_url === abs) && images.length < MAX_IMAGES) {
      images.push({ src_url: abs });
    }
  });

  // The floating WhatsApp button ships commented out in the footer, so the number
  // is in the HTML but not in the DOM — read it off the source (adapters/kibarer.md).
  const waPhone = /api\.whatsapp\.com\/send\?phone=(\d+)/.exec(html);

  const bodyText = `${title || ''} ${spec.status || ''} ${description || ''}`;

  const terms = [spec.status ? `Status: ${spec.status}` : null, facilities.length ? `Facilities: ${facilities.join(', ')}` : null]
    .filter(Boolean)
    .join(' | ') || null;

  return {
    source: 'kibarer',
    ref: String(ref).toUpperCase(),
    url: url || null,
    title,
    description,
    terms,
    area,
    sub_area: subAreaFrom(location, area),
    beach_km_hint: beachHint(area, location, title),
    location,

    bedrooms: stats.bedrooms ?? null,
    bathrooms: stats.bathrooms ?? null,
    land_m2: spec['land size'] ? areToM2(spec['land size']) : stats.land_m2 ?? null,
    build_m2: spec['building size'] ? numberIn(spec['building size']) : stats.build_m2 ?? null,
    price_month_idr,
    price_year_idr,
    term: termFor(price_month_idr, price_year_idr),
    pool: has(/^pool$|swimming/i),
    kitchen_full: has(/kitchen/i),
    aircon: has(/air conditioner|^ac$/i),
    garden: has(/garden/i),
    images,
    // No lat/lng: `.property-detail[data-latitude]` carries the agency office pin,
    // identical on every listing (verified on two 2026-09 pages) — see adapters/kibarer.md.
    lat: null,
    lng: null,
    pin_source: null,

    contacts: waPhone ? [{ role: 'agency', name: 'Kibarer Property', whatsapp: `+${waPhone[1]}` }] : [],
    gone: GONE_RE.test(bodyText),
    raw: { specifications: spec, facilities, price_currency: currency, price_original: original },
  };
}

async function detail(ctx, url) {
  const res = await ctx.fetchHtml(url, { ttlHours: 24 });
  if (!res || res.status === 404 || res.status === 410 || !res.html) return null;
  return detailFrom(res.html, url, ctx.config);
}

/** Facts the page states outright beat normaliseListing's keyword guesses. */
const ASSERTED = ['bathrooms', 'land_m2', 'build_m2', 'pool', 'kitchen_full', 'aircon', 'garden'];

export function applyDetail(row, d) {
  if (!d) return row;
  const out = { ...row };
  for (const k of ASSERTED) if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  if (Array.isArray(d.images) && d.images.length) out.images = d.images;
  if (d.gone) out.availability = 'gone';
  return out;
}

export default {
  id: 'kibarer',
  name: 'Kibarer Property (villabalisale.com)',
  base: BASE,
  areas: TARGET_SLUGS,
  list, detail, applyDetail, cardsFrom, detailFrom, lastPageOf,
};
