// Bali Coconut Living — SPEC §6 "Adapters to build" item 2.
// `/property/villa-for-long-term-rental?page=N` is server-rendered (12 cards a page);
// only the search form on it is Vue. The site's own JSON endpoint `/property/search` is
// robots-disallowed, so this walks the paged index. See adapters/balicoconutliving.md.

import * as cheerio from 'cheerio';
import { MAX_IMAGES, absUrl, textOf, numberIn } from './_shared.js';
import { moneyIdr, areaFromText, subAreaFrom, beachHint, termFor } from './_shared.js';

const BASE = 'https://balicoconutliving.com';
const LIST_PATH = '/property/villa-for-long-term-rental';

/** "Rented Until October 2026", "Rented", "Sold" — the card's own status label. */
const GONE_RE = /\b(rented|sold)\b/i;

/**
 * The index lists every villa still on offer first (newest first), then the rented
 * ones, then the sold ones. On 2026-09-26 the offered stock ran to page ~94 (~1 100
 * villas, 12 a page) and the rented tail started on page 95; the paginator claims 390.
 * The walk stops on the first page whose every card is rented or sold. MAX_PAGES is
 * only the safety stop above that — it used to be the shared 10, which reached the
 * newest 120 and silently missed the other ~1 000.
 */
export const MAX_PAGES = 150;

const indexUrl = (page) => (page > 1 ? `${BASE}${LIST_PATH}/?page=${page}` : `${BASE}${LIST_PATH}`);

/** Cards link through `onclick="openDetail("\/bali-villa-…")"`, never an href. */
const OPEN_DETAIL_RE = /openDetail\(\s*["']((?:\\\/|\/)[^"']+)["']\s*\)/;
const detailPathFrom = (attr) => {
  const m = OPEN_DETAIL_RE.exec(String(attr || ''));
  return m ? m[1].replace(/\\\//g, '/') : null;
};

/** `ID V009-4425 | VILLA - Pererenan` → `{ref:'V009-4425', location:'Pererenan'}`. */
export function parseMeta(text) {
  const s = String(text || '');
  const ref = (/ID\s+([A-Z0-9-]+)/i.exec(s) || [])[1] || null;
  const location = (/\|\s*[^-]*-\s*(.+)$/.exec(s) || [])[1] || null;
  return { ref: ref ? ref.toUpperCase() : null, location: location ? location.trim() : null };
}

/** `/upload/image/property/_thumb/x.jpeg` → the full-size original. */
const fullSize = (src) => String(src || '').replace('/_thumb/', '/');

/** `.icon-thumb[title]` — Bedroom(s) / Furnished status / Land Size / Building Size. */
function iconStats($, $scope) {
  const out = {};
  $scope.find('.icon-thumb').each((_, el) => {
    const $el = $(el);
    const label = ($el.attr('title') || '').toLowerCase();
    const value = textOf($el.find('.icon-text'));
    if (!label || value == null) return;
    if (label.startsWith('bedroom')) out.bedrooms = numberIn(value);
    else if (label.startsWith('bathroom')) out.bathrooms = numberIn(value);
    else if (label.startsWith('land')) out.land_m2 = numberIn(value);
    else if (label.startsWith('building')) out.build_m2 = numberIn(value);
    else if (label.startsWith('furnish')) out.furnished_text = value;
  });
  return out;
}

/** One `.property-thumb` card → a SPEC §6 partial (`area` null when off-target). */
export function cardFrom($, el, config = {}) {
  const $card = $(el);
  const $link = $card.find('.property-title a').first();
  const path = detailPathFrom($link.attr('onclick'));
  if (!path) return null;

  const title = textOf($link);
  const { ref, location } = parseMeta(textOf($card.find('.property-thumb-meta')));
  if (!ref) return null;

  const area = areaFromText(location, title);

  // Per-term tab panes #yearly-thumb-<id> / #monthly-thumb-<id>; a #leasehold-thumb
  // pane is a sale price and is deliberately ignored.
  let price_month_idr = null;
  let price_year_idr = null;
  let currency = null;
  $card.find('[id^="yearly-thumb-"], [id^="monthly-thumb-"]').each((_, pane) => {
    const $pane = $(pane);
    const money = moneyIdr(textOf($pane.find('.price-icon')) || '', config);
    if (!money) return;
    currency = money.currency;
    if ($pane.attr('id').startsWith('yearly')) price_year_idr = money.amount;
    else price_month_idr = money.amount;
  });

  const stats = iconStats($, $card);
  const label = textOf($card.find('.property-thumb-label .property-label'));
  const thumb = absUrl(fullSize($card.find('img[src*="/upload/image/property"]').first().attr('src')), BASE);

  return {
    source: 'balicoconutliving',
    ref,
    url: absUrl(path, BASE),
    title,
    area,
    sub_area: subAreaFrom(location, area),
    beach_km_hint: beachHint(area, location, title),
    location,
    note: label,
    bedrooms: stats.bedrooms ?? null,
    bathrooms: stats.bathrooms ?? null,
    land_m2: stats.land_m2 ?? null,
    build_m2: stats.build_m2 ?? null,
    price_month_idr,
    price_year_idr,
    term: termFor(price_month_idr, price_year_idr),
    thumb,
    gone: label ? GONE_RE.test(label) : false,
    raw: { site_location: location, label, furnished_text: stats.furnished_text || null, price_currency: currency },
  };
}

/** Every card of one index page. `all: true` also keeps the cards whose `area` is
 * null, which `list()` needs to tell "nothing new" from "all Seminyak". */
export function cardsFrom(html, config = {}, { all = false } = {}) {
  const $ = cheerio.load(html);
  const out = [];
  $('.property-thumb').each((_, el) => {
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
    if ($('.property-thumb').length === 0) break;

    const cards = cardsFrom(res.html, ctx.config, { all: true });
    let fresh = 0;
    for (const card of cards) {
      if (seen.has(card.ref)) continue;
      seen.add(card.ref);
      fresh++;
      if (card.area) yield card;
    }
    // The paginator advertises a page count far past the real one; the honest end
    // markers are a page that links to no next page, one that repeats itself, and —
    // the one that fires in practice — a page with nothing left on offer.
    if (fresh === 0) break;
    if (cards.length && cards.every((c) => c.gone)) break;
    if (!$(`a[href*="page=${page + 1}"]`).length) break;
    if (page === MAX_PAGES && ctx.log && ctx.log.warn) {
      ctx.log.warn(`[balicoconutliving] stopped at MAX_PAGES=${MAX_PAGES} with offered villas still listed`);
    }
  }
}

// ---------------------------------------------------------------------------
// detail()
// ---------------------------------------------------------------------------

/** "Yes" → 1, "No" → 0, absent or anything else → null. */
function yesNo(v) {
  const s = String(v ?? '').trim();
  return /^(yes|ada)\b/i.test(s) ? 1 : /^(no|none|tidak)\b/i.test(s) ? 0 : null;
}

/** The pure half of `detail()`. Exported for tests. */
export function detailFrom(html, url, config = {}) {
  const $ = cheerio.load(html);
  const $facts = $('section.line-section').filter((_, el) => /Detail$/.test(textOf($(el).find('h2')) || ''));
  if (!$facts.length) return null;

  // `.list-detail li` is "Label: <span>value</span>".
  const facts = {};
  $facts.find('.list-detail li').each((_, el) => {
    const $el = $(el);
    const value = textOf($el.find('span').first());
    const key = (textOf($el) || '').replace(/:\s*.*$/, '').trim().toLowerCase();
    if (key) facts[key] = value;
  });

  const ref = facts.id ? String(facts.id).toUpperCase() : null;
  if (!ref) return null;

  const title = textOf($('h1.title-header')) || textOf($('h1').first());

  const sectionText = (heading) =>
    $('section.line-section')
      .filter((_, el) => (textOf($(el).find('h2')) || '').toLowerCase() === heading)
      .first();

  const description = sectionText('description').find('p').text().replace(/\n{3,}/g, '\n\n').trim() || null;
  const included = sectionText('included facilities')
    .find('li')
    .map((_, el) => textOf($(el)))
    .get()
    .filter(Boolean);
  const has = (re) => (included.some((f) => re.test(f)) ? 1 : null);

  // The rent-type pill names the term; the pane under it holds the amount ("TBA" often).
  let price_month_idr = null;
  let price_year_idr = null;
  let currency = null;
  $('.property-detail-price .tab-pane').each((_, pane) => {
    const $pane = $(pane);
    const id = ($pane.attr('id') || '').toLowerCase();
    const money = moneyIdr(textOf($pane) || '', config);
    if (!money) return;
    currency = money.currency;
    if (id.startsWith('yearly')) price_year_idr = money.amount;
    else if (id.startsWith('monthly')) price_month_idr = money.amount;
  });

  const area = areaFromText(facts.location, title);

  const images = [];
  const GALLERY_RE = /\/upload\/image\/property_gallery\/(?:_thumb\/)?([A-Za-z0-9_-]+\.[a-z]{3,4})/g;
  for (const m of String(html).matchAll(GALLERY_RE)) {
    const abs = absUrl(`/upload/image/property_gallery/${m[1]}`, BASE);
    if (abs && !images.some((i) => i.src_url === abs) && images.length < MAX_IMAGES) images.push({ src_url: abs });
  }

  // The Google-Maps bootstrap ships commented out but keeps the real marker:
  //   var markers = [["Villa Pelangi",'-8.6426109', '115.12913159999994']]
  const pin = /markers\s*=\s*\[\s*\[\s*"[^"]*"\s*,\s*'(-?\d+\.\d+)'\s*,\s*'(-?\d+\.\d+)'/.exec(html);
  const lat = pin ? Number(pin[1]) : null;
  const lng = pin ? Number(pin[2]) : null;
  const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);

  const waPhone = /(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\d+)/.exec(html);

  const furniture = facts.furniture || '';
  const terms = [
    facts.furniture ? `Furniture: ${facts.furniture}` : null,
    facts['living room'] ? `Living room: ${facts['living room']}` : null,
    included.length ? `Included: ${included.join(', ')}` : null,
  ].filter(Boolean).join(' | ') || null;

  return {
    area,
    source: 'balicoconutliving',
    ref,
    url: url || null,
    title,
    description,
    terms,
    area,
    sub_area: subAreaFrom(facts.location, area),
    beach_km_hint: beachHint(area, facts.location, title, description),
    location: facts.location || null,

    bedrooms: numberIn(facts['bedroom(s)']),
    bathrooms: numberIn(facts['bathroom(s)']),
    land_m2: numberIn(facts['land size']),
    build_m2: numberIn(facts['building size']),
    price_month_idr,
    price_year_idr,
    term: termFor(price_month_idr, price_year_idr),
    furnished: /^un/i.test(furniture) ? 0 : /furnished/i.test(furniture) ? 1 : null,
    pool: yesNo(facts['swimming pool']) ?? has(/swimming pool/i),
    garden: has(/^garden$/i),
    kitchen_full: has(/^kitchen$/i),
    aircon: has(/^ac$|air cond/i),
    living_open: facts['living room'] ? (/open/i.test(facts['living room']) ? 1 : 0) : null,
    images,
    lat: hasPin ? lat : null,
    lng: hasPin ? lng : null,
    pin_source: hasPin ? 'listing_map' : null,

    contacts: waPhone ? [{ role: 'agency', name: 'Bali Coconut Living', whatsapp: `+${waPhone[1]}` }] : [],
    // No availability marker on a detail page: every `.property-label` there belongs
    // to an "OTHER PROPERTY" card. null = unknown, so the card's flag survives.
    gone: null,
    raw: { facts, included, price_currency: currency },
  };
}

async function detail(ctx, url) {
  const res = await ctx.fetchHtml(url, { ttlHours: 24 });
  if (!res || res.status === 404 || res.status === 410 || !res.html) return null;
  return detailFrom(res.html, url, ctx.config);
}

const ASSERTED =
  ['bathrooms', 'land_m2', 'build_m2', 'furnished', 'pool', 'garden', 'kitchen_full', 'aircon', 'living_open'];

/** The index card is the only place this site states "Rented …" — keep its verdict.
 * `normaliseListing` stored the merged partial in `row.raw`. */
function cardSaidGone(row) {
  try {
    return JSON.parse(row.raw || '{}').gone === true;
  } catch {
    return false;
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
  if (d.gone || cardSaidGone(row)) out.availability = 'gone';
  return out;
}

export default {
  id: 'balicoconutliving',
  name: 'Bali Coconut Living',
  base: BASE,
  list, detail, applyDetail, cardsFrom, detailFrom, parseMeta,
};
