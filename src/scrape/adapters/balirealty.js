// Bali Realty (balirealty.com) — SPEC §6 "Adapters to build" item 2.
//
// WordPress + the Realia property theme, server-rendered. The rental list is
// `/properties/page/N/?filter-contract=RENT&filter-property-type=75` (75 = Villa),
// 12 cards a page. See adapters/balirealty.md.

import * as cheerio from 'cheerio';
import { MAX_PAGES, MAX_IMAGES, absUrl, textOf, numberIn } from './_shared.js';
import { moneyIdr, areaFromText, subAreaFrom, beachHint, termFor } from './_shared.js';

const BASE = 'https://www.balirealty.com';
const LIST_PATH = '/properties';
const FILTER = 'filter-contract=RENT&filter-property-type=75';

/**
 * The index card prints an amount with no period (`data-base-amount`), so the card
 * has to decide monthly vs yearly before the band check can run. The band is
 * 15–80 M/month, i.e. 180–960 M/year: no in-band listing can sit on either side of
 * 150 M under the wrong reading, which makes this a boundary, not a guess. A title
 * that says "yearly"/"monthly" outright always wins, and `detail()` — which does
 * get "IDR 365,000,000/year" in full — overwrites both.
 */
const YEARLY_THRESHOLD_IDR = 150_000_000;

const PER_YEAR_RE = /\b(yearly|annual|annually|per\s+year|\/\s*year|tahun)\b/i;
const PER_MONTH_RE = /\b(monthly|per\s+month|\/\s*month|bulan)\b/i;

const GONE_RE = /\b(rented|sold|no longer available|not available|unavailable)\b/i;

function indexUrl(page) {
  return page > 1 ? `${BASE}${LIST_PATH}/page/${page}/?${FILTER}` : `${BASE}${LIST_PATH}/?${FILTER}`;
}

/** `…-in-pererenan-2984/` → `2984` (the agency's own reference, shown as "Reference"). */
function refFromUrl(url) {
  const m = /-(\d{3,6})\/?$/.exec(String(url || '').replace(/[?#].*$/, ''));
  return m ? m[1] : null;
}

/** `data-base-currency` + `data-base-amount` → IDR, or null for a currency we do not convert. */
function amountIdr($box, config) {
  const currency = ($box.attr('data-base-currency') || '').toUpperCase();
  const raw = Number($box.attr('data-base-amount'));
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const money = moneyIdr(`${currency} ${raw}`, config);
  return money ? { amount: money.amount, currency, original: raw } : { amount: null, currency, original: raw };
}

/** One `.property-container` card → a SPEC §6 partial, or null when out of area. */
export function cardFrom($, el, config = {}) {
  const $card = $(el);
  const $link = $card.find('.property-text h3 a, h3 a').first();
  const url = absUrl($link.attr('href'), BASE);
  if (!url) return null;

  const ref = refFromUrl(url);
  if (!ref) return null;

  // The theme appends " – <ref>" to the card title; the detail page's <h1> does not.
  const title = (textOf($link) || '').replace(/\s*[–-]\s*\d{3,6}$/, '') || null;
  const blurb = textOf($card.find('.property-text > div').first());

  const area = areaFromText(title, blurb);

  const money = amountIdr($card.find('.property-currency-box').first(), config);
  const haystack = `${title || ''} ${blurb || ''}`;
  let price_month_idr = null;
  let price_year_idr = null;
  if (money && money.amount != null) {
    const yearly = PER_YEAR_RE.test(haystack)
      ? true
      : PER_MONTH_RE.test(haystack)
        ? false
        : money.amount >= YEARLY_THRESHOLD_IDR;
    if (yearly) price_year_idr = money.amount;
    else price_month_idr = money.amount;
  }

  const attrs = {};
  $card.find('.property-attributes .col-xs-3').each((_, a) => {
    const $a = $(a);
    const label = (textOf($a.find('p')) || '').toLowerCase();
    const value = numberIn(textOf($a.find('h4')));
    if (label && value != null) attrs[label] = value;
  });

  const $img = $card.find('img[data-src]').first();
  const thumb = absUrl($img.attr('data-src') || $img.attr('src'), BASE);

  return {
    source: 'balirealty',
    ref,
    url,
    title,
    // The card has no location field of its own — the area comes from the title.
    area,
    sub_area: null,
    beach_km_hint: beachHint(area, title, blurb),
    location: null,
    note: blurb,
    bedrooms: attrs.bedrooms ?? null,
    bathrooms: attrs.bathrooms ?? null,
    price_month_idr,
    price_year_idr,
    term: termFor(price_month_idr, price_year_idr),
    thumb: thumb && !thumb.startsWith('data:') ? thumb : null,
    raw: { price_currency: money ? money.currency : null, price_original: money ? money.original : null },
  };
}

/** Every rental card of one index page. `all: true` also keeps the cards whose
 * `area` is null, which `list()` needs to tell "nothing new" from "all Seminyak". */
export function cardsFrom(html, config = {}, { all = false } = {}) {
  const $ = cheerio.load(html);
  const out = [];
  $('.property-container').each((_, el) => {
    const card = cardFrom($, el, config);
    if (!card) return;
    if (!all && !card.area) return;
    out.push(card);
  });
  return out;
}

async function* list(ctx) {
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await ctx.fetchHtml(indexUrl(page), { ttlHours: 24 });
    if (!res || !res.html) break;

    const $ = cheerio.load(res.html);
    const total = $('.property-container').length;
    if (total === 0) break;

    let fresh = 0;
    for (const card of cardsFrom(res.html, ctx.config, { all: true })) {
      if (seen.has(card.ref)) continue;
      seen.add(card.ref);
      fresh++;
      if (card.area) yield card;
    }
    // The theme serves page 1 again past the last page, so a page that repeats every
    // ref — or links to no page N+1 — is the end of the walk.
    if (fresh === 0) break;
    if (!$(`a[href*="/page/${page + 1}/"]`).length) break;
  }
}

// ---------------------------------------------------------------------------
// detail()
// ---------------------------------------------------------------------------

/** The pure half of `detail()`. Exported for tests. */
export function detailFrom(html, url, config = {}) {
  const $ = cheerio.load(html);
  const $body = $('body');
  if (!$body.hasClass('single-property') && !$('.property-overview').length) return null;

  const ref = refFromUrl(url) || textOf($('.property-overview li:contains("Reference") strong'));
  if (!ref) return null;

  // The theme comments its own <h1> out; og:title is the only clean copy of the name.
  const title =
    (textOf($('meta[property="og:title"]').first().attr('content') || textOf($('h2').first())) || '')
      .replace(/\s+-\s+BALI REALTY$/i, '')
      .replace(/\s*[–-]\s*\d{3,6}$/, '') || null;

  // `.property-overview ul li` is `<span>Label</span><strong>value</strong>`.
  const overview = {};
  $('.property-overview li').each((_, el) => {
    const $el = $(el);
    const k = textOf($el.find('span').first());
    const v = textOf($el.find('strong').first());
    if (k) overview[k.toLowerCase()] = v;
  });

  const features = {};
  $('.property-main-features li').each((_, el) => {
    const $el = $(el);
    const k = (textOf($el.find('.feature-names')) || '').toLowerCase();
    const v = numberIn(textOf($el.find('span').first()));
    if (k && v != null) features[k] = v;
  });

  // Every facility is listed; the ones this villa does NOT have carry class "no".
  const amenities = $('.property-amenities li')
    .filter((_, el) => !$(el).hasClass('no'))
    .map((_, el) => textOf($(el)))
    .get()
    .filter(Boolean);

  const $desc = $('.property-description').first().clone();
  $desc.find('h1, h2, h3').remove();
  const description = $desc.text().replace(/\n{3,}/g, '\n\n').trim() || null;

  // `.property-pricing` states the period in full: "IDR 365,000,000/year".
  const money = moneyIdr(textOf($('.property-pricing')) || '', config);
  let price_month_idr = null;
  let price_year_idr = null;
  if (money) {
    if (money.per === 'year') price_year_idr = money.amount;
    else if (money.per === 'month') price_month_idr = money.amount;
  }

  // The <body> class carries the taxonomy term: `locations-pererenan`.
  const bodyLocation = (($body.attr('class') || '').match(/locations-([a-z0-9-]+)/) || [])[1] || null;
  const area = areaFromText(bodyLocation && bodyLocation.replace(/-/g, ' '), overview.location, title);

  const images = [];
  $('.property-gallery img').each((_, el) => {
    const src = $(el).attr('data-src') || $(el).attr('src') || '';
    if (!src || src.startsWith('data:')) return;
    const abs = absUrl(src, BASE);
    if (abs && !images.some((i) => i.src_url === abs) && images.length < MAX_IMAGES) images.push({ src_url: abs });
  });

  const waHref = $('a[href*="wa.me/"]').first().attr('href') || '';
  const waPhone = /wa\.me\/(\d+)/.exec(waHref);
  const contactName = overview['contact name'] || null;

  // Overview states both outright: Sold = Yes/No, Status = Available / Rented / Sold.
  const gone = /^yes\b/i.test(overview.sold || '') || GONE_RE.test(overview.status || '');

  return {
    area,
    source: 'balirealty',
    ref,
    url: url || null,
    title,
    description,
    terms: amenities.length ? `Amenities: ${amenities.join(', ')}` : null,
    area,
    sub_area: subAreaFrom(overview.location, area),
    beach_km_hint: beachHint(area, overview.location, title, description),
    location: overview.location || null,

    bedrooms: features.bedrooms ?? numberIn(overview.bedrooms),
    bathrooms: features.bathrooms ?? numberIn(overview.bathrooms),
    land_m2: overview['land size'] ? numberIn(overview['land size'].replace(/<[^>]*>/g, '')) : null,
    build_m2: overview['building size'] ? numberIn(overview['building size'].replace(/<[^>]*>/g, '')) : null,

    price_month_idr,
    price_year_idr,
    term: termFor(price_month_idr, price_year_idr),

    images,
    // `#simple-map` ships with data-latitude="" on every page checked — no listing pin.
    lat: null,
    lng: null,
    pin_source: null,

    contacts: waPhone
      ? [{ role: 'agency', name: contactName ? `Bali Realty — ${contactName}` : 'Bali Realty', whatsapp: `+${waPhone[1]}` }]
      : [],
    gone,
    raw: { overview, features, amenities, price_currency: money ? money.currency : null, price_original: money ? money.original : null },
  };
}

async function detail(ctx, url) {
  const res = await ctx.fetchHtml(url, { ttlHours: 24 });
  if (!res || res.status === 404 || res.status === 410 || !res.html) return null;
  return detailFrom(res.html, url, ctx.config);
}

const ASSERTED = ['bathrooms', 'land_m2', 'build_m2'];

export function applyDetail(row, d) {
  if (!d) return row;
  const out = { ...row };
  for (const k of ASSERTED) if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  if (Array.isArray(d.images) && d.images.length) out.images = d.images;
  if (d.gone) out.availability = 'gone';
  return out;
}

export default {
  id: 'balirealty',
  name: 'Bali Realty',
  base: BASE,
  list, detail, applyDetail, cardsFrom, detailFrom,
};
